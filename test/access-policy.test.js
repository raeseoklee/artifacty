import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getNetworkPolicy, setNetworkPolicy } from "../src/lib/network-policy.js";
import {
  addRelation, canReadArtifactEvent, createArtifact, createStore, createTeam, createUser,
  exportFullStoreTables, getAccessMode, getArtifact, getArtifactSharing,
  importFullStoreTables, listArtifactsPage, listAuditEvents, listEventsSince,
  listRelations, listTeams, setAccessMode, setArtifactSharing, setTeamMembers, setUserActive, updateArtifact
} from "../src/lib/storage.js";

async function withStore(fn) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-access-policy-"));
  try { await fn(createStore({ home })); }
  finally { await rm(home, { recursive: true, force: true }); }
}

async function users(store) {
  const result = {};
  for (const name of ["admin", "owner", "reader", "stranger"]) {
    const user = await createUser(store, { name, email: `${name}@example.com`, password: "password-123", role: name === "admin" ? "admin" : "user" });
    result[name] = { userId: user.id, role: user.role };
  }
  return result;
}

const anonymous = { anonymous: true };

test("access mode defaults public, is persisted, and requires an administrator to change", async () => {
  await withStore(async (store) => {
    assert.equal(await getAccessMode(store), "public");
    await assert.rejects(setAccessMode(store, "private"), /active administrator/);
    const { admin, reader } = await users(store);
    await assert.rejects(setAccessMode(store, "private", { access: reader }), { statusCode: 403 });
    await assert.rejects(setAccessMode(store, "invalid", { access: admin }), { statusCode: 400 });
    const artifact = await createArtifact(store, { title: "Existing public artifact", content: "old content", format: "text", visibility: "public" });
    assert.equal((await getArtifact(store, artifact.id, { access: anonymous })).id, artifact.id);
    await setAccessMode(store, "private", { access: admin });
    assert.equal(await getAccessMode(createStore({ home: store.home })), "private");
    await assert.rejects(getArtifact(store, artifact.id, { access: anonymous }), { statusCode: 404 });
    assert.equal((await getArtifact(store, artifact.id, { access: admin })).id, artifact.id);
    assert.equal((await getArtifact(store, artifact.id)).id, artifact.id, "trusted local callers retain access");
    await setAccessMode(store, "public", { access: admin });
    assert.equal((await getArtifact(store, artifact.id, { access: anonymous })).id, artifact.id);
  });
});

