import assert from "node:assert/strict";
import test from "node:test";
import {
  createRateLimiter,
  effectiveScopes,
  exposureWarning,
  normalizeTokenScopes,
  rateLimitEnabled,
  rateLimitFromEnv,
  requireScope,
  requireToken,
  tokensEqual
} from "../src/lib/security.js";

test("compares API tokens through fixed-length timing-safe digests", () => {
  assert.equal(tokensEqual("secret-token", "secret-token"), true);
  assert.equal(tokensEqual("secret-token", "wrong-token"), false);
  assert.equal(tokensEqual("secret-token", "secret-token-extra"), false);
  assert.equal(tokensEqual("", "secret-token"), false);
});

test("requires configured API tokens from headers before query or form convenience paths", () => {
  const config = { apiToken: "configured-token" };
  const url = new URL("http://127.0.0.1:8787/api/artifacts?token=query-token");
  const request = {
    headers: {
      authorization: "Bearer configured-token",
      "x-artifacty-token": "header-token"
    }
  };
  assert.doesNotThrow(() => requireToken({ request, url, body: { _token: "form-token" }, config }));

  assert.throws(
    () => requireToken({
      request: { headers: { "x-artifacty-token": "wrong-token" } },
      url: new URL("http://127.0.0.1:8787/api/artifacts"),
      config
    }),
    /Artifacty API token required/
  );
});

test("warns when binding outside loopback", () => {
  assert.equal(exposureWarning({ host: "127.0.0.1", config: { shareMode: "local" } }), "");
  const warning = exposureWarning({ host: "0.0.0.0", config: { shareMode: "lan" } });
  assert.match(warning, /listening on 0\.0\.0\.0/);
  assert.match(warning, /trusted LAN\/VPN/);
  assert.match(warning, /React rendering disabled/);
});

test("normalizeTokenScopes defaults, validates, and restricts admin to admin users", () => {
  assert.deepEqual(normalizeTokenScopes(undefined, { userRole: "user" }), ["read", "write"]);
  assert.deepEqual(normalizeTokenScopes([], { userRole: "user" }), ["read", "write"]);
  assert.deepEqual(normalizeTokenScopes(["read"], { userRole: "user" }), ["read"]);
  assert.deepEqual(normalizeTokenScopes(["write", "write"], { userRole: "user" }), ["write"]);

  assert.throws(
    () => normalizeTokenScopes(["delete"], { userRole: "admin" }),
    /Unsupported token scope/
  );
  assert.throws(
    () => normalizeTokenScopes(["admin"], { userRole: "user" }),
    /admin scope requires an admin user/
  );
  assert.deepEqual(normalizeTokenScopes(["read", "admin"], { userRole: "admin" }), ["read", "admin"]);
});

test("effectiveScopes and requireScope: personal tokens are scoped, everything else is full-scope", () => {
  assert.deepEqual(effectiveScopes({ type: "api-token", scopes: ["read"] }), ["read"]);
  assert.deepEqual(effectiveScopes({ type: "global-token" }), ["read", "write", "admin"]);
  assert.deepEqual(effectiveScopes({ type: "session" }), ["read", "write", "admin"]);
  assert.deepEqual(effectiveScopes({ type: "anonymous" }), ["read", "write", "admin"]);
  assert.deepEqual(effectiveScopes(undefined), ["read", "write", "admin"]);

  assert.doesNotThrow(() => requireScope({ type: "api-token", scopes: ["read", "write"] }, "write"));
  assert.doesNotThrow(() => requireScope({ type: "session" }, "admin"));

  const readOnlyAuth = { type: "api-token", scopes: ["read"], tokenId: "tok_1" };
  assert.throws(() => requireScope(readOnlyAuth, "write"), (error) => {
    assert.equal(error.code, "scope_denied");
    assert.equal(error.statusCode, 403);
    return true;
  });
});

test("createRateLimiter enforces a fixed window per (principal, bucket) and resets after it elapses", () => {
  let now = 1000000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const limiter = createRateLimiter({ windowMs: 1000, limits: { write: 2, search: 0 } });

    assert.equal(limiter.check("token-a", "write").allowed, true);
    assert.equal(limiter.check("token-a", "write").allowed, true);
    const third = limiter.check("token-a", "write");
    assert.equal(third.allowed, false);
    assert.ok(third.retryAfterSeconds >= 1);

    // A different principal in the same bucket has its own counter.
    assert.equal(limiter.check("token-b", "write").allowed, true);

    // A bucket with a non-positive/missing limit is never limited.
    assert.equal(limiter.check("token-a", "search").allowed, true);
    assert.equal(limiter.check("token-a", "read").allowed, true);

    // After the window elapses, the counter resets.
    now += 1000;
    assert.equal(limiter.check("token-a", "write").allowed, true);
  } finally {
    Date.now = originalNow;
  }
});

test("rateLimitEnabled: disabled on loopback by default, forceable both ways", () => {
  assert.equal(rateLimitEnabled({ host: "127.0.0.1", env: {} }), false);
  assert.equal(rateLimitEnabled({ host: "localhost", env: {} }), false);
  assert.equal(rateLimitEnabled({ host: "0.0.0.0", env: {} }), true);
  assert.equal(rateLimitEnabled({ host: "127.0.0.1", env: { ARTIFACTY_RATE_LIMIT: "always" } }), true);
  assert.equal(rateLimitEnabled({ host: "0.0.0.0", env: { ARTIFACTY_RATE_LIMIT: "off" } }), false);
});

test("rateLimitFromEnv reads per-bucket limits with defaults", () => {
  assert.deepEqual(rateLimitFromEnv({}), { write: 120, auth: 10, search: 300 });
  assert.deepEqual(
    rateLimitFromEnv({ ARTIFACTY_RATE_WRITE_PER_MIN: "5", ARTIFACTY_RATE_AUTH_PER_MIN: "0", ARTIFACTY_RATE_SEARCH_PER_MIN: "not-a-number" }),
    { write: 5, auth: 10, search: 300 }
  );
});
