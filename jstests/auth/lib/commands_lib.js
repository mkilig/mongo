/*

Declaratively defined tests for the authorization properties
of all database commands.

This file contains an array of test definitions, as well as
some shared test logic.

See jstests/auth/commands_builtin_roles.js and jstests/auth/commands_user_defined_roles.js for two
separate implementations of the test logic, respectively to test authorization with builtin roles
and authorization with user-defined roles.

Example test definition:

This tests that when run on the "roles_commands_1" database,
the given command will return an authorization error unless
the user has the role with key "readWrite" or the role with
key "readWriteAnyDatabase". The command will be run as a
user with each of the roles in the "roles" array below.

Similarly, this tests that when run on the "roles_commands_2"
database, only a user with role "readWriteAnyDatabase" should
be authorized.

    {
        testname: "aggregate_out_legacy",
        command: {aggregate: "foo", pipeline: [ {$out: "foo_out"} ], cursor: {} },
        testcases: [
            { runOnDb: "roles_commands_1", roles: {readWrite: 1, readWriteAnyDatabase: 1} },
            { runOnDb: "roles_commands_2", roles: {readWriteAnyDatabase: 1} }
        ]
    },

Additional options:

1) expectFail

You can add "expectFail: true" to an individual element of the testcases
array. This means that if the command is authorized, then you still expect
it to fail with a non-auth related error. As always, for roles other than
those in the "roles" array, an auth error is expected.

2) expectAuthzFailure

Like "expectFailure", this option applies to an individual test case rather than
than the full test object.  When this option is true, it means the test case is
*not* testing that the given roles/privileges make the command authorized to run,
instead it makes it so it is testing that the given roles/privileges are *not* sufficient
to be authorized to run the command.

3) skipSharded

Add "skipSharded: true" if you want to run the test only ony in a non-sharded configuration.

4) skipUnlessSharded

Add "skipUnlessSharded: true" if you want to run the test only in sharded
configuration.

5) skipUnlessReplicaSet
Add "skipUnlessReplicaSet: true" if you want to run the test only when replica sets are in use.

6) setup

The setup function, if present, is called before testing whether a
particular role authorizes a command for a particular database.

7) teardown

The teardown function, if present, is called immediately after
testing whether a particular role authorizes a command for a
particular database.

8) privileges

An array of privileges used when testing user-defined roles. The test case tests that a user with
the specified privileges is authorized to run the command, and that having only a subset of the
privileges causes an authorization failure. If an individual privilege specifies
"removeWhenTestingAuthzFailure: false", then that privilege will not be removed when testing for
authorization failure.

9) commandArgs

Set of options to be passed to your 'command' function. Can be used to send different versions of
the command depending on the testcase being run.

10) skipTest

Add "skipTest: <function>" to not run the test for more complex reasons. The function is passed
one argument, the connection object.

*/

// constants

// All roles that are specific to one database will be given only for 'firstDbName'. For example,
// when using the roles in 'roles_read', the 'read' role will only be granted on 'firstDbName'. In
// particular, this means that when 'runOnDb' is 'secondDbName', the test user with the 'read' role
// should not be able to perform read operations.
var firstDbName = "roles_commands_1";
var secondDbName = "roles_commands_2";
var adminDbName = "admin";
var authErrCode = 13;
var commandNotSupportedCode = 115;
var shard0name = "shard0000";

// useful shorthand when defining the tests below
var roles_write =
    {readWrite: 1, readWriteAnyDatabase: 1, dbOwner: 1, restore: 1, root: 1, __system: 1};
var roles_read = {
    read: 1,
    readAnyDatabase: 1,
    readWrite: 1,
    readWriteAnyDatabase: 1,
    dbOwner: 1,
    backup: 1,
    root: 1,
    __system: 1
};
var roles_userAdmin = {
    userAdmin: 1,
    dbOwner: 1,
    userAdminAnyDatabase: 1,
    restore: 1,
    root: 1,
    __system: 1,
};
var roles_userAdminAny = {
    userAdminAnyDatabase: 1,
    restore: 1,
    root: 1,
    __system: 1,
};
var roles_readAny = {readAnyDatabase: 1, readWriteAnyDatabase: 1, backup: 1, root: 1, __system: 1};
var roles_dbAdmin = {dbAdmin: 1, dbAdminAnyDatabase: 1, dbOwner: 1, root: 1, __system: 1};
var roles_dbAdminAny = {dbAdminAnyDatabase: 1, root: 1, __system: 1};
var roles_writeDbAdmin = {
    readWrite: 1,
    readWriteAnyDatabase: 1,
    dbAdmin: 1,
    dbAdminAnyDatabase: 1,
    dbOwner: 1,
    root: 1,
    __system: 1
};
var roles_writeDbAdminAny = {readWriteAnyDatabase: 1, dbAdminAnyDatabase: 1, root: 1, __system: 1};
var roles_readDbAdmin = {
    read: 1,
    readAnyDatabase: 1,
    readWrite: 1,
    readWriteAnyDatabase: 1,
    dbAdmin: 1,
    dbAdminAnyDatabase: 1,
    dbOwner: 1,
    root: 1,
    __system: 1
};
var roles_readDbAdminAny =
    {readAnyDatabase: 1, readWriteAnyDatabase: 1, dbAdminAnyDatabase: 1, root: 1, __system: 1};
var roles_monitoring = {clusterMonitor: 1, clusterAdmin: 1, root: 1, __system: 1};
var roles_hostManager = {hostManager: 1, clusterAdmin: 1, root: 1, __system: 1};
var roles_clusterManager = {clusterManager: 1, clusterAdmin: 1, root: 1, __system: 1};
var roles_all = {
    read: 1,
    readLocal: 1,
    readAnyDatabase: 1,
    readWrite: 1,
    readWriteLocal: 1,
    readWriteAnyDatabase: 1,
    userAdmin: 1,
    userAdminAnyDatabase: 1,
    dbAdmin: 1,
    dbAdminAnyDatabase: 1,
    dbOwner: 1,
    enableSharding: 1,
    clusterMonitor: 1,
    hostManager: 1,
    clusterManager: 1,
    clusterAdmin: 1,
    backup: 1,
    restore: 1,
    root: 1,
    __system: 1
};

load("jstests/libs/uuid_util.js");
// For isReplSet
load("jstests/libs/fixture_helpers.js");