test("private user and team grants cover read/search/events and revoke immediately without granting writes", async () => {
  await withStore(async (store) => {
    const { admin, owner, reader, stranger } = await users(store);
    const artifact = await createArtifact(store, { title: "Shared manual", content: "needle manual", format: "markdown", visibility: "private", ownerUserId: owner.userId });
    const unshared = await createArtifact(store, { title: "Secret manual", content: "needle secret", format: "text", ownerUserId: owner.userId });
    await addRelation(store, { fromId: artifact.id, toId: unshared.id, relation: "references" });
    await setAccessMode(store, "private", { access: admin });
    await assert.rejects(getArtifact(store, unshared.id, { access: reader }), { statusCode: 404 });
    assert.equal((await listArtifactsPage(store, { access: reader })).total, 0);
    await setArtifactSharing(store, artifact.id, { userIds: [reader.userId] }, { access: owner });
    assert.equal((await getArtifact(store, artifact.id, { access: reader })).content, "needle manual");
    assert.deepEqual((await listArtifactsPage(store, { access: reader, query: "needle" })).artifacts.map((item) => item.id), [artifact.id]);
    assert.equal((await listArtifactsPage(store, { access: anonymous })).total, 0);
    await assert.rejects(updateArtifact(store, artifact.id, { content: "changed", access: reader }), { statusCode: 403 });
    await assert.rejects(setArtifactSharing(store, artifact.id, {}, { access: reader }), { statusCode: 403 });
    const relations = await listRelations(store, artifact.id, { access: reader });
    assert.equal(relations.outgoing[0].restricted, true);
    const events = await listEventsSince(store, 0, {}, 200, reader);
    assert.ok(events.length);
    assert.ok(events.every((event) => event.artifactId === artifact.id));
    assert.equal(await canReadArtifactEvent(store, { artifactId: unshared.id }, reader), false);
    assert.equal(await canReadArtifactEvent(store, { artifactId: artifact.id }, reader), true);
    const audit = await listAuditEvents(store, { access: reader });
    assert.ok(audit.every((event) => event.artifactId === artifact.id));
    assert.equal(JSON.stringify(audit).includes(unshared.id), false, "relation audit does not leak restricted target ids");
    assert.equal(audit.find((event) => event.action === "artifact-sharing-change").metadata.userIds, undefined);
    const team = await createTeam(store, { name: "Docs" }, { access: admin });
    await setTeamMembers(store, team.id, [reader.userId], { access: admin });
    await setArtifactSharing(store, artifact.id, { teamIds: [team.id] }, { access: owner });
    assert.equal((await getArtifact(store, artifact.id, { access: reader })).id, artifact.id);
    await assert.rejects(getArtifact(store, artifact.id, { access: stranger }), { statusCode: 404 });
    await setTeamMembers(store, team.id, [], { access: admin });
    await assert.rejects(getArtifact(store, artifact.id, { access: reader }), { statusCode: 404 });
    assert.equal((await listArtifactsPage(store, { access: reader, query: "needle" })).total, 0);
    assert.deepEqual(await listEventsSince(store, 0, {}, 200, reader), []);
    assert.equal(await canReadArtifactEvent(store, { artifactId: artifact.id }, reader), false);
    assert.deepEqual(await listAuditEvents(store, { access: reader }), []);
  });
});

test("team and share updates validate references atomically and enforce administration", async () => {
  await withStore(async (store) => {
    const { admin, owner, reader } = await users(store);
    const artifact = await createArtifact(store, { title: "Manual", content: "manual", ownerUserId: owner.userId });
    await assert.rejects(createTeam(store, { name: "Docs" }, { access: reader }), { statusCode: 403 });
    const team = await createTeam(store, { name: "Docs" }, { access: admin });
    await assert.rejects(createTeam(store, { name: "docs" }, { access: admin }), { statusCode: 409 });
    await setTeamMembers(store, team.id, [reader.userId], { access: admin });
    await assert.rejects(setTeamMembers(store, team.id, ["missing"], { access: admin }), { statusCode: 400 });
    assert.deepEqual((await listTeams(store))[0].memberIds, [reader.userId]);
    await setArtifactSharing(store, artifact.id, { userIds: [reader.userId] }, { access: owner });
    await assert.rejects(setArtifactSharing(store, artifact.id, { teamIds: ["missing"] }, { access: owner }), { statusCode: 400 });
    assert.deepEqual(await getArtifactSharing(store, artifact.id, { access: owner }), { userIds: [reader.userId], teamIds: [] });
  });
});

test("full backups preserve grants and private mode cannot be silently opened by restore", async () => {
  await withStore(async (store) => {
    const { admin, owner, reader } = await users(store);
    const artifact = await createArtifact(store, { title: "Manual", content: "manual", ownerUserId: owner.userId });
    const team = await createTeam(store, { name: "Docs" }, { access: admin });
    await setTeamMembers(store, team.id, [reader.userId], { access: admin });
    await setArtifactSharing(store, artifact.id, { teamIds: [team.id] }, { access: owner });
    await setAccessMode(store, "private", { access: admin });
    setNetworkPolicy(store, { allowedCidrs: ["127.0.0.1/32"] }, { access: admin });
    const tables = await exportFullStoreTables(store);
    assert.equal(tables.teams.length, 1);
    assert.equal(tables.teamMembers.length, 1);
    assert.equal(tables.artifactShares.length, 1);
    await importFullStoreTables(store, tables, { forceUsers: true });
    assert.equal((await getArtifact(store, artifact.id, { access: reader })).id, artifact.id);
    tables.meta = tables.meta.map((row) => row.key === "access_mode" ? { ...row, value: "public" }
      : row.key === "network_policy" ? { ...row, value: JSON.stringify({ allowedCidrs: [] }) } : row);
    await importFullStoreTables(store, tables, { forceUsers: true });
    assert.equal(await getAccessMode(store), "private");
    assert.deepEqual(getNetworkPolicy(store).allowedCidrs, ["127.0.0.1/32"]);
    await assert.rejects(getArtifact(store, artifact.id, { access: anonymous }), { statusCode: 404 });
  });
});


