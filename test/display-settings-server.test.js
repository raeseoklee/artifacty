import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { createUser, createSession, createApiToken, createArtifact, awaitEmbeddingIndexing } from "../src/lib/storage.js";
import { getDisplaySettings } from "../src/lib/display-settings.js";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-display-http-"));
  const app = await startServer({ home, port: 0 });
  t.after(async () => { await app.close(); await awaitEmbeddingIndexing(app.store); await rm(home, { recursive: true, force: true }); });
  const admin = await createUser(app.store, { email: "admin@example.test", password: "fixture-password-123", role: "admin" });
  const member = await createUser(app.store, { email: "member@example.test", password: "fixture-password-456", role: "user" });
  const cookie = `artifacty_session=${(await createSession(app.store, admin.id)).token}`;
  const memberCookie = `artifacty_session=${(await createSession(app.store, member.id)).token}`;
  const token = (await createApiToken(app.store, admin.id, { name: "API administrator" })).token;
  // Consume every response: these tests assert authorization/display semantics,
  // not keep-alive behavior or fetch connection-pool timing on slow hosts.
  const request = async (route, options = {}) => {
    const response = await fetch(`${app.url}${route}`, { redirect: "manual", ...options });
    return { status: response.status, headers: response.headers, body: await response.text() };
  };
  const post = (timeZone, headers = {}) => request("/admin/display", { method: "POST", headers: { cookie, origin: app.url, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ timeZone }) });
  return { app, cookie, memberCookie, token, request, post };
}

test("display administration requires an admin browser session and rejects cross-origin writes", async t => {
  const { app, cookie, memberCookie, token, request, post } = await fixture(t);
  for (const headers of [{}, { cookie: memberCookie }, { authorization: `Bearer ${token}` }]) {
    const page = await request("/admin/display", { headers });
    assert.ok([401, 403].includes(page.status));
    const change = await post("Asia/Seoul", { ...headers, cookie: headers.cookie || "" });
    assert.ok([401, 403].includes(change.status));
  }
  const page = await request("/admin/display", { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.body, /name="timeZone"/);
  for (const origin of ["", "null", "https://evil.example", `${app.url}/`]) {
    assert.equal((await post("Asia/Seoul", { origin })).status, 403);
  }
  assert.deepEqual(await getDisplaySettings(app.store), { timeZone: "UTC" });
});

test("time zone autosave validates before mutation and applies to subsequent pages without changing UTC API data", async t => {
  const { app, cookie, token, request, post } = await fixture(t);
  const artifact = await createArtifact(app.store, { title: "Display zone fixture", content: "hello", format: "text" });
  const before = await request(`/api/artifacts/${artifact.id}`, { headers: { authorization: `Bearer ${token}` } });
  const valid = await post("Asia/Seoul", { accept: "application/json" });
  assert.equal(valid.status, 200);
  assert.deepEqual(JSON.parse(valid.body), { ok: true, timeZone: "Asia/Seoul" });
  const invalid = await post("Not/AZone", { accept: "application/json" });
  assert.equal(invalid.status, 400);
  assert.equal(JSON.parse(invalid.body).code, "INVALID_DISPLAY_SETTINGS");
  assert.deepEqual(await getDisplaySettings(app.store), { timeZone: "Asia/Seoul" });
  const page = await request(`/artifacts/${artifact.id}`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(page.body, /<time[^>]+datetime="[^"]+"[^>]*>[^<]+Asia\/Seoul<\/time>/);
  const after = await request(`/api/artifacts/${artifact.id}`, { headers: { authorization: `Bearer ${token}` } });
  const first = JSON.parse(before.body), second = JSON.parse(after.body);
  assert.equal(before.status, 200);
  assert.equal(after.status, 200);
  assert.equal(typeof first.createdAt, "string");
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.updatedAt, first.updatedAt);
  const fallback = await post("UTC");
  assert.equal(fallback.status, 303);
  assert.equal(fallback.headers.get("location"), "/admin/display");
});
