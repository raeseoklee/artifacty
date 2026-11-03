import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { createArtifact, updateArtifact, getArtifact, awaitEmbeddingIndexing } from "../src/lib/storage.js";

test("editing a historical version loads that content and saves a new version with concurrency protection", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-historical-edit-"));
  const app = await startServer({ home, port: 0 });
  try {
    const artifact = await createArtifact(app.store, { title: "Versioned guide", format: "text", content: "First revision", visibility: "public" });
    await updateArtifact(app.store, artifact.id, { format: "text", content: "Second revision" });
    await updateArtifact(app.store, artifact.id, { format: "text", content: "Third revision" });
    const url = `${app.url}/artifacts/${artifact.id}`;
    const viewer = await (await fetch(`${url}?version=2`)).text();
    assert.match(viewer, new RegExp(`/artifacts/${artifact.id}/edit\\?version=2`));
    const editor = await (await fetch(`${url}/edit?version=2`)).text();
    assert.match(editor, />Second revision<\/textarea>/);
    assert.doesNotMatch(editor, />Third revision<\/textarea>/);
    assert.match(editor, /name="expectedVersion" value="3"/);
    const save = content => fetch(`${url}/edit`, {
      method: "POST", redirect: "manual", headers: { origin: app.url },
      body: new URLSearchParams({ title: "Versioned guide", format: "text", content, expectedVersion: "3" })
    });
    const saved = await save("Second revision, edited");
    assert.equal(saved.status, 303);
    await saved.text();
    const latest = await getArtifact(app.store, artifact.id);
    assert.equal(latest.latestVersion, 4);
    assert.equal(latest.content, "Second revision, edited");
    assert.equal((await getArtifact(app.store, artifact.id, { version: 2 })).content, "Second revision");
    assert.equal((await getArtifact(app.store, artifact.id, { version: 3 })).content, "Third revision");
    const stale = await save("Another edit based on the earlier latest revision");
    assert.equal(stale.status, 409);
    assert.match(await stale.text(), /Another edit based on the earlier latest revision/);
    assert.equal((await getArtifact(app.store, artifact.id)).latestVersion, 4);
  } finally {
    await awaitEmbeddingIndexing(app.store);
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
