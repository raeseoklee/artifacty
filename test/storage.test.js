import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ARTIFACT_FORMATS,
  ARTIFACT_TYPES,
  archiveArtifact,
  checkStoreIntegrity,
  authenticateApiToken,
  changeUserPassword,
  countUsers,
  createApiToken,
  contentTypeForFormat,
  createArtifact,
  createStore,
  createSession,
  createUser,
  deleteArtifactVersion,
  getSessionUser,
  getArtifact,
  importUsersFromCsv,
  listAuditEvents,
  listArtifacts,
  listArtifactsPage,
  listApiTokens,
  listUsers,
  rebuildSearchIndex,
  revokeApiToken,
  revokeSession,
  restoreArtifact,
  replaceArtifactVersion,
  updateArtifact,
  verifyUserPassword
} from "../src/lib/storage.js";

test("creates, lists, reads, and versions artifacts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-storage-"));
  try {
    const store = createStore({ home });
    const created = await createArtifact(store, {
      title: "Review Notes",
      content: "# Notes",
      format: "markdown",
      artifactType: "handoff",
      sourceAgent: "codex",
      tags: ["review"]
    });

    assert.equal(created.title, "Review Notes");
    assert.equal(created.schemaVersion, 1);
    assert.equal(created.artifactType, "handoff");
    assert.equal(created.archivedAt, null);
    assert.equal(created.latestVersion, 1);
    assert.equal(created.version.format, "markdown");
    assert.equal(created.content, "# Notes");

    const list = await listArtifacts(store, { tag: "review" });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);

    const updated = await updateArtifact(store, created.id, {
      title: "Review Notes",
      content: "# Updated",
      format: "markdown",
      sourceAgent: "gemini",
      tags: ["review", "handoff"]
    });
    assert.equal(updated.latestVersion, 2);

    const v1 = await getArtifact(store, created.id, { version: 1 });
    const v2 = await getArtifact(store, created.id);
    assert.equal(v1.content, "# Notes");
    assert.equal(v2.content, "# Updated");
    assert.equal(v2.sourceAgent, "gemini");
    assert.deepEqual(v2.tags, ["review", "handoff"]);

    const contentOnlyUpdate = await updateArtifact(store, created.id, {
      content: "# Content only",
      format: "markdown"
    });
    assert.equal(contentOnlyUpdate.title, "Review Notes");
    assert.equal(contentOnlyUpdate.latestVersion, 3);

    const archived = await archiveArtifact(store, created.id);
    assert.ok(archived.archivedAt);
    assert.equal((await listArtifacts(store, {})).length, 0);
    assert.equal((await listArtifacts(store, { includeArchived: true })).length, 1);

    const restored = await restoreArtifact(store, created.id);
    assert.equal(restored.archivedAt, null);
    assert.equal((await listArtifacts(store, {})).length, 1);

    const auditEvents = await listAuditEvents(store, { artifactId: created.id, limit: 20 });
    const actions = auditEvents.map((event) => event.action);
    assert.ok(actions.includes("create"));
    assert.ok(actions.includes("update"));
    assert.ok(actions.includes("read"));
    assert.ok(actions.includes("archive"));
    assert.ok(actions.includes("restore"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("skips no-op web edits and lets admins repair or delete versions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-version-admin-"));
  try {
    const store = createStore({ home });
    const created = await createArtifact(store, {
      title: "Version Cleanup",
      content: "first",
      format: "text",
      sourceAgent: "codex",
      tags: ["cleanup"]
    });

    const noop = await updateArtifact(store, created.id, {
      title: "Version Cleanup",
      content: "first",
      format: "text",
      sourceAgent: "codex",
      tags: ["cleanup"],
      skipNoop: true
    });
    assert.equal(noop.latestVersion, 1);

    const updated = await updateArtifact(store, created.id, {
      title: "Version Cleanup",
      content: "wrong",
      format: "text",
      sourceAgent: "codex",
      tags: ["cleanup"]
    });
    assert.equal(updated.latestVersion, 2);

    const repaired = await replaceArtifactVersion(store, created.id, 1, {
      content: "fixed first",
      format: "text",
      reason: "Correct bad initial content"
    });
    assert.equal(repaired.version.version, 1);
    assert.equal(repaired.content, "fixed first");

    const deleted = await deleteArtifactVersion(store, created.id, 2, {
      reason: "Remove accidental edit"
    });
    assert.equal(deleted.latestVersion, 1);
    assert.equal(deleted.content, "fixed first");
    assert.equal(deleted.versions.length, 1);

    await assert.rejects(
      () => deleteArtifactVersion(store, created.id, 1),
      /Cannot delete the only version/
    );

    const integrity = await checkStoreIntegrity(store);
    assert.equal(integrity.ok, true);

    const auditEvents = await listAuditEvents(store, { artifactId: created.id, limit: 20 });
    const actions = auditEvents.map((event) => event.action);
    assert.ok(actions.includes("update-noop"));
    assert.ok(actions.includes("version-repair"));
    assert.ok(actions.includes("version-delete"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("stores extended artifact formats and taxonomy", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-format-taxonomy-"));
  try {
    assert.ok(ARTIFACT_FORMATS.includes("code"));
    assert.ok(ARTIFACT_FORMATS.includes("svg"));
    assert.ok(ARTIFACT_FORMATS.includes("mermaid"));
    assert.ok(ARTIFACT_FORMATS.includes("react"));
    assert.ok(ARTIFACT_FORMATS.includes("sarif"));
    assert.ok(ARTIFACT_FORMATS.includes("csv"));
    assert.ok(ARTIFACT_FORMATS.includes("image"));
    assert.ok(ARTIFACT_FORMATS.includes("video"));
    assert.ok(ARTIFACT_TYPES.includes("diagram"));
    assert.ok(ARTIFACT_TYPES.includes("component"));
    assert.ok(ARTIFACT_TYPES.includes("snippet"));
    assert.ok(ARTIFACT_TYPES.includes("analysis-report"));
    assert.ok(ARTIFACT_TYPES.includes("table"));

    const store = createStore({ home });
    const sarifReport = JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "CodeQL" } },
          results: []
        }
      ]
    });
    const cases = [
      {
        title: "Snippet",
        content: "console.log('ok');",
        format: "code",
        artifactType: "snippet",
        extension: ".code"
      },
      {
        title: "Diagram SVG",
        content: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
        format: "svg",
        artifactType: "diagram",
        extension: ".svg"
      },
      {
        title: "Mermaid",
        content: "flowchart TD\n  A --> B",
        format: "mermaid",
        artifactType: "diagram",
        extension: ".mmd"
      },
      {
        title: "Component",
        content: "export default function App() { return <div />; }",
        format: "react",
        artifactType: "component",
        extension: ".jsx"
      },
      {
        title: "SARIF Report",
        content: sarifReport,
        format: "sarif",
        artifactType: "analysis-report",
        extension: ".sarif"
      },
      {
        title: "CSV Table",
        content: "name,count\nCodex,2\nArtifacty,10",
        format: "csv",
        artifactType: "table",
        extension: ".csv"
      },
      {
        title: "Screenshot",
        content: "iVBORw0KGgo=",
        format: "image",
        artifactType: "asset",
        contentType: "image/png",
        extension: ".image"
      },
      {
        title: "Demo Video",
        content: Buffer.from("webm").toString("base64"),
        format: "video",
        artifactType: "asset",
        contentType: "video/webm",
        extension: ".video"
      }
    ];

    for (const item of cases) {
      const artifact = await createArtifact(store, {
        title: item.title,
        content: item.content,
        format: item.format,
        artifactType: item.artifactType,
        contentType: item.contentType,
        sourceAgent: "test"
      });
      assert.equal(artifact.version.format, item.format);
      assert.equal(artifact.version.contentType, item.contentType || contentTypeForFormat(item.format));
      assert.equal(artifact.artifactType, item.artifactType);
      assert.ok(artifact.version.path.endsWith(item.extension));
    }

    const inferred = await createArtifact(store, {
      title: "Inferred Mermaid",
      content: "flowchart TD\n  A --> B",
      format: "mermaid",
      sourceAgent: "test"
    });
    assert.equal(inferred.artifactType, "diagram");

    const inferredSarif = await createArtifact(store, {
      title: "Inferred SARIF",
      content: sarifReport,
      format: "sarif",
      sourceAgent: "test"
    });
    assert.equal(inferredSarif.artifactType, "analysis-report");

    const inferredFindingsCsv = await createArtifact(store, {
      title: "Security Findings",
      content: "severity,file,message\nwarning,src/app.js,Check input",
      format: "csv",
      sourceAgent: "test"
    });
    assert.equal(inferredFindingsCsv.artifactType, "analysis-report");

    const inferredImage = await createArtifact(store, {
      title: "Inferred Image",
      content: "iVBORw0KGgo=",
      contentType: "image/png",
      sourceAgent: "test"
    });
    assert.equal(inferredImage.version.format, "image");
    assert.equal(inferredImage.artifactType, "asset");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("infers HTML format for native artifacts when format is omitted", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-html-infer-"));
  try {
    const store = createStore({ home });
    const artifact = await createArtifact(store, {
      title: "HTML Fragment",
      content: "<section><h1>Ready</h1><p>Rendered as HTML</p></section>",
      sourceAgent: "codex"
    });

    assert.equal(artifact.version.format, "html");
    assert.equal(artifact.version.contentType, "text/html; charset=utf-8");
    assert.equal(artifact.artifactType, "html-page");
    assert.ok(artifact.version.path.endsWith(".html"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("records artifact publishers and backfills legacy rows from audit actors", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-publishers-"));
  try {
    const store = createStore({ home });
    const user = await createUser(store, {
      email: "publisher@example.com",
      name: "Publisher User",
      role: "user",
      password: "password-123"
    });
    const artifact = await createArtifact(store, {
      title: "Publisher Note",
      content: "owned content",
      format: "markdown",
      sourceAgent: "codex",
      audit: {
        actor: "publisher@example.com",
        userId: user.id,
        publisherName: user.name,
        surface: "test"
      }
    });

    assert.equal(artifact.publisherId, "publisher@example.com");
    assert.equal(artifact.publisherName, "Publisher User");
    assert.equal(artifact.publisherUserId, user.id);

    const page = await listArtifactsPage(store, { query: "publisher@example.com" });
    assert.equal(page.total, 1);
    assert.equal(page.artifacts[0].publisherId, "publisher@example.com");

    const browserArtifact = await createArtifact(store, {
      title: "Legacy Browser Note",
      content: "browser content",
      format: "text",
      sourceAgent: "artifacty",
      audit: {
        actor: "Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        surface: "web"
      }
    });
    const curlArtifact = await createArtifact(store, {
      title: "Legacy Curl Note",
      content: "curl content",
      format: "text",
      sourceAgent: "artifacty",
      audit: {
        actor: "curl/8.7.1",
        surface: "http-api"
      }
    });

    const db = new DatabaseSync(store.dbPath);
    try {
      db.prepare(`
        UPDATE artifacts
        SET publisher_id = NULL, publisher_name = NULL, publisher_user_id = NULL
        WHERE id IN (?, ?)
      `).run(artifact.id, browserArtifact.id);
    } finally {
      db.close();
    }

    const backfilled = await getArtifact(store, artifact.id);
    assert.equal(backfilled.publisherId, "publisher@example.com");
    assert.equal(backfilled.publisherName, "Publisher User");
    assert.equal(backfilled.publisherUserId, user.id);

    const skipped = await getArtifact(store, browserArtifact.id);
    assert.equal(skipped.publisherId, null);
    assert.equal(skipped.publisherName, null);
    assert.equal(skipped.publisherUserId, null);

    const cleared = await getArtifact(store, curlArtifact.id);
    assert.equal(cleared.publisherId, null);
    assert.equal(cleared.publisherName, null);
    assert.equal(cleared.publisherUserId, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("blocks detected secrets unless explicitly allowed", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-secrets-"));
  try {
    const store = createStore({ home });
    const fakeGithubToken = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    await assert.rejects(
      createArtifact(store, {
        title: "Secret",
        content: `token ${fakeGithubToken}`,
        format: "text"
      }),
      /Secret scan blocked/
    );

    const artifact = await createArtifact(store, {
      title: "Allowed Secret",
      content: `token ${fakeGithubToken}`,
      format: "text",
      allowSecrets: true
    });
    assert.equal(artifact.version.metadata.secretScan.status, "allowed");
    assert.equal(artifact.version.metadata.secretScan.findingCount, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("manages users, sessions, and hashed API tokens", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-users-"));
  try {
    const store = createStore({ home });
    assert.equal(await countUsers(store), 0);

    const admin = await createUser(store, {
      email: "Admin@Example.com",
      name: "Admin",
      role: "admin",
      password: "password-123"
    });
    assert.equal(admin.email, "admin@example.com");
    assert.equal(admin.role, "admin");
    assert.equal(await countUsers(store), 1);
    assert.equal((await listUsers(store))[0].email, "admin@example.com");

    const session = await createSession(store, admin.id);
    const sessionUser = await getSessionUser(store, session.token);
    assert.equal(sessionUser.email, "admin@example.com");
    assert.equal(await revokeSession(store, session.token), true);
    assert.equal(await getSessionUser(store, session.token), null);

    const createdToken = await createApiToken(store, admin.id, { name: "Codex" });
    assert.match(createdToken.token, /^arty_/);
    assert.equal((await listApiTokens(store, admin.id))[0].name, "Codex");
    const auth = await authenticateApiToken(store, createdToken.token);
    assert.equal(auth.actor, "admin@example.com");
    assert.equal(auth.user.role, "admin");
    assert.equal(await revokeApiToken(store, createdToken.record.id, admin.id), true);
    assert.equal(await authenticateApiToken(store, createdToken.token), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("imports users from CSV with generated temporary passwords", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-users-csv-"));
  try {
    const store = createStore({ home });
    await createUser(store, {
      email: "existing@example.com",
      name: "Existing",
      role: "user",
      password: "password-000"
    });

    const result = await importUsersFromCsv(store, [
      "email,name,role,password,password_reset_required",
      "new@example.com,New User,user,,",
      "admin2@example.com,Admin Two,admin,password-222,true",
      "existing@example.com,Existing,user,,",
      "bad@example.com,Bad,owner,,"
    ].join("\n"));

    assert.equal(result.created.length, 2);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(result.created[0].user.email, "new@example.com");
    assert.equal(result.created[0].user.passwordResetRequired, true);
    assert.equal(result.created[0].passwordGenerated, true);
    assert.match(result.created[0].temporaryPassword, /^tmp_[A-Za-z0-9_-]+$/);
    assert.equal(result.created[1].user.role, "admin");
    assert.equal(result.created[1].temporaryPassword, undefined);
    assert.match(result.failed[0].error, /Unsupported user role/);

    const tempLogin = await verifyUserPassword(store, "new@example.com", result.created[0].temporaryPassword);
    assert.equal(tempLogin.passwordResetRequired, true);

    const changed = await changeUserPassword(store, tempLogin.id, {
      currentPassword: result.created[0].temporaryPassword,
      newPassword: "new-password-123"
    });
    assert.equal(changed.passwordResetRequired, false);
    assert.equal(await verifyUserPassword(store, "new@example.com", result.created[0].temporaryPassword), null);
    const nextLogin = await verifyUserPassword(store, "new@example.com", "new-password-123");
    assert.equal(nextLogin.passwordResetRequired, false);

    const generatedNoResetOverride = await importUsersFromCsv(store, "email,name,role\nforced@example.com,Forced,user", {
      passwordResetRequired: false
    });
    assert.equal(generatedNoResetOverride.created[0].user.passwordResetRequired, true);

    const providedNoReset = await importUsersFromCsv(store, "email,name,role,password,password_reset_required\nready@example.com,Ready,user,password-333,false");
    assert.equal(providedNoReset.created[0].user.passwordResetRequired, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("migrates legacy JSON index into SQLite store", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-legacy-"));
  try {
    const artifactDir = path.join(home, "artifacts", "legacy-note");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "v1.md"), "# Legacy", "utf8");
    await writeFile(path.join(home, "index.json"), JSON.stringify({
      version: 1,
      artifacts: [
        {
          id: "legacy-note",
          title: "Legacy Note",
          artifactType: "document",
          schemaVersion: 1,
          sourceAgent: "claude",
          tags: ["legacy"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          latestVersion: 1,
          versions: [
            {
              version: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
              format: "markdown",
              contentType: "text/markdown; charset=utf-8",
              path: path.join("artifacts", "legacy-note", "v1.md"),
              sizeBytes: 8,
              sha256: "legacy-sha",
              metadata: { migrated: true }
            }
          ]
        }
      ]
    }), "utf8");

    const store = createStore({ home });
    const artifacts = await listArtifacts(store, { tag: "legacy" });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].id, "legacy-note");
    assert.equal(existsSync(store.dbPath), true);

    const artifact = await getArtifact(store, "legacy-note");
    assert.equal(artifact.content, "# Legacy");
    assert.deepEqual(artifact.version.metadata, { migrated: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("paginates artifact lists and searches latest content with FTS5 when available", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-search-"));
  try {
    const store = createStore({ home });
    const first = await createArtifact(store, {
      title: "First Note",
      content: "metadata only",
      format: "markdown",
      sourceAgent: "test"
    });
    const second = await createArtifact(store, {
      title: "Second Note",
      content: "body-only-needle lives here",
      format: "markdown",
      sourceAgent: "test"
    });
    await createArtifact(store, {
      title: "Third Note",
      content: "another note",
      format: "markdown",
      sourceAgent: "test"
    });

    const page = await listArtifactsPage(store, { limit: 2, offset: 1 });
    assert.equal(page.total, 3);
    assert.equal(page.limit, 2);
    assert.equal(page.offset, 1);
    assert.equal(page.artifacts.length, 2);
    assert.equal(page.hasMore, false);
    assert.equal(page.previousOffset, 0);

    const rebuild = await rebuildSearchIndex(store);
    if (!rebuild.fts5) {
      assert.equal(rebuild.ok, false);
      return;
    }

    const bodySearch = await listArtifactsPage(store, { query: "body-only-needle" });
    assert.equal(bodySearch.search.backend, "fts5");
    assert.equal(bodySearch.total, 1);
    assert.equal(bodySearch.artifacts[0].id, second.id);
    assert.match(bodySearch.artifacts[0].searchSnippet, /body-only-needle/);

    await updateArtifact(store, second.id, {
      content: "latest-only-token replaces the previous body",
      format: "markdown",
      sourceAgent: "test"
    });
    const oldBodySearch = await listArtifactsPage(store, { query: "body-only-needle" });
    assert.equal(oldBodySearch.total, 0);
    const latestBodySearch = await listArtifactsPage(store, { query: "latest-only-token" });
    assert.equal(latestBodySearch.total, 1);
    assert.equal(latestBodySearch.artifacts[0].id, second.id);

    const metadataSearch = await listArtifacts(store, { query: "First Note" });
    assert.equal(metadataSearch.length, 1);
    assert.equal(metadataSearch[0].id, first.id);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("checks store integrity for missing, changed, and orphaned version files", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-integrity-"));
  try {
    const store = createStore({ home });
    const artifact = await createArtifact(store, {
      title: "Integrity Note",
      content: "original",
      format: "text",
      sourceAgent: "test"
    });

    const clean = await checkStoreIntegrity(store);
    assert.equal(clean.ok, true);
    assert.equal(clean.artifactCount, 1);
    assert.equal(clean.versionCount, 1);

    await writeFile(path.join(store.home, artifact.version.path), "changed!", "utf8");
    await mkdir(path.join(store.artifactsDir, "orphan"), { recursive: true });
    await writeFile(path.join(store.artifactsDir, "orphan", "v1.txt"), "orphan", "utf8");

    const broken = await checkStoreIntegrity(store);
    assert.equal(broken.ok, false);
    assert.equal(broken.hashMismatches.length, 1);
    assert.equal(broken.hashMismatches[0].artifactId, artifact.id);
    assert.equal(broken.sizeMismatches.length, 0);
    assert.equal(broken.orphanFiles.length, 1);
    assert.equal(broken.orphanFiles[0].path, path.join("artifacts", "orphan", "v1.txt"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
