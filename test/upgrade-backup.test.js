import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import { createArtifact, createStore, createUser, openDatabase, STORE_VERSION, updateArtifact } from "../src/lib/storage.js";
import { createUpgradeBackup, listUpgradeBackups, openProtectedDatabase, restoreUpgradeBackup, verifyUpgradeBackup } from "../src/lib/upgrade-backup.js";

const exec = promisify(execFile);
const storageUrl = new URL("../src/lib/storage.js", import.meta.url).href;
const backupUrl = new URL("../src/lib/upgrade-backup.js", import.meta.url).href;
const hash = (content) => createHash("sha256").update(content).digest("hex");
async function fixture(fn) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-upgrade-"));
  try { await fn(createStore({ home })); } finally { await rm(home, { recursive: true, force: true }); }
}
function raw(store, fn) { const db = new DatabaseSync(store.dbPath); try { return fn(db); } finally { db.close(); } }
function older(store) { raw(store, (db) => db.prepare("UPDATE meta SET value=? WHERE key='store_version'").run(String(STORE_VERSION - 1))); }
function reopen(store) { openDatabase(store).close(); }
function childOpen(home) { return exec(process.execPath, ["--input-type=module", "-e", `import {openDatabase,createStore} from ${JSON.stringify(storageUrl)}; openDatabase(createStore({home:process.argv[1]})).close()`, home], { timeout: 20000 }); }

test("schema upgrade snapshots all security tables and referenced files before creating new tables", async () => {
  await fixture(async (store) => {
    const user = await createUser(store, { email: "admin@example.com", name: "Admin", role: "admin", password: "password-123" });
    const artifact = await createArtifact(store, { title: "Guide", content: "immutable guide", ownerUserId: user.id });
    older(store);
    raw(store, (db) => { db.exec("DROP TABLE notifications"); db.exec("CREATE TABLE custom_security (secret TEXT); INSERT INTO custom_security VALUES ('keep-me')"); });
    reopen(store);
    const snapshots = listUpgradeBackups(store);
    assert.equal(snapshots.length, 1);
    const snapshot = verifyUpgradeBackup(store, snapshots[0].id);
    assert.equal(snapshot.sourceSchemaVersion, STORE_VERSION - 1);
    const before = new DatabaseSync(path.join(snapshot.path, "artifacty.sqlite"), { readOnly: true });
    try {
      assert.equal(before.prepare("SELECT value FROM meta WHERE key='store_version'").get().value, String(STORE_VERSION - 1));
      assert.equal(before.prepare("SELECT name FROM sqlite_master WHERE name='notifications'").get(), undefined);
      assert.equal(before.prepare("SELECT secret FROM custom_security").get().secret, "keep-me");
      assert.equal(before.prepare("SELECT password_hash FROM users WHERE id=?").get(user.id).password_hash.startsWith("scrypt"), true);
    } finally { before.close(); }
    const versionPath = artifact.versions[0].path.replaceAll("\\", "/");
    const file = snapshot.files.find((entry) => entry.path === versionPath);
    assert.equal(fs.readFileSync(path.join(snapshot.path, file.path), "utf8"), "immutable guide");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(snapshot.path).mode & 0o777, 0o700);
      for (const entry of snapshot.files) assert.equal(fs.statSync(path.join(snapshot.path, entry.path)).mode & 0o777, 0o600);
    }
    reopen(store);
    assert.equal(listUpgradeBackups(store).length, 1);
  });
});

test("new stores need no snapshot and newer stores are rejected without schema mutation", async () => {
  await fixture(async (store) => {
    reopen(store);
    assert.deepEqual(listUpgradeBackups(store), []);
    raw(store, (db) => { db.prepare("UPDATE meta SET value=? WHERE key='store_version'").run(String(STORE_VERSION + 1)); db.exec("DROP TABLE notifications"); });
    const before = hash(fs.readFileSync(store.dbPath));
    assert.throws(() => reopen(store), /newer version/);
    assert.equal(hash(fs.readFileSync(store.dbPath)), before);
    assert.deepEqual(listUpgradeBackups(store), []);
  });
});

test("missing or changed version bytes block migration and leave its schema unchanged", async () => {
  for (const missing of [false, true]) await fixture(async (store) => {
    const artifact = await createArtifact(store, { title: "Guide", content: "before" });
    older(store);
    const file = path.join(store.home, artifact.versions[0].path);
    if (missing) fs.rmSync(file); else fs.writeFileSync(file, "changed");
    assert.throws(() => reopen(store));
    assert.equal(raw(store, (db) => db.prepare("SELECT value FROM meta WHERE key='store_version'").get().value), String(STORE_VERSION - 1));
    assert.deepEqual(listUpgradeBackups(store), []);
  });
});

