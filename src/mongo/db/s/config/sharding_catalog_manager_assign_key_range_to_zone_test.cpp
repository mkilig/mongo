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

#include "mongo/bson/json.h"
#include "mongo/client/read_preference.h"
#include "mongo/db/namespace_string.h"
#include "mongo/db/s/config/sharding_catalog_manager.h"
#include "mongo/s/catalog/type_chunk.h"
#include "mongo/s/catalog/type_collection.h"
#include "mongo/s/catalog/type_shard.h"
#include "mongo/s/catalog/type_tags.h"
#include "mongo/s/client/shard.h"
#include "mongo/s/config_server_test_fixture.h"

namespace mongo {
namespace {

using std::string;

ReadPreferenceSetting kReadPref(ReadPreference::PrimaryOnly);

/**
 * Basic fixture with a one shard with zone, and a sharded collection.
 */
class AssignKeyRangeToZoneTestFixture : public ConfigServerTestFixture {
public:
    void setUp() override {
        ConfigServerTestFixture::setUp();

        ShardType shard;
        shard.setName("a");
        shard.setHost("a:1234");
        shard.setTags({zoneName()});

        setupShards({shard});

        CollectionType shardedCollection;
        shardedCollection.setNs(shardedNS());
        shardedCollection.setEpoch(OID::gen());
        shardedCollection.setKeyPattern(BSON("x" << 1));

        ASSERT_OK(insertToConfigCollection(
            operationContext(), CollectionType::ConfigNS, shardedCollection.toBSON()));
    }

    /**
     * Asserts that the config.tags collection is empty.
     */
    void assertNoZoneDoc() {
        auto findStatus =
            findOneOnConfigCollection(operationContext(), TagsType::ConfigNS, BSONObj());
        ASSERT_EQ(ErrorCodes::NoMatchingDocument, findStatus);
    }

    /**
     * Asserts that the config.tags collection does not contain any tag document with
     * the given namespace.
     */
    void assertNoZoneDocWithNamespace(NamespaceString ns) {
        auto findStatus = findOneOnConfigCollection(
            operationContext(), TagsType::ConfigNS, BSON("ns" << ns.toString()));
        ASSERT_EQ(ErrorCodes::NoMatchingDocument, findStatus);
    }

    /**
     * Asserts that this is the only tag that exists in config.tags.
     */
    void assertOnlyZone(const NamespaceString& ns,
                        const ChunkRange& range,
                        const string& zoneName) {
        auto findStatus =
            getConfigShard()->exhaustiveFindOnConfig(operationContext(),
                                                     kReadPref,
                                                     repl::ReadConcernLevel::kMajorityReadConcern,
                                                     TagsType::ConfigNS,
                                                     BSONObj(),
                                                     BSONObj(),
                                                     1);
        ASSERT_OK(findStatus.getStatus());

        auto findResult = findStatus.getValue();
        ASSERT_EQ(1U, findResult.docs.size());

        auto tagDocStatus = TagsType::fromBSON(findResult.docs.front());
        ASSERT_OK(tagDocStatus.getStatus());

        auto tagDoc = tagDocStatus.getValue();
        ASSERT_EQ(ns, tagDoc.getNS());
        ASSERT_BSONOBJ_EQ(range.getMin(), tagDoc.getMinKey());
        ASSERT_BSONOBJ_EQ(range.getMax(), tagDoc.getMaxKey());
        ASSERT_EQ(zoneName, tagDoc.getTag());
    }

    NamespaceString shardedNS() const {
        return NamespaceString("test.foo");
    }

    NamespaceString unshardedNS() const {
        return NamespaceString("unsharded.coll");
    }

    string zoneName() const {
        return "z";
    }
};

TEST_F(AssignKeyRangeToZoneTestFixture, BasicAssignKeyRange) {
    const ChunkRange newRange(BSON("x" << 0), BSON("x" << 10));
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->assignKeyRangeToZone(operationContext(), shardedNS(), newRange, zoneName()));

    assertOnlyZone(shardedNS(), newRange, zoneName());
}

TEST_F(AssignKeyRangeToZoneTestFixture, BasicAssignKeyRangeOnUnshardedColl) {
    const ChunkRange newRange(BSON("x" << 0), BSON("x" << 10));
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->assignKeyRangeToZone(operationContext(), unshardedNS(), newRange, zoneName()));

