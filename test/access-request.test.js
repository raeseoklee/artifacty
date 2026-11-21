import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import {
  archiveArtifact, createArtifact, createStore, createUser, listAuditEvents, listNotifications,
  markNotificationRead, requestArtifactAccess, setAccessMode, setArtifactSharing
} from "../src/lib/storage.js";

const PASSWORD = "correct horse battery staple";
const html = { accept: "text/html,application/xhtml+xml" };
const CONFIRMATION = /If this artifact exists and its owner can receive requests, they were notified\./;

async function withServer(run, { env = {} } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-access-request-"));
  const store = createStore({ home });
  const owner = await createUser(store, { email: "owner@example.test", name: "Olive Owner", role: "user", password: PASSWORD });
  const asker = await createUser(store, { email: "asker@example.test", name: "Ada <Asker>", role: "user", password: PASSWORD });
  const admin = await createUser(store, { email: "admin@example.test", name: "Admin", role: "admin", password: PASSWORD });
  const reader = await createUser(store, { email: "reader@example.test", name: "Rita Reader", role: "user", password: PASSWORD });
  const secret = await createArtifact(store, { title: "Private plan", content: "secret", sourceAgent: "test", visibility: "private", ownerUserId: owner.id });
  const shared = await createArtifact(store, { title: "Shared plan", content: "shared", sourceAgent: "test", visibility: "private", ownerUserId: owner.id });
  await setArtifactSharing(store, shared.id, { userIds: [reader.id] }, { access: { userId: owner.id, role: "user" } });
  await setAccessMode(store, "private", { access: { userId: admin.id, role: "admin" } });
  const previous = {};
  for (const [key, value] of Object.entries(env)) { previous[key] = process.env[key]; process.env[key] = value; }
  const app = await startServer({ port: 0, home });
  try {
    await run({ app, store, owner, asker, reader, secret, shared });
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function signIn(app, email) {
  const response = await fetch(`${app.url}/login`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password: PASSWORD })
  });
  return response.headers.get("set-cookie").split(";")[0];
}

function requestAccess(app, id, cookie, headers = {}) {
  return fetch(`${app.url}/artifacts/${id}/request-access`, {
    method: "POST", redirect: "manual",
    headers: { ...html, cookie, origin: app.url, "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ lang: "en" })
  });
}

const accessOf = (user) => ({ userId: user.id, role: user.role });
const pending = async (store, user) => (await listNotifications(store, { access: accessOf(user) })).notifications.filter((item) => item.type === "access-requested");
const auditRows = async (store) => (await listAuditEvents(store, { limit: 200 })).filter((row) => row.action === "access-request");

test("an unreadable existing artifact notifies its owner once and records an audit row", async () => {
  await withServer(async ({ app, store, owner, secret }) => {
    const cookie = await signIn(app, "asker@example.test");
    const first = await requestAccess(app, secret.id, cookie);
    assert.equal(first.status, 200);
    assert.match(await first.text(), CONFIRMATION);
    const items = await pending(store, owner);
    assert.equal(items.length, 1);
    assert.equal(items[0].artifactId, secret.id);
    assert.deepEqual(items[0].requester, { name: "Ada <Asker>", email: "asker@example.test" });
    const rows = await auditRows(store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].artifactId, secret.id);

    const inbox = await fetch(`${app.url}/inbox`, { headers: { ...html, cookie: await signIn(app, "owner@example.test") } });
    const page = await inbox.text();
    assert.match(page, /Access requested/);
    assert.match(page, /Ada &lt;Asker&gt; \(asker@example\.test\)/);
    assert.match(page, new RegExp(`href="/artifacts/${secret.id}/sharing`));
  });
});

test("repeat requests are deduplicated until the owner marks the item read", async () => {
  await withServer(async ({ app, store, owner, secret }) => {
    const cookie = await signIn(app, "asker@example.test");
    await requestAccess(app, secret.id, cookie);
    await requestAccess(app, secret.id, cookie);
    const items = await pending(store, owner);
    assert.equal(items.length, 1);
    assert.equal((await auditRows(store)).length, 1);
    await markNotificationRead(store, items[0].id, { access: accessOf(owner) });
    await requestAccess(app, secret.id, cookie);
    assert.equal((await pending(store, owner)).length, 2);
  });
});

test("no item is created when the requester can already read the artifact or owns it", async () => {
  await withServer(async ({ app, store, owner, shared }) => {
    const cookie = await signIn(app, "reader@example.test");
    assert.equal((await requestAccess(app, shared.id, cookie)).status, 200);
    const ownerCookie = await signIn(app, "owner@example.test");
    assert.equal((await requestAccess(app, shared.id, ownerCookie)).status, 200);
    assert.equal((await pending(store, owner)).length, 0);
    assert.equal((await auditRows(store)).length, 0);
  });
});

