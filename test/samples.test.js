import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createArtifact, createStore, createUser, getArtifact, updateArtifact } from "../src/lib/storage.js";
import { installSamples, removeSamples } from "../src/lib/samples.js";

const catalog = [{ key: "intro", title: "Introduction", format: "markdown", content: "# Original", tags: ["sample"] }];

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-samples-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return createStore({ home });
}

test("sample lifecycle is idempotent and preserves edits and unrelated content", async (t) => {
  const store = await fixture(t);
  const unrelated = await createArtifact(store, { ...catalog[0] });
  const first = await installSamples(store, { catalog });
  assert.equal(first.installed, 1);
  assert.equal((await installSamples(store, { catalog })).skipped, 1);
  const id = first.artifactIds[0];
  await updateArtifact(store, id, { content: "# My edits", metadata: { custom: true } });
  assert.equal((await removeSamples(store)).archived, 1);
  assert.equal((await removeSamples(store)).archived, 0);
  assert.equal((await getArtifact(store, unrelated.id)).archivedAt, null);
  const restored = await installSamples(store, { catalog });
  assert.equal(restored.restored, 1);
  assert.deepEqual(restored.artifactIds, [id]);
  const artifact = await getArtifact(store, id);
  assert.equal(artifact.content, "# My edits");
  assert.equal(artifact.latestVersion, 2);
});

test("sample management requires an active administrator and is ownership scoped", async (t) => {
  const store = await fixture(t);
  const admin = await createUser(store, { email: "admin@example.test", password: "test-password-admin", role: "admin" });
  const member = await createUser(store, { email: "member@example.test", password: "test-password-member", role: "user" });
  const access = { userId: admin.id, role: "admin" };
  await assert.rejects(installSamples(store, { catalog, access: { userId: member.id, role: "admin" } }), /administrators/);
  await assert.rejects(removeSamples(store, { access: {} }), /administrators/);
  const local = await installSamples(store, { catalog });
  const owned = await installSamples(store, { catalog, access });
  assert.notEqual(local.artifactIds[0], owned.artifactIds[0]);
  assert.deepEqual((await removeSamples(store, { access })).artifactIds, owned.artifactIds);
  assert.equal((await getArtifact(store, local.artifactIds[0])).archivedAt, null);
});

test("the final manual catalog installs all four real samples safely", async (t) => {
  const store = await fixture(t);
  const first = await installSamples(store);
  assert.equal(first.installed, 4);
  assert.equal(new Set(first.artifactIds).size, 4);
  const artifacts = await Promise.all(first.artifactIds.map((id) => getArtifact(store, id)));
  assert.deepEqual(artifacts.map((artifact) => artifact.version.format), ["markdown", "html", "mermaid", "markdown"]);
  assert.equal(artifacts[3].artifactType, "handoff");
  for (const artifact of artifacts) assert.ok(artifact.content.length > 500);
  assert.doesNotMatch(artifacts[1].content, /<script\b/i);
  assert.match(artifacts[1].content, /120 seconds/);
  assert.match(artifacts[1].content, /13 formats/);
  assert.equal((await installSamples(store)).skipped, 4);
  assert.equal((await removeSamples(store)).archived, 4);
  assert.equal((await installSamples(store)).restored, 4);
});
