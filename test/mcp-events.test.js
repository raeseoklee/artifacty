// resources/subscribe -> notifications/resources/updated, and the
// artifacty_wait long-poll tool (roadmap section 3). Uses
// createMcpJsonRpcHandler directly with an injected `notify` so it does not
// need to parse a spawned child's stdout for unsolicited notification
// lines.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createArtifact, createStore, updateArtifact } from "../src/lib/storage.js";
import { createMcpJsonRpcHandler } from "../src/mcp-server.js";

async function callTool(handler, name, args, id) {
  return handler({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

test("resources/subscribe on artifacty://artifacts/{id} delivers notifications/resources/updated for that artifact only", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-events-"));
  try {
    const store = createStore({ home });
    const artifact = await createArtifact(store, { title: "One", content: "1", sourceAgent: "test" });
    const other = await createArtifact(store, { title: "Other", content: "1", sourceAgent: "test" });

    const notifications = [];
    const handler = createMcpJsonRpcHandler({ store, transport: "stdio", notify: (message) => notifications.push(message) });

    const subscribeResponse = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/subscribe",
      params: { uri: `artifacty://artifacts/${artifact.id}` }
    });
    assert.equal(subscribeResponse.error, undefined);

    await updateArtifact(store, other.id, { content: "2", sourceAgent: "test" });
    await updateArtifact(store, artifact.id, { content: "2", sourceAgent: "test" });
    await new Promise((resolve) => setImmediate(resolve));

    const updates = notifications.filter((n) => n.method === "notifications/resources/updated");
    assert.equal(updates.length, 1, `expected exactly one notification, got: ${JSON.stringify(notifications)}`);
    assert.equal(updates[0].params.uri, `artifacty://artifacts/${artifact.id}`);

    await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/unsubscribe",
      params: { uri: `artifacty://artifacts/${artifact.id}` }
    });
    await updateArtifact(store, artifact.id, { content: "3", sourceAgent: "test" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notifications.filter((n) => n.method === "notifications/resources/updated").length, 1, "no further notifications after unsubscribe");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("resources/subscribe on artifacty://recent delivers notifications for any artifact", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-events-"));
  try {
    const store = createStore({ home });
    const notifications = [];
    const handler = createMcpJsonRpcHandler({ store, transport: "stdio", notify: (message) => notifications.push(message) });

    await handler({ jsonrpc: "2.0", id: 1, method: "resources/subscribe", params: { uri: "artifacty://recent" } });
    await createArtifact(store, { title: "New", content: "1", sourceAgent: "test" });
    await new Promise((resolve) => setImmediate(resolve));

    const updates = notifications.filter((n) => n.method === "notifications/resources/updated");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].params.uri, "artifacty://recent");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifacty_wait returns the first matching event", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-events-"));
  try {
    const store = createStore({ home });
    const artifact = await createArtifact(store, { title: "One", content: "1", sourceAgent: "test" });
    const handler = createMcpJsonRpcHandler({ store, transport: "stdio" });

    const waitPromise = callTool(handler, "artifacty_wait", { artifactId: artifact.id, timeoutMs: 5000 }, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await updateArtifact(store, artifact.id, { content: "2", sourceAgent: "test" });

    const response = await waitPromise;
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.timedOut, false);
    assert.equal(response.result.structuredContent.event.type, "artifact.updated");
    assert.equal(response.result.structuredContent.event.artifactId, artifact.id);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifacty_wait returns { timedOut: true } when nothing matches within timeoutMs", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-events-"));
  try {
    const store = createStore({ home });
    const handler = createMcpJsonRpcHandler({ store, transport: "stdio" });
    const response = await callTool(handler, "artifacty_wait", { artifactId: "nonexistent", timeoutMs: 100 }, 1);
    assert.deepEqual(response.result.structuredContent, { timedOut: true });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
