import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildServerArgs, stopCommandForPlatform } from "../src/lib/background.js";

test("builds portable detached server arguments", () => {
  const store = { home: path.join("tmp", "artifacty home") };
  const args = buildServerArgs({
    serverPath: path.join("src", "server.js"),
    host: "127.0.0.1",
    port: 8787,
    shareMode: "lan",
    bytes: 16,
    generateToken: true,
    allowSecrets: true
  }, store);

  assert.deepEqual(args, [
    path.join("src", "server.js"),
    "--host",
    "127.0.0.1",
    "--port",
    "8787",
    "--home",
    store.home,
    "--share-mode",
    "lan",
    "--bytes",
    "16",
    "--generate-token",
    "--allow-secrets"
  ]);
});

test("uses taskkill only for Windows stop handling", () => {
  assert.equal(stopCommandForPlatform(1234, {}, "linux"), null);
  assert.equal(stopCommandForPlatform(1234, {}, "darwin"), null);
  assert.deepEqual(stopCommandForPlatform(1234, {}, "win32"), {
    command: "taskkill",
    args: ["/PID", "1234", "/T"]
  });
  assert.deepEqual(stopCommandForPlatform(1234, { force: true }, "win32"), {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
});
