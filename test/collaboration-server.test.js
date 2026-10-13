import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { createApiToken, createArtifact, createSession, createUser, getAccessMode, listArtifacts, listNotifications, openDatabase, updateArtifact } from "../src/lib/storage.js";
import { getNetworkPolicy, getPendingNetworkPolicy } from "../src/lib/network-policy.js";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-collaboration-http-"));
  const app = await startServer({ home, port: 0 });
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }); });
  const accounts = {};
  for (const name of ["admin", "owner", "reader", "commenter", "editor", "outsider"]) {
    const user = await createUser(app.store, { email: `${name}@example.com`, name, role: name === "admin" ? "admin" : "user", password: "password-123" });
    const session = await createSession(app.store, user.id);
    const token = await createApiToken(app.store, user.id, { name: "test", scopes: ["read", "write"] });
    accounts[name] = { user, cookie: `artifacty_session=${session.token}`, token: token.token, access: { userId: user.id, role: user.role } };
  }
  const get = (route, who) => fetch(`${app.url}${route}`, { redirect: "manual", headers: who ? { cookie: accounts[who].cookie } : {} });
  const post = (route, who, body = {}, extraHeaders = {}) => fetch(`${app.url}${route}`, { method: "POST", redirect: "manual", headers: { cookie: accounts[who].cookie, "content-type": "application/x-www-form-urlencoded", ...extraHeaders }, body: new URLSearchParams(body) });
  const api = (route, who, body) => fetch(`${app.url}${route}`, { method: "POST", headers: { authorization: `Bearer ${accounts[who].token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, accounts, get, post, api };
}

test("mode preview, permission forms, effective report, and personal inbox enforce each role", async (t) => {
  const { app, accounts, get, post, api } = await fixture(t);
  const artifact = await createArtifact(app.store, { title: "Permission manual", format: "text", content: "Original", ownerUserId: accounts.owner.user.id });
  const root = `/artifacts/${artifact.id}`;
  const preview = await post("/admin/access/preview", "admin", { mode: "private" });
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /action="\/admin\/access"/);
  assert.equal(await getAccessMode(app.store), "public");
  assert.equal((await post("/admin/access", "admin", { mode: "private" })).status, 303);
  const fields = [];
  for (const [who, permission] of [["reader", "read"], ["commenter", "comment"], ["editor", "edit"]]) {
    fields.push(["userIds", accounts[who].user.id], [`userPermission:${accounts[who].user.id}`, permission]);
  }
  assert.equal((await post(`${root}/sharing`, "owner", fields)).status, 303);
  const report = await get(`${root}/sharing`, "owner");
  assert.equal(report.status, 200);
  assert.match(await report.text(), /direct:edit/);
  assert.equal((await get(`${root}/sharing`, "editor")).status, 403);
  assert.equal((await api(`/api${root}`, "reader", { content: "Denied" })).status, 403);
  assert.equal((await api(`/api${root}`, "commenter", { content: "Denied" })).status, 403);
  assert.equal((await api(`/api${root}/comments`, "reader", { body: "Denied" })).status, 403);
  assert.equal((await api(`/api${root}/comments`, "commenter", { body: "Review comment" })).status, 201);
  assert.equal((await api(`/api${root}`, "editor", { content: "Edited" })).status, 200);
  assert.equal((await post(`${root}/sharing`, "editor", {})).status, 403);
  assert.equal((await get("/inbox")).status, 303);
  const inbox = await get("/inbox", "reader");
  assert.equal(inbox.status, 200);
  assert.match(await inbox.text(), /Permission manual/);
  const notifications = await listNotifications(app.store, { access: accounts.reader.access });
  assert.ok(notifications.unreadCount > 0);
  const id = notifications.notifications[0].id;
  assert.equal((await post(`/inbox/${id}/read`, "outsider")).status, 404);
  assert.equal((await post(`/inbox/${id}/read`, "reader")).status, 303);
  assert.equal((await post("/inbox/read-all", "reader")).status, 303);
  assert.equal((await listNotifications(app.store, { access: accounts.reader.access })).unreadCount, 0);
  assert.equal((await post(`${root}/sharing`, "owner", {})).status, 303);
  assert.doesNotMatch(await (await get("/inbox", "reader")).text(), /Permission manual/);
  assert.equal((await post("/admin/access/preview", "owner", { mode: "public" })).status, 403);
  assert.equal((await post("/admin/access/preview", "admin", { mode: "public" }, { origin: "https://attacker.example" })).status, 403);
});

test("public share links are read-only, version scoped, revocable, and private-policy gated", async (t) => {
  const { app, accounts, get, post } = await fixture(t);
  const artifact = await createArtifact(app.store, { title: "Public excerpt", format: "text", content: "Version one", ownerUserId: accounts.owner.user.id, tags: ["private-tag"] });
  const root = `/artifacts/${artifact.id}`;
  await post("/admin/access", "admin", { mode: "private" });
  assert.equal((await post(`${root}/share-links`, "owner", { version: "1", days: "7" })).status, 403);
  assert.equal((await post("/admin/access/share-links", "owner", { enabledInPrivate: "true" })).status, 403);
  assert.equal((await post("/admin/access/share-links", "admin", { enabledInPrivate: "true" })).status, 303);
  async function create(version) {
    const response = await post(`${root}/share-links`, "owner", { version, days: "7" });
    assert.equal(response.status, 200);
    const html = await response.text();
    const token = /\/s\/([A-Za-z0-9_-]{43})/.exec(html)?.[1];
    assert.ok(token);
    return `/s/${token}`;
  }
  const pinned = await create("1");
  const latest = await create("latest");
  await updateArtifact(app.store, artifact.id, { content: "Version two" });
  const viewer = await get(pinned);
  assert.equal(viewer.status, 200);
  assert.equal(viewer.headers.get("referrer-policy"), "no-referrer");
  assert.equal(viewer.headers.get("cache-control"), "no-store");
  const html = await viewer.text();
  assert.match(html, /Version one/);
  for (const hidden of [artifact.id, "owner@example.com", "private-tag", "Version two"]) assert.ok(!html.includes(hidden), hidden);
  assert.equal(await (await get(`${pinned}/raw?version=2`)).text(), "Version one");
  assert.equal(await (await get(`${latest}/raw`)).text(), "Version two");
  const rawCsp = (await get(`${pinned}/raw`)).headers.get("content-security-policy");
  assert.match(rawCsp, /^sandbox; default-src 'none'/);
  assert.match(rawCsp, /style-src 'unsafe-inline'/);
  assert.doesNotMatch(rawCsp, /allow-scripts|script-src/);
  assert.ok(!(await (await get(`${root}/sharing`, "owner")).text()).includes(pinned));
  assert.equal((await get(`${pinned}/raw?file=../../secret`)).status, 404);
  assert.equal((await post(pinned, "owner", { content: "Bad" })).status, 404);
  assert.equal((await get(`${root}/raw`)).status, 303);
  const { setNetworkPolicy } = await import("../src/lib/network-policy.js");
  setNetworkPolicy(app.store, { allowedCidrs: ["192.0.2.0/24"] }, { access: accounts.admin.access });
  assert.equal((await get(pinned)).status, 403);
  assert.equal((await get(`${pinned}/raw`)).status, 403);
  setNetworkPolicy(app.store, { allowedCidrs: [] }, { access: accounts.admin.access });
  const { listShareLinks } = await import("../src/lib/share-links.js");
  const links = listShareLinks(app.store, artifact.id, { access: accounts.owner.access });
  const pinnedLink = links.find((link) => link.version === 1);
  assert.equal((await post(`${root}/share-links/${pinnedLink.id}/revoke`, "owner")).status, 303);
  assert.equal((await get(pinned)).status, 404);
  const db = openDatabase(app.store);
  try { db.prepare("UPDATE artifact_share_links SET expires_at = ? WHERE artifact_id = ?").run("2000-01-01T00:00:00.000Z", artifact.id); }
  finally { db.close(); }
  assert.equal((await get(latest)).status, 404);
  await post("/admin/access/share-links", "admin", {});
  assert.equal((await get(latest)).status, 404);
  assert.equal((await get("/s/not-a-valid-token")).status, 404);
});

test("network changes require confirmation and recover after timeout; samples are admin-only", async (t) => {
  const { app, accounts, get, post } = await fixture(t);
  assert.equal((await post("/admin/access/network", "admin", { allowedCidrs: "127.0.0.0/8" })).status, 303);
  let pending = getPendingNetworkPolicy(app.store);
  assert.ok(pending.id);
  assert.match(await (await get("/admin/access", "admin")).text(), /\/admin\/access\/network\/confirm/);
  assert.equal((await post("/admin/access/network/confirm", "owner", { id: pending.id })).status, 403);
  assert.equal((await post("/admin/access/network/rollback", "admin", { id: pending.id })).status, 303);
  assert.deepEqual(getNetworkPolicy(app.store).allowedCidrs, []);
  await post("/admin/access/network", "admin", { allowedCidrs: "127.0.0.1" });
  pending = getPendingNetworkPolicy(app.store);
  assert.equal((await post("/admin/access/network/confirm", "admin", { id: pending.id })).status, 303);
  assert.equal(getPendingNetworkPolicy(app.store), null);
  assert.deepEqual(getNetworkPolicy(app.store).allowedCidrs, ["127.0.0.1"]);
  await post("/admin/access/network", "admin", { allowedCidrs: "127.0.0.0/8" });
  const db = openDatabase(app.store);
  try {
    const staged = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'network_policy_pending'").get().value);
    staged.expiresAt = "2000-01-01T00:00:00.000Z";
    db.prepare("UPDATE meta SET value = ? WHERE key = 'network_policy_pending'").run(JSON.stringify(staged));
    db.prepare("UPDATE meta SET value = ? WHERE key = 'network_policy'").run(JSON.stringify({ allowedCidrs: ["192.0.2.0/24"] }));
  } finally { db.close(); }
  assert.equal((await get("/health")).status, 200);
  assert.equal(getPendingNetworkPolicy(app.store), null);
  assert.deepEqual(getNetworkPolicy(app.store).allowedCidrs, ["127.0.0.1"]);
  assert.equal((await post("/admin/samples/install", "owner")).status, 403);
  assert.equal((await post("/admin/samples/remove", "owner")).status, 403);
  assert.equal((await post("/admin/samples/install", "admin")).status, 303);
  const first = await listArtifacts(app.store);
  assert.equal((await post("/admin/samples/install", "admin")).status, 303);
  assert.equal((await listArtifacts(app.store)).length, first.length);
  assert.equal((await post("/admin/samples/remove", "admin")).status, 303);
});