    assertOnlyZone(unshardedNS(), newRange, zoneName());
}

TEST_F(AssignKeyRangeToZoneTestFixture, AssignKeyRangeOnDroppedShardedColl) {
    CollectionType unshardedCollection;
    unshardedCollection.setNs(unshardedNS());
    unshardedCollection.setEpoch(OID::gen());
    unshardedCollection.setKeyPattern(BSON("x" << 1));
    unshardedCollection.setDropped(true);

    const ChunkRange newRange(BSON("x" << 0), BSON("x" << 10));
    ASSERT_OK(insertToConfigCollection(
        operationContext(), CollectionType::ConfigNS, unshardedCollection.toBSON()));

    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->assignKeyRangeToZone(operationContext(), unshardedNS(), newRange, zoneName()));

    assertOnlyZone(unshardedNS(), newRange, zoneName());
}

TEST_F(AssignKeyRangeToZoneTestFixture, AssignKeyRangeNonExistingZoneShouldFail) {
    auto status = ShardingCatalogManager::get(operationContext())
                      ->assignKeyRangeToZone(operationContext(),
                                             shardedNS(),
                                             ChunkRange(BSON("x" << 0), BSON("x" << 10)),
                                             zoneName() + "y");
    ASSERT_EQ(ErrorCodes::ZoneNotFound, status);

    assertNoZoneDoc();
}

TEST_F(AssignKeyRangeToZoneTestFixture, MinWithInvalidShardKeyShouldFail) {
    auto status = ShardingCatalogManager::get(operationContext())
                      ->assignKeyRangeToZone(operationContext(),
                                             shardedNS(),
                                             ChunkRange(BSON("a" << 0), BSON("x" << 10)),
                                             zoneName());
    ASSERT_EQ(ErrorCodes::ShardKeyNotFound, status);

    assertNoZoneDoc();
}

TEST_F(AssignKeyRangeToZoneTestFixture, MaxWithInvalidShardKeyShouldFail) {
    auto status = ShardingCatalogManager::get(operationContext())
                      ->assignKeyRangeToZone(operationContext(),
                                             shardedNS(),
                                             ChunkRange(BSON("x" << 0), BSON("y" << 10)),
                                             zoneName());
    ASSERT_EQ(ErrorCodes::ShardKeyNotFound, status);

    assertNoZoneDoc();
}

TEST_F(AssignKeyRangeToZoneTestFixture, AssignZoneWithDollarPrefixedShardKeysShouldFail) {
    ASSERT_NOT_OK(ShardingCatalogManager::get(operationContext())
                      ->assignKeyRangeToZone(
                          operationContext(),
                          shardedNS(),
                          ChunkRange(BSON("x" << BSON("$A" << 1)), BSON("x" << BSON("$B" << 1))),
                          zoneName()));
    assertNoZoneDoc();

    ASSERT_NOT_OK(
        ShardingCatalogManager::get(operationContext())
            ->assignKeyRangeToZone(operationContext(),
                                   shardedNS(),
                                   ChunkRange(BSON("x" << 0), BSON("x" << BSON("$maxKey" << 1))),
                                   zoneName()));
    assertNoZoneDoc();
}

TEST_F(AssignKeyRangeToZoneTestFixture,
       AssignZoneWithDollarPrefixedShardKeysOnUnshardedCollShouldFail) {
    ASSERT_NOT_OK(ShardingCatalogManager::get(operationContext())
                      ->assignKeyRangeToZone(
                          operationContext(),
                          unshardedNS(),
                          ChunkRange(BSON("x" << BSON("$A" << 1)), BSON("x" << BSON("$B" << 1))),
                          zoneName()));
    assertNoZoneDoc();

    ASSERT_NOT_OK(
        ShardingCatalogManager::get(operationContext())
            ->assignKeyRangeToZone(operationContext(),
                                   unshardedNS(),
                                   ChunkRange(BSON("x" << 0), BSON("x" << BSON("$maxKey" << 1))),
                                   zoneName()));
    assertNoZoneDoc();
}


