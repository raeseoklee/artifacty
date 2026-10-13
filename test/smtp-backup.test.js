import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore, createUser } from "../src/lib/storage.js";
import { saveSmtpSettings, getSmtpDeliveryConfig } from "../src/lib/smtp-settings.js";
import { createUpgradeBackup, restoreUpgradeBackup } from "../src/lib/upgrade-backup.js";

test("upgrade snapshots exclude the SMTP key and same-home rollback retains the key and restores encrypted configuration", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-smtp-backup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = createStore({ home });
  const admin = await createUser(store, { email: "admin@example.test", role: "admin", password: "fixture-password" });
  const config = { enabled: true, host: "smtp.example.test", port: 587, tlsMode: "starttls", username: "fixture-user", password: "fixture-secret", from: "sender@example.test" };
  await saveSmtpSettings(store, config, { access: { userId: admin.id } });
  const key = await readFile(path.join(home, "secrets", "smtp.key"));
  const snapshot = createUpgradeBackup(store);
  assert.ok(snapshot.files.every(file => !file.path.startsWith("secrets/")));
  await saveSmtpSettings(store, { ...config, password: "replacement-secret" }, { access: { userId: admin.id } });
  restoreUpgradeBackup(store, snapshot.id, { confirm: "restore-store" });
  assert.deepEqual(await readFile(path.join(home, "secrets", "smtp.key")), key);
  assert.deepEqual(await getSmtpDeliveryConfig(store), config);
});
