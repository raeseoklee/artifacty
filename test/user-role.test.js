import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore, createUser, setUserActive, setUserRole, listUsers, openDatabase, createSession, getSessionUser, createApiToken, authenticateApiToken, createArtifact, canReadArtifactEvent } from "../src/lib/storage.js";
import { requireScope } from "../src/lib/security.js";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-user-role-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = createStore({ home });
  const admin = await createUser(store, { email: "admin@example.test", role: "admin", password: "password-123" });
  const user = await createUser(store, { email: "user@example.test", role: "user", password: "password-123" });
  return { store, admin, user, options: { access: { userId: admin.id, role: "admin" }, audit: { surface: "web", actor: "spoofed" } } };
}

test("role changes require an active database administrator and strict roles", async (t) => {
  const { store, admin, user, options } = await fixture(t);
  for (const access of [undefined, { role: "admin" }, { userId: user.id, role: "admin" }, { userId: "missing", role: "admin" }]) {
    await assert.rejects(setUserRole(store, user.id, "admin", { access }), { code: "ADMIN_REQUIRED", statusCode: 403 });
  }
  for (const role of ["ADMIN", "", null, "owner", {}]) await assert.rejects(setUserRole(store, user.id, role, options), { code: "INVALID_USER_ROLE", statusCode: 400 });
  await assert.rejects(setUserRole(store, "missing", "admin", options), { code: "USER_NOT_FOUND", statusCode: 404 });
  await setUserActive(store, admin.id, false);
  await assert.rejects(setUserRole(store, user.id, "admin", options), { code: "ADMIN_REQUIRED" });
});

test("last active administrator is protected and inactive administrators do not count", async (t) => {
  const { store, admin, user, options } = await fixture(t);
  await assert.rejects(setUserRole(store, admin.id, "user", options), { code: "LAST_ADMIN_REQUIRED", statusCode: 409 });
  await setUserRole(store, user.id, "admin", options);
  await setUserActive(store, user.id, false);
  await assert.rejects(setUserRole(store, admin.id, "user", options), { code: "LAST_ADMIN_REQUIRED" });
  assert.equal((await listUsers(store)).find((entry) => entry.id === admin.id).role, "admin");
});

test("promotion, no-op, demotion and restoration audit trusted actor identity", async (t) => {
  const { store, admin, user, options } = await fixture(t);
  await setUserRole(store, admin.id, "admin", options);
  await setUserRole(store, user.id, "admin", options);
  await setUserRole(store, admin.id, "user", options);
  await assert.rejects(setUserRole(store, admin.id, "admin", options), { code: "ADMIN_REQUIRED" });
  await setUserRole(store, admin.id, "admin", { access: { userId: user.id, role: "user" } });
  const db = openDatabase(store);
  try {
    const rows = db.prepare("SELECT actor, metadata_json FROM audit_log WHERE action='user-role-change' ORDER BY rowid").all();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].actor, admin.email);
    assert.deepEqual(JSON.parse(rows[0].metadata_json), { targetUserId: user.id, fromRole: "user", toRole: "admin", actorUserId: admin.id });
    assert.equal(rows[2].actor, user.email);
  } finally { db.close(); }
});

test("existing sessions and admin-scoped tokens immediately follow the current role", async (t) => {
  const { store, admin, user, options } = await fixture(t);
  await setUserRole(store, user.id, "admin", options);
  const session = await createSession(store, admin.id);
  const token = await createApiToken(store, admin.id, { scopes: ["read", "write", "admin"] });
  requireScope(await authenticateApiToken(store, token.token), "admin");
  await setUserRole(store, admin.id, "user", options);
  assert.equal((await getSessionUser(store, session.token)).role, "user");
  const auth = await authenticateApiToken(store, token.token);
  assert.deepEqual(auth.scopes, ["read", "write"]);
  assert.throws(() => requireScope(auth, "admin"), { code: "scope_denied" });
  await setUserRole(store, admin.id, "admin", { access: { userId: user.id } });
  requireScope(await authenticateApiToken(store, token.token), "admin");
});


test("long-lived event subscriptions lose admin visibility after demotion", async (t) => {
  const { store, admin, user, options } = await fixture(t);
  await setUserRole(store, user.id, "admin", options);
  const artifact = await createArtifact(store, { title: "Private", content: "private", visibility: "private", ownerUserId: user.id });
  const access = { userId: admin.id, role: "admin" };
  const event = { artifactId: artifact.id };
  assert.equal(await canReadArtifactEvent(store, event, access), true);
  await setUserRole(store, admin.id, "user", options);
  assert.equal(await canReadArtifactEvent(store, event, access), false);
});
