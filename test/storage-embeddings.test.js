import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  awaitEmbeddingIndexing,
  createArtifact,
  createStore,
  createUser,
  deleteArtifactEmbeddings,
  deleteArtifactVersion,
  listArtifactEmbeddings,
  listArtifactsPage,
  rebuildEmbeddingIndex,
  resetEmbeddingProvider,
  setEmbeddingProvider,
  updateArtifact,
  upsertArtifactEmbedding
} from "../src/lib/storage.js";

// A small deterministic "embedding" provider for storage-level tests: each
// text maps to a fixed vector based on which of a handful of topic keywords
// it contains, so semantic ranking is predictable without a real model.
function fakeProvider({ name = "fake", model = "fake-model" } = {}) {
  const axes = ["deploy", "recipe", "database", "onions"];
  return {
    name,
    model,
    dimensions: axes.length,
    calls: [],
    async embed(texts) {
      this.calls.push(texts);
      return texts.map((text) => {
        const lower = String(text).toLowerCase();
        const vector = new Float32Array(axes.length);
        axes.forEach((axis, index) => {
          if (lower.includes(axis)) {
            vector[index] = 1;
          }
        });
        if (!vector.some(Boolean)) {
          vector[0] = 0.01;
        }
        return vector;
      });
    }
  };
}

