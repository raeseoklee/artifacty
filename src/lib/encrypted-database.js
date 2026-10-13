import { createRequire } from "node:module";

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
