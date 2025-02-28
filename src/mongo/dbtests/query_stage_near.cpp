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

/**
 * This file tests near search functionality.
 */


#include "mongo/platform/basic.h"

#include <memory>
#include <vector>

#include "mongo/base/owned_pointer_vector.h"
#include "mongo/db/client.h"
#include "mongo/db/db_raii.h"
#include "mongo/db/dbdirectclient.h"
#include "mongo/db/exec/near.h"
#include "mongo/db/exec/queued_data_stage.h"
#include "mongo/db/exec/working_set_common.h"
#include "mongo/dbtests/dbtests.h"
#include "mongo/unittest/unittest.h"

namespace {

using namespace mongo;
using std::shared_ptr;
using std::unique_ptr;
using std::vector;

const std::string kTestNamespace = "test.coll";
const BSONObj kTestKeyPattern = BSON("testIndex" << 1);

class QueryStageNearTest : public unittest::Test {
public:
    void setUp() override {
        directClient.createCollection(kTestNamespace);
        ASSERT_OK(dbtests::createIndex(_opCtx, kTestNamespace, kTestKeyPattern));

        _autoColl.emplace(_opCtx, NamespaceString{kTestNamespace});
        auto* coll = _autoColl->getCollection();
        ASSERT(coll);
        _mockGeoIndex = coll->getIndexCatalog()->findIndexByKeyPatternAndCollationSpec(
            _opCtx, kTestKeyPattern, BSONObj{});
        ASSERT(_mockGeoIndex);
    }

protected:
    const ServiceContext::UniqueOperationContext _uniqOpCtx = cc().makeOperationContext();
    OperationContext* const _opCtx = _uniqOpCtx.get();
    DBDirectClient directClient{_opCtx};

    boost::optional<AutoGetCollectionForRead> _autoColl;
    const IndexDescriptor* _mockGeoIndex;
};

/**
 * Stage which implements a basic distance search, and interprets the "distance" field of
 * fetched documents as the distance.
 */
class MockNearStage final : public NearStage {
public:
    struct MockInterval {
        MockInterval(const vector<BSONObj>& data, double min, double max)
            : data(data), min(min), max(max) {}

        vector<BSONObj> data;
        double min;
        double max;
    };

    MockNearStage(OperationContext* opCtx,
                  WorkingSet* workingSet,
                  const IndexDescriptor* indexDescriptor)
        : NearStage(
              opCtx, "MOCK_DISTANCE_SEARCH_STAGE", STAGE_UNKNOWN, workingSet, indexDescriptor),
          _pos(0) {}

    void addInterval(vector<BSONObj> data, double min, double max) {
        _intervals.push_back(std::make_unique<MockInterval>(data, min, max));
    }

    virtual StatusWith<CoveredInterval*> nextInterval(OperationContext* opCtx,
                                                      WorkingSet* workingSet,
                                                      const Collection* collection) {
        if (_pos == static_cast<int>(_intervals.size()))
            return StatusWith<CoveredInterval*>(nullptr);

        const MockInterval& interval = *_intervals[_pos++];

        bool lastInterval = _pos == static_cast<int>(_intervals.size());

        auto queuedStage = std::make_unique<QueuedDataStage>(opCtx, workingSet);

        for (unsigned int i = 0; i < interval.data.size(); i++) {
            // Add all documents from the lastInterval into the QueuedDataStage.
            const WorkingSetID id = workingSet->allocate();
            WorkingSetMember* member = workingSet->get(id);
            member->obj = Snapshotted<BSONObj>(SnapshotId(), interval.data[i]);
            workingSet->transitionToOwnedObj(id);
            queuedStage->pushBack(id);
        }

        _children.push_back(std::move(queuedStage));
        return StatusWith<CoveredInterval*>(
            new CoveredInterval(_children.back().get(), interval.min, interval.max, lastInterval));
    }

