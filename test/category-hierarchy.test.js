import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore, createUser, createTeam, awaitEmbeddingIndexing, setTeamMembers, createArtifact, getArtifact, openDatabase, exportFullStoreTables, importFullStoreTables, upgradePostgresStoreSchema, STORE_VERSION } from "../src/lib/storage.js";
import { createCategory, updateCategory, deleteCategory, listCategories, listCategoryArtifactIds, setCategoryArtifact, MAX_CATEGORY_DEPTH } from "../src/lib/categories.js";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-hierarchy-"));
  t.after(async () => { await awaitEmbeddingIndexing(); await rm(home, { recursive: true, force: true }); });
  const store = createStore({ home });
  const owner = await createUser(store, { email: "owner@example.test", password: "fixture-password", role: "admin" });
  const other = await createUser(store, { email: "other@example.test", password: "fixture-password" });
  return { store, owner: { userId: owner.id, role: "admin" }, other: { userId: other.id, role: "user" } };
}

test("nested categories preserve direct memberships and allow matching names in separate branches", async t => {
  const { store, owner } = await fixture(t);
  const first = await createCategory(store, { name: "Research" }, { access: owner });
  const second = await createCategory(store, { name: "Delivery" }, { access: owner });
  const child = await createCategory(store, { name: "Notes", parentId: first.id }, { access: owner });
  await createCategory(store, { name: "NOTES", parentId: second.id }, { access: owner });
  await assert.rejects(createCategory(store, { name: "notes", parentId: first.id }, { access: owner }), { code: "CATEGORY_EXISTS" });
  const artifact = await createArtifact(store, { title: "Private note", content: "untouched", visibility: "private", access: owner });
  await setCategoryArtifact(store, child.id, artifact.id, true, { access: owner });
  assert.deepEqual(await listCategoryArtifactIds(store, first.id, { access: owner }), []);
  const moved = await updateCategory(store, child.id, { parentId: second.id, name: "Moved" }, { access: owner });
  assert.equal(moved.parentId, second.id);
  assert.deepEqual(await listCategoryArtifactIds(store, child.id, { access: owner }), [artifact.id]);
  const unchanged = await getArtifact(store, artifact.id, { access: owner });
  assert.equal(unchanged.content, "untouched");
  assert.equal(unchanged.visibility, "private");
  assert.equal(unchanged.latestVersion, 1);
  assert.equal((await updateCategory(store, child.id, { parentId: null }, { access: owner })).parentId, null);
});

test("hierarchy rejects self references, cycles, deep subtrees and inaccessible parents atomically", async t => {
  const { store, owner, other } = await fixture(t);
  const root = await createCategory(store, { name: "Root" }, { access: owner });
  let parent = root;
  const nodes = [root];
  for (let depth = 2; depth <= MAX_CATEGORY_DEPTH; depth++) {
    parent = await createCategory(store, { name: `Level ${depth}`, parentId: parent.id }, { access: owner });
    nodes.push(parent);
  }
  await assert.rejects(createCategory(store, { name: "Too deep", parentId: parent.id }, { access: owner }), { code: "INVALID_CATEGORY" });
  await assert.rejects(updateCategory(store, root.id, { parentId: parent.id }, { access: owner }), { code: "INVALID_CATEGORY" });
  await assert.rejects(updateCategory(store, root.id, { parentId: root.id }, { access: owner }), { code: "INVALID_CATEGORY" });
  const another = await createCategory(store, { name: "Another" }, { access: owner });
  await assert.rejects(updateCategory(store, root.id, { parentId: another.id }, { access: owner }), { code: "INVALID_CATEGORY" });
  const otherRoot = await createCategory(store, { name: "Other" }, { access: other });
  await assert.rejects(createCategory(store, { name: "Forbidden", parentId: otherRoot.id }, { access: owner }), { code: "CATEGORY_NOT_FOUND" });
  assert.equal((await listCategories(store, { access: owner })).length, nodes.length + 1);
  assert.equal((await listCategories(store, { access: owner })).find(item => item.id === root.id).parentId, null);
});

