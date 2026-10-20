import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { createUser, createSession, createApiToken, listUsers, listApiTokens, verifyUserPassword } from "../src/lib/storage.js";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-browser-auth-"));
  const app = await startServer({ home, port: 0 });
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }); });
  return app;
}

function post(app, route, body, cookie, origin = app.url) {
  return fetch(`${app.url}${route}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}), ...(origin === undefined ? {} : { origin }) },
    body: new URLSearchParams(body)
  });
}

test("browser auth and user mutations reject hostile origins without changing credentials, sessions, tokens or users", async (t) => {
  const app = await fixture(t);
  for (const origin of ["https://evil.example", "http://127.0.0.1:1", "null"]) {
    assert.equal((await post(app, "/login", { email: "attacker@example.com", password: "attacker-password" }, null, origin)).status, 403);
  }
  assert.equal((await listUsers(app.store)).length, 0);
  const setup = await post(app, "/login", { email: "admin@example.com", password: "admin-password" });
  assert.equal(setup.status, 303);
  const cookie = setup.headers.getSetCookie()[0].split(";")[0];
  const admin = (await listUsers(app.store))[0];
  const member = await createUser(app.store, { email: "member@example.com", password: "member-password" });
  const token = await createApiToken(app.store, admin.id, { name: "Existing", scopes: ["read"] });
  const actions = [
    ["/login", { email: admin.email, password: "admin-password" }],
    ["/logout", {}],
    ["/account/password", { currentPassword: "admin-password", newPassword: "attacker-password", confirmPassword: "attacker-password" }],
    ["/account/tokens", { name: "Injected", scopeAdmin: "on" }],
    [`/account/tokens/${token.id}/revoke`, {}],
    ["/admin/users", { email: "injected@example.com", password: "attacker-password", role: "admin" }],
    ["/admin/users/import", { csv: "email,name,password\ninjected@example.com,Injected,attacker-password" }],
    [`/admin/users/${member.id}/disable`, {}]
  ];
  for (const origin of ["https://evil.example", "http://127.0.0.1:1", app.url.replace("http:", "https:"), "null"]) {
    for (const [route, body] of actions) assert.equal((await post(app, route, body, cookie, origin)).status, 403, `${origin} ${route}`);
  }
  assert.ok(await verifyUserPassword(app.store, admin.email, "admin-password"));
  assert.equal(await verifyUserPassword(app.store, admin.email, "attacker-password"), null);
  assert.equal((await listUsers(app.store)).length, 2);
  assert.equal((await listUsers(app.store)).find((user) => user.id === member.id).active, true);
  assert.equal((await listApiTokens(app.store, admin.id)).filter((item) => !item.revokedAt).length, 1);
  assert.equal((await fetch(`${app.url}/account`, { headers: { cookie }, redirect: "manual" })).status, 200);
  assert.equal((await post(app, "/account/tokens", { name: "Allowed", scopeRead: "on" }, cookie)).status, 200);
  assert.equal((await post(app, `/account/tokens/${token.id}/revoke`, {}, cookie)).status, 303);
  assert.equal((await post(app, `/admin/users/${member.id}/disable`, {}, cookie)).status, 303);
  assert.equal((await post(app, "/admin/users", { email: "allowed@example.com", password: "allowed-password" }, cookie)).status, 303);
  assert.equal((await post(app, "/admin/users/import", { csv: "email,name,password\nimported@example.com,Imported,imported-password" }, cookie)).status, 200);
  assert.ok((await listUsers(app.store)).some((user) => user.email === "imported@example.com"));
  assert.equal((await post(app, "/logout", {}, cookie)).status, 303);
  assert.equal((await fetch(`${app.url}/account`, { headers: { cookie }, redirect: "manual" })).status, 303);
});

for (const passwordResetRequired of [false, true]) {
  test(`browser password changes require the existing password (reset required: ${passwordResetRequired})`, async (t) => {
    const app = await fixture(t);
    const user = await createUser(app.store, { email: "member@example.com", password: "existing-password", passwordResetRequired });
    const cookie = `artifacty_session=${(await createSession(app.store, user.id)).token}`;
    const body = { newPassword: "replacement-password", confirmPassword: "replacement-password" };
    for (const input of [body, { ...body, currentPassword: "" }, { ...body, currentPassword: "wrong-password" }]) {
      assert.equal((await post(app, "/account/password", input, cookie)).status, 400);
      assert.ok(await verifyUserPassword(app.store, user.email, "existing-password"));
      assert.equal(await verifyUserPassword(app.store, user.email, "replacement-password"), null);
    }
    assert.equal((await post(app, "/account/password", { ...body, currentPassword: "existing-password" }, cookie)).status, 200);
    assert.equal((await verifyUserPassword(app.store, user.email, "replacement-password")).passwordResetRequired, false);
  });
}
