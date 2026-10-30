import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archiveArtifact, awaitEmbeddingIndexing, createArtifact, createStore, createTeam, createUser, exportFullStoreTables,
  getArtifact, importFullStoreTables, listArtifactsPage, listAuditEvents, openDatabase, resetEmbeddingProvider, setAccessMode,
  setArtifactSharing, setEmbeddingProvider, setTeamMembers, setUserActive
} from "../src/lib/storage.js";
import {
  createCategory, deleteCategory, listCategories, listCategoryArtifactIds, listCategoryTeams,
  setCategoryArtifact, updateCategory
} from "../src/lib/categories.js";

async function fixture(fn) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-categories-"));
  const store = createStore({ home });
  const users = {};
  try {
    for (const name of ["admin", "owner", "member", "stranger"]) {
      const user = await createUser(store, { name, email: `${name}@example.test`, password: "password-123", role: name === "admin" ? "admin" : "user" });
      users[name] = { userId: user.id, role: user.role };
    }
    await fn(store, users);
  } finally { await rm(home, { recursive: true, force: true }); }
}

test("personal categories are owner-only and independent of tags, versions, and other categories", async () => {
  await fixture(async (store, { admin, owner, member }) => {
    const artifact = await createArtifact(store, { title: "Notes", content: "unchanged", tags: ["source"], access: owner });
    const one = await createCategory(store, { name: " Read next " }, { access: owner });
    const two = await createCategory(store, { name: "Project" }, { access: owner });
    assert.equal(one.name, "Read next");
    assert.equal(one.scope, "personal");
    assert.equal(one.ownerUserId, owner.userId);
    await setCategoryArtifact(store, one.id, artifact.id, true, { access: owner });
    await setCategoryArtifact(store, one.id, artifact.id, true, { access: owner });
    await setCategoryArtifact(store, two.id, artifact.id, true, { access: owner });
    assert.deepEqual(await listCategoryArtifactIds(store, one.id, { access: owner }), [artifact.id]);
    assert.deepEqual(await listCategories(store, { access: member }), []);
    assert.deepEqual(await listCategories(store, { access: admin }), []);
    const audit = await listAuditEvents(store, { access: member, artifactId: artifact.id });
    assert.ok(!JSON.stringify(audit).includes(one.id));
    assert.ok(!JSON.stringify(audit).includes(two.id));
    assert.ok(!JSON.stringify(await listAuditEvents(store, { access: admin, artifactId: artifact.id })).includes(one.id));
    await assert.rejects(updateCategory(store, one.id, { name: "Stolen" }, { access: admin }), { statusCode: 404 });
    await assert.rejects(deleteCategory(store, one.id, { access: member }), { statusCode: 404 });
    await assert.rejects(listCategoryArtifactIds(store, one.id, { access: member }), { statusCode: 404 });
    const memberships = await listCategories(store, { access: owner, artifactId: artifact.id });
    assert.ok(memberships.every((row) => row.artifactCount === 1 && row.containsArtifact));
    await updateCategory(store, one.id, { name: "Read today" }, { access: owner });
    await deleteCategory(store, one.id, { access: owner });
    assert.deepEqual(await listCategoryArtifactIds(store, two.id, { access: owner }), [artifact.id]);
    const after = await getArtifact(store, artifact.id, { access: owner });
    assert.equal(after.latestVersion, 1);
    assert.deepEqual(after.tags, ["source"]);
    assert.equal(after.content, "unchanged");
  });
});

test("semantic and hybrid category filters never rank artifacts outside the category", async () => {
  await fixture(async (store, { owner, member }) => {
    setEmbeddingProvider({
      name: "category-test", model: "category-test-v1", dimensions: 2,
      async embed(texts) { return texts.map(() => new Float32Array([1, 0])); }
    });
    try {
      const category = await createCategory(store, { name: "Research" }, { access: owner });
      const included = await createArtifact(store, { title: "Research note", content: "research", access: owner });
      await createArtifact(store, { title: "Research outside", content: "research", access: owner });
      await setCategoryArtifact(store, category.id, included.id, true, { access: owner });
      await awaitEmbeddingIndexing();
      for (const mode of ["semantic", "hybrid"]) {
        const page = await listArtifactsPage(store, { categoryId: category.id, query: "research", mode, access: owner });
        assert.equal(page.search.mode, mode);
        assert.equal(page.total, 1);
        assert.deepEqual(page.artifacts.map((artifact) => artifact.id), [included.id]);
        await assert.rejects(listArtifactsPage(store, { categoryId: category.id, query: "research", mode, access: member }), { statusCode: 404 });
      }
    } finally {
      await awaitEmbeddingIndexing();
      resetEmbeddingProvider();
    }
  });
});

