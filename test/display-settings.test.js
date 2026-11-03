import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore, openDatabase, createArtifact, getArtifact, awaitEmbeddingIndexing } from "../src/lib/storage.js";
import { exportStoreToString, importStoreFromString } from "../src/lib/backup.js";
import { getDisplaySettings, saveDisplaySettings, currentDisplayTimeZone, runWithDisplaySettings, supportedDisplayTimeZones } from "../src/lib/display-settings.js";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-display-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return createStore({ home });
}

test("display defaults use UTC without persisting settings and include IANA choices", async t => {
  const store = await fixture(t);
  assert.deepEqual(await getDisplaySettings(store), { timeZone: "UTC" });
  assert.equal(currentDisplayTimeZone(), "UTC");
  assert.ok(supportedDisplayTimeZones().includes("Asia/Seoul"));
  assert.ok(supportedDisplayTimeZones().includes("UTC"));
  const db = openDatabase(store);
  try { assert.equal(db.prepare("SELECT value FROM meta WHERE key='display_settings'").get(), undefined); } finally { db.close(); }
});

test("display settings persist per store, audit changes once and never change artifact timestamps", async t => {
  const store = await fixture(t), other = await fixture(t);
  const artifact = await createArtifact(store, { title: "Notes", content: "hello" });
  const before = await getArtifact(store, artifact.id);
  await saveDisplaySettings(store, { timeZone: " Asia/Seoul " });
  await saveDisplaySettings(store, { timeZone: "Asia/Seoul" });
  assert.deepEqual(await getDisplaySettings(store), { timeZone: "Asia/Seoul" });
  assert.deepEqual(await getDisplaySettings(other), { timeZone: "UTC" });
  const after = await getArtifact(store, artifact.id);
  await awaitEmbeddingIndexing(store);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.updatedAt, before.updatedAt);
  const db = openDatabase(store);
  try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='display-settings-change'").get().count, 1); } finally { db.close(); }
});

test("invalid zones and malformed settings cannot replace an accepted choice", async t => {
  const store = await fixture(t);
  await saveDisplaySettings(store, { timeZone: "Asia/Seoul" });
  for (const value of [null, [], {}, { timeZone: "" }, { timeZone: "+09:00" }, { timeZone: "No/TimeZone" }, { timeZone: "Asia/Seoul", unknown: true }, { timeZone: "x".repeat(101) }]) {
    await assert.rejects(saveDisplaySettings(store, value), { code: "INVALID_DISPLAY_SETTINGS", statusCode: 400 });
  }
  assert.deepEqual(await getDisplaySettings(store), { timeZone: "Asia/Seoul" });
});

test("concurrent request contexts do not leak time zones between stores", async () => {
  await Promise.all(["Asia/Seoul", "America/New_York"].map(timeZone => runWithDisplaySettings({ timeZone }, async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(currentDisplayTimeZone(), timeZone);
  })));
  assert.equal(currentDisplayTimeZone(), "UTC");
});

test("full backups preserve the display setting", async t => {
  const store = await fixture(t), target = await fixture(t);
  await saveDisplaySettings(store, { timeZone: "Asia/Seoul" });
  await importStoreFromString(target, await exportStoreToString(store, { scope: "full" }), { confirm: "replace-all" });
  assert.deepEqual(await getDisplaySettings(target), { timeZone: "Asia/Seoul" });
});

test("corrupt persisted display settings fail explicitly", async t => {
  const store = await fixture(t);
  await getDisplaySettings(store);
  const db = openDatabase(store);
  try { db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('display_settings', ?)").run('{"timeZone":"unknown"}'); } finally { db.close(); }
  await assert.rejects(getDisplaySettings(store), { code: "CORRUPT_DISPLAY_SETTINGS" });
});
