// Regression tests for M2 (unbounded rate-limiter/audit-throttle maps) and
// M6 (artifacty_wait rate limiting and concurrency cap) from the 2026-09
// security review.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRateLimiter } from "../src/lib/security.js";
import { createStore } from "../src/lib/storage.js";
import { createMcpJsonRpcHandler } from "../src/mcp-server.js";

test("M2: createRateLimiter sweeps expired entries instead of growing without bound", () => {
  const limiter = createRateLimiter({ windowMs: 1, limits: { write: 1000000 } });
  // Each principal is distinct, so nothing here is naturally overwritten in
  // place; a limiter that never reclaims memory would grow this map to
  // exactly 5000 entries. The sweep is time-based (entries older than
  // windowMs, checked periodically), so give already-inserted entries time
  // to expire partway through.
  for (let i = 0; i < 2500; i += 1) {
    limiter.check(`principal-${i}`, "write");
  }
  // Let the 1ms window lapse for everything inserted so far.
  const deadline = Date.now() + 5;
  while (Date.now() < deadline) {
    // busy-wait briefly; this is a synchronous API with no timer hook
  }
  for (let i = 2500; i < 6000; i += 1) {
    limiter.check(`principal-${i}`, "write");
  }
  // Without sweeping, bucketCount() would be 6000 (one entry per distinct
  // principal ever seen). The periodic sweep (every 1000 checks, or
  // whenever the map exceeds 10000 entries) must have reclaimed the
  // first batch's now-expired entries well before that.
  assert.ok(limiter.bucketCount() < 6000, `expected sweeping to reclaim expired entries, got bucketCount=${limiter.bucketCount()}`);
});

test("M2: createRateLimiter still enforces the limit correctly around a sweep", () => {
  const limiter = createRateLimiter({ windowMs: 60000, limits: { write: 2 } });
  assert.equal(limiter.check("p", "write").allowed, true);
  assert.equal(limiter.check("p", "write").allowed, true);
  const third = limiter.check("p", "write");
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfterSeconds > 0);
});

test("M6: artifacty_wait is capped by ARTIFACTY_MAX_WAITS and returns too_many_waits", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-secfix-waitcap-"));
  const previous = process.env.ARTIFACTY_MAX_WAITS;
  process.env.ARTIFACTY_MAX_WAITS = "1";
  try {
    const store = createStore({ home });
    const handler = createMcpJsonRpcHandler({ store, transport: "stdio" });

    const firstWaitPromise = handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "artifacty_wait", arguments: { artifactId: "nonexistent", timeoutMs: 500 } }
    });
    // Give the first call a moment to register as in-flight before firing
    // the second one.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondResponse = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "artifacty_wait", arguments: { artifactId: "nonexistent", timeoutMs: 500 } }
    });
    assert.equal(secondResponse.result.isError, true);
    assert.equal(secondResponse.result.structuredContent.code, "too_many_waits");

    const firstResponse = await firstWaitPromise;
    assert.equal(firstResponse.result.isError, false);
    assert.equal(firstResponse.result.structuredContent.timedOut, true);

    // The slot is released once the first call completes, so a third call
    // is allowed again.
    const thirdResponse = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "artifacty_wait", arguments: { artifactId: "nonexistent", timeoutMs: 50 } }
    });
    assert.equal(thirdResponse.result.isError, false);
  } finally {
    if (previous === undefined) {
      delete process.env.ARTIFACTY_MAX_WAITS;
    } else {
      process.env.ARTIFACTY_MAX_WAITS = previous;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("M6: artifacty_wait over HTTP is rate-limited on the search bucket", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-secfix-waitrate-"));
  try {
    const store = createStore({ home });
    let calls = 0;
    const handler = createMcpJsonRpcHandler({
      store,
      transport: "streamable-http",
      auth: null,
      enforceRateLimit: async (bucket) => {
        calls += 1;
        if (bucket === "search") {
          return { allowed: false, retryAfterSeconds: 7 };
        }
        return { allowed: true };
      }
    });

    const response = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "artifacty_wait", arguments: { artifactId: "nonexistent", timeoutMs: 50 } }
    });
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.code, "rate_limited");
    assert.equal(response.result.structuredContent.retryAfterSeconds, 7);
    assert.ok(calls > 0, "expected enforceRateLimit to be consulted for artifacty_wait");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