test("team hierarchy stays inside one team and parent deletion cannot remove children", async t => {
  const { store, owner, other } = await fixture(t);
  const team = await createTeam(store, { name: "Product" }, { access: owner });
  const otherTeam = await createTeam(store, { name: "Operations" }, { access: owner });
  await setTeamMembers(store, team.id, [other.userId], { access: owner });
  const root = await createCategory(store, { name: "Roadmap", scope: "team", teamId: team.id }, { access: owner });
  const child = await createCategory(store, { name: "Next", scope: "team", teamId: team.id, parentId: root.id }, { access: other });
  const personal = await createCategory(store, { name: "Personal" }, { access: owner });
  await assert.rejects(updateCategory(store, personal.id, { parentId: root.id }, { access: owner }), { code: "INVALID_CATEGORY" });
  await assert.rejects(createCategory(store, { name: "Wrong team", scope: "team", teamId: otherTeam.id, parentId: root.id }, { access: owner }), { code: "INVALID_CATEGORY" });
  await assert.rejects(deleteCategory(store, root.id, { access: owner }), { code: "CATEGORY_HAS_CHILDREN", statusCode: 409 });
  assert.equal((await listCategories(store, { access: other })).length, 2);
  await updateCategory(store, child.id, { parentId: null }, { access: other });
  await deleteCategory(store, root.id, { access: owner });
  assert.equal((await listCategories(store, { access: other })).length, 1);
});

test("schema 11 flat categories migrate to roots behind a mandatory SQLite snapshot", async t => {
  const { store, owner } = await fixture(t);
  const root = await createCategory(store, { name: "Existing" }, { access: owner });
  const artifact = await createArtifact(store, { title: "Existing membership", content: "keep", access: owner });
  await setCategoryArtifact(store, root.id, artifact.id, true, { access: owner });
  const raw = new DatabaseSync(store.dbPath);
  try {
    raw.exec("DROP INDEX idx_categories_parent; DROP INDEX idx_categories_personal_sibling_name; DROP INDEX idx_categories_team_sibling_name; ALTER TABLE categories DROP COLUMN parent_id;");
    raw.prepare("UPDATE meta SET value = '11' WHERE key = 'store_version'").run();
  } finally { raw.close(); }
  const rows = await listCategories(store, { access: owner });
  assert.equal(rows[0].parentId, null);
  assert.equal(rows[0].id, root.id);
  assert.deepEqual(await listCategoryArtifactIds(store, root.id, { access: owner }), [artifact.id]);
  const db = openDatabase(store);
  try { assert.equal(db.prepare("SELECT value FROM meta WHERE key='store_version'").get().value, String(STORE_VERSION)); }
  finally { db.close(); }
  assert.ok((await readdir(path.join(store.home, "upgrade-backups"))).length > 0);
});

test("full backup restores out-of-order trees and rejects malformed hierarchies atomically", async t => {
  const { store, owner } = await fixture(t);
  const root = await createCategory(store, { name: "Root" }, { access: owner });
  const child = await createCategory(store, { name: "Child", parentId: root.id }, { access: owner });
  const tables = await exportFullStoreTables(store);
  tables.categories.reverse();
  await importFullStoreTables(store, tables, { forceUsers: true });
  assert.equal((await listCategories(store, { access: owner })).find(item => item.id === child.id).parentId, root.id);
  const malformed = await exportFullStoreTables(store);
  malformed.categories.find(item => item.id === root.id).parentId = child.id;
  await assert.rejects(importFullStoreTables(store, malformed, { forceUsers: true }), { code: "INVALID_CATEGORY_HIERARCHY" });
  assert.equal((await listCategories(store, { access: owner })).find(item => item.id === root.id).parentId, null);
});

test("explicit PostgreSQL migration requires confirmation before creating a store or connecting", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "artifacty-pg-confirm-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "not-created");
  await assert.rejects(upgradePostgresStoreSchema({ home }, {}), { code: "DATABASE_UPGRADE_CONFIRMATION_REQUIRED" });
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(upgradePostgresStoreSchema({ home, databaseUrl: null }, { confirm: "verified-backup" }), { code: "INVALID_DATABASE_BACKEND" });
});
