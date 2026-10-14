import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createStoreKey, readStoreKey, exportStoreKey, importStoreKey } from "../src/lib/store-keys.js";
import { DatabaseSync } from "node:sqlite";
import { createStore, createArtifact, addComment } from "../src/lib/storage.js";
import { openEncryptedDatabase } from "../src/lib/encrypted-database.js";
import { buildStoreGeneration, verifyStoreGeneration } from "../src/lib/store-generation.js";

const require = createRequire(import.meta.url);
let driverAvailable = true;
try { require.resolve("better-sqlite3-multiple-ciphers"); } catch { driverAvailable = false; }
const encryptedTest = (name, callback) => test(name, { skip: !driverAvailable && "Optional encrypted SQLite driver is not installed" }, callback);

async function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "artifacty-generation-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const store = createStore({ home: source });
  const artifact = await createArtifact(store, { title: "TITLE_CANARY", content: "BODY_CANARY searchablephrase", format: "text" });
  await addComment(store, artifact.id, { body: "COMMENT_CANARY" });
  await createArtifact(store, { title: "Binary", format: "image", content: Buffer.from([0, 255, 18, 45]).toString("base64") });
  await createArtifact(store, { title: "Bundle", format: "json", artifactType: "bundle", content: JSON.stringify({ files: [{ path: "index.html", content: "<p>bundle</p>" }] }) });
  return { root, source, artifact, encryption: { key: randomBytes(32), storeId: randomUUID(), keyId: randomUUID() } };
}

encryptedTest("offline generations roundtrip metadata, comments, FTS and all blob bytes without plaintext encrypted output", async (t) => {
  const { root, source, encryption } = await fixture(t);
  const encrypted = path.join(root, "encrypted");
  assert.equal(buildStoreGeneration(source, encrypted, { targetEncryption: encryption }).versionCount, 3);
  assert.equal(verifyStoreGeneration(encrypted, { encryption }).verified, true);
  for (const file of readdirSync(path.join(encrypted, "artifacts"))) assert.match(file, /^[a-f0-9-]{36}\.enc$/);
  for (const file of ["artifacty.sqlite", "generation.json", ...readdirSync(path.join(encrypted, "artifacts")).map((name) => `artifacts/${name}`)]) {
    const content = readFileSync(path.join(encrypted, file));
    for (const canary of ["TITLE_CANARY", "BODY_CANARY", "COMMENT_CANARY"]) assert.equal(content.includes(Buffer.from(canary)), false);
  }
  const db = openEncryptedDatabase(path.join(encrypted, "artifacty.sqlite"), { key: encryption.key, readOnly: true });
  try {
    assert.equal(db.prepare("SELECT title FROM artifacts WHERE title='TITLE_CANARY'").get().title, "TITLE_CANARY");
    assert.equal(db.prepare("SELECT body FROM artifact_comments").get().body, "COMMENT_CANARY");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM artifact_search WHERE artifact_search MATCH 'searchablephrase'").get().count, 1);
  } finally { db.close(); }
  const restored = path.join(root, "restored");
  buildStoreGeneration(encrypted, restored, { sourceEncryption: encryption });
  const original = new DatabaseSync(path.join(source, "artifacty.sqlite"), { readOnly: true });
  const copy = new DatabaseSync(path.join(restored, "artifacty.sqlite"), { readOnly: true });
  try {
    const versions = original.prepare("SELECT artifact_id,version,path FROM artifact_versions").all();
    for (const row of versions) {
      const target = copy.prepare("SELECT path FROM artifact_versions WHERE artifact_id=? AND version=?").get(row.artifact_id, row.version);
      assert.deepEqual(readFileSync(path.join(source, row.path)), readFileSync(path.join(restored, target.path)));
    }
  } finally { original.close(); copy.close(); }
});

