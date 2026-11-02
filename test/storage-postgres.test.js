import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { databaseConfiguration, isPostgresStore, readDatabaseBackend } from "../src/lib/database-config.js";
import { openPostgresDatabase } from "../src/lib/postgres-database.js";
import { createStore, ensureStore, createArtifact, updateArtifact, getArtifact, listArtifactsPage,
  createUser, createTeam, setTeamMembers, setArtifactSharing, setAccessMode, openDatabase,
  checkStoreIntegrity, rebuildSearchIndex, exportFullStoreTables, createApiToken, authenticateApiToken,
  addComment, listComments, listEventsSince, latestEventSeq, setEmbeddingProvider, resetEmbeddingProvider,
  awaitEmbeddingIndexing, transaction } from "../src/lib/storage.js";
import { createCategory, setCategoryArtifact, listCategories } from "../src/lib/categories.js";
import { buildStoreBackup, importStoreBundle } from "../src/lib/backup.js";

const databaseUrl = process.env.ARTIFACTY_TEST_POSTGRES_URL;
const options = { skip: !databaseUrl };
const schemaName = () => `test_storage_${randomUUID().replaceAll("-", "")}`;
async function fixture(fn) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-pg-storage-"));
  const schema = schemaName();
  const store = createStore({ home, databaseUrl, databaseSchema: schema });
  try { await fn(store); }
  finally {
    const db = openPostgresDatabase({ connectionString: databaseUrl, schema });
    try { db.exec(`DROP SCHEMA ${schema} CASCADE`); } finally { db.close(); }
    await rm(home, { recursive: true, force: true });
  }
}

test("database configuration keeps SQLite default and validates/redacts PostgreSQL settings", async () => {
  assert.equal(databaseConfiguration({}, {}).kind, "sqlite");
  assert.equal(databaseConfiguration({ databaseUrl: null }, { ARTIFACTY_DATABASE_URL: "invalid" }).kind, "sqlite");
  for (const databaseUrl of ["bad", "https://secret:password@example.test/db", "postgres://localhost/", "postgres://localhost/db#fragment"]) assert.throws(() => databaseConfiguration({ databaseUrl }, {}), { code: "INVALID_DATABASE_CONFIG" });
  for (const databaseSchema of ["public", "pg_catalog", "other;DROP", "UPPER", "information_schema"]) assert.throws(() => databaseConfiguration({ databaseUrl: "postgres://localhost/db", databaseSchema }, {}), { code: "INVALID_DATABASE_CONFIG" });
  const store = createStore({ home: "/tmp/not-an-existing-pg-home", databaseUrl: "postgres://secret:password@localhost/db" });
  assert.equal(store.databaseBackend, "postgres"); assert.equal(store.dbPath, null);
  assert.doesNotMatch(JSON.stringify(store), /secret|password|postgres:/);
});

test("PostgreSQL stores preserve artifacts, access, categories, body search and version conflicts", options, async () => fixture(async store => {
  await ensureStore(store);
  const admin = await createUser(store, { email: "admin@example.test", name: "Admin", password: "password-123", role: "admin" });
  const reader = await createUser(store, { email: "reader@example.test", password: "password-123" });
  const adminAccess = { userId: admin.id, role: "admin" };
  const readerAccess = { userId: reader.id, role: "user" };
  await setAccessMode(store, "private", { access: adminAccess });
  const team = await createTeam(store, { name: "Product" }, { access: adminAccess });
  await assert.rejects(createTeam(store, { name: "PRODUCT" }, { access: adminAccess }));
  await setTeamMembers(store, team.id, [reader.id], { access: adminAccess });
  const a = await createArtifact(store, { title: "PG document", content: "A distinctive-body token with 50%_literal.", format: "markdown", visibility: "private", access: adminAccess });
  await assert.rejects(getArtifact(store, a.id, { access: readerAccess }), { statusCode: 404 });
  await setArtifactSharing(store, a.id, { teamIds: [team.id] }, { access: adminAccess });
  assert.equal((await getArtifact(store, a.id, { access: readerAccess })).content, a.content);
  const category = await createCategory(store, { name: "Reading", scope: "team", teamId: team.id }, { access: readerAccess });
  await assert.rejects(createCategory(store, { name: "READING", scope: "team", teamId: team.id }, { access: readerAccess }), { code: "CATEGORY_EXISTS" });
  await setCategoryArtifact(store, category.id, a.id, true, { access: readerAccess });
  assert.equal((await listCategories(store, { access: readerAccess }))[0].artifactCount, 1);
  const page = await listArtifactsPage(store, { query: "distinctive-body", access: readerAccess, categoryId: category.id });
  assert.equal(page.total, 1); assert.equal(page.search.backend, "postgres-substring");
  assert.equal((await listArtifactsPage(store, { query: "50%_literal", access: readerAccess })).total, 1);
  await updateArtifact(store, a.id, { content: "Second version", expectedVersion: 1, access: adminAccess });
  await assert.rejects(updateArtifact(store, a.id, { content: "Wrong version", expectedVersion: 1, access: adminAccess }), { statusCode: 409 });
  assert.equal((await getArtifact(store, a.id, { version: 1, access: readerAccess })).content, a.content);
  assert.equal((await listArtifactsPage(store, { query: "distinctive-body", access: readerAccess })).total, 0);
  assert.equal((await rebuildSearchIndex(store)).backend, "postgres-substring");
  assert.equal((await checkStoreIntegrity(store)).ok, true);
  const token = await createApiToken(store, reader.id, { name: "Reader", scopes: ["read"] });
  assert.equal((await authenticateApiToken(store, token.token)).user.id, reader.id);
  assert.ok(await latestEventSeq(store) > 0);
  assert.equal((await exportFullStoreTables(store)).meta.some(row => row.key === "postgres_home_binding"), false);
}));

