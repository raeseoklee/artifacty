// Pluggable embedding providers for semantic search (roadmap section 6).
//
// No provider is bundled or required: createEmbeddingProvider() returns null
// when no provider is configured through the environment, and every caller
// in this codebase treats a null provider as "fall back to keyword search."
//
// Two providers are supported in v1:
//   - "openai-compatible": POSTs { model, input: texts } to
//     `${ARTIFACTY_EMBEDDINGS_URL}/embeddings` and reads `data[].embedding`,
//     the shape used by OpenAI and most self-hosted OpenAI-compatible
//     embedding servers.
//   - "command": spawns ARTIFACTY_EMBEDDINGS_COMMAND, writes one JSON line
//     per text (`{ "text": "..." }`) to its stdin, and reads one JSON line
//     per vector (`{ "embedding": [...] }`) from its stdout. This lets users
//     wire in Ollama or any local model without Artifacty depending on it.
//
// The API key (ARTIFACTY_EMBEDDINGS_API_KEY) is read from the environment
// only. It is never logged, never included in error messages, and never
// persisted to the store.

import { spawn } from "node:child_process";
import { metadataSearchText } from "./storage.js";

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_COMMAND_MODEL = "command";

// Returns a provider object, or null when no embedding provider is
// configured. `config` defaults to process.env but accepts a plain object so
// callers (and tests) can configure a provider without mutating the real
// environment.
export function createEmbeddingProvider(config = process.env) {
  const command = normalizeString(config.ARTIFACTY_EMBEDDINGS_COMMAND);
  if (command) {
    return createCommandProvider(command, config);
  }
  const url = normalizeString(config.ARTIFACTY_EMBEDDINGS_URL);
  if (url) {
    return createOpenAiCompatibleProvider(url, config);
  }
  return null;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Converts a raw embedding array into a Float32Array, but only when every
// element is a finite number. A malformed/hostile embeddings endpoint or
// command can otherwise smuggle in NaN/Infinity, which makes
// cosineSimilarity return NaN and the results sort comparator inconsistent.
// Returns null for anything that doesn't validate so the caller can skip
// that row (see the `!vector || !vector.length` checks in storage.js).
function toFiniteVector(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const floats = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    floats[index] = value;
  }
  return floats;
}

function createOpenAiCompatibleProvider(url, config) {
  const baseUrl = url.replace(/\/+$/, "");
  const model = normalizeString(config.ARTIFACTY_EMBEDDINGS_MODEL) || DEFAULT_OPENAI_MODEL;
  const apiKey = normalizeString(config.ARTIFACTY_EMBEDDINGS_API_KEY);
  let dimensions = null;

  return {
    name: "openai-compatible",
    model,
    get dimensions() {
      return dimensions;
    },
    async embed(texts) {
      const inputs = Array.isArray(texts) ? texts : [texts];
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({ model, input: inputs })
      });
      if (!response.ok) {
        // Never include the request body/headers (which could carry the key)
        // in the error message; only the response status and a bounded
        // excerpt of the response body.
        const bodyText = await response.text().catch(() => "");
        throw new Error(`Embeddings request failed with status ${response.status}: ${bodyText.slice(0, 200)}`);
      }
      const parsed = await response.json();
      const rows = Array.isArray(parsed?.data) ? parsed.data : [];
      const vectors = rows
        .slice()
        .sort((a, b) => (Number(a?.index) || 0) - (Number(b?.index) || 0))
        .map((row) => toFiniteVector(Array.isArray(row?.embedding) ? row.embedding : null));
      const firstValid = vectors.find((vector) => vector && vector.length);
      if (firstValid) {
        dimensions = firstValid.length;
      }
      return vectors;
    }
  };
}

function createCommandProvider(command, config) {
  const model = normalizeString(config.ARTIFACTY_EMBEDDINGS_MODEL) || DEFAULT_COMMAND_MODEL;
  let dimensions = null;
  const argv = parseCommandArgv(command);
  const env = minimalEmbeddingsEnv(config);
  // Read from the caller's full config, not the minimal spawn env above —
  // ARTIFACTY_EMBEDDINGS_TIMEOUT_MS is an operator setting, not something
  // the child process should see or need.
  const timeoutMs = commandTimeoutMs(config);

  return {
    name: "command",
    model,
    get dimensions() {
      return dimensions;
    },
    async embed(texts) {
      const inputs = Array.isArray(texts) ? texts : [texts];
      const vectors = await runCommandEmbeddings(argv, env, inputs, timeoutMs);
      const firstValid = vectors.find((vector) => vector && vector.length);
      if (firstValid) {
        dimensions = firstValid.length;
      }
      return vectors;
    }
  };
}

// Splits an operator-supplied command string into argv, supporting simple
// single- and double-quoted segments and backslash escapes, so the command
// can be spawned directly (shell: false) instead of being handed to /bin/sh.
// This is deliberately not a full shell grammar (no pipes, redirection, or
// variable expansion) — ARTIFACTY_EMBEDDINGS_COMMAND is expected to name one
// executable plus its arguments.
export function parseCommandArgv(command) {
  const argv = [];
  let current = "";
  let hasCurrent = false;
  let quote = null;
  const text = String(command || "");

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === "\"" && index + 1 < text.length) {
        index += 1;
        current += text[index];
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      hasCurrent = true;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      current += text[index];
      hasCurrent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasCurrent) {
        argv.push(current);
        current = "";
        hasCurrent = false;
      }
      continue;
    }
    current += char;
    hasCurrent = true;
  }
  if (hasCurrent) {
    argv.push(current);
  }
  return argv;
}