encryptedTest("corrupt, missing and unsafe source blobs never publish or alter the source", async (t) => {
  const { root, source, artifact } = await fixture(t);
  const file = path.join(source, artifact.versions[0].path);
  const original = readFileSync(file);
  writeFileSync(file, "corrupt");
  assert.throws(() => buildStoreGeneration(source, path.join(root, "bad")), { code: "STORE_GENERATION_INVALID" });
  assert.equal(existsSync(path.join(root, "bad")), false);
  assert.deepEqual(readdirSync(root), ["source"]);
  rmSync(file);
  assert.throws(() => buildStoreGeneration(source, path.join(root, "missing")), { code: "STORE_GENERATION_INVALID" });
  writeFileSync(file, original);
  const linked = path.join(root, "linked"); linkSync(file, linked);
  assert.throws(() => buildStoreGeneration(source, path.join(root, "hardlink")), { code: "STORE_GENERATION_INVALID" });
  rmSync(linked);
  if (process.platform !== "win32") {
    rmSync(file); writeFileSync(linked, original); symlinkSync(linked, file);
    assert.throws(() => buildStoreGeneration(source, path.join(root, "symlink")), { code: "STORE_GENERATION_INVALID" });
  }
});

encryptedTest("wrong keys, manifest identities, existing destinations and nested destinations fail closed", async (t) => {
  const { root, source, encryption } = await fixture(t);
  const encrypted = path.join(root, "encrypted");
  buildStoreGeneration(source, encrypted, { targetEncryption: encryption });
  for (const changed of [null, { ...encryption, key: randomBytes(32) }, { ...encryption, storeId: randomUUID() }, { ...encryption, keyId: randomUUID() }]) {
    assert.throws(() => verifyStoreGeneration(encrypted, { encryption: changed }), { code: "STORE_GENERATION_INVALID" });
  }
  assert.throws(() => buildStoreGeneration(source, encrypted), { code: "STORE_GENERATION_INVALID" });
  assert.throws(() => buildStoreGeneration(source, path.join(source, "nested")), { code: "STORE_GENERATION_INVALID" });
  assert.throws(() => buildStoreGeneration(source, path.join(root, "missing-parent", "target")), { code: "STORE_GENERATION_INVALID" });
});


encryptedTest("live managed servers and traversal references cannot produce a generation", async (t) => {
  const { root, source } = await fixture(t);
  const marker = path.join(source, "server.pid");
  writeFileSync(marker, String(process.pid));
  assert.throws(() => buildStoreGeneration(source, path.join(root, "live")), { code: "STORE_GENERATION_INVALID" });
  rmSync(marker);
  const db = new DatabaseSync(path.join(source, "artifacty.sqlite"));
  try { db.prepare("UPDATE artifact_versions SET path='artifacts/../../outside'").run(); } finally { db.close(); }
  assert.throws(() => buildStoreGeneration(source, path.join(root, "traversal")), { code: "STORE_GENERATION_INVALID" });
  assert.deepEqual(readdirSync(root), ["source"]);
});


encryptedTest("external recovery key restores an encrypted generation into a fresh key directory", async (t) => {
  const { root, source, encryption } = await fixture(t);
  const options = { home: source, keyDirectory: path.join(root, "keys-original"), storeId: encryption.storeId, keyId: encryption.keyId };
  createStoreKey(options);
  const key = readStoreKey(options);
  const encrypted = path.join(root, "encrypted");
  try { buildStoreGeneration(source, encrypted, { targetEncryption: { ...encryption, key } }); } finally { key.fill(0); }
  const recoveryFile = path.join(root, "recovery-key.json");
  exportStoreKey(options, recoveryFile);
  rmSync(options.keyDirectory, { recursive: true });
  const recoveredOptions = { ...options, home: encrypted, keyDirectory: path.join(root, "keys-recovered") };
  importStoreKey(recoveredOptions, recoveryFile);
  const recoveredKey = readStoreKey(recoveredOptions);
  try {
    const recovered = { ...encryption, key: recoveredKey };
    assert.equal(verifyStoreGeneration(encrypted, { encryption: recovered }).versionCount, 3);
    const restored = path.join(root, "recovered-plaintext");
    assert.equal(buildStoreGeneration(encrypted, restored, { sourceEncryption: recovered }).verified, true);
    const db = new DatabaseSync(path.join(restored, "artifacty.sqlite"), { readOnly: true });
    try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM artifact_search WHERE artifact_search MATCH 'searchablephrase'").get().count, 1); } finally { db.close(); }
  } finally { recoveredKey.fill(0); }
});
