import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";

async function fixture(t) {
  const previous = process.env.ARTIFACTY_LOCALE;
  delete process.env.ARTIFACTY_LOCALE;
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-locale-http-"));
  const app = await startServer({ home, port: 0 });
  t.after(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ARTIFACTY_LOCALE;
    else process.env.ARTIFACTY_LOCALE = previous;
  });
  return app;
}
async function assertLanguage(response, language) {
  assert.equal(response.status, 200);
  assert.match(await response.text(), new RegExp(`<html lang="${language}">`));
}

test("browser locale defaults to English and persists a validated explicit choice", async (t) => {
  const app = await fixture(t);
  await assertLanguage(await fetch(app.url, { headers: { "accept-language": "ko-KR,ko;q=0.9" } }), "en");
  const selected = await fetch(`${app.url}/?lang=ko`);
  const cookies = selected.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /^artifacty_locale=ko;/);
  assert.match(cookies[0], /Path=\/; HttpOnly; SameSite=Lax; Max-Age=31536000/);
  assert.equal(selected.headers.get("cache-control"), "no-store");
  assert.equal(selected.headers.get("vary"), "Cookie");
  await assertLanguage(selected, "ko");
  await assertLanguage(await fetch(`${app.url}/import`, { headers: { cookie: "artifacty_locale=ko" } }), "ko");
  const english = await fetch(`${app.url}/?lang=en`, { headers: { cookie: "artifacty_locale=ko" } });
  assert.match(english.headers.get("set-cookie"), /^artifacty_locale=en;/);
  await assertLanguage(english, "en");
});

test("explicit English and stored preferences override the environment while invalid values fall back safely", async (t) => {
  const app = await fixture(t);
  process.env.ARTIFACTY_LOCALE = "ko";
  await assertLanguage(await fetch(app.url), "ko");
  await assertLanguage(await fetch(`${app.url}/?lang=en`), "en");
  await assertLanguage(await fetch(app.url, { headers: { cookie: "artifacty_locale=en" } }), "en");
  for (const lang of ["ja", "EN<script>", ""]) {
    const response = await fetch(`${app.url}/?lang=${encodeURIComponent(lang)}`, { headers: { cookie: "artifacty_locale=en" } });
    assert.equal(response.headers.get("set-cookie"), null);
    await assertLanguage(response, "en");
  }
  await assertLanguage(await fetch(app.url, { headers: { cookie: "artifacty_locale=%E0%A4%A" } }), "ko");
  process.env.ARTIFACTY_LOCALE = "invalid";
  await assertLanguage(await fetch(app.url, { headers: { cookie: "artifacty_locale=invalid" } }), "en");
});

test("language selection survives login and logout without replacing authentication cookies", async (t) => {
  const app = await fixture(t);
  const login = await fetch(`${app.url}/login?lang=ko`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "admin@example.com", name: "Admin", password: "password-123" })
  });
  assert.equal(login.status, 303);
  const cookies = login.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some((cookie) => cookie.startsWith("artifacty_locale=ko;")));
  assert.ok(cookies.some((cookie) => cookie.startsWith("artifacty_session=")));
  const cookie = cookies.map((item) => item.split(";")[0]).join("; ");
  await assertLanguage(await fetch(new URL(login.headers.get("location"), app.url), { headers: { cookie } }), "ko");
  const invalid = await fetch(`${app.url}/login`, {
    method: "POST", headers: { cookie: "artifacty_locale=ko", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "admin@example.com", password: "wrong-password" })
  });
  assert.equal(invalid.status, 401);
  assert.match(await invalid.text(), /이메일 또는 비밀번호가 올바르지 않습니다\./);
  const logout = await fetch(`${app.url}/logout?lang=en`, { method: "POST", redirect: "manual", headers: { cookie } });
  assert.equal(logout.status, 303);
  assert.ok(logout.headers.getSetCookie().some((item) => item.startsWith("artifacty_locale=en;")));
  assert.ok(logout.headers.getSetCookie().some((item) => item.startsWith("artifacty_session=;") && item.includes("Max-Age=0")));
  await assertLanguage(await fetch(new URL(logout.headers.get("location"), app.url), { headers: { cookie: "artifacty_locale=en" } }), "en");
});

test("browser locale cookies do not change API responses or set preferences on API requests", async (t) => {
  const app = await fixture(t);
  const baseline = await (await fetch(`${app.url}/api/artifacts`)).json();
  const response = await fetch(`${app.url}/api/artifacts?lang=ko`, { headers: { cookie: "artifacty_locale=ko" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(await response.json(), baseline);
  const health = await fetch(`${app.url}/health?lang=ko`);
  assert.equal(health.headers.get("set-cookie"), null);
  assert.equal((await health.json()).ok, true);
  const content = "# Original content\n\nKeep these bytes unchanged.\n";
  const created = await fetch(`${app.url}/api/artifacts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Locale fixture", format: "markdown", content })
  });
  assert.equal(created.status, 201);
  const artifact = await created.json();
  const raw = await fetch(`${app.url}/artifacts/${artifact.id}/raw?lang=ko`, { headers: { cookie: "artifacty_locale=ko" } });
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("set-cookie"), null);
  assert.equal(await raw.text(), content);
});
