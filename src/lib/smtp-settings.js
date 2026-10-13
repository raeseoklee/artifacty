import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdirSync, lstatSync, readFileSync, openSync, writeFileSync, closeSync, fsyncSync } from "node:fs";
import path from "node:path";
import { openDatabase, transaction, insertAuditRow } from "./storage.js";

const AAD = Buffer.from("artifacty:smtp-settings:v1");
const defaults = () => ({ enabled: false, host: "", port: 587, tlsMode: "starttls", username: "", password: "", from: "" });
const fail = (code, statusCode = 500) => Object.assign(new Error(code === "SMTP_KEY_UNAVAILABLE"
  ? "SMTP encryption key is unavailable. Restore the original secrets/smtp.key before changing settings."
  : code === "SMTP_SETTINGS_INVALID" ? "Invalid SMTP settings. Check required fields and TLS configuration."
  : "SMTP settings could not be accessed securely."), { code, statusCode });

function checkedPath(file, directory, mode) {
  let info;
  try { info = lstatSync(file); } catch (error) { if (error.code === "ENOENT") return false; throw fail("SMTP_KEY_UNAVAILABLE"); }
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      (process.platform !== "win32" && ((info.mode & 0o777) !== mode || (process.getuid && info.uid !== process.getuid())))) {
    throw fail("SMTP_KEY_UNSAFE");
  }
  return true;
}

function keyFor(store, create) {
  const directory = path.join(store.home, "secrets");
  const file = path.join(directory, "smtp.key");
  if (!checkedPath(directory, true, 0o700)) {
    if (!create) throw fail("SMTP_KEY_UNAVAILABLE");
    mkdirSync(directory, { mode: 0o700 });
    checkedPath(directory, true, 0o700);
  }
  if (!checkedPath(file, false, 0o600)) {
    if (!create) throw fail("SMTP_KEY_UNAVAILABLE");
    let descriptor;
    try {
      descriptor = openSync(file, "wx", 0o600);
      writeFileSync(descriptor, randomBytes(32));
      fsyncSync(descriptor);
    } catch (error) { if (error.code !== "EEXIST") throw fail("SMTP_KEY_UNAVAILABLE"); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  checkedPath(file, false, 0o600);
  let key;
  try { key = readFileSync(file); } catch { throw fail("SMTP_KEY_UNAVAILABLE"); }
  if (key.length !== 32) throw fail("SMTP_KEY_UNAVAILABLE");
  return key;
}

function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.enabled !== "boolean") throw fail("SMTP_SETTINGS_INVALID", 400);
  for (const field of ["host", "username", "password", "from"]) {
    if (typeof input[field] !== "string" || Buffer.byteLength(input[field], "utf8") > 4096 || /[\r\n\0]/.test(input[field])) throw fail("SMTP_SETTINGS_INVALID", 400);
  }
  if (Boolean(input.username) !== Boolean(input.password)) throw fail("SMTP_SETTINGS_INVALID", 400);
  if (!input.host.trim() || /[\s/@?#]/.test(input.host) || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(input.from) ||
      !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || !["tls", "starttls"].includes(input.tlsMode)) throw fail("SMTP_SETTINGS_INVALID", 400);
  return { enabled: input.enabled, host: input.host, port: input.port, tlsMode: input.tlsMode, username: input.username, password: input.password, from: input.from };
}

function readConfig(db, store) {
  const row = db.prepare("SELECT value FROM meta WHERE key='smtp_settings'").get();
  if (!row) return defaults();
  const key = keyFor(store, false);
  try {
    const envelope = JSON.parse(row.value);
    if (envelope.v !== 1 || !["iv", "tag", "ciphertext"].every((field) => typeof envelope[field] === "string")) throw new Error();
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return validate(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8")));
  } catch { throw fail("SMTP_SETTINGS_UNREADABLE"); }
}

function redact(config) {
  const { password, ...settings } = config;
  return { ...settings, hasPassword: Boolean(password) };
}

export async function getSmtpDeliveryConfig(store) {
  const db = openDatabase(store);
  try { return readConfig(db, store); } finally { db.close(); }
}

export async function getSmtpSettings(store) {
  return redact(await getSmtpDeliveryConfig(store));
}

export async function saveSmtpSettings(store, input, { access, audit } = {}) {
  const db = openDatabase(store);
  try {
    return transaction(db, () => {
      const actor = db.prepare("SELECT id,email FROM users WHERE id=? AND active=1 AND role='admin'").get(access?.userId || "");
      if (!actor) throw Object.assign(new Error("An active administrator is required"), { code: "ADMIN_REQUIRED", statusCode: 403 });
      const previous = readConfig(db, store);
      const config = validate({ ...input, password: input?.username === "" ? "" : input?.password === "" ? previous.password : input?.password });
      const key = keyFor(store, true);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
      const envelope = { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('smtp_settings',?)").run(JSON.stringify(envelope));
      insertAuditRow(db, { action: "smtp-settings-change", artifactId: "", audit: { surface: audit?.surface, actor: actor.email, userId: actor.id }, metadata: { enabled: config.enabled, tlsMode: config.tlsMode } });
      return redact(config);
    });
  } finally { db.close(); }
}
