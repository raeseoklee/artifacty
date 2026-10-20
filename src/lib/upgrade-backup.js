import { randomUUID, createHash } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync, chmodSync
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const APP_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const KIND = "artifacty-upgrade-backup";
const ID_PATTERN = /^(auto|manual|recovery)-[0-9T-]+-[a-f0-9-]{36}$/;
const wait = new Int32Array(new SharedArrayBuffer(4));

function error(message, code = "UPGRADE_BACKUP_FAILED") {
  return Object.assign(new Error(message), { code });
}

function paths(store) {
  const home = path.resolve(store.home);
  return { home, dbPath: path.join(home, "artifacty.sqlite"), indexPath: path.join(home, "index.json"), artifactsDir: path.join(home, "artifacts"), backups: path.join(home, "upgrade-backups") };
}

function safePath(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw error(`Unsafe snapshot path: ${relative}`);
  }
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw error("Snapshot path escapes its root");
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw error(`Snapshot paths must not contain symbolic links: ${current}`);
    } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
  }
  return target;
}

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw error(`Expected a real directory: ${directory}`);
  chmodSync(directory, 0o700);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (cause) { return cause.code !== "ESRCH"; }
}

function assertOffline(store, allowOwnPid = false) {
  for (const filename of ["server.pid", "server.json"]) {
    const file = safePath(store.home, filename);
    if (!existsSync(file)) continue;
    let pid;
    try {
      const text = readFileSync(file, "utf8");
      pid = filename.endsWith(".json") ? JSON.parse(text).pid : Number(text.trim());
    } catch { throw error(`Cannot inspect ${filename}; stop the server and repair this marker first`, "STORE_NOT_OFFLINE"); }
    if (alive(pid) && !(allowOwnPid && pid === process.pid)) throw error("Stop the managed Artifacty server before upgrading or restoring this store", "STORE_NOT_OFFLINE");
  }
}

function durableWrite(file, content) {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) syncTree(file);
    else {
      const fd = openSync(file, "r+");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  syncDirectory(directory);
}

