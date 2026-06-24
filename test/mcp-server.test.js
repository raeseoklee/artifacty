import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../src/lib/storage.js";
import { writeServerState } from "../src/lib/server-state.js";

test("mcp server initializes and exposes artifact tools", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-"));
  await writeServerState(createStore({ home }), {
    url: "http://127.0.0.1:18888",
    host: "127.0.0.1",
    port: 18888,
    requestedPort: 8787,
    portFallback: true
  });
  const childEnv = {
    ...process.env,
    ARTIFACTY_HOME: home
  };
  delete childEnv.ARTIFACTY_URL;
  const child = spawn(process.execPath, ["src/mcp-server.js"], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const client = createLineClient(child);
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" }
    });
    assert.equal(init.protocolVersion, "2025-06-18");

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const listedTools = await client.request("tools/list", {});
    assert.ok(listedTools.tools.some((tool) => tool.name === "artifacty_create"));
    assert.ok(listedTools.tools.some((tool) => tool.name === "artifacty_publish"));
    assert.ok(listedTools.tools.some((tool) => tool.name === "artifacty_archive"));
    assert.ok(listedTools.tools.some((tool) => tool.name === "artifacty_restore"));
    assert.ok(listedTools.tools.some((tool) => tool.name === "artifacty_audit"));
    const createTool = listedTools.tools.find((tool) => tool.name === "artifacty_create");
    assert.ok(createTool.inputSchema.properties.format.enum.includes("code"));
    assert.ok(createTool.inputSchema.properties.format.enum.includes("svg"));
    assert.ok(createTool.inputSchema.properties.format.enum.includes("mermaid"));
    assert.ok(createTool.inputSchema.properties.format.enum.includes("react"));
    assert.ok(createTool.inputSchema.properties.artifactType.enum.includes("diagram"));
    assert.ok(createTool.inputSchema.properties.artifactType.enum.includes("component"));
    assert.ok(createTool.inputSchema.properties.artifactType.enum.includes("snippet"));

    const info = await client.request("tools/call", {
      name: "artifacty_info",
      arguments: {}
    });
    assert.equal(info.structuredContent.url, "http://127.0.0.1:18888");

    const published = await client.request("tools/call", {
      name: "artifacty_create",
      arguments: {
        title: "MCP Demo",
        content: "hello",
        format: "text",
        artifactType: "document",
        sourceAgent: "test"
      }
    });
    assert.equal(published.isError, false);
    const id = published.structuredContent.id;
    assert.match(published.structuredContent.url, /^http:\/\/127\.0\.0\.1:18888\/artifacts\//);

    const fetched = await client.request("tools/call", {
      name: "artifacty_get",
      arguments: { id }
    });
    assert.equal(fetched.structuredContent.content, "hello");
    assert.equal(fetched.structuredContent.schemaVersion, 1);

    const codeArtifact = await client.request("tools/call", {
      name: "artifacty_create",
      arguments: {
        title: "MCP Snippet",
        content: "console.log('mcp');",
        format: "code",
        artifactType: "snippet",
        sourceAgent: "codex"
      }
    });
    assert.equal(codeArtifact.isError, false);
    assert.equal(codeArtifact.structuredContent.version.format, "code");
    assert.equal(codeArtifact.structuredContent.artifactType, "snippet");

    const archived = await client.request("tools/call", {
      name: "artifacty_archive",
      arguments: { id }
    });
    assert.ok(archived.structuredContent.archivedAt);

    const restored = await client.request("tools/call", {
      name: "artifacty_restore",
      arguments: { id }
    });
    assert.equal(restored.structuredContent.archivedAt, null);

    const imported = await client.request("tools/call", {
      name: "artifacty_import",
      arguments: {
        agent: "gemini",
        payload: {
          title: "Gemini result",
          returnDisplay: "# Result"
        }
      }
    });
    assert.equal(imported.isError, false);
    assert.equal(imported.structuredContent.title, "Gemini result");
    assert.equal(imported.structuredContent.version.format, "markdown");

    const audit = await client.request("tools/call", {
      name: "artifacty_audit",
      arguments: { artifactId: id, limit: 10 }
    });
    assert.ok(audit.structuredContent.events.some((event) => event.action === "create"));
    assert.ok(audit.structuredContent.events.some((event) => event.action === "read"));
  } finally {
    child.kill("SIGTERM");
    await rm(home, { recursive: true, force: true });
  }
});

function createLineClient(child) {
  let nextId = 1;
  const pending = new Map();
  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        const message = JSON.parse(line);
        const resolver = pending.get(message.id);
        if (resolver) {
          pending.delete(message.id);
          if (message.error) {
            resolver.reject(new Error(message.error.message));
          } else {
            resolver.resolve(message.result);
          }
        }
      }
      newline = buffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;
      const message = {
        jsonrpc: "2.0",
        id,
        method,
        params
      };

      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return promise;
    }
  };
}
