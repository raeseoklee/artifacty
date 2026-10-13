import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { archiveArtifact, createArtifact, createStore, createUser, openDatabase, setAccessMode, setArtifactOwner, setUserActive, updateArtifact } from "../src/lib/storage.js";
import { createShareLink, getShareLinkPolicy, listShareLinks, resolveShareLink, revokeShareLink, setShareLinkPolicy } from "../src/lib/share-links.js";

async function fixture(fn) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-links-"));
  try {
    const store = createStore({ home });
    const users = {};
    for (const name of ["admin", "owner", "other"]) {
      const user = await createUser(store, { name, email: `${name}@example.com`, password: "password-123", role: name === "admin" ? "admin" : "user" });
      users[name] = { userId: user.id, role: user.role };
    }
    const artifact = await createArtifact(store, { title: "Manual", content: "first", format: "text", ownerUserId: users.owner.userId, visibility: "private" });
    await fn({ store, artifact, ...users });
  } finally { await rm(home, { recursive: true, force: true }); }
}

test("share links pin versions or follow latest and persist only token hashes", () => fixture(async ({ store, artifact, owner, other }) => {
  const latest = createShareLink(store, artifact.id, {}, { access: owner });
  const pinned = createShareLink(store, artifact.id, { version: 1 }, { access: owner });
  assert.equal(latest.token.length, 43);
  assert.ok(Date.parse(latest.expiresAt) > Date.now());
  await updateArtifact(store, artifact.id, { content: "second", access: owner });
  assert.equal((await resolveShareLink(store, latest.token)).content, "second");
  assert.equal((await resolveShareLink(store, pinned.token)).content, "first");
  const listed = listShareLinks(store, artifact.id, { access: owner });
  assert.equal(JSON.stringify(listed).includes(latest.token), false);
  assert.equal(JSON.stringify(listed).includes("hash"), false);
  const db = openDatabase(store);
  try { assert.equal(JSON.stringify(db.prepare("SELECT * FROM artifact_share_links").all()).includes(latest.token), false); }
  finally { db.close(); }
  assert.throws(() => createShareLink(store, artifact.id, {}, { access: other }), { statusCode: 403 });
  assert.throws(() => listShareLinks(store, artifact.id, { access: other }), { statusCode: 403 });
  assert.throws(() => revokeShareLink(store, artifact.id, latest.id, { access: other }), { statusCode: 403 });
  revokeShareLink(store, artifact.id, latest.id, { access: owner });
  await assert.rejects(resolveShareLink(store, latest.token), { statusCode: 404 });
}));

test("private policy disables existing links and only active administrators can change it", () => fixture(async ({ store, artifact, admin, owner }) => {
  assert.deepEqual(getShareLinkPolicy(store), { enabledInPrivate: false });
  const link = createShareLink(store, artifact.id, {}, { access: owner });
  await setAccessMode(store, "private", { access: admin });
  await assert.rejects(resolveShareLink(store, link.token), { statusCode: 404 });
  assert.throws(() => createShareLink(store, artifact.id, {}, { access: owner }), { statusCode: 403 });
  assert.throws(() => setShareLinkPolicy(store, { enabledInPrivate: true }, { access: owner }), { statusCode: 403 });
  setShareLinkPolicy(store, { enabledInPrivate: true }, { access: admin });
  assert.equal((await resolveShareLink(store, link.token)).content, "first");
  setShareLinkPolicy(store, { enabledInPrivate: false }, { access: admin });
  await assert.rejects(resolveShareLink(store, link.token), { statusCode: 404 });
  await setUserActive(store, admin.userId, false);
  assert.throws(() => setShareLinkPolicy(store, { enabledInPrivate: true }, { access: admin }), { statusCode: 403 });
}));

test("expired malformed archived disabled-issuer and ownership-changed links fail closed", () => fixture(async ({ store, artifact, owner, admin, other }) => {
  for (const expiresAt of [null, "bad", "2000-01-01T00:00:00Z"]) {
    assert.throws(() => createShareLink(store, artifact.id, { expiresAt }, { access: owner }), { statusCode: 400 });
  }
  assert.throws(() => createShareLink(store, artifact.id, { version: 999 }, { access: owner }), { statusCode: 400 });
  const link = createShareLink(store, artifact.id, {}, { access: owner });
  for (const token of ["bad", "x".repeat(43)]) await assert.rejects(resolveShareLink(store, token), { statusCode: 404 });
  await setUserActive(store, owner.userId, false);
  await assert.rejects(resolveShareLink(store, link.token), { statusCode: 404 });
  await setUserActive(store, owner.userId, true);
  await setArtifactOwner(store, artifact.id, other.userId, { access: admin });
  await assert.rejects(resolveShareLink(store, link.token), { statusCode: 404 });
  const next = createShareLink(store, artifact.id, {}, { access: other });
  const db = openDatabase(store);
  try { db.prepare("UPDATE artifact_share_links SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00Z", next.id); }
  finally { db.close(); }
  await assert.rejects(resolveShareLink(store, next.token), { statusCode: 404 });
  const archived = createShareLink(store, artifact.id, {}, { access: other });
  await archiveArtifact(store, artifact.id, { access: other });
  await assert.rejects(resolveShareLink(store, archived.token), { statusCode: 404 });
}));

test("deleted artifacts or pinned versions and forged admin roles cannot authorize links", () => fixture(async ({ store, artifact, owner, other }) => {
  assert.throws(() => createShareLink(store, artifact.id, {}, { access: { ...other, role: "admin" } }), { statusCode: 403 });
  assert.throws(() => setShareLinkPolicy(store, { enabledInPrivate: true }, { access: { ...other, role: "admin" } }), { statusCode: 403 });
  const pinned = createShareLink(store, artifact.id, { version: 1 }, { access: owner });
  const latest = createShareLink(store, artifact.id, {}, { access: owner });
  await updateArtifact(store, artifact.id, { content: "second", access: owner });
  const db = openDatabase(store);
  try { db.prepare("DELETE FROM artifact_versions WHERE artifact_id = ? AND version = 1").run(artifact.id); }
  finally { db.close(); }
  await assert.rejects(resolveShareLink(store, pinned.token), { statusCode: 404 });
  assert.equal((await resolveShareLink(store, latest.token)).content, "second");
  const remove = openDatabase(store);
  try { remove.prepare("DELETE FROM artifacts WHERE id = ?").run(artifact.id); }
  finally { remove.close(); }
  await assert.rejects(resolveShareLink(store, latest.token), { statusCode: 404 });
}));
