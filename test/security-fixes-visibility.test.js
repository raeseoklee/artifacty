// Regression tests for the private-artifact visibility leaks fixed in the
// 2026-09 security review (findings H1-H4, M3).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addRelation,
  createApiToken,
  createArtifact,
  createStore,
  createUser,
  updateArtifact
} from "../src/lib/storage.js";
import { startServer } from "../src/server.js";
import { createMcpRequestHandler } from "../src/mcp-server.js";

async function withStore(fn) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-secfix-vis-"));
  try {
    await fn(createStore({ home }));
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function readUntil(reader, predicate, timeoutMs = 5000) {
  let buffer = "";
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), Math.max(remaining, 0)))
    ]);
    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }
    if (predicate(buffer)) {
      return buffer;
    }
    if (done) {
      break;
    }
  }
  return buffer;
}

test("H1: MCP resources/list omits another user's private artifacts", async () => {
  await withStore(async (store) => {
    const owner = await createUser(store, { email: "h1-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "h1-other@example.com", name: "Other", role: "user", password: "password-123" });

    const privateArtifact = await createArtifact(store, {
      title: "H1 Private Secret Plan",
      content: "secret",
      format: "text",
      visibility: "private",
      audit: { userId: owner.id, actor: owner.email }
    });

    const otherHandler = createMcpRequestHandler({
      store,
      auth: { user: other },
      auditContext: () => ({ surface: "mcp", actor: other.email, userId: other.id, publisherName: other.name })
    });

    const listed = await otherHandler({ method: "resources/list", params: {} });
    const uris = listed.resources.map((resource) => resource.uri);
    assert.ok(!uris.includes(`artifacty://artifacts/${privateArtifact.id}`), "private artifact resource must not be listed");
    assert.ok(!uris.includes(`artifacty://artifacts/${privateArtifact.id}/raw`), "private artifact raw resource must not be listed");
    assert.ok(!listed.resources.some((resource) => (resource.title || "").includes("H1 Private Secret Plan")));

    const ownerHandler = createMcpRequestHandler({
      store,
      auth: { user: owner },
      auditContext: () => ({ surface: "mcp", actor: owner.email, userId: owner.id, publisherName: owner.name })
    });
    const ownerListed = await ownerHandler({ method: "resources/list", params: {} });
    assert.ok(ownerListed.resources.some((resource) => resource.uri === `artifacty://artifacts/${privateArtifact.id}`));
  });
});

test("H2: MCP relation graph resource skips a restricted private neighbour", async () => {
  await withStore(async (store) => {
    const owner = await createUser(store, { email: "h2-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "h2-other@example.com", name: "Other", role: "user", password: "password-123" });

    const visibleArtifact = await createArtifact(store, {
      title: "H2 Team Root",
      content: "content",
      format: "text",
      visibility: "team",
      audit: { userId: other.id, actor: other.email }
    });
    const privateTarget = await createArtifact(store, {
      title: "H2 Private Neighbour",
      content: "content",
      format: "text",
      visibility: "private",
      audit: { userId: owner.id, actor: owner.email }
    });
    await addRelation(store, {
      fromId: visibleArtifact.id,
      toId: privateTarget.id,
      relation: "references",
      access: { userId: owner.id, role: "user" }
    });

    const otherHandler = createMcpRequestHandler({
      store,
      auth: { user: other },
      auditContext: () => ({ surface: "mcp", actor: other.email, userId: other.id, publisherName: other.name })
    });
    const graphResponse = await otherHandler({
      method: "resources/read",
      params: { uri: `artifacty://artifacts/${visibleArtifact.id}/graph` }
    });
    const graph = JSON.parse(graphResponse.contents[0].text);
    assert.ok(!graph.nodes.some((node) => node.id === privateTarget.id), "restricted neighbour must not appear as a node");
    assert.ok(!graph.edges.some((edge) => edge.to === privateTarget.id || edge.from === privateTarget.id));

    const ownerHandler = createMcpRequestHandler({
      store,
      auth: { user: owner },
      auditContext: () => ({ surface: "mcp", actor: owner.email, userId: owner.id, publisherName: owner.name })
    });
    const ownerGraphResponse = await ownerHandler({
      method: "resources/read",
      params: { uri: `artifacty://artifacts/${visibleArtifact.id}/graph` }
    });
    const ownerGraph = JSON.parse(ownerGraphResponse.contents[0].text);
    assert.ok(ownerGraph.nodes.some((node) => node.id === privateTarget.id), "owner should still see the neighbour");
  });
});

test("H3: audit log hides private artifact events for a non-owner over HTTP and MCP", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-secfix-audit-"));
  const app = await startServer({ port: 0, home });
  const store = createStore({ home });
  try {
    const owner = await createUser(store, { email: "h3-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "h3-other@example.com", name: "Other", role: "user", password: "password-123" });
    const ownerToken = (await createApiToken(store, owner.id, { name: "Owner", scopes: ["read", "write"] })).token;
    const otherToken = (await createApiToken(store, other.id, { name: "Other", scopes: ["read", "write"] })).token;

    const createResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "x-artifacty-token": ownerToken, "content-type": "application/json" },
      body: JSON.stringify({ title: "H3 Confidential Roadmap", content: "secret", format: "text", visibility: "private" })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();

    // Whole-log listing must not include the private artifact's row.
    const wholeLogResponse = await fetch(`${app.url}/api/audit`, { headers: { "x-artifacty-token": otherToken } });
    const wholeLog = await wholeLogResponse.json();
    assert.ok(!wholeLog.events.some((event) => event.artifactId === created.id), "private artifact must not appear in the whole audit log");
    assert.ok(!wholeLog.events.some((event) => JSON.stringify(event.metadata || {}).includes("H3 Confidential Roadmap")));

    // Directly filtering by the private artifact's id must not disclose its
    // existence either (defeats the 404-not-403 existence-hiding design).
    const scopedLogResponse = await fetch(`${app.url}/api/audit?artifactId=${encodeURIComponent(created.id)}`, {
      headers: { "x-artifacty-token": otherToken }
    });
    const scopedLog = await scopedLogResponse.json();
    assert.equal(scopedLog.events.length, 0);

    // The owner still sees their own row.
    const ownerLogResponse = await fetch(`${app.url}/api/audit?artifactId=${encodeURIComponent(created.id)}`, {
      headers: { "x-artifacty-token": ownerToken }
    });
    const ownerLog = await ownerLogResponse.json();
    assert.ok(ownerLog.events.length > 0);

    // Same guarantee over MCP's artifacty_audit tool.
    const otherHandler = createMcpRequestHandler({
      store,
      auth: { user: other },
      auditContext: () => ({ surface: "mcp", actor: other.email, userId: other.id, publisherName: other.name })
    });
    const mcpAudit = await otherHandler({
      method: "tools/call",
      params: { name: "artifacty_audit", arguments: {} }
    });
    assert.ok(!mcpAudit.structuredContent.events.some((event) => event.artifactId === created.id));
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("H4: SSE stream, ?since= polling, and artifacty_wait hide private artifact events from a non-owner", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-secfix-events-"));
  const app = await startServer({ port: 0, home });
  const store = createStore({ home });
  const controller = new AbortController();
  try {
    const owner = await createUser(store, { email: "h4-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "h4-other@example.com", name: "Other", role: "user", password: "password-123" });
    const ownerToken = (await createApiToken(store, owner.id, { name: "Owner", scopes: ["read", "write"] })).token;
    const otherToken = (await createApiToken(store, other.id, { name: "Other", scopes: ["read", "write"] })).token;

    // Open the SSE stream as `other` before the private artifact exists.
    const streamResponse = await fetch(`${app.url}/api/events`, {
      headers: { accept: "text/event-stream", "x-artifacty-token": otherToken },
      signal: controller.signal
    });
    assert.equal(streamResponse.status, 200);
    const reader = streamResponse.body.getReader();
    await readUntil(reader, (text) => text.includes(": connected"));

    const createResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "x-artifacty-token": ownerToken, "content-type": "application/json" },
      body: JSON.stringify({ title: "H4 Private Event Source", content: "secret", format: "text", visibility: "private" })
    });
    const created = await createResponse.json();

    // A harmless team artifact that fires an event after the private one,
    // so the stream has something to observe without hanging forever.
    const sentinelResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "x-artifacty-token": ownerToken, "content-type": "application/json" },
      body: JSON.stringify({ title: "H4 Sentinel", content: "hi", format: "text" })
    });
    const sentinel = await sentinelResponse.json();

    const streamBuffer = await readUntil(reader, (text) => text.includes(sentinel.id));
    assert.ok(!streamBuffer.includes(created.id), "private artifact id must never appear on the non-owner's SSE stream");
    assert.ok(!streamBuffer.includes("ownerUserId"), "ownerUserId must be stripped from delivered SSE frames");
    controller.abort();

    // ?since= JSON polling mode.
    const pollResponse = await fetch(`${app.url}/api/events?since=0`, { headers: { "x-artifacty-token": otherToken } });
    const poll = await pollResponse.json();
    assert.ok(!poll.events.some((event) => event.artifactId === created.id));
    assert.ok(poll.events.some((event) => event.artifactId === sentinel.id));

    // The owner still sees both over the same JSON polling mode.
    const ownerPollResponse = await fetch(`${app.url}/api/events?since=0`, { headers: { "x-artifacty-token": ownerToken } });
    const ownerPoll = await ownerPollResponse.json();
    assert.ok(ownerPoll.events.some((event) => event.artifactId === created.id));

    // artifacty_wait over MCP must not resolve for the private artifact's
    // event even though it matches the filter.
    const otherHandler = createMcpRequestHandler({
      store,
      auth: { user: other },
      auditContext: () => ({ surface: "mcp", actor: other.email, userId: other.id, publisherName: other.name })
    });
    const waitPromise = otherHandler({
      method: "tools/call",
      params: { name: "artifacty_wait", arguments: { artifactId: created.id, timeoutMs: 300 } }
    });
    await updateArtifact(store, created.id, { content: "changed", sourceAgent: "test", audit: { userId: owner.id, actor: owner.email } });
    const waitResult = await waitPromise;
    assert.equal(waitResult.structuredContent.timedOut, true, "wait must time out rather than resolve with a private event");
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("M3: relations API blanks both artifactId and artifact for a restricted neighbour", async () => {
  await withStore(async (store) => {
    const owner = await createUser(store, { email: "m3-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "m3-other@example.com", name: "Other", role: "user", password: "password-123" });

    const visibleArtifact = await createArtifact(store, {
      title: "M3 Team Root",
      content: "content",
      format: "text",
      visibility: "team",
      audit: { userId: other.id, actor: other.email }
    });
    const privateTarget = await createArtifact(store, {
      title: "M3 Private Target Title",
      content: "content",
      format: "text",
      visibility: "private",
      audit: { userId: owner.id, actor: owner.email }
    });
    await addRelation(store, {
      fromId: visibleArtifact.id,
      toId: privateTarget.id,
      relation: "references",
      access: { userId: owner.id, role: "user" }
    });

    const { listRelations } = await import("../src/lib/storage.js");
    const relations = await listRelations(store, visibleArtifact.id, { access: { userId: other.id, role: "user" } });
    assert.equal(relations.outgoing.length, 1);
    const entry = relations.outgoing[0];
    assert.equal(entry.restricted, true);
    assert.equal(entry.artifactId, null, "restricted entry must not leak the neighbour's id (ids are slugified titles)");
    assert.equal(entry.artifact, null);
  });
});
