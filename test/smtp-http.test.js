import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { createUser, createSession, createApiToken } from "../src/lib/storage.js";
import { getSmtpDeliveryConfig } from "../src/lib/smtp-settings.js";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-smtp-http-"));
  const deliveries = [];
  let fail = false;
  const app = await startServer({ home, port: 0, smtpSender: async (config, message) => {
    deliveries.push({ config, message });
    if (fail) throw Object.assign(new Error("SECRET SMTP server response"), { code: "SMTP_DELIVERY_UNKNOWN" });
    return { accepted: true };
  } });
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }); });
  const admin = await createUser(app.store, { email: "admin@example.com", name: "Admin", password: "password-123", role: "admin" });
  const member = await createUser(app.store, { email: "member@example.com", name: "Member", password: "password-456", role: "user" });
  const cookie = `artifacty_session=${(await createSession(app.store, admin.id)).token}`;
  const memberCookie = `artifacty_session=${(await createSession(app.store, member.id)).token}`;
  const token = (await createApiToken(app.store, admin.id, { name: "Admin API" })).token;
  const post = (route, body, headers = {}) => fetch(`${app.url}${route}`, { method: "POST", redirect: "manual", headers: { cookie, origin: app.url, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });
  return { app, home, member, cookie, memberCookie, token, deliveries, failMail: () => { fail = true; }, post };
}
const configuration = { enabled: "on", host: "smtp.example.com", port: "465", tlsMode: "tls", username: "service-account", from: "artifacty@example.com", password: "SMTP_SECRET_123", lang: "ko" };

test("SMTP settings require an admin session, exact origin, and never expose the saved password", async (t) => {
  const { app, cookie, memberCookie, token, post, deliveries } = await fixture(t);
  for (const headers of [{ cookie: "" }, { cookie: memberCookie }, { cookie: "", authorization: `Bearer ${token}` }]) {
    assert.ok([401, 403].includes((await fetch(`${app.url}/admin/email`, { headers, redirect: "manual" })).status));
    assert.ok([401, 403].includes((await post("/admin/email", configuration, headers)).status));
  }
  for (const origin of ["", "http://localhost:1", "https://evil.example"]) assert.equal((await post("/admin/email", configuration, { origin })).status, 403);
  assert.equal((await post("/admin/email", { ...configuration, password: "" })).status, 400, "A new username without a password is invalid");
  const saved = await post("/admin/email", configuration);
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get("location"), "/admin/email?lang=ko");
  const response = await fetch(`${app.url}/admin/email`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const page = await response.text();
  assert.match(page, /smtp\.example\.com/);
  assert.ok(!page.includes(configuration.password));
  assert.equal((await post("/admin/email", { ...configuration, password: "" })).status, 303);
  assert.equal((await getSmtpDeliveryConfig(app.store)).password, configuration.password);
  const invalid = await post("/admin/email", { ...configuration, port: "bad", password: "INVALID_SECRET" });
  assert.equal(invalid.status, 400);
  assert.ok(!(await invalid.text()).includes("INVALID_SECRET"));
  assert.equal((await post("/admin/email", { ...configuration, username: "", password: "" })).status, 303);
  assert.equal((await getSmtpDeliveryConfig(app.store)).password, "", "Disabling authentication clears the retained password");
  assert.equal(deliveries.length, 0, "Saving settings must not send email");
});

test("temporary password email is sent once to the account address and mail failures preserve manual delivery", async (t) => {
  const { app, home, member, cookie, post, deliveries, failMail } = await fixture(t);
  const route = `/admin/users/${member.id}/reset-password`;
  const unconfigured = await post(route, { lang: "en" });
  assert.equal(unconfigured.status, 200);
  const unconfiguredPage = await unconfigured.text();
  assert.match(unconfiguredPage, /tmp_[A-Za-z0-9_-]+/);
  assert.match(unconfiguredPage, /Email is not configured/);
  assert.equal(deliveries.length, 0);
  assert.equal((await post("/admin/email", configuration)).status, 303);
  const sent = await post(route, { lang: "ko", to: "attacker@example.com" });
  assert.equal(sent.status, 200);
  const page = await sent.text();
  const password = /tmp_[A-Za-z0-9_-]+/.exec(page)?.[0];
  assert.ok(password);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].message.to, member.email);
  assert.match(deliveries[0].message.subject, /임시 비밀번호/);
  assert.ok(deliveries[0].message.text.includes(password));
  assert.ok(deliveries[0].message.text.includes(member.email));
  assert.doesNotMatch(deliveries[0].message.text, /https?:\/\//);
  assert.ok(!page.includes(configuration.password));
  assert.match(page, /SMTP 서버가 비밀번호 초기화 메일을 접수했습니다/);
  assert.equal(sent.headers.get("cache-control"), "no-store");
  failMail();
  const failed = await post(route, { lang: "en" });
  assert.equal(failed.status, 200);
  const failedPage = await failed.text();
  assert.match(failedPage, /tmp_[A-Za-z0-9_-]+/);
  assert.ok(!failedPage.includes("SECRET SMTP"));
  assert.match(failedPage, /Email delivery could not be confirmed/);
  assert.equal(deliveries.length, 2, "Uncertain SMTP acceptance must not retry");
  await rm(path.join(home, "secrets", "smtp.key"));
  const decryptionFailed = await post(route, { lang: "en" });
  assert.equal(decryptionFailed.status, 200);
  const decryptionPage = await decryptionFailed.text();
  assert.match(decryptionPage, /tmp_[A-Za-z0-9_-]+/);
  assert.match(decryptionPage, /Email delivery could not be confirmed/);
  assert.equal(deliveries.length, 2);
  const refreshed = await fetch(`${app.url}/admin/users`, { headers: { cookie } });
  assert.ok(!(await refreshed.text()).includes(password));
});
