import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createEmbeddingProvider, cosineSimilarity } from "../src/lib/embeddings.js";
import { BUNDLED_MODEL_PATH, closeLocalEmbeddingWorker, readModelManifest } from "../src/lib/local-embeddings.js";

const exec = promisify(execFile);

test("local model manifest rejects traversal and unsupported pooling before inference", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "artifacty-model-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(path.join(BUNDLED_MODEL_PATH, "embedding-model.json"), "utf8"));
  await writeFile(path.join(root, "embedding-model.json"), JSON.stringify({ ...manifest, pooling: "unknown" }));
  assert.throws(() => readModelManifest(root), /Invalid/);
  manifest.files[0].path = "../tokenizer.json";
  await writeFile(path.join(root, "embedding-model.json"), JSON.stringify(manifest));
  assert.throws(() => readModelManifest(root), /Invalid model file/);
});

test("provider selection keeps explicit overrides and legacy external precedence", () => {
  const external = { ARTIFACTY_EMBEDDINGS_URL: "http://127.0.0.1:1/v1", ARTIFACTY_EMBEDDINGS_COMMAND: "node fixture.js" };
  assert.equal(createEmbeddingProvider(external).name, "command");
  assert.equal(createEmbeddingProvider({ ...external, ARTIFACTY_EMBEDDINGS_PROVIDER: "local" }).name, "local-onnx");
  assert.equal(createEmbeddingProvider({ ...external, ARTIFACTY_EMBEDDINGS_PROVIDER: "disabled" }), null);
  assert.equal(createEmbeddingProvider({ ...external, ARTIFACTY_EMBEDDINGS_PROVIDER: "openai-compatible" }).name, "openai-compatible");
  assert.throws(() => createEmbeddingProvider({ ARTIFACTY_EMBEDDINGS_PROVIDER: "typo" }), /Invalid/);
  assert.throws(() => createEmbeddingProvider({ ARTIFACTY_EMBEDDINGS_PROVIDER: "openai-compatible" }), /required/);
});

test("bundled ONNX model runs offline, normalizes vectors and retrieves Korean and English passages", { timeout: 120_000 }, async t => {
  t.after(closeLocalEmbeddingWorker);
  const provider = createEmbeddingProvider({});
  const started = performance.now();
  const documents = [
    "Java 서버에서 OutOfMemoryError가 발생했다. 힙 덤프를 분석하여 메모리 누수와 객체 참조를 확인한다.",
    "레몬 케이크를 만들려면 밀가루와 설탕, 버터를 섞고 오븐에 굽는다.",
    "The database backup can be restored after an accidental deletion. Verify the backup before recovering the lost records."
  ];
  const vectors = await provider.embed(documents, { purpose: "document" });
  const queries = await provider.embed(["서버 메모리 부족 문제 원인 분석", "How do I recover deleted data?"], { purpose: "query" });
  for (const vector of [...vectors, ...queries]) {
    assert.equal(vector.length, 384);
    assert.ok(Array.from(vector).every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 0.0001);
  }
  for (const [queryIndex, expected] of [[0, 0], [1, 2]]) {
    const scores = vectors.map(vector => cosineSimilarity(queries[queryIndex], vector));
    assert.equal(scores.indexOf(Math.max(...scores)), expected, JSON.stringify(scores));
  }
  const [long] = await provider.embed(["검색 문서 ".repeat(2000)]);
  assert.equal(long.length, 384);
  t.diagnostic(`Cold load, 3 passages, 2 queries and truncated long input: ${Math.round(performance.now() - started)}ms; process RSS ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MiB`);
});

test("a custom model directory is selectable and corrupted model bytes are rejected", { timeout: 120_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "artifacty-model-custom-"));
  t.after(async () => { await closeLocalEmbeddingWorker(); await rm(root, { recursive: true, force: true }); });
  await cp(BUNDLED_MODEL_PATH, root, { recursive: true });
  const filename = path.join(root, "embedding-model.json");
  const manifest = JSON.parse(await readFile(filename, "utf8"));
  manifest.id = "local/custom-e5";
  await writeFile(filename, JSON.stringify(manifest));
  const provider = createEmbeddingProvider({ ARTIFACTY_EMBEDDINGS_LOCAL_PATH: root });
  assert.match(provider.model, /^local\/custom-e5@/);
  assert.notEqual(provider.model, createEmbeddingProvider({}).model);
  assert.equal(provider.local.bundled, false);
  const [vector] = await provider.embed(["local model selection"]);
  assert.equal(vector.length, 384);
  await closeLocalEmbeddingWorker();
  await writeFile(path.join(root, "tokenizer_config.json"), "{}");
  await assert.rejects(provider.embed(["must fail integrity"]), /integrity check failed/);
});

test("embeddings info and check work without initializing a data store", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-embedding-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, ARTIFACTY_HOME: path.join(home, "absent"), ARTIFACTY_EMBEDDINGS_PROVIDER: "local", ARTIFACTY_EMBEDDINGS_LOCAL_PATH: BUNDLED_MODEL_PATH };
  const { stdout } = await exec(process.execPath, ["src/cli.js", "embeddings", "info"], { env });
  assert.equal(JSON.parse(stdout).provider, "local-onnx");
  const checked = await exec(process.execPath, ["--import", path.resolve("scripts/fixtures/deny-network.mjs"), "src/cli.js", "embeddings", "check"], { env });
  assert.equal(JSON.parse(checked.stdout).ok, true);
  await assert.rejects(readFile(path.join(env.ARTIFACTY_HOME, "artifacty.sqlite")), { code: "ENOENT" });
});


test("vendored WASM runtime matches the pinned upstream distribution and includes licenses", async () => {
  const root = new URL("../vendor/onnxruntime/", import.meta.url);
  const provenance = JSON.parse(await readFile(new URL("provenance.json", root), "utf8"));
  assert.equal(provenance.version, "1.30.0");
  for (const file of provenance.files) {
    const bytes = await readFile(new URL(file.path, root));
    assert.equal(bytes.length, file.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  for (const name of ["onnxruntime-LICENSE.txt", "onnxruntime-ThirdPartyNotices.txt", "multilingual-e5-small-LICENSE.txt", "tokenizers-js-LICENSE.txt"]) {
    assert.ok((await readFile(new URL(`../licenses/${name}`, import.meta.url))).length > 100);
  }
});