// A separate reaper guard serializes removal of dead-owner locks. A malformed
// lock or an abandoned reaper fails closed; it is never guessed to be stale.
function lockStore(store) {
  privateDirectory(store.home);
  const lock = safePath(store.home, ".upgrade.lock");
  const reaper = safePath(store.home, ".upgrade-reaper");
  const token = randomUUID();
  const deadline = Date.now() + 5000;
  const acquire = () => {
    durableWrite(lock, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
    return () => {
      const current = JSON.parse(readFileSync(lock, "utf8"));
      if (current.token !== token) throw error("Store lock ownership changed");
      rmSync(lock);
    };
  };
  while (true) {
    if (!existsSync(reaper)) {
      try { return acquire(); } catch (cause) { if (cause.code !== "EEXIST") throw cause; }
      let owner;
      try { owner = JSON.parse(readFileSync(lock, "utf8")); }
      catch (cause) {
        if (cause.code === "ENOENT") continue;
        if (Date.now() >= deadline) throw error("Unreadable upgrade lock; inspect .upgrade.lock before retrying", "STORE_LOCKED");
        Atomics.wait(wait, 0, 0, 25);
        continue;
      }
      if (!Number.isInteger(owner.pid) || !owner.token) throw error("Invalid upgrade lock; inspect .upgrade.lock before retrying", "STORE_LOCKED");
      if (!alive(owner.pid)) {
        try { mkdirSync(reaper, { mode: 0o700 }); }
        catch (cause) { if (cause.code === "EEXIST") continue; throw cause; }
        try {
          if (existsSync(lock)) {
            const current = JSON.parse(readFileSync(lock, "utf8"));
            if (current.token === owner.token && !alive(current.pid)) rmSync(lock);
          }
          if (!existsSync(lock)) {
            // An opener that passed the reaper check can still win this race.
            try { return acquire(); } catch (cause) { if (cause.code !== "EEXIST") throw cause; }
          }
        } finally { rmSync(reaper, { recursive: true }); }
      }
    }
    if (Date.now() >= deadline) throw error("Store upgrade or restore is already running; inspect .upgrade.lock and .upgrade-reaper if its owner has stopped", "STORE_LOCKED");
    Atomics.wait(wait, 0, 0, 25);
  }
}

function rawState(store) {
  safePath(store.home, "artifacty.sqlite");
  safePath(store.home, "index.json");
  if (!existsSync(store.dbPath) || lstatSync(store.dbPath).size === 0) return { schemaVersion: null, appVersion: null, hasDatabase: false, hasData: existsSync(store.indexPath) };
  safePath(store.home, "artifacty.sqlite");
  const db = new DatabaseSync(store.dbPath, { readOnly: true });
  try {
    // The upgrade lock does not cover SQLite locks held by existing handles.
    db.exec("PRAGMA busy_timeout=5000");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const hasMeta = tables.some((table) => table.name === "meta");
    const schema = hasMeta ? db.prepare("SELECT value FROM meta WHERE key='store_version'").get()?.value : null;
    const app = hasMeta ? db.prepare("SELECT value FROM meta WHERE key='application_version'").get()?.value : null;
    if (schema != null && (!/^\d+$/.test(String(schema)) || !Number.isSafeInteger(Number(schema)))) throw error("Invalid stored schema version");
    return { schemaVersion: schema == null ? null : Number(schema), appVersion: app || null, hasDatabase: true, hasData: tables.length > 0 || existsSync(store.indexPath) };
  } finally { db.close(); }
}

function fileInfo(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw error(`Expected a regular file: ${file}`);
  return { sizeBytes: stat.size, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

function references(database, indexFile) {
  const refs = new Map();
  const add = (row) => {
    const versionPath = typeof row.path === "string" ? row.path.replaceAll("\\", "/") : "";
    if (!versionPath.startsWith("artifacts/")) throw error("Version path must be inside artifacts/");
    const expected = { path: versionPath, sizeBytes: row.size_bytes ?? row.sizeBytes, sha256: row.sha256 };
    if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 0 || !/^[a-f0-9]{64}$/i.test(expected.sha256 || "")) throw error(`Invalid version size or hash: ${row.path}`);
    const previous = refs.get(versionPath);
    if (previous && (previous.sha256 !== expected.sha256 || previous.sizeBytes !== expected.sizeBytes)) throw error("Conflicting version file references");
    refs.set(versionPath, expected);
  };
  let legacyAlreadyImported = false;
  if (database) {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const result = db.prepare("PRAGMA integrity_check").all();
      if (result.length !== 1 || Object.values(result[0])[0] !== "ok") throw error("Snapshot SQLite integrity check failed");
      if (db.prepare("SELECT name FROM sqlite_master WHERE name='artifact_versions'").get()) {
        for (const row of db.prepare("SELECT path, size_bytes, sha256 FROM artifact_versions").all()) add(row);
      }
      if (db.prepare("SELECT name FROM sqlite_master WHERE name='artifacts'").get()) {
        legacyAlreadyImported = db.prepare("SELECT COUNT(*) AS count FROM artifacts").get().count > 0;
      }
      if (db.prepare("SELECT name FROM sqlite_master WHERE name='meta'").get()) {
        legacyAlreadyImported ||= db.prepare("SELECT value FROM meta WHERE key='json_index_migrated'").get()?.value === "true";
      }
    } finally { db.close(); }
  }
  // A legacy index is authoritative only before its import into SQLite.
  if (indexFile && !legacyAlreadyImported) {
    const index = JSON.parse(readFileSync(indexFile, "utf8"));
    if (!Array.isArray(index.artifacts)) throw error("Invalid legacy index");
    for (const artifact of index.artifacts) for (const version of artifact.versions || []) add(version);
  }
  return [...refs.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function compareFile(root, expected) {
  const actual = fileInfo(safePath(root, expected.path));
  if (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) throw error(`Snapshot file verification failed: ${expected.path}`);
}

function snapshotDirectory(store, id) {
  if (!ID_PATTERN.test(id || "")) throw error("Invalid snapshot id");
  return safePath(store.home, `upgrade-backups/${id}`);
}

function manifestAt(store, id) {
  const directory = snapshotDirectory(store, id);
  const manifest = JSON.parse(readFileSync(safePath(directory, "manifest.json"), "utf8"));
  if (manifest.kind !== KIND || manifest.manifestVersion !== 1 || manifest.id !== id || !Array.isArray(manifest.files)) throw error("Invalid snapshot manifest");
  const seen = new Set();
  for (const file of manifest.files) {
    if (!file || (file.path !== "artifacty.sqlite" && file.path !== "index.json" && !file.path?.startsWith("artifacts/")) || seen.has(file.path)) throw error("Invalid snapshot file entry");
    safePath(directory, file.path);
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || !/^[a-f0-9]{64}$/i.test(file.sha256 || "")) throw error("Invalid snapshot file hash or size");
    seen.add(file.path);
  }
  return { directory, manifest };
}

export function verifyUpgradeBackup(input, id) {
  const store = paths(input);
  const { directory, manifest } = manifestAt(store, id);
  for (const file of manifest.files) compareFile(directory, file);
  const database = manifest.files.some((file) => file.path === "artifacty.sqlite") ? safePath(directory, "artifacty.sqlite") : null;
  const index = manifest.files.some((file) => file.path === "index.json") ? safePath(directory, "index.json") : null;
  if (!database && !index && !manifest.emptyStore) throw error("Snapshot has no database or legacy index");
  const refs = references(database, index);
  const listed = manifest.files.filter((file) => file.path.startsWith("artifacts/"));
  if (JSON.stringify(refs) !== JSON.stringify(listed)) throw error("Snapshot manifest does not match database file references");
  return { id, valid: true, filesVerified: manifest.files.length, ...manifest, path: directory };
}

export function listUpgradeBackups(input) {
  const store = paths(input);
  safePath(store.home, "upgrade-backups");
  if (!existsSync(store.backups)) return [];
  return readdirSync(store.backups).filter((id) => ID_PATTERN.test(id)).map((id) => {
    try { const { directory, manifest } = manifestAt(store, id); return { ...manifest, path: directory }; }
    catch (cause) { return { id, valid: false, error: cause.message }; }
  }).sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)));
}

