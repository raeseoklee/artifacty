import { randomUUID, createHash } from "node:crypto";
import { lstatSync, realpathSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, openSync, closeSync, fsyncSync, chmodSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { convertDatabaseCopy, openEncryptedDatabase } from "./encrypted-database.js";
import { encryptContent, decryptContent } from "./encrypted-content.js";

const fail = () => Object.assign(new Error("Store generation could not be built or verified safely."), { code: "STORE_GENERATION_INVALID" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function context(value) {
  if (value === null) return;
  if (!value || !Buffer.isBuffer(value.key) || value.key.length !== 32 || !UUID.test(value.storeId) || !UUID.test(value.keyId)) throw fail();
}
function inspect(file, optional = false) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw fail();
    } catch (error) { if (optional && error.code === "ENOENT" && current === absolute) return null; throw error; }
  }
  return lstatSync(absolute);
}
function blobPath(home, value) {
  if (typeof value !== "string") throw fail();
  const relative = value.replaceAll("\\", "/");
  if (!relative.startsWith("artifacts/") || relative.split("/").some((part) => !part || part === "." || part === "..") || path.isAbsolute(relative) || relative.includes("\0")) throw fail();
  const file = path.resolve(home, relative);
  if (!file.startsWith(`${home}${path.sep}`) || !inspect(file).isFile()) throw fail();
  return file;
}
function assertOffline(home) {
  for (const name of ["server.pid", "server.json"]) {
    const file = path.join(home, name);
    const stat = inspect(file, true);
    if (!stat) continue;
    if (!stat.isFile() || stat.size > 16384) throw fail();
    const value = readFileSync(file, "utf8");
    const pid = name.endsWith(".json") ? JSON.parse(value).pid : Number(value.trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw fail();
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") continue; throw fail(); }
    throw fail();
  }
}
function manifest(home, encryption) {
  context(encryption);
  const file = path.join(home, "generation.json");
  const stat = inspect(file, true);
  if (!stat) { if (encryption) throw fail(); return; }
  if (!stat.isFile() || stat.size > 4096) throw fail();
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.formatVersion !== 1 || value.mode !== (encryption ? "encrypted" : "plaintext") ||
      (encryption && (value.storeId !== encryption.storeId || value.keyId !== encryption.keyId))) throw fail();
}
function open(home, encryption) {
  const file = path.join(home, "artifacty.sqlite");
  if (!inspect(file).isFile()) throw fail();
  for (const suffix of ["-wal", "-shm", "-journal"]) inspect(file + suffix, true);
  return encryption ? openEncryptedDatabase(file, { key: encryption.key, readOnly: true }) : new DatabaseSync(file, { readOnly: true });
}
function rows(db) {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length) throw fail();
  if (db.prepare("SELECT id FROM artifacts a WHERE NOT EXISTS (SELECT 1 FROM artifact_versions v WHERE v.artifact_id=a.id AND v.version=a.latest_version) LIMIT 1").get()) throw fail();
  return db.prepare("SELECT artifact_id,version,path,size_bytes,sha256 FROM artifact_versions ORDER BY artifact_id,version").all();
}
function bytes(home, row, encryption) {
  if (!Number.isSafeInteger(row.version) || row.version < 1 || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0 || !/^[a-f0-9]{64}$/.test(row.sha256)) throw fail();
  const stored = readFileSync(blobPath(home, row.path));
  const plaintext = encryption ? decryptContent(stored, { ...encryption, artifactId: row.artifact_id, version: row.version }) : stored;
  if (plaintext.length !== row.size_bytes || createHash("sha256").update(plaintext).digest("hex") !== row.sha256) throw fail();
  return plaintext;
}
function syncTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) syncTree(file);
    else { chmodSync(file, 0o600); const fd = openSync(file, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); } }
  }
  if (process.platform !== "win32") { const fd = openSync(directory, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
}

export function verifyStoreGeneration(input, { encryption = null } = {}) {
  let db;
  try {
    const home = path.resolve(input);
    if (!inspect(home).isDirectory()) throw fail();
    manifest(home, encryption);
    db = open(home, encryption);
    const versions = rows(db);
    for (const row of versions) bytes(home, row, encryption);
    return { verified: true, mode: encryption ? "encrypted" : "plaintext", versionCount: versions.length };
  } catch { throw fail(); }
  finally { db?.close(); }
}

/** Offline conversion only. The caller must stop every writer before invocation. */
export function buildStoreGeneration(sourceInput, destinationInput, { sourceEncryption = null, targetEncryption = null } = {}) {
  let pending;
  let db;
  try {
    context(sourceEncryption); context(targetEncryption);
    const source = path.resolve(sourceInput);
    const destination = path.resolve(destinationInput);
    if (!inspect(source).isDirectory() || inspect(destination, true)) throw fail();
    const parent = path.dirname(destination);
    if (!inspect(parent).isDirectory()) throw fail();
    const canonicalSource = realpathSync(source);
    const canonicalDestination = path.join(realpathSync(parent), path.basename(destination));
    if (canonicalDestination === canonicalSource || canonicalDestination.startsWith(`${canonicalSource}${path.sep}`) || canonicalSource.startsWith(`${canonicalDestination}${path.sep}`)) throw fail();
    manifest(source, sourceEncryption);
    assertOffline(source);
    // Check source paths, including SQLite sidecars, before the converter opens them.
    const probe = open(source, sourceEncryption); probe.close();
    pending = path.join(parent, `.generation-${randomUUID()}`);
    mkdirSync(pending, { mode: 0o700 });
    mkdirSync(path.join(pending, "artifacts"), { mode: 0o700 });
    const databaseFile = path.join(pending, "artifacty.sqlite");
    convertDatabaseCopy(path.join(source, "artifacty.sqlite"), databaseFile, { sourceKey: sourceEncryption?.key || null, targetKey: targetEncryption?.key || null });
    db = targetEncryption ? openEncryptedDatabase(databaseFile, { key: targetEncryption.key }) : new DatabaseSync(databaseFile);
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    for (const row of rows(db)) {
      const plaintext = bytes(source, row, sourceEncryption);
      const relative = `artifacts/${randomUUID()}.${targetEncryption ? "enc" : "blob"}`;
      const content = targetEncryption ? encryptContent(plaintext, { ...targetEncryption, artifactId: row.artifact_id, version: row.version }) : plaintext;
      writeFileSync(path.join(pending, relative), content, { flag: "wx", mode: 0o600 });
      db.prepare("UPDATE artifact_versions SET path=? WHERE artifact_id=? AND version=?").run(relative, row.artifact_id, row.version);
    }
    db.exec("COMMIT"); db.close(); db = null;
    const identity = targetEncryption ? { storeId: targetEncryption.storeId, keyId: targetEncryption.keyId } : {};
    writeFileSync(path.join(pending, "generation.json"), JSON.stringify({ formatVersion: 1, mode: targetEncryption ? "encrypted" : "plaintext", ...identity }), { flag: "wx", mode: 0o600 });
    const result = verifyStoreGeneration(pending, { encryption: targetEncryption });
    syncTree(pending);
    if (inspect(destination, true)) throw fail();
    renameSync(pending, destination); pending = null;
    if (process.platform !== "win32") { const fd = openSync(parent, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
    return { ...result, path: destination };
  } catch { throw fail(); }
  finally { try { db?.close(); } finally { if (pending) rmSync(pending, { recursive: true, force: true }); } }
}
