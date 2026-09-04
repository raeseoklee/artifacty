import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createArtifact, createStore, createWebhook, deleteWebhook, listWebhooks, recordWebhookDelivery } from "../src/lib/storage.js";
import { assertPublicWebhookUrl, deliverWebhook, registerWebhookDispatcher, signPayload } from "../src/lib/webhooks.js";
import { publish } from "../src/lib/events.js";

test("assertPublicWebhookUrl rejects non-http(s) and private/loopback targets unless allowed", () => {
  assert.throws(() => assertPublicWebhookUrl("ftp://example.com"));
  assert.throws(() => assertPublicWebhookUrl("http://127.0.0.1:9999"));
  assert.throws(() => assertPublicWebhookUrl("http://localhost"));
  assert.throws(() => assertPublicWebhookUrl("http://10.0.0.5"));
  assert.throws(() => assertPublicWebhookUrl("http://169.254.169.254"));
  assert.doesNotThrow(() => assertPublicWebhookUrl("https://example.com/hook"));
  assert.doesNotThrow(() => assertPublicWebhookUrl("http://127.0.0.1:9999", { allowPrivate: true }));
});

test("signPayload is deterministic HMAC-SHA256 over the raw body using the stored secret hash as key", () => {
  const secretHash = createHash("sha256").update("whsec_abc").digest("hex");
  const body = JSON.stringify({ hello: "world" });
  const signature = signPayload(secretHash, body);
  const expected = createHmac("sha256", secretHash).update(body).digest("hex");
  assert.equal(signature, expected);
});

test("createWebhook/listWebhooks/deleteWebhook round trip and hide the raw secret after creation", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-webhooks-"));
  try {
    const store = createStore({ home });
    process.env.ARTIFACTY_WEBHOOK_ALLOW_PRIVATE = "true";
    try {
      const created = await createWebhook(store, { url: "http://127.0.0.1:9999/hook", eventTypes: ["artifact.updated"] });
      assert.ok(created.secret, "creation response includes the one-time secret");
      assert.ok(created.secretHash);
      assert.notEqual(created.secret, created.secretHash);

      const list = await listWebhooks(store);
      assert.equal(list.length, 1);
      assert.equal(list[0].secret, undefined, "listed webhooks never expose the raw secret");
      assert.equal(list[0].url, "http://127.0.0.1:9999/hook");

      const removed = await deleteWebhook(store, created.id);
      assert.equal(removed.id, created.id);
      assert.equal((await listWebhooks(store)).length, 0);
    } finally {
      delete process.env.ARTIFACTY_WEBHOOK_ALLOW_PRIVATE;
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("deliverWebhook signs requests, retries with injected delays, and reports failure after exhausting attempts", async () => {
  const attempts = [];
  const fetchImpl = async (url, init) => {
    attempts.push({ url, init });
    return { status: 500 };
  };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };

  const webhook = { id: "wh1", url: "https://example.com/hook", secretHash: createHash("sha256").update("s").digest("hex") };
  const event = { type: "artifact.updated", artifactId: "a1" };
  const result = await deliverWebhook({ webhook, event, delaysMs: [1, 2, 3], fetchImpl, sleep });

  assert.equal(result.ok, false);
  assert.equal(attempts.length, 4);
  assert.deepEqual(sleeps, [1, 2, 3]);
  for (const attempt of attempts) {
    assert.equal(attempt.init.headers["x-artifacty-event"], "artifact.updated");
    assert.match(attempt.init.headers["x-artifacty-signature"], /^sha256=[0-9a-f]{64}$/);
    assert.equal(attempt.init.redirect, "manual");
  }
});

test("deliverWebhook succeeds without retrying once a 2xx response is received", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { status: 204 };
  };
  const webhook = { id: "wh1", url: "https://example.com/hook", secretHash: "abc" };
  const result = await deliverWebhook({ webhook, event: { type: "artifact.updated" }, delaysMs: [1, 2, 3], fetchImpl, sleep: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

test("registerWebhookDispatcher delivers matching events to a real local HTTP receiver with a verifiable signature", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-webhooks-"));
  try {
    const store = createStore({ home });
    process.env.ARTIFACTY_WEBHOOK_ALLOW_PRIVATE = "true";
    let received = null;
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        received = { headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
        response.writeHead(200);
        response.end();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const created = await createWebhook(store, { url: `http://127.0.0.1:${port}/hook`, eventTypes: [] });
      const unsubscribe = registerWebhookDispatcher(store, { listWebhooks, recordWebhookDelivery });
      try {
        // events.publish() dedupes by id (see src/lib/events.js), so this
        // must be unique across every test in this file/process, not just
        // within this test.
        publish({ id: `evt_${randomUUID()}`, type: "artifact.updated", artifactId: "a1", tags: [], createdAt: new Date().toISOString() });
        await waitFor(() => received !== null);
        assert.equal(received.headers["x-artifacty-event"], "artifact.updated");
        assert.match(received.headers["x-artifacty-signature"], /^sha256=[0-9a-f]{64}$/);
        const expectedSignature = createHmac("sha256", createHash("sha256").update(created.secret).digest("hex"))
          .update(received.body)
          .digest("hex");
        assert.equal(received.headers["x-artifacty-signature"], `sha256=${expectedSignature}`);
      } finally {
        unsubscribe();
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      delete process.env.ARTIFACTY_WEBHOOK_ALLOW_PRIVATE;
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("registerWebhookDispatcher disables a webhook and records an audit row after 20 consecutive failures", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-webhooks-"));
  try {
    const store = createStore({ home });
    process.env.ARTIFACTY_WEBHOOK_ALLOW_PRIVATE = "true";
    try {
      const created = await createWebhook(store, { url: "http://127.0.0.1:1/hook", eventTypes: [] });
      const audits = [];
      const unsubscribe = registerWebhookDispatcher(store, {
        listWebhooks,
        recordWebhookDelivery,
        insertWebhookFailureAudit: async (_store, webhook, event, result) => audits.push({ webhook, event, result }),
        deliver: async () => ({ ok: false, status: 0, attempts: 1 }),
        delaysMs: []
      });
      try {
        for (let i = 0; i < 20; i += 1) {
          publish({ id: `evt_${randomUUID()}`, type: "artifact.updated", artifactId: "a1", tags: [], createdAt: new Date().toISOString() });
          await waitFor(async () => (await listWebhooks(store)).find((w) => w.id === created.id)?.failureCount === i + 1);
        }
        const webhook = (await listWebhooks(store, { enabledOnly: false }))[0] ?? (await (async () => {
          const all = await listWebhooksIncludingDisabled(store);
          return all[0];
        })());
        assert.equal(audits.length, 1);
      } finally {
        unsubscribe();
      }
    } finally {
      delete process.env.ARTIFACTY_WEBHOOK_ALLOW_PRIVATE;
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function listWebhooksIncludingDisabled(store) {
  return listWebhooks(store, { enabledOnly: false });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}
