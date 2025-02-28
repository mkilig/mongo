/**
 *    Copyright (C) 2018-present MongoDB, Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the Server Side Public License, version 1,
 *    as published by MongoDB, Inc.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    Server Side Public License for more details.
 *
 *    You should have received a copy of the Server Side Public License
 *    along with this program. If not, see
 *    <http://www.mongodb.com/licensing/server-side-public-license>.
 *
 *    As a special exception, the copyright holders give permission to link the
 *    code of portions of this program with the OpenSSL library under certain
 *    conditions as described in each individual source file and distribute
 *    linked combinations including the program with the OpenSSL library. You
 *    must comply with the Server Side Public License in all respects for
 *    all of the code used other than as permitted herein. If you modify file(s)
 *    with this exception, you may extend this exception to your version of the
 *    file(s), but you are not obligated to do so. If you do not wish to do so,
 *    delete this exception statement from your version. If you delete this
 *    exception statement from all source files in the program, then also delete
 *    it in the license file.
 */

#define MONGO_LOG_DEFAULT_COMPONENT ::mongo::logger::LogComponent::kTransaction

#include "mongo/platform/basic.h"

#include "mongo/db/s/transaction_coordinator_catalog.h"

#include "mongo/s/grid.h"
#include "mongo/util/log.h"