function retentionCount() {
  const value = process.env.ARTIFACTY_UPGRADE_BACKUP_KEEP || "3";
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000) throw error("ARTIFACTY_UPGRADE_BACKUP_KEEP must be from 1 to 1000");
  return Number(value);
}

function pruneAutomatic(store) {
  const keep = retentionCount();
  const automatic = listUpgradeBackups(store).filter((item) => item.id.startsWith("auto-") && item.kind === KIND && ["schema-upgrade", "application-update"].includes(item.reason));
  for (const item of automatic.slice(keep)) {
    verifyUpgradeBackup(store, item.id);
    rmSync(snapshotDirectory(store, item.id), { recursive: true });
  }
}

function createSnapshot(store, options = {}) {
  const state = rawState(store);
  const reason = options.reason || "manual";
  const prefix = reason === "recovery" ? "recovery" : ["schema-upgrade", "application-update"].includes(reason) ? "auto" : "manual";
  const id = `${prefix}-${new Date().toISOString().replace(/[:.Z]/g, "-")}-${randomUUID()}`;
  privateDirectory(safePath(store.home, "upgrade-backups"));
  const pending = safePath(store.backups, `.pending-${randomUUID()}`);
  privateDirectory(pending);
  let guard;
  let published;
  let complete = false;
  try {
    const files = [];
    if (state.hasDatabase) {
      guard = new DatabaseSync(store.dbPath);
      guard.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      const source = new DatabaseSync(store.dbPath, { readOnly: true });
      try { source.prepare("VACUUM INTO ?").run(path.join(pending, "artifacty.sqlite")); }
      finally { source.close(); }
      chmodSync(path.join(pending, "artifacty.sqlite"), 0o600);
      files.push({ path: "artifacty.sqlite", ...fileInfo(path.join(pending, "artifacty.sqlite")) });
    }
    if (existsSync(store.indexPath)) {
      const original = safePath(store.home, "index.json");
      copyFileSync(original, path.join(pending, "index.json"));
      chmodSync(path.join(pending, "index.json"), 0o600);
      files.push({ path: "index.json", ...fileInfo(path.join(pending, "index.json")) });
    }
    const refs = references(state.hasDatabase ? path.join(pending, "artifacty.sqlite") : null, existsSync(path.join(pending, "index.json")) ? path.join(pending, "index.json") : null);
    for (const ref of refs) {
      const source = safePath(store.home, ref.path);
      const target = safePath(pending, ref.path);
      privateDirectory(path.dirname(target));
      copyFileSync(source, target);
      chmodSync(target, 0o600);
      compareFile(pending, ref);
      files.push(ref);
    }
    if (prefix === "auto") {
      const previous = listUpgradeBackups(store).find((item) => item.reason === reason
        && item.sourceSchemaVersion === state.schemaVersion && item.targetSchemaVersion === (options.targetSchemaVersion ?? null)
        && item.sourceAppVersion === state.appVersion && item.targetAppVersion === (options.targetAppVersion ?? null)
        && JSON.stringify(item.files) === JSON.stringify(files));
      if (previous) {
        try { return verifyUpgradeBackup(store, previous.id); } catch { /* Keep damaged backups for inspection; create a verified replacement. */ }
      }
    }
    const manifest = { kind: KIND, manifestVersion: 1, id, reason, createdAt: new Date().toISOString(), sourceSchemaVersion: state.schemaVersion, targetSchemaVersion: options.targetSchemaVersion ?? null, sourceAppVersion: state.appVersion, targetAppVersion: options.targetAppVersion ?? null, emptyStore: !state.hasData && !state.hasDatabase, files };
    durableWrite(path.join(pending, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    syncTree(pending);
    const destination = snapshotDirectory(store, id);
    renameSync(pending, destination);
    published = destination;
    syncDirectory(store.backups);
    const verified = verifyUpgradeBackup(store, id);
    complete = true;
    return verified;
  } finally {
    if (guard) { try { guard.exec("ROLLBACK"); } finally { guard.close(); } }
    if (existsSync(pending)) rmSync(pending, { recursive: true, force: true });
    if (published && !complete) rmSync(published, { recursive: true, force: true });
  }
}

function assertNoInterruptedRestore(store) {
  const pending = readdirSync(store.home).find((name) => /^\.restore-[a-f0-9-]{36}$/.test(name));
  if (pending) throw error(`Interrupted restore found at ${path.join(store.home, pending)}. Preserve this directory and the damaged store. Use its restore.json recoveryBackupId to restore into a new empty home.`, "RESTORE_INCOMPLETE");
}

export function createUpgradeBackup(input, options = {}) {
  const store = paths(input);
  const release = lockStore(store);
  try { assertNoInterruptedRestore(store); assertOffline(store); return createSnapshot(store, options); }
  finally { release(); }
}

// The lock spans the snapshot, migrations, and application-version marker.
// Existing application handles must be stopped separately before an upgrade.
export function openProtectedDatabase(input, targetVersion, initialize) {
  const store = paths(input);
  const release = lockStore(store);
  let db;
  try {
    assertNoInterruptedRestore(store);
    const state = rawState(store);
    if (state.schemaVersion > targetVersion) throw error(`Artifacty store was written by a newer version (store_version ${state.schemaVersion}) than this build supports (STORE_VERSION ${targetVersion}). Upgrade artifacty before opening this store.`, "NEWER_STORE_VERSION");
    const schemaUpgrade = state.hasData && (state.schemaVersion == null || state.schemaVersion < targetVersion);
    const appUpdate = state.hasData && process.env.ARTIFACTY_BACKUP_ON_UPDATE === "true" && state.appVersion !== APP_VERSION;
    if (schemaUpgrade || appUpdate) {
      retentionCount();
      assertOffline(store, true);
      createSnapshot(store, { reason: schemaUpgrade ? "schema-upgrade" : "application-update", targetSchemaVersion: targetVersion, targetAppVersion: APP_VERSION });
    }
    privateDirectory(store.artifactsDir);
    db = new DatabaseSync(store.dbPath);
    initialize(db);
    if (state.appVersion !== APP_VERSION) db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('application_version', ?)").run(APP_VERSION);
    if (schemaUpgrade || appUpdate) pruneAutomatic(store);
    return db;
  } catch (cause) { db?.close(); throw cause; }
  finally { release(); }
}

export function restoreUpgradeBackup(input, id, { confirm } = {}) {
  if (confirm !== "restore-store") throw error('Restore requires confirm: "restore-store"', "RESTORE_CONFIRMATION_REQUIRED");
  const store = paths(input);
  const release = lockStore(store);
  let stage;
  let preserveStage = false;
  try {
    assertNoInterruptedRestore(store);
    assertOffline(store);
    const snapshot = verifyUpgradeBackup(store, id);
    let recovery;
    try { recovery = createSnapshot(store, { reason: "recovery" }); }
    catch (cause) {
      throw error(`Cannot verify the current store for a recovery snapshot: ${cause.message}. Preserve the damaged store and copy the selected snapshot into a new empty home's upgrade-backups directory, then restore there.`, "RECOVERY_BACKUP_FAILED");
    }
    stage = safePath(store.home, `.restore-${randomUUID()}`);
    privateDirectory(stage);
    privateDirectory(path.join(stage, "artifacts"));
    for (const file of snapshot.files) {
      const target = safePath(stage, file.path);
      privateDirectory(path.dirname(target));
      copyFileSync(safePath(snapshot.path, file.path), target);
      chmodSync(target, 0o600);
      compareFile(stage, file);
    }
    const previous = path.join(stage, "previous");
    privateDirectory(previous);
    const names = ["artifacty.sqlite", "artifacty.sqlite-wal", "artifacty.sqlite-shm", "index.json", "artifacts"];
    const moved = [];
    const installed = [];
    durableWrite(path.join(stage, "restore.json"), JSON.stringify({ snapshotId: id, recoveryBackupId: recovery.id, createdAt: new Date().toISOString() }));
    syncTree(stage);
    syncDirectory(store.home);
    try {
      for (const name of names) {
        const current = safePath(store.home, name);
        if (existsSync(current)) { renameSync(current, path.join(previous, name)); moved.push(name); }
      }
      for (const name of ["artifacty.sqlite", "index.json", "artifacts"]) {
        const source = path.join(stage, name);
        if (existsSync(source)) { renameSync(source, path.join(store.home, name)); installed.push(name); }
      }
      syncDirectory(previous);
      syncDirectory(store.home);
    } catch (cause) {
      try {
        for (const name of installed.reverse()) rmSync(path.join(store.home, name), { recursive: true, force: true });
        for (const name of moved.reverse()) renameSync(path.join(previous, name), path.join(store.home, name));
        syncDirectory(store.home);
      } catch (rollbackError) {
        preserveStage = true;
        throw error(`Restore and rollback failed. Preserve ${stage}; recovery snapshot ${recovery.id}. Original error: ${cause.message}; rollback error: ${rollbackError.message}`, "RESTORE_INCOMPLETE");
      }
      throw cause;
    }
    return { restored: id, recoveryBackupId: recovery.id };
  } finally {
    if (stage && !preserveStage && existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    release();
  }
}