TEST_F(AssignKeyRangeToZoneTestFixture, RemoveZoneWithDollarPrefixedShardKeysShouldFail) {
    ChunkRange zoneWithDollarKeys(BSON("x" << BSON("$A" << 1)), BSON("x" << BSON("$B" << 1)));

    // Manually insert a zone with illegal keys in order to bypass the checks performed by
    // assignKeyRangeToZone
    BSONObj updateQuery(BSON("_id" << BSON(TagsType::ns(shardedNS().ns())
                                           << TagsType::min(zoneWithDollarKeys.getMin()))));

    BSONObjBuilder updateBuilder;
    updateBuilder.append(
        "_id", BSON(TagsType::ns(shardedNS().ns()) << TagsType::min(zoneWithDollarKeys.getMin())));
    updateBuilder.append(TagsType::ns(), shardedNS().ns());
    updateBuilder.append(TagsType::min(), zoneWithDollarKeys.getMin());
    updateBuilder.append(TagsType::max(), zoneWithDollarKeys.getMax());
    updateBuilder.append(TagsType::tag(), "TestZone");

    ASSERT_OK(Grid::get(operationContext())
                  ->catalogClient()
                  ->updateConfigDocument(
                      operationContext(),
                      TagsType::ConfigNS,
                      updateQuery,
                      updateBuilder.obj(),
                      true,
                      WriteConcernOptions(1, WriteConcernOptions::SyncMode::UNSET, Seconds(0))));
    assertOnlyZone(shardedNS(), zoneWithDollarKeys, "TestZone");

    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->removeKeyRangeFromZone(operationContext(), shardedNS(), zoneWithDollarKeys));
    assertNoZoneDoc();
}

TEST_F(AssignKeyRangeToZoneTestFixture, MinThatIsAShardKeyPrefixShouldConvertToFullShardKey) {
    NamespaceString ns("compound.shard");
    CollectionType shardedCollection;
    shardedCollection.setNs(ns);
    shardedCollection.setEpoch(OID::gen());
    shardedCollection.setKeyPattern(BSON("x" << 1 << "y" << 1));

    ASSERT_OK(insertToConfigCollection(
        operationContext(), CollectionType::ConfigNS, shardedCollection.toBSON()));

    const ChunkRange newRange(BSON("x" << 0), BSON("x" << 10 << "y" << 10));
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->assignKeyRangeToZone(operationContext(), ns, newRange, zoneName()));

    const ChunkRange fullRange(fromjson("{ x: 0, y: { $minKey: 1 }}"),
                               BSON("x" << 10 << "y" << 10));
    assertOnlyZone(ns, fullRange, zoneName());
}

TEST_F(AssignKeyRangeToZoneTestFixture, MaxThatIsAShardKeyPrefixShouldConvertToFullShardKey) {
    NamespaceString ns("compound.shard");
    CollectionType shardedCollection;
    shardedCollection.setNs(ns);
    shardedCollection.setEpoch(OID::gen());
    shardedCollection.setKeyPattern(BSON("x" << 1 << "y" << 1));

    ASSERT_OK(insertToConfigCollection(
        operationContext(), CollectionType::ConfigNS, shardedCollection.toBSON()));

    const ChunkRange newRange(BSON("x" << 0 << "y" << 0), BSON("x" << 10));
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->assignKeyRangeToZone(operationContext(), ns, newRange, zoneName()));

    const ChunkRange fullRange(BSON("x" << 0 << "y" << 0), fromjson("{ x: 10, y: { $minKey: 1 }}"));
    assertOnlyZone(ns, fullRange, zoneName());
}

TEST_F(AssignKeyRangeToZoneTestFixture, MinThatIsNotAShardKeyPrefixShouldFail) {
    auto status =
        ShardingCatalogManager::get(operationContext())
            ->assignKeyRangeToZone(operationContext(),
                                   shardedNS(),
                                   ChunkRange(BSON("x" << 0 << "y" << 0), BSON("x" << 10)),
                                   zoneName());
    ASSERT_EQ(ErrorCodes::ShardKeyNotFound, status);

    assertNoZoneDoc();
}

TEST_F(AssignKeyRangeToZoneTestFixture, MaxThatIsNotAShardKeyPrefixShouldFail) {
    auto status =
        ShardingCatalogManager::get(operationContext())
            ->assignKeyRangeToZone(operationContext(),
                                   shardedNS(),
                                   ChunkRange(BSON("x" << 0), BSON("x" << 10 << "y" << 10)),
                                   zoneName());
    ASSERT_EQ(ErrorCodes::ShardKeyNotFound, status);

    assertNoZoneDoc();
}

