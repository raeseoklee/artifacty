// Regression tests for M5 from the 2026-09 security review: POST
// /api/artifacts, POST /api/artifacts/:id, and POST /api/import must
// allowlist accepted JSON fields instead of spreading the request body, so
// a write-scoped caller cannot set `ownerUserId` (planting content in
// another user's private namespace) or `auditAction` (forging an
// artifact.archived/restored event).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApiToken, createStore, createUser } from "../src/lib/storage.js";
import { startServer } from "../src/server.js";

test("M5: POST /api/artifacts ignores an attacker-supplied ownerUserId and auditAction", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-secfix-input-"));
  const app = await startServer({ port: 0, home });
  const store = createStore({ home });
  try {
    const attacker = await createUser(store, { email: "m5-attacker@example.com", name: "Attacker", role: "user", password: "password-123" });
    const victim = await createUser(store, { email: "m5-victim@example.com", name: "Victim", role: "user", password: "password-123" });
    const attackerToken = (await createApiToken(store, attacker.id, { name: "Attacker", scopes: ["read", "write"] })).token;

    const createResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "x-artifacty-token": attackerToken, "content-type": "application/json" },
      body: JSON.stringify({
        title: "M5 Planted Artifact",
        content: "planted",
        format: "text",
        visibility: "private",
        ownerUserId: victim.id,
        auditAction: "archive"
      })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();

    // ownerUserId must derive from the authenticated caller, never the body.
    assert.equal(created.ownerUserId, attacker.id, "ownerUserId must come from the authenticated caller, not the request body");
    assert.notEqual(created.ownerUserId, victim.id);

    // auditAction must not have forged an "archive" event: the audit row
    // for this artifact must be a "create", not an "archive".
    const auditResponse = await fetch(`${app.url}/api/audit?artifactId=${encodeURIComponent(created.id)}`, {
      headers: { "x-artifacty-token": attackerToken }
    });
    const audit = await auditResponse.json();
    assert.ok(audit.events.length > 0);
    assert.ok(audit.events.every((event) => event.action !== "archive"), "auditAction must not be settable from the request body");
    assert.ok(audit.events.some((event) => event.action === "create"));

    // The artifact itself must not actually be archived.
    const readResponse = await fetch(`${app.url}/api/artifacts/${created.id}`, {
      headers: { "x-artifacty-token": attackerToken }
    });
    const read = await readResponse.json();
    assert.equal(read.archivedAt, null);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("M5: POST /api/artifacts/:id (update) ignores an attacker-supplied auditAction", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-secfix-input-update-"));
  const app = await startServer({ port: 0, home });
  const store = createStore({ home });
  try {
    const owner = await createUser(store, { email: "m5u-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const ownerToken = (await createApiToken(store, owner.id, { name: "Owner", scopes: ["read", "write"] })).token;

    const created = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "x-artifacty-token": ownerToken, "content-type": "application/json" },
      body: JSON.stringify({ title: "M5 Update Target", content: "v1", format: "text" })
    }).then((r) => r.json());

    const updateResponse = await fetch(`${app.url}/api/artifacts/${created.id}`, {
      method: "POST",
      headers: { "x-artifacty-token": ownerToken, "content-type": "application/json" },
      body: JSON.stringify({ content: "v2", format: "text", auditAction: "restore" })
    });
    assert.equal(updateResponse.status, 200);

    const auditResponse = await fetch(`${app.url}/api/audit?artifactId=${encodeURIComponent(created.id)}`, {
      headers: { "x-artifacty-token": ownerToken }
    });
    const audit = await auditResponse.json();
    assert.ok(audit.events.every((event) => event.action !== "restore"), "auditAction must not be settable from the update body");
    assert.ok(audit.events.some((event) => event.action === "update"));
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("M5: POST /api/import ignores an attacker-supplied ownerUserId", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-secfix-import-"));
  const app = await startServer({ port: 0, home });
  const store = createStore({ home });
  try {
    const attacker = await createUser(store, { email: "m5i-attacker@example.com", name: "Attacker", role: "user", password: "password-123" });
    const victim = await createUser(store, { email: "m5i-victim@example.com", name: "Victim", role: "user", password: "password-123" });
    const attackerToken = (await createApiToken(store, attacker.id, { name: "Attacker", scopes: ["read", "write"] })).token;

    const importResponse = await fetch(`${app.url}/api/import`, {
      method: "POST",
      headers: { "x-artifacty-token": attackerToken, "content-type": "application/json" },
      body: JSON.stringify({
        agent: "generic",
        title: "M5 Imported",
        content: "imported",
        ownerUserId: victim.id
      })
    });
    assert.equal(importResponse.status, 201);
    const created = await importResponse.json();
    assert.equal(created.ownerUserId, attacker.id);
    assert.notEqual(created.ownerUserId, victim.id);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
