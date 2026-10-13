import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore, createUser, setUserActive, resetUserPassword, verifyUserPassword, createSession, getSessionUser, createApiToken, authenticateApiToken, openDatabase } from "../src/lib/storage.js";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-password-reset-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = createStore({ home });
  const admin = await createUser(store, { email: "admin@example.test", password: "old-password", role: "admin" });
  const user = await createUser(store, { email: "user@example.test", password: "old-password", role: "user" });
  return { store, admin, user, options: { access: { userId: admin.id }, audit: { surface: "web", actor: "spoofed" } } };
}

test("temporary reset replaces password, requires change and revokes sessions while preserving API tokens", async (t) => {
  const { store, admin, user, options } = await fixture(t);
  const session = await createSession(store, user.id);
  const adminSession = await createSession(store, admin.id);
  const token = await createApiToken(store, user.id, { scopes: ["read", "write"] });
  const result = await resetUserPassword(store, user.id, options);
  assert.match(result.temporaryPassword, /^tmp_[A-Za-z0-9_-]{24}$/);
  assert.equal(result.user.passwordResetRequired, true);
  assert.equal(result.user.password_hash, undefined);
  assert.equal(await verifyUserPassword(store, user.email, "old-password"), null);
  assert.equal((await verifyUserPassword(store, user.email, result.temporaryPassword)).passwordResetRequired, true);
  assert.equal(await getSessionUser(store, session.token), null);
  assert.equal((await getSessionUser(store, adminSession.token)).id, admin.id);
  assert.deepEqual((await authenticateApiToken(store, token.token)).scopes, ["read", "write"]);
  const db = openDatabase(store);
  try {
    const rows = db.prepare("SELECT actor,metadata_json FROM audit_log WHERE action='user-password-reset'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, admin.email);
    assert.deepEqual(JSON.parse(rows[0].metadata_json), { targetUserId: user.id });
    for (const table of ["users", "audit_log", "sessions", "api_tokens"]) {
      assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes(result.temporaryPassword), false);
    }
  } finally { db.close(); }
  assert.notEqual((await resetUserPassword(store, user.id, options)).temporaryPassword, result.temporaryPassword);
});

test("reset requires an active database administrator and an existing target", async (t) => {
  const { store, admin, user, options } = await fixture(t);
  for (const access of [undefined, { role: "admin" }, { userId: user.id, role: "admin" }]) {
    await assert.rejects(resetUserPassword(store, user.id, { access }), { code: "ADMIN_REQUIRED", statusCode: 403 });
  }
  await assert.rejects(resetUserPassword(store, "missing", options), { code: "USER_NOT_FOUND", statusCode: 404 });
  await setUserActive(store, admin.id, false);
  await assert.rejects(resetUserPassword(store, user.id, options), { code: "ADMIN_REQUIRED" });
  assert.notEqual(await verifyUserPassword(store, user.email, "old-password"), null);
});

test("self reset revokes the current session and disabled targets stay disabled", async (t) => {
  const { store, admin, user, options } = await fixture(t);
  await setUserActive(store, user.id, false);
  const disabled = await resetUserPassword(store, user.id, options);
  assert.equal(disabled.user.active, false);
  assert.equal(await verifyUserPassword(store, user.email, disabled.temporaryPassword), null);
  const session = await createSession(store, admin.id);
  const self = await resetUserPassword(store, admin.id, options);
  assert.equal(await getSessionUser(store, session.token), null);
  assert.equal((await verifyUserPassword(store, admin.email, self.temporaryPassword)).passwordResetRequired, true);
});
