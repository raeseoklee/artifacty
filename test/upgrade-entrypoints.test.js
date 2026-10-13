import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startServer } from "../src/server.js";
import { createArtifact, createStore, STORE_VERSION } from "../src/lib/storage.js";
import { listUpgradeBackups, verifyUpgradeBackup } from "../src/lib/upgrade-backup.js";

function schemaVersion(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number(db.prepare("SELECT value FROM meta WHERE key = 'store_version'").get().value);
  } finally {
    db.close();
  }
}

async function olderStore(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-upgrade-entry-"));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = createStore({ home });
  const artifact = await createArtifact(store, { title: "Pre-upgrade evidence", format: "text", content: "Preserve this version" });
  const db = new DatabaseSync(store.dbPath);
  try {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'store_version'").run(String(STORE_VERSION - 1));
  } finally {
    db.close();
  }
  return { store, artifact };
}

async function availablePort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function mcpList(home) {
  const child = spawn(process.execPath, ["src/mcp-server.js"], {
    env: { ...process.env, ARTIFACTY_HOME: home, ARTIFACTY_MCP_MODE: "local", ARTIFACTY_BACKUP_ON_UPDATE: "false" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    return await new Promise((resolve, reject) => {
      let buffer = "";
      const timeout = setTimeout(() => reject(new Error(`MCP timed out: ${stderr}`)), 10000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(`MCP exited before response: ${stderr}`)); });
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.id !== 1) continue;
          clearTimeout(timeout);
          resolve(message);
        }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "artifacty_list", arguments: {} } })}\n`);
    });
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
}

function assertMigrationSnapshot(store) {
  const backups = listUpgradeBackups(store).filter((item) => item.reason === "schema-upgrade");
  assert.equal(backups.length, 1);
  const snapshot = backups[0];
  assert.equal(snapshot.sourceSchemaVersion, STORE_VERSION - 1);
  assert.equal(snapshot.targetSchemaVersion, STORE_VERSION);
  assert.equal(verifyUpgradeBackup(store, snapshot.id).valid, true);
  assert.equal(schemaVersion(path.join(snapshot.path, "artifacty.sqlite")), STORE_VERSION - 1);
  assert.equal(schemaVersion(store.dbPath), STORE_VERSION);
  return snapshot;
}

test("HTTP startup snapshots the old schema before the first request", async (t) => {
  const { store, artifact } = await olderStore(t);
  const app = await startServer({ home: store.home, port: 0 });
  t.after(() => app.close());
  const snapshot = assertMigrationSnapshot(store);
  const response = await fetch(`${app.url}/api/artifacts/${artifact.id}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, "Preserve this version");
  assert.equal(listUpgradeBackups(store).filter((item) => item.reason === "schema-upgrade").length, 1);
  assert.equal(await readFile(path.join(snapshot.path, artifact.versions[0].path), "utf8"), "Preserve this version");
});

test("local MCP first use shares the mandatory pre-migration snapshot guard", async (t) => {
  const { store, artifact } = await olderStore(t);
  const response = await mcpList(store.home);
  assert.equal(response.result?.isError, false, JSON.stringify(response));
  assert.ok(response.result.structuredContent.artifacts.some((item) => item.id === artifact.id));
  const snapshot = assertMigrationSnapshot(store);
  assert.equal(await readFile(path.join(snapshot.path, artifact.versions[0].path), "utf8"), "Preserve this version");
  await mcpList(store.home);
  assert.equal(listUpgradeBackups(store).filter((item) => item.reason === "schema-upgrade").length, 1);
});

for (const entrypoint of ["HTTP", "MCP"]) {
  test(`${entrypoint} refuses migration when the mandatory snapshot cannot preserve a version file`, async (t) => {
    const { store, artifact } = await olderStore(t);
    const contentPath = path.join(store.home, artifact.versions[0].path);
    await writeFile(contentPath, "Corrupted content");
    if (entrypoint === "HTTP") {
      const port = await availablePort();
      await assert.rejects(startServer({ home: store.home, port }), /backup|snapshot|hash|integrity|checksum/i);
      const probe = net.createServer();
      try {
        probe.listen(port, "127.0.0.1");
        await once(probe, "listening");
      } finally {
        await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
      }
    } else {
      const response = await mcpList(store.home);
      assert.ok(response.error || response.result?.isError, JSON.stringify(response));
    }
    assert.equal(schemaVersion(store.dbPath), STORE_VERSION - 1);
    assert.equal(await readFile(contentPath, "utf8"), "Corrupted content");
    assert.equal(listUpgradeBackups(store).filter((item) => item.reason === "schema-upgrade").length, 0);
  });
}
