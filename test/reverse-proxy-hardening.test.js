import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { createUser, createStore, listUsers } from "../src/lib/storage.js";
import { setNetworkPolicy } from "../src/lib/network-policy.js";

const PUBLIC_URL = "https://artifacts.example.test";
const PASSWORD = "correct horse battery staple";

async function withServer(env, options, run) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-proxy-hardening-"));
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  await createUser(createStore({ home }), { email: "admin@example.test", name: "Admin", role: "admin", password: PASSWORD });
  const app = await startServer({ port: 0, home, ...options });
  try {
    await run(app);
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function login(app, headers = {}, password = PASSWORD) {
  return fetch(`${app.url}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ email: "admin@example.test", password })
  });
}

test("ARTIFACTY_URL is an accepted origin behind a TLS proxy and marks its cookies Secure", async () => {
  await withServer({ ARTIFACTY_URL: PUBLIC_URL }, {}, async (app) => {
    const proxied = await login(app, { origin: PUBLIC_URL });
    assert.equal(proxied.status, 303);
    assert.match(proxied.headers.get("set-cookie"), /artifacty_session=[^;]+;.*; Secure/);

    const direct = await login(app, { origin: app.url });
    assert.equal(direct.status, 303, "the listening address keeps working for direct access");
    assert.doesNotMatch(direct.headers.get("set-cookie"), /Secure/, "a Secure cookie would be discarded over direct HTTP");

    const foreign = await login(app, { origin: "https://evil.example.test" });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get("set-cookie"), null);

    const lookalike = await login(app, { origin: "http://artifacts.example.test" });
    assert.equal(lookalike.status, 403, "the configured scheme must match");
  });
});

test("without ARTIFACTY_URL a proxied HTTPS origin stays rejected and cookies stay unchanged", async () => {
  await withServer({ ARTIFACTY_URL: "" }, {}, async (app) => {
    assert.equal((await login(app, { origin: PUBLIC_URL })).status, 403);
    assert.doesNotMatch((await login(app, { origin: app.url })).headers.get("set-cookie"), /Secure/);
  });
});

test("login attempts are limited per forwarded client on a loopback bind behind a trusted proxy", async () => {
  await withServer({ ARTIFACTY_RATE_AUTH_PER_MIN: "2", ARTIFACTY_RATE_LIMIT: "" }, { trustedProxies: "127.0.0.1" }, async (app) => {
    const attempt = (client) => login(app, { "x-forwarded-for": client }, "wrong password");
    assert.notEqual((await attempt("203.0.113.9")).status, 429);
    assert.notEqual((await attempt("203.0.113.9")).status, 429);
    assert.equal((await attempt("203.0.113.9")).status, 429);
    assert.equal((await attempt("garbage, 203.0.113.9")).status, 429, "garbage must not earn a fresh bucket");
    assert.notEqual((await attempt("203.0.113.10")).status, 429, "other clients keep their own bucket");
  });
});

test("loopback binds without a trusted proxy stay unthrottled, and off still wins", async () => {
  await withServer({ ARTIFACTY_RATE_AUTH_PER_MIN: "1", ARTIFACTY_RATE_LIMIT: "" }, {}, async (app) => {
    for (let i = 0; i < 3; i += 1) assert.notEqual((await login(app, {}, "wrong password")).status, 429);
  });
  await withServer({ ARTIFACTY_RATE_AUTH_PER_MIN: "1", ARTIFACTY_RATE_LIMIT: "off" }, { trustedProxies: "127.0.0.1" }, async (app) => {
    for (let i = 0; i < 3; i += 1) assert.notEqual((await login(app, {}, "wrong password")).status, 429);
  });
});

test("a malformed forwarded chain cannot pass the network policy under the proxy's address", async () => {
  await withServer({}, { trustedProxies: "127.0.0.1" }, async (app) => {
    const [admin] = await listUsers(app.store);
    setNetworkPolicy(app.store, { allowedCidrs: ["127.0.0.0/8"] }, { access: { userId: admin.id, role: "admin" } });
    const status = async (client) => (await fetch(`${app.url}/health`, { headers: client === undefined ? {} : { "x-forwarded-for": client } })).status;
    assert.equal(await status("203.0.113.9"), 403);
    assert.equal(await status("garbage, 203.0.113.9"), 403);
    assert.equal(await status("203.0.113.9, garbage"), 403);
    assert.equal(await status("x".repeat(8193)), 403);
    assert.equal(await status(), 200, "the proxy itself may still connect without forwarding a client");
  });
});
