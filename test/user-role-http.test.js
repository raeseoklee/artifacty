import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { createUser, createSession, createApiToken, listUsers } from "../src/lib/storage.js";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-user-role-"));
  const app = await startServer({ home, port: 0 });
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }); });
  const admin = await createUser(app.store, { email: "admin@example.com", name: "Admin", password: "password-123", role: "admin" });
  const member = await createUser(app.store, { email: "member@example.com", name: "Member", password: "password-456", role: "user" });
  const adminCookie = `artifacty_session=${(await createSession(app.store, admin.id)).token}`;
  const memberCookie = `artifacty_session=${(await createSession(app.store, member.id)).token}`;
  const post = (id, role, headers = {}, lang = "en") => fetch(`${app.url}/admin/users/${id}/role`, {
    method: "POST", redirect: "manual", headers: { cookie: adminCookie, origin: app.url, "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ role, lang })
  });
  return { app, admin, member, adminCookie, memberCookie, post };
}

test("inline role changes require an admin session and exact browser origin", async (t) => {
  const { app, admin, member, memberCookie, post } = await fixture(t);
  const token = (await createApiToken(app.store, admin.id, { name: "Admin token" })).token;
  for (const headers of [{ cookie: "" }, { cookie: memberCookie }, { cookie: "", authorization: `Bearer ${token}` }]) {
    assert.ok([401, 403].includes((await post(member.id, "admin", headers)).status));
  }
  for (const origin of ["", "http://localhost:1", "https://evil.example"]) assert.equal((await post(member.id, "admin", { origin })).status, 403);
  assert.equal((await listUsers(app.store)).find((user) => user.id === member.id).role, "user");
});

test("the last administrator cannot be demoted and invalid roles do not alter users", async (t) => {
  const { app, admin, member, post } = await fixture(t);
  const last = await post(admin.id, "user", {}, "ko");
  assert.equal(last.status, 409);
  const html = await last.text();
  assert.match(html, /<html lang="ko">/);
  assert.doesNotMatch(html, /users\.lastAdmin/);
  assert.match(html, /role="alert"/);
  assert.equal((await post(member.id, "superuser")).status, 400);
  const users = await listUsers(app.store);
  assert.equal(users.find((user) => user.id === admin.id).role, "admin");
  assert.equal(users.find((user) => user.id === member.id).role, "user");
});

test("promotion and self-demotion take effect in existing sessions without cached privileges", async (t) => {
  const { app, admin, member, adminCookie, memberCookie, post } = await fixture(t);
  const promoted = await post(member.id, "admin", {}, "ko");
  assert.equal(promoted.status, 303);
  assert.equal(promoted.headers.get("location"), "/admin/users?lang=ko");
  assert.equal((await fetch(`${app.url}/admin/users`, { headers: { cookie: memberCookie } })).status, 200);
  const demoted = await post(admin.id, "user", {}, "ko");
  assert.equal(demoted.status, 303);
  assert.equal(demoted.headers.get("location"), "/account?lang=ko");
  assert.equal((await fetch(new URL(demoted.headers.get("location"), app.url), { headers: { cookie: adminCookie } })).status, 200);
  assert.equal((await fetch(`${app.url}/admin/users`, { headers: { cookie: adminCookie } })).status, 403);
  assert.equal((await post(member.id, "user")).status, 403);
  assert.equal((await post(member.id, "user", { cookie: memberCookie })).status, 409);
});
