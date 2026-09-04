import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  blobToVector,
  cosineSimilarity,
  createEmbeddingProvider,
  embeddingTextForArtifact,
  reciprocalRankFusion,
  vectorToBlob
} from "../src/lib/embeddings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Deliberately NOT under test/fixtures: node --test's default glob picks up
// any .js file located inside a directory literally named "test" and tries
// to run it as its own test file, which would hang forever on this script's
// stdin read and stall the whole suite. scripts/fixtures/ is outside that
// glob.
const COMMAND_FIXTURE = path.join(__dirname, "..", "scripts", "fixtures", "embeddings-command.js");

test("createEmbeddingProvider returns null when unconfigured", () => {
  assert.equal(createEmbeddingProvider({}), null);
});

test("createEmbeddingProvider prefers command over openai-compatible when both are set", () => {
  const provider = createEmbeddingProvider({
    ARTIFACTY_EMBEDDINGS_COMMAND: `node ${JSON.stringify(COMMAND_FIXTURE)}`,
    ARTIFACTY_EMBEDDINGS_URL: "http://127.0.0.1:1"
  });
  assert.equal(provider.name, "command");
});

test("vectorToBlob/blobToVector round trip preserves values as little-endian float32", () => {
  const vector = Float32Array.from([1, -2.5, 0, 3.25, -100.125]);
  const blob = vectorToBlob(vector);
  assert.ok(Buffer.isBuffer(blob));
  assert.equal(blob.length, vector.length * 4);

  // Verify little-endian encoding directly against a DataView.
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let i = 0; i < vector.length; i += 1) {
    assert.equal(view.getFloat32(i * 4, true), vector[i]);
  }

  const roundTripped = blobToVector(blob);
  assert.equal(roundTripped.length, vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    assert.equal(roundTripped[i], vector[i]);
  }
});

test("blobToVector handles a length not evenly divisible by 4 by truncating", () => {
  const blob = Buffer.alloc(6);
  const vector = blobToVector(blob);
  assert.equal(vector.length, 1);
});

test("cosineSimilarity returns 1 for identical vectors and 0 for orthogonal vectors", () => {
  const a = Float32Array.from([1, 0, 0]);
  const b = Float32Array.from([1, 0, 0]);
  const c = Float32Array.from([0, 1, 0]);
  assert.equal(cosineSimilarity(a, b), 1);
  assert.equal(cosineSimilarity(a, c), 0);
});

test("cosineSimilarity returns 0 (not NaN) for a zero-magnitude vector", () => {
  const zero = Float32Array.from([0, 0, 0]);
  const other = Float32Array.from([1, 2, 3]);
  assert.equal(cosineSimilarity(zero, other), 0);
  assert.equal(cosineSimilarity(other, zero), 0);
});

test("cosineSimilarity ranks a more similar vector higher", () => {
  const query = Float32Array.from([1, 1, 0]);
  const close = Float32Array.from([2, 2, 0]);
  const far = Float32Array.from([0, 0, 1]);
  assert.ok(cosineSimilarity(query, close) > cosineSimilarity(query, far));
});

test("embeddingTextForArtifact combines title, tags, metadata, and truncated content", () => {
  const text = embeddingTextForArtifact(
    { title: "Deploy Report", tags: ["ops", "deploy"], metadata: { env: "prod" }, format: "markdown" },
    "a".repeat(100),
    10
  );
  assert.match(text, /^Deploy Report/);
  assert.match(text, /ops deploy/);
  assert.match(text, /"env":"prod"/);
  assert.match(text, /a{10}$/);
  assert.ok(!text.includes("a".repeat(11)));
});

test("embeddingTextForArtifact omits content for binary formats but keeps metadata", () => {
  const text = embeddingTextForArtifact(
    { title: "Screenshot", tags: [], metadata: { width: 100 }, format: "image" },
    "base64payloadshouldnotappear",
    8000
  );
  assert.ok(!text.includes("base64payloadshouldnotappear"));
  assert.match(text, /Screenshot/);
  assert.match(text, /"width":100/);
});

test("embeddingTextForArtifact returns empty string for an empty artifact", () => {
  assert.equal(embeddingTextForArtifact({}, "", 8000), "");
});

test("reciprocalRankFusion merges rankings and rewards items ranked highly in multiple lists", () => {
  const keyword = ["a", "b", "c"];
  const semantic = ["b", "a", "d"];
  const fused = reciprocalRankFusion([keyword, semantic]);
  const ids = fused.map((entry) => entry.id);
  // "a" and "b" each appear near the top of both lists, so they should rank
  // above "c" and "d", which only appear in one list.
  assert.ok(ids.indexOf("a") < ids.indexOf("c"));
  assert.ok(ids.indexOf("b") < ids.indexOf("d"));
});

