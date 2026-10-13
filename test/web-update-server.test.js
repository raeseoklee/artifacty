import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { createUser, createSession, createApiToken } from "../src/lib/storage.js";

test("web updates require an administrator session and exact same origin while GET remains read-only", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-web-update-http-"));
  const calls = [];
  const webUpdater = {
    status: async () => { calls.push("status"); return { currentVersion: "0.14.0", check: null, run: null }; },
    check: async (session) => { calls.push(["check", session]); return { currentVersion: "0.14.0", check: null, run: null }; },
    start: async (request) => { calls.push(["start", request]); return {}; }
  };
  const app = await startServer({ home, port: 0, webUpdater });
  try {
    const admin = await createUser(app.store, { email: "admin@example.com", name: "Admin", password: "password-123", role: "admin" });
    const member = await createUser(app.store, { email: "member@example.com", name: "Member", password: "password-456", role: "user" });
    const adminSession = await createSession(app.store, admin.id);
    const memberSession = await createSession(app.store, member.id);
    const token = await createApiToken(app.store, admin.id, { name: "Admin API" });
    const cookie = `artifacty_session=${adminSession.token}`;
    for (const headers of [{}, { cookie: `artifacty_session=${memberSession.token}` }, { authorization: `Bearer ${token.token}` }]) {
      const response = await fetch(`${app.url}/admin/update/status`, { headers, redirect: "manual" });
      assert.ok([401, 403].includes(response.status));
    }
    assert.deepEqual(calls, []);
    for (const route of ["/admin/update", "/admin/update/status"]) {
      const response = await fetch(`${app.url}${route}?lang=ko`, { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual(calls, ["status", "status"]);
    for (const route of ["check", "start"]) {
      for (const origin of [undefined, "http://localhost:1", "https://evil.example", `${app.url}/`]) {
        const response = await fetch(`${app.url}/admin/update/${route}`, {
          method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) }, body: ""
        });
        assert.equal(response.status, 403);
      }
    }
    assert.equal(calls.length, 2);
    const checked = await fetch(`${app.url}/admin/update/check`, { method: "POST", headers: { cookie, origin: app.url, "content-type": "application/x-www-form-urlencoded" }, body: "lang=ko" });
    assert.equal(checked.status, 200);
    assert.deepEqual(calls[2], ["check", adminSession.token]);
    const started = await fetch(`${app.url}/admin/update/start`, { method: "POST", redirect: "manual", headers: { cookie, origin: app.url, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ lang: "ko", confirmationId: "confirmed", targetVersion: "0.15.0", confirmUpdate: "true", packageRoot: "/evil" }) });
    assert.equal(started.status, 303);
    assert.equal(started.headers.get("location"), "/admin/update?lang=ko");
    assert.deepEqual(calls[3], ["start", { session: adminSession.token, confirmationId: "confirmed", targetVersion: "0.15.0", confirmUpdate: "true" }]);
    const asset = await fetch(`${app.url}/assets/update.js`);
    assert.equal(asset.status, 200);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