async function withTempStore(prefix, fn) {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await fn(createStore({ home }));
  } finally {
    resetEmbeddingProvider();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function waitForBackgroundIndexing() {
  // Deterministic instead of a fixed sleep/setImmediate-chain guess:
  // scheduleEmbeddingIndexing() (storage.js) tracks every job it starts in
  // a module-level Set, and awaitEmbeddingIndexing() resolves once that set
  // drains, however many setImmediate hops it took to get there.
  await awaitEmbeddingIndexing();
}

test("listArtifactsPage without a provider is unaffected by mode=semantic (falls back to keyword)", async () => {
  await withTempStore("artifacty-embed-fallback-", async (store) => {
    resetEmbeddingProvider();
    await createArtifact(store, { title: "Deploy failure", content: "deploy database migration failed", format: "text", sourceAgent: "test" });

    const page = await listArtifactsPage(store, { query: "deploy", mode: "semantic" });
    assert.equal(page.search.mode, "keyword");
    assert.equal(page.search.fallback, true);
    assert.equal(page.artifacts.length, 1);
  });
});

test("listArtifactsPage mode=keyword ignores a configured provider", async () => {
  await withTempStore("artifacty-embed-keyword-", async (store) => {
    const provider = fakeProvider();
    setEmbeddingProvider(provider);
    await createArtifact(store, { title: "Deploy failure", content: "deploy database migration failed", format: "text", sourceAgent: "test" });
    // createArtifact itself schedules background indexing; wait for it to
    // settle so the assertion below only observes calls made by the search
    // itself (mode=keyword should make none).
    await waitForBackgroundIndexing();
    const callsBeforeSearch = provider.calls.length;

    const page = await listArtifactsPage(store, { query: "deploy", mode: "keyword" });
    assert.equal(page.search.mode, "keyword");
    assert.equal(provider.calls.length, callsBeforeSearch);
  });
});

test("mode=semantic ranks by cosine similarity over embedded content", async () => {
  await withTempStore("artifacty-embed-semantic-", async (store) => {
    setEmbeddingProvider(fakeProvider());
    const deploy = await createArtifact(store, { title: "Deploy report", content: "The deploy failed because of a database timeout.", format: "text", sourceAgent: "test" });
    const recipe = await createArtifact(store, { title: "Onion soup", content: "Chop onions and simmer with stock.", format: "text", sourceAgent: "test" });
    await waitForBackgroundIndexing();

    const page = await listArtifactsPage(store, { query: "our deploy database is broken", mode: "semantic" });
    assert.equal(page.search.mode, "semantic");
    assert.equal(page.search.backend, "semantic");
    assert.equal(page.artifacts[0].id, deploy.id);
    assert.ok(typeof page.artifacts[0].searchScore === "number");
    assert.ok(page.artifacts.some((a) => a.id === recipe.id));
    assert.ok(page.artifacts[0].searchScore >= page.artifacts[1].searchScore);
  });
});

test("mode=hybrid merges keyword and semantic rankings", async () => {
  await withTempStore("artifacty-embed-hybrid-", async (store) => {
    setEmbeddingProvider(fakeProvider());
    const deploy = await createArtifact(store, { title: "Deploy report", content: "The deploy failed because of a database timeout.", format: "text", sourceAgent: "test" });
    await createArtifact(store, { title: "Onion soup", content: "Chop onions and simmer with stock.", format: "text", sourceAgent: "test" });
    await waitForBackgroundIndexing();

    const page = await listArtifactsPage(store, { query: "deploy", mode: "hybrid" });
    assert.equal(page.search.mode, "hybrid");
    assert.equal(page.artifacts[0].id, deploy.id);
  });
});

test("mode is hybrid by default when a provider is configured and a query is set", async () => {
  await withTempStore("artifacty-embed-default-", async (store) => {
    setEmbeddingProvider(fakeProvider());
    await createArtifact(store, { title: "Deploy report", content: "deploy database", format: "text", sourceAgent: "test" });
    await waitForBackgroundIndexing();

    const page = await listArtifactsPage(store, { query: "deploy" });
    assert.equal(page.search.mode, "hybrid");
  });
});

test("no query means keyword mode even with a provider configured", async () => {
  await withTempStore("artifacty-embed-noquery-", async (store) => {
    setEmbeddingProvider(fakeProvider());
    await createArtifact(store, { title: "Deploy report", content: "deploy database", format: "text", sourceAgent: "test" });

    const page = await listArtifactsPage(store, {});
    assert.equal(page.search.mode, "keyword");
  });
});

test("semantic search respects visibility: a private artifact is hidden from a non-owner", async () => {
  await withTempStore("artifacty-embed-visibility-", async (store) => {
    setEmbeddingProvider(fakeProvider());
    const owner = await createUser(store, { email: "embed-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "embed-other@example.com", name: "Other", role: "user", password: "password-123" });

    const priv = await createArtifact(store, {
      title: "Private deploy notes",
      content: "deploy database secrets",
      format: "text",
      sourceAgent: "test",
      visibility: "private",
      audit: { userId: owner.id, actor: owner.email }
    });
    await waitForBackgroundIndexing();

    const asOwner = await listArtifactsPage(store, { query: "deploy", mode: "semantic", access: { userId: owner.id, role: "user" } });
    assert.ok(asOwner.artifacts.some((a) => a.id === priv.id));

    const asOther = await listArtifactsPage(store, { query: "deploy", mode: "semantic", access: { userId: other.id, role: "user" } });
    assert.ok(!asOther.artifacts.some((a) => a.id === priv.id));

    const asAdmin = await listArtifactsPage(store, { query: "deploy", mode: "semantic", access: { userId: other.id, role: "admin" } });
    assert.ok(asAdmin.artifacts.some((a) => a.id === priv.id));
  });
});

test("listArtifactEmbeddings applies the same visibility predicate", async () => {
  await withTempStore("artifacty-embed-list-visibility-", async (store) => {
    const provider = fakeProvider();
    setEmbeddingProvider(provider);
    const owner = await createUser(store, { email: "embed-list-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "embed-list-other@example.com", name: "Other", role: "user", password: "password-123" });

    await createArtifact(store, {
      title: "Private deploy notes",
      content: "deploy database secrets",
      format: "text",
      sourceAgent: "test",
      visibility: "private",
      audit: { userId: owner.id, actor: owner.email }
    });
    await waitForBackgroundIndexing();

    const visible = await listArtifactEmbeddings(store, { provider: provider.name, model: provider.model, access: { userId: owner.id, role: "user" } });
    assert.equal(visible.length, 1);

    const hidden = await listArtifactEmbeddings(store, { provider: provider.name, model: provider.model, access: { userId: other.id, role: "user" } });
    assert.equal(hidden.length, 0);
  });
});

test("upsertArtifactEmbedding stores a vector retrievable by listArtifactEmbeddings", async () => {
  await withTempStore("artifacty-embed-upsert-", async (store) => {
    const artifact = await createArtifact(store, { title: "Doc", content: "hello world", format: "text", sourceAgent: "test" });
    await upsertArtifactEmbedding(store, {
      artifactId: artifact.id,
      version: 1,
      provider: "manual",
      model: "manual-model",
      vector: Float32Array.from([1, 2, 3])
    });

    const rows = await listArtifactEmbeddings(store, { provider: "manual", model: "manual-model" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].artifactId, artifact.id);
    assert.deepEqual(Array.from(rows[0].vector), [1, 2, 3]);
  });
});

test("deleteArtifactEmbeddings removes stored vectors for an artifact", async () => {
  await withTempStore("artifacty-embed-delete-", async (store) => {
    const artifact = await createArtifact(store, { title: "Doc", content: "hello world", format: "text", sourceAgent: "test" });
    await upsertArtifactEmbedding(store, {
      artifactId: artifact.id,
      version: 1,
      provider: "manual",
      model: "manual-model",
      vector: Float32Array.from([1, 2, 3])
    });

    const result = await deleteArtifactEmbeddings(store, artifact.id);
    assert.equal(result.ok, true);
    assert.equal(result.deleted, 1);

    const rows = await listArtifactEmbeddings(store, { provider: "manual", model: "manual-model" });
    assert.equal(rows.length, 0);
  });
});

test("deleteArtifactVersion removes the stale embedding for the deleted version and re-embeds the new latest", async () => {
  await withTempStore("artifacty-embed-version-delete-", async (store) => {
    const provider = fakeProvider();
    setEmbeddingProvider(provider);
    const artifact = await createArtifact(store, { title: "Doc", content: "deploy notes v1", format: "text", sourceAgent: "test" });
    await waitForBackgroundIndexing();

    const updated = await updateArtifact(store, artifact.id, { content: "recipe notes v2", sourceAgent: "test" });
    await waitForBackgroundIndexing();
    assert.equal(updated.latestVersion, 2);

    let rows = await listArtifactEmbeddings(store, { provider: provider.name, model: provider.model });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].version, 2, "the embedding should track the latest version after an update");

    // Deleting the embedded version must drop its now-stale embedding row
    // and schedule a fresh embedding of the version that becomes latest.
    await deleteArtifactVersion(store, artifact.id, 2, { reason: "revert" });
    await waitForBackgroundIndexing();

    rows = await listArtifactEmbeddings(store, { provider: provider.name, model: provider.model });
    assert.equal(rows.length, 1, "the new latest version should be re-embedded, not left with zero embeddings");
    assert.equal(rows[0].version, 1);

    const page = await listArtifactsPage(store, { query: "deploy", mode: "semantic" });
    assert.equal(page.artifacts[0].id, artifact.id, "search must rank on the re-embedded content, not the stale deleted version");
  });
});

test("update after approval re-embeds the new content in the background", async () => {
  await withTempStore("artifacty-embed-update-", async (store) => {
    const provider = fakeProvider();
    setEmbeddingProvider(provider);
    const artifact = await createArtifact(store, { title: "Doc", content: "deploy notes v1", format: "text", sourceAgent: "test" });
    await waitForBackgroundIndexing();

    await updateArtifact(store, artifact.id, { content: "onions and recipe notes v2", sourceAgent: "test" });
    await waitForBackgroundIndexing();

    const page = await listArtifactsPage(store, { query: "onions", mode: "semantic" });
    assert.equal(page.artifacts[0].id, artifact.id);
  });
});

test("a no-op update (skipNoop) does not schedule redundant re-embedding", async () => {
  await withTempStore("artifacty-embed-noop-", async (store) => {
    const provider = fakeProvider();
    setEmbeddingProvider(provider);
    const artifact = await createArtifact(store, { title: "Doc", content: "deploy notes", format: "text", sourceAgent: "test" });
    await waitForBackgroundIndexing();
    const callsAfterCreate = provider.calls.length;

    await updateArtifact(store, artifact.id, { content: "deploy notes", title: "Doc", sourceAgent: "test", skipNoop: true });
    await waitForBackgroundIndexing();

    assert.equal(provider.calls.length, callsAfterCreate);
  });
});

test("rebuildEmbeddingIndex without a provider reports configured: false", async () => {
  await withTempStore("artifacty-embed-rebuild-none-", async (store) => {
    resetEmbeddingProvider();
    await createArtifact(store, { title: "Doc", content: "hello", format: "text", sourceAgent: "test" });
    const result = await rebuildEmbeddingIndex(store);
    assert.equal(result.ok, false);
    assert.equal(result.configured, false);
  });
});

test("rebuildEmbeddingIndex re-embeds every latest version in batches", async () => {
  await withTempStore("artifacty-embed-rebuild-", async (store) => {
    resetEmbeddingProvider();
    const artifacts = [];
    for (let i = 0; i < 20; i += 1) {
      artifacts.push(await createArtifact(store, { title: `Doc ${i}`, content: `deploy notes ${i}`, format: "text", sourceAgent: "test" }));
    }

    const provider = fakeProvider();
    const result = await rebuildEmbeddingIndex(store, { embeddingProvider: provider, batchSize: 4 });
    assert.equal(result.ok, true);
    assert.equal(result.configured, true);
    assert.equal(result.indexed, 20);
    // 20 jobs at a batch size of 4 is 5 embed() calls.
    assert.equal(provider.calls.length, 5);

    const rows = await listArtifactEmbeddings(store, { provider: provider.name, model: provider.model });
    assert.equal(rows.length, 20);
    assert.ok(artifacts.every((artifact) => rows.some((row) => row.artifactId === artifact.id)));
  });
});

test("rebuildEmbeddingIndex skips binary formats' content but still embeds metadata", async () => {
  await withTempStore("artifacty-embed-rebuild-binary-", async (store) => {
    const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const artifact = await createArtifact(store, {
      title: "Screenshot",
      content: tinyPngBase64,
      format: "image",
      contentType: "image/png",
      sourceAgent: "test",
      tags: ["ui"]
    });

    const provider = fakeProvider();
    const result = await rebuildEmbeddingIndex(store, { embeddingProvider: provider });
    assert.equal(result.indexed, 1);
    assert.equal(provider.calls[0][0].includes(tinyPngBase64), false);
    assert.match(provider.calls[0][0], /Screenshot/);

    const rows = await listArtifactEmbeddings(store, { provider: provider.name, model: provider.model });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].artifactId, artifact.id);
  });
});

test("setEmbeddingProvider/resetEmbeddingProvider control the module-level default", async () => {
  await withTempStore("artifacty-embed-setter-", async (store) => {
    const provider = fakeProvider();
    setEmbeddingProvider(provider);
    await createArtifact(store, { title: "Doc", content: "deploy notes", format: "text", sourceAgent: "test" });
    await waitForBackgroundIndexing();
    assert.ok(provider.calls.length > 0);

    resetEmbeddingProvider();
    const page = await listArtifactsPage(store, { query: "deploy", mode: "semantic" });
    // With no provider configured, semantic falls back to keyword.
    assert.equal(page.search.mode, "keyword");
    assert.equal(page.search.fallback, true);
  });
});
