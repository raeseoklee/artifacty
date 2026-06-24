import { spawn } from "node:child_process";
import path from "node:path";

export const REQUIRED_MCP_TOOLS = [
  "artifacty_create",
  "artifacty_publish",
  "artifacty_import",
  "artifacty_list",
  "artifacty_get",
  "artifacty_update",
  "artifacty_archive",
  "artifacty_restore",
  "artifacty_audit",
  "artifacty_info"
];

export async function checkMcpTools(options = {}) {
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const serverPath = path.resolve(options.serverPath || path.join(projectDir, "src", "mcp-server.js"));
  const requiredTools = options.requiredTools || REQUIRED_MCP_TOOLS;
  const timeoutMs = Number(options.timeout || 5000);
  const client = spawnMcpClient({
    serverPath,
    timeoutMs,
    env: {
      ...process.env,
      ...(options.url ? { ARTIFACTY_URL: options.url } : {}),
      ...(options.home ? { ARTIFACTY_HOME: path.resolve(options.home) } : {})
    }
  });

  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "artifacty-check", version: "0.1.0" }
    });
    client.notify("notifications/initialized", {});
    const listed = await client.request("tools/list", {});
    const toolNames = (listed.tools || []).map((tool) => tool.name).sort();
    const missingTools = requiredTools.filter((tool) => !toolNames.includes(tool));

    return {
      ok: missingTools.length === 0,
      serverPath,
      protocolVersion: initialized.protocolVersion,
      toolCount: toolNames.length,
      tools: toolNames,
      missingTools
    };
  } finally {
    client.close();
  }
}

function spawnMcpClient({ serverPath, timeoutMs, env }) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(path.dirname(serverPath)),
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        const message = JSON.parse(line);
        const entry = pending.get(message.id);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(message.id);
          if (message.error) {
            entry.reject(new Error(message.error.message));
          } else {
            entry.resolve(message.result);
          }
        }
      }
      newline = buffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  child.on("exit", (code) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`MCP server exited with code ${code}: ${stderr.trim()}`));
    }
    pending.clear();
  });

  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;
      const payload = { jsonrpc: "2.0", id, method, params };
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for MCP response to ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      return promise;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    close() {
      child.kill("SIGTERM");
    }
  };
}