test("simultaneous processes perform one upgrade and stale dead-owner locks are recovered", async () => {
  await fixture(async (store) => {
    await createArtifact(store, { title: "Guide", content: "before" });
    older(store);
    fs.writeFileSync(path.join(store.home, ".upgrade.lock"), JSON.stringify({ pid: 2147483647, token: randomUUID() }));
    await Promise.all([childOpen(store.home), childOpen(store.home), childOpen(store.home)]);
    assert.equal(listUpgradeBackups(store).length, 1);
    assert.equal(fs.existsSync(path.join(store.home, ".upgrade.lock")), false);
  });
});

test("optional application backups record unknown source honestly and retain only owned automatic snapshots", async () => {
  await fixture(async (store) => {
    const original = process.env.ARTIFACTY_BACKUP_ON_UPDATE;
    const keep = process.env.ARTIFACTY_UPGRADE_BACKUP_KEEP;
    try {
      const artifact = await createArtifact(store, { title: "Guide", content: "before" });
      const manual = createUpgradeBackup(store);
      raw(store, (db) => db.prepare("DELETE FROM meta WHERE key='application_version'").run());
      process.env.ARTIFACTY_BACKUP_ON_UPDATE = "true";
      process.env.ARTIFACTY_UPGRADE_BACKUP_KEEP = "2";
      reopen(store);
      assert.equal(listUpgradeBackups(store).find((entry) => entry.reason === "application-update").sourceAppVersion, null);
      reopen(store);
      assert.equal(listUpgradeBackups(store).length, 2);
      for (let n = 0; n < 3; n++) {
        await updateArtifact(store, artifact.id, { content: `version ${n}` });
        raw(store, (db) => db.prepare("UPDATE meta SET value=? WHERE key='application_version'").run(`0.0.${n}`));
        reopen(store);
      }
      assert.equal(listUpgradeBackups(store).filter((entry) => entry.id.startsWith("auto-")).length, 2);
      assert.equal(verifyUpgradeBackup(store, manual.id).valid, true);
    } finally {
      if (original === undefined) delete process.env.ARTIFACTY_BACKUP_ON_UPDATE; else process.env.ARTIFACTY_BACKUP_ON_UPDATE = original;
      if (keep === undefined) delete process.env.ARTIFACTY_UPGRADE_BACKUP_KEEP; else process.env.ARTIFACTY_UPGRADE_BACKUP_KEEP = keep;
    }
  });
});

test("legacy-only snapshots restore exact index and files; stale migrated indexes are not authoritative", async () => {
  await fixture(async (store) => {
    const content = "legacy";
    fs.mkdirSync(path.join(store.home, "artifacts", "legacy"), { recursive: true });
    fs.writeFileSync(path.join(store.home, "artifacts", "legacy", "v1.txt"), content);
    const index = { artifacts: [{ id: "legacy", versions: [{ path: "artifacts/legacy/v1.txt", sizeBytes: content.length, sha256: hash(content) }] }] };
    fs.writeFileSync(store.indexPath, JSON.stringify(index));
    const snapshot = createUpgradeBackup(store);
    assert.equal(snapshot.files.some((file) => file.path === "artifacty.sqlite"), false);
    const target = createStore({ home: path.join(store.home, "restore-target") });
    fs.mkdirSync(path.join(target.home, "upgrade-backups"), { recursive: true });
    fs.cpSync(snapshot.path, path.join(target.home, "upgrade-backups", snapshot.id), { recursive: true });
    const restored = restoreUpgradeBackup(target, snapshot.id, { confirm: "restore-store" });
    assert.equal(fs.existsSync(target.dbPath), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(target.indexPath, "utf8")), index);
    assert.equal(verifyUpgradeBackup(target, restored.recoveryBackupId).emptyStore, true);
  });
  await fixture(async (store) => {
    reopen(store);
    raw(store, (db) => db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('json_index_migrated','true')").run());
    fs.writeFileSync(store.indexPath, JSON.stringify({ artifacts: [{ versions: [{ path: "artifacts/missing/v1.txt", sizeBytes: 1, sha256: "invalid" }] }] }));
    older(store);
    reopen(store);
    assert.equal(listUpgradeBackups(store).length, 1);
  });
});

test("snapshot path traversal and dangling symlinks fail closed", async () => {
  await fixture(async (store) => {
    const artifact = await createArtifact(store, { title: "Guide", content: "before" });
    const snapshot = createUpgradeBackup(store);
    const manifestFile = path.join(snapshot.path, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    manifest.files.find((file) => file.path.startsWith("artifacts/")).path = "artifacts/../../outside";
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => verifyUpgradeBackup(store, snapshot.id), /Unsafe snapshot path/);
    assert.throws(() => restoreUpgradeBackup(store, snapshot.id, { confirm: "restore-store" }));
    assert.equal(fs.readFileSync(path.join(store.home, artifact.versions[0].path), "utf8"), "before");
  });
  if (process.platform !== "win32") for (const filename of ["artifacty.sqlite", "upgrade-backups"]) await fixture(async (store) => {
    const outside = path.join(store.home, "outside-missing");
    fs.symlinkSync(outside, path.join(store.home, filename));
    if (filename === "artifacty.sqlite") assert.throws(() => reopen(store), /symbolic links/);
    else assert.throws(() => createUpgradeBackup(store), /symbolic links/);
    assert.equal(fs.existsSync(outside), false);
  });
});

