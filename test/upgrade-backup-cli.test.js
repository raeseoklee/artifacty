import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createArtifact, createStore } from "../src/lib/storage.js";

const exec = promisify(execFile);
const cli = (...args) => exec(process.execPath, ["src/cli.js", ...args], {
  env: { ...process.env, ARTIFACTY_BACKUP_ON_UPDATE: "false" }
});

async function homeFor(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-upgrade-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("backup help distinguishes store recovery from artifact restoration", async () => {
  const { stdout } = await cli("help");
  assert.match(stdout, /artifacty backups restore <id> --confirm restore-store/);
  assert.match(stdout, /ARTIFACTY_BACKUP_ON_UPDATE=true/);
  assert.match(stdout, /mandatory snapshot before a schema migration/);
  assert.match(stdout, /artifacty restore <id> restores an archived artifact/);
});

test("backup listing does not initialize or migrate an unreadable store", async (t) => {
  const home = await homeFor(t);
  const database = path.join(home, "artifacty.sqlite");
  const bytes = Buffer.from("damaged database awaiting recovery");
  await writeFile(database, bytes);
  const { stdout } = await cli("backups", "list", "--home", home);
  assert.deepEqual(JSON.parse(stdout), { backups: [] });
  assert.deepEqual(await readFile(database), bytes);
  assert.deepEqual(await readdir(home), ["artifacty.sqlite"]);
  await assert.rejects(cli("backups", "restore", "missing", "--home", home), /--confirm restore-store/);
  await assert.rejects(cli("backups", "verify", "../outside", "--home", home));
  assert.deepEqual(await readFile(database), bytes);
});

test("backup commands verify snapshots and restore without an implicit migration", async (t) => {
  const { createUpgradeBackup, listUpgradeBackups } = await import("../src/lib/upgrade-backup.js");
  const home = await homeFor(t);
  const store = createStore({ home });
  const artifact = await createArtifact(store, { title: "Recovery manual", format: "text", content: "Original" });
  const db = new DatabaseSync(store.dbPath);
  db.prepare("UPDATE meta SET value = '9' WHERE key = 'store_version'").run();
  db.close();
  const snapshot = createUpgradeBackup(store, { reason: "schema-upgrade", sourceSchemaVersion: 9, targetSchemaVersion: 10 });
  const listed = JSON.parse((await cli("backups", "list", "--home", home)).stdout).backups;
  assert.ok(listed.some((item) => item.id === snapshot.id));
  const verified = JSON.parse((await cli("backups", "verify", snapshot.id, "--home", home)).stdout);
  assert.equal(verified.valid, true);
  const readVersion = () => {
    const connection = new DatabaseSync(store.dbPath, { readOnly: true });
    try { return connection.prepare("SELECT value FROM meta WHERE key = 'store_version'").get().value; }
    finally { connection.close(); }
  };
  assert.equal(readVersion(), "9");
  // Change raw files without using the migration-aware storage API.
  const contentPath = path.join(home, artifact.versions[0].path);
  await writeFile(contentPath, "After snapshot");
  const changed = new DatabaseSync(store.dbPath);
  changed.prepare("UPDATE artifact_versions SET size_bytes = ?, sha256 = ? WHERE artifact_id = ? AND version = 1")
    .run(Buffer.byteLength("After snapshot"), createHash("sha256").update("After snapshot").digest("hex"), artifact.id);
  changed.close();
  await assert.rejects(cli("backups", "restore", snapshot.id, "--confirm", "wrong", "--home", home), /--confirm restore-store/);
  assert.equal(await readFile(contentPath, "utf8"), "After snapshot");
  await writeFile(path.join(home, "server.pid"), String(process.pid));
  await assert.rejects(cli("backups", "restore", snapshot.id, "--confirm", "restore-store", "--home", home), /running|Stop|stop/);
  assert.equal(await readFile(contentPath, "utf8"), "After snapshot");
  await writeFile(path.join(home, "server.pid"), "2147483647");
  const restored = JSON.parse((await cli("backups", "restore", snapshot.id, "--confirm", "restore-store", "--home", home)).stdout);
  assert.equal(restored.restored, snapshot.id);
  assert.ok(restored.recoveryBackupId);
  assert.equal(await readFile(contentPath, "utf8"), "Original");
  assert.equal(readVersion(), "9");
  assert.ok(listUpgradeBackups(store).some((item) => item.id === restored.recoveryBackupId));
  assert.equal(JSON.parse((await cli("backups", "verify", restored.recoveryBackupId, "--home", home)).stdout).valid, true);
  await cli("backups", "restore", restored.recoveryBackupId, "--confirm", "restore-store", "--home", home);
  assert.equal(await readFile(contentPath, "utf8"), "After snapshot");
  assert.equal(readVersion(), "9");
});

test("existing artifact restore command keeps its original behavior", async (t) => {
  const home = await homeFor(t);
  const store = createStore({ home });
  const artifact = await createArtifact(store, { title: "Archived example", format: "text", content: "Keep" });
  await cli("archive", artifact.id, "--home", home);
  const restored = JSON.parse((await cli("restore", artifact.id, "--home", home)).stdout);
  assert.equal(restored.id, artifact.id);
  assert.equal(restored.archivedAt, null);
});


test("backup verification rejects corrupted snapshots without changing the current store", async (t) => {
  const { createUpgradeBackup } = await import("../src/lib/upgrade-backup.js");
  const home = await homeFor(t);
  const store = createStore({ home });
  const artifact = await createArtifact(store, { title: "Hash check", format: "text", content: "Keep current" });
  const snapshot = createUpgradeBackup(store);
  const entries = await readdir(snapshot.path, { recursive: true });
  const versionFile = entries.find((entry) => entry.endsWith(artifact.versions[0].path));
  assert.ok(versionFile);
  await writeFile(path.join(snapshot.path, versionFile), "Corrupted snapshot");
  await assert.rejects(cli("backups", "verify", snapshot.id, "--home", home));
  await assert.rejects(cli("backups", "restore", snapshot.id, "--confirm", "restore-store", "--home", home));
  assert.equal(await readFile(path.join(home, artifact.versions[0].path), "utf8"), "Keep current");
});
