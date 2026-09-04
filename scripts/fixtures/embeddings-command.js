#!/usr/bin/env node
// Deterministic fixture "embeddings" command used by test/embeddings.test.js,
// test/doctor.test.js, test/cli.test.js, test/server.test.js, and
// test/mcp-server.test.js. Reads one JSON line per text on stdin
// (`{ "text": "..." }`) and writes one JSON line per vector on stdout
// (`{ "embedding": [...] }`), matching the `command` provider protocol
// described in src/lib/embeddings.js.
//
// The vector is a simple 8-dimensional character-frequency histogram, so
// texts that share more characters score higher on cosine similarity while
// staying fully deterministic across runs and platforms.
//
// Deliberately lives under scripts/fixtures/, not test/fixtures/: node
// --test's default glob treats every .js file inside a directory literally
// named "test" as a test file. This script isn't one — it reads from stdin
// and never calls into node:test — so if the runner picked it up it would
// hang forever waiting for stdin to close, stalling the whole suite.

const DIMENSIONS = 8;

function embed(text) {
  const vector = new Array(DIMENSIONS).fill(0);
  for (const char of String(text || "")) {
    const code = char.toLowerCase().codePointAt(0) || 0;
    vector[code % DIMENSIONS] += 1;
  }
  return vector;
}

process.stdin.setEncoding("utf8");
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk;
});

process.stdin.on("end", () => {
  const lines = buffer.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    process.stdout.write(`${JSON.stringify({ embedding: embed(parsed.text) })}\n`);
  }
});