TEST_F(AssignKeyRangeToZoneTestFixture, MinMaxThatIsNotAShardKeyPrefixShouldFail) {
    auto status = ShardingCatalogManager::get(operationContext())
                      ->assignKeyRangeToZone(
                          operationContext(),
                          shardedNS(),
                          ChunkRange(BSON("x" << 0 << "y" << 0), BSON("x" << 10 << "y" << 10)),
                          zoneName());
    ASSERT_EQ(ErrorCodes::ShardKeyNotFound, status);

    assertNoZoneDoc();
}

TEST_F(AssignKeyRangeToZoneTestFixture, MinMaxThatIsAShardKeyPrefixShouldSucceed) {
    NamespaceString ns("compound.shard");
    CollectionType shardedCollection;
    shardedCollection.setNs(ns);
    shardedCollection.setEpoch(OID::gen());
    shardedCollection.setKeyPattern(BSON("x" << 1 << "y" << 1));

    ASSERT_OK(insertToConfigCollection(
        operationContext(), CollectionType::ConfigNS, shardedCollection.toBSON()));

    const ChunkRange newRange(BSON("x" << 0 << "y" << 0), BSON("x" << 10 << "y" << 10));
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->assignKeyRangeToZone(operationContext(), ns, newRange, zoneName()));

    assertOnlyZone(ns, newRange, zoneName());
}

TEST_F(AssignKeyRangeToZoneTestFixture, MinMaxOnUnshardedCollMustHaveTheSameShardKeys) {
    auto status = ShardingCatalogManager::get(operationContext())
                      ->assignKeyRangeToZone(operationContext(),
                                             unshardedNS(),
                                             ChunkRange(BSON("x" << 0), BSON("y" << 10)),
                                             zoneName());
    ASSERT_EQ(ErrorCodes::ShardKeyNotFound, status);

    assertNoZoneDoc();
}

TEST_F(AssignKeyRangeToZoneTestFixture, PrefixIsNotAllowedOnUnshardedColl) {
    auto status =
        ShardingCatalogManager::get(operationContext())
            ->assignKeyRangeToZone(operationContext(),
                                   unshardedNS(),
                                   ChunkRange(BSON("x" << 0), BSON("x" << 10 << "y" << 1)),
                                   zoneName());
    ASSERT_EQ(ErrorCodes::ShardKeyNotFound, status);

    assertNoZoneDoc();
}

/**
 * Basic fixture with a one shard with zone, a sharded collection and a zoned key range.
 */
class AssignKeyRangeWithOneRangeFixture : public AssignKeyRangeToZoneTestFixture {
public:
    void setUp() override {
        AssignKeyRangeToZoneTestFixture::setUp();

        ASSERT_OK(ShardingCatalogManager::get(operationContext())
                      ->assignKeyRangeToZone(
                          operationContext(), shardedNS(), getExistingRange(), zoneName()));
    }

    ChunkRange getExistingRange() {
        return ChunkRange(BSON("x" << 4), BSON("x" << 8));
    }
};


/**
 * new         ZZ
 * existing      ZZZZ
 *           0123456789
 */
TEST_F(AssignKeyRangeWithOneRangeFixture, NewMaxAlignsWithExistingMinShouldSucceed) {
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->assignKeyRangeToZone(operationContext(),
                                         shardedNS(),
                                         ChunkRange(BSON("x" << 2), BSON("x" << 4)),
                                         zoneName()));

    {
        auto findStatus = findOneOnConfigCollection(
            operationContext(), TagsType::ConfigNS, BSON("min" << BSON("x" << 2)));
        ASSERT_OK(findStatus);

        auto tagDocStatus = TagsType::fromBSON(findStatus.getValue());
        ASSERT_OK(tagDocStatus.getStatus());

        auto tagDoc = tagDocStatus.getValue();
        ASSERT_EQ(shardedNS(), tagDoc.getNS());
        ASSERT_BSONOBJ_EQ(BSON("x" << 2), tagDoc.getMinKey());
        ASSERT_BSONOBJ_EQ(BSON("x" << 4), tagDoc.getMaxKey());
        ASSERT_EQ(zoneName(), tagDoc.getTag());
    }

    {
        const auto existingRange = getExistingRange();
        auto findStatus = findOneOnConfigCollection(
            operationContext(), TagsType::ConfigNS, BSON("min" << existingRange.getMin()));
        ASSERT_OK(findStatus);

        auto tagDocStatus = TagsType::fromBSON(findStatus.getValue());
        ASSERT_OK(tagDocStatus.getStatus());

        auto tagDoc = tagDocStatus.getValue();
        ASSERT_EQ(shardedNS(), tagDoc.getNS());
        ASSERT_BSONOBJ_EQ(existingRange.getMin(), tagDoc.getMinKey());
        ASSERT_BSONOBJ_EQ(existingRange.getMax(), tagDoc.getMaxKey());
        ASSERT_EQ(zoneName(), tagDoc.getTag());
    }
}

