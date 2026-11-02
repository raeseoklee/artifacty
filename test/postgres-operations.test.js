import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createUpgradeBackup, verifyUpgradeBackup, listUpgradeBackups, restoreUpgradeBackup, openProtectedDatabase } from "../src/lib/upgrade-backup.js";
import { updateApplication, inspectWebUpdateService } from "../src/lib/self-update.js";
import { createWebUpdater } from "../src/lib/web-update.js";

const databaseUrl = "postgres://test:do-not-expose@example.invalid/artifacty";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const assertSafe = (error) => { assert.match(error.code, /^POSTGRES_/); assert.doesNotMatch(error.message, /do-not-expose|example\.invalid/); return true; };

test("PostgreSQL physical backup paths fail before creating files or initializing a SQLite database", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-pg-operations-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = { home, databaseBackend: "postgres", database: { kind: "postgres", connectionString: databaseUrl } };
  for (const action of [() => createUpgradeBackup(store), () => verifyUpgradeBackup(store, "unused"), () => listUpgradeBackups(store), () => restoreUpgradeBackup(store, "unused", { confirm: "restore-store" }), () => openProtectedDatabase(store, 11, () => assert.fail("initializer must not run"))]) assert.throws(action, assertSafe);
  assert.deepEqual(await readdir(home), []);
});

test("PostgreSQL self-update refuses mutation before invoking commands; check is unsupported", async () => {
  const calls = [];
  const injected = { env: { ARTIFACTY_DATABASE_URL: databaseUrl }, platform: "linux", uid: 1000, run: async (command, args) => { calls.push([command,args]); assert.equal(command,"npm"); assert.equal(args[0],"view"); return {stdout:'"99.0.0"'}; } };
  await assert.rejects(updateApplication({ packageRoot }, injected), assertSafe);
  assert.deepEqual(calls, []);
  const result = await updateApplication({ packageRoot, check: true }, injected);
  assert.equal(result.supported, false); assert.match(result.reason, /PostgreSQL/); assert.equal(calls.length, 1);
  await assert.rejects(inspectWebUpdateService({ home: "/unused" }, injected), assertSafe);
});

test("PostgreSQL web update status/check remain read-only and start cannot queue a worker", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-pg-web-update-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const updater = createWebUpdater({ home, packageRoot, databaseUrl }, { userHome: path.join(home,"absent-user"), run: async () => assert.fail("must not run commands"), inspect: async () => assert.fail("must not inspect service"), update: async () => assert.fail("must not stage update") });
  for (const state of [await updater.status("session"), await updater.check("session")]) { assert.equal(state.supported,false); assert.match(state.reason,/PostgreSQL/); }
  await assert.rejects(updater.start({}), assertSafe);
  assert.deepEqual(await readdir(home), []);
});


test("a bound PostgreSQL home blocks physical backups and updates when shell credentials are absent", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-pg-marker-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, ".postgres-store-id"), "fixture-store-id");
  assert.throws(() => createUpgradeBackup({home, databaseBackend:"sqlite"}), assertSafe);
  await assert.rejects(updateApplication({home, packageRoot, databaseUrl:null}, {env:{}, run:async()=>assert.fail("must not run")}), assertSafe);
  const updater=createWebUpdater({home,packageRoot,databaseUrl:null}, {env:{}, run:async()=>assert.fail("must not run")});
  assert.equal((await updater.check("session")).supported,false);
  assert.deepEqual(await readdir(home),[".postgres-store-id"]);
});
