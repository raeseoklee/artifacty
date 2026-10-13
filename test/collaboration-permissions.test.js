import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  addComment, archiveArtifact, createArtifact, createStore, createTeam, createUser,
  getArtifactAccessReport, getArtifactPermission, getArtifactSharing, previewAccessMode,
  replaceArtifactVersion, resolveComment, setAccessMode, setArtifactOwner, setArtifactSharing,
  setTeamMembers, updateArtifact, openDatabase, exportFullStoreTables, importFullStoreTables
} from "../src/lib/storage.js";

async function fixture(fn) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-permissions-"));
  try {
    const store = createStore({ home });
    const contexts = {};
    for (const name of ["admin", "owner", "reader", "commenter", "editor", "other"]) {
      const user = await createUser(store, { email: `${name}@example.com`, name, role: name === "admin" ? "admin" : "user", password: "password-123" });
      contexts[name] = { userId: user.id, role: user.role };
    }
    const artifact = await createArtifact(store, { title: "Guide", content: "original", access: contexts.owner });
    await setAccessMode(store, "private", { access: contexts.admin });
    await fn(store, contexts, artifact);
  } finally { await rm(home, { recursive: true, force: true }); }
}

test("read/comment/edit permissions enforce distinct operations and strongest team union", async () => {
  await fixture(async (store, { admin, owner, reader, commenter, editor }, artifact) => {
    const id = artifact.id;
    await setArtifactSharing(store, id, {
      userIds: [reader.userId, commenter.userId, editor.userId],
      userPermissions: { [commenter.userId]: "comment", [editor.userId]: "edit" }
    }, { access: owner });
    assert.equal(await getArtifactPermission(store, id, { access: reader }), "read");
    await assert.rejects(addComment(store, id, { body: "no", access: reader }), { statusCode: 403 });
    await assert.rejects(updateArtifact(store, id, { content: "no", access: commenter }), { statusCode: 403 });
    const ownComment = await addComment(store, id, { body: "suggestion", access: commenter });
    assert.equal(ownComment.authorUserId, commenter.userId);
    const ownerComment = await addComment(store, id, { body: "review", access: owner });
    await assert.rejects(resolveComment(store, id, ownerComment.id, { access: commenter }), { statusCode: 403 });
    assert.equal((await resolveComment(store, id, ownComment.id, { access: commenter })).status, "resolved");
    assert.equal((await updateArtifact(store, id, { content: "revised", access: editor })).latestVersion, 2);
    await addComment(store, id, { body: "updated", access: editor });
    for (const operation of [
      () => archiveArtifact(store, id, { access: editor }),
      () => setArtifactOwner(store, id, editor.userId, { access: editor }),
      () => setArtifactSharing(store, id, {}, { access: editor }),
      () => replaceArtifactVersion(store, id, 1, { content: "rewrite", access: editor })
    ]) await assert.rejects(operation, { statusCode: 403 });
    const team = await createTeam(store, { name: "Editors" }, { access: admin });
    await setTeamMembers(store, team.id, [reader.userId], { access: admin });
    await setArtifactSharing(store, id, { userIds: [reader.userId], teamIds: [team.id], teamPermissions: { [team.id]: "edit" } }, { access: owner });
    assert.equal(await getArtifactPermission(store, id, { access: reader }), "edit");
    await setTeamMembers(store, team.id, [], { access: admin });
    assert.equal(await getArtifactPermission(store, id, { access: reader }), "read");
  });
});

test("sharing maps remain optional, validate atomically, and access reports explain effective rights", async () => {
  await fixture(async (store, { admin, owner, reader, other }, artifact) => {
    const team = await createTeam(store, { name: "Reviewers" }, { access: admin });
    await setTeamMembers(store, team.id, [reader.userId], { access: admin });
    const shares = { userIds: [reader.userId], teamIds: [team.id] };
    await setArtifactSharing(store, artifact.id, { ...shares, teamPermissions: { [team.id]: "comment" } }, { access: owner });
    assert.deepEqual(await getArtifactSharing(store, artifact.id, { access: owner }), shares);
    assert.equal((await getArtifactSharing(store, artifact.id, { access: owner, includePermissions: true })).teamPermissions[team.id], "comment");
    await assert.rejects(setArtifactSharing(store, artifact.id, { ...shares, userPermissions: { [reader.userId]: "admin" } }, { access: owner }), { statusCode: 400 });
    await assert.rejects(setArtifactSharing(store, artifact.id, { ...shares, userPermissions: { [other.userId]: "edit" } }, { access: owner }), { statusCode: 400 });
    const report = await getArtifactAccessReport(store, artifact.id, { access: owner });
    const row = report.users.find((user) => user.id === reader.userId);
    assert.equal(row.permission, "comment");
    assert.deepEqual(row.reasons.sort(), ["direct:read", "team:Reviewers:comment"]);
    assert.equal(report.anonymousRead, false);
    await assert.rejects(getArtifactAccessReport(store, artifact.id, { access: reader }), { statusCode: 403 });
    const preview = await previewAccessMode(store, "public", { access: admin });
    assert.equal(preview.anonymousArtifactCount, 0);
    assert.equal(preview.total, 0);
    assert.deepEqual(preview.artifacts.map((entry) => entry.id), []);
    assert.deepEqual(await previewAccessMode(store, "private", { access: admin }), { mode: "private", anonymousArtifactCount: 0, total: 0, artifacts: [] });
    await assert.rejects(previewAccessMode(store, "public", { access: reader }), { statusCode: 403 });
    await setAccessMode(store, "public", { access: admin });
    const publicReport = await getArtifactAccessReport(store, artifact.id, { access: owner });
    assert.equal(publicReport.anonymousRead, false);
    assert.equal(publicReport.users.find((user) => user.id === other.userId).permission, "edit");
  });
});

test("v9 read grants migrate to v10 and old backup grants default to read", async () => {
  await fixture(async (store, { owner, reader }, artifact) => {
    await setArtifactSharing(store, artifact.id, { userIds: [reader.userId] }, { access: owner });
    const db = new DatabaseSync(store.dbPath);
    try {
      db.exec("ALTER TABLE artifact_shares DROP COLUMN permission");
      db.prepare("UPDATE meta SET value = '9' WHERE key = 'store_version'").run();
    } finally { db.close(); }
    assert.equal(await getArtifactPermission(store, artifact.id, { access: reader }), "read");
    const migrated = openDatabase(store);
    try { assert.equal(migrated.prepare("SELECT value FROM meta WHERE key='store_version'").get().value, "10"); }
    finally { migrated.close(); }
    const tables = await exportFullStoreTables(store);
    for (const grant of tables.artifactShares) delete grant.permission;
    await importFullStoreTables(store, tables, { forceUsers: true });
    assert.equal(await getArtifactPermission(store, artifact.id, { access: reader }), "read");
  });
});
