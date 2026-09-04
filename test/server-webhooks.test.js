// /api/webhooks CRUD coverage (roadmap section 3).
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";

test("GET/POST/DELETE /api/webhooks round trip, and the secret is only ever returned once", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-webhooks-http-"));
  process.env.ARTIFACTY_WEBHOOK_ALLOW_PRIVATE = "true";
  const app = await startServer({ port: 0, home });
  try {
    const createResponse = await fetch(`${app.url}/api/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:1/hook", eventTypes: ["artifact.updated"] })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.ok(created.secret);
    assert.equal(created.secretHash, undefined);

    const listResponse = await fetch(`${app.url}/api/webhooks`);
    const { webhooks } = await listResponse.json();
    assert.equal(webhooks.length, 1);
    assert.equal(webhooks[0].secret, undefined);
    assert.equal(webhooks[0].url, "http://127.0.0.1:1/hook");

    const deleteResponse = await fetch(`${app.url}/api/webhooks/${created.id}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 200);
    const afterDelete = await fetch(`${app.url}/api/webhooks`).then((r) => r.json());
    assert.equal(afterDelete.webhooks.length, 0);
  } finally {
    delete process.env.ARTIFACTY_WEBHOOK_ALLOW_PRIVATE;
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("POST /api/webhooks rejects an SSRF-suspect target", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-webhooks-http-"));
  const app = await startServer({ port: 0, home });
  try {
    const response = await fetch(`${app.url}/api/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data" })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, "INVALID_WEBHOOK_URL");
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("POST /api/webhooks/:id/test delivers a signed synthetic event to a real receiver", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-webhooks-http-"));
  process.env.ARTIFACTY_WEBHOOK_ALLOW_PRIVATE = "true";
  let received = null;
  const receiver = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = { headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const app = await startServer({ port: 0, home });
  try {
    const created = await fetch(`${app.url}/api/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${receiver.address().port}/hook` })
    }).then((r) => r.json());

    const testResponse = await fetch(`${app.url}/api/webhooks/${created.id}/test`, { method: "POST" });
    assert.equal(testResponse.status, 200);
    const result = await testResponse.json();
    assert.equal(result.ok, true);

    assert.ok(received);
    assert.equal(received.headers["x-artifacty-event"], "artifact.updated");
    const expectedSignature = createHmac("sha256", createHash("sha256").update(created.secret).digest("hex"))
      .update(received.body)
      .digest("hex");
    assert.equal(received.headers["x-artifacty-signature"], `sha256=${expectedSignature}`);
  } finally {
    delete process.env.ARTIFACTY_WEBHOOK_ALLOW_PRIVATE;
    await app.close();
    await new Promise((resolve) => receiver.close(resolve));
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("webhook routes require admin once user accounts exist", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-webhooks-http-"));
  const app = await startServer({ port: 0, home });
  try {
    await fetch(`${app.url}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "admin@example.com", name: "Admin", password: "hunter2hunter2" }),
      redirect: "manual"
    });

    const unauthenticated = await fetch(`${app.url}/api/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook" })
    });
    assert.equal(unauthenticated.status, 401);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
