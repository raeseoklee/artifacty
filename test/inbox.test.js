import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addComment, createArtifact, createStore, createTeam, createUser, exportFullStoreTables,
  importFullStoreTables, listNotifications, markAllNotificationsRead, markNotificationRead,
  setAccessMode, setArtifactSharing, setReviewStatus, setTeamMembers, updateArtifact, openDatabase
} from "../src/lib/storage.js";

async function fixture(fn) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-inbox-"));
  try {
    const store = createStore({ home });
    const contexts = {};
    for (const name of ["admin", "owner", "reader", "other"]) {
      const user = await createUser(store, { email: `${name}@example.com`, name, role: name === "admin" ? "admin" : "user", password: "password-123" });
      contexts[name] = { userId: user.id, role: user.role };
    }
    const artifact = await createArtifact(store, { title: "Guide", content: "original", access: contexts.owner });
    await setAccessMode(store, "private", { access: contexts.admin });
    await fn(store, contexts, artifact);
  } finally { await rm(home, { recursive: true, force: true }); }
}

test("inbox persists shared, comment, review and version notifications without notifying actors", async () => {
  await fixture(async (store, { owner, reader, other }, artifact) => {
    await setArtifactSharing(store, artifact.id, { userIds: [reader.userId], userPermissions: { [reader.userId]: "comment" } }, { access: owner });
    let inbox = await listNotifications(store, { access: reader });
    assert.equal(inbox.unreadCount, 1);
    assert.equal(inbox.notifications[0].type, "shared-with-me");
    assert.equal(inbox.notifications[0].title, "Guide");
    assert.equal((await listNotifications(store, { access: owner })).unreadCount, 0);
    await addComment(store, artifact.id, { body: "Please improve", access: reader });
    assert.equal((await listNotifications(store, { access: owner })).notifications[0].type, "comment");
    assert.equal((await listNotifications(store, { access: reader })).unreadCount, 1);
    await setReviewStatus(store, artifact.id, "pending", { access: owner });
    await updateArtifact(store, artifact.id, { content: "second", access: owner });
    inbox = await listNotifications(createStore({ home: store.home }), { access: reader });
    assert.deepEqual(inbox.notifications.map((item) => item.type).sort(), ["new-version", "review-requested", "shared-with-me"]);
    assert.equal((await listNotifications(store, { access: other })).unreadCount, 0);
    const notification = inbox.notifications[0];
    await assert.rejects(markNotificationRead(store, notification.id, { access: other }), { statusCode: 404 });
    await markNotificationRead(store, notification.id, { access: reader });
    assert.equal((await listNotifications(store, { access: reader, unreadOnly: true })).notifications.length, 2);
    assert.equal((await markAllNotificationsRead(store, { access: reader })).updated, 2);
    assert.equal((await listNotifications(store, { access: reader })).unreadCount, 0);
    await assert.rejects(listNotifications(store, { access: { anonymous: true } }), { statusCode: 403 });
  });
});

test("team additions notify, unchanged membership does not, and live revocation hides history", async () => {
  await fixture(async (store, { admin, owner, reader }, artifact) => {
    const team = await createTeam(store, { name: "Readers" }, { access: admin });
    await setArtifactSharing(store, artifact.id, { teamIds: [team.id] }, { access: owner });
    await setTeamMembers(store, team.id, [reader.userId], { access: admin });
    assert.equal((await listNotifications(store, { access: reader })).unreadCount, 1);
    await setTeamMembers(store, team.id, [reader.userId], { access: admin });
    assert.equal((await listNotifications(store, { access: reader })).unreadCount, 1);
    await updateArtifact(store, artifact.id, { content: "second", access: owner });
    const inbox = await listNotifications(store, { access: reader });
    assert.equal(inbox.unreadCount, 2);
    await setTeamMembers(store, team.id, [], { access: admin });
    assert.deepEqual(await listNotifications(store, { access: reader }), { notifications: [], unreadCount: 0 });
    await assert.rejects(markNotificationRead(store, inbox.notifications[0].id, { access: reader }), { statusCode: 404 });
  });
});

test("failed updates create no notifications and full backup preserves read state and permission levels", async () => {
  await fixture(async (store, { owner, reader }, artifact) => {
    await setArtifactSharing(store, artifact.id, { userIds: [reader.userId], userPermissions: { [reader.userId]: "edit" } }, { access: owner });
    await markAllNotificationsRead(store, { access: reader });
    await assert.rejects(updateArtifact(store, artifact.id, { content: "conflict", expectedVersion: 999, access: owner }), { statusCode: 409 });
    assert.equal((await listNotifications(store, { access: reader })).unreadCount, 0);
    await updateArtifact(store, artifact.id, { content: "changed", access: owner });
    const before = await listNotifications(store, { access: reader });
    const tables = await exportFullStoreTables(store);
    assert.equal(tables.notifications.length, 2);
    await importFullStoreTables(store, tables, { forceUsers: true });
    assert.deepEqual(await listNotifications(store, { access: reader }), before);
  });
});

test("full backups exclude pending network rollback state and preserve target link/network policy", async () => {
  await fixture(async (store) => {
    const pending = JSON.stringify({ expiresAt: "2000-01-01", previousPolicy: { allowedCidrs: [] } });
    const db = openDatabase(store);
    try {
      db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('network_policy_pending', ?)").run(pending);
      db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('share_link_policy', ?)").run('{"enabled":false}');
    } finally { db.close(); }
    const tables = await exportFullStoreTables(store);
    assert.equal(tables.meta.some((row) => row.key === "network_policy_pending"), false);
    tables.meta.push({ key: "network_policy_pending", value: "malicious-source-state" });
    tables.meta = tables.meta.map((row) => row.key === "share_link_policy" ? { ...row, value: '{"enabled":true}' } : row);
    await importFullStoreTables(store, tables, { forceUsers: true });
    const restored = openDatabase(store);
    try {
      assert.equal(restored.prepare("SELECT value FROM meta WHERE key='network_policy_pending'").get().value, pending);
      assert.equal(restored.prepare("SELECT value FROM meta WHERE key='share_link_policy'").get().value, '{"enabled":false}');
    } finally { restored.close(); }
  });
});