namespace mongo {

TransactionCoordinatorCatalog::TransactionCoordinatorCatalog() = default;

TransactionCoordinatorCatalog::~TransactionCoordinatorCatalog() {
    join();
}

void TransactionCoordinatorCatalog::exitStepUp(Status status) {
    if (status.isOK()) {
        LOG(0) << "Incoming coordinateCommit requests are now enabled";
    } else {
        warning() << "Coordinator recovery failed and coordinateCommit requests will not be allowed"
                  << causedBy(status);
    }

    stdx::lock_guard<stdx::mutex> lk(_mutex);
    invariant(!_stepUpCompletionStatus);
    _stepUpCompletionStatus = std::move(status);
    _stepUpCompleteCV.notify_all();
}

void TransactionCoordinatorCatalog::onStepDown() {
    stdx::unique_lock<stdx::mutex> ul(_mutex);

    std::vector<std::shared_ptr<TransactionCoordinator>> coordinatorsToCancel;
    for (auto&& [sessionId, coordinatorsForSession] : _coordinatorsBySession) {
        for (auto&& [txnNumber, coordinator] : coordinatorsForSession) {
            coordinatorsToCancel.emplace_back(coordinator);
        }
    }

    ul.unlock();

    for (auto&& coordinator : coordinatorsToCancel) {
        coordinator->cancelIfCommitNotYetStarted();
    }
}

void TransactionCoordinatorCatalog::insert(OperationContext* opCtx,
                                           const LogicalSessionId& lsid,
                                           TxnNumber txnNumber,
                                           std::shared_ptr<TransactionCoordinator> coordinator,
                                           bool forStepUp) {
    LOG(3) << "Inserting coordinator " << lsid.getId() << ':' << txnNumber
           << " into in-memory catalog";

    stdx::unique_lock<stdx::mutex> ul(_mutex);
    if (!forStepUp) {
        _waitForStepUpToComplete(ul, opCtx);
    }

    auto& coordinatorsBySession = _coordinatorsBySession[lsid];

    // We should never try to insert a coordinator if one already exists for this session and txn
    // number. Logic for avoiding this due to e.g. malformed commands should be handled external to
    // the catalog.
    invariant(coordinatorsBySession.find(txnNumber) == coordinatorsBySession.end(),
              "Cannot insert a TransactionCoordinator into the TransactionCoordinatorCatalog with "
              "the same session ID and transaction number as a previous coordinator");

    coordinatorsBySession[txnNumber] = coordinator;

    // Schedule callback to remove the coordinator from the catalog when all its activities have
    // completed. This needs to be done outside of the mutex, in case the coordinator completed
    // early because of stepdown. Otherwise the continuation could execute on the same thread and
    // recursively acquire the mutex.
    ul.unlock();

    coordinator->onCompletion()
        .thenRunOn(Grid::get(opCtx)->getExecutorPool()->getFixedExecutor())
        .ignoreValue()
        .getAsync([this, lsid, txnNumber](Status) { _remove(lsid, txnNumber); });
}

std::shared_ptr<TransactionCoordinator> TransactionCoordinatorCatalog::get(
    OperationContext* opCtx, const LogicalSessionId& lsid, TxnNumber txnNumber) {
    stdx::unique_lock<stdx::mutex> ul(_mutex);
    _waitForStepUpToComplete(ul, opCtx);

    std::shared_ptr<TransactionCoordinator> coordinatorToReturn;

    auto coordinatorsForSessionIter = _coordinatorsBySession.find(lsid);
    if (coordinatorsForSessionIter != _coordinatorsBySession.end()) {
        const auto& coordinatorsForSession = coordinatorsForSessionIter->second;
        auto coordinatorForTxnIter = coordinatorsForSession.find(txnNumber);
        if (coordinatorForTxnIter != coordinatorsForSession.end()) {
            coordinatorToReturn = coordinatorForTxnIter->second;
        }
    }

    return coordinatorToReturn;
}

boost::optional<std::pair<TxnNumber, std::shared_ptr<TransactionCoordinator>>>
TransactionCoordinatorCatalog::getLatestOnSession(OperationContext* opCtx,
                                                  const LogicalSessionId& lsid) {
    stdx::unique_lock<stdx::mutex> ul(_mutex);
    _waitForStepUpToComplete(ul, opCtx);

    const auto& coordinatorsForSessionIter = _coordinatorsBySession.find(lsid);

    if (coordinatorsForSessionIter == _coordinatorsBySession.end()) {
        return boost::none;
    }

    const auto& coordinatorsForSession = coordinatorsForSessionIter->second;

    // We should never have empty map for a session because entries for sessions with no
    // transactions are removed
    invariant(!coordinatorsForSession.empty());

    const auto& lastCoordinatorOnSession = coordinatorsForSession.begin();
    return std::make_pair(lastCoordinatorOnSession->first, lastCoordinatorOnSession->second);
}

void TransactionCoordinatorCatalog::_remove(const LogicalSessionId& lsid, TxnNumber txnNumber) {
    LOG(3) << "Removing coordinator " << lsid.getId() << ':' << txnNumber
           << " from in-memory catalog";

    stdx::lock_guard<stdx::mutex> lk(_mutex);

    const auto& coordinatorsForSessionIter = _coordinatorsBySession.find(lsid);

    if (coordinatorsForSessionIter != _coordinatorsBySession.end()) {
        auto& coordinatorsForSession = coordinatorsForSessionIter->second;
        const auto& coordinatorForTxnIter = coordinatorsForSession.find(txnNumber);

        if (coordinatorForTxnIter != coordinatorsForSession.end()) {
            auto coordinator = coordinatorForTxnIter->second;

            coordinatorsForSession.erase(coordinatorForTxnIter);
            if (coordinatorsForSession.empty()) {
                _coordinatorsBySession.erase(coordinatorsForSessionIter);
            }
        }
    }

    if (_coordinatorsBySession.empty()) {
        LOG(3) << "Signaling last active coordinator removed";
        _noActiveCoordinatorsCV.notify_all();
    }
}

void TransactionCoordinatorCatalog::join() {
    stdx::unique_lock<stdx::mutex> ul(_mutex);

    while (!_noActiveCoordinatorsCV.wait_for(
        ul, stdx::chrono::seconds{5}, [this] { return _coordinatorsBySession.empty(); })) {
        LOG(0) << "After 5 seconds of wait there are still " << _coordinatorsBySession.size()
               << " sessions left with active coordinators which have not yet completed";
        LOG(0) << _toString(ul);
    }
}

std::string TransactionCoordinatorCatalog::toString() const {
    stdx::lock_guard<stdx::mutex> lk(_mutex);
    return _toString(lk);
}

void TransactionCoordinatorCatalog::_waitForStepUpToComplete(stdx::unique_lock<stdx::mutex>& lk,
                                                             OperationContext* opCtx) {
    invariant(lk.owns_lock());
    opCtx->waitForConditionOrInterrupt(
        _stepUpCompleteCV, lk, [this]() { return bool(_stepUpCompletionStatus); });

    uassertStatusOK(*_stepUpCompletionStatus);
}

std::string TransactionCoordinatorCatalog::_toString(WithLock wl) const {
    StringBuilder ss;
    ss << "[";
    for (const auto& coordinatorsForSession : _coordinatorsBySession) {
        ss << "\n" << coordinatorsForSession.first.getId() << ": ";
        for (const auto& coordinator : coordinatorsForSession.second) {
            ss << coordinator.first << ",";
        }
    }
    ss << "]";
    return ss.str();
}

}  // namespace mongo
