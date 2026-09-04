// Regression tests for the webhook SSRF guard rewrite (M1) and the
// secret-in-redirect-URL fix (M4) from the 2026-09 security review.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertPublicWebhookUrl } from "../src/lib/webhooks.js";
import { startServer } from "../src/server.js";

test("M1: SSRF guard rejects legacy inet_aton IPv4 loopback forms", () => {
  // All of these resolve to 127.0.0.1 (loopback) via Node's URL host
  // canonicalization / the resolver's own inet_aton acceptance, not just
  // the four-part dotted-decimal form.
  for (const url of [
    "http://2130706433/", // decimal
    "http://0177.0.0.1/", // octal
    "http://0x7f000001/", // hex
    "http://127.1/", // 2-part shorthand
    "http://127.0.1/" // 3-part shorthand
  ]) {
    assert.throws(() => assertPublicWebhookUrl(url), new RegExp("."), `expected ${url} to be rejected`);
  }
});

test("M1: SSRF guard rejects legacy inet_aton IPv4 forms for other blocked ranges", () => {
  for (const url of [
    "http://0x0a000001/", // hex for 10.0.0.1 (private)
    "http://2851995648/", // decimal for 169.254.0.0 (link-local)
    "http://0x64400001/" // hex for 100.64.0.1 (CGNAT)
  ]) {
    assert.throws(() => assertPublicWebhookUrl(url), `expected ${url} to be rejected`);
  }
});

test("M1: SSRF guard rejects newly-covered ranges: CGNAT, 192.0.0.0/24, benchmarking, multicast", () => {
  for (const url of [
    "http://100.64.0.1/", // CGNAT 100.64.0.0/10
    "http://192.0.0.8/", // IETF protocol assignments 192.0.0.0/24
    "http://198.18.0.1/", // benchmarking 198.18.0.0/15
    "http://224.0.0.1/" // multicast 224.0.0.0/4
  ]) {
    assert.throws(() => assertPublicWebhookUrl(url), `expected ${url} to be rejected`);
  }
});

test("M1: SSRF guard rejects fully-expanded IPv6 loopback and mapped-IPv4 forms", () => {
  for (const url of [
    "http://[0:0:0:0:0:0:0:1]/", // fully-expanded ::1
    "http://[::ffff:127.0.0.1]/", // IPv4-mapped loopback
    "http://[::ffff:7f00:1]/" // IPv4-mapped loopback, hex-group form
  ]) {
    assert.throws(() => assertPublicWebhookUrl(url), `expected ${url} to be rejected`);
  }
});

test("M1: SSRF guard still allows ordinary public hosts", () => {
  assert.doesNotThrow(() => assertPublicWebhookUrl("https://example.com/hook"));
  assert.doesNotThrow(() => assertPublicWebhookUrl("https://8.8.8.8/hook"));
});

async function createAdminSession(app) {
  const setupResponse = await fetch(`${app.url}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: "webhook-admin@example.com",
      name: "Admin",
      password: "password-123"
    })
  });
  assert.equal(setupResponse.status, 303);
  return setupResponse.headers.get("set-cookie");
}

test("M4: creating a webhook via the browser never puts the raw secret in the redirect URL", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-secfix-webhook-secret-"));
  const app = await startServer({ port: 0, home });
  try {
    const cookie = await createAdminSession(app);

    const createResponse = await fetch(`${app.url}/admin/webhooks`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: "https://example.com/hook", eventTypes: "" })
    });
    assert.equal(createResponse.status, 303);
    const location = createResponse.headers.get("location");
    assert.ok(location, "expected a redirect Location header");
    assert.doesNotMatch(location, /secret=/, "the raw signing secret must never appear in the redirect URL");

    // The redirect target renders the secret exactly once, consumed from a
    // server-side one-time slot keyed by the nonce in the URL.
    const revealResponse = await fetch(`${app.url}${location}`, { headers: { cookie } });
    assert.equal(revealResponse.status, 200);
    const revealHtml = await revealResponse.text();
    assert.match(revealHtml, /whsec_/, "the create page should reveal the secret once");

    // Revisiting the exact same URL must not reveal the secret again (the
    // one-time slot was consumed on first read).
    const secondVisit = await fetch(`${app.url}${location}`, { headers: { cookie } });
    const secondHtml = await secondVisit.text();
    assert.doesNotMatch(secondHtml, /whsec_/, "revisiting the redirect URL must not re-reveal the secret");
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
