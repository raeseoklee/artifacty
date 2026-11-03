import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { createArtifact, updateArtifact, getArtifact, awaitEmbeddingIndexing } from "../src/lib/storage.js";

test("historical explainer edits preserve selected source provenance across conflicts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-explainer-base-"));
  const app = await startServer({ home, port: 0 });
  const model = summary => JSON.stringify({ schemaVersion: 1, goal: "Understand queues", summary, limitations: [], blocks: [{ id: "flow", title: "Flow", type: "steps", items: [{ id: "queue", label: "Queue", explanation: "Jobs wait.", basis: "source", citation: "Queue section" }] }] });
  try {
    const artifact = await createArtifact(app.store, { title: "Queue", format: "explainer", content: model("First"), metadata: { explainerSourceVersion: 1, explainerSourceSha256: "a".repeat(64) }, visibility: "public" });
    await updateArtifact(app.store, artifact.id, { format: "explainer", content: model("Second"), metadata: { explainerSourceVersion: 2, explainerSourceSha256: "b".repeat(64) } });
    const url = app.url + "/artifacts/" + artifact.id + "/edit";
    const editor = await (await fetch(url + "?version=1")).text();
    assert.match(editor, /name="baseVersion" value="1"/);
    assert.match(editor, /name="expectedVersion" value="2"/);
    const save = expectedVersion => fetch(url, { method: "POST", redirect: "manual", headers: { origin: app.url }, body: new URLSearchParams({ title: "Queue", format: "explainer", content: model("Edited first"), baseVersion: "1", expectedVersion }) });
    const conflict = await save("1");
    assert.equal(conflict.status, 409);
    const conflictPage = await conflict.text();
    assert.match(conflictPage, /name="baseVersion" value="1"/);
    assert.match(conflictPage, /name="expectedVersion" value="2"/);
    const saved = await save("2");
    assert.equal(saved.status, 303);
    await saved.text();
    const latest = await getArtifact(app.store, artifact.id);
    assert.equal(latest.latestVersion, 3);
    assert.equal(latest.version.metadata.explainerSourceVersion, 1);
    assert.equal(latest.version.metadata.explainerSourceSha256, "a".repeat(64));
  } finally {
    await awaitEmbeddingIndexing(app.store);
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
