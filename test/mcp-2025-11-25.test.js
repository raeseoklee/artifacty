import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpRequestHandler, handleJsonRpcMessage } from "../src/mcp-server.js";
import { startServer } from "../src/server.js";
import { createStore } from "../src/lib/storage.js";

test("invalid tool arguments come back as tool errors; an unknown tool stays a protocol error", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-args-"));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const handler = createMcpRequestHandler({ store: createStore({ home }) });
  const missing = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "artifacty_get", arguments: {} } }, handler);
  assert.equal(missing.error, undefined, "not a JSON-RPC error");
  assert.equal(missing.result.isError, true);
  assert.equal(missing.result.structuredContent.code, "invalid_arguments");
  assert.match(missing.result.content[0].text, /Missing required argument: id/);

  const unknown = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "artifacty_nope", arguments: {} } }, handler);
  assert.equal(unknown.error.code, -32602);
  assert.match(unknown.error.message, /Unknown tool/);
});

test("the HTTP MCP endpoint rejects foreign browser origins and allows agents, same origin, and configured origins", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-origin-"));
  const previous = process.env.ARTIFACTY_MCP_ALLOWED_ORIGINS;
  process.env.ARTIFACTY_MCP_ALLOWED_ORIGINS = "http://localhost:6274";
  const app = await startServer({ port: 0, home, mcpHttp: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.ARTIFACTY_MCP_ALLOWED_ORIGINS; else process.env.ARTIFACTY_MCP_ALLOWED_ORIGINS = previous;
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const post = (headers = {}) => fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  assert.equal((await post()).status, 200, "agents send no Origin");
  assert.equal((await post({ origin: app.url })).status, 200, "same origin");
  assert.equal((await post({ origin: "http://localhost:6274" })).status, 200, "configured origin");
  const foreign = await post({ origin: "https://evil.example.test" });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).code, "MCP_ORIGIN_FORBIDDEN");
});
