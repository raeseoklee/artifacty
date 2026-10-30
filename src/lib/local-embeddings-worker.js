import { parentPort } from "node:worker_threads";
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import * as ort from "../../vendor/onnxruntime/ort.wasm.min.mjs";
import { readModelManifest } from "./local-embeddings.js";

ort.env.wasm.numThreads = 1;
let loaded;
async function checkedFile(root, entry) {
  const filename = await realpath(path.join(root, entry.path));
  if (path.dirname(filename) !== root) throw new Error("Model file escapes its directory");
  const bytes = await readFile(filename);
  if (bytes.length !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`Model integrity check failed: ${entry.path}`);
  return bytes;
}

async function load(root, digest) {
  if (loaded?.key === `${root}:${digest}`) return loaded;
  const descriptor = readModelManifest(root);
  if (descriptor.digest !== digest) throw new Error("Model manifest changed; retry with the new configuration");
  const { manifest } = descriptor;
  const files = new Map();
  for (const file of manifest.files) files.set(file.path, await checkedFile(root, file));
  const bytes = Buffer.alloc(manifest.model.size);
  let offset = 0;
  for (const part of manifest.model.parts) {
    const chunk = await checkedFile(root, part);
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.model.sha256) throw new Error("Model weights integrity check failed");
  const tokenizer = new Tokenizer(JSON.parse(files.get("tokenizer.json")), JSON.parse(files.get("tokenizer_config.json")));
  // One session at a time bounds resident model memory. Only the CPU provider
  // is used; neither model loading nor tokenization fetches remote resources.
  if (loaded) { await loaded.session.release(); loaded = undefined; }
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
  if (session.inputNames.some(name => !["input_ids", "attention_mask", "token_type_ids"].includes(name))) {
    await session.release();
    throw new Error("Unsupported ONNX inputs: expected sentence-transformer token inputs");
  }
  loaded = { key: `${root}:${digest}`, manifest, tokenizer, session };
  return loaded;
}

async function embed(job) {
  const { manifest, tokenizer, session } = await load(job.root, job.digest);
  const vectors = [];
  for (const text of job.inputs) {
    const prefix = job.purpose === "query" ? manifest.queryPrefix : manifest.documentPrefix;
    const encoded = tokenizer.encode(prefix + text, { add_special_tokens: true, return_token_type_ids: true });
    // Preserve the final separator when truncating to the model's token limit.
    const take = values => values.length <= manifest.maxTokens ? values : [...values.slice(0, manifest.maxTokens - 1), values.at(-1)];
    const ids = take(encoded.ids);
    const mask = take(encoded.attention_mask);
    const types = take(encoded.token_type_ids);
    const feeds = {};
    for (const name of session.inputNames) {
      const values = name === "input_ids" ? ids : name === "attention_mask" ? mask : types;
      feeds[name] = new ort.Tensor("int64", BigInt64Array.from(values.map(BigInt)), [1, ids.length]);
    }
    const outputs = await session.run(feeds);
    const tensor = outputs[manifest.outputName || (manifest.pooling === "sentence" ? "sentence_embedding" : "last_hidden_state")];
    if (!tensor || !["float32", "float64"].includes(tensor.type)) throw new Error("Unsupported ONNX embedding output");
    const expectedDims = manifest.pooling === "sentence" ? [1, manifest.dimensions] : [1, ids.length, manifest.dimensions];
    if (JSON.stringify(tensor.dims) !== JSON.stringify(expectedDims)) throw new Error("ONNX output dimensions do not match the manifest");
    const vector = new Float32Array(manifest.dimensions);
    const count = manifest.pooling === "mean" ? ids.length : 1;
    let weight = 0;
    for (let token = 0; token < count; token++) {
      const active = manifest.pooling === "mean" ? mask[token] : 1;
      if (!active) continue;
      weight += active;
      for (let dim = 0; dim < vector.length; dim++) vector[dim] += tensor.data[token * vector.length + dim] * active;
    }
    if (!weight) throw new Error("Empty embedding attention mask");
    let norm = 0;
    for (let dim = 0; dim < vector.length; dim++) { vector[dim] /= weight; norm += vector[dim] ** 2; }
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || !norm) throw new Error("Model produced an invalid embedding");
    for (let dim = 0; dim < vector.length; dim++) vector[dim] /= norm;
    vectors.push(Array.from(vector));
  }
  return vectors;
}

// Serialize requests so rebuilding and interactive searches do not run competing
// sessions or concurrently replace the selected model.
let queue = Promise.resolve();
parentPort.on("message", job => {
  queue = queue.then(async () => {
    try { parentPort.postMessage({ id: job.id, vectors: await embed(job) }); }
    catch (error) { parentPort.postMessage({ id: job.id, error: error.message }); }
  });
});