/**
 * new          ZZ
 * existing      ZZZZ
 *           0123456789
 */
TEST_F(AssignKeyRangeWithOneRangeFixture, NewMaxOverlappingExistingShouldFail) {
    auto status = ShardingCatalogManager::get(operationContext())
                      ->assignKeyRangeToZone(operationContext(),
                                             shardedNS(),
                                             ChunkRange(BSON("x" << 3), BSON("x" << 5)),
                                             zoneName());
    ASSERT_EQ(ErrorCodes::RangeOverlapConflict, status);

    assertOnlyZone(shardedNS(), getExistingRange(), zoneName());
}

/**
 * new            ZZ
 * existing      ZZZZ
 *           0123456789
 */
TEST_F(AssignKeyRangeWithOneRangeFixture, NewRangeOverlappingInsideExistingShouldFail) {
    auto status = ShardingCatalogManager::get(operationContext())
                      ->assignKeyRangeToZone(operationContext(),
                                             shardedNS(),
                                             ChunkRange(BSON("x" << 5), BSON("x" << 7)),
                                             zoneName());
    ASSERT_EQ(ErrorCodes::RangeOverlapConflict, status);

    assertOnlyZone(shardedNS(), getExistingRange(), zoneName());
}

/**
 * new            ZZ
 * existing      ZZZZ
 *           0123456789
 */
TEST_F(AssignKeyRangeWithOneRangeFixture, NewRangeOverlappingWithDifferentNSShouldSucceed) {
    CollectionType shardedCollection;
    shardedCollection.setNs(NamespaceString("other.coll"));
    shardedCollection.setEpoch(OID::gen());
    shardedCollection.setKeyPattern(BSON("x" << 1));

    ASSERT_OK(insertToConfigCollection(
        operationContext(), CollectionType::ConfigNS, shardedCollection.toBSON()));

    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->assignKeyRangeToZone(operationContext(),
                                         shardedCollection.getNs(),
                                         ChunkRange(BSON("x" << 5), BSON("x" << 7)),
                                         zoneName()));

    {
        const auto existingRange = getExistingRange();
        auto findStatus = findOneOnConfigCollection(
            operationContext(), TagsType::ConfigNS, BSON("min" << existingRange.getMin()));
        ASSERT_OK(findStatus);

        auto tagDocStatus = TagsType::fromBSON(findStatus.getValue());
        ASSERT_OK(tagDocStatus.getStatus());

        auto tagDoc = tagDocStatus.getValue();
        ASSERT_EQ(shardedNS(), tagDoc.getNS());
        ASSERT_BSONOBJ_EQ(existingRange.getMin(), tagDoc.getMinKey());
        ASSERT_BSONOBJ_EQ(existingRange.getMax(), tagDoc.getMaxKey());
        ASSERT_EQ(zoneName(), tagDoc.getTag());
    }
    {
        auto findStatus = findOneOnConfigCollection(
            operationContext(), TagsType::ConfigNS, BSON("min" << BSON("x" << 5)));
        ASSERT_OK(findStatus);

        auto tagDocStatus = TagsType::fromBSON(findStatus.getValue());
        ASSERT_OK(tagDocStatus.getStatus());

        auto tagDoc = tagDocStatus.getValue();
        ASSERT_EQ(shardedCollection.getNs(), tagDoc.getNS());
        ASSERT_BSONOBJ_EQ(BSON("x" << 5), tagDoc.getMinKey());
        ASSERT_BSONOBJ_EQ(BSON("x" << 7), tagDoc.getMaxKey());
        ASSERT_EQ(zoneName(), tagDoc.getTag());
    }
}

/**
 * new           ZZZZ
 * existing      ZZZZ
 *           0123456789
 */
