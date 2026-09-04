// MCP-over-HTTP token scope filtering (roadmap section 11) and write-bucket
// rate limiting (roadmap section 12).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { createApiToken, createUser } from "../src/lib/storage.js";

async function mcpCall(url, token, method, params = {}, id = 1) {
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  const body = await response.json();
  assert.equal(body.id, id);
  return body;
}

test("tools/list omits mutating tools for a read-only token over the HTTP transport, and tools/call rejects them", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-scopes-"));
  const app = await startServer({ port: 0, home, mcpHttp: true });
  try {
    const member = await createUser(app.store, {
      email: "mcp-scope-member@example.com",
      name: "MCP Scope Member",
      role: "user",
      password: "password-123"
    });
    const readOnly = await createApiToken(app.store, member.id, { name: "Read only", scopes: ["read"] });
    const readWrite = await createApiToken(app.store, member.id, { name: "Read write", scopes: ["read", "write"] });

    const readOnlyList = await mcpCall(app.url, readOnly.token, "tools/list");
    const readOnlyNames = readOnlyList.result.tools.map((tool) => tool.name);
    assert.ok(readOnlyNames.includes("artifacty_list"));
    assert.ok(readOnlyNames.includes("artifacty_get"));
    assert.ok(!readOnlyNames.includes("artifacty_create"));
    assert.ok(!readOnlyNames.includes("artifacty_update"));
    assert.ok(!readOnlyNames.includes("artifacty_archive"));

    const readWriteList = await mcpCall(app.url, readWrite.token, "tools/list");
    const readWriteNames = readWriteList.result.tools.map((tool) => tool.name);
    assert.ok(readWriteNames.includes("artifacty_create"));

    const deniedCall = await mcpCall(app.url, readOnly.token, "tools/call", {
      name: "artifacty_create",
      arguments: { title: "Denied", content: "x", format: "text" }
    });
    assert.equal(deniedCall.result.isError, true);
    assert.equal(deniedCall.result.structuredContent.code, "scope_denied");

    const allowedRead = await mcpCall(app.url, readOnly.token, "tools/call", {
      name: "artifacty_list",
      arguments: {}
    });
    assert.equal(allowedRead.result.isError, false);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a stdio (non-HTTP) MCP context has full scopes regardless of any configured token", async () => {
  const { createMcpRequestHandler } = await import("../src/mcp-server.js");
  const { createStore } = await import("../src/lib/storage.js");
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-stdio-scopes-"));
  const handler = createMcpRequestHandler({ store: createStore({ home }) });
  try {
    const listed = await handler({ method: "tools/list" });
    assert.ok(listed.tools.some((tool) => tool.name === "artifacty_create"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("mutating MCP tool calls over HTTP are rate-limited and return an isError result with code rate_limited", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-rate-limit-"));
  process.env.ARTIFACTY_RATE_LIMIT = "always";
  process.env.ARTIFACTY_RATE_WRITE_PER_MIN = "1";
  const app = await startServer({ port: 0, home, mcpHttp: true });
  try {
    const first = await mcpCall(app.url, null, "tools/call", {
      name: "artifacty_create",
      arguments: { title: "First", content: "x", format: "text" }
    });
    assert.equal(first.result.isError, false);

    const second = await mcpCall(app.url, null, "tools/call", {
      name: "artifacty_create",
      arguments: { title: "Second", content: "x", format: "text" }
    });
    assert.equal(second.result.isError, true);
    assert.equal(second.result.structuredContent.code, "rate_limited");
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
    delete process.env.ARTIFACTY_RATE_LIMIT;
    delete process.env.ARTIFACTY_RATE_WRITE_PER_MIN;
  }
});
