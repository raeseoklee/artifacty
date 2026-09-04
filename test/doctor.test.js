import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runDoctor } from "../src/lib/doctor.js";

const execFileAsync = promisify(execFile);

test("doctor reports local runtime, storage, service, and skipped MCP checks", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-doctor-"));
  try {
    const result = await runDoctor({
      packageRoot: process.cwd(),
      home,
      skipMcp: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.home, home);
    assert.ok(result.version);
    assert.equal(result.failures.length, 0);
    assert.ok(result.warnings.some((warning) => warning.name === "server"));
    assert.equal(result.checks.find((check) => check.name === "runtime").status, "pass");
    assert.equal(result.checks.find((check) => check.name === "storage").status, "pass");
    assert.equal(result.checks.find((check) => check.name === "service").status, "pass");
    assert.equal(result.checks.find((check) => check.name === "mcp").status, "skip");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("doctor fails unsafe non-local exposure settings", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-doctor-unsafe-"));
  try {
    const result = await runDoctor({
      packageRoot: process.cwd(),
      home,
      host: "0.0.0.0",
      skipMcp: true
    });

    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.name === "security"));
    assert.equal(result.checks.find((check) => check.name === "security").status, "fail");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("doctor reports no embedding provider configured by default", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-doctor-no-embeddings-"));
  try {
    const result = await runDoctor({ packageRoot: process.cwd(), home, skipMcp: true });
    const check = result.checks.find((entry) => entry.name === "embeddings");
    assert.equal(check.status, "pass");
    assert.equal(check.data.configured, false);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("doctor reports the openai-compatible provider with the API key redacted", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-doctor-embeddings-openai-"));
  const previous = {
    url: process.env.ARTIFACTY_EMBEDDINGS_URL,
    model: process.env.ARTIFACTY_EMBEDDINGS_MODEL,
    apiKey: process.env.ARTIFACTY_EMBEDDINGS_API_KEY
  };
  try {
    process.env.ARTIFACTY_EMBEDDINGS_URL = "https://api.example.com/v1";
    process.env.ARTIFACTY_EMBEDDINGS_MODEL = "text-embedding-3-small";
    process.env.ARTIFACTY_EMBEDDINGS_API_KEY = "sk-super-secret-value-1234";

    const result = await runDoctor({ packageRoot: process.cwd(), home, skipMcp: true });
    const check = result.checks.find((entry) => entry.name === "embeddings");
    assert.equal(check.status, "pass");
    assert.equal(check.data.configured, true);
    assert.equal(check.data.provider, "openai-compatible");
    assert.equal(check.data.model, "text-embedding-3-small");
    assert.ok(!check.data.apiKey.includes("super-secret-value"));
    assert.ok(!JSON.stringify(result).includes("sk-super-secret-value-1234"));
  } finally {
    for (const [key, value] of Object.entries({
      ARTIFACTY_EMBEDDINGS_URL: previous.url,
      ARTIFACTY_EMBEDDINGS_MODEL: previous.model,
      ARTIFACTY_EMBEDDINGS_API_KEY: previous.apiKey
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("doctor reports the command provider without an API key field", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-doctor-embeddings-command-"));
  const previous = process.env.ARTIFACTY_EMBEDDINGS_COMMAND;
  try {
    process.env.ARTIFACTY_EMBEDDINGS_COMMAND = "node scripts/fixtures/embeddings-command.js";
    const result = await runDoctor({ packageRoot: process.cwd(), home, skipMcp: true });
    const check = result.checks.find((entry) => entry.name === "embeddings");
    assert.equal(check.data.configured, true);
    assert.equal(check.data.provider, "command");
    assert.equal(check.data.apiKey, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.ARTIFACTY_EMBEDDINGS_COMMAND;
    } else {
      process.env.ARTIFACTY_EMBEDDINGS_COMMAND = previous;
    }
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("doctor command prints JSON and exits successfully for warnings only", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-doctor-cli-"));
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      "src/cli.js",
      "doctor",
      "--home",
      home,
      "--skip-mcp"
    ]);
    const result = JSON.parse(stdout);

    assert.equal(result.ok, true);
    assert.equal(result.home, home);
    assert.ok(result.warnings.some((warning) => warning.name === "server"));
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