test("PostgreSQL home binding and version guards fail closed without SQLite fallback", options, async () => fixture(async store => {
  await ensureStore(store);
  assert.equal(readDatabaseBackend(store.home), "postgres"); assert.equal(isPostgresStore({ home: store.home }), true);
  assert.throws(() => createStore({ home: store.home }), { code: "DATABASE_CONFIG_REQUIRED" });
  assert.throws(() => createStore({ home: store.home, databaseUrl: null }), { code: "DATABASE_BACKEND_CONFLICT" });
  await assert.rejects(access(path.join(store.home, "artifacty.sqlite")));
  const otherHome = await mkdtemp(path.join(tmpdir(), "artifacty-pg-wrong-home-"));
  try { await assert.rejects(ensureStore(createStore({ home: otherHome, databaseUrl, databaseSchema: store.database.schema })), { code: "DATABASE_HOME_MISMATCH" }); }
  finally { await rm(otherHome, { recursive: true, force: true }); }
  const db = openDatabase(store); db.prepare("UPDATE meta SET value = ? WHERE key = 'store_version'").run("999"); db.close();
  await assert.rejects(ensureStore(store), { code: "NEWER_STORE_VERSION" });
  const raw = openPostgresDatabase(store.database); raw.prepare("UPDATE meta SET value = ? WHERE key = 'store_version'").run("10"); raw.close();
  await assert.rejects(ensureStore(store), { code: "POSTGRES_MIGRATION_REQUIRED" });
}));

test("full JSON backups migrate SQLite to PostgreSQL and back with accounts and version files", options, async () => fixture(async target => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-pg-source-"));
  const restoredHome = await mkdtemp(path.join(tmpdir(), "artifacty-pg-restored-"));
  const source = createStore({ home, databaseUrl: null });
  const restored = createStore({ home: restoredHome, databaseUrl: null });
  try {
    const user = await createUser(source, { email: "owner@example.test", password: "password-123", role: "admin" });
    const a = await createArtifact(source, { title: "Migrating document", content: "Original", format: "text", ownerUserId: user.id, visibility: "private" });
    await updateArtifact(source, a.id, { content: "Current" });
    const token = await createApiToken(source, user.id, { name: "Moving client" });
    await addComment(source, a.id, { body: "Keep this comment", authorLabel: "Owner" });
    await importStoreBundle(target, await buildStoreBackup(source, { scope: "full" }), { confirm: "replace-all" });
    assert.equal((await getArtifact(target, a.id)).content, "Current");
    assert.equal((await getArtifact(target, a.id, { version: 1 })).content, "Original");
    assert.equal((await listComments(target, a.id))[0].body, "Keep this comment");
    assert.equal((await authenticateApiToken(target, token.token)).user.id, user.id);
    await importStoreBundle(restored, await buildStoreBackup(target, { scope: "full" }), { confirm: "replace-all" });
    assert.equal((await getArtifact(restored, a.id)).content, "Current");
    assert.equal((await checkStoreIntegrity(restored)).ok, true);
  } finally { await rm(home, { recursive: true, force: true }); await rm(restoredHome, { recursive: true, force: true }); }
}));

test("PostgreSQL BYTEA embeddings round-trip and semantic search uses the selected provider", options, async () => fixture(async store => {
  setEmbeddingProvider({ name: "postgres-test", model: "v1", dimensions: 2, async embed(texts) { return texts.map(() => new Float32Array([1, 0])); } });
  try {
    const artifact = await createArtifact(store, { title: "Semantic example", content: "A backup guide", format: "text" });
    await awaitEmbeddingIndexing(store, artifact.id);
    const result = await listArtifactsPage(store, { query: "recover lost records", mode: "semantic" });
    assert.equal(result.artifacts[0].id, artifact.id);
    const exported = await exportFullStoreTables(store);
    assert.equal(exported.embeddings.length, 1);
    assert.equal(Buffer.from(exported.embeddings[0].vector, "base64").byteLength, 8);
  } finally { await awaitEmbeddingIndexing(store); resetEmbeddingProvider(); }
}));


test("PostgreSQL selection refuses an existing SQLite home before writing a binding", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-pg-conflict-"));
  try {
    await writeFile(path.join(home, "artifacty.sqlite"), "existing SQLite bytes");
    assert.throws(() => createStore({ home, databaseUrl: "postgres://localhost/example" }), { code: "DATABASE_BACKEND_CONFLICT" });
    await assert.rejects(access(path.join(home, ".postgres-store-id")));
  } finally { await rm(home, { recursive: true, force: true }); }
});


test("PostgreSQL updates requiring automatic backup fail before changing application state", options, async () => fixture(async store => {
  await ensureStore(store);
  const db = openDatabase(store);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'application_version'").run("0.0.0"); db.close();
  const previous = process.env.ARTIFACTY_BACKUP_ON_UPDATE;
  process.env.ARTIFACTY_BACKUP_ON_UPDATE = "true";
  try { await assert.rejects(ensureStore(store), { code: "POSTGRES_BACKUP_REQUIRED" }); }
  finally { if (previous === undefined) delete process.env.ARTIFACTY_BACKUP_ON_UPDATE; else process.env.ARTIFACTY_BACKUP_ON_UPDATE = previous; }
  const raw = openPostgresDatabase(store.database);
  try { assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'application_version'").get().value, "0.0.0"); }
  finally { raw.close(); }
}));