var authCommandsLib = {

    /************* TEST CASES ****************/

    tests: [
        {
          testname: "abortTxn",
          command: {abortTransaction: 1},
          skipSharded: true,
          skipUnlessReplicaSet: true,
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_all,
              },
          ]
        },
        {
          testname: "_addShard",
          command: {
              _addShard: 1,
              shardIdentity: {
                  shardName: "shard0000",
                  clusterId: ObjectId('5b2031806195dffd744258ee'),
                  configsvrConnectionString: "foobarbaz/host:20022,host:20023,host:20024"
              }
          },
          skipSharded: true,  // Command doesn't exist on mongos
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {__system: 1},
                privileges: [{resource: {cluster: true}, actions: ["internal"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "addShard",
          command: {addShard: "x"},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {cluster: true}, actions: ["addShard"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          // Test that clusterManager role has permission to run addTagRange
          testname: "addTagRange",
          command: {
              // addTagRange is not a "real command"; it updates config.tags
              update: "tags",
              updates: [{
                  q: {_id: {ns: "test.x", min: 1}},
                  u: {_id: {ns: "test.x", min: 1}, ns: "test.x"}
              }]
          },
          skipUnlessSharded: true,
          testcases: [{
              runOnDb: "config",
              roles: roles_clusterManager,
          }]
        },

        {
          testname: "applyOps_empty",
          command: {applyOps: []},
          skipSharded: true,
          testcases: [
              {
                roles: {__system: 1},
                runOnDb: adminDbName,
              },
              {
                roles: {__system: 1},
                runOnDb: firstDbName,
              }
          ]
        },
        {
          testname: "applyOps_precondition",
          command: {
              applyOps: [{"op": "n", "ns": "", "o": {}}],
              preCondition: [{ns: firstDbName + ".x", q: {x: 5}, res: []}]
          },
          skipSharded: true,
          setup: function(db) {
              db.getSisterDB(firstDbName).x.save({});
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["find"]},
                    {
                      resource: {cluster: true},
                      actions: ["appendOplogNote"],
                      removeWhenTestingAuthzFailure: false
                    },
                ],
              },
          ]
        },
        {
          testname: "applyOps_c_create",
          command: {
              applyOps: [{
                  "op": "c",
                  "ns": firstDbName + ".$cmd",
                  "o": {
                      "create": "x",
                  }
              }]
          },
          skipSharded: true,
          setup: function(db) {},
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {
                    readWrite: 1,
                    dbAdmin: 1,
                    dbOwner: 1,
                    readWriteAnyDatabase: 1,
                    dbAdminAnyDatabase: 1,
                    root: 1,
                    restore: 1,
                    __system: 1
                },
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["createCollection"]},
                ]
              },
          ]
        },

        {
          testname: "applyOps_c_create_UUID",
          command: {
              applyOps: [{
                  "ui": UUID("71f1d1d7-68ca-493e-a7e9-f03c94e2e960"),
                  "op": "c",
                  "ns": firstDbName + ".$cmd",
                  "o": {
                      "create": "x",
                  }
              }]
          },
          skipSharded: true,
          setup: function(db) {},
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {root: 1, restore: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["createCollection"]},
                    {resource: {cluster: true}, actions: ["useUUID", "forceUUID"]}
                ]
              },
          ]
        },
        {
          testname: "applyOps_c_create_UUID_failure",
          command: {
              applyOps: [{
                  "ui": UUID("71f1d1d7-68ca-493e-a7e9-f03c94e2e960"),
                  "op": "c",
                  "ns": firstDbName + ".$cmd",
                  "o": {
                      "create": "x",
                  }
              }]
          },
          skipSharded: true,
          setup: function(db) {},
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [{
              expectAuthzFailure: true,
              runOnDb: adminDbName,
              privileges: [
                  {resource: {db: firstDbName, collection: "x"}, actions: ["createCollection"]},
                  // Do not have forceUUID.
                  {resource: {cluster: true}, actions: ["useUUID"]}
              ]
          }]
        },
        {
          testname: "applyOps_c_drop",
          command: {
              applyOps: [{
                  "op": "c",
                  "ns": firstDbName + ".$cmd",
                  "o": {
                      "drop": "x",
                  }
              }]
          },
          skipSharded: true,
          setup: function(db) {
              db.getSisterDB(firstDbName).x.save({});
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {
                    readWrite: 1,
                    dbAdmin: 1,
                    dbOwner: 1,
                    readWriteAnyDatabase: 1,
                    dbAdminAnyDatabase: 1,
                    root: 1,
                    restore: 1,
                    __system: 1
                },
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["dropCollection"]},
                ]
              },
          ]
        },
        {
          testname: "applyOps_c_drop_UUID",
          command: function(state) {
              return {
                  applyOps: [{
                      "op": "c",
                      "ui": state.uuid,
                      "ns": firstDbName + ".$cmd",
                      "o": {
                          "drop": "x",
                      }
                  }]
              };
          },
          skipSharded: true,
          setup: function(db) {
              var sibling = db.getSisterDB(firstDbName);
              sibling.runCommand({create: "x"});

              return {
                  collName: sibling.x.getFullName(),
                  uuid: getUUIDFromListCollections(sibling, sibling.x.getName())
              };
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {root: 1, restore: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["dropCollection"]},
                    {resource: {cluster: true}, actions: ["useUUID"]}
                ]
              },
          ]
        },
        {
          testname: "applyOps_c_drop_UUID_failure",
          command: function(state) {
              return {
                  applyOps: [{
                      "op": "c",
                      "ui": state.uuid,
                      "ns": firstDbName + ".$cmd",
                      "o": {
                          "drop": "x",
                      }
                  }]
              };
          },
          skipSharded: true,
          setup: function(db) {
              var sibling = db.getSisterDB(firstDbName);
              sibling.runCommand({create: "x"});

              return {
                  collName: sibling.x.getFullName(),
                  uuid: getUUIDFromListCollections(sibling, sibling.x.getName())
              };
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                expectAuthzFailure: true,
                runOnDb: adminDbName,
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["dropCollection"]}
                    // don't have useUUID privilege.
                ]
              },
          ]
        },
        {
          testname: "applyOps_noop",
          command: {applyOps: [{"op": "n", "ns": "", "o": {}}]},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                privileges: [
                    {resource: {cluster: true}, actions: ["appendOplogNote"]},
                ],
              },
              {
                runOnDb: firstDbName,
                privileges: [
                    {resource: {cluster: true}, actions: ["appendOplogNote"]},
                ],
                expectFailure: true
              }
          ]
        },
        {
          testname: "applyOps_c_renameCollection_twoDbs",
          command: {
              applyOps: [{
                  "op": "c",
                  "ns": firstDbName + ".$cmd",
                  "o": {
                      "renameCollection": firstDbName + ".x",
                      "to": secondDbName + ".y",
                      "stayTemp": false,
                      "dropTarget": false
                  }
              }]
          },
          skipSharded: true,
          setup: function(db) {
              db.getSisterDB(firstDbName).x.save({});
              db.getSisterDB(adminDbName).runCommand({movePrimary: firstDbName, to: shard0name});
              db.getSisterDB(adminDbName).runCommand({movePrimary: secondDbName, to: shard0name});
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
              db.getSisterDB(secondDbName).y.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [
                    {
                      resource: {db: firstDbName, collection: "x"},
                      actions: ["find", "dropCollection"]
                    },
                    {
                      resource: {db: secondDbName, collection: "y"},
                      actions: ["insert", "createIndex"]
                    }
                ]
              },
          ]
        },
        {
          testname: "applyOps_insert",
          command: {
              applyOps: [{
                  "op": "i",
                  "ns": firstDbName + ".x",
                  "o": {"_id": ObjectId("57dc3d7da4fce4358afa85b8"), "data": 5}
              }]
          },
          skipSharded: true,
          setup: function(db) {
              db.getSisterDB(firstDbName).x.save({});
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_write,
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["insert"]},
                ],
              },
          ]
        },
        {
          testname: "applyOps_insert_UUID",
          command: function(state) {
              return {
                  applyOps: [{
                      "op": "i",
                      "ns": state.collName,
                      "ui": state.uuid,
                      "o": {"_id": ObjectId("57dc3d7da4fce4358afa85b8"), "data": 5}
                  }]
              };
          },
          skipSharded: true,
          setup: function(db) {
              var sibling = db.getSisterDB(firstDbName);
              sibling.runCommand({create: "x"});

              return {
                  collName: sibling.x.getFullName(),
                  uuid: getUUIDFromListCollections(sibling, sibling.x.getName())
              };
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {root: 1, restore: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["insert"]},
                    {resource: {cluster: true}, actions: ["useUUID"]}
                ],
              },
          ]
        },
        {
          testname: "applyOps_insert_with_nonexistent_UUID",
          command: function(state) {
              return {
                  applyOps: [{
                      "op": "i",
                      "ns": state.collName,
                      // Given a nonexistent UUID. The command should fail.
                      "ui": UUID("71f1d1d7-68ca-493e-a7e9-f03c94e2e960"),
                      "o": {"_id": ObjectId("57dc3d7da4fce4358afa85b8"), "data": 5}
                  }]
              };
          },
          skipSharded: true,
          setup: function(db) {
              var sibling = db.getSisterDB(firstDbName);
              sibling.runCommand({create: "x"});

              return {
                  collName: sibling.x.getFullName(),
                  uuid: getUUIDFromListCollections(sibling, sibling.x.getName())
              };
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                // It would be an sanity check failure rather than a auth check
                // failure.
                expectFail: true,
                runOnDb: adminDbName,
                roles: {root: 1, restore: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["insert"]},
                    {resource: {cluster: true}, actions: ["useUUID"]}
                ],
              },
          ]
        },
        {
          testname: "applyOps_insert_UUID_failure",
          command: function(state) {
              return {
                  applyOps: [{
                      "op": "i",
                      "ns": state.collName,
                      "ui": state.uuid,
                      "o": {"_id": ObjectId("57dc3d7da4fce4358afa85b8"), "data": 5}
                  }]
              };
          },
          skipSharded: true,
          setup: function(db) {
              var sibling = db.getSisterDB(firstDbName);
              sibling.runCommand({create: "x"});

              return {
                  collName: sibling.x.getFullName(),
                  uuid: getUUIDFromListCollections(sibling, sibling.x.getName())
              };
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                expectAuthzFailure: true,
                runOnDb: adminDbName,
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["insert"]},
                    // Don't have useUUID privilege.
                ],
              },
          ]
        },
        {
          testname: "applyOps_create_and_insert_UUID_failure",
          command: function(state) {
              return {
                  applyOps: [
                      {
                        "ui": UUID("71f1d1d7-68ca-493e-a7e9-f03c94e2e960"),
                        "op": "c",
                        "ns": firstDbName + ".$cmd",
                        "o": {
                            "create": "x",
                        }
                      },
                      {
                        "op": "i",
                        "ns": firstDbName + ".x",
                        "ui": UUID("71f1d1d7-68ca-493e-a7e9-f03c94e2e960"),
                        "o": {"_id": ObjectId("57dc3d7da4fce4358afa85b8"), "data": 5}
                      }
                  ]
              };
          },
          skipSharded: true,
          setup: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                // Batching createCollection and insert together is not allowed.
                expectAuthzFailure: true,
                runOnDb: adminDbName,
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["insert"]},
                    {resource: {cluster: true}, actions: ["useUUID", "forceUUID"]}
                    // Require universal privilege set.
                ],
              },
          ]
        },
        {
          testname: "applyOps_insert_UUID_with_wrong_ns",
          command: function(state) {
              return {
                  applyOps: [{
                      "op": "i",
                      "ns":
                          firstDbName + ".y",  // Specify wrong name but correct uuid. Should work.
                      "ui": state.x_uuid,      // The insert should on x
                      "o": {"_id": ObjectId("57dc3d7da4fce4358afa85b8"), "data": 5}
                  }]
              };
          },
          skipSharded: true,
          setup: function(db) {
              db.getSisterDB(firstDbName).x.drop();
              db.getSisterDB(firstDbName).y.drop();
              var sibling = db.getSisterDB(firstDbName);
              sibling.runCommand({create: "x"});
              sibling.runCommand({create: "y"});
              return {x_uuid: getUUIDFromListCollections(sibling, sibling.x.getName())};
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                privileges: [
                    {
                      resource: {db: firstDbName, collection: "x"},
                      actions: ["createCollection", "insert"]
                    },
                    {resource: {db: firstDbName, collection: "y"}, actions: ["createCollection"]},
                    {resource: {cluster: true}, actions: ["useUUID", "forceUUID"]}
                ],
              },
          ]
        },
        {
          testname: "applyOps_insert_UUID_with_wrong_ns_failure",
          command: function(state) {
              return {
                  applyOps: [{
                      "op": "i",
                      "ns":
                          firstDbName + ".y",  // Specify wrong name but correct uuid. Should work.
                      "ui": state.x_uuid,      // The insert should on x
                      "o": {"_id": ObjectId("57dc3d7da4fce4358afa85b8"), "data": 5}
                  }]
              };
          },
          skipSharded: true,
          setup: function(db) {
              db.getSisterDB(firstDbName).x.drop();
              db.getSisterDB(firstDbName).y.drop();
              var sibling = db.getSisterDB(firstDbName);
              sibling.runCommand({create: "x"});
              sibling.runCommand({create: "y"});
              return {x_uuid: getUUIDFromListCollections(sibling, sibling.x.getName())};
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                expectAuthzFailure: true,
                runOnDb: adminDbName,
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["createCollection"]},
                    {
                      resource: {db: firstDbName, collection: "y"},
                      actions: ["createCollection", "insert"]
                    },
                    {resource: {cluster: true}, actions: ["useUUID", "forceUUID"]}
                ],
              },
          ]
        },
        {
          testname: "applyOps_upsert",
          command: {
              applyOps: [{
                  "op": "u",
                  "ns": firstDbName + ".x",
                  "o2": {"_id": 1},
                  "o": {"_id": 1, "data": 8}
              }]
          },
          skipSharded: true,
          setup: function(db) {
              db.getSisterDB(firstDbName).x.save({_id: 1, data: 1});
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                roles: Object.merge(roles_write, {restore: 0}, true),
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["update", "insert"]},
                ],
              },
          ]
        },
        {
          testname: "applyOps_update",
          command: {
              applyOps: [{
                  "op": "u",
                  "ns": firstDbName + ".x",
                  "o2": {"_id": 1},
                  "o": {"_id": 1, "data": 8}
              }],
              alwaysUpsert: false
          },
          skipSharded: true,
          setup: function(db) {
              db.getSisterDB(firstDbName).x.save({_id: 1, data: 1});
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                roles: Object.merge(roles_write, {restore: 0}, true),
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["update"]},
                ],
              },
          ]
        },
        {
          testname: "applyOps_update_UUID",
          command: function(state) {
              return {
                  applyOps: [{
                      "op": "u",
                      "ns": state.collName,
                      "ui": state.uuid,
                      "o2": {"_id": 1},
                      "o": {"_id": 1, "data": 8}
                  }],
                  alwaysUpsert: false
              };
          },
          skipSharded: true,
          setup: function(db) {
              var sibling = db.getSisterDB(firstDbName);
              sibling.x.save({_id: 1, data: 1});

              return {
                  collName: sibling.x.getFullName(),
                  uuid: getUUIDFromListCollections(sibling, sibling.x.getName())
              };
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["update"]},
                    {resource: {cluster: true}, actions: ["useUUID"]}
                ],
              },
          ]
        },
        {
          testname: "applyOps_update_UUID_failure",
          command: function(state) {
              return {
                  applyOps: [{
                      "op": "u",
                      "ns": state.collName,
                      "ui": state.uuid,
                      "o2": {"_id": 1},
                      "o": {"_id": 1, "data": 8}
                  }],
                  alwaysUpsert: false
              };
          },
          skipSharded: true,
          setup: function(db) {
              var sibling = db.getSisterDB(firstDbName);
              sibling.x.save({_id: 1, data: 1});

              return {
                  collName: sibling.x.getFullName(),
                  uuid: getUUIDFromListCollections(sibling, sibling.x.getName())
              };
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                expectAuthzFailure: true,
                runOnDb: adminDbName,
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["update"]},
                ],
              },
          ]
        },
        {
          testname: "applyOps_delete",
          command: {applyOps: [{"op": "d", "ns": firstDbName + ".x", "o": {"_id": 1}}]},
          skipSharded: true,
          setup: function(db) {
              db.getSisterDB(firstDbName).x.save({_id: 1, data: 1});
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                roles: Object.merge(roles_write, {restore: 0}, true),
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["remove"]},
                ],
              },
          ]
        },

        {
          testname: "aggregate_readonly",
          command: {aggregate: "foo", pipeline: [], cursor: {}},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [{resource: {db: firstDbName, collection: "foo"}, actions: ["find"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "foo"}, actions: ["find"]}]
              }
          ]
        },
        {
          testname: "aggregate_readonly_views",
          setup: function(db) {
              db.createView("view", "collection", [{$match: {}}]);
          },
          teardown: function(db) {
              db.view.drop();
          },
          command: {aggregate: "view", pipeline: [], cursor: {}},
          testcases: [
              // Tests that a user with read privileges on a view can aggregate it, even if they
              // don't have read privileges on the underlying namespace.
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [{resource: {db: firstDbName, collection: "view"}, actions: ["find"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "view"}, actions: ["find"]}]
              }
          ]
        },
        {
          testname: "aggregate_explain",
          command: {aggregate: "foo", explain: true, pipeline: [{$match: {bar: 1}}]},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [{resource: {db: firstDbName, collection: "foo"}, actions: ["find"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "foo"}, actions: ["find"]}]
              }
          ]
        },
        {
          testname: "aggregate_explain_views",
          setup: function(db) {
              db.createView("view", "collection", [{$match: {}}]);
          },
          teardown: function(db) {
              db.view.drop();
          },
          command: {aggregate: "view", explain: true, pipeline: [{$match: {bar: 1}}]},
          testcases: [
              // Tests that a user with read privileges on a view can explain an aggregation on the
              // view, even if they don't have read privileges on the underlying namespace.
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [{resource: {db: firstDbName, collection: "view"}, actions: ["find"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "view"}, actions: ["find"]}]
              }
          ]
        },
        {
          testname: "aggregate_out_legacy",
          command: function(state, args) {
              return {
                  aggregate: "foo",
                  pipeline: [{$out: "foo_out"}],
                  cursor: {},
                  bypassDocumentValidation: args.bypassDocumentValidation,
              };
          },
          testcases: [
              {
                runOnDb: firstDbName,
                commandArgs: {bypassDocumentValidation: false},
                roles: {readWrite: 1, readWriteAnyDatabase: 1, dbOwner: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "foo_out"}, actions: ["insert"]},
                    {resource: {db: firstDbName, collection: "foo_out"}, actions: ["remove"]}
                ]
              },
              {
                runOnDb: secondDbName,
                commandArgs: {bypassDocumentValidation: false},
                roles: {readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "foo_out"}, actions: ["insert"]},
                    {resource: {db: secondDbName, collection: "foo_out"}, actions: ["remove"]}
                ]
              },
              {
                runOnDb: firstDbName,
                commandArgs: {bypassDocumentValidation: true},
                // Note that the built-in role must have 'bypassDocumentValidation' for this test.
                roles: {dbOwner: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {
                      resource: {db: firstDbName, collection: "foo_out"},
                      actions: ["insert", "remove", "bypassDocumentValidation"]
                    },
                ]
              },
          ]
        },
        {
          testname: "aggregate_out_replace_collection",
          command: function(state, args) {
              return {
                  aggregate: "foo",
                  pipeline: [{$out: "foo_out"}],
                  cursor: {},
                  bypassDocumentValidation: args.bypassDocumentValidation,
              };
          },
          testcases: [
              {
                runOnDb: firstDbName,
                commandArgs: {bypassDocumentValidation: false},
                roles: {readWrite: 1, readWriteAnyDatabase: 1, dbOwner: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "foo_out"}, actions: ["insert"]},
                    {resource: {db: firstDbName, collection: "foo_out"}, actions: ["remove"]}
                ]
              },
              {
                runOnDb: secondDbName,
                commandArgs: {bypassDocumentValidation: false},
                roles: {readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "foo_out"}, actions: ["insert"]},
                    {resource: {db: secondDbName, collection: "foo_out"}, actions: ["remove"]}
                ]
              },
              {
                runOnDb: firstDbName,
                commandArgs: {bypassDocumentValidation: true},
                // Note that the built-in role must have 'bypassDocumentValidation' for this test.
                roles: {dbOwner: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {
                      resource: {db: firstDbName, collection: "foo_out"},
                      actions: ["insert", "remove", "bypassDocumentValidation"]
                    },
                ]
              },
              // TODO SERVER-36832: Test with a foreign database.
          ]
        },
        {
          testname: "aggregate_merge_insert_documents",
          command: function(state, args) {
              return {
                  aggregate: "foo",
                  pipeline: [{
                      $merge: {
                          into: {db: args.targetDB, coll: "foo_out"},
                          whenMatched: "fail",
                          whenNotMatched: "insert"
                      }
                  }],
                  cursor: {},
                  bypassDocumentValidation: args.bypassDocumentValidation,
              };
          },
          testcases: [
              {
                runOnDb: firstDbName,
                commandArgs: {targetDB: firstDbName, bypassDocumentValidation: false},
                roles: {readWrite: 1, readWriteAnyDatabase: 1, dbOwner: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "foo_out"}, actions: ["insert"]},
                ]
              },
              {
                runOnDb: secondDbName,
                commandArgs: {targetDB: secondDbName, bypassDocumentValidation: false},
                roles: {readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "foo_out"}, actions: ["insert"]},
                ]
              },
              {
                runOnDb: firstDbName,
                commandArgs: {targetDB: secondDbName, bypassDocumentValidation: false},
                roles: {readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "foo_out"}, actions: ["insert"]},
                ]
              },
              // Test for bypassDocumentValidation.
              {
                runOnDb: firstDbName,
                commandArgs: {targetDB: firstDbName, bypassDocumentValidation: true},
                // Note that the built-in role must have 'bypassDocumentValidation' for this test.
                roles: {dbOwner: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {
                      resource: {db: firstDbName, collection: "foo_out"},
                      actions: ["insert", "bypassDocumentValidation"]
                    },
                ]
              },
              // Test for bypassDocumentValidation to a foreign database.
              {
                runOnDb: firstDbName,
                commandArgs: {targetDB: secondDbName, bypassDocumentValidation: true},
                // Note that the built-in role must have 'bypassDocumentValidation' for this test.
                roles: {root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {
                      resource: {db: secondDbName, collection: "foo_out"},
                      actions: ["insert", "bypassDocumentValidation"]
                    },
                ]
              },
          ]
        },
        {
          testname: "aggregate_merge_replace_documents",
          command: function(state, args) {
              return {
                  aggregate: "foo",
                  pipeline: [{
                      $merge: {
                          into: {db: args.targetDB, coll: "foo_out"},
                          whenMatched: "replace",
                          whenNotMatched: "insert"
                      }
                  }],
                  cursor: {},
                  bypassDocumentValidation: args.bypassDocumentValidation,
              };
          },
          testcases: [
              {
                runOnDb: firstDbName,
                commandArgs: {targetDB: firstDbName, bypassDocumentValidation: false},
                roles: {readWrite: 1, readWriteAnyDatabase: 1, dbOwner: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "foo_out"}, actions: ["insert"]},
                    {resource: {db: firstDbName, collection: "foo_out"}, actions: ["update"]},
                ]
              },
              {
                runOnDb: secondDbName,
                commandArgs: {targetDB: secondDbName, bypassDocumentValidation: false},
                roles: {readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "foo_out"}, actions: ["insert"]},
                    {resource: {db: secondDbName, collection: "foo_out"}, actions: ["update"]},
                ]
              },
              {
                runOnDb: firstDbName,
                commandArgs: {targetDB: secondDbName, bypassDocumentValidation: false},
                roles: {readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "foo_out"}, actions: ["insert"]},
                    {resource: {db: secondDbName, collection: "foo_out"}, actions: ["update"]},
                ]
              },
              // Test for bypassDocumentValidation.
              {
                runOnDb: firstDbName,
                commandArgs: {targetDB: firstDbName, bypassDocumentValidation: true},
                // Note that the built-in role must have 'bypassDocumentValidation' for this test.
                roles: {dbOwner: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {
                      resource: {db: firstDbName, collection: "foo_out"},
                      actions: ["insert", "update", "bypassDocumentValidation"]
                    },
                ]
              },
              // Test for bypassDocumentValidation to a foreign database.
              {
                runOnDb: firstDbName,
                commandArgs: {targetDB: secondDbName, bypassDocumentValidation: true},
                // Note that the built-in role must have 'bypassDocumentValidation' for this test.
                roles: {root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {
                      resource: {db: secondDbName, collection: "foo_out"},
                      actions: ["insert", "update", "bypassDocumentValidation"]
                    },
                ]
              },
          ]
        },
        {
          testname: "aggregate_readView_writeCollection",
          setup: function(db) {
              db.createView("view", "collection", [{$match: {}}]);
          },
          teardown: function(db) {
              db.view.drop();
          },
          command: {aggregate: "view", pipeline: [{$out: "view_out"}], cursor: {}},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {readWrite: 1, readWriteAnyDatabase: 1, dbOwner: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "view"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "view_out"}, actions: ["insert"]},
                    {resource: {db: firstDbName, collection: "view_out"}, actions: ["remove"]}
                ]
              },
              {
                runOnDb: secondDbName,
                roles: {readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: secondDbName, collection: "view"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "view_out"}, actions: ["insert"]},
                    {resource: {db: secondDbName, collection: "view_out"}, actions: ["remove"]}
                ]
              }
          ]
        },
        {
          testname: "aggregate_writeView",
          setup: function(db) {
              db.createView("view", "collection", [{$match: {}}]);
          },
          teardown: function(db) {
              db.view.drop();
          },
          command: {aggregate: "foo", pipeline: [{$out: "view"}], cursor: {}},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {readWrite: 1, readWriteAnyDatabase: 1, dbOwner: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "view"}, actions: ["insert"]},
                    {resource: {db: firstDbName, collection: "view"}, actions: ["remove"]}
                ],
                expectFail: true  // Cannot write to a view.
              },
              {
                runOnDb: secondDbName,
                roles: {readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "view"}, actions: ["insert"]},
                    {resource: {db: secondDbName, collection: "view"}, actions: ["remove"]}
                ],
                expectFail: true  // Cannot write to a view.
              }
          ]
        },
        {
          testname: "aggregate_indexStats",
          command: {aggregate: "foo", pipeline: [{$indexStats: {}}], cursor: {}},
          setup: function(db) {
              db.createCollection("foo");
          },
          teardown: function(db) {
              db.foo.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_monitoring,
                privileges:
                    [{resource: {db: firstDbName, collection: "foo"}, actions: ["indexStats"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_monitoring,
                privileges:
                    [{resource: {db: secondDbName, collection: "foo"}, actions: ["indexStats"]}]
              }
          ]
        },
        {
          testname: "aggregate_planCacheStats",
          command: {aggregate: "foo", pipeline: [{$planCacheStats: {}}], cursor: {}},
          skipSharded: true,
          setup: function(db) {
              db.createCollection("foo");
          },
          teardown: function(db) {
              db.foo.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_readDbAdmin,
                privileges:
                    [{resource: {db: firstDbName, collection: "foo"}, actions: ["planCacheRead"]}],
              },
              {
                runOnDb: secondDbName,
                roles: roles_readDbAdminAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "foo"}, actions: ["planCacheRead"]}],
              },
          ]
        },
        {
          testname: "aggregate_currentOp_allUsers_true",
          command: {aggregate: 1, pipeline: [{$currentOp: {allUsers: true}}], cursor: {}},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_monitoring,
                privileges: [{resource: {cluster: true}, actions: ["inprog"]}]
              },
              {
                runOnDb: adminDbName,
                privileges: [{resource: {cluster: true}, actions: ["inprog"]}]
              },
              {
                runOnDb: firstDbName,
                roles: roles_monitoring,
                privileges: [{resource: {cluster: true}, actions: ["inprog"]}],
                expectFail: true
              }
          ]
        },
        {
          testname: "aggregate_currentOp_allUsers_false",
          command: {aggregate: 1, pipeline: [{$currentOp: {allUsers: false}}], cursor: {}},
          testcases: [{runOnDb: adminDbName, roles: roles_all}],
          skipSharded: true
        },
        {
          testname: "aggregate_currentOp_allUsers_false_localOps_true",
          command: {
              aggregate: 1,
              pipeline: [{$currentOp: {allUsers: false, localOps: true}}],
              cursor: {}
          },
          testcases: [{runOnDb: adminDbName, roles: roles_all}]
        },
        {
          testname: "aggregate_listLocalSessions_allUsers_true",
          command: {aggregate: 1, pipeline: [{$listLocalSessions: {allUsers: true}}], cursor: {}},
          testcases: [{
              runOnDb: "config",
              roles:
                  {clusterAdmin: 1, clusterMonitor: 1, clusterManager: 1, root: 1, __system: 1}
          }],
          skipSharded: true
        },
        {
          testname: "aggregate_listLocalSessions_allUsers_false",
          command: {aggregate: 1, pipeline: [{$listLocalSessions: {allUsers: false}}], cursor: {}},
          testcases: [{runOnDb: adminDbName, roles: roles_all}],
          skipSharded: true
        },
        {
          testname: "aggregate_listSessions_allUsers_true",
          command: {
              aggregate: 'system.sessions',
              pipeline: [{$listSessions: {allUsers: true}}],
              cursor: {}
          },
          testcases: [{
              runOnDb: "config",
              roles:
                  {clusterAdmin: 1, clusterMonitor: 1, clusterManager: 1, root: 1, __system: 1}
          }]
        },
        {
          testname: "aggregate_listSessions_allUsers_false",
          command: {
              aggregate: 'system.sessions',
              pipeline: [{$listSessions: {allUsers: false}}],
              cursor: {}
          },
          testcases: [{runOnDb: "config", roles: roles_all}]
        },
        {
          testname: "aggregate_lookup",
          command: {
              aggregate: "foo",
              pipeline:
                  [{$lookup: {from: "bar", localField: "_id", foreignField: "_id", as: "results"}}],
              cursor: {}
          },
          setup: function(db) {
              db.createCollection("foo");
              db.createCollection("bar");
          },
          teardown: function(db) {
              db.foo.drop();
              db.bar.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "bar"}, actions: ["find"]}
                ]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges: [
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "bar"}, actions: ["find"]}
                ]
              }
          ]
        },
        {
          testname: "aggregate_lookup_nested_pipeline",
          command: {
              aggregate: "foo",
              pipeline: [{
                  $lookup: {
                      from: "bar",
                      pipeline: [{$lookup: {from: "baz", pipeline: [], as: "lookup2"}}],
                      as: "lookup1"
                  }
              }],
              cursor: {}
          },
          setup: function(db) {
              db.createCollection("foo");
              db.createCollection("bar");
              db.createCollection("baz");
          },
          teardown: function(db) {
              db.foo.drop();
              db.bar.drop();
              db.baz.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "bar"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "baz"}, actions: ["find"]}
                ]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges: [
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "bar"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "baz"}, actions: ["find"]}
                ]
              }
          ]
        },
        {
          testname: "aggregate_lookup_views",
          setup: function(db) {
              db.createView("view", "collection", [{$match: {}}]);
              db.createCollection("foo");
          },
          teardown: function(db) {
              db.view.drop();
              db.foo.drop();
          },
          command: {
              aggregate: "foo",
              pipeline: [
                  {$lookup: {from: "view", localField: "_id", foreignField: "_id", as: "results"}}
              ],
              cursor: {}
          },
          testcases: [
              // Tests that a user can successfully $lookup into a view when given read access.
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [
                    {resource: {db: firstDbName, collection: "view"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]}
                ]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges: [
                    {resource: {db: secondDbName, collection: "view"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]}
                ]
              }
          ]
        },
        {
          testname: "aggregate_graphLookup",
          command: {
              aggregate: "foo",
              pipeline: [{
                  $graphLookup: {
                      from: "bar",
                      startWith: [1],
                      connectFromField: "_id",
                      connectToField: "barId",
                      as: "results"
                  }
              }],
              cursor: {}
          },
          setup: function(db) {
              db.createCollection("foo");
              db.createCollection("bar");
          },
          teardown: function(db) {
              db.foo.drop();
              db.bar.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "bar"}, actions: ["find"]}
                ]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges: [
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "bar"}, actions: ["find"]}
                ]
              }
          ]
        },
        {
          testname: "aggregate_graphLookup_views",
          setup: function(db) {
              db.createView("view", "collection", [{$match: {}}]);
              db.createCollection("foo");
          },
          teardown: function(db) {
              db.view.drop();
              db.foo.drop();
          },
          command: {
              aggregate: "foo",
              pipeline: [{
                  $graphLookup: {
                      from: "view",
                      startWith: [1],
                      connectFromField: "_id",
                      connectToField: "viewId",
                      as: "results"
                  }
              }],
              cursor: {}
          },
          testcases: [
              // Tests that a user can successfully $graphLookup into a view when given read access.
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [
                    {resource: {db: firstDbName, collection: "view"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]}
                ]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges: [
                    {resource: {db: secondDbName, collection: "view"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]}
                ]
              }
          ]
        },
        {
          testname: "aggregate_collStats",
          command: {aggregate: "foo", pipeline: [{$collStats: {latencyStats: {}}}], cursor: {}},
          setup: function(db) {
              db.createCollection("foo");
          },
          teardown: function(db) {
              db.foo.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {
                    read: 1,
                    readAnyDatabase: 1,
                    readWrite: 1,
                    readWriteAnyDatabase: 1,
                    dbAdmin: 1,
                    dbAdminAnyDatabase: 1,
                    dbOwner: 1,
                    clusterMonitor: 1,
                    clusterAdmin: 1,
                    backup: 1,
                    root: 1,
                    __system: 1
                },
                privileges:
                    [{resource: {db: firstDbName, collection: "foo"}, actions: ["collStats"]}]
              },
              {
                runOnDb: secondDbName,
                roles: {
                    readAnyDatabase: 1,
                    readWriteAnyDatabase: 1,
                    dbAdminAnyDatabase: 1,
                    clusterMonitor: 1,
                    clusterAdmin: 1,
                    backup: 1,
                    root: 1,
                    __system: 1
                },
                privileges:
                    [{resource: {db: secondDbName, collection: "foo"}, actions: ["collStats"]}]
              }
          ]
        },
        {
          testname: "aggregate_facet",
          command: {
              aggregate: "foo",
              pipeline: [{
                  // There are stages within the $facet stage that require additional privileges.
                  $facet: {
                      lookup: [{
                          $lookup: {
                              from: "bar",
                              localField: "_id",
                              foreignField: "_id",
                              as: "results"
                          }
                      }],
                      graphLookup: [{
                          $graphLookup: {
                              from: "baz",
                              startWith: [1],
                              connectFromField: "_id",
                              connectToField: "bazId",
                              as: "results"
                          }
                      }]
                  }
              }],
              cursor: {}
          },
          setup: function(db) {
              db.createCollection("foo");
              db.createCollection("bar");
              db.createCollection("baz");
          },
          teardown: function(db) {
              db.foo.drop();
              db.bar.drop();
              db.baz.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "bar"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "baz"}, actions: ["find"]}
                ]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges: [
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "bar"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "baz"}, actions: ["find"]}
                ]
              }
          ]
        },
        {
          testname: "aggregate_facet_views",
          command: {
              aggregate: "foo",
              pipeline: [{
                  $facet: {
                      lookup: [{
                          $lookup: {
                              from: "view1",
                              localField: "_id",
                              foreignField: "_id",
                              as: "results"
                          }
                      }],
                      graphLookup: [{
                          $graphLookup: {
                              from: "view2",
                              startWith: "foo",
                              connectFromField: "_id",
                              connectToField: "_id",
                              as: "results"
                          }
                      }]
                  }
              }],
              cursor: {}
          },
          setup: function(db) {
              db.createCollection("foo");
              db.createView("view1", "bar", [
                  {$lookup: {from: "qux", localField: "_id", foreignField: "_id", as: "results"}}
              ]);
              db.createView("view2", "baz", [{
                                $graphLookup: {
                                    from: "quz",
                                    startWith: [1],
                                    connectFromField: "_id",
                                    connectToField: "_id",
                                    as: "results"
                                }
                            }]);
          },
          teardown: function(db) {
              db.foo.drop();
              db.view1.drop();
              db.view2.drop();
          },
          testcases: [
              // Tests that a user can successfully $lookup and $graphLookup into views when the
              // lookups are nested within a $facet.
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "view1"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "view2"}, actions: ["find"]}
                ]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges: [
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "view1"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "view2"}, actions: ["find"]}
                ]
              }
          ]
        },
        {
          testname: "aggregate_changeStream_one_collection",
          command: {aggregate: "foo", pipeline: [{$changeStream: {}}], cursor: {}},
          setup: function(db) {
              db.createCollection("foo");
          },
          teardown: function(db) {
              db.foo.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {
                    read: 1,
                    readAnyDatabase: 1,
                    readWrite: 1,
                    readWriteAnyDatabase: 1,
                    dbOwner: 1,
                    root: 1,
                    __system: 1
                },
                privileges: [{
                    resource: {db: firstDbName, collection: "foo"},
                    actions: ["changeStream", "find"]
                }],
                expectFail: true,  // because no replication enabled
              },
              {
                runOnDb: secondDbName,
                roles: {readAnyDatabase: 1, readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [{
                    resource: {db: secondDbName, collection: "foo"},
                    actions: ["changeStream", "find"]
                }],
                expectFail: true,  // because no replication enabled
              }
          ]
        },
        {
          testname: "aggregate_changeStream_whole_db",
          command: {aggregate: 1, pipeline: [{$changeStream: {}}], cursor: {}},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {
                    read: 1,
                    readAnyDatabase: 1,
                    readWrite: 1,
                    readWriteAnyDatabase: 1,
                    dbOwner: 1,
                    root: 1,
                    __system: 1
                },
                privileges: [{
                    resource: {db: firstDbName, collection: ""},
                    actions: ["changeStream", "find"]
                }],
                expectFail: true,  // because no replication enabled
              },
              {
                runOnDb: secondDbName,
                roles: {readAnyDatabase: 1, readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [{
                    resource: {db: secondDbName, collection: ""},
                    actions: ["changeStream", "find"]
                }],
                expectFail: true,  // because no replication enabled
              }
          ]
        },
        {
          testname: "aggregate_changeStream_whole_cluster",
          command:
              {aggregate: 1, pipeline: [{$changeStream: {allChangesForCluster: true}}], cursor: {}},
          testcases: [{
              runOnDb: adminDbName,
              roles: {readAnyDatabase: 1, readWriteAnyDatabase: 1, root: 1, __system: 1},
              privileges: [{resource: {db: "", collection: ""}, actions: ["changeStream", "find"]}],
              expectFail: true,  // because no replication enabled
          }]
        },
        {
          testname: "appendOplogNote",
          command: {appendOplogNote: 1, data: {a: 1}},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {backup: 1, clusterManager: 1, clusterAdmin: 1, root: 1, __system: 1},
                privileges: [{resource: {cluster: true}, actions: ["appendOplogNote"]}],
                expectFail: true,  // because no replication enabled
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "aggregate_geoNear",
          command: {
              aggregate: "coll",
              cursor: {},
              pipeline: [{$geoNear: {near: [50, 50], distanceField: "dist"}}]
          },
          setup: (db) => {
              db.coll.drop();
              assert.commandWorked(db.coll.createIndex({loc: "2d"}));
              assert.commandWorked(db.coll.insert({loc: [45.32, 51.12]}));
          },
          teardown: (db) => {
              db.coll.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [{resource: {db: firstDbName, collection: "coll"}, actions: ["find"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "coll"}, actions: ["find"]}]
              },
          ],
        },
        {
          testname: "buildInfo",
          command: {buildInfo: 1},
          testcases: [
              {runOnDb: firstDbName, roles: roles_all, privileges: []},
              {runOnDb: secondDbName, roles: roles_all, privileges: []}
          ]
        },
        {
          testname: "checkShardingIndex_firstDb",
          command: {checkShardingIndex: firstDbName + ".x", keyPattern: {_id: 1}},
          skipSharded: true,
          testcases: [{
              runOnDb: firstDbName,
              roles: roles_read,
              privileges: [{resource: {db: firstDbName, collection: "x"}, actions: ["find"]}]
          }]
        },
        {
          testname: "checkShardingIndex_secondDb",
          command: {checkShardingIndex: secondDbName + ".x", keyPattern: {_id: 1}},
          skipSharded: true,
          testcases: [{
              runOnDb: secondDbName,
              roles: roles_readAny,
              privileges: [{resource: {db: secondDbName, collection: "x"}, actions: ["find"]}]
          }]
        },
        {
          testname: "cleanupOrphaned",
          command: {cleanupOrphaned: firstDbName + ".x"},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {cluster: true}, actions: ["cleanupOrphaned"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "cloneCollectionAsCapped",
          command: {cloneCollectionAsCapped: "x", toCollection: "y", size: 1000},
          skipSharded: true,
          setup: function(db) {
              db.x.save({});
          },
          teardown: function(db) {
              db.x.drop();
              db.y.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {readWrite: 1, readWriteAnyDatabase: 1, dbOwner: 1, root: 1, __system: 1},
                privileges: [
                    {
                      resource: {db: firstDbName, collection: "y"},
                      actions: ["insert", "createIndex", "convertToCapped"]
                    },
                    {resource: {db: firstDbName, collection: "x"}, actions: ["find"]}
                ]
              },
              {
                runOnDb: secondDbName,
                roles: {readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [
                    {
                      resource: {db: secondDbName, collection: "y"},
                      actions: ["insert", "createIndex", "convertToCapped"]
                    },
                    {resource: {db: secondDbName, collection: "x"}, actions: ["find"]}
                ]
              }
          ]
        },
        {
          testname: "collMod",
          command: {collMod: "foo"},
          setup: function(db) {
              db.foo.save({});
          },
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_dbAdmin),
                privileges:
                    [{resource: {db: firstDbName, collection: "foo"}, actions: ["collMod"]}]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_dbAdminAny),
                privileges:
                    [{resource: {db: secondDbName, collection: "foo"}, actions: ["collMod"]}]
              }
          ]
        },
        {
          testname: "collMod_views",
          setup: function(db) {
              db.createView("view", "foo", [{$match: {}}]);
          },
          teardown: function(db) {
              db.view.drop();
          },
          command: {collMod: "view", viewOn: "bar", pipeline: [{$limit: 7}]},
          testcases: [
              // Tests that a user who can modify a view (but not read it) may modify it to be a
              // view on a namespace the user also cannot read.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_dbAdmin),
                privileges:
                    [{resource: {db: firstDbName, collection: "view"}, actions: ["collMod"]}]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_dbAdminAny),
                privileges:
                    [{resource: {db: secondDbName, collection: "view"}, actions: ["collMod"]}]
              },
              // Tests that a user who can both read and modify a view has read privileges on the
              // view's underlying namespace.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_dbAdmin),
                privileges: [
                    {resource: {db: firstDbName, collection: "bar"}, actions: ["find"]},
                    {
                      resource: {db: firstDbName, collection: "view"},
                      actions: ["collMod", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_dbAdminAny),
                privileges: [
                    {resource: {db: secondDbName, collection: "bar"}, actions: ["find"]},
                    {
                      resource: {db: secondDbName, collection: "view"},
                      actions: ["collMod", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ]
              }
          ]
        },
        {
          testname: "collMod_views_lookup",
          setup: function(db) {
              db.createView("view", "foo", [{$match: {}}]);
          },
          teardown: function(db) {
              db.view.drop();
          },
          command: {
              collMod: "view",
              viewOn: "bar",
              pipeline: [
                  {$lookup: {from: "baz", localField: "_id", foreignField: "_id", as: "results"}}
              ]
          },
          testcases: [
              // Tests that a user who can modify a view (but not read it) may modify it to depend
              // on namespaces the user also cannot read, including namespaces accessed via $lookup.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_dbAdmin),
                privileges:
                    [{resource: {db: firstDbName, collection: "view"}, actions: ["collMod"]}]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_dbAdminAny),
                privileges:
                    [{resource: {db: secondDbName, collection: "view"}, actions: ["collMod"]}]
              },
              // Tests that a user who can both read and modify a view has read privileges on all
              // the view's dependent namespaces, including namespaces accessed via $lookup.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_dbAdmin),
                privileges: [
                    {resource: {db: firstDbName, collection: "bar"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "baz"}, actions: ["find"]},
                    {
                      resource: {db: firstDbName, collection: "view"},
                      actions: ["collMod", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_dbAdminAny),
                privileges: [
                    {resource: {db: secondDbName, collection: "bar"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "baz"}, actions: ["find"]},
                    {
                      resource: {db: secondDbName, collection: "view"},
                      actions: ["collMod", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ]
              }
          ]
        },
        {
          testname: "collMod_views_graphLookup",
          setup: function(db) {
              db.createView("view", "foo", [{$match: {}}]);
          },
          teardown: function(db) {
              db.view.drop();
          },
          command: {
              collMod: "view",
              viewOn: "bar",
              pipeline: [{
                  $graphLookup: {
                      from: "baz",
                      startWith: [1],
                      connectFromField: "_id",
                      connectToField: "bazId",
                      as: "results"
                  }
              }]
          },
          testcases: [
              // Tests that a user who can modify a view (but not read it) may modify it to depend
              // on namespaces the user also cannot read, including namespaces accessed via
              // $graphLookup.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_dbAdmin),
                privileges:
                    [{resource: {db: firstDbName, collection: "view"}, actions: ["collMod"]}]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_dbAdminAny),
                privileges:
                    [{resource: {db: secondDbName, collection: "view"}, actions: ["collMod"]}]
              },
              // Tests that a user who can both read and modify a view has read privileges on all
              // the view's dependent namespaces, including namespaces accessed via $graphLookup.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_dbAdmin),
                privileges: [
                    {resource: {db: firstDbName, collection: "bar"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "baz"}, actions: ["find"]},
                    {
                      resource: {db: firstDbName, collection: "view"},
                      actions: ["collMod", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_dbAdminAny),
                privileges: [
                    {resource: {db: secondDbName, collection: "bar"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "baz"}, actions: ["find"]},
                    {
                      resource: {db: secondDbName, collection: "view"},
                      actions: ["collMod", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ]
              }
          ]
        },
        {
          testname: "collMod_views_facet",
          setup: function(db) {
              db.createView("view", "foo", []);
          },
          teardown: function(db) {
              db.view.drop();
          },
          command: {
              collMod: "view",
              viewOn: "bar",
              pipeline: [{
                  $facet: {
                      lookup: [{
                          $lookup: {
                              from: "baz",
                              localField: "_id",
                              foreignField: "_id",
                              as: "results"
                          }
                      }],
                      graphLookup: [{
                          $graphLookup: {
                              from: "qux",
                              startWith: "blah",
                              connectFromField: "_id",
                              connectToField: "_id",
                              as: "results"
                          }
                      }]
                  }
              }]
          },
          testcases: [
              // Tests that a user who can modify a view (but not read it) may modify it to depend
              // on namespaces the user also cannot read, including namespaces accessed via $lookup
              // and $graphLookup that are nested within a $facet.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_dbAdmin),
                privileges:
                    [{resource: {db: firstDbName, collection: "view"}, actions: ["collMod"]}],
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_dbAdminAny),
                privileges:
                    [{resource: {db: secondDbName, collection: "view"}, actions: ["collMod"]}],
              },
              // Tests that a user who can both read and modify a view has read privileges on all
              // the view's dependent namespaces, including namespaces accessed via $lookup and
              // $graphLookup that are nested within a $facet.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_dbAdmin),
                privileges: [
                    {resource: {db: firstDbName, collection: "bar"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "baz"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "qux"}, actions: ["find"]},
                    {
                      resource: {db: firstDbName, collection: "view"},
                      actions: ["collMod", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ],
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_dbAdminAny),
                privileges: [
                    {resource: {db: secondDbName, collection: "bar"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "baz"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "qux"}, actions: ["find"]},
                    {
                      resource: {db: secondDbName, collection: "view"},
                      actions: ["collMod", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ],
              }
          ]
        },
        {
          testname: "collStats",
          command: {collStats: "bar", scale: 1},
          setup: function(db) {
              db.bar.save({});
          },
          teardown: function(db) {
              db.dropDatabase();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {
                    read: 1,
                    readAnyDatabase: 1,
                    readWrite: 1,
                    readWriteAnyDatabase: 1,
                    dbAdmin: 1,
                    dbAdminAnyDatabase: 1,
                    dbOwner: 1,
                    clusterMonitor: 1,
                    clusterAdmin: 1,
                    backup: 1,
                    root: 1,
                    __system: 1
                },
                privileges:
                    [{resource: {db: firstDbName, collection: "bar"}, actions: ["collStats"]}]
              },
              {
                runOnDb: secondDbName,
                roles: {
                    readAnyDatabase: 1,
                    readWriteAnyDatabase: 1,
                    dbAdminAnyDatabase: 1,
                    clusterMonitor: 1,
                    clusterAdmin: 1,
                    backup: 1,
                    root: 1,
                    __system: 1
                },
                privileges:
                    [{resource: {db: secondDbName, collection: "bar"}, actions: ["collStats"]}]
              }
          ]
        },
        {
          testname: "commitTxn",
          command: {commitTransaction: 1},
          skipSharded: true,
          skipUnlessReplicaSet: true,
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_all,
              },
          ]
        },
        {
          testname: "compact",
          command: {compact: "foo"},
          skipSharded: true,
          setup: function(db) {
              db.foo.save({});
          },
          teardown: function(db) {
              db.dropDatabase();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_dbAdmin,
                privileges:
                    [{resource: {db: firstDbName, collection: "foo"}, actions: ["compact"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_dbAdminAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "foo"}, actions: ["compact"]}]
              }
          ]
        },
        {
          testname: "connectionStatus",
          command: {connectionStatus: 1},
          testcases: [
              {runOnDb: firstDbName, roles: roles_all, privileges: []},
              {runOnDb: secondDbName, roles: roles_all, privileges: []}
          ]
        },
        {
          testname: "connPoolStats",
          command: {connPoolStats: 1},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_monitoring,
                privileges: [{resource: {cluster: true}, actions: ["connPoolStats"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_monitoring,
                privileges: [{resource: {cluster: true}, actions: ["connPoolStats"]}]
              }
          ]
        },
        {
          testname: "connPoolSync",
          command: {connPoolSync: 1},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_hostManager,
                privileges: [{resource: {cluster: true}, actions: ["connPoolSync"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_hostManager,
                privileges: [{resource: {cluster: true}, actions: ["connPoolSync"]}]
              }
          ]
        },
        {
          testname: "convertToCapped",
          command: {convertToCapped: "toCapped", size: 1000},
          setup: function(db) {
              db.toCapped.save({});
          },
          teardown: function(db) {
              db.toCapped.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges: [{
                    resource: {db: firstDbName, collection: "toCapped"},
                    actions: ["convertToCapped"]
                }]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges: [{
                    resource: {db: secondDbName, collection: "toCapped"},
                    actions: ["convertToCapped"]
                }]
              }
          ]
        },
        {
          testname: "createRole_authenticationRestrictions",
          command: {
              createRole: "testRole",
              roles: [],
              privileges: [],
              authenticationRestrictions: [{clientSource: ["127.0.0.1"]}]
          },
          teardown: function(db) {
              db.runCommand({dropRole: "testRole"});
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_userAdmin,
                privileges: [{
                    resource: {db: firstDbName, collection: ""},
                    actions: ["createRole", "setAuthenticationRestriction"]
                }],
              },
              {
                runOnDb: secondDbName,
                roles: roles_userAdminAny,
                privileges: [{
                    resource: {db: secondDbName, collection: ""},
                    actions: ["createRole", "setAuthenticationRestriction"]
                }],
              }

          ],
        },
        {
          testname: "createUser_authenticationRestrictions",
          command: {
              createUser: "testUser",
              pwd: "test",
              roles: [],
              authenticationRestrictions: [{clientSource: ["127.0.0.1"]}]
          },
          teardown: function(db) {
              db.runCommand({dropUser: "testUser"});
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_userAdmin,
                privileges: [{
                    resource: {db: firstDbName, collection: ""},
                    actions: ["createUser", "setAuthenticationRestriction"]
                }],
              },
              {
                runOnDb: secondDbName,
                roles: roles_userAdminAny,
                privileges: [{
                    resource: {db: secondDbName, collection: ""},
                    actions: ["createUser", "setAuthenticationRestriction"]
                }],
              }
          ],
        },
        {
          testname: "balancerStart",
          command: {balancerStart: 1},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                privileges:
                    [{resource: {db: 'config', collection: 'settings'}, actions: ['update']}],
                expectFail: true  // Command cannot be run on non-config server
              },
          ]
        },
        {
          testname: "_configsvrBalancerStart",
          command: {_configsvrBalancerStart: 1},
          skipSharded: true,
          testcases: [
              {runOnDb: adminDbName, roles: {__system: 1}, expectFail: true},
          ]
        },
        {
          testname: "balancerStop",
          command: {balancerStop: 1},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                privileges:
                    [{resource: {db: 'config', collection: 'settings'}, actions: ['update']}],
                expectFail: true  // Command cannot be run on non-config server
              },
          ]
        },
        {
          testname: "_configsvrBalancerStop",
          command: {_configsvrBalancerStop: 1},
          skipSharded: true,
          testcases: [
              {runOnDb: adminDbName, roles: {__system: 1}, expectFail: true},
          ]
        },
        {
          testname: "balancerStatus",
          command: {balancerStatus: 1},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                privileges: [{resource: {db: 'config', collection: 'settings'}, actions: ['find']}],
              },
          ]
        },
        {
          testname: "_configsvrBalancerStatus",
          command: {_configsvrBalancerStatus: 1},
          skipSharded: true,
          testcases: [
              {runOnDb: adminDbName, roles: {__system: 1}, expectFail: true},
          ]
        },
        {
          testname: "count",
          command: {count: "x"},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [{resource: {db: firstDbName, collection: "x"}, actions: ["find"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges: [{resource: {db: secondDbName, collection: "x"}, actions: ["find"]}]
              }
          ]
        },
        {
          testname: "countWithUUID",
          command: function(state) {
              return {count: state.uuid};
          },
          skipSharded: true,
          setup: function(db) {
              db.runCommand({create: "foo"});

              return {uuid: getUUIDFromListCollections(db, db.foo.getName())};
          },
          teardown: function(db) {
              db.foo.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {__system: 1, root: 1, backup: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {cluster: true}, actions: ["useUUID"]}
                ],
              },
          ]
        },
        {
          testname: "_configsvrCommitChunkMerge",
          command: {_configsvrCommitChunkMerge: "x.y"},
          skipSharded: true,
          expectFail: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {__system: 1},
                privileges: [{resource: {cluster: true}, actions: ["internal"]}],
                expectFail: true
              },
          ]
        },
        {
          testname: "_configsvrCommitChunkMigration",
          command: {_configsvrCommitChunkMigration: "x.y"},
          skipSharded: true,
          expectFail: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {__system: 1},
                privileges: [{resource: {cluster: true}, actions: ["internal"]}],
                expectFail: true
              },
          ]
        },
        {
          testname: "_configsvrCommitChunkSplit",
          command: {_configsvrCommitChunkSplit: "x.y"},
          skipSharded: true,
          expectFail: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {__system: 1},
                privileges: [{resource: {cluster: true}, actions: ["internal"]}],
                expectFail: true
              },
          ]
        },
        {
          testname: "create",
          command: {create: "x"},
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["createCollection"]}
                ]
              },
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges: [{resource: {db: firstDbName, collection: "x"}, actions: ["insert"]}]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges: [{
                    resource: {db: secondDbName, collection: "x"},
                    actions: ["createCollection"]
                }]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges:
                    [{resource: {db: secondDbName, collection: "x"}, actions: ["insert"]}]
              }
          ]
        },
        {
          testname: "_configsvrCreateCollection",
          command: {_configsvrCreateCollection: "test.user"},
          skipSharded: true,
          expectFail: true,
          testcases: [
              {
                runOnDb: "admin",
                roles: {__system: 1},
                privileges: [{resource: {cluster: true}, actions: ["internal"]}],
                expectFail: true
              },
          ]
        },
        {
          testname: "create_views",
          command: {create: "view", viewOn: "collection", pipeline: [{$match: {}}]},
          teardown: function(db) {
              db.view.drop();
          },
          testcases: [
              // Tests that a user who can create a view (but not read it) can create a view on a
              // namespace the user also cannot read.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges: [{
                    resource: {db: firstDbName, collection: "view"},
                    actions: ["createCollection"]
                }]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges: [{
                    resource: {db: secondDbName, collection: "view"},
                    actions: ["createCollection"]
                }]
              },
              // Tests that a user who can both create and read a view has read privileges on the
              // view's underlying namespace.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges: [
                    {resource: {db: firstDbName, collection: "collection"}, actions: ["find"]},
                    {
                      resource: {db: firstDbName, collection: "view"},
                      actions: ["createCollection", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges: [
                    {resource: {db: secondDbName, collection: "collection"}, actions: ["find"]},
                    {
                      resource: {db: secondDbName, collection: "view"},
                      actions: ["createCollection", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ]
              }
          ]
        },
        {
          testname: "create_views_lookup",
          command: {
              create: "view",
              viewOn: "foo",
              pipeline: [
                  {$lookup: {from: "bar", localField: "_id", foreignField: "_id", as: "results"}}
              ]
          },
          teardown: function(db) {
              db.view.drop();
          },
          testcases: [
              // Tests that a user who can create a view (but not read it) may create a view that
              // depends on namespaces the user also cannot read, including namespaces accessed via
              // $lookup.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges: [{
                    resource: {db: firstDbName, collection: "view"},
                    actions: ["createCollection"]
                }],
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges: [{
                    resource: {db: secondDbName, collection: "view"},
                    actions: ["createCollection"]
                }],
              },
              // Tests that a user who can both create and read a view has read privileges on all
              // the view's dependent namespaces, including namespaces accessed via $lookup.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "bar"}, actions: ["find"]},
                    {
                      resource: {db: firstDbName, collection: "view"},
                      actions: ["createCollection", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges: [
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "bar"}, actions: ["find"]},
                    {
                      resource: {db: secondDbName, collection: "view"},
                      actions: ["createCollection", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ]
              }
          ]
        },
        {
          testname: "create_views_graphLookup",
          command: {
              create: "view",
              viewOn: "foo",
              pipeline: [{
                  $graphLookup: {
                      from: "bar",
                      startWith: [1],
                      connectFromField: "_id",
                      connectToField: "barId",
                      as: "results"
                  }
              }]
          },
          teardown: function(db) {
              db.view.drop();
          },
          testcases: [
              // Tests that a user who can create a view (but not read it) may create a view that
              // depends on namespaces the user also cannot read, including namespaces accessed via
              // $graphLookup.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges: [{
                    resource: {db: firstDbName, collection: "view"},
                    actions: ["createCollection"]
                }],
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges: [{
                    resource: {db: secondDbName, collection: "view"},
                    actions: ["createCollection"]
                }],
              },
              // Tests that a user who can both create and read a view has read privileges on all
              // the view's dependent namespaces, including namespaces accessed via $graphLookup.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "bar"}, actions: ["find"]},
                    {
                      resource: {db: firstDbName, collection: "view"},
                      actions: ["createCollection", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ],
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges: [
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "bar"}, actions: ["find"]},
                    {
                      resource: {db: secondDbName, collection: "view"},
                      actions: ["createCollection", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ],
              }
          ]
        },
        {
          testname: "create_views_facet",
          command: {
              create: "view",
              viewOn: "foo",
              pipeline: [{
                  $facet: {
                      lookup: [{
                          $lookup: {
                              from: "bar",
                              localField: "_id",
                              foreignField: "_id",
                              as: "results"
                          }
                      }],
                      graphLookup: [{
                          $graphLookup: {
                              from: "baz",
                              startWith: "foo",
                              connectFromField: "_id",
                              connectToField: "_id",
                              as: "results"
                          }
                      }]
                  }
              }]
          },
          teardown: function(db) {
              db.view.drop();
          },
          testcases: [
              // Tests that a user who can create a view (but not read it) may create a view that
              // depends on namespaces the user also cannot read, including namespaces accessed via
              // $lookup and $graphLookup that are nested within a $facet.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges: [{
                    resource: {db: firstDbName, collection: "view"},
                    actions: ["createCollection"]
                }],
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges: [{
                    resource: {db: secondDbName, collection: "view"},
                    actions: ["createCollection"]
                }],
              },
              // Tests that a user who can both create and read a view has read privileges on all
              // the view's dependent namespaces, including namespaces accessed via $lookup and
              // $graphLookup that are nested within a $facet.
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "bar"}, actions: ["find"]},
                    {resource: {db: firstDbName, collection: "baz"}, actions: ["find"]},
                    {
                      resource: {db: firstDbName, collection: "view"},
                      actions: ["createCollection", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ],
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges: [
                    {resource: {db: secondDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "bar"}, actions: ["find"]},
                    {resource: {db: secondDbName, collection: "baz"}, actions: ["find"]},
                    {
                      resource: {db: secondDbName, collection: "view"},
                      actions: ["createCollection", "find"],
                      removeWhenTestingAuthzFailure: false
                    }
                ],
              }
          ]
        },
        {
          testname: "create_capped",
          command: {create: "x", capped: true, size: 1000},
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges: [{
                    resource: {db: firstDbName, collection: "x"},
                    actions: ["createCollection", "convertToCapped"]
                }]
              },
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges: [{
                    resource: {db: firstDbName, collection: "x"},
                    actions: ["insert", "convertToCapped"]
                }]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges: [{
                    resource: {db: secondDbName, collection: "x"},
                    actions: ["createCollection", "convertToCapped"]
                }]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges: [{
                    resource: {db: secondDbName, collection: "x"},
                    actions: ["insert", "convertToCapped"]
                }]
              }
          ]
        },
        {
          testname: "createIndexes",
          command: {createIndexes: "x", indexes: [{key: {a: 1}, name: "a_1"}]},
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [{
              runOnDb: firstDbName,
              roles: Object.extend({
                  readWrite: 1,
                  readWriteAnyDatabase: 1,
                  dbAdmin: 1,
                  dbAdminAnyDatabase: 1,
                  dbOwner: 1,
                  restore: 1,
                  root: 1,
                  __system: 1
              }),
              privileges:
                  [{resource: {db: firstDbName, collection: "x"}, actions: ["createIndex"]}]
          }]
        },
        {
          testname: "currentOp_$ownOps_false",
          command: {currentOp: 1, $all: true, $ownOps: false},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_monitoring,
                privileges: [{resource: {cluster: true}, actions: ["inprog"]}]
              },
              {runOnDb: firstDbName, roles: {}}
          ]
        },
        {
          testname: "currentOp_$ownOps_true",
          command: {currentOp: 1, $all: true, $ownOps: true},
          testcases: [{runOnDb: adminDbName, roles: roles_all}],
          skipSharded: true
        },
        {
          testname: "lockInfo",
          command: {lockInfo: 1},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: Object.extend({backup: 1}, roles_monitoring),
                privileges: [{resource: {cluster: true}, actions: ["serverStatus"]}]
              },
              {runOnDb: firstDbName, roles: {}, expectFail: true},
              {runOnDb: secondDbName, roles: {}, expectFail: true}
          ]
        },
        {
          testname: "dataSize_1",
          command: {dataSize: firstDbName + ".x"},
          testcases: [{
              runOnDb: firstDbName,
              roles: roles_read,
              privileges: [{resource: {db: firstDbName, collection: "x"}, actions: ["find"]}]
          }]
        },
        {
          testname: "dataSize_2",
          command: {dataSize: secondDbName + ".x"},
          testcases: [{
              runOnDb: secondDbName,
              roles: roles_readAny,
              privileges: [{resource: {db: secondDbName, collection: "x"}, actions: ["find"]}]
          }]
        },
        {
          testname: "dbHash",
          command: {dbHash: 1},
          skipSharded: true,
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {
                    read: 1,
                    readAnyDatabase: 1,
                    readWrite: 1,
                    readWriteAnyDatabase: 1,
                    dbOwner: 1,
                    root: 1,
                    __system: 1
                },
                privileges: [{resource: {db: firstDbName, collection: ""}, actions: ["dbHash"]}]
              },
              {
                runOnDb: secondDbName,
                roles: {readAnyDatabase: 1, readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges:
                    [{resource: {db: secondDbName, collection: ""}, actions: ["dbHash"]}]
              }
          ]
        },
        {
          testname: "dbStats",
          command: {dbStats: 1, scale: 1024},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {
                    read: 1,
                    readAnyDatabase: 1,
                    readWrite: 1,
                    readWriteAnyDatabase: 1,
                    dbAdmin: 1,
                    dbAdminAnyDatabase: 1,
                    dbOwner: 1,
                    clusterMonitor: 1,
                    clusterAdmin: 1,
                    root: 1,
                    __system: 1
                },
                privileges: [{resource: {db: firstDbName, collection: ""}, actions: ["dbStats"]}]
              },
              {
                runOnDb: secondDbName,
                roles: {
                    readAnyDatabase: 1,
                    readWriteAnyDatabase: 1,
                    dbAdminAnyDatabase: 1,
                    clusterMonitor: 1,
                    clusterAdmin: 1,
                    root: 1,
                    __system: 1
                },
                privileges:
                    [{resource: {db: secondDbName, collection: ""}, actions: ["dbStats"]}]
              }
          ]
        },
        {
          testname: "distinct",
          command: {distinct: "coll", key: "a", query: {}},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [{resource: {db: firstDbName, collection: "coll"}, actions: ["find"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "coll"}, actions: ["find"]}]
              }
          ]
        },
        {
          testname: "drop",
          command: {drop: "x"},
          setup: function(db) {
              db.x.save({});
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges:
                    [{resource: {db: firstDbName, collection: "x"}, actions: ["dropCollection"]}]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges: [{
                    resource: {db: secondDbName, collection: "x"},
                    actions: ["dropCollection"]
                }]
              }
          ]
        },
        {
          testname: "drop_views",
          setup: function(db) {
              db.createView("view", "collection", [{$match: {}}]);
          },
          command: {drop: "view"},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdmin),
                privileges: [{
                    resource: {db: firstDbName, collection: "view"},
                    actions: ["dropCollection"]
                }]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({restore: 1}, roles_writeDbAdminAny),
                privileges: [{
                    resource: {db: secondDbName, collection: "view"},
                    actions: ["dropCollection"]
                }]
              }
          ]
        },
        {
          testname: "dropDatabase",
          command: {dropDatabase: 1},
          setup: function(db) {
              db.x.save({});
          },
          teardown: function(db) {
              db.x.save({});
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {
                    dbAdmin: 1,
                    dbAdminAnyDatabase: 1,
                    dbOwner: 1,
                    clusterAdmin: 1,
                    root: 1,
                    __system: 1
                },
                privileges:
                    [{resource: {db: firstDbName, collection: ""}, actions: ["dropDatabase"]}]
              },
              {
                runOnDb: secondDbName,
                roles: {dbAdminAnyDatabase: 1, clusterAdmin: 1, root: 1, __system: 1},
                privileges:
                    [{resource: {db: secondDbName, collection: ""}, actions: ["dropDatabase"]}]
              }
          ]
        },
        {
          testname: "dropIndexes",
          command: {dropIndexes: "x", index: "*"},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_writeDbAdmin,
                privileges:
                    [{resource: {db: firstDbName, collection: "x"}, actions: ["dropIndex"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_writeDbAdminAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "x"}, actions: ["dropIndex"]}]
              }
          ]
        },
        {
          testname: "enableSharding",
          command: {enableSharding: "x"},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: Object.extend({enableSharding: 1}, roles_clusterManager),
                privileges: [{resource: {db: "x", collection: ""}, actions: ["enableSharding"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "features",
          command: {features: 1},
          testcases: [
              {runOnDb: firstDbName, roles: roles_all, privilegesRequired: []},
              {runOnDb: secondDbName, roles: roles_all, privilegesRequired: []}
          ]
        },
        {
          testname: "filemd5",
          command: {filemd5: 1, root: "fs"},
          setup: function(db) {
              db.fs.chunks.drop();
              db.fs.chunks.insert({files_id: 1, n: 0, data: new BinData(0, "test")});
              db.fs.chunks.ensureIndex({files_id: 1, n: 1});
          },
          teardown: function(db) {
              db.fs.chunks.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [{resource: {db: firstDbName, collection: ""}, actions: ["find"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges: [{resource: {db: secondDbName, collection: ""}, actions: ["find"]}]
              }
          ]
        },
        {
          testname: "find",
          command: {find: "foo"},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [{resource: {db: firstDbName, collection: "foo"}, actions: ["find"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "foo"}, actions: ["find"]}]
              }
          ]
        },
        {
          testname: "dbstats_on_local",
          command: {dbStats: 1},
          skipSharded: true,
          testcases: [
              {
                runOnDb: "local",
                roles: {
                    "readLocal": 1,
                    "readWriteLocal": 1,
                    "clusterAdmin": 1,
                    "clusterMonitor": 1,
                    "root": 1,
                    "__system": 1,
                },
              },
          ]
        },
        {
          testname: "find_config_changelog",
          command: {find: "changelog"},
          testcases: [
              {
                runOnDb: "config",
                roles: {
                    "clusterAdmin": 1,
                    "clusterManager": 1,
                    "clusterMonitor": 1,
                    "backup": 1,
                    "root": 1,
                    "__system": 1
                },
                privileges:
                    [{resource: {db: "config", collection: "changelog"}, actions: ["find"]}]
              },
          ]
        },
        {
          testname: "find_local_me",
          skipSharded: true,
          command: {find: "me"},
          testcases: [
              {
                runOnDb: "local",
                roles: {
                    "clusterAdmin": 1,
                    "clusterMonitor": 1,
                    "readLocal": 1,
                    "readWriteLocal": 1,
                    "backup": 1,
                    "root": 1,
                    "__system": 1
                },
                privileges: [{resource: {db: "local", collection: "me"}, actions: ["find"]}]
              },
          ]
        },
        {
          testname: "find_oplog_main",
          skipSharded: true,
          command: {find: "oplog.$main"},
          testcases: [
              {
                runOnDb: "local",
                roles: {
                    "clusterAdmin": 1,
                    "clusterMonitor": 1,
                    "readLocal": 1,
                    "readWriteLocal": 1,
                    "backup": 1,
                    "root": 1,
                    "__system": 1
                },
                privileges:
                    [{resource: {db: "local", collection: "oplog.$main"}, actions: ["find"]}]
              },
          ]
        },
        {
          testname: "find_oplog_rs",
          skipSharded: true,
          command: {find: "oplog.rs"},
          testcases: [
              {
                runOnDb: "local",
                roles: {
                    "clusterAdmin": 1,
                    "clusterMonitor": 1,
                    "readLocal": 1,
                    "readWriteLocal": 1,
                    "backup": 1,
                    "root": 1,
                    "__system": 1
                },
                privileges: [{resource: {db: "local", collection: "oplog.rs"}, actions: ["find"]}]
              },
          ]
        },
        {
          testname: "find_replset_election",
          skipSharded: true,
          command: {find: "replset.election"},
          testcases: [
              {
                runOnDb: "local",
                roles: {
                    "clusterAdmin": 1,
                    "clusterMonitor": 1,
                    "readLocal": 1,
                    "readWriteLocal": 1,
                    "backup": 1,
                    "root": 1,
                    "__system": 1
                },
                privileges:
                    [{resource: {db: "local", collection: "replset.election"}, actions: ["find"]}]
              },
          ]
        },
        {
          testname: "find_replset_minvalid",
          skipSharded: true,
          command: {find: "replset.minvalid"},
          testcases: [
              {
                runOnDb: "local",
                roles: {
                    "clusterAdmin": 1,
                    "clusterMonitor": 1,
                    "readLocal": 1,
                    "readWriteLocal": 1,
                    "backup": 1,
                    "root": 1,
                    "__system": 1
                },
                privileges:
                    [{resource: {db: "local", collection: "replset.minvalid"}, actions: ["find"]}]
              },
          ]
        },
        {
          testname: "find_sources",
          skipSharded: true,
          command: {find: "sources"},
          testcases: [
              {
                runOnDb: "local",
                roles: {
                    "clusterAdmin": 1,
                    "clusterMonitor": 1,
                    "readLocal": 1,
                    "readWriteLocal": 1,
                    "backup": 1,
                    "root": 1,
                    "__system": 1
                },
                privileges: [{resource: {db: "local", collection: "sources"}, actions: ["find"]}]
              },
          ]
        },
        {
          testname: "find_startup_log",
          command: {find: "startup_log"},
          skipSharded: true,
          testcases: [
              {
                runOnDb: "local",
                roles: {
                    "clusterAdmin": 1,
                    "clusterMonitor": 1,
                    "readLocal": 1,
                    "readWriteLocal": 1,
                    "backup": 1,
                    "root": 1,
                    "__system": 1
                },
                privileges:
                    [{resource: {db: "local", collection: "startup_log"}, actions: ["find"]}]
              },
          ]
        },
        {
          testname: "find_views",
          setup: function(db) {
              db.createView("view", "collection", [{$match: {}}]);
          },
          teardown: function(db) {
              db.view.drop();
          },
          command: {find: "view"},
          testcases: [
              // Tests that a user with read access to a view can perform a find on it, even if they
              // don't have read access to the underlying namespace.
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [{resource: {db: firstDbName, collection: "view"}, actions: ["find"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "view"}, actions: ["find"]}]
              }
          ]
        },
        {
          testname: "findWithTerm",
          command: {find: "foo", limit: -1, term: NumberLong(1)},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {__system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {cluster: true}, actions: ["internal"]}
                ],
                expectFail: true  // because of invalid limit
              },
          ]
        },
        {
          testname: "findWithUUID",
          command: function(state) {
              return {find: state.uuid};
          },
          skipSharded: true,
          setup: function(db) {
              db.runCommand({create: "foo"});

              return {uuid: getUUIDFromListCollections(db, db.foo.getName())};
          },
          teardown: function(db) {
              db.foo.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {__system: 1, root: 1, backup: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "foo"}, actions: ["find"]},
                    {resource: {cluster: true}, actions: ["useUUID"]}
                ],
              },
          ],
        },
        {
          testname: "findAndModify",
          command: {findAndModify: "x", query: {_id: "abc"}, update: {$inc: {n: 1}}},
          setup: function(db) {
              db.x.drop();
              db.x.save({_id: "abc", n: 0});
          },
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {readWrite: 1, readWriteAnyDatabase: 1, dbOwner: 1, root: 1, __system: 1},
                privileges:
                    [{resource: {db: firstDbName, collection: "x"}, actions: ["find", "update"]}]
              },
              {
                runOnDb: secondDbName,
                roles: {readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [{
                    resource: {db: secondDbName, collection: "x"},
                    actions: ["find", "update"]
                }]
              }
          ]
        },
        {
          testname: "flushRouterConfig",
          command: {flushRouterConfig: 1},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: Object.extend({clusterManager: 1}, roles_hostManager),
                privileges: [{resource: {cluster: true}, actions: ["flushRouterConfig"]}]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "fsync",
          command: {fsync: 1},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_hostManager,
                privileges: [{resource: {cluster: true}, actions: ["fsync"]}]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "fsyncUnlock",
          command: {fsyncUnlock: 1},
          skipSharded: true,  // TODO: remove when fsyncUnlock is implemented in mongos
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_hostManager,
                privileges: [{resource: {cluster: true}, actions: ["unlock"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "geoSearch",
          command: {geoSearch: "x", near: [50, 50], maxDistance: 6, limit: 1, search: {}},
          skipSharded: true,
          setup: function(db) {
              db.x.drop();
              db.x.save({loc: {long: 50, lat: 50}});
              db.x.ensureIndex({loc: "geoHaystack", type: 1}, {bucketSize: 1});
          },
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [{resource: {db: firstDbName, collection: "x"}, actions: ["find"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges: [{resource: {db: secondDbName, collection: "x"}, actions: ["find"]}]
              }
          ]
        },
        {
          testname: "getCmdLineOpts",
          command: {getCmdLineOpts: 1},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_monitoring,
                privileges: [{resource: {cluster: true}, actions: ["getCmdLineOpts"]}]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "getDatabaseVersion",
          command: {getDatabaseVersion: "test"},
          skipSharded: true,  // only available on mongod
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_monitoring,
                privileges:
                    [{resource: {db: "test", collection: ""}, actions: ["getDatabaseVersion"]}],
                expectFail: true  // only allowed on shard servers
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "getDiagnosticData",
          command: {getDiagnosticData: 1},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_monitoring,
                privileges: [
                    {resource: {cluster: true}, actions: ["serverStatus"]},
                    {resource: {cluster: true}, actions: ["replSetGetStatus"]},
                    {resource: {db: "local", collection: "oplog.rs"}, actions: ["collStats"]},
                    {
                      resource: {cluster: true},
                      actions: ["connPoolStats"]
                    },  // Only needed against mongos
                ]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "getFreeMonitoringStatus",
          skipSharded: true,
          command: {getFreeMonitoringStatus: 1},
          testcases: [{
              runOnDb: adminDbName,
              roles: {clusterMonitor: 1, clusterAdmin: 1, root: 1, __system: 1},
              privileges: [{resource: {cluster: true}, actions: ["checkFreeMonitoringStatus"]}]
          }]
        },
        {
          testname: "getLastError",
          command: {getLastError: 1},
          testcases: [
              {runOnDb: firstDbName, roles: roles_all, privileges: []},
              {runOnDb: secondDbName, roles: roles_all, privileges: []}
          ]
        },
        {
          testname: "getLog",
          command: {getLog: "*"},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_monitoring,
                privileges: [{resource: {cluster: true}, actions: ["getLog"]}]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "getMoreWithTerm",
          command: {getMore: NumberLong("1"), collection: "foo", term: NumberLong(1)},
          testcases: [{
              runOnDb: firstDbName,
              roles: {__system: 1},
              privileges: [{resource: {cluster: true}, actions: ["internal"]}],
              expectFail: true
          }]
        },
        {
          testname: "getnonce",
          command: {getnonce: 1},
          testcases: [
              {runOnDb: firstDbName, roles: roles_all, privileges: []},
              {runOnDb: secondDbName, roles: roles_all, privileges: []}
          ]
        },
        {
          testname: "getParameter",
          command: {getParameter: 1, quiet: 1},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {
                    backup: 1,
                    restore: 1,
                    clusterMonitor: 1,
                    clusterAdmin: 1,
                    root: 1,
                    __system: 1
                },
                privileges: [{resource: {cluster: true}, actions: ["getParameter"]}]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "getShardMap",
          command: {getShardMap: "x"},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_monitoring,
                privileges: [{resource: {cluster: true}, actions: ["getShardMap"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "getShardVersion",
          command: {getShardVersion: "test.foo"},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_monitoring,
                privileges:
                    [{resource: {db: "test", collection: 'foo'}, actions: ["getShardVersion"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "hostInfo",
          command: {hostInfo: 1},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_monitoring,
                privileges: [{resource: {cluster: true}, actions: ["hostInfo"]}]
              },
              {
                runOnDb: firstDbName,
                roles: roles_monitoring,
                privileges: [{resource: {cluster: true}, actions: ["hostInfo"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_monitoring,
                privileges: [{resource: {cluster: true}, actions: ["hostInfo"]}]
              }
          ]
        },
        {
          testname: "insert",
          command: {insert: "foo", documents: [{data: 5}]},
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_write,
                privileges: [{resource: {db: firstDbName, collection: "foo"}, actions: ["insert"]}],
              },
              {
                runOnDb: secondDbName,
                roles: {"readWriteAnyDatabase": 1, "root": 1, "__system": 1, "restore": 1},
                privileges:
                    [{resource: {db: secondDbName, collection: "foo"}, actions: ["insert"]}],
              }

          ]
        },
        {
          testname: "insert_config_changelog",
          command: {insert: "changelog", documents: [{data: 5}]},
          testcases: [{
              runOnDb: "config",
              roles:
                  {"clusterAdmin": 1, "clusterManager": 1, "root": 1, "__system": 1, "restore": 1},
              privileges:
                  [{resource: {db: "config", collection: "changelog"}, actions: ["insert"]}],
          }]
        },
        {
          testname: "insert_me",
          command: {insert: "me", documents: [{data: 5}]},
          skipSharded: true,
          testcases: [{
              runOnDb: "local",
              roles: {
                  "clusterAdmin": 1,
                  "clusterManager": 1,
                  "readWriteLocal": 1,
                  "root": 1,
                  "__system": 1,
                  "restore": 1
              },
              privileges: [{resource: {db: "local", collection: "me"}, actions: ["insert"]}],
          }]
        },
        /* Untestable, because insert to oplog.$main will always fail
         {
          testname: "insert_oplog_main",
          command: {insert: "oplog.$main", documents: [{ts: Timestamp()}]},
          skipSharded: true,
          setup: function(db) {
              db.createCollection("oplog.$main", {capped: true, size: 10000});
          },
          teardown: function(db) {
              db.oplog.$main.drop();
          },
          testcases: [
              {
                runOnDb: "local",
                roles: {"clusterAdmin": 1, "clusterMonitor": 1, "readWriteLocal": 1, "restore": 1,
        "root": 1, "__system": 1},
                privileges:
                    [{resource: {db: "local", collection: "oplog.$main"}, actions: ["insert"]}],
              },

          ]
        },*/
        {
          testname: "insert_oplog_rs",
          command: {insert: "oplog.rs", documents: [{ts: Timestamp()}]},
          skipSharded: true,
          setup: function(db) {
              load("jstests/libs/storage_engine_utils.js");
              if (!db.getCollectionNames().includes("oplog.rs")) {
                  assert.commandWorked(
                      db.runCommand({create: "oplog.rs", capped: true, size: 10000}));
              } else {
                  if (storageEngineIsWiredTigerOrInMemory()) {
                      assert.commandWorked(db.adminCommand({replSetResizeOplog: 1, size: 10000}));
                  } else {
                      assert.commandWorked(db.runCommand({drop: "oplog.rs"}));
                      assert.commandWorked(
                          db.runCommand({create: "oplog.rs", capped: true, size: 10000}));
                  }
              }
          },
          teardown: function(db) {
              assert.commandWorked(db.oplog.rs.runCommand('emptycapped'));
          },
          testcases: [
              {
                runOnDb: "local",
                roles: {
                    "clusterAdmin": 1,
                    "clusterManager": 1,
                    "readWriteLocal": 1,
                    "restore": 1,
                    "root": 1,
                    "__system": 1
                },
                privileges:
                    [{resource: {db: "local", collection: "oplog.rs"}, actions: ["insert"]}],
              },

          ]
        },

        {
          testname: "insert_replset_election",
          command: {insert: "replset.election", documents: [{data: 5}]},
          skipSharded: true,
          testcases: [{
              runOnDb: "local",
              roles: {
                  "clusterAdmin": 1,
                  "clusterManager": 1,
                  "readWriteLocal": 1,
                  "root": 1,
                  "__system": 1,
                  "restore": 1
              },
              privileges:
                  [{resource: {db: "local", collection: "replset.election"}, actions: ["insert"]}],
          }

          ]
        },
        {
          testname: "insert_replset_minvalid",
          command: {insert: "replset.minvalid", documents: [{data: 5}]},
          skipSharded: true,
          testcases: [{
              runOnDb: "local",
              roles: {
                  "clusterAdmin": 1,
                  "clusterManager": 1,
                  "readWriteLocal": 1,
                  "root": 1,
                  "__system": 1,
                  "restore": 1
              },
              privileges:
                  [{resource: {db: "local", collection: "replset.minvalid"}, actions: ["insert"]}],
          }

          ]
        },
        {
          testname: "insert_system_users",
          command: {insert: "system.users", documents: [{data: 5}]},
          setup: function(db) {
              // Ensure unique indexes consistently cause insertion failure
              db.system.users.insert({data: 5});
          },
          testcases: [
              {
                runOnDb: "admin",
                roles: {"root": 1, "__system": 1, "restore": 1},
                privileges:
                    [{resource: {db: "admin", collection: "system.users"}, actions: ["insert"]}],
                expectFail: true,
              },
          ]
        },
        {
          testname: "insert_sources",
          command: {insert: "sources", documents: [{data: 5}]},
          skipSharded: true,
          testcases: [{
              runOnDb: "local",
              roles: {
                  "clusterAdmin": 1,
                  "clusterManager": 1,
                  "readWriteLocal": 1,
                  "root": 1,
                  "__system": 1,
                  "restore": 1
              },
              privileges: [{resource: {db: "local", collection: "sources"}, actions: ["insert"]}],
          }]
        },
        {
          testname: "insert_startup_log",
          command: {insert: "startup_log", documents: [{data: 5}]},
          skipSharded: true,
          testcases: [{
              runOnDb: "local",
              roles: {
                  "clusterAdmin": 1,
                  "clusterManager": 1,
                  "readWriteLocal": 1,
                  "root": 1,
                  "__system": 1,
                  "restore": 1
              },
              privileges:
                  [{resource: {db: "local", collection: "startup_log"}, actions: ["insert"]}],
          }]
        },
        {
          testname: "isMaster",
          command: {isMaster: 1},
          testcases: [
              {runOnDb: adminDbName, roles: roles_all, privileges: []},
              {runOnDb: firstDbName, roles: roles_all, privileges: []},
              {runOnDb: secondDbName, roles: roles_all, privileges: []}
          ]
        },
        {
          testname: "killCursors",
          setup: function(runOnDb) {
              return runOnDb;
          },
          command: function(runOnDb) {
              // Don't create the cursor during setup() because we're not logged in yet.
              // Cursor must be created with same user who tries to kill it.
              const cmd = runOnDb.runCommand({find: "foo", batchSize: 2});
              if (cmd.ok === 1) {
                  return {killCursors: "foo", cursors: [cmd.cursor.id]};
              } else {
                  // If we can't even execute a find, then we certainly can't kill it.
                  // Let it fail/unauthorized via the find command
                  return {find: "foo", batchSize: 2};
              }
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {
                    read: 1,
                    readAnyDatabase: 1,
                    readWrite: 1,
                    readWriteAnyDatabase: 1,
                    dbOwner: 1,
                    backup: 1,
                    root: 1,
                    __system: 1
                },
                privileges: [{resource: {db: firstDbName, collection: "foo"}, actions: ["find"]}],
                expectFail: true
              },
              {
                runOnDb: secondDbName,
                roles:
                    {readAnyDatabase: 1, readWriteAnyDatabase: 1, backup: 1, root: 1, __system: 1},
                privileges: [{resource: {db: secondDbName, collection: "foo"}, actions: ["find"]}],
                expectFail: true
              }
          ]
        },
        {
          testname: "killOp",  // standalone version
          command: {killOp: 1, op: 123},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_hostManager,
                privileges: [{resource: {cluster: true}, actions: ["killop"]}]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "killOp",  // sharded version
          command: {killOp: 1, op: "shard1:123"},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_hostManager,
                privileges: [{resource: {cluster: true}, actions: ["killop"]}],
                expectFail: true  // we won't be able to find the shardId
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        // The rest of kill sessions auth testing is in the kill_sessions fixture (because calling
        // the commands logged in as a different user needs to have different results).  These tests
        // merely verify that the hostManager is the only role with killAnySession.
        {
          testname: "killAllSessions",
          command: {killAllSessions: []},
          testcases: [
              {runOnDb: adminDbName, roles: roles_hostManager},
          ]
        },
        {
          testname: "killAllSessionsByPattern",
          command: {killAllSessionsByPattern: []},
          testcases: [
              {runOnDb: adminDbName, roles: roles_hostManager},
          ]
        },
        {
          testname: "listCommands",
          command: {listCommands: 1},
          testcases: [
              {runOnDb: adminDbName, roles: roles_all, privileges: []},
              {runOnDb: firstDbName, roles: roles_all, privileges: []},
              {runOnDb: secondDbName, roles: roles_all, privileges: []}
          ]
        },
        {
          testname: "listDatabases",
          command: {listDatabases: 1},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_all,
                privileges: [{resource: {cluster: true}, actions: ["listDatabases"]}]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "listCollections",
          command: {listCollections: 1},
          setup: function(db) {
              db.x.insert({_id: 5});
              db.y.insert({_id: 6});
          },
          teardown: function(db) {
              db.x.drop();
              db.y.drop();
          },
          testcases: [{
              runOnDb: firstDbName,
              roles: {
                  read: 1,
                  readAnyDatabase: 1,
                  readWrite: 1,
                  readWriteAnyDatabase: 1,
                  dbAdmin: 1,
                  dbAdminAnyDatabase: 1,
                  dbOwner: 1,
                  backup: 1,
                  restore: 1,
                  root: 1,
                  __system: 1
              },
              privileges:
                  [{resource: {db: firstDbName, collection: ""}, actions: ["listCollections"]}]
          }]
        },
        {
          testname: "listOwnCollections",
          command: {listCollections: 1, nameOnly: true, authorizedCollections: true},
          setup: function(db) {
              db.x.insert({_id: 5});
              db.y.insert({_id: 6});
          },
          teardown: function(db) {
              db.x.drop();
              db.y.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {
                    read: 1,
                    readAnyDatabase: 1,
                    readWrite: 1,
                    readWriteAnyDatabase: 1,
                    dbAdmin: 1,
                    dbAdminAnyDatabase: 1,
                    dbOwner: 1,
                    userAdmin: 1,
                    userAdminAnyDatabase: 1,
                    hostManager: 1,
                    enableSharding: 1,
                    clusterMonitor: 1,
                    clusterManager: 1,
                    clusterAdmin: 1,
                    backup: 1,
                    restore: 1,
                    root: 1,
                    __system: 1
                },
              },
              {
                runOnDb: firstDbName,
                privileges: [{resource: {db: firstDbName, collection: "x"}, actions: ["find"]}]
              },
              {
                runOnDb: firstDbName,
                privileges: [{resource: {db: "", collection: "x"}, actions: ["find"]}]
              },
              {
                runOnDb: firstDbName,
                privileges: [{resource: {db: "", collection: ""}, actions: ["find"]}]
              },
              {
                runOnDb: firstDbName,
                privileges: [{resource: {db: firstDbName, collection: ""}, actions: ["find"]}]
              },
              {
                runOnDb: firstDbName,
                privileges: [{resource: {cluster: true}, actions: ["find"]}],
                expectAuthzFailure: true
              },
              {
                runOnDb: firstDbName,
                privileges: [{resource: {db: secondDbName, collection: "x"}, actions: ["find"]}],
                expectAuthzFailure: true
              },
              {runOnDb: firstDbName, privileges: [], expectAuthzFailure: true},
          ]
        },

        {
          testname: "listIndexes",
          command: {listIndexes: "x"},
          setup: function(db) {
              db.x.insert({_id: 5});
              db.x.insert({_id: 6});
          },
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [{
              runOnDb: firstDbName,
              roles: {
                  read: 1,
                  readAnyDatabase: 1,
                  readWrite: 1,
                  readWriteAnyDatabase: 1,
                  dbAdmin: 1,
                  dbAdminAnyDatabase: 1,
                  dbOwner: 1,
                  backup: 1,
                  root: 1,
                  __system: 1
              },
              privileges:
                  [{resource: {db: firstDbName, collection: ""}, actions: ["listIndexes"]}]
          }]
        },
        {
          testname: "listIndexesWithUUID",
          command: function(state) {
              return {listIndexes: state.uuid};
          },
          skipSharded: true,
          setup: function(db) {
              db.x.insert({_id: 5});
              db.x.insert({_id: 6});

              return {uuid: getUUIDFromListCollections(db, db.x.getName())};
          },
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [{
              runOnDb: firstDbName,
              roles: {backup: 1, root: 1, __system: 1},
              privileges: [
                  {resource: {db: firstDbName, collection: ""}, actions: ["listIndexes"]},
                  {resource: {cluster: true}, actions: ["useUUID"]}
              ]
          }]
        },

        {
          testname: "listShards",
          command: {listShards: 1},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: Object.extend({clusterManager: 1}, roles_monitoring),
                privileges: [{resource: {cluster: true}, actions: ["listShards"]}]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "logRotate",
          command: {logRotate: 1},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_hostManager,
                privileges: [{resource: {cluster: true}, actions: ["logRotate"]}]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "mapReduce_readonly",
          command: {
              mapreduce: "x",
              map: function() {
                  emit(this.groupby, this.n);
              },
              reduce: function(id, emits) {
                  return Array.sum(emits);
              },
              out: {inline: 1}
          },
          setup: function(db) {
              db.x.insert({groupby: 1, n: 5});
              db.x.insert({groupby: 1, n: 6});
          },
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [{resource: {db: firstDbName, collection: "x"}, actions: ["find"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges: [{resource: {db: secondDbName, collection: "x"}, actions: ["find"]}]
              }
          ]
        },
        {
          testname: "mapReduce_write",
          command: {
              mapreduce: "x",
              map: function() {
                  emit(this.groupby, this.n);
              },
              reduce: function(id, emits) {
                  return Array.sum(emits);
              },
              out: "mr_out"
          },
          setup: function(db) {
              db.x.insert({groupby: 1, n: 5});
              db.x.insert({groupby: 1, n: 6});
          },
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {readWrite: 1, readWriteAnyDatabase: 1, dbOwner: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: firstDbName, collection: "x"}, actions: ["find"]},
                    {
                      resource: {db: firstDbName, collection: "mr_out"},
                      actions: ["insert", "remove"]
                    }
                ]
              },
              {
                runOnDb: secondDbName,
                roles: {readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [
                    {resource: {db: secondDbName, collection: "x"}, actions: ["find"]},
                    {
                      resource: {db: secondDbName, collection: "mr_out"},
                      actions: ["insert", "remove"]
                    }
                ]
              }
          ]
        },
        {
          testname: "s_mergeChunks",
          command: {mergeChunks: "test.x", bounds: [{i: 0}, {i: 5}]},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {db: "test", collection: "x"}, actions: ["splitChunk"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "d_mergeChunks",
          command: {mergeChunks: "test.x", bounds: [{i: 0}, {i: 5}]},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {__system: 1},
                privileges: [{resource: {cluster: true}, actions: ["internal"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "s_moveChunk",
          command: {moveChunk: "test.x"},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {db: "test", collection: "x"}, actions: ["moveChunk"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "d_moveChunk",
          command: {moveChunk: "test.x"},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {__system: 1},
                privileges: [{resource: {cluster: true}, actions: ["internal"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "movePrimary",
          command: {movePrimary: "x"},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {db: "x", collection: ""}, actions: ["moveChunk"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "netstat",
          command: {netstat: "x"},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_monitoring,
                privileges: [{resource: {cluster: true}, actions: ["netstat"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "planCacheIndexFilter",
          command: {planCacheClearFilters: "x"},
          skipSharded: true,
          setup: function(db) {
              db.x.save({});
          },
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_dbAdmin,
                privileges: [{
                    resource: {db: firstDbName, collection: "x"},
                    actions: ["planCacheIndexFilter"]
                }],
              },
              {
                runOnDb: secondDbName,
                roles: roles_dbAdminAny,
                privileges: [{
                    resource: {db: secondDbName, collection: "x"},
                    actions: ["planCacheIndexFilter"]
                }],
              },
          ]
        },
        {
          testname: "planCacheRead",
          command: {planCacheListQueryShapes: "x"},
          skipSharded: true,
          setup: function(db) {
              db.x.save({});
          },
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_readDbAdmin,
                privileges:
                    [{resource: {db: firstDbName, collection: "x"}, actions: ["planCacheRead"]}],
              },
              {
                runOnDb: secondDbName,
                roles: roles_readDbAdminAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "x"}, actions: ["planCacheRead"]}],
              },
          ]
        },
        {
          testname: "planCacheWrite",
          command: {planCacheClear: "x"},
          skipSharded: true,
          setup: function(db) {
              db.x.save({});
          },
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_dbAdmin,
                privileges:
                    [{resource: {db: firstDbName, collection: "x"}, actions: ["planCacheWrite"]}],
              },
              {
                runOnDb: secondDbName,
                roles: roles_dbAdminAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "x"}, actions: ["planCacheWrite"]}],
              },
          ]
        },
        {
          testname: "ping",
          command: {ping: 1},
          testcases: [
              {runOnDb: adminDbName, roles: roles_all, privileges: []},
              {runOnDb: firstDbName, roles: roles_all, privileges: []},
              {runOnDb: secondDbName, roles: roles_all, privileges: []}
          ]
        },
        {
          testname: "profile",
          command: {profile: 0},
          skipSharded: true,
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_dbAdmin,
                privileges:
                    [{resource: {db: firstDbName, collection: ""}, actions: ["enableProfiler"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_dbAdminAny,
                privileges: [
                    {resource: {db: secondDbName, collection: ""}, actions: ["enableProfiler"]}
                ]
              }
          ]
        },
        {
          testname: "profileGetLevel",
          command: {profile: -1},
          skipSharded: true,
          testcases: [
              {
                runOnDb: firstDbName,
                roles: {
                    backup: 1,
                    dbAdmin: 1,
                    dbAdminAnyDatabase: 1,
                    dbOwner: 1,
                    clusterMonitor: 1,
                    clusterAdmin: 1,
                    root: 1,
                    __system: 1
                },
                privileges: [{
                    resource: {db: firstDbName, collection: "system.profile"},
                    actions: ["find"]
                }]
              },
              {
                runOnDb: secondDbName,
                roles: {
                    backup: 1,
                    dbAdminAnyDatabase: 1,
                    clusterMonitor: 1,
                    clusterAdmin: 1,
                    root: 1,
                    __system: 1
                },
                privileges: [{
                    resource: {db: secondDbName, collection: "system.profile"},
                    actions: ["find"]
                }]
              }
          ]
        },
        {
          testname: "profileSetSampleRate",
          command: {profile: -1, sampleRate: 0.5},
          skipSharded: true,
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_dbAdmin,
                privileges:
                    [{resource: {db: firstDbName, collection: ""}, actions: ["enableProfiler"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_dbAdminAny,
                privileges: [
                    {resource: {db: secondDbName, collection: ""}, actions: ["enableProfiler"]}
                ]
              }
          ]
        },
        {
          testname: "profile_mongos",
          command: {profile: 0, slowms: 10, sampleRate: 0.5},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_dbAdminAny,
                privileges:
                    [{resource: {db: adminDbName, collection: ""}, actions: ["enableProfiler"]}]
              },
              {
                runOnDb: firstDbName,
                roles: {},
              }
          ]
        },
        {
          testname: "profileGetLevel_mongos",
          command: {profile: -1},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {
                    backup: 1,
                    dbAdminAnyDatabase: 1,
                    clusterMonitor: 1,
                    clusterAdmin: 1,
                    root: 1,
                    __system: 1
                },
                privileges: [{
                    resource: {db: adminDbName, collection: "system.profile"},
                    actions: ["find"]
                }]
              },
              {
                runOnDb: firstDbName,
                roles: {},
              }
          ]
        },
        {
          testname: "refineCollectionShardKey",
          command: {refineCollectionShardKey: "test.x", key: {aKey: 1}},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: Object.extend({enableSharding: 1}, roles_clusterManager),
                privileges: [{
                    resource: {db: "test", collection: "x"},
                    actions: ["refineCollectionShardKey"]
                }],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "renameCollection_sameDb",
          command: {renameCollection: firstDbName + ".x", to: firstDbName + ".y", dropTarget: true},
          setup: function(db) {
              db.getSisterDB(firstDbName).x.save({});
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
              db.getSisterDB(firstDbName).y.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_writeDbAdmin,
                privileges: [
                    {
                      resource: {db: firstDbName, collection: ""},
                      actions: ["renameCollectionSameDB"]
                    },
                    {resource: {db: firstDbName, collection: "y"}, actions: ["dropCollection"]}
                ]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          // Make sure that you cannot use renameCollectionSameDB to rename from a collection you
          // don't have read access on to one that you do.
          testname: "renameCollection_sameDb_failure",
          command: {renameCollection: firstDbName + ".x", to: firstDbName + ".y"},
          setup: function(db) {
              db.getSisterDB(firstDbName).x.save({});
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
              db.getSisterDB(firstDbName).y.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                privileges: [
                    {
                      resource: {db: firstDbName, collection: ""},
                      actions: ["renameCollectionSameDB"]
                    },
                    {resource: {db: firstDbName, collection: "y"}, actions: ["find"]}
                ],
                expectAuthzFailure: true
              },
          ]
        },
        {
          testname: "renameCollection_twoDbs",
          command: {renameCollection: firstDbName + ".x", to: secondDbName + ".y"},
          setup: function(db) {
              db.getSisterDB(firstDbName).x.save({});
              db.getSisterDB(adminDbName).runCommand({movePrimary: firstDbName, to: shard0name});
              db.getSisterDB(adminDbName).runCommand({movePrimary: secondDbName, to: shard0name});
          },
          teardown: function(db) {
              db.getSisterDB(firstDbName).x.drop();
              db.getSisterDB(secondDbName).y.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {readWriteAnyDatabase: 1, root: 1, __system: 1},
                privileges: [
                    {
                      resource: {db: firstDbName, collection: "x"},
                      actions: ["find", "dropCollection"]
                    },
                    {
                      resource: {db: secondDbName, collection: "y"},
                      actions: ["insert", "createIndex"]
                    }
                ]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "reIndex",
          command: {reIndex: "x"},
          skipSharded: true,
          setup: function(db) {
              db.x.save({});
          },
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_dbAdmin,
                privileges: [{resource: {db: firstDbName, collection: "x"}, actions: ["reIndex"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_dbAdminAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "x"}, actions: ["reIndex"]}]
              }
          ]
        },
        {
          testname: "removeShard",
          command: {removeShard: "x"},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {cluster: true}, actions: ["removeShard"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "replSetFreeze",
          command: {replSetFreeze: "x"},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {cluster: true}, actions: ["replSetStateChange"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "replSetGetRBID",
          command: {replSetGetRBID: 1},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {__system: 1},
                privileges: [{resource: {cluster: true}, actions: ["internal"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "replSetGetStatus",
          command: {replSetGetStatus: 1},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles:
                    {clusterMonitor: 1, clusterManager: 1, clusterAdmin: 1, root: 1, __system: 1},
                privileges: [{resource: {cluster: true}, actions: ["replSetGetStatus"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "replSetGetConfig",
          command: {replSetGetConfig: 1},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles:
                    {clusterMonitor: 1, clusterManager: 1, clusterAdmin: 1, root: 1, __system: 1},
                privileges: [{resource: {cluster: true}, actions: ["replSetGetConfig"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "replSetHeartbeat",
          command: {replSetHeartbeat: 1},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {__system: 1},
                privileges: [{resource: {cluster: true}, actions: ["internal"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "replSetInitiate",
          command: {replSetInitiate: "x"},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {cluster: true}, actions: ["replSetConfigure"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "replSetMaintenance",
          command: {replSetMaintenance: "x"},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {cluster: true}, actions: ["replSetStateChange"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "replSetReconfig",
          command: {replSetReconfig: "x"},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {cluster: true}, actions: ["replSetConfigure"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "replSetStepDown",
          command: {replSetStepDown: "x"},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {cluster: true}, actions: ["replSetStateChange"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "replSetStepUp",
          command: {replSetStepUp: "x"},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {cluster: true}, actions: ["replSetStateChange"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "replSetSyncFrom",
          command: {replSetSyncFrom: "x"},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {cluster: true}, actions: ["replSetStateChange"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "resetError",
          command: {resetError: 1},
          testcases: [
              {runOnDb: adminDbName, roles: roles_all, privileges: []},
              {runOnDb: firstDbName, roles: roles_all, privileges: []},
              {runOnDb: secondDbName, roles: roles_all, privileges: []}
          ]
        },
        {
          testname: "serverStatus",
          command: {serverStatus: 1},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: Object.extend({backup: 1}, roles_monitoring),
                privileges: [{resource: {cluster: true}, actions: ["serverStatus"]}]
              },
              {
                runOnDb: firstDbName,
                roles: Object.extend({backup: 1}, roles_monitoring),
                privileges: [{resource: {cluster: true}, actions: ["serverStatus"]}]
              },
              {
                runOnDb: secondDbName,
                roles: Object.extend({backup: 1}, roles_monitoring),
                privileges: [{resource: {cluster: true}, actions: ["serverStatus"]}]
              }
          ]
        },
        {
          testname: "setFeatureCompatibilityVersion",
          command: {setFeatureCompatibilityVersion: "x"},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges:
                    [{resource: {cluster: true}, actions: ['setFeatureCompatibilityVersion']}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "setParameter",
          command: {setParameter: 1, quiet: 1},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_hostManager,
                privileges: [{resource: {cluster: true}, actions: ["setParameter"]}]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "setShardVersion",
          command: {setShardVersion: 1},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {__system: 1},
                privileges: [{resource: {cluster: true}, actions: ["internal"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "shardCollection",
          command: {shardCollection: "test.x"},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: Object.extend({enableSharding: 1}, roles_clusterManager),
                privileges:
                    [{resource: {db: "test", collection: "x"}, actions: ["enableSharding"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "shardingState",
          command: {shardingState: 1},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_monitoring,
                privileges: [{resource: {cluster: true}, actions: ["shardingState"]}]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "shutdown",
          command: {shutdown: 1},
          testcases: [{runOnDb: firstDbName, roles: {}}, {runOnDb: secondDbName, roles: {}}]
        },
        {
          testname: "split",
          command: {split: "test.x"},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {db: "test", collection: "x"}, actions: ["splitChunk"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "splitChunk",
          command: {splitChunk: "test.x"},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {__system: 1},
                privileges: [{resource: {cluster: true}, actions: ["internal"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "splitVector",
          command: {splitVector: "test.x"},
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {db: "test", collection: "x"}, actions: ["splitVector"]}],
                expectFail: true
              },
              {
                runOnDb: firstDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {db: "test", collection: "x"}, actions: ["splitVector"]}],
                expectFail: true
              },
              {
                runOnDb: secondDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {db: "test", collection: "x"}, actions: ["splitVector"]}],
                expectFail: true
              }
          ]
        },
        /*      temporarily removed see SERVER-13555
                 {
                    testname: "storageDetails",
                    command: {storageDetails: "x", analyze: "diskStorage"},
                    skipSharded: true,
                    setup: function (db) { db.x.save( {} ); },
                    teardown: function (db) { db.x.drop(); },
                    testcases: [
                        {
                            runOnDb: firstDbName,
                            roles: roles_dbAdmin,
                            privileges: [
                                { resource: {db: firstDbName, collection: "x"}, actions:
           ["storageDetails"] }
                            ]
                        },
                        {
                            runOnDb: secondDbName,
                            roles: roles_dbAdminAny,
                            privileges: [
                                { resource: {db: secondDbName, collection: "x"}, actions:
           ["storageDetails"] }
                            ]
                        }
                    ]
                }, */
        {
          testname: "top",
          command: {top: 1},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_monitoring,
                privileges: [{resource: {cluster: true}, actions: ["top"]}]
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "touch",
          command: {touch: "x", data: true, index: false},
          skipSharded: true,
          setup: function(db) {
              db.x.save({});
          },
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_hostManager,
                privileges: [{resource: {cluster: true}, actions: ["touch"]}]
              },
              {
                runOnDb: firstDbName,
                roles: roles_hostManager,
                privileges: [{resource: {cluster: true}, actions: ["touch"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_hostManager,
                privileges: [{resource: {cluster: true}, actions: ["touch"]}]
              }
          ]
        },
        {
          testname: "unsetSharding",
          command: {unsetSharding: "x"},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {__system: 1},
                privileges: [{resource: {cluster: true}, actions: ["internal"]}],
                expectFail: true
              },
              {runOnDb: firstDbName, roles: {}},
              {runOnDb: secondDbName, roles: {}}
          ]
        },
        {
          testname: "updateRole_authenticationRestrictions",
          command: {updateRole: "testRole", authenticationRestrictions: []},
          setup: function(db) {
              db.runCommand({
                  createRole: "testRole",
                  roles: [],
                  privileges: [],
                  authenticationRestrictions: [{clientSource: ["127.0.0.1"]}]
              });
          },
          teardown: function(db) {
              db.runCommand({dropRole: "testRole"});
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_userAdminAny,
                privileges: [
                    {resource: {db: "", collection: ""}, actions: ["revokeRole"]},
                    {
                      resource: {db: firstDbName, collection: ""},
                      actions: ["setAuthenticationRestriction"]
                    }
                ],
              },
              {
                runOnDb: secondDbName,
                roles: roles_userAdminAny,
                privileges: [
                    {resource: {db: "", collection: ""}, actions: ["revokeRole"]},
                    {
                      resource: {db: secondDbName, collection: ""},
                      actions: ["setAuthenticationRestriction"]
                    }
                ],
              }

          ],
        },
        {
          testname: "updateUser_authenticationRestrictions",
          command: {updateUser: "testUser", authenticationRestrictions: []},
          setup: function(db) {
              db.runCommand({
                  createUser: "testUser",
                  pwd: "test",
                  roles: [],
                  authenticationRestrictions: [{clientSource: ["127.0.0.1"]}]
              });
          },
          teardown: function(db) {
              db.runCommand({dropUser: "testUser"});
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_userAdmin,
                privileges: [{
                    resource: {db: firstDbName, collection: ""},
                    actions: ["setAuthenticationRestriction"]
                }],
              },
              {
                runOnDb: secondDbName,
                roles: roles_userAdminAny,
                privileges: [{
                    resource: {db: secondDbName, collection: ""},
                    actions: ["setAuthenticationRestriction"]
                }],
              }
          ],
        },
        {
          testname: "validate",
          command: {validate: "x"},
          setup: function(db) {
              db.x.save({});
          },
          teardown: function(db) {
              db.x.drop();
          },
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_dbAdmin,
                privileges:
                    [{resource: {db: firstDbName, collection: "x"}, actions: ["validate"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_dbAdminAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "x"}, actions: ["validate"]}]
              }
          ]
        },
        {
          // Test that the root role has the privilege to validate any system.* collection
          testname: "validate_system",
          command: {validate: "system.users"},
          testcases: [{runOnDb: adminDbName, roles: {root: 1, __system: 1}}]
        },
        {
          testname: "whatsmyuri",
          command: {whatsmyuri: 1},
          testcases: [
              {runOnDb: adminDbName, roles: roles_all, privileges: []},
              {runOnDb: firstDbName, roles: roles_all, privileges: []},
              {runOnDb: secondDbName, roles: roles_all, privileges: []}
          ]
        },
        {
          testname: "_configsvrAddShard",
          command: {_configsvrAddShard: "x"},
          skipSharded: true,
          testcases: [
              {runOnDb: adminDbName, roles: {__system: 1}, expectFail: true},
          ]
        },
        {
          testname: "addShardToZone",
          command: {addShardToZone: shard0name, zone: 'z'},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [{resource: {db: 'config', collection: 'shards'}, actions: ['update']}],
              },
          ]
        },
        {
          testname: "_configsvrAddShardToZone",
          command: {_configsvrAddShardToZone: shard0name, zone: 'z'},
          skipSharded: true,
          testcases: [
              {runOnDb: adminDbName, roles: {__system: 1}, expectFail: true},
          ]
        },
        {
          testname: "removeShardFromZone",
          command: {removeShardFromZone: shard0name, zone: 'z'},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [
                    {resource: {db: 'config', collection: 'shards'}, actions: ['update']},
                    {resource: {db: 'config', collection: 'tags'}, actions: ['find']}
                ],
              },
          ]
        },
        {
          testname: "_configsvrRemoveShardFromZone",
          command: {_configsvrRemoveShardFromZone: shard0name, zone: 'z'},
          skipSharded: true,
          testcases: [
              {runOnDb: adminDbName, roles: {__system: 1}, expectFail: true},
          ]
        },
        {
          testname: "updateZoneKeyRange",
          command: {updateZoneKeyRange: 'test.foo', min: {x: 1}, max: {x: 5}, zone: 'z'},
          skipUnlessSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: roles_clusterManager,
                privileges: [
                    {resource: {db: 'config', collection: 'shards'}, actions: ['find']},
                    {
                      resource: {db: 'config', collection: 'tags'},
                      actions: ['find', 'update', 'remove']
                    },
                ],
                expectFail: true
              },
          ]
        },
        {
          testname: "_configsvrUpdateZoneKeyRange",
          command: {_configsvrUpdateZoneKeyRange: 'test.foo', min: {x: 1}, max: {x: 5}, zone: 'z'},
          skipSharded: true,
          testcases: [
              {runOnDb: adminDbName, roles: {__system: 1}, expectFail: true},
          ]
        },
        {
          testname: "startSession",
          command: {startSession: 1},
          privileges: [{resource: {cluster: true}, actions: ["startSession"]}],
          testcases: [{runOnDb: adminDbName, roles: roles_all}],
        },
        {
          testname: "refreshLogicalSessionCacheNow",
          command: {refreshLogicalSessionCacheNow: 1},
          testcases: [{runOnDb: adminDbName, roles: roles_all}],
        },
        {
          testname: "refreshSessions",
          command: {refreshSessions: []},
          testcases: [{runOnDb: adminDbName, roles: roles_all}],
        },
        {
          testname: "_getNextSessionMods",
          command: {_getNextSessionMods: "a-b"},
          skipSharded: true,
          testcases: [
              {
                runOnDb: adminDbName,
                roles: {__system: 1},
                privileges: [{resource: {cluster: true}, actions: ["internal"]}],
                expectFail: true
              },
          ]
        },
        {
          testname: "aggregate_$backupCursor",
          command: {aggregate: 1, cursor: {}, pipeline: [{$backupCursor: {}}]},
          skipSharded: true,
          // Only enterprise knows of this aggregation stage.
          skipTest:
              (conn) =>
                  !conn.getDB("admin").runCommand({buildInfo: 1}).modules.includes("enterprise"),
          testcases: [{
              runOnDb: adminDbName,
              roles: roles_hostManager,
              privileges: [
                  {resource: {cluster: true}, actions: ["fsync"]},
              ],
              expectFail: TestData.storageEngine == "inMemory",
          }],
          teardown: (db, response) => {
              if (response.ok) {
                  assert.commandWorked(db.runCommand(
                      {killCursors: "$cmd.aggregate", cursors: [response.cursor.id]}));
              }
          }
        },
        {
          testname: "aggregate_$searchBeta",
          command: {
              aggregate: "foo",
              cursor: {},
              pipeline: [{
                  $searchBeta: {
                      // empty query
                  }
              }]
          },
          skipSharded: false,
          // Only enterprise knows of this aggregation stage.
          skipTest:
              (conn) =>
                  !conn.getDB("admin").runCommand({buildInfo: 1}).modules.includes("enterprise"),
          testcases: [
              {
                runOnDb: firstDbName,
                roles: roles_read,
                privileges: [{resource: {db: firstDbName, collection: "foo"}, actions: ["find"]}]
              },
              {
                runOnDb: secondDbName,
                roles: roles_readAny,
                privileges:
                    [{resource: {db: secondDbName, collection: "foo"}, actions: ["find"]}]
              }
          ],
          setup: function(db) {
              // Configure the $searchBeta stage to always return EOF so we can avoid the hassle
              // of giving mongod a host and port for mongot.
              const cmd = {configureFailPoint: "searchBetaReturnEofImmediately", mode: "alwaysOn"};
              FixtureHelpers.runCommandOnEachPrimary({db: db.getSiblingDB("admin"), cmdObj: cmd});
          },
          teardown: function(db) {
              const cmd = {configureFailPoint: "searchBetaReturnEofImmediately", mode: "off"};
              FixtureHelpers.runCommandOnEachPrimary({db: db.getSiblingDB("admin"), cmdObj: cmd});
          }
        },
        {
          testname: "startRecordingTraffic",
          command: {startRecordingTraffic: 1, filename: "notARealPath"},
          testcases: [
              {runOnDb: adminDbName, roles: roles_hostManager},
          ],
          teardown: (db, response) => {
              if (response.ok) {
                  assert.commandWorked(db.runCommand({stopRecordingTraffic: 1}));
              }
          }
        },
        {
          testname: "stopRecordingTraffic",
          command: {stopRecordingTraffic: 1},
          testcases: [
              {runOnDb: adminDbName, roles: roles_hostManager},
          ],
          setup: function(db) {
              db.runCommand({startRecordingTraffic: 1, filename: "notARealPath"});
          }
        },
    ],

    /************* SHARED TEST LOGIC ****************/

    /**
     * Returns true if conn is a connection to mongos,
     * and false otherwise.
     */
    isMongos: function(conn) {
        var res = conn.getDB("admin").runCommand({isdbgrid: 1});
        return (res.ok == 1 && res.isdbgrid == 1);
    },

    /**
     * Runs a single test object from the tests array above.
     * The actual implementation must be provided in "impls".
     *
     * Parameters:
     *   conn -- a connection to either mongod or mongos
     *   t -- a single test object from the tests array above
     *
     * Returns:
     *  An array of strings. Each string in the array reports
     *  a particular test error.
     */
    runOneTest: function(conn, t, impls, isMongos) {
        jsTest.log("Running test: " + t.testname);

        if (t.skipTest && t.skipTest(conn)) {
            return [];
        }
        // some tests shouldn't run in a sharded environment
        if (t.skipSharded && isMongos) {
            return [];
        }
        // others shouldn't run in a standalone environment
        if (t.skipUnlessSharded && !isMongos) {
            return [];
        }
        // some tests require replica sets to be enabled.
        if (t.skipUnlessReplicaSet && !FixtureHelpers.isReplSet(conn.getDB("admin"))) {
            return [];
        }

        return impls.runOneTest(conn, t);
    },

    setup: function(conn, t, runOnDb, testcase) {
        var adminDb = conn.getDB(adminDbName);
        if (t.setup) {
            adminDb.auth("admin", "password");
            var state = t.setup(runOnDb, testcase);
            runOnDb.getLastError();
            adminDb.logout();
            return state;
        }

        return {};
    },

    authenticatedSetup: function(t, runOnDb) {
        if (t.authenticatedSetup) {
            t.authenticatedSetup(runOnDb);
        }
    },

    teardown: function(conn, t, runOnDb, response) {
        var adminDb = conn.getDB(adminDbName);
        if (t.teardown) {
            adminDb.auth("admin", "password");
            t.teardown(runOnDb, response);
            runOnDb.getLastError();
            adminDb.logout();
        }
    },

    /**
     * Top-level test runner
     */
    runTests: function(conn, impls) {

        // impls must provide implementations of a few functions
        assert("createUsers" in impls);
        assert("runOneTest" in impls);

        impls.createUsers(conn);

        var failures = [];

        const isMongos = this.isMongos(conn);
        for (var i = 0; i < this.tests.length; i++) {
            res = this.runOneTest(conn, this.tests[i], impls, isMongos);
            failures = failures.concat(res);
        }

        failures.forEach(function(i) {
            jsTest.log(i);
        });
        assert.eq(0, failures.length);
    }

};
