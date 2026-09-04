import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildStoreBackup, exportStore, importStore, importStoreBundle, importStoreFromString, defaultBackupPath } from "../src/lib/backup.js";
import {
  addComment,
  addRelation,
  checkStoreIntegrity,
  createApiToken,
  createArtifact,
  createStore,
  createUser,
  createWebhook,
  getArtifact,
  listArtifacts,
  listAuditEvents,
  listComments,
  listUsers,
  listWebhooks
} from "../src/lib/storage.js";
import { createLaunchAgentPlist, createSystemdUserUnit, createWindowsTaskScript, serviceCommand } from "../src/lib/service.js";

test("exports and imports a complete store backup", async () => {
  const sourceHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-src-"));
  const targetHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-dst-"));
  try {
    const sourceStore = createStore({ home: sourceHome });
    const created = await createArtifact(sourceStore, {
      title: "Backup Demo",
      content: "# Backup",
      format: "markdown",
      sourceAgent: "test"
    });
    const backupFile = path.join(sourceHome, "backup.json");

    const exported = await exportStore(sourceStore, backupFile);
    assert.equal(exported.artifactCount, 1);

    const targetStore = createStore({ home: targetHome });
    const imported = await importStore(targetStore, backupFile);
    assert.equal(imported.artifactCount, 1);

    const artifacts = await listArtifacts(targetStore);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].id, created.id);
    assert.equal((await getArtifact(targetStore, created.id)).content, "# Backup");
  } finally {
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  }
});

test("store restore replaces artifact files without leaving orphans", async () => {
  const sourceHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-replace-src-"));
  const targetHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-replace-dst-"));
  try {
    const sourceStore = createStore({ home: sourceHome });
    const kept = await createArtifact(sourceStore, {
      title: "Kept",
      content: "kept",
      format: "text",
      sourceAgent: "test"
    });
    const backupFile = path.join(sourceHome, "backup.json");
    await exportStore(sourceStore, backupFile);

    const targetStore = createStore({ home: targetHome });
    const removed = await createArtifact(targetStore, {
      title: "Removed",
      content: "removed",
      format: "text",
      sourceAgent: "test"
    });
    assert.notEqual(kept.id, removed.id);

    await importStore(targetStore, backupFile);
    const artifacts = await listArtifacts(targetStore);
    assert.deepEqual(artifacts.map((artifact) => artifact.id), [kept.id]);

    const integrity = await checkStoreIntegrity(targetStore);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.orphanFiles.length, 0);
  } finally {
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  }
});

