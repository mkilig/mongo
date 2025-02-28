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
#include "mongo/platform/basic.h"

#include "mongo/db/storage/index_entry_comparison.h"

#include <ostream>

#include "mongo/db/jsobj.h"
#include "mongo/db/namespace_string.h"
#include "mongo/db/storage/duplicate_key_error_info.h"
#include "mongo/db/storage/key_string.h"

namespace mongo {

std::ostream& operator<<(std::ostream& stream, const IndexKeyEntry& entry) {
    return stream << entry.key << '@' << entry.loc;
}

// Due to the limitations of various APIs, we need to use the same type (IndexKeyEntry)
// for both the stored data and the "query". We cheat and encode extra information in the
// first byte of the field names in the query. This works because all stored objects should
// have all field names empty, so their first bytes are '\0'.
enum BehaviorIfFieldIsEqual {
    normal = '\0',
    less = 'l',
    greater = 'g',
};

bool IndexEntryComparison::operator()(const IndexKeyEntry& lhs, const IndexKeyEntry& rhs) const {
    // implementing in memcmp style to ease reuse of this code.
    return compare(lhs, rhs) < 0;
}

// This should behave the same as customBSONCmp from btree_logic.cpp.
//
// Reading the comment in the .h file is highly recommended if you need to understand what this
// function is doing
int IndexEntryComparison::compare(const IndexKeyEntry& lhs, const IndexKeyEntry& rhs) const {
    BSONObjIterator lhsIt(lhs.key);
    BSONObjIterator rhsIt(rhs.key);

    // Iterate through both BSONObjects, comparing individual elements one by one
    for (unsigned mask = 1; lhsIt.more(); mask <<= 1) {
        if (!rhsIt.more())
            return _order.descending(mask) ? -1 : 1;

        const BSONElement l = lhsIt.next();
        const BSONElement r = rhsIt.next();

        if (int cmp = l.woCompare(r, /*compareFieldNames=*/false)) {
            if (cmp == std::numeric_limits<int>::min()) {
                // can't be negated
                cmp = -1;
            }

            return _order.descending(mask) ? -cmp : cmp;
        }

        // Here is where the weirdness begins. We sometimes want to fudge the comparison
        // when a key == the query to implement exclusive ranges.
        BehaviorIfFieldIsEqual lEqBehavior = BehaviorIfFieldIsEqual(l.fieldName()[0]);
        BehaviorIfFieldIsEqual rEqBehavior = BehaviorIfFieldIsEqual(r.fieldName()[0]);

        if (lEqBehavior) {
            // lhs is the query, rhs is the stored data
            invariant(rEqBehavior == normal);
            return lEqBehavior == less ? -1 : 1;
        }

        if (rEqBehavior) {
            // rhs is the query, lhs is the stored data, so reverse the returns
            invariant(lEqBehavior == normal);
            return rEqBehavior == less ? 1 : -1;
        }
    }

    if (rhsIt.more())
        return -1;

    // This means just look at the key, not the loc.
    if (lhs.loc.isNull() || rhs.loc.isNull())
        return 0;

    return lhs.loc.compare(rhs.loc);  // is supposed to ignore ordering
}

// reading the comment in the .h file is highly recommended if you need to understand what this
// function is doing
BSONObj IndexEntryComparison::makeQueryObject(const BSONObj& keyPrefix,
                                              int prefixLen,
                                              bool prefixExclusive,
                                              const std::vector<const BSONElement*>& keySuffix,
                                              const std::vector<bool>& suffixInclusive,
                                              const int cursorDirection) {
    // Please read the comments in the header file to see why this is done.
    // The basic idea is that we use the field name to store a byte which indicates whether
    // each field in the query object is inclusive and exclusive, and if it is exclusive, in
    // which direction.
    const char exclusiveByte = (cursorDirection == 1 ? greater : less);

    const StringData exclusiveFieldName(&exclusiveByte, 1);

    BSONObjBuilder bb;

    // handle the prefix
    if (prefixLen > 0) {
        BSONObjIterator it(keyPrefix);
        for (int i = 0; i < prefixLen; i++) {
            invariant(it.more());
            const BSONElement e = it.next();

            if (prefixExclusive && i == prefixLen - 1) {
                bb.appendAs(e, exclusiveFieldName);
            } else {
                bb.appendAs(e, StringData());
            }
        }
    }

    // If the prefix is exclusive then the suffix does not matter as it will never be used
    if (prefixExclusive) {
        invariant(prefixLen > 0);
        return bb.obj();
    }

    // Handle the suffix. Note that the useful parts of the suffix start at index prefixLen
    // rather than at 0.
    invariant(keySuffix.size() == suffixInclusive.size());
    for (size_t i = prefixLen; i < keySuffix.size(); i++) {
        invariant(keySuffix[i]);
        if (suffixInclusive[i]) {
            bb.appendAs(*keySuffix[i], StringData());
        } else {
            bb.appendAs(*keySuffix[i], exclusiveFieldName);

            // If an exclusive field exists then no fields after this will matter, since an
            // exclusive field never evaluates as equal
            return bb.obj();
        }
    }

    return bb.obj();
}

KeyString::Value IndexEntryComparison::makeKeyStringForSeekPoint(const IndexSeekPoint& seekPoint,
                                                                 KeyString::Version version,
                                                                 Ordering ord,
                                                                 bool isForward) {
    BSONObj key = IndexEntryComparison::makeQueryObject(seekPoint, isForward);

    const auto discriminator = isForward ? KeyString::Discriminator::kExclusiveBefore
                                         : KeyString::Discriminator::kExclusiveAfter;

    KeyString::Builder builder(version, key, ord, discriminator);
    return builder.getValueCopy();
}

Status buildDupKeyErrorStatus(const BSONObj& key,
                              const NamespaceString& collectionNamespace,
                              const std::string& indexName,
                              const BSONObj& keyPattern) {
    StringBuilder sb;
    sb << "E11000 duplicate key error";
    sb << " collection: " << collectionNamespace;
    sb << " index: " << indexName;
    sb << " dup key: ";

    BSONObjBuilder builder;
    // key is a document with forms like: '{ : 123}', '{ : {num: 123} }', '{ : 123, : "str" }'
    BSONObjIterator keyValueIt(key);
    // keyPattern is a document with only one level. e.g. '{a : 1, b : -1}', '{a.b : 1}'
    BSONObjIterator keyNameIt(keyPattern);
    // Combine key and keyPattern into one document which represents a mapping from indexFieldName
    // to indexKey.
    while (1) {
        BSONElement keyValueElem = keyValueIt.next();
        BSONElement keyNameElem = keyNameIt.next();
        if (keyNameElem.eoo())
            break;

        builder.appendAs(keyValueElem, keyNameElem.fieldName());
    }

    auto keyValueWithName = builder.obj();
    sb << keyValueWithName;
    return Status(DuplicateKeyErrorInfo(keyPattern, keyValueWithName), sb.str());
}

Status buildDupKeyErrorStatus(const KeyString::Value& keyString,
                              const NamespaceString& collectionNamespace,
                              const std::string& indexName,
                              const BSONObj& keyPattern,
                              const Ordering& ordering) {
    const BSONObj key = KeyString::toBson(
        keyString.getBuffer(), keyString.getSize(), ordering, keyString.getTypeBits());

    return buildDupKeyErrorStatus(key, collectionNamespace, indexName, keyPattern);
}

}  // namespace mongo
