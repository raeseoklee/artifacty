import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { createUser, createSession, createApiToken } from "../src/lib/storage.js";
import { TRANSLATIONS } from "../src/lib/i18n.js";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-language-admin-"));
  const app = await startServer({ home, port: 0 });
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }); });
  const admin = await createUser(app.store, { email: "admin@example.com", name: "Admin", password: "password-123", role: "admin" });
  const member = await createUser(app.store, { email: "member@example.com", name: "Member", password: "password-456", role: "user" });
  const cookie = `artifacty_session=${(await createSession(app.store, admin.id)).token}`;
  const memberCookie = `artifacty_session=${(await createSession(app.store, member.id)).token}`;
  const token = (await createApiToken(app.store, admin.id, { name: "Admin API" })).token;
  const post = (route, body, headers = {}) => fetch(`${app.url}${route}`, { method: "POST", redirect: "manual", headers: { cookie, origin: app.url, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });
  return { app, cookie, memberCookie, token, post };
}
const settingsForm = (defaultLocale, enabled) => [["defaultLocale", defaultLocale], ...enabled.map((locale) => ["enabledLocales", locale])];
const customPack = (label) => ({ locale: "fr", nativeName: "Français", messages: { "nav.new": label } });

test("language administration requires an admin browser session and rejects cross-origin changes", async (t) => {
  const { app, cookie, memberCookie, token, post } = await fixture(t);
  for (const headers of [{}, { cookie: memberCookie }, { authorization: `Bearer ${token}` }]) {
    const response = await fetch(`${app.url}/admin/languages`, { headers, redirect: "manual" });
    assert.ok([401, 403].includes(response.status));
    const template = await fetch(`${app.url}/admin/languages/template`, { headers, redirect: "manual" });
    assert.ok([401, 403].includes(template.status));
    const write = await fetch(`${app.url}/admin/languages`, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded", origin: app.url }, body: new URLSearchParams(settingsForm("ko", ["ko"])) });
    assert.ok([401, 403].includes(write.status));
    const imported = await fetch(`${app.url}/admin/languages/import`, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded", origin: app.url }, body: new URLSearchParams({ pack: JSON.stringify(customPack("Unauthorized")) }) });
    assert.ok([401, 403].includes(imported.status));
  }
  assert.equal((await fetch(`${app.url}/admin/languages`, { headers: { cookie } })).status, 200);
  const template = await fetch(`${app.url}/admin/languages/template`, { headers: { cookie } });
  assert.equal(template.status, 200);
  assert.match(template.headers.get("content-type"), /application\/json/);
  assert.equal(template.headers.get("content-disposition"), 'attachment; filename="artifacty-language-template.json"');
  assert.equal(template.headers.get("cache-control"), "no-store");
  assert.deepEqual(await template.json(), { locale: "en", nativeName: "English", messages: TRANSLATIONS.en });
  assert.equal((await post("/admin/languages", settingsForm("ko", ["ko"]), { origin: "https://evil.example" })).status, 403);
  for (const origin of ["", "http://localhost:1", "http://127.0.0.1:1"]) {
    assert.equal((await post("/admin/languages", settingsForm("ko", ["ko"]), { origin })).status, 403);
    assert.equal((await post("/admin/languages/import", { pack: JSON.stringify(customPack("Denied")) }, { origin })).status, 403);
  }
});

test("saving language settings applies on the next request and disabled choices cannot override the default", async (t) => {
  const { app, post } = await fixture(t);
  const changed = await post("/admin/languages?lang=en", settingsForm("ko", ["en", "ko"]));
  assert.equal(changed.status, 303);
  assert.equal(changed.headers.get("location"), "/admin/languages");
  assert.match(await (await fetch(app.url)).text(), /<html lang="ko">/);
  assert.match(await (await fetch(`${app.url}/?lang=en`)).text(), /<html lang="en">/);
  assert.equal((await post("/admin/languages", settingsForm("en", ["en"]))).status, 303);
  const disabled = await fetch(`${app.url}/?lang=ko`, { headers: { cookie: "artifacty_locale=ko" } });
  assert.equal(disabled.headers.get("set-cookie"), null);
  assert.match(await disabled.text(), /<html lang="en">/);
});

test("invalid settings and malformed or oversized packs leave the selected configuration intact", async (t) => {
  const { app, post } = await fixture(t);
  assert.equal((await post("/admin/languages", settingsForm("ko", ["en", "ko"]))).status, 303);
  const invalid = await post("/admin/languages", settingsForm("fr", ["en"]));
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /<html lang="ko">/);
  const malformed = await post("/admin/languages/import", { pack: "{ broken JSON" });
  assert.equal(malformed.status, 400);
  for (const pack of [null, [], { locale: "../evil", nativeName: "Bad", messages: {} }]) {
    assert.equal((await post("/admin/languages/import", { pack: JSON.stringify(pack) })).status, 400);
  }
  const oversized = await post("/admin/languages/import", { pack: "x".repeat(512 * 1024 + 1) });
  assert.equal(oversized.status, 413);
  assert.match(await (await fetch(app.url)).text(), /<html lang="ko">/);
});

test("custom language packs render with English fallback and remain isolated between simultaneous stores", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  for (const [context, label] of [[first, "Créer dans A"], [second, "Créer dans B"]]) {
    assert.equal((await context.post("/admin/languages/import", { pack: JSON.stringify(customPack(label)) })).status, 303);
    assert.equal((await context.post("/admin/languages", settingsForm("fr", ["en", "fr"]))).status, 303);
  }
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const firstStore = index % 2 === 0;
    const context = firstStore ? first : second;
    const html = await (await fetch(context.app.url)).text();
    assert.match(html, /<html lang="fr">/);
    assert.ok(html.includes(firstStore ? "Créer dans A" : "Créer dans B"));
    assert.ok(!html.includes(firstStore ? "Créer dans B" : "Créer dans A"));
    assert.match(html, /Advanced filters/);
  }));
  const explicit = await fetch(`${first.app.url}/?lang=fr`);
  assert.match(explicit.headers.get("set-cookie"), /^artifacty_locale=fr;/);
});
