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
    await rm(home, { recursive: true, force: true });
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
    await rm(home, { recursive: true, force: true });
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
    await rm(home, { recursive: true, force: true });
  }
});
