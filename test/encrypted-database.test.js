import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { openEncryptedDatabase } from "../src/lib/encrypted-database.js";

const require = createRequire(import.meta.url);
let driverAvailable = true;
try { require.resolve("better-sqlite3-multiple-ciphers"); } catch { driverAvailable = false; }
const encryptedTest = (name, callback) => test(name, { skip: !driverAvailable && "Optional encrypted SQLite driver is not installed" }, callback);
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "artifacty-encrypted-db-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, "store.sqlite"), key: randomBytes(32) };
}

// Key validation does not load the optional dependency or create a file.
test("encrypted database rejects absent, string, and incorrectly sized keys without creating a file", (t) => {
  const { file } = fixture(t);
  for (const key of [undefined, "secret-password", new Uint8Array(32), Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33)]) {
    assert.throws(() => openEncryptedDatabase(file, { key }), { code: "INVALID_DATABASE_KEY" });
    assert.equal(existsSync(file), false);
  }
});

encryptedTest("encrypted metadata, comments, FTS and WAL contain no plaintext canaries", (t) => {
  const { file, key } = fixture(t);
  const originalKey = Buffer.from(key);
  const db = openEncryptedDatabase(file, { key });
  t.after(() => db.close());
  assert.deepEqual(key, originalKey, "The caller owns its key buffer");
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE metadata(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE comments(id INTEGER PRIMARY KEY, body TEXT); CREATE VIRTUAL TABLE artifact_search USING fts5(content);");
  const canaries = ["metadata_canary_73c32a", "comment_canary_d47d59", "searchcanary9f4a"];
  assert.equal(db.prepare("INSERT INTO metadata(value) VALUES (?)").run(canaries[0]).changes, 1);
  db.prepare("INSERT INTO comments(body) VALUES (?)").run(canaries[1]);
  db.prepare("INSERT INTO artifact_search(content) VALUES (?)").run(canaries[2]);
  assert.equal(db.prepare("SELECT value FROM metadata").get().value, canaries[0]);
  assert.deepEqual(db.prepare("SELECT body FROM comments").all(), [{ body: canaries[1] }]);
  assert.equal(db.prepare("SELECT content FROM artifact_search WHERE artifact_search MATCH ?").get(canaries[2]).content, canaries[2]);
  assert.ok(existsSync(`${file}-wal`));
  assert.ok(readFileSync(`${file}-wal`).length > 32);
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    if (!existsSync(candidate)) continue;
    const bytes = readFileSync(candidate);
    for (const canary of canaries) assert.equal(bytes.includes(Buffer.from(canary)), false, `${path.basename(candidate)} exposes a canary`);
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.notEqual(readFileSync(file).subarray(0, 16).toString(), "SQLite format 3\0");
  const plain = new DatabaseSync(file, { readOnly: true });
  try { assert.throws(() => plain.prepare("SELECT name FROM sqlite_schema").all()); }
  finally { plain.close(); }
});

encryptedTest("correct keys reopen read-only with memory temp storage and enforced constraints", (t) => {
  const { file, key } = fixture(t);
  let db = openEncryptedDatabase(file, { key });
  db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES (1)");
  assert.throws(() => db.prepare("INSERT INTO child VALUES (?)").run(99), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
  db.close();
  db = openEncryptedDatabase(file, { key, readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA temp_store").get().temp_store, 2);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
    assert.equal(db.prepare("SELECT id FROM parent").get().id, 1);
    assert.throws(() => db.exec("INSERT INTO parent VALUES (2)"), { code: "SQLITE_READONLY" });
  } finally { db.close(); }
});

encryptedTest("wrong keys, plaintext input, and authenticated-page tampering fail closed", (t) => {
  const { file, key, directory } = fixture(t);
  const db = openEncryptedDatabase(file, { key });
  db.exec("CREATE TABLE data(value TEXT); INSERT INTO data VALUES ('authenticated-data')");
  db.close();
  const before = readFileSync(file);
  const wrong = Buffer.alloc(32, 0x7f);
  assert.throws(() => openEncryptedDatabase(file, { key: wrong }), (error) => {
    assert.equal(error.code, "ENCRYPTED_DATABASE_OPEN_FAILED");
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes(file));
    assert.ok(!error.message.includes(wrong.toString("hex")));
    return true;
  });
  assert.deepEqual(readFileSync(file), before);
  const plaintext = path.join(directory, "plain.sqlite");
  const plain = new DatabaseSync(plaintext);
  plain.exec("CREATE TABLE data(value TEXT)"); plain.close();
  const originalPlaintext = readFileSync(plaintext);
  assert.throws(() => openEncryptedDatabase(plaintext, { key }), { code: "ENCRYPTED_DATABASE_OPEN_FAILED" });
  assert.deepEqual(readFileSync(plaintext), originalPlaintext);
  const damaged = Buffer.from(before);
  damaged[200] ^= 0x80;
  writeFileSync(file, damaged);
  assert.throws(() => openEncryptedDatabase(file, { key }), { code: "ENCRYPTED_DATABASE_OPEN_FAILED" });
});

encryptedTest("read-only mode never creates a missing database and rejects ambiguous options", (t) => {
  const { file, key } = fixture(t);
  assert.throws(() => openEncryptedDatabase(file, { key, readOnly: true }), { code: "ENCRYPTED_DATABASE_OPEN_FAILED" });
  assert.equal(existsSync(file), false);
  assert.throws(() => openEncryptedDatabase(file, { key, readOnly: "false" }), { code: "INVALID_DATABASE_OPTIONS" });
  assert.equal(existsSync(file), false);
});

encryptedTest("VACUUM INTO snapshots remain encrypted and reopen with the same key", (t) => {
  const { file, key, directory } = fixture(t);
  const snapshot = path.join(directory, "snapshot.sqlite");
  const db = openEncryptedDatabase(file, { key });
  try {
    db.exec("CREATE TABLE data(value TEXT)");
    db.prepare("INSERT INTO data VALUES (?)").run("snapshot_canary_68ae19");
    db.prepare("VACUUM INTO ?").run(snapshot);
  } finally { db.close(); }
  assert.equal(readFileSync(snapshot).includes(Buffer.from("snapshot_canary_68ae19")), false);
  assert.notEqual(readFileSync(snapshot).subarray(0, 16).toString(), "SQLite format 3\0");
  const copy = openEncryptedDatabase(snapshot, { key, readOnly: true });
  try { assert.equal(copy.prepare("SELECT value FROM data").get().value, "snapshot_canary_68ae19"); }
  finally { copy.close(); }
});

encryptedTest("statement failures omit SQL and bound secrets", (t) => {
  const { file, key } = fixture(t);
  const db = openEncryptedDatabase(file, { key });
  try {
    assert.throws(() => db.prepare("SELECT secret_column_123 FROM missing_secret_table"), (error) => {
      assert.equal(error.message, "Encrypted database operation failed.");
      assert.equal(error.cause, undefined);
      return true;
    });
  } finally { db.close(); }
});
