import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore, ensureStore, createUser, awaitEmbeddingIndexing, createArtifact, openDatabase, upgradePostgresStoreSchema, exportFullStoreTables, importFullStoreTables } from "../src/lib/storage.js";
import { openPostgresDatabase } from "../src/lib/postgres-database.js";
import { createCategory, listCategories, updateCategory, setCategoryArtifact, listCategoryArtifactIds } from "../src/lib/categories.js";

const databaseUrl = process.env.ARTIFACTY_TEST_POSTGRES_URL;
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-pg-category-migration-"));
  const schema = `test_hierarchy_${randomUUID().replaceAll("-", "")}`;
  const options = { home, databaseUrl, databaseSchema: schema };
  const store = createStore(options);
  t.after(async () => {
    await awaitEmbeddingIndexing();
    const db = openPostgresDatabase(store.database);
    try { db.exec(`DROP SCHEMA ${schema} CASCADE`); } finally { db.close(); }
    await rm(home, { recursive: true, force: true });
  });
  await ensureStore(store);
  const user = await createUser(store, { email: "admin@example.test", password: "fixture-password", role: "admin" });
  return { store, options, access: { userId: user.id, role: "admin" } };
}

test("PostgreSQL schema 11 upgrades only through explicit backup acknowledgment and preserves flat data", { skip: !databaseUrl }, async t => {
  const { store, options, access } = await fixture(t);
  const category = await createCategory(store, { name: "Existing" }, { access });
  const artifact = await createArtifact(store, { title: "Existing", content: "preserve", access });
  await setCategoryArtifact(store, category.id, artifact.id, true, { access });
  let db = openPostgresDatabase(store.database);
  try {
    db.exec("DROP INDEX idx_categories_parent; DROP INDEX idx_categories_personal_sibling_name; DROP INDEX idx_categories_team_sibling_name; ALTER TABLE categories DROP COLUMN parent_id");
    db.prepare("UPDATE meta SET value = '11' WHERE key = 'store_version'").run();
  } finally { db.close(); }
  await assert.rejects(ensureStore(store), { code: "POSTGRES_MIGRATION_REQUIRED" });
  await assert.rejects(upgradePostgresStoreSchema(options), { code: "DATABASE_UPGRADE_CONFIRMATION_REQUIRED" });
  db = openPostgresDatabase(store.database);
  try { assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'store_version'").get().value, "11"); }
  finally { db.close(); }
  const migrated = await upgradePostgresStoreSchema(options, { confirm: "verified-backup" });
  assert.deepEqual(migrated, { backend: "postgres", previousVersion: 11, currentVersion: 12, upgraded: true });
  assert.equal((await listCategories(store, { access }))[0].parentId, null);
  assert.deepEqual(await listCategoryArtifactIds(store, category.id, { access }), [artifact.id]);
  const child = await createCategory(store, { name: "Child", parentId: category.id }, { access });
  assert.equal(child.parentId, category.id);
  await assert.rejects(updateCategory(store, category.id, { parentId: child.id }, { access }), { code: "INVALID_CATEGORY" });
  const tables = await exportFullStoreTables(store);
  tables.categories.reverse();
  await importFullStoreTables(store, tables, { forceUsers: true });
  assert.equal((await listCategories(store, { access })).find(row => row.id === child.id).parentId, category.id);
  assert.equal((await upgradePostgresStoreSchema(options, { confirm: "verified-backup" })).upgraded, false);
});

test("PostgreSQL schema upgrade refuses older and newer unrecognized schemas", { skip: !databaseUrl }, async t => {
  const { store, options } = await fixture(t);
  for (const version of [10, 13]) {
    const db = openPostgresDatabase(store.database);
    try { db.prepare("UPDATE meta SET value = ? WHERE key = 'store_version'").run(String(version)); }
    finally { db.close(); }
    await assert.rejects(upgradePostgresStoreSchema(options, { confirm: "verified-backup" }), { code: "POSTGRES_MIGRATION_REQUIRED" });
  }
});

test("PostgreSQL schema upgrade blocks live or malformed managed-server markers before connection", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-pg-migration-offline-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const options = { home, databaseUrl: databaseUrl || "postgresql://fixture@127.0.0.1:9/fixture" };
  await writeFile(path.join(home, "server.json"), JSON.stringify({ pid: process.pid }));
  await assert.rejects(upgradePostgresStoreSchema(options, { confirm: "verified-backup" }), { code: "STORE_NOT_OFFLINE" });
  await writeFile(path.join(home, "server.json"), "invalid marker");
  await assert.rejects(upgradePostgresStoreSchema(options, { confirm: "verified-backup" }), { code: "STORE_NOT_OFFLINE" });
});


test("database upgrade CLI requires backup acknowledgment before creating a store", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "artifacty-cli-schema-confirm-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "store");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [cli, "database", "upgrade", "--home", home], {
    env: { ...process.env, ARTIFACTY_DATABASE_URL: "postgresql://fixture:secret@example.test:9/fixture" }
  }), error => /--confirm verified-backup/.test(error.stderr) && !error.stderr.includes("secret"));
  await assert.rejects(access(home), { code: "ENOENT" });
});

test("database upgrade CLI reads its PostgreSQL configuration and reports a safe no-op", { skip: !databaseUrl }, async t => {
  const { store } = await fixture(t);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const result = await promisify(execFile)(process.execPath, [cli, "database", "upgrade", "--confirm", "verified-backup", "--home", store.home], {
    env: { ...process.env, ARTIFACTY_DATABASE_URL: databaseUrl, ARTIFACTY_DATABASE_SCHEMA: store.database.schema, ARTIFACTY_EMBEDDINGS_PROVIDER: "disabled" }
  });
  assert.deepEqual(JSON.parse(result.stdout), { backend: "postgres", previousVersion: 12, currentVersion: 12, upgraded: false });
  assert.ok(!result.stdout.includes(databaseUrl));
});
