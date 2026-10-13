import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, chmod, symlink, lstat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore, createUser, openDatabase } from "../src/lib/storage.js";
import { exportStoreToString, importStoreFromString } from "../src/lib/backup.js";
import { getSmtpSettings, getSmtpDeliveryConfig, saveSmtpSettings } from "../src/lib/smtp-settings.js";
const config = { enabled: true, host: "smtp.secret.example", port: 587, tlsMode: "starttls", username: "secret-user", password: "secret-password", from: "sender@secret.example" };
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-smtp-settings-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = createStore({ home });
  const admin = await createUser(store, { email: "admin@example.test", password: "password123", role: "admin" });
  return { store, options: { access: { userId: admin.id } }, key: path.join(home, "secrets", "smtp.key") };
}
function envelope(store, value) {
  const db = openDatabase(store);
  try {
    if (value !== undefined) db.prepare("UPDATE meta SET value=? WHERE key='smtp_settings'").run(value);
    return db.prepare("SELECT value FROM meta WHERE key='smtp_settings'").get()?.value;
  } finally { db.close(); }
}

test("entire SMTP config is encrypted, redacted publicly, and audited without SMTP values", async (t) => {
  const { store, options, key } = await fixture(t);
  assert.equal((await getSmtpSettings(store)).enabled, false);
  const result = await saveSmtpSettings(store, config, options);
  assert.equal(result.password, undefined);
  assert.equal(result.hasPassword, true);
  assert.deepEqual(await getSmtpDeliveryConfig(store), config);
  const first = envelope(store);
  await saveSmtpSettings(store, { ...config, password: "" }, options);
  assert.equal((await getSmtpDeliveryConfig(store)).password, config.password);
  assert.notEqual(JSON.parse(first).iv, JSON.parse(envelope(store)).iv);
  assert.equal((await readFile(key)).length, 32);
  if (process.platform !== "win32") assert.equal((await lstat(key)).mode & 0o777, 0o600);
  const db = openDatabase(store);
  try {
    const persisted = JSON.stringify(db.prepare("SELECT * FROM meta").all()) + JSON.stringify(db.prepare("SELECT * FROM audit_log").all());
    for (const value of [config.host, config.username, config.password, config.from]) assert.equal(persisted.includes(value), false);
  } finally { db.close(); }
});

test("validation and authorization reject unsafe inputs without revealing values", async (t) => {
  const { store, options } = await fixture(t);
  await assert.rejects(saveSmtpSettings(store, config, { access: { role: "admin" } }), { code: "ADMIN_REQUIRED" });
  for (const changes of [{ port: 0 }, { port: "587" }, { tlsMode: "none" }, { host: "smtp\r\nsecret" }, { from: "a@b.test\r\nBcc: secret" }, { password: "x".repeat(4097) }, { enabled: "true" }]) {
    await assert.rejects(saveSmtpSettings(store, { ...config, ...changes }, options), (error) => error.statusCode === 400 && !error.message.includes("secret"));
  }
  assert.equal(envelope(store), undefined);
});

test("ciphertext tampering fails closed and missing keys never regenerate or overwrite encrypted settings", async (t) => {
  const { store, options, key } = await fixture(t);
  await saveSmtpSettings(store, config, options);
  const original = envelope(store);
  const changed = JSON.parse(original);
  const bytes = Buffer.from(changed.ciphertext, "base64"); bytes[0] ^= 1; changed.ciphertext = bytes.toString("base64");
  envelope(store, JSON.stringify(changed));
  await assert.rejects(getSmtpDeliveryConfig(store), { code: "SMTP_SETTINGS_UNREADABLE" });
  envelope(store, original);
  await rm(key);
  await assert.rejects(getSmtpSettings(store), { code: "SMTP_KEY_UNAVAILABLE" });
  await assert.rejects(saveSmtpSettings(store, config, options), { code: "SMTP_KEY_UNAVAILABLE" });
  assert.equal(envelope(store), original);
  await assert.rejects(lstat(key), { code: "ENOENT" });
});

test("unsafe POSIX permissions and symlink keys are refused", { skip: process.platform === "win32" }, async (t) => {
  const { store, options, key } = await fixture(t);
  await saveSmtpSettings(store, config, options);
  await chmod(key, 0o644);
  await assert.rejects(getSmtpSettings(store), { code: "SMTP_KEY_UNSAFE" });
  await chmod(key, 0o600);
  await chmod(path.dirname(key), 0o755);
  await assert.rejects(getSmtpSettings(store), { code: "SMTP_KEY_UNSAFE" });
  await chmod(path.dirname(key), 0o700);
  await rm(key);
  await symlink(path.join(store.home, "missing"), key);
  await assert.rejects(getSmtpSettings(store), { code: "SMTP_KEY_UNSAFE" });
});

test("full JSON backup carries ciphertext but requires the separately restored key", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);
  await saveSmtpSettings(source.store, config, source.options);
  const bundle = await exportStoreToString(source.store, { scope: "full" });
  assert.equal(bundle.includes(config.password), false);
  await importStoreFromString(target.store, bundle, { confirm: "replace-all", forceUsers: true });
  await assert.rejects(getSmtpSettings(target.store), { code: "SMTP_KEY_UNAVAILABLE" });
  await mkdir(path.dirname(target.key), { mode: 0o700 });
  await writeFile(target.key, await readFile(source.key), { mode: 0o600 });
  assert.deepEqual(await getSmtpDeliveryConfig(target.store), config);
});


test("SMTP authentication requires a credential pair and clearing username disables authentication", async (t) => {
  const { store, options } = await fixture(t);
  await assert.rejects(saveSmtpSettings(store, { ...config, password: "" }, options), { code: "SMTP_SETTINGS_INVALID", statusCode: 400 });
  await saveSmtpSettings(store, config, options);
  await saveSmtpSettings(store, { ...config, password: "" }, options);
  assert.equal((await getSmtpDeliveryConfig(store)).password, config.password);
  const cleared = await saveSmtpSettings(store, { ...config, username: "", password: "" }, options);
  assert.equal(cleared.hasPassword, false);
  assert.equal(cleared.username, "");
  assert.equal((await getSmtpDeliveryConfig(store)).password, "");
  await assert.rejects(saveSmtpSettings(store, { ...config, password: "" }, options), { code: "SMTP_SETTINGS_INVALID" });
});