test("reciprocalRankFusion is deterministic across repeated calls", () => {
  const rankings = [["x", "y", "z"], ["y", "z", "x"], ["z", "x", "y"]];
  const first = reciprocalRankFusion(rankings).map((entry) => entry.id);
  const second = reciprocalRankFusion(rankings).map((entry) => entry.id);
  assert.deepEqual(first, second);
});

test("reciprocalRankFusion respects a custom k", () => {
  const rankings = [["a", "b"]];
  const highK = reciprocalRankFusion(rankings, 1000);
  const lowK = reciprocalRankFusion(rankings, 1);
  // Larger k compresses the score differences between ranks.
  const highGap = highK[0].score - highK[1].score;
  const lowGap = lowK[0].score - lowK[1].score;
  assert.ok(lowGap > highGap);
});

test("reciprocalRankFusion handles empty input", () => {
  assert.deepEqual(reciprocalRankFusion([]), []);
  assert.deepEqual(reciprocalRankFusion(), []);
});

test("command provider embeds deterministic vectors via the fixture script", async () => {
  const provider = createEmbeddingProvider({
    ARTIFACTY_EMBEDDINGS_COMMAND: `node ${JSON.stringify(COMMAND_FIXTURE)}`
  });
  assert.equal(provider.name, "command");
  assert.equal(provider.model, "command");

  const [vectorA, vectorB] = await provider.embed(["hello", "hello"]);
  assert.equal(vectorA.length, 8);
  assert.deepEqual(Array.from(vectorA), Array.from(vectorB));
  assert.equal(provider.dimensions, 8);

  const [different] = await provider.embed(["zzzzzzzzzzzzzzzzzzzz"]);
  assert.notDeepEqual(Array.from(different), Array.from(vectorA));
});

test("command provider honors a custom model label", async () => {
  const provider = createEmbeddingProvider({
    ARTIFACTY_EMBEDDINGS_COMMAND: `node ${JSON.stringify(COMMAND_FIXTURE)}`,
    ARTIFACTY_EMBEDDINGS_MODEL: "fixture-v1"
  });
  assert.equal(provider.model, "fixture-v1");
});

test("command provider rejects when the command exits non-zero", async () => {
  const provider = createEmbeddingProvider({
    ARTIFACTY_EMBEDDINGS_COMMAND: "node -e \"process.exit(1)\""
  });
  await assert.rejects(() => provider.embed(["text"]));
});

test("openai-compatible provider posts { model, input } and parses data[].embedding", async () => {
  let receivedBody = null;
  let receivedAuth = null;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      receivedBody = JSON.parse(raw);
      receivedAuth = request.headers.authorization;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        data: [
          { index: 1, embedding: [0, 1, 0] },
          { index: 0, embedding: [1, 0, 0] }
        ]
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const provider = createEmbeddingProvider({
      ARTIFACTY_EMBEDDINGS_URL: `http://127.0.0.1:${port}`,
      ARTIFACTY_EMBEDDINGS_MODEL: "test-model",
      ARTIFACTY_EMBEDDINGS_API_KEY: "secret-key-value"
    });
    assert.equal(provider.name, "openai-compatible");
    assert.equal(provider.model, "test-model");

    const vectors = await provider.embed(["first", "second"]);
    assert.equal(receivedBody.model, "test-model");
    assert.deepEqual(receivedBody.input, ["first", "second"]);
    assert.equal(receivedAuth, "Bearer secret-key-value");

    // Response rows are out of order (index 1 before index 0); the provider
    // must sort them back into request order.
    assert.deepEqual(Array.from(vectors[0]), [1, 0, 0]);
    assert.deepEqual(Array.from(vectors[1]), [0, 1, 0]);
    assert.equal(provider.dimensions, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("openai-compatible provider surfaces a bounded error without leaking the API key", async () => {
  const server = http.createServer((request, response) => {
    response.statusCode = 401;
    response.end("unauthorized: bad key");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const provider = createEmbeddingProvider({
      ARTIFACTY_EMBEDDINGS_URL: `http://127.0.0.1:${port}`,
      ARTIFACTY_EMBEDDINGS_API_KEY: "super-secret-key"
    });
    await assert.rejects(
      () => provider.embed(["text"]),
      (error) => {
        assert.match(error.message, /401/);
        assert.ok(!error.message.includes("super-secret-key"));
        return true;
      }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("openai-compatible provider strips a trailing slash from the base URL", async () => {
  let requestedPath = null;
  const server = http.createServer((request, response) => {
    requestedPath = request.url;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const provider = createEmbeddingProvider({ ARTIFACTY_EMBEDDINGS_URL: `http://127.0.0.1:${port}/` });
    await provider.embed(["text"]);
    assert.equal(requestedPath, "/embeddings");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