test("restore refuses corrupt current store and preserves its bytes", async () => {
  await fixture(async (store) => {
    const artifact = await createArtifact(store, { title: "Guide", content: "before" });
    const snapshot = createUpgradeBackup(store);
    const file = path.join(store.home, artifact.versions[0].path);
    fs.writeFileSync(file, "damaged");
    assert.throws(() => restoreUpgradeBackup(store, snapshot.id, { confirm: "restore-store" }), /new empty home's upgrade-backups/);
    assert.equal(fs.readFileSync(file, "utf8"), "damaged");
  });
});

test("interrupted restore blocks initialization, and failed rollback retains recovery files", async () => {
  await fixture(async (store) => {
    await createArtifact(store, { title: "Guide", content: "before" });
    const snapshot = createUpgradeBackup(store);
    const script = `import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
      import {restoreUpgradeBackup} from ${JSON.stringify(backupUrl)};
      const rename = fs.renameSync; fs.renameSync = (from,to) => {
        const source = String(from).split(path.sep).join('/'); const target = String(to).split(path.sep).join('/');
        if ((target.includes('/previous/') && target.endsWith('/artifacts')) || (source.includes('/previous/') && source.endsWith('/artifacty.sqlite'))) throw new Error('injected rename failure');
        return rename(from,to);
      }; syncBuiltinESMExports();
      try {restoreUpgradeBackup({home:process.argv[1]},process.argv[2],{confirm:'restore-store'});process.exitCode=2}
      catch(e){if(e.code!=='RESTORE_INCOMPLETE')throw e;console.log(e.message)};`;
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script, store.home, snapshot.id]);
    assert.match(stdout, /recovery snapshot/);
    const pending = fs.readdirSync(store.home).find((name) => name.startsWith(".restore-"));
    assert.ok(pending);
    assert.equal(fs.existsSync(path.join(store.home, pending, "previous", "artifacty.sqlite")), true);
    const marker = JSON.parse(fs.readFileSync(path.join(store.home, pending, "restore.json"), "utf8"));
    assert.equal(verifyUpgradeBackup(store, marker.recoveryBackupId).valid, true);
    assert.throws(() => reopen(store), { code: "RESTORE_INCOMPLETE" });
    assert.equal(fs.existsSync(store.dbPath), false);
  });
});


test("VACUUM snapshot includes committed WAL data while another connection remains open", async () => {
  await fixture(async (store) => {
    reopen(store);
    const writer = new DatabaseSync(store.dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE wal_security (token TEXT); INSERT INTO wal_security VALUES ('committed-in-wal')");
      assert.ok(fs.statSync(`${store.dbPath}-wal`).size > 0);
      const snapshot = createUpgradeBackup(store);
      const db = new DatabaseSync(path.join(snapshot.path, "artifacty.sqlite"), { readOnly: true });
      try { assert.equal(db.prepare("SELECT token FROM wal_security").get().token, "committed-in-wal"); }
      finally { db.close(); }
    } finally { writer.close(); }
  });
});

test("failed migration retries reuse identical backup and never prune existing snapshots", async () => {
  await fixture(async (store) => {
    await createArtifact(store, { title: "Guide", content: "before" });
    older(store);
    const original = process.env.ARTIFACTY_UPGRADE_BACKUP_KEEP;
    try {
      process.env.ARTIFACTY_UPGRADE_BACKUP_KEEP = "invalid";
      assert.throws(() => reopen(store), /must be from 1 to 1000/);
      assert.deepEqual(listUpgradeBackups(store), []);
      process.env.ARTIFACTY_UPGRADE_BACKUP_KEEP = "1";
      const manual = createUpgradeBackup(store);
      const fail = () => { throw new Error("injected migration failure"); };
      assert.throws(() => openProtectedDatabase(store, STORE_VERSION, fail), /injected migration failure/);
      const ids = listUpgradeBackups(store).map((item) => item.id).sort();
      assert.equal(ids.length, 2);
      assert.throws(() => openProtectedDatabase(store, STORE_VERSION, fail), /injected migration failure/);
      assert.deepEqual(listUpgradeBackups(store).map((item) => item.id).sort(), ids);
      assert.equal(verifyUpgradeBackup(store, manual.id).valid, true);
      assert.equal(raw(store, (db) => db.prepare("SELECT value FROM meta WHERE key='store_version'").get().value), String(STORE_VERSION - 1));
    } finally { if (original === undefined) delete process.env.ARTIFACTY_UPGRADE_BACKUP_KEEP; else process.env.ARTIFACTY_UPGRADE_BACKUP_KEEP = original; }
  });
});