test("store restore rejects unsafe backup version paths", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-backup-path-"));
  try {
    const store = createStore({ home });
    for (const unsafePath of ["../outside.txt", "..\\outside.txt", "C:\\outside.txt"]) {
      const malicious = JSON.stringify({
        schemaVersion: 1,
        artifacts: [
          {
            id: "malicious",
            title: "Malicious",
            artifactType: "document",
            schemaVersion: 1,
            sourceAgent: "test",
            tags: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            latestVersion: 1,
            versions: [
              {
                version: 1,
                createdAt: new Date().toISOString(),
                format: "text",
                contentType: "text/plain; charset=utf-8",
                path: unsafePath,
                sizeBytes: 3,
                sha256: "bad",
                metadata: {},
                content: "bad"
              }
            ]
          }
        ]
      });

      await assert.rejects(
        () => importStoreFromString(store, malicious),
        /Invalid Artifacty backup version path/
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("store restore normalizes portable backup paths across operating systems", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-backup-portable-"));
  try {
    const store = createStore({ home });
    const content = "portable";
    const backup = JSON.stringify({
      schemaVersion: 1,
      artifacts: [
        {
          id: "portable",
          title: "Portable",
          artifactType: "document",
          schemaVersion: 1,
          sourceAgent: "test",
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          latestVersion: 1,
          versions: [
            {
              version: 1,
              createdAt: new Date().toISOString(),
              format: "text",
              contentType: "text/plain; charset=utf-8",
              path: "artifacts\\portable\\v1.txt",
              sizeBytes: Buffer.byteLength(content),
              sha256: createHash("sha256").update(content).digest("hex"),
              metadata: {},
              content
            }
          ]
        }
      ]
    });

    await importStoreFromString(store, backup);
    assert.equal((await getArtifact(store, "portable")).content, content);
    const restored = await getArtifact(store, "portable");
    assert.equal(restored.version.path, "artifacts/portable/v1.txt");
    assert.equal((await checkStoreIntegrity(store)).ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function seedFullStore(store) {
  const first = await createArtifact(store, {
    title: "First",
    content: "one",
    format: "text",
    sourceAgent: "test"
  });
  const second = await createArtifact(store, {
    title: "Second",
    content: "two",
    format: "text",
    sourceAgent: "test"
  });
  await addRelation(store, { fromId: first.id, toId: second.id, relation: "references" });
  await addComment(store, first.id, { body: "Looks good." });
  const user = await createUser(store, { email: "admin@example.com", password: "correct-horse-battery", role: "admin" });
  const created = await createUser(store, { email: "member@example.com", password: "correct-horse-battery", role: "user" });
  await createApiToken(store, created.id, { name: "ci" });
  await createWebhook(store, { url: "https://example.com/hook", eventTypes: [] });
  return { first, second, user, created };
}

test("full-scope backup bundle round trips users, tokens, audit log, relations, and webhooks", async () => {
  const sourceHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-full-src-"));
  const targetHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-full-dst-"));
  try {
    const sourceStore = createStore({ home: sourceHome });
    await seedFullStore(sourceStore);

    const bundle = await buildStoreBackup(sourceStore, { scope: "full" });
    assert.equal(bundle.bundleVersion, 2);
    assert.equal(bundle.scope, "full");
    assert.equal(typeof bundle.storeVersion, "number");
    assert.ok(bundle.full);
    assert.equal(bundle.full.sessions, undefined, "sessions must never be exported");
    assert.equal(bundle.full.users.length, 2);
    assert.equal(bundle.full.apiTokens.length, 1);
    assert.equal(bundle.full.relations.length, 1);
    assert.equal(bundle.full.webhooks.length, 1);
    assert.equal(bundle.full.webhooks[0].secretMissing, true);
    assert.equal(bundle.full.webhooks[0].secretHash, undefined);
    assert.equal(bundle.full.comments.length, 1);
    assert.equal(bundle.full.comments[0].body, "Looks good.");
    assert.ok(bundle.full.auditLog.length > 0);

    const targetStore = createStore({ home: targetHome });
    const result = await importStoreBundle(targetStore, bundle, { confirm: "replace-all" });
    assert.equal(result.scope, "full");
    assert.equal(result.artifactCount, 2);
    assert.equal(result.tableCounts.users, 2);
    assert.equal(result.tableCounts.apiTokens, 1);
    assert.equal(result.tableCounts.relations, 1);
    assert.equal(result.tableCounts.webhooks, 1);
    assert.equal(result.tableCounts.comments, 1);

    const users = await listUsers(targetStore);
    assert.deepEqual(users.map((item) => item.email).sort(), ["admin@example.com", "member@example.com"]);

    const restoredArtifacts = await listArtifacts(targetStore);
    const restoredFirst = restoredArtifacts.find((item) => item.title === "First");
    const restoredComments = await listComments(targetStore, restoredFirst.id);
    assert.equal(restoredComments.length, 1);
    assert.equal(restoredComments[0].body, "Looks good.");

    const webhooks = await listWebhooks(targetStore);
    assert.equal(webhooks.length, 1);
    assert.ok(webhooks[0].disabledAt, "restored webhook must be disabled until its secret is re-issued");

    const auditEvents = await listAuditEvents(targetStore, { limit: 50 });
    const importRow = auditEvents.find((event) => event.action === "backup-import");
    assert.ok(importRow, "expected a backup-import audit row");
    assert.equal(importRow.metadata.scope, "full");
    assert.equal(importRow.metadata.counts.users, 2);
  } finally {
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  }
});

test("v1 backup bundles (no bundleVersion/scope) still import as artifacts-only", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-backup-v1-"));
  try {
    const store = createStore({ home });
    const legacyBundle = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      artifacts: [
        {
          id: "legacy",
          title: "Legacy",
          artifactType: "document",
          schemaVersion: 1,
          sourceAgent: "test",
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          latestVersion: 1,
          versions: [
            {
              version: 1,
              createdAt: new Date().toISOString(),
              format: "text",
              contentType: "text/plain; charset=utf-8",
              path: "artifacts/legacy/v1.txt",
              sizeBytes: 5,
              sha256: createHash("sha256").update("hello").digest("hex"),
              metadata: {},
              content: "hello"
            }
          ]
        }
      ]
    };

    const result = await importStoreBundle(store, legacyBundle);
    assert.equal(result.scope, "artifacts");
    assert.equal(result.artifactCount, 1);
    assert.equal((await getArtifact(store, "legacy")).content, "hello");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("full-scope restore refuses without confirm: replace-all", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-backup-noconfirm-"));
  try {
    const store = createStore({ home });
    await seedFullStore(store);
    const bundle = await buildStoreBackup(store, { scope: "full" });

    const targetHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-noconfirm-dst-"));
    try {
      const targetStore = createStore({ home: targetHome });
      await assert.rejects(
        () => importStoreBundle(targetStore, bundle),
        (error) => {
          assert.equal(error.code, "confirm_required");
          assert.equal(error.statusCode, 400);
          return true;
        }
      );
    } finally {
      await rm(targetHome, { recursive: true, force: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("full-scope restore refuses when target already has users unless forceUsers is set", async () => {
  const sourceHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-users-src-"));
  const targetHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-users-dst-"));
  try {
    const sourceStore = createStore({ home: sourceHome });
    await seedFullStore(sourceStore);
    const bundle = await buildStoreBackup(sourceStore, { scope: "full" });

    const targetStore = createStore({ home: targetHome });
    await createUser(targetStore, { email: "existing@example.com", password: "correct-horse-battery", role: "admin" });

    await assert.rejects(
      () => importStoreBundle(targetStore, bundle, { confirm: "replace-all" }),
      (error) => {
        assert.equal(error.code, "users_exist");
        assert.equal(error.statusCode, 409);
        return true;
      }
    );

    // forceUsers overrides the refusal and replaces the target's users.
    const result = await importStoreBundle(targetStore, bundle, { confirm: "replace-all", forceUsers: true });
    assert.equal(result.tableCounts.users, 2);
    const users = await listUsers(targetStore);
    assert.deepEqual(users.map((item) => item.email).sort(), ["admin@example.com", "member@example.com"]);
  } finally {
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  }
});

test("full-scope restore is atomic: a malformed bundle.full is rejected before artifacts are replaced", async () => {
  const sourceHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-atomic-src-"));
  const targetHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-atomic-dst-"));
  try {
    const sourceStore = createStore({ home: sourceHome });
    await seedFullStore(sourceStore);
    const bundle = await buildStoreBackup(sourceStore, { scope: "full" });
    // Corrupt one full.users row so importFullStoreTables would hit a NOT
    // NULL constraint violation partway through, after writeIndex had
    // already replaced the target's artifacts table.
    bundle.full.users[0] = { ...bundle.full.users[0], email: null };

    const targetStore = createStore({ home: targetHome });
    const existingUser = await createUser(targetStore, { email: "keep-me@example.com", password: "correct-horse-battery", role: "admin" });
    const existingArtifact = await createArtifact(targetStore, {
      title: "Target-only artifact",
      content: "must survive",
      format: "text",
      sourceAgent: "test"
    });

    await assert.rejects(
      () => importStoreBundle(targetStore, bundle, { confirm: "replace-all", forceUsers: true }),
      (error) => {
        assert.equal(error.code, "INVALID_BACKUP");
        return true;
      }
    );

    // The target must be entirely unchanged: the malformed bundle.full must
    // be caught before writeIndex ever touched the artifacts table.
    const artifacts = await listArtifacts(targetStore);
    assert.deepEqual(artifacts.map((item) => item.id), [existingArtifact.id]);
    const users = await listUsers(targetStore);
    assert.deepEqual(users.map((item) => item.id), [existingUser.id]);
  } finally {
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  }
});

test("artifacts-scope restore refuses when the target has comments/relations, and warns once confirmed", async () => {
  const sourceHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-artifacts-dep-src-"));
  const targetHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-artifacts-dep-dst-"));
  try {
    const sourceStore = createStore({ home: sourceHome });
    const sourceArtifact = await createArtifact(sourceStore, {
      title: "Replacement",
      content: "new content",
      format: "text",
      sourceAgent: "test"
    });
    const bundle = await buildStoreBackup(sourceStore, { scope: "artifacts" });

    const targetStore = createStore({ home: targetHome });
    await seedFullStore(targetStore); // gives the target comments and relations

    await assert.rejects(
      () => importStoreBundle(targetStore, bundle),
      (error) => {
        assert.equal(error.code, "dependents_exist");
        assert.equal(error.statusCode, 409);
        return true;
      }
    );

    const result = await importStoreBundle(targetStore, bundle, { confirm: "replace-all" });
    assert.equal(result.scope, "artifacts");
    assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0, "expected a warning about deleted comments/relations");
    const restored = await listArtifacts(targetStore);
    assert.deepEqual(restored.map((item) => item.id), [sourceArtifact.id]);
  } finally {
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  }
});

test("full-scope backup bundle round trips embeddings", async () => {
  const sourceHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-embeddings-src-"));
  const targetHome = await mkdtemp(path.join(tmpdir(), "artifacty-backup-embeddings-dst-"));
  try {
    const { upsertArtifactEmbedding, listArtifactEmbeddings } = await import("../src/lib/storage.js");
    const sourceStore = createStore({ home: sourceHome });
    const artifact = await createArtifact(sourceStore, {
      title: "Embedded",
      content: "hello",
      format: "text",
      sourceAgent: "test"
    });
    await upsertArtifactEmbedding(sourceStore, {
      artifactId: artifact.id,
      version: 1,
      provider: "test-provider",
      model: "test-model",
      vector: [0.1, 0.2, 0.3]
    });

    const bundle = await buildStoreBackup(sourceStore, { scope: "full" });
    assert.ok(Array.isArray(bundle.full.embeddings));
    assert.equal(bundle.full.embeddings.length, 1);
    assert.equal(typeof bundle.full.embeddings[0].vector, "string", "vector must be base64-encoded for JSON transport");

    const targetStore = createStore({ home: targetHome });
    const result = await importStoreBundle(targetStore, bundle, { confirm: "replace-all" });
    assert.equal(result.tableCounts.embeddings, 1);

    const restoredEmbeddings = await listArtifactEmbeddings(targetStore, { provider: "test-provider", model: "test-model" });
    assert.equal(restoredEmbeddings.length, 1);
    assert.equal(restoredEmbeddings[0].artifactId, artifact.id);
    assert.deepEqual(Array.from(restoredEmbeddings[0].vector).map((n) => Math.round(n * 10) / 10), [0.1, 0.2, 0.3]);
  } finally {
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  }
});

test("full-scope backup file is written with 0600 permissions", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-backup-mode-"));
  try {
    const store = createStore({ home });
    await seedFullStore(store);
    const file = path.join(home, "full-backup.json");

    await exportStore(store, file, { scope: "full" });
    const stats = await stat(file);
    assert.equal(stats.mode & 0o777, 0o600);

    const artifactsOnlyFile = path.join(home, "artifacts-backup.json");
    await exportStore(store, artifactsOnlyFile);
    const artifactsOnlyStats = await stat(artifactsOnlyFile);
    assert.notEqual(artifactsOnlyStats.mode & 0o777, 0o600, "artifacts-only export should not be force-restricted");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("builds LaunchAgent service definitions without writing in dry run", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-service-"));
  try {
    const plistPath = path.join(home, "com.artifacty.server.plist");
    const plist = createLaunchAgentPlist({
      projectDir: process.cwd(),
      home,
      host: "127.0.0.1",
      port: 8787
    });
    assert.match(plist, /com\.artifacty\.server/);
    assert.match(plist, /ARTIFACTY_HOME/);

    const result = await serviceCommand("install", {
      platform: "macos",
      projectDir: process.cwd(),
      home,
      plistPath,
      dryRun: true
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.changed, true);
    assert.match(result.content, /ProgramArguments/);
    assert.ok(defaultBackupPath(createStore({ home })).startsWith(path.join(home, "backups")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("builds Linux systemd user service definitions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-service-linux-"));
  try {
    const unitPath = path.join(home, "com.artifacty.server.service");
    const unit = createSystemdUserUnit({
      projectDir: process.cwd(),
      home,
      host: "127.0.0.1",
      port: 8787,
      apiToken: "service-token",
      mcpHttp: true
    });

    assert.match(unit, /\[Unit\]/);
    assert.match(unit, /ExecStart=/);
    assert.match(unit, /ARTIFACTY_HOME=/);
    assert.match(unit, /ARTIFACTY_API_TOKEN=service-token/);
    assert.match(unit, /--mcp-http/);
    assert.match(unit, /Restart=on-failure/);

    const result = await serviceCommand("install", {
      platform: "linux",
      projectDir: process.cwd(),
      home,
      unitPath,
      dryRun: true
    });
    assert.equal(result.platform, "linux");
    assert.equal(result.path, unitPath);
    assert.match(result.content, /WantedBy=default\.target/);
    assert.ok(result.nextSteps.some((step) => step.includes("systemctl --user enable --now")));
    assert.ok(result.nextSteps.some((step) => step.includes("loginctl enable-linger")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("builds Windows scheduled task installer scripts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-service-windows-"));
  try {
    const scriptPath = path.join(home, "install-artifacty-server-task.ps1");
    const script = createWindowsTaskScript({
      projectDir: process.cwd(),
      home,
      host: "127.0.0.1",
      port: 8787,
      apiToken: "service-token",
      mcpHttp: true
    });

    assert.match(script, /Register-ScheduledTask/);
    assert.match(script, /ArtifactyServer/);
    assert.match(script, /Start-ScheduledTask/);
    assert.match(script, /--api-token service-token/);
    assert.match(script, /--mcp-http/);

    const result = await serviceCommand("task", {
      platform: "windows",
      projectDir: process.cwd(),
      home,
      scriptPath
    });
    assert.equal(result.platform, "windows");
    assert.equal(result.path, scriptPath);
    assert.match(result.content, /New-ScheduledTaskAction/);
    assert.ok(result.nextSteps.some((step) => step.includes("powershell")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
