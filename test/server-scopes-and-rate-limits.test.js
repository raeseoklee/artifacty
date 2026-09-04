// API token scopes (roadmap section 11) and rate limiting (roadmap section
// 12) HTTP coverage.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { createApiToken, createStore, createUser } from "../src/lib/storage.js";

test("personal API token scopes gate /api/* routes by read/write/admin", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-scopes-"));
  const app = await startServer({ port: 0, home });
  try {
    const admin = await createUser(app.store, {
      email: "scope-admin@example.com",
      name: "Scope Admin",
      role: "admin",
      password: "password-123"
    });
    const member = await createUser(app.store, {
      email: "scope-member@example.com",
      name: "Scope Member",
      role: "user",
      password: "password-123"
    });

    const readOnly = await createApiToken(app.store, member.id, { name: "Read only", scopes: ["read"] });
    const readWrite = await createApiToken(app.store, member.id, { name: "Read write", scopes: ["read", "write"] });
    const adminToken = await createApiToken(app.store, admin.id, { name: "Admin", scopes: ["read", "write", "admin"] });

    const listResponse = await fetch(`${app.url}/api/artifacts`, {
      headers: { authorization: `Bearer ${readOnly.token}` }
    });
    assert.equal(listResponse.status, 200);

    const deniedCreate = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${readOnly.token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Denied", content: "x", format: "text" })
    });
    assert.equal(deniedCreate.status, 403);
    const deniedBody = await deniedCreate.json();
    assert.equal(deniedBody.code, "scope_denied");

    const allowedCreate = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${readWrite.token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Allowed", content: "x", format: "text" })
    });
    assert.equal(allowedCreate.status, 201);

    const deniedAdmin = await fetch(`${app.url}/api/webhooks`, {
      headers: { authorization: `Bearer ${readWrite.token}` }
    });
    assert.equal(deniedAdmin.status, 403);
    assert.equal((await deniedAdmin.json()).code, "scope_denied");

    const allowedAdmin = await fetch(`${app.url}/api/webhooks`, {
      headers: { authorization: `Bearer ${adminToken.token}` }
    });
    assert.equal(allowedAdmin.status, 200);

    // A repeated scope denial from the same token within the throttle
    // window should still only produce (at most) the throttled audit rows,
    // not error.
    const secondDenial = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${readOnly.token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Denied again", content: "x", format: "text" })
    });
    assert.equal(secondDenial.status, 403);

    const auditResponse = await fetch(`${app.url}/api/audit`, {
      headers: { authorization: `Bearer ${adminToken.token}` }
    });
    const audit = await auditResponse.json();
    assert.ok(audit.events.some((event) => event.action === "token-scope-denied"));
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("429 rate_limited responses carry Retry-After and code, forced on via ARTIFACTY_RATE_LIMIT=always", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-rate-limit-"));
  process.env.ARTIFACTY_RATE_LIMIT = "always";
  process.env.ARTIFACTY_RATE_WRITE_PER_MIN = "1";
  const app = await startServer({ port: 0, home });
  try {
    const first = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "First", content: "x", format: "text" })
    });
    assert.equal(first.status, 201);

    const second = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Second", content: "x", format: "text" })
    });
    assert.equal(second.status, 429);
    assert.ok(second.headers.get("retry-after"));
    const body = await second.json();
    assert.equal(body.code, "rate_limited");
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
    delete process.env.ARTIFACTY_RATE_LIMIT;
    delete process.env.ARTIFACTY_RATE_WRITE_PER_MIN;
  }
});

test("rate limiting is disabled by default on a loopback bind", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-rate-limit-loopback-"));
  process.env.ARTIFACTY_RATE_WRITE_PER_MIN = "1";
  const app = await startServer({ port: 0, home });
  try {
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(`${app.url}/api/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: `Loopback ${i}`, content: "x", format: "text" })
      });
      assert.equal(response.status, 201);
    }
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
    delete process.env.ARTIFACTY_RATE_WRITE_PER_MIN;
  }
});

test("account page renders scope checkboxes on token creation and lists each token's scopes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-scope-ui-"));
  const app = await startServer({ port: 0, home });
  try {
    const setupResponse = await fetch(`${app.url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "ui-admin@example.com", name: "UI Admin", password: "password-123" })
    });
    const cookie = setupResponse.headers.get("set-cookie");

    const accountPage = await (await fetch(`${app.url}/account`, { headers: { cookie } })).text();
    assert.match(accountPage, /name="scopeRead"/);
    assert.match(accountPage, /name="scopeWrite"/);
    assert.match(accountPage, /name="scopeAdmin"/);

    const tokenResponse = await fetch(`${app.url}/account/tokens`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "Scoped token", scopeRead: "on" })
    });
    assert.equal(tokenResponse.status, 200);
    const tokenPage = await tokenResponse.text();
    assert.match(tokenPage, /Scoped token/);
    // Table row should show the single requested scope, not the read+write
    // default (i.e. the checkbox selection reached createApiToken).
    assert.match(tokenPage, /<td>read<\/td>/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