test("team members collaborate on categories without gaining artifact access", async () => {
  await fixture(async (store, { admin, owner, member, stranger }) => {
    const team = await createTeam(store, { name: "Design" }, { access: admin });
    await setTeamMembers(store, team.id, [owner.userId, member.userId], { access: admin });
    const category = await createCategory(store, { name: "References", scope: "team", teamId: team.id }, { access: owner });
    const privateArtifact = await createArtifact(store, { title: "Private draft", content: "hidden", visibility: "private", access: owner });
    const sharedArtifact = await createArtifact(store, { title: "Team notes", content: "readable", visibility: "team", access: owner });
    await setCategoryArtifact(store, category.id, privateArtifact.id, true, { access: owner });
    await setCategoryArtifact(store, category.id, sharedArtifact.id, true, { access: owner });
    assert.deepEqual(await listCategoryTeams(store, { access: member }), [{ id: team.id, name: "Design" }]);
    assert.deepEqual(await listCategoryTeams(store, { access: stranger }), []);
    assert.equal((await listCategoryTeams(store, { access: admin })).length, 1);
    const listed = await listCategories(store, { access: member });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].artifactCount, 1);
    assert.deepEqual(await listCategoryArtifactIds(store, category.id, { access: member }), [sharedArtifact.id]);
    assert.ok(!JSON.stringify(listed).includes(privateArtifact.id));
    await assert.rejects(listCategories(store, { access: member, artifactId: privateArtifact.id }), { statusCode: 404 });
    await assert.rejects(setCategoryArtifact(store, category.id, privateArtifact.id, false, { access: member }), { statusCode: 404 });
    await assert.rejects(setCategoryArtifact(store, category.id, privateArtifact.id, true, { access: member }), { statusCode: 404 });
    await assert.rejects(createCategory(store, { name: "Intrusion", scope: "team", teamId: team.id }, { access: stranger }), { statusCode: 404 });
    assert.deepEqual(await listCategories(store, { access: stranger }), []);
    assert.equal((await updateCategory(store, category.id, { name: "Useful references" }, { access: member })).name, "Useful references");
    await setCategoryArtifact(store, category.id, sharedArtifact.id, false, { access: member });
    assert.deepEqual(await listCategoryArtifactIds(store, category.id, { access: member }), []);
    await deleteCategory(store, category.id, { access: admin });
    assert.equal((await getArtifact(store, sharedArtifact.id, { access: member })).id, sharedArtifact.id);
  });
});

test("membership, user activity, and database role revocations apply immediately", async () => {
  await fixture(async (store, { admin, owner, member, stranger }) => {
    const team = await createTeam(store, { name: "Review" }, { access: admin });
    await setTeamMembers(store, team.id, [owner.userId, member.userId], { access: admin });
    const category = await createCategory(store, { name: "Queue", scope: "team", teamId: team.id }, { access: owner });
    await setTeamMembers(store, team.id, [owner.userId], { access: admin });
    await assert.rejects(listCategoryArtifactIds(store, category.id, { access: member }), { statusCode: 404 });
    // A supplied/stale role must not elevate an ordinary account.
    await assert.rejects(updateCategory(store, category.id, { name: "Hijack" }, { access: { ...stranger, role: "admin" } }), { statusCode: 404 });
    const ownCategory = await createCategory(store, { name: "Saved as admin" }, { access: stranger });
    const privateArtifact = await createArtifact(store, { title: "Owner private", content: "secret", visibility: "private", access: owner });
    let db = openDatabase(store);
    try { db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(stranger.userId); }
    finally { db.close(); }
    await setCategoryArtifact(store, ownCategory.id, privateArtifact.id, true, { access: stranger });
    db = openDatabase(store);
    try { db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(stranger.userId); }
    finally { db.close(); }
    assert.deepEqual(await listCategoryArtifactIds(store, ownCategory.id, { access: { ...stranger, role: "admin" } }), []);
    assert.equal((await listArtifactsPage(store, { categoryId: ownCategory.id, access: { ...stranger, role: "admin" } })).total, 0);
    await setUserActive(store, owner.userId, false);
    await assert.rejects(listCategories(store, { access: owner }), { statusCode: 403 });
    await assert.rejects(listCategories(store), { statusCode: 403 });
    await assert.rejects(createCategory(store, { name: "Anonymous" }, { access: { anonymous: true } }), { statusCode: 403 });
  });
});