TEST_F(AssignKeyRangeWithOneRangeFixture, NewRangeEquivalentToExistingOneShouldBeNoOp) {
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->assignKeyRangeToZone(
                      operationContext(), shardedNS(), getExistingRange(), zoneName()));

    assertOnlyZone(shardedNS(), getExistingRange(), zoneName());
}

/**
 * new           YYYY
 * existing      ZZZZ
 *           0123456789
 */
TEST_F(AssignKeyRangeWithOneRangeFixture,
       NewRangeEquivalentToExistingOneWithDifferentZoneShouldFail) {
    ShardType shard;
    shard.setName("b");
    shard.setHost("b:1234");
    shard.setTags({"y"});

    ASSERT_OK(insertToConfigCollection(operationContext(), ShardType::ConfigNS, shard.toBSON()));

    auto status =
        ShardingCatalogManager::get(operationContext())
            ->assignKeyRangeToZone(operationContext(), shardedNS(), getExistingRange(), "y");
    ASSERT_EQ(ErrorCodes::RangeOverlapConflict, status);

    assertOnlyZone(shardedNS(), getExistingRange(), zoneName());
}

/**
 * new              ZZ
 * existing      ZZZZ
 *           0123456789
 */
TEST_F(AssignKeyRangeWithOneRangeFixture, NewMinOverlappingExistingShouldFail) {
    auto status = ShardingCatalogManager::get(operationContext())
                      ->assignKeyRangeToZone(operationContext(),
                                             shardedNS(),
                                             ChunkRange(BSON("x" << 7), BSON("x" << 9)),
                                             zoneName());
    ASSERT_EQ(ErrorCodes::RangeOverlapConflict, status);

    assertOnlyZone(shardedNS(), getExistingRange(), zoneName());
}

/**
 * new               ZZ
 * existing      ZZZZ
 *           0123456789
 */
TEST_F(AssignKeyRangeWithOneRangeFixture, NewMinAlignsWithExistingMaxShouldSucceed) {
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->assignKeyRangeToZone(operationContext(),
                                         shardedNS(),
                                         ChunkRange(BSON("x" << 8), BSON("x" << 10)),
                                         zoneName()));

    {
        const auto existingRange = getExistingRange();
        auto findStatus = findOneOnConfigCollection(
            operationContext(), TagsType::ConfigNS, BSON("min" << existingRange.getMin()));
        ASSERT_OK(findStatus);

        auto tagDocStatus = TagsType::fromBSON(findStatus.getValue());
        ASSERT_OK(tagDocStatus.getStatus());

        auto tagDoc = tagDocStatus.getValue();
        ASSERT_EQ(shardedNS(), tagDoc.getNS());
        ASSERT_BSONOBJ_EQ(existingRange.getMin(), tagDoc.getMinKey());
        ASSERT_BSONOBJ_EQ(existingRange.getMax(), tagDoc.getMaxKey());
        ASSERT_EQ(zoneName(), tagDoc.getTag());
    }

    {
        auto findStatus = findOneOnConfigCollection(
            operationContext(), TagsType::ConfigNS, BSON("min" << BSON("x" << 8)));
        ASSERT_OK(findStatus);

        auto tagDocStatus = TagsType::fromBSON(findStatus.getValue());
        ASSERT_OK(tagDocStatus.getStatus());

        auto tagDoc = tagDocStatus.getValue();
        ASSERT_EQ(shardedNS(), tagDoc.getNS());
        ASSERT_BSONOBJ_EQ(BSON("x" << 8), tagDoc.getMinKey());
        ASSERT_BSONOBJ_EQ(BSON("x" << 10), tagDoc.getMaxKey());
        ASSERT_EQ(zoneName(), tagDoc.getTag());
    }
}

/**
 * new          ZZZZZZ
 * existing      ZZZZ
 *           0123456789
 */
TEST_F(AssignKeyRangeWithOneRangeFixture, NewRangeIsSuperSetOfExistingShouldFail) {
    auto status = ShardingCatalogManager::get(operationContext())
                      ->assignKeyRangeToZone(operationContext(),
                                             shardedNS(),
                                             ChunkRange(BSON("x" << 3), BSON("x" << 9)),
                                             zoneName());

    ASSERT_EQ(ErrorCodes::RangeOverlapConflict, status);

    assertOnlyZone(shardedNS(), getExistingRange(), zoneName());
}

