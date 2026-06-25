import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("generates API tokens from the CLI", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["src/cli.js", "token"]);
  const result = JSON.parse(stdout);

  assert.equal(result.bytes, 32);
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(result.env, /^ARTIFACTY_API_TOKEN="/);
  assert.equal(result.header, `x-artifacty-token: ${result.token}`);
  assert.equal(result.authorization, `Authorization: Bearer ${result.token}`);
});

test("generates configurable token sizes", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["src/cli.js", "token", "--bytes", "48"]);
  const result = JSON.parse(stdout);

  assert.equal(result.bytes, 48);
  assert.match(result.token, /^[A-Za-z0-9_-]{64}$/);
});

test("prints raw token for shell usage", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["src/cli.js", "token", "--raw"]);
  assert.match(stdout.trim(), /^[A-Za-z0-9_-]{43}$/);
});

test("rejects unsafe token byte sizes", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["src/cli.js", "token", "--bytes", "8"]),
    /--bytes must be an integer between 16 and 128/
  );
});

test("serve can generate and enforce a startup API token", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-"));
  const child = spawn(process.execPath, [
    "src/cli.js",
    "serve",
    "--port",
    "0",
    "--home",
    home,
    "--generate-token"
  ], {
    stdio: ["ignore", "ignore", "pipe"]
  });

  try {
    const stderr = await waitForStderr(child, (output) => output.includes("Import URL:"));
    const url = /Artifacty listening on (http:\/\/[^\s]+)/.exec(stderr)?.[1];
    const token = /API token: ([A-Za-z0-9_-]+)/.exec(stderr)?.[1];

    assert.ok(url);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(stderr, new RegExp(`Create URL: ${escapeRegExp(url)}/new\\?token=${escapeRegExp(token)}`));
    assert.match(stderr, new RegExp(`Import URL: ${escapeRegExp(url)}/import\\?token=${escapeRegExp(token)}`));

    const unauthorized = await fetch(`${url}/api/artifacts`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${url}/api/artifacts`, {
      headers: {
        "x-artifacty-token": token
      }
    });
    assert.equal(authorized.status, 200);
  } finally {
    await stopProcess(child);
    await rm(home, { recursive: true, force: true });
  }
});

test("serve rejects conflicting token options", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["src/cli.js", "serve", "--api-token", "configured", "--generate-token"]),
    /Use either --api-token or --generate-token, not both/
  );
});

test("starts, reports, and stops a background server", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-background-"));
  try {
    const start = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "start",
      "--port",
      "0",
      "--home",
      home
    ])).stdout);

    assert.equal(start.running, true);
    assert.equal(start.home, home);
    assert.match(start.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${start.url}/health`)).status, 200);

    const status = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "status",
      "--home",
      home
    ])).stdout);
    assert.equal(status.running, true);
    assert.equal(status.managed, true);
    assert.equal(status.pid, start.pid);
    assert.equal(status.url, start.url);

    const stop = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "stop",
      "--home",
      home
    ])).stdout);
    assert.equal(stop.stopped, true);
    assert.equal(stop.running, false);

    const stopped = JSON.parse((await execFileAsync(process.execPath, [
      "src/cli.js",
      "status",
      "--home",
      home
    ])).stdout);
    assert.equal(stopped.running, false);
    assert.equal(stopped.managed, false);
  } finally {
    await execFileAsync(process.execPath, ["src/cli.js", "stop", "--home", home]).catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});

test("imports media files as base64 artifacts", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-cli-media-"));
  try {
    const pngBytes = Buffer.from("89504e470d0a", "hex");
    const pngPath = path.join(home, "screenshot.png");
    await writeFile(pngPath, pngBytes);

    const { stdout } = await execFileAsync(process.execPath, [
      "src/cli.js",
      "import",
      "--home",
      home,
      "--agent",
      "cursor",
      "--file",
      pngPath
    ]);
    const imported = JSON.parse(stdout);

    assert.equal(imported.version.format, "image");
    assert.equal(imported.version.contentType, "image/png");
    assert.equal(imported.artifactType, "asset");
    assert.equal(imported.content, pngBytes.toString("base64"));
    assert.equal(imported.version.metadata.mimeType, "image/png");
    assert.equal(imported.version.metadata.encoding, "base64");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("server entrypoint can generate and enforce a startup API token", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "artifacty-server-"));
  const child = spawn(process.execPath, [
    "src/server.js",
    "--port",
    "0",
    "--home",
    home,
    "--generate-token",
    "--bytes",
    "16"
  ], {
    stdio: ["ignore", "ignore", "pipe"]
  });

  try {
    const stderr = await waitForStderr(child, (output) => output.includes("Import URL:"));
    const url = /Artifacty listening on (http:\/\/[^\s]+)/.exec(stderr)?.[1];
    const token = /API token: ([A-Za-z0-9_-]+)/.exec(stderr)?.[1];

    assert.ok(url);
    assert.match(token, /^[A-Za-z0-9_-]{22}$/);

    const unauthorized = await fetch(`${url}/api/artifacts`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${url}/api/artifacts`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(authorized.status, 200);
  } finally {
    await stopProcess(child);
    await rm(home, { recursive: true, force: true });
  }
});

function waitForStderr(child, predicate) {
  let output = "";
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for stderr. Output:\n${output}`));
    }, 5000);

    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (predicate(output)) {
        cleanup();
        resolve(output);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Process exited before expected output: code=${code} signal=${signal}\n${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };

    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await once(child, "exit");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