test("category counts and filters respect private sharing and archived artifacts before pagination", async () => {
  await fixture(async (store, { admin, owner, member }) => {
    const team = await createTeam(store, { name: "Operations" }, { access: admin });
    await setTeamMembers(store, team.id, [owner.userId, member.userId], { access: admin });
    const category = await createCategory(store, { name: "Runbooks", scope: "team", teamId: team.id }, { access: owner });
    const first = await createArtifact(store, { title: "Runbook one", content: "runbook", access: owner });
    const second = await createArtifact(store, { title: "Runbook two", content: "runbook", access: owner });
    await createArtifact(store, { title: "Outside category", content: "runbook", access: owner });
    await setCategoryArtifact(store, category.id, first.id, true, { access: owner });
    await setCategoryArtifact(store, category.id, second.id, true, { access: owner });
    const page = await listArtifactsPage(store, { categoryId: category.id, query: "runbook", mode: "keyword", limit: 1, access: member });
    assert.equal(page.total, 2);
    assert.equal(page.artifacts.length, 1);
    assert.equal(page.hasMore, true);
    const next = await listArtifactsPage(store, { categoryId: category.id, limit: 1, offset: 1, access: member });
    assert.equal(next.total, 2);
    assert.ok([first.id, second.id].includes(next.artifacts[0].id));
    await archiveArtifact(store, second.id, { access: owner });
    assert.equal((await listCategories(store, { access: member }))[0].artifactCount, 1);
    assert.equal((await listCategories(store, { access: member, includeArchived: true }))[0].artifactCount, 2);
    await setAccessMode(store, "private", { access: admin });
    assert.deepEqual(await listCategoryArtifactIds(store, category.id, { access: member }), []);
    await setArtifactSharing(store, first.id, { teamIds: [team.id] }, { access: owner });
    assert.deepEqual(await listCategoryArtifactIds(store, category.id, { access: member }), [first.id]);
    await assert.rejects(listArtifactsPage(store, { categoryId: category.id, access: { anonymous: true } }), { statusCode: 403 });
  });
});

test("category input validation prevents duplicate scopes and unintended sharing", async () => {
  await fixture(async (store, { admin, owner, member }) => {
    for (const name of ["", " ", "x".repeat(121), null, {}]) {
      await assert.rejects(createCategory(store, { name }, { access: owner }), { statusCode: 400 });
    }
    const category = await createCategory(store, { name: "Inbox" }, { access: owner });
    await assert.rejects(createCategory(store, { name: "inbox" }, { access: owner }), { statusCode: 409 });
    await createCategory(store, { name: "Inbox" }, { access: member });
    const team = await createTeam(store, { name: "Research" }, { access: admin });
    await setTeamMembers(store, team.id, [owner.userId], { access: admin });
    await createCategory(store, { name: "Inbox", scope: "team", teamId: team.id }, { access: owner });
    await assert.rejects(createCategory(store, { name: "Queue", scope: "public" }, { access: owner }), { statusCode: 400 });
    await assert.rejects(createCategory(store, { name: "Queue", scope: "team" }, { access: owner }), { statusCode: 400 });
    await assert.rejects(createCategory(store, { name: "Queue", teamId: team.id }, { access: owner }), { statusCode: 400 });
    await assert.rejects(updateCategory(store, category.id, { name: "Inbox", scope: "team", teamId: team.id }, { access: owner }), { statusCode: 400 });
    await assert.rejects(setCategoryArtifact(store, category.id, "missing", "true", { access: owner }), { statusCode: 400 });
    await assert.rejects(setCategoryArtifact(store, category.id, "missing", true, { access: owner }), { statusCode: 404 });
  });
});

test("full-store table backup preserves categories and memberships with cascade cleanup", async () => {
  await fixture(async (store, { admin, owner }) => {
    const team = await createTeam(store, { name: "Backup team" }, { access: admin });
    await setTeamMembers(store, team.id, [owner.userId], { access: admin });
    const personal = await createCategory(store, { name: "Personal" }, { access: owner });
    const shared = await createCategory(store, { name: "Shared", scope: "team", teamId: team.id }, { access: owner });
    const artifact = await createArtifact(store, { title: "Backup notes", content: "saved", access: owner });
    await setCategoryArtifact(store, personal.id, artifact.id, true, { access: owner });
    await setCategoryArtifact(store, shared.id, artifact.id, true, { access: owner });
    const tables = await exportFullStoreTables(store);
    assert.equal(tables.categories.length, 2);
    assert.equal(tables.categoryArtifacts.length, 2);
    await deleteCategory(store, personal.id, { access: owner });
    const restored = await importFullStoreTables(store, tables, { forceUsers: true });
    assert.equal(restored.categories, 2);
    assert.equal(restored.categoryArtifacts, 2);
    assert.deepEqual(await listCategoryArtifactIds(store, personal.id, { access: owner }), [artifact.id]);
    assert.deepEqual(await listCategoryArtifactIds(store, shared.id, { access: owner }), [artifact.id]);
    const db = openDatabase(store);
    try {
      db.prepare("DELETE FROM teams WHERE id = ?").run(team.id);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM category_artifacts WHERE category_id = ?").get(shared.id).n, 0);
      db.prepare("DELETE FROM artifacts WHERE id = ?").run(artifact.id);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM category_artifacts").get().n, 0);
    } finally { db.close(); }
  });
});
