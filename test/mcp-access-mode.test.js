import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createArtifact, createStore, createUser, setAccessMode,
  setArtifactSharing, updateArtifact
} from "../src/lib/storage.js";
import { createMcpJsonRpcHandler } from "../src/mcp-server.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("private mode MCP reads and live notifications follow grants and revocation", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-access-"));
  let handler;
  let nextId = 0;
  const rpc = (method, params) => handler({ jsonrpc: "2.0", id: ++nextId, method, params });
  const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
  try {
    const store = createStore({ home });
    const admin = await createUser(store, { email: "admin@example.com", password: "password-123", role: "admin" });
    const reader = await createUser(store, { email: "reader@example.com", password: "password-123", role: "user" });
    const access = { userId: admin.id, role: "admin", anonymous: false };
    const artifact = await createArtifact(store, { title: "Restricted", content: "original", audit: { userId: admin.id } });
    await setAccessMode(store, "private", { access });
    const anonymous = createMcpJsonRpcHandler({ store });
    for (const name of ["artifacty_create", "artifacty_import"]) {
      const denied = await anonymous({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: { title: "Anonymous", content: "denied", agent: "generic" } } });
      assert.equal(denied.result.isError, true, name);
    }
    const notifications = [];
    handler = createMcpJsonRpcHandler({ store, auth: { type: "personal-token", user: reader }, notify: (message) => notifications.push(message) });
    assert.equal((await call("artifacty_get", { id: artifact.id })).result.isError, true);
    assert.equal((await call("artifacty_list")).result.structuredContent.artifacts.length, 0);
    await rpc("resources/subscribe", { uri: "artifacty://recent" });
    await updateArtifact(store, artifact.id, { content: "not shared" });
    await tick();
    assert.equal(notifications.length, 0);

    await setArtifactSharing(store, artifact.id, { userIds: [reader.id], teamIds: [] }, { access });
    assert.equal((await call("artifacty_get", { id: artifact.id })).result.isError, false);
    assert.equal((await call("artifacty_update", { id: artifact.id, content: "unauthorized edit" })).result.isError, true);
    const waiting = call("artifacty_wait", { artifactId: artifact.id, timeoutMs: 1000 });
    await tick();
    await updateArtifact(store, artifact.id, { content: "shared update" });
    assert.equal((await waiting).result.structuredContent.event.artifactId, artifact.id);
    await tick();
    assert.equal(notifications.length, 1);

    await setArtifactSharing(store, artifact.id, { userIds: [], teamIds: [] }, { access });
    const deniedWait = call("artifacty_wait", { artifactId: artifact.id, timeoutMs: 100 });
    await tick();
    await updateArtifact(store, artifact.id, { content: "revoked update" });
    assert.deepEqual((await deniedWait).result.structuredContent, { timedOut: true });
    assert.equal(notifications.length, 1);
    assert.equal((await call("artifacty_get", { id: artifact.id })).result.isError, true);
  } finally {
    if (handler) await rpc("resources/unsubscribe", { uri: "artifacty://recent" });
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
