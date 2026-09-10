// `artifacty watch` coverage (roadmap section 18).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { createArtifact } from "../src/lib/storage.js";

function runCli(args, env) {
  const child = spawn(process.execPath, ["src/cli.js", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  return {
    child,
    waitForExit: () => new Promise((resolve) => {
      child.on("exit", (code) => resolve({ code, stdout: () => stdout, stderr: () => stderr }));
    }),
    stdout: () => stdout,
    stderr: () => stderr
  };
}

// `artifacty watch` writes a deterministic ready marker to stderr once its
// SSE subscription is actually live (after the server's ": connected"
// frame), so tests can wait for that instead of sleeping and hoping the
// subscription beat the publish below.
//
// The deadlines below are liveness guards, not performance assertions: every
// step here waits on a real spawned process, and on a loaded Windows runner a
// Node boot alone can take seconds. They are generous on purpose so a genuine
// hang still fails loudly while ordinary scheduling jitter does not.
const READY_TIMEOUT_MS = 20000;
const EXIT_TIMEOUT_MS = 30000;
const EXEC_OUTPUT_TIMEOUT_MS = 15000;

// Races `promise` against a deadline, then clears the timer. Without the
// clear, the pending setTimeout keeps the event loop alive and every test
// file here runs for the full deadline even after its assertions pass.
async function withDeadline(promise, timeoutMs, describe) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(describe())), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function waitForReady(run, { json = false, timeoutMs = READY_TIMEOUT_MS } = {}) {
  const marker = json ? "\"ready\":true" : "# connected";
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (run.stderr().includes(marker)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`watch did not report ready in time. stderr:\n${run.stderr()}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

test("artifacty watch --once --json prints the first matching event and exits 0", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-watch-"));
  const app = await startServer({ port: 0, home });
  try {
    const run = runCli(["watch", "--once", "--json"], { ARTIFACTY_URL: app.url, ARTIFACTY_HOME: home });

    await waitForReady(run, { json: true });
    const artifact = await createArtifact(app.store, { title: "Watched", content: "hello", sourceAgent: "test" });

    const result = await withDeadline(
      run.waitForExit(),
      EXIT_TIMEOUT_MS,
      () => `watch did not exit. stdout:\n${run.stdout()}\nstderr:\n${run.stderr()}`
    );

    assert.equal(result.code, 0);
    const lines = result.stdout().trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.type, "artifact.created");
    assert.equal(event.artifactId, artifact.id);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifacty watch --exec runs the command with event JSON on stdin and ARTIFACTY_EVENT_* env vars", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-watch-"));
  const app = await startServer({ port: 0, home });
  const outFile = path.join(home, "exec-output.json");
  try {
    // A tiny inline Node script that records stdin + the env vars it saw.
    const scriptPath = path.join(home, "record.mjs");
    await writeFile(scriptPath, `
      import { readFileSync, writeFileSync } from "node:fs";
      const stdin = readFileSync(0, "utf8");
      writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
        stdin,
        type: process.env.ARTIFACTY_EVENT_TYPE,
        artifactId: process.env.ARTIFACTY_EVENT_ARTIFACT_ID,
        version: process.env.ARTIFACTY_EVENT_VERSION
      }));
    `, "utf8");

    const run = runCli(["watch", "--once", "--exec", `${process.execPath} ${scriptPath}`], {
      ARTIFACTY_URL: app.url,
      ARTIFACTY_HOME: home
    });

    await waitForReady(run);
    const artifact = await createArtifact(app.store, { title: "Exec Demo", content: "hi", sourceAgent: "test" });

    await withDeadline(
      run.waitForExit(),
      EXIT_TIMEOUT_MS,
      () => `watch did not exit. stdout:\n${run.stdout()}\nstderr:\n${run.stderr()}`
    );

    // The child process writes its file asynchronously relative to the
    // parent watch process exiting; poll briefly for it.
    let recorded = null;
    const deadline = Date.now() + EXEC_OUTPUT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        recorded = JSON.parse(await readFile(outFile, "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(recorded, "expected --exec to have written the output file");
    assert.equal(recorded.type, "artifact.created");
    assert.equal(recorded.artifactId, artifact.id);
    assert.equal(recorded.version, "1");
    const stdinEvent = JSON.parse(recorded.stdin);
    assert.equal(stdinEvent.artifactId, artifact.id);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