// Builds a minimal environment for the embeddings command child process:
// enough for a normal executable to run (PATH/HOME/LANG) plus any
// ARTIFACTY_EMBEDDINGS_* configuration the provider itself may want to read
// (e.g. a model name), but never the API key or the rest of the server's
// environment (which could carry ARTIFACTY_API_TOKEN and other secrets).
export function minimalEmbeddingsEnv(config = process.env) {
  const env = {};
  // PATH/HOME/LANG aren't secrets, and a spawned executable normally needs
  // PATH to be found at all, so these three fall back to the real process
  // environment when the caller's config object doesn't specify them
  // (e.g. a config assembled from just a handful of ARTIFACTY_EMBEDDINGS_*
  // values, not the process's actual env).
  for (const key of ["PATH", "HOME", "LANG"]) {
    const value = typeof config[key] === "string" ? config[key] : process.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  for (const key of Object.keys(config)) {
    if (
      key.startsWith("ARTIFACTY_EMBEDDINGS_") &&
      key !== "ARTIFACTY_EMBEDDINGS_API_KEY" &&
      typeof config[key] === "string"
    ) {
      env[key] = config[key];
    }
  }
  return env;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
// Bounds accumulated stdout so a runaway or misbehaving embeddings command
// cannot exhaust process memory before we ever get to parse its output.
const COMMAND_STDOUT_MAX_BYTES = 8 * 1024 * 1024;

function commandTimeoutMs(config) {
  const parsed = Number.parseInt(config?.ARTIFACTY_EMBEDDINGS_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COMMAND_TIMEOUT_MS;
}

function runCommandEmbeddings(argv, env, texts, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!argv.length) {
      reject(new Error("ARTIFACTY_EMBEDDINGS_COMMAND did not resolve to an executable"));
      return;
    }
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { shell: false, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      fn(value);
    };

    const timeoutTimer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error(`Embeddings command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.stdout.on("data", (chunk) => {
      if (stdoutTruncated) {
        return;
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > COMMAND_STDOUT_MAX_BYTES) {
        stdoutTruncated = true;
        child.kill("SIGKILL");
        finish(reject, new Error(`Embeddings command exceeded ${COMMAND_STDOUT_MAX_BYTES} bytes of output`));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish(reject, error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        finish(reject, new Error(`Embeddings command exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
        return;
      }
      try {
        const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
        const vectors = lines.map((line) => {
          const parsedLine = JSON.parse(line);
          return toFiniteVector(Array.isArray(parsedLine?.embedding) ? parsedLine.embedding : null);
        });
        finish(resolve, vectors);
      } catch (error) {
        finish(reject, new Error(`Failed to parse embeddings command output: ${error.message}`));
      }
    });

    try {
      for (const text of texts) {
        child.stdin.write(`${JSON.stringify({ text: String(text ?? "") })}\n`);
      }
      child.stdin.end();
    } catch (error) {
      finish(reject, error);
    }
  });
}

// Cosine similarity between two vectors. Returns 0 when either vector has
// zero magnitude (rather than NaN) so callers can sort without filtering.
export function cosineSimilarity(a, b) {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Serializes a Float32Array (or plain array of numbers) into a little-endian
// Buffer suitable for a SQLite BLOB column.
export function vectorToBlob(vector) {
  const floats = vector instanceof Float32Array ? vector : Float32Array.from(vector || []);
  const buffer = Buffer.alloc(floats.length * 4);
  for (let index = 0; index < floats.length; index += 1) {
    buffer.writeFloatLE(floats[index], index * 4);
  }
  return buffer;
}

// Inverse of vectorToBlob: reads a little-endian Float32 BLOB back into a
// Float32Array.
export function blobToVector(blob) {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const length = Math.floor(buffer.length / 4);
  const floats = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    floats[index] = buffer.readFloatLE(index * 4);
  }
  return floats;
}

// Builds the text that gets embedded for an artifact: title + tags +
// metadata summary + up to maxChars characters of content. Binary formats
// (image, video) omit content and embed metadata only, since their content
// field is base64 payload rather than natural-language text.
const BINARY_EMBEDDING_FORMATS = new Set(["image", "video"]);

export function embeddingTextForArtifact(artifact = {}, content = "", maxChars = 8000) {
  const parts = [];
  const title = typeof artifact.title === "string" ? artifact.title.trim() : "";
  if (title) {
    parts.push(title);
  }
  if (Array.isArray(artifact.tags) && artifact.tags.length) {
    parts.push(artifact.tags.join(" "));
  }
  const metadataSummary = metadataSearchText(artifact.metadata, 2000);
  if (metadataSummary) {
    parts.push(metadataSummary);
  }
  const isBinary = BINARY_EMBEDDING_FORMATS.has(artifact.format);
  if (!isBinary && typeof content === "string" && content) {
    const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 8000;
    parts.push(content.slice(0, limit));
  }
  return parts.join("\n\n").trim();
}

// Reciprocal rank fusion: merges several ranked id lists into one ranking by
// summing 1 / (k + rank) across every list an id appears in. Deterministic
// for a given input order (ties keep the order ids first appear across the
// rankings, since Map preserves insertion order and Array#sort is stable).
export function reciprocalRankFusion(rankings, k = 60) {
  const scores = new Map();
  for (const ranking of rankings || []) {
    (ranking || []).forEach((id, index) => {
      const rank = index + 1;
      const contribution = 1 / (k + rank);
      scores.set(id, (scores.get(id) || 0) + contribution);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }));
}
