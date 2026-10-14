import { createRequire } from "node:module";
import { closeSync, lstatSync, openSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const error = (message, code) => Object.assign(new Error(message), { code });

function sanitizedSqliteError(cause) {
  const code = /^SQLITE_[A-Z_]+$/.test(cause?.code || "") ? cause.code : "ENCRYPTED_DATABASE_OPERATION_FAILED";
  return error("Encrypted database operation failed.", code);
}

/** Experimental sync adapter. SQL is trusted application code, never user input. */
export function openEncryptedDatabase(file, { key, readOnly = false } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw error("Encrypted databases require a 32-byte Buffer key.", "INVALID_DATABASE_KEY");
  }
  if (typeof file !== "string" || !file.trim() || file === ":memory:" || file.startsWith("file:") || file.includes("\0") || typeof readOnly !== "boolean") {
    throw error("Encrypted databases require a local file and a boolean readOnly option.", "INVALID_DATABASE_OPTIONS");
  }
  let Database;
  try { Database = require("better-sqlite3-multiple-ciphers"); }
  catch { throw error("The encrypted SQLite driver is unavailable.", "ENCRYPTED_DATABASE_DRIVER_UNAVAILABLE"); }

  let database;
  const copiedKey = Buffer.from(key);
  try {
    database = new Database(file, { readonly: readOnly, fileMustExist: readOnly, timeout: 5000 });
    // Cipher selection is the only pre-key configuration. Never interpolate a
    // key into SQL, and authenticate the database before returning a handle.
    database.pragma("cipher='chacha20'");
    if (database.key(copiedKey) !== 0) throw error("Key initialization failed.", "ENCRYPTED_DATABASE_OPEN_FAILED");
    database.pragma("temp_store=MEMORY");
    database.pragma("foreign_keys=ON");
    database.pragma("busy_timeout=5000");
    if (database.pragma("cipher", { simple: true }) !== "chacha20" ||
        database.pragma("temp_store", { simple: true }) !== 2 ||
        database.pragma("foreign_keys", { simple: true }) !== 1 ||
        database.pragma("busy_timeout", { simple: true }) !== 5000) {
      throw error("Required database configuration could not be applied.", "ENCRYPTED_DATABASE_OPEN_FAILED");
    }
    const checks = database.pragma("quick_check");
    if (checks.length !== 1 || checks[0].quick_check !== "ok") throw error("Database integrity check failed.", "ENCRYPTED_DATABASE_OPEN_FAILED");
  } catch {
    try { database?.close(); } catch { /* Preserve the fixed, sanitized error. */ }
    throw error("Could not open or authenticate the encrypted database.", "ENCRYPTED_DATABASE_OPEN_FAILED");
  } finally {
    copiedKey.fill(0);
  }

  const invoke = (operation) => {
    try { return operation(); }
    catch (cause) { throw sanitizedSqliteError(cause); }
  };
  const adapter = Object.freeze({
    prepare(sql) {
      const statement = invoke(() => database.prepare(sql));
      return Object.freeze({
        get: (...parameters) => invoke(() => statement.get(...parameters)),
        all: (...parameters) => invoke(() => statement.all(...parameters)),
        run: (...parameters) => invoke(() => statement.run(...parameters))
      });
    },
    exec(sql) { invoke(() => database.exec(sql)); return adapter; },
    close() { invoke(() => database.close()); }
  });
  return adapter;
}


/** Build a verified copy; the caller must keep the target directory private. */
export function convertDatabaseCopy(sourceFile, targetFile, { sourceKey = null, targetKey = null } = {}) {
  for (const key of [sourceKey, targetKey]) {
    if (key !== null && (!Buffer.isBuffer(key) || key.length !== 32)) {
      throw error("Database keys must be null or 32-byte Buffers.", "INVALID_DATABASE_KEY");
    }
  }
  const keys = [sourceKey && Buffer.from(sourceKey), targetKey && Buffer.from(targetKey)];
  let source;
  let target;
  let created;
  let destination;
  const validatePath = (file) => {
    if (typeof file !== "string" || !file.trim() || file === ":memory:" || file.startsWith("file:") || file.includes("\0")) throw new Error();
    const absolute = path.resolve(file);
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep)) {
      current = path.join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) throw new Error(); }
      catch (cause) { if (cause.code !== "ENOENT") throw cause; }
    }
    return absolute;
  };
  const configure = (db, key) => {
    db.pragma("cipher='chacha20'");
    if (key && db.key(key) !== 0) throw new Error();
    db.pragma("temp_store=MEMORY");
    if (db.pragma("temp_store", { simple: true }) !== 2) throw new Error();
  };
  const verify = (db) => {
    const rows = db.pragma("integrity_check");
    if (rows.length !== 1 || rows[0].integrity_check !== "ok") throw new Error();
  };
  try {
    const origin = validatePath(sourceFile);
    destination = validatePath(targetFile);
    if (!lstatSync(origin).isFile() || realpathSync(origin) === path.join(realpathSync(path.dirname(destination)), path.basename(destination))) throw new Error();
    // Exclusive creation also rejects existing aliases/hardlinks to the source.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { lstatSync(destination + suffix); throw new Error(); }
      catch (cause) { if (cause.code !== "ENOENT") throw cause; }
    }
    const Database = require("better-sqlite3-multiple-ciphers");
    source = new Database(origin, { readonly: true, fileMustExist: true, timeout: 5000 });
    configure(source, keys[0]);
    verify(source);
    const fd = openSync(destination, "wx", 0o600);
    try { created = lstatSync(destination); } finally { closeSync(fd); }
    source.prepare("VACUUM INTO ?").run(destination);
    source.close();
    source = null;
    target = new Database(destination, { fileMustExist: true, timeout: 5000 });
    configure(target, keys[0]);
    target.pragma("journal_mode=DELETE");
    if (target.pragma("journal_mode", { simple: true }) !== "delete") throw new Error();
    verify(target);
    if (target.rekey(keys[1] || Buffer.alloc(0)) !== 0) throw new Error();
    verify(target);
    target.close();
    target = new Database(destination, { readonly: true, fileMustExist: true, timeout: 5000 });
    configure(target, keys[1]);
    verify(target);
    target.close();
    target = null;
    return { path: destination, encrypted: targetKey !== null };
  } catch {
    try { target?.close(); } catch { /* Keep errors sanitized. */ }
    try { source?.close(); } catch { /* Keep errors sanitized. */ }
    if (created) {
      try {
        const current = lstatSync(destination);
        if (!current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino) {
          for (const suffix of ["-wal", "-shm", "-journal", ""]) {
            try { unlinkSync(destination + suffix); } catch { /* Never replace the original failure. */ }
          }
        }
      } catch { /* Never remove a replacement file. */ }
    }
    throw error("Could not create or verify the database copy.", "DATABASE_COPY_FAILED");
  } finally {
    for (const key of keys) key?.fill(0);
  }
}