test("missing, private, shared, and archived artifacts get the same response", async () => {
  await withServer(async ({ app, store, owner, secret, shared }) => {
    const archived = await createArtifact(store, { title: "Old plan", content: "old", sourceAgent: "test", visibility: "private", ownerUserId: owner.id });
    await archiveArtifact(store, archived.id, { access: accessOf(owner) });
    const cookie = await signIn(app, "asker@example.test");
    const outcomes = [];
    for (const id of ["does-not-exist-12345678", secret.id, shared.id, archived.id]) {
      const response = await requestAccess(app, id, cookie);
      outcomes.push({ status: response.status, type: response.headers.get("content-type"), location: response.headers.get("location"), body: await response.text() });
    }
    for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0]);
    assert.equal(outcomes[0].status, 200);
    assert.equal(outcomes[0].location, null);
    assert.match(outcomes[0].body, CONFIRMATION);
    assert.doesNotMatch(outcomes[0].body, /Private plan|Shared plan|Old plan/);
    assert.equal((await pending(store, owner)).length, 3);
  });
});

test("the unavailable page offers the form only after sign-in and looks the same for missing artifacts", async () => {
  await withServer(async ({ app, secret }) => {
    const signedOut = await fetch(`${app.url}/artifacts/${secret.id}`, { redirect: "manual", headers: html });
    assert.equal(signedOut.status, 303);
    assert.equal(new URL(signedOut.headers.get("location"), app.url).pathname, "/login");
    const signedOutPost = await fetch(`${app.url}/artifacts/${secret.id}/request-access`, {
      method: "POST", redirect: "manual", headers: { ...html, origin: app.url, "content-type": "application/x-www-form-urlencoded" }, body: ""
    });
    assert.equal(signedOutPost.status, 303);
    assert.equal(new URL(signedOutPost.headers.get("location"), app.url).pathname, "/login");

    const cookie = await signIn(app, "asker@example.test");
    const page = async (id) => {
      const response = await fetch(`${app.url}/artifacts/${id}`, { redirect: "manual", headers: { ...html, cookie } });
      return { status: response.status, body: (await response.text()).replaceAll(id, "ID") };
    };
    const existing = await page(secret.id);
    const missing = await page("0".repeat(secret.id.length));
    assert.equal(existing.status, 404);
    assert.match(existing.body, /Request access/);
    assert.match(existing.body, /action="\/artifacts\/ID\/request-access"/);
    assert.deepEqual(existing, missing);
  });
});

test("a cross-origin or originless request is rejected without creating an item", async () => {
  await withServer(async ({ app, store, owner, secret }) => {
    const cookie = await signIn(app, "asker@example.test");
    assert.equal((await requestAccess(app, secret.id, cookie, { origin: "https://evil.example" })).status, 403);
    const noOrigin = await fetch(`${app.url}/artifacts/${secret.id}/request-access`, {
      method: "POST", redirect: "manual", headers: { ...html, cookie, "content-type": "application/x-www-form-urlencoded" }, body: ""
    });
    assert.equal(noOrigin.status, 403);
    assert.equal((await pending(store, owner)).length, 0);
  });
});

test("requests share the write rate limit", async () => {
  await withServer(async ({ app, store, owner, secret }) => {
    const cookie = await signIn(app, "asker@example.test");
    assert.equal((await requestAccess(app, secret.id, cookie)).status, 200);
    const limited = await requestAccess(app, secret.id, cookie);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
    assert.equal((await pending(store, owner)).length, 1);
  }, { env: { ARTIFACTY_RATE_LIMIT: "always", ARTIFACTY_RATE_WRITE_PER_MIN: "1" } });
});

test("storage ignores anonymous callers, unknown ids, and non-string ids", async () => {
  await withServer(async ({ store, owner, asker, secret }) => {
    assert.deepEqual(await requestArtifactAccess(store, secret.id, { access: { anonymous: true } }), { requested: false });
    assert.deepEqual(await requestArtifactAccess(store, "missing", { access: accessOf(asker) }), { requested: false });
    assert.deepEqual(await requestArtifactAccess(store, { toString() { return secret.id; } }, { access: accessOf(asker) }), { requested: false });
    assert.deepEqual(await requestArtifactAccess(store, secret.id, { access: accessOf(asker) }), { requested: true });
    assert.equal((await pending(store, owner)).length, 1);
  });
});