/**
 * new       ZZ
 * existing      ZZZZ
 * existing         ZZZ
 *           0123456789
 */
TEST_F(AssignKeyRangeWithOneRangeFixture, AssignWithExistingOveralpShouldFail) {
    TagsType tagDoc;
    tagDoc.setNS(shardedNS());
    tagDoc.setMinKey(BSON("x" << 0));
    tagDoc.setMaxKey(BSON("x" << 2));
    tagDoc.setTag("z");

    ASSERT_OK(insertToConfigCollection(operationContext(), TagsType::ConfigNS, tagDoc.toBSON()));

    auto status = ShardingCatalogManager::get(operationContext())
                      ->assignKeyRangeToZone(operationContext(),
                                             shardedNS(),
                                             ChunkRange(BSON("x" << 0), BSON("x" << 1)),
                                             zoneName());

    ASSERT_EQ(ErrorCodes::RangeOverlapConflict, status);
}

TEST_F(AssignKeyRangeWithOneRangeFixture, BasicRemoveKeyRange) {
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->removeKeyRangeFromZone(operationContext(), shardedNS(), getExistingRange()));

    assertNoZoneDoc();
}

TEST_F(AssignKeyRangeWithOneRangeFixture, BasicRemoveKeyRangeOnUnshardedColl) {
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->assignKeyRangeToZone(
                      operationContext(), unshardedNS(), getExistingRange(), zoneName()));
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->removeKeyRangeFromZone(operationContext(), unshardedNS(), getExistingRange()));

    assertNoZoneDocWithNamespace(unshardedNS());
}

TEST_F(AssignKeyRangeWithOneRangeFixture, RemoveKeyRangeOnDroppedShardedColl) {
    CollectionType unshardedCollection;
    unshardedCollection.setNs(unshardedNS());
    unshardedCollection.setEpoch(OID::gen());
    unshardedCollection.setKeyPattern(BSON("x" << 1));
    unshardedCollection.setDropped(true);

    ASSERT_OK(insertToConfigCollection(
        operationContext(), CollectionType::ConfigNS, unshardedCollection.toBSON()));

    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->removeKeyRangeFromZone(operationContext(),
                                           unshardedNS(),
                                           ChunkRange(BSON("x" << 0), BSON("x" << 10))));
    assertOnlyZone(shardedNS(), getExistingRange(), zoneName());
}

TEST_F(AssignKeyRangeWithOneRangeFixture, RemoveWithInvalidMinShardKeyShouldFail) {
    auto status = ShardingCatalogManager::get(operationContext())
                      ->removeKeyRangeFromZone(operationContext(),
                                               shardedNS(),
                                               ChunkRange(BSON("a" << 0), BSON("x" << 10)));
    ASSERT_EQ(ErrorCodes::ShardKeyNotFound, status);

    assertOnlyZone(shardedNS(), getExistingRange(), zoneName());
}

TEST_F(AssignKeyRangeWithOneRangeFixture, RemoveWithInvalidMaxShardKeyShouldFail) {
    auto status = ShardingCatalogManager::get(operationContext())
                      ->removeKeyRangeFromZone(operationContext(),
                                               shardedNS(),
                                               ChunkRange(BSON("x" << 0), BSON("y" << 10)));
    ASSERT_EQ(ErrorCodes::ShardKeyNotFound, status);

    assertOnlyZone(shardedNS(), getExistingRange(), zoneName());
}

