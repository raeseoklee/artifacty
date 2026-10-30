import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createArtifact, createStore, listArtifactsPage, rebuildSearchIndex } from "../src/lib/storage.js";

process.env.ARTIFACTY_EMBEDDINGS_PROVIDER = "disabled";

test("collection keyword indexes include prose but never referenced artifact IDs", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-collection-search-"));
  try {
    const store = createStore({ home });
    await createArtifact(store, { title: "Manual", format: "collection", content: JSON.stringify({ description: "Searchable introduction", sections: [{ id: "start", title: "Chapter", items: [{ artifactId: "private-hidden-filename-123", display: "card" }] }] }) });
    for (const rebuild of [false, true]) {
      if (rebuild) await rebuildSearchIndex(store);
      const hidden = await listArtifactsPage(store, { query: "private-hidden-filename-123", mode: "keyword" });
      assert.equal(hidden.total, 0);
      const visible = await listArtifactsPage(store, { query: "Searchable", mode: "keyword" });
      assert.equal(visible.total, 1);
      assert.doesNotMatch(JSON.stringify(visible), /private-hidden-filename-123/);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
