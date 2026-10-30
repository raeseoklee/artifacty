import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export const BUNDLED_MODEL_PATH = fileURLToPath(new URL("../../models/multilingual-e5-small/", import.meta.url));
const cache = new Map();
let worker;
let nextId = 0;
let idleTimer;
const pending = new Map();

export function readModelManifest(directory) {
  const root = realpathSync(directory);
  const text = readFileSync(path.join(root, "embedding-model.json"), "utf8");
  const manifest = JSON.parse(text);
  if (manifest.schemaVersion !== 1 || typeof manifest.id !== "string" || !manifest.id ||
      typeof manifest.license !== "string" || !manifest.license ||
      !Number.isInteger(manifest.dimensions) || manifest.dimensions < 1 || manifest.dimensions > 8192 ||
      !Number.isInteger(manifest.maxTokens) || manifest.maxTokens < 2 || manifest.maxTokens > 8192 ||
      !["mean", "cls", "sentence"].includes(manifest.pooling) || manifest.normalize !== true ||
      !Array.isArray(manifest.files) || !Array.isArray(manifest.model?.parts) || !manifest.model.parts.length) {
    throw new Error("Invalid embedding-model.json: expected a licensed, normalized sentence-embedding model manifest");
  }
  for (const key of ["queryPrefix", "documentPrefix"]) {
    if (typeof manifest[key] !== "string" || manifest[key].length > 256) throw new Error(`Invalid model ${key}`);
  }
  const entries = [...manifest.files, ...manifest.model.parts];
  const names = new Set();
  for (const entry of entries) {
    if (typeof entry.path !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(entry.path) || entry.path === "." || entry.path === ".." ||
        names.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 2_000_000_000) {
      throw new Error("Invalid model file path, size or SHA-256");
    }
    names.add(entry.path);
  }
  if (!manifest.files.some(file => file.path === "tokenizer.json") || !manifest.files.some(file => file.path === "tokenizer_config.json") ||
      !/^[a-f0-9]{64}$/.test(manifest.model.sha256) ||
      manifest.model.size !== manifest.model.parts.reduce((total, part) => total + part.size, 0) || manifest.model.size > 2_000_000_000) {
    throw new Error("Invalid model weights or tokenizer manifest");
  }
  const digest = createHash("sha256").update(text).digest("hex");
  return { root, manifest, digest };
}

export function createLocalEmbeddingProvider(config = {}) {
  const directory = config.ARTIFACTY_EMBEDDINGS_LOCAL_PATH?.trim() || BUNDLED_MODEL_PATH;
  // Cache configuration, not inferred vectors or artifact text.
  const { root, manifest, digest } = readModelManifest(directory);
  const key = `${root}:${digest}`;
  if (cache.has(key)) return cache.get(key);
  const provider = {
    name: "local-onnx",
    model: `${manifest.id}@${digest}`,
    dimensions: manifest.dimensions,
    local: { id: manifest.id, revision: manifest.revision || null, license: manifest.license, path: root, bundled: root === realpathSync(BUNDLED_MODEL_PATH), maxTokens: manifest.maxTokens },
    async embed(texts, { purpose = "document" } = {}) {
      const inputs = Array.isArray(texts) ? texts : [texts];
      if (!inputs.length) return [];
      if (inputs.length > 64 || inputs.some(text => typeof text !== "string" || text.length > 1_000_000)) throw new Error("Local embedding input exceeds limits");
      if (!["query", "document"].includes(purpose)) throw new Error("Invalid embedding purpose");
      return infer({ root, digest, inputs, purpose });
    }
  };
  // Avoid retaining arbitrary model configurations for the process lifetime.
  if (cache.size >= 8) cache.delete(cache.keys().next().value);
  cache.set(key, provider);
  return provider;
}

function failAll(error, target = worker) {
  if (target !== worker) return;
  worker = undefined;
  clearTimeout(idleTimer);
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); }
  pending.clear();
  target?.terminate().catch(() => {});
}

function infer(job) {
  if (pending.size >= 64) return Promise.reject(new Error("Local embedding queue is full; rebuild the index when idle"));
  if (!worker) {
    const target = new Worker(new URL("./local-embeddings-worker.js", import.meta.url));
    worker = target;
    target.on("message", ({ id, vectors, error }) => {
      if (target !== worker) return;
      const task = pending.get(id);
      if (!task) return;
      pending.delete(id);
      clearTimeout(task.timer);
      if (error) task.reject(new Error(error)); else task.resolve(vectors.map(vector => Float32Array.from(vector)));
      if (!pending.size) {
        target.unref();
        idleTimer = setTimeout(() => {
          if (worker === target && !pending.size) {
            worker = undefined;
            target.terminate().catch(() => {});
          }
        }, 60_000);
        idleTimer.unref();
      }
    });
    target.on("error", error => failAll(error, target));
    target.on("exit", () => failAll(new Error("Local embedding worker exited"), target));
  }
  clearTimeout(idleTimer);
  worker.ref();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    // Includes queue time and cold model initialization. A stalled inference call
    // cannot keep HTTP or CLI requests waiting indefinitely.
    const timer = setTimeout(() => failAll(new Error("Local embedding inference timed out")), 120_000);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ ...job, id });
  });
}

export async function closeLocalEmbeddingWorker() {
  if (pending.size) throw new Error("Cannot close local embedding worker while requests are pending");
  const target = worker;
  clearTimeout(idleTimer);
  worker = undefined;
  if (target) await target.terminate();
}