TEST_F(AssignKeyRangeWithOneRangeFixture, RemoveThatIsOnlyMinPrefixOfExistingShouldNotRemoveRange) {
    NamespaceString ns("compound.shard");
    CollectionType shardedCollection;
    shardedCollection.setNs(ns);
    shardedCollection.setEpoch(OID::gen());
    shardedCollection.setKeyPattern(BSON("x" << 1 << "y" << 1));

    ASSERT_OK(insertToConfigCollection(
        operationContext(), CollectionType::ConfigNS, shardedCollection.toBSON()));

    const ChunkRange existingRange(fromjson("{ x: 0, y: { $minKey: 1 }}"),
                                   BSON("x" << 10 << "y" << 10));
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->assignKeyRangeToZone(operationContext(), ns, existingRange, zoneName()));

    ASSERT_OK(
        ShardingCatalogManager::get(operationContext())
            ->removeKeyRangeFromZone(
                operationContext(), ns, ChunkRange(BSON("x" << 0), BSON("x" << 10 << "y" << 10))));

    {
        auto findStatus = findOneOnConfigCollection(
            operationContext(), TagsType::ConfigNS, BSON("min" << existingRange.getMin()));
        ASSERT_OK(findStatus);

        auto tagDocStatus = TagsType::fromBSON(findStatus.getValue());
        ASSERT_OK(tagDocStatus.getStatus());

        auto tagDoc = tagDocStatus.getValue();
        ASSERT_EQ(ns, tagDoc.getNS());
        ASSERT_BSONOBJ_EQ(existingRange.getMin(), tagDoc.getMinKey());
        ASSERT_BSONOBJ_EQ(existingRange.getMax(), tagDoc.getMaxKey());
        ASSERT_EQ(zoneName(), tagDoc.getTag());
    }

    {
        const auto existingRange = getExistingRange();
        auto findStatus = findOneOnConfigCollection(
            operationContext(), TagsType::ConfigNS, BSON("min" << existingRange.getMin()));
        ASSERT_OK(findStatus);

        auto tagDocStatus = TagsType::fromBSON(findStatus.getValue());
        ASSERT_OK(tagDocStatus.getStatus());

        auto tagDoc = tagDocStatus.getValue();
        ASSERT_EQ(shardedNS(), tagDoc.getNS());
        ASSERT_BSONOBJ_EQ(existingRange.getMin(), tagDoc.getMinKey());
        ASSERT_BSONOBJ_EQ(existingRange.getMax(), tagDoc.getMaxKey());
        ASSERT_EQ(zoneName(), tagDoc.getTag());
    }
}

TEST_F(AssignKeyRangeWithOneRangeFixture, RemoveThatIsOnlyMaxPrefixOfExistingShouldNotRemoveRange) {
    NamespaceString ns("compound.shard");
    CollectionType shardedCollection;
    shardedCollection.setNs(ns);
    shardedCollection.setEpoch(OID::gen());
    shardedCollection.setKeyPattern(BSON("x" << 1 << "y" << 1));

    ASSERT_OK(insertToConfigCollection(
        operationContext(), CollectionType::ConfigNS, shardedCollection.toBSON()));

    const ChunkRange existingRange(BSON("x" << 0 << "y" << 0),
                                   fromjson("{ x: 10, y: { $minKey: 1 }}"));
    ASSERT_OK(ShardingCatalogManager::get(operationContext())
                  ->assignKeyRangeToZone(operationContext(), ns, existingRange, zoneName()));

    ASSERT_OK(
        ShardingCatalogManager::get(operationContext())
            ->removeKeyRangeFromZone(
                operationContext(), ns, ChunkRange(BSON("x" << 0 << "y" << 0), BSON("x" << 10))));

    {
        auto findStatus = findOneOnConfigCollection(
            operationContext(), TagsType::ConfigNS, BSON("min" << existingRange.getMin()));
        ASSERT_OK(findStatus);

        auto tagDocStatus = TagsType::fromBSON(findStatus.getValue());
        ASSERT_OK(tagDocStatus.getStatus());

        auto tagDoc = tagDocStatus.getValue();
        ASSERT_EQ(ns, tagDoc.getNS());
        ASSERT_BSONOBJ_EQ(existingRange.getMin(), tagDoc.getMinKey());
        ASSERT_BSONOBJ_EQ(existingRange.getMax(), tagDoc.getMaxKey());
        ASSERT_EQ(zoneName(), tagDoc.getTag());
    }

    {
        const auto existingRange = getExistingRange();
        auto findStatus = findOneOnConfigCollection(
            operationContext(), TagsType::ConfigNS, BSON("min" << existingRange.getMin()));
        ASSERT_OK(findStatus);

        auto tagDocStatus = TagsType::fromBSON(findStatus.getValue());
        ASSERT_OK(tagDocStatus.getStatus());

        auto tagDoc = tagDocStatus.getValue();
        ASSERT_EQ(shardedNS(), tagDoc.getNS());
        ASSERT_BSONOBJ_EQ(existingRange.getMin(), tagDoc.getMinKey());
        ASSERT_BSONOBJ_EQ(existingRange.getMax(), tagDoc.getMaxKey());
        ASSERT_EQ(zoneName(), tagDoc.getTag());
    }
}

}  // namespace
}  // namespace mongo
