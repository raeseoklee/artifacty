import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createArtifact, createStore, getArtifact, listArtifactsPage, updateArtifact } from "../src/lib/storage.js";

test("SQLite keeps NUL characters in content but rejects them in titles and tags, matching PostgreSQL", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-nul-"));
  try {
    const store = createStore({ home });
    const created = await createArtifact(store, { title: "Searchable", content: "alpha\u0000omega", sourceAgent: "test" });
    assert.equal((await getArtifact(store, created.id)).content, "alpha\u0000omega");
    assert.ok((await listArtifactsPage(store, { query: "omega" })).artifacts.some((item) => item.id === created.id));
    await assert.rejects(createArtifact(store, { title: "bad\u0000title", content: "x", sourceAgent: "test" }), { statusCode: 400, code: "INVALID_TEXT" });
    await assert.rejects(updateArtifact(store, created.id, { title: "bad\u0000title", content: "y" }), { statusCode: 400 });
    await assert.rejects(createArtifact(store, { title: "ok", content: "x", tags: ["bad\u0000tag"], sourceAgent: "test" }), { statusCode: 400 });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
