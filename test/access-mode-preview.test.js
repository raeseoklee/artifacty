import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore, createUser, createArtifact, archiveArtifact, setAccessMode, getAccessMode, previewAccessMode, openDatabase } from "../src/lib/storage.js";

async function fixture(t, accounts = true) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mode-preview-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = createStore({ home });
  const user = accounts ? await createUser(store, { email: "admin@example.test", password: "password-123", role: "admin" }) : null;
  return { store, access: { role: "admin", userId: user?.id } };
}
function auditCount(store) {
  const db = openDatabase(store);
  try { return db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count; } finally { db.close(); }
}

test("mode preview shows the proposed anonymous dashboard without changing mode or writing audit", async (t) => {
  const { store, access } = await fixture(t);
  const shared = await createArtifact(store, { title: "Public dashboard", content: "not returned", visibility: "public" });
  await createArtifact(store, { title: "Private title must stay hidden", content: "secret", visibility: "private" });
  const archived = await createArtifact(store, { title: "Archived", content: "old", visibility: "public" });
  await archiveArtifact(store, archived.id);
  for (const current of ["private", "public"]) {
    await setAccessMode(store, current, { access });
    const before = auditCount(store);
    const result = await previewAccessMode(store, "public", { access });
    assert.equal(result.total, 1);
    assert.equal(result.anonymousArtifactCount, 1);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.id), [shared.id]);
    assert.equal(result.artifacts[0].title, shared.title);
    assert.equal(result.artifacts[0].content, undefined);
    assert.equal(JSON.stringify(result).includes("Private title"), false);
    assert.deepEqual(await previewAccessMode(store, "private", { access }), { mode: "private", anonymousArtifactCount: 0, total: 0, artifacts: [] });
    assert.equal(await getAccessMode(store), current);
    assert.equal(auditCount(store), before);
  }
  await assert.rejects(previewAccessMode(store, "public", { access: { role: "user" } }), { statusCode: 403 });
  await assert.rejects(previewAccessMode(store, "invalid", { access }), { statusCode: 400 });
});

test("preview is capped at fifty and orders timestamp ties deterministically", async (t) => {
  const { store, access } = await fixture(t);
  const ids = [];
  for (let index = 0; index < 52; index++) ids.push((await createArtifact(store, { title: `Artifact ${index}`, content: "test", visibility: "public" })).id);
  const db = openDatabase(store);
  try { db.prepare("UPDATE artifacts SET created_at=?,updated_at=?").run("2026-01-01", "2026-01-01"); } finally { db.close(); }
  const result = await previewAccessMode(store, "public", { access });
  assert.equal(result.total, 52);
  assert.equal(result.anonymousArtifactCount, 52);
  assert.deepEqual(result.artifacts.map((artifact) => artifact.id), ids.sort().slice(0, 50));
});

test("public preview preserves single-user visibility semantics", async (t) => {
  const { store, access } = await fixture(t, false);
  const artifact = await createArtifact(store, { title: "Local private label", content: "text", visibility: "private" });
  const result = await previewAccessMode(store, "public", { access });
  assert.deepEqual(result.artifacts.map((entry) => entry.id), [artifact.id]);
});