    StatusWith<double> computeDistance(WorkingSetMember* member) final {
        ASSERT(member->hasObj());
        return StatusWith<double>(member->obj.value()["distance"].numberDouble());
    }

    virtual StageState initialize(OperationContext* opCtx,
                                  WorkingSet* workingSet,
                                  WorkingSetID* out) {
        return IS_EOF;
    }

private:
    std::vector<std::unique_ptr<MockInterval>> _intervals;
    int _pos;
};

static vector<BSONObj> advanceStage(PlanStage* stage, WorkingSet* workingSet) {
    vector<BSONObj> results;

    WorkingSetID nextMemberID;
    PlanStage::StageState state = PlanStage::NEED_TIME;

    while (PlanStage::NEED_TIME == state) {
        while (PlanStage::ADVANCED == (state = stage->work(&nextMemberID))) {
            results.push_back(workingSet->get(nextMemberID)->obj.value());
        }
    }

    return results;
}

static void assertAscendingAndValid(const vector<BSONObj>& results) {
    double lastDistance = -1.0;
    for (vector<BSONObj>::const_iterator it = results.begin(); it != results.end(); ++it) {
        double distance = (*it)["distance"].numberDouble();
        bool shouldInclude = (*it)["$included"].eoo() || (*it)["$included"].trueValue();
        ASSERT(shouldInclude);
        ASSERT_GREATER_THAN_OR_EQUALS(distance, lastDistance);
        lastDistance = distance;
    }
}

TEST_F(QueryStageNearTest, Basic) {
    vector<BSONObj> mockData;
    WorkingSet workingSet;

    MockNearStage nearStage(_opCtx, &workingSet, _mockGeoIndex);

    // First set of results
    mockData.clear();
    mockData.push_back(BSON("distance" << 0.5));
    // Not included in this interval, but will be buffered and included in the last interval
    mockData.push_back(BSON("distance" << 2.0));
    mockData.push_back(BSON("distance" << 0.0));
    mockData.push_back(BSON("distance" << 3.5));  // Not included
    nearStage.addInterval(mockData, 0.0, 1.0);

    // Second set of results
    mockData.clear();
    mockData.push_back(BSON("distance" << 1.5));
    mockData.push_back(BSON("distance" << 0.5));  // Not included
    mockData.push_back(BSON("distance" << 1.0));
    nearStage.addInterval(mockData, 1.0, 2.0);

    // Last set of results
    mockData.clear();
    mockData.push_back(BSON("distance" << 2.5));
    mockData.push_back(BSON("distance" << 3.0));  // Included
    mockData.push_back(BSON("distance" << 2.0));
    mockData.push_back(BSON("distance" << 3.5));  // Not included
    nearStage.addInterval(mockData, 2.0, 3.0);

    vector<BSONObj> results = advanceStage(&nearStage, &workingSet);
    ASSERT_EQUALS(results.size(), 8u);
    assertAscendingAndValid(results);
}

TEST_F(QueryStageNearTest, EmptyResults) {
    vector<BSONObj> mockData;
    WorkingSet workingSet;

    AutoGetCollectionForRead autoColl(_opCtx, NamespaceString{kTestNamespace});
    auto* coll = autoColl.getCollection();
    ASSERT(coll);

    MockNearStage nearStage(_opCtx, &workingSet, _mockGeoIndex);

    // Empty set of results
    mockData.clear();
    nearStage.addInterval(mockData, 0.0, 1.0);

    // Non-empty set of results
    mockData.clear();
    mockData.push_back(BSON("distance" << 1.5));
    mockData.push_back(BSON("distance" << 2.0));
    mockData.push_back(BSON("distance" << 1.0));
    nearStage.addInterval(mockData, 1.0, 2.0);

    vector<BSONObj> results = advanceStage(&nearStage, &workingSet);
    ASSERT_EQUALS(results.size(), 3u);
    assertAscendingAndValid(results);
}
}  // namespace