test("private creation requires a personal identity and stale event contexts lose disabled-user access", async () => {
  await withStore(async (store) => {
    const { admin, owner, reader } = await users(store);
    await setAccessMode(store, "private", { access: admin });
    await assert.rejects(createArtifact(store, { title: "Anonymous", content: "secret", access: anonymous }), { statusCode: 403 });
    await assert.rejects(createArtifact(store, { title: "Wrong owner", content: "secret", access: reader, ownerUserId: owner.userId }), { statusCode: 403 });
    const artifact = await createArtifact(store, { title: "Personal", content: "secret", access: owner });
    assert.equal(artifact.ownerUserId, owner.userId);
    assert.equal(await canReadArtifactEvent(store, { artifactId: artifact.id }, owner), true);
    await setUserActive(store, owner.userId, false);
    assert.equal(await canReadArtifactEvent(store, { artifactId: artifact.id }, owner), false);
    await assert.rejects(setArtifactSharing(store, artifact.id, { userIds: [owner.userId] }, { access: admin }), { statusCode: 400 });
  });
});


test("version 8 stores migrate to access-policy schema 10 without changing public behavior", async () => {
  await withStore(async (store) => {
    const artifact = await createArtifact(store, { title: "Legacy", content: "legacy content" });
    const legacy = new DatabaseSync(store.dbPath);
    try {
      legacy.exec("DROP TABLE artifact_shares; DROP TABLE team_members; DROP TABLE teams;");
      legacy.prepare("UPDATE meta SET value = '8' WHERE key = 'store_version'").run();
    } finally { legacy.close(); }
    assert.equal(await getAccessMode(store), "public");
    assert.equal((await getArtifact(store, artifact.id, { access: anonymous })).id, artifact.id);
    assert.deepEqual(await listTeams(store), []);
    const migrated = new DatabaseSync(store.dbPath);
    try { assert.equal(migrated.prepare("SELECT value FROM meta WHERE key = 'store_version'").get().value, "11"); }
    finally { migrated.close(); }
  });
});


test("public-mode audit also redacts sharing recipients and unreadable private relation targets", async () => {
  await withStore(async (store) => {
    const { owner, reader } = await users(store);
    const artifact = await createArtifact(store, { title: "Public manual", content: "manual", ownerUserId: owner.userId });
    const hidden = await createArtifact(store, { title: "Private notes", content: "secret", visibility: "private", ownerUserId: owner.userId });
    await addRelation(store, { fromId: artifact.id, toId: hidden.id, relation: "references", access: owner });
    await setArtifactSharing(store, artifact.id, { userIds: [reader.userId] }, { access: owner });
    const audit = await listAuditEvents(store, { artifactId: artifact.id, access: reader });
    assert.equal(JSON.stringify(audit).includes(hidden.id), false);
    assert.deepEqual(audit.find((event) => event.action === "artifact-sharing-change").metadata, { restricted: true });
    const ownerAudit = await listAuditEvents(store, { artifactId: artifact.id, access: owner });
    assert.equal(ownerAudit.find((event) => event.action === "relation-add").metadata.toId, hidden.id);
    assert.deepEqual(ownerAudit.find((event) => event.action === "artifact-sharing-change").metadata.userIds, [reader.userId]);
  });
});
