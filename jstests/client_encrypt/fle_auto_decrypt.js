// Test to ensure that the client community shell auto decrypts an encrypted field
// stored in the database if it has the correct credentials.

load("jstests/client_encrypt/lib/mock_kms.js");
load('jstests/ssl/libs/ssl_helpers.js');

(function() {
"use strict";

const x509_options = {
    sslMode: "requireSSL",
    sslPEMKeyFile: SERVER_CERT,
    sslCAFile: CA_CERT
};

const conn = MongoRunner.runMongod(x509_options);

let localKMS = {
    key: BinData(
        0,
        "tu9jUCBqZdwCelwE/EAm/4WqdxrSMi04B8e9uAV+m30rI1J2nhKZZtQjdvsSCwuI4erR6IEcEK+5eGUAODv43NDNIR9QheT2edWFewUfHKsl9cnzTc86meIzOmYl6drp"),
};

const clientSideFLEOptions = {
    kmsProviders: {
        local: localKMS,
    },
    keyVaultNamespace: "test.coll",
    schemaMap: {}
};

const deterministicAlgorithm = "AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic";

const shell = Mongo(conn.host, clientSideFLEOptions);
const keyVault = shell.getKeyVault();

assert.commandWorked(
    keyVault.createKey("local", "arn:aws:kms:us-east-1:fake:fake:fake", ['mongoKey']));

const clientEncrypt = shell.getClientEncryption();
const keyId = keyVault.getKeyByAltName("mongoKey").toArray()[0]._id;

const encryptedStr = clientEncrypt.encrypt(keyId, "mongodb", deterministicAlgorithm);

// Insert encrypted string into database
const collection = conn.getDB("test").getCollection("collection");

for (var i = 0; i < 150; i++) {
    assert.commandWorked(collection.insert({string: encryptedStr, id: 1}));
}

// Ensure string is auto decrypted
const encryptedCollection = shell.getDB("test").getCollection("collection");
const result = encryptedCollection.find({id: 1}).toArray();
result.forEach(function(entry) {
    assert.eq(entry.string, "mongodb");
});

MongoRunner.stopMongod(conn);
}());