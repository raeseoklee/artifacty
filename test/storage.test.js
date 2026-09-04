import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  addComment,
  addRelation,
  ARTIFACT_FORMATS,
  ARTIFACT_TYPES,
  archiveArtifact,
  checkStoreIntegrity,
  authenticateApiToken,
  BUNDLE_BINARY_CONTENT_TYPES,
  changeUserPassword,
  countUsers,
  createApiToken,
  contentTypeForFormat,
  createArtifact,
  createSavedView,
  createStore,
  createSession,
  createUser,
  isSafeBundleFilePath,
  MAX_BUNDLE_FILE_BYTES,
  readBundleFile,
  deleteComment,
  deleteSavedView,
  listComments,
  listSavedViews,
  MAX_COMMENT_BYTES,
  resolveComment,
  resolveSavedView,
  REVIEW_STATUSES,
  SAVED_VIEW_FILTER_KEYS,
  deleteArtifactVersion,
  getSessionUser,
  getArtifact,
  importUsersFromCsv,
  inverseRelation,
  listAuditEvents,
  listArtifacts,
  listArtifactsPage,
  listApiTokens,
  listRelations,
  listUsers,
  openDatabase,
  rebuildSearchIndex,
  removeRelation,
  RELATION_TYPES,
  revokeApiToken,
  revokeSession,
  restoreArtifact,
  replaceArtifactVersion,
  setReviewStatus,
  updateArtifact,
  verifyUserPassword,
  artifactEtag,
  VersionConflictError
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
    assert.equal(contentOnlyUpdate.sourceAgent, "gemini");
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("skips no-op web edits and lets admins repair or delete versions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-version-admin-"));
  try {
    const store = createStore({ home });
    const aliased = await createArtifact(store, {
      title: "Aliased Source",
      content: "alias",
      format: "text",
      sourceAgent: "Claude Code"
    });
    assert.equal(aliased.sourceAgent, "claude");

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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("replaceArtifactVersion and deleteArtifactVersion enforce owner/admin access like other admin repair actions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-version-access-"));
  try {
    const store = createStore({ home });
    const owner = await createUser(store, { email: "owner@example.com", password: "correct-horse-battery", role: "user" });
    const stranger = await createUser(store, { email: "stranger@example.com", password: "correct-horse-battery", role: "user" });
    const admin = await createUser(store, { email: "admin@example.com", password: "correct-horse-battery", role: "admin" });

    // Team visibility (the default), not private: a stranger can still read
    // this artifact, so replaceArtifactVersion/deleteArtifactVersion's
    // rejection below exercises assertArtifactManageable's ForbiddenError
    // specifically, not assertArtifactReadable's 404-instead-of-403 for a
    // private artifact a non-owner can't even see.
    const artifact = await createArtifact(store, {
      title: "Guarded",
      content: "v1",
      format: "text",
      sourceAgent: "codex",
      ownerUserId: owner.id
    });
    await updateArtifact(store, artifact.id, { content: "v2", format: "text" });

    const strangerAccess = { userId: stranger.id, role: "user" };
    const ownerAccess = { userId: owner.id, role: "user" };
    const adminAccess = { userId: admin.id, role: "admin" };
    const v1Path = path.join(home, "artifacts", artifact.id, "v1.txt");
    const v2Path = path.join(home, "artifacts", artifact.id, "v2.txt");

    // A non-owner, non-admin cannot repair or delete a version.
    await assert.rejects(
      () => replaceArtifactVersion(store, artifact.id, 1, { content: "hacked", format: "text", access: strangerAccess }),
      (error) => {
        assert.equal(error.name, "ForbiddenError");
        return true;
      }
    );
    assert.equal(await readFile(v1Path, "utf8"), "v1", "a rejected repair must leave the original version file untouched");

    await assert.rejects(
      () => deleteArtifactVersion(store, artifact.id, 2, { access: strangerAccess }),
      (error) => {
        assert.equal(error.name, "ForbiddenError");
        return true;
      }
    );
    assert.ok(existsSync(v2Path), "a rejected delete must leave the version file in place");

    // The owner can still repair and delete.
    const repaired = await replaceArtifactVersion(store, artifact.id, 1, {
      content: "fixed v1",
      format: "text",
      access: ownerAccess
    });
    assert.equal(repaired.content, "fixed v1");

    const deleted = await deleteArtifactVersion(store, artifact.id, 2, { access: ownerAccess });
    assert.equal(deleted.latestVersion, 1);
    assert.equal(existsSync(v2Path), false, "an allowed delete must remove the version file");

    // An admin can manage another user's private artifact too.
    await updateArtifact(store, artifact.id, { content: "v3", format: "text", access: ownerAccess });
    const adminRepaired = await replaceArtifactVersion(store, artifact.id, 1, {
      content: "fixed by admin",
      format: "text",
      access: adminAccess
    });
    assert.equal(adminRepaired.content, "fixed by admin");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    assert.ok(ARTIFACT_FORMATS.includes("notebook"));
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
      },
      {
        title: "Analysis Notebook",
        content: JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }),
        format: "notebook",
        artifactType: "analysis-report",
        extension: ".ipynb"
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

    const inferredNotebook = await createArtifact(store, {
      title: "Inferred Notebook",
      content: JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }),
      sourceAgent: "test"
    });
    assert.equal(inferredNotebook.version.format, "notebook");
    assert.equal(inferredNotebook.version.contentType, "application/x-ipynb+json; charset=utf-8");
    assert.equal(inferredNotebook.artifactType, "analysis-report");

    const notebookByExtension = await createArtifact(store, {
      title: "notebook.ipynb",
      content: JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }),
      contentType: "application/x-ipynb+json",
      sourceAgent: "test"
    });
    assert.equal(notebookByExtension.version.format, "notebook");
    assert.equal(notebookByExtension.artifactType, "analysis-report");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a second open of an already-backfilled store performs no UPDATE on artifacts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-backfill-noop-"));
  try {
    const store = createStore({ home });
    await createArtifact(store, {
      title: "Already Backfilled",
      content: "no legacy fields here",
      format: "text",
      sourceAgent: "codex",
      audit: {
        actor: "publisher@example.com",
        surface: "test"
      }
    });

    const probe = new DatabaseSync(store.dbPath);
    let updateCount;
    try {
      probe.exec(`
        CREATE TABLE IF NOT EXISTS _test_artifacts_update_log (n INTEGER);
        CREATE TRIGGER IF NOT EXISTS _test_artifacts_update_trigger
        AFTER UPDATE ON artifacts
        BEGIN
          INSERT INTO _test_artifacts_update_log (n) VALUES (1);
        END;
      `);
    } finally {
      probe.close();
    }

    // openDatabase() re-runs schema init and the self-healing backfills on
    // every open (see backfillArtifactOwnersAndPublishers); on an
    // already-backfilled store the cheap pre-checks must short-circuit
    // before any UPDATE touches the artifacts table.
    const db = openDatabase(store);
    db.close();

    const verify = new DatabaseSync(store.dbPath);
    try {
      updateCount = verify.prepare("SELECT COUNT(*) AS n FROM _test_artifacts_update_log").get().n;
      verify.exec(`
        DROP TRIGGER IF EXISTS _test_artifacts_update_trigger;
        DROP TABLE IF EXISTS _test_artifacts_update_log;
      `);
    } finally {
      verify.close();
    }

    assert.equal(updateCount, 0, "openDatabase() must not UPDATE the artifacts table when nothing needs backfilling");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("normalizes stored source agent aliases and infers unknown from metadata", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-source-normalize-"));
  try {
    const aliasDir = path.join(home, "artifacts", "alias-note");
    const unknownDir = path.join(home, "artifacts", "unknown-note");
    await mkdir(aliasDir, { recursive: true });
    await mkdir(unknownDir, { recursive: true });
    await writeFile(path.join(aliasDir, "v1.html"), "<main>Alias</main>", "utf8");
    await writeFile(path.join(unknownDir, "v1.html"), "<main>Unknown</main>", "utf8");
    await writeFile(path.join(home, "index.json"), JSON.stringify({
      version: 1,
      artifacts: [
        {
          id: "alias-note",
          title: "Alias Note",
          artifactType: "html-page",
          schemaVersion: 1,
          sourceAgent: "claude-code",
          tags: ["claude-code", "report6"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          latestVersion: 1,
          versions: [
            {
              version: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
              format: "html",
              contentType: "text/html; charset=utf-8",
              path: path.join("artifacts", "alias-note", "v1.html"),
              sizeBytes: 18,
              sha256: "legacy-sha",
              metadata: {}
            }
          ]
        },
        {
          id: "unknown-note",
          title: "Unknown Note",
          artifactType: "html-page",
          schemaVersion: 1,
          sourceAgent: "unknown",
          tags: ["unknown", "report7"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          latestVersion: 1,
          versions: [
            {
              version: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
              format: "html",
              contentType: "text/html; charset=utf-8",
              path: path.join("artifacts", "unknown-note", "v1.html"),
              sizeBytes: 20,
              sha256: "legacy-sha",
              metadata: {
                artifactyImport: {
                  sourceAgent: "Claude Code"
                }
              }
            }
          ]
        }
      ]
    }), "utf8");

    const store = createStore({ home });
    const alias = await getArtifact(store, "alias-note");
    const inferred = await getArtifact(store, "unknown-note");
    assert.equal(alias.sourceAgent, "claude");
    assert.deepEqual(alias.tags, ["claude", "report6"]);
    assert.equal(inferred.sourceAgent, "claude");
    assert.deepEqual(inferred.tags, ["claude", "report7"]);

    const page = await listArtifactsPage(store, { sourceAgent: "claude-code" });
    assert.equal(page.total, 2);

    const db = new DatabaseSync(store.dbPath);
    try {
      const marker = db.prepare("SELECT value FROM meta WHERE key = 'source_agent_normalized_version'").get();
      assert.equal(marker.value, "1");
    } finally {
      db.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("updateArtifact enforces optimistic concurrency with expectedVersion", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-concurrency-"));
  try {
    const store = createStore({ home });
    const created = await createArtifact(store, {
      title: "Concurrent Doc",
      content: "v1",
      format: "text",
      sourceAgent: "test"
    });
    assert.equal(created.latestVersion, 1);
    assert.equal(artifactEtag(created), `${created.id}:1`);

    const matched = await updateArtifact(store, created.id, {
      content: "v2",
      format: "text",
      expectedVersion: 1
    });
    assert.equal(matched.latestVersion, 2);
    assert.equal(artifactEtag(matched), `${created.id}:2`);

    const [summary] = await listArtifacts(store, { query: created.title });
    assert.equal(summary.etag, `${created.id}:2`);

    await assert.rejects(
      () => updateArtifact(store, created.id, {
        content: "v3-conflict",
        format: "text",
        expectedVersion: 1
      }),
      (error) => {
        assert.ok(error instanceof VersionConflictError);
        assert.equal(error.code, "version_conflict");
        assert.equal(error.statusCode, 409);
        assert.equal(error.latestVersion, 2);
        return true;
      }
    );

    const afterConflict = await getArtifact(store, created.id);
    assert.equal(afterConflict.latestVersion, 2);
    assert.equal(afterConflict.versions.length, 2);
    assert.equal(afterConflict.content, "v2");

    const versionFiles = await readdirIfExists(path.join(store.artifactsDir, created.id));
    assert.deepEqual(versionFiles.sort(), ["v1.txt", "v2.txt"]);

    const auditEvents = await listAuditEvents(store, { artifactId: created.id, limit: 20 });
    const conflictEvent = auditEvents.find((event) => event.action === "update-conflict");
    assert.ok(conflictEvent, "expected an update-conflict audit row");
    assert.equal(conflictEvent.metadata.expectedVersion, 1);
    assert.equal(conflictEvent.metadata.latestVersion, 2);

    const noConflict = await updateArtifact(store, created.id, {
      content: "v3",
      format: "text",
      expectedVersion: 2
    });
    assert.equal(noConflict.latestVersion, 3);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifact relations: round trip, inverse names, and getArtifact/listRelations shape", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-storage-"));
  try {
    const store = createStore({ home });
    const a = await createArtifact(store, { title: "A", content: "a" });
    const b = await createArtifact(store, { title: "B", content: "b", relations: [{ toId: a.id, relation: "derived-from" }] });

    assert.equal(inverseRelation("derived-from"), "derives");
    assert.equal(inverseRelation("derives"), "derived-from");
    assert.equal(inverseRelation("supersedes"), "superseded-by");
    assert.equal(inverseRelation("reviews"), "reviewed-by");
    assert.equal(inverseRelation("references"), "referenced-by");
    assert.equal(inverseRelation("part-of"), "contains");
    assert.equal(inverseRelation("nonsense"), null);
    assert.deepEqual(RELATION_TYPES, ["derived-from", "supersedes", "reviews", "references", "part-of"]);

    const inlineAudit = await listAuditEvents(store, { artifactId: b.id, action: "relation-add" });
    assert.equal(inlineAudit.length, 1, "inline relations on create must write a relation-add audit row");
    assert.deepEqual(inlineAudit[0].metadata, { toId: a.id, relation: "derived-from" });
    await updateArtifact(store, b.id, { content: "b2", relations: [{ toId: a.id, relation: "derived-from" }] });
    const afterDuplicate = await listAuditEvents(store, { artifactId: b.id, action: "relation-add" });
    assert.equal(afterDuplicate.length, 1, "duplicate inline relations must not write a second audit row");

    const bWithContent = await getArtifact(store, b.id);
    assert.equal(bWithContent.relations.outgoing.length, 1);
    assert.equal(bWithContent.relations.outgoing[0].relation, "derived-from");
    assert.equal(bWithContent.relations.outgoing[0].artifactId, a.id);
    assert.equal(bWithContent.relations.outgoing[0].missing, false);
    assert.equal(bWithContent.relations.outgoing[0].artifact.id, a.id);
    assert.equal(bWithContent.relations.incoming.length, 0);

    const aWithContent = await getArtifact(store, a.id);
    assert.equal(aWithContent.relations.incoming.length, 1);
    assert.equal(aWithContent.relations.incoming[0].relation, "derives");
    assert.equal(aWithContent.relations.incoming[0].artifactId, b.id);
    assert.equal(aWithContent.relations.outgoing.length, 0);

    const added = await addRelation(store, { fromId: b.id, toId: a.id, relation: "references" });
    assert.equal(added.fromId, b.id);
    assert.equal(added.toId, a.id);
    assert.equal(added.relation, "references");
    assert.ok(added.id);

    const viaListRelations = await listRelations(store, a.id, { direction: "in" });
    assert.equal(viaListRelations.outgoing.length, 0);
    assert.equal(viaListRelations.incoming.length, 2);

    const filteredByRelation = await listRelations(store, a.id, { relation: "derived-from" });
    assert.equal(filteredByRelation.incoming.length, 1);
    assert.equal(filteredByRelation.incoming[0].artifactId, b.id);

    const removed = await removeRelation(store, { fromId: b.id, toId: a.id, relation: "references" });
    assert.equal(removed.relation, "references");
    const afterRemove = await listRelations(store, a.id);
    assert.equal(afterRemove.incoming.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifact relations: rejects self-links, unknown relations, and unknown artifacts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-storage-"));
  try {
    const store = createStore({ home });
    const a = await createArtifact(store, { title: "A", content: "a" });

    await assert.rejects(
      () => addRelation(store, { fromId: a.id, toId: a.id, relation: "references" }),
      (error) => error.code === "SELF_RELATION"
    );

    await assert.rejects(
      () => addRelation(store, { fromId: a.id, toId: "missing-id", relation: "references" }),
      (error) => error.code === "ARTIFACT_NOT_FOUND"
    );

    await assert.rejects(
      () => addRelation(store, { fromId: a.id, toId: a.id, relation: "not-a-relation" }),
      (error) => error.code === "INVALID_RELATION"
    );

    await assert.rejects(
      () => removeRelation(store, { relationId: "nope" }),
      (error) => error.code === "RELATION_NOT_FOUND"
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifact relations: unique constraint ignores duplicate insert instead of throwing", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-storage-"));
  try {
    const store = createStore({ home });
    const a = await createArtifact(store, { title: "A", content: "a" });
    const b = await createArtifact(store, { title: "B", content: "b" });

    const first = await addRelation(store, { fromId: b.id, toId: a.id, relation: "derived-from" });
    const second = await addRelation(store, { fromId: b.id, toId: a.id, relation: "derived-from" });
    assert.equal(first.id, second.id, "duplicate relation insert should be a no-op, not a new row");

    const relations = await listRelations(store, a.id);
    assert.equal(relations.incoming.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifact relations: dangling target is reported as missing, not dropped", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-storage-"));
  try {
    const store = createStore({ home });
    const a = await createArtifact(store, { title: "A", content: "a" });
    const b = await createArtifact(store, { title: "B", content: "b" });
    await addRelation(store, { fromId: b.id, toId: a.id, relation: "derived-from" });

    const db = new DatabaseSync(store.dbPath);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM artifacts WHERE id = ?").run(a.id);
    db.close();

    const bWithContent = await getArtifact(store, b.id);
    assert.equal(bWithContent.relations.outgoing.length, 1);
    assert.equal(bWithContent.relations.outgoing[0].missing, true);
    assert.equal(bWithContent.relations.outgoing[0].artifact, null);
    assert.equal(bWithContent.relations.outgoing[0].artifactId, a.id);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifact relations: cascades on artifact delete via foreign key", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-storage-"));
  try {
    const store = createStore({ home });
    const a = await createArtifact(store, { title: "A", content: "a" });
    const b = await createArtifact(store, { title: "B", content: "b" });
    await addRelation(store, { fromId: b.id, toId: a.id, relation: "derived-from" });

    const db = new DatabaseSync(store.dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare("DELETE FROM artifacts WHERE id = ?").run(a.id);
    const remainingRelations = db.prepare("SELECT * FROM artifact_relations").all();
    db.close();

    assert.equal(remainingRelations.length, 0, "expected the relation row to cascade-delete with its artifact");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("relatedTo and relation filters restrict listArtifactsPage, with pagination", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-storage-"));
  try {
    const store = createStore({ home });
    const a = await createArtifact(store, { title: "A", content: "a" });
    const b = await createArtifact(store, { title: "B", content: "b", relations: [{ toId: a.id, relation: "derived-from" }] });
    const c = await createArtifact(store, { title: "C", content: "c", relations: [{ toId: a.id, relation: "references" }] });
    await createArtifact(store, { title: "D", content: "d" });

    const related = await listArtifactsPage(store, { relatedTo: a.id, limit: 1, offset: 0 });
    assert.equal(related.total, 2);
    assert.equal(related.artifacts.length, 1);
    assert.equal(related.hasMore, true);

    const relatedPage2 = await listArtifactsPage(store, { relatedTo: a.id, limit: 1, offset: 1 });
    assert.equal(relatedPage2.artifacts.length, 1);
    assert.equal(relatedPage2.hasMore, false);

    const ids = new Set([related.artifacts[0].id, relatedPage2.artifacts[0].id]);
    assert.deepEqual(ids, new Set([b.id, c.id]));

    const relatedByRelation = await listArtifactsPage(store, { relatedTo: a.id, relation: "derived-from" });
    assert.equal(relatedByRelation.total, 1);
    assert.equal(relatedByRelation.artifacts[0].id, b.id);

    const relatedByOtherRelation = await listArtifactsPage(store, { relatedTo: a.id, relation: "supersedes" });
    assert.equal(relatedByOtherRelation.total, 0);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("relations array passed to createArtifact and updateArtifact links in the same transaction", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-storage-"));
  try {
    const store = createStore({ home });
    const a = await createArtifact(store, { title: "A", content: "a" });
    const b = await createArtifact(store, { title: "B", content: "b", relations: [{ toId: a.id, relation: "derived-from" }] });
    const bRelations = await listRelations(store, b.id);
    assert.equal(bRelations.outgoing.length, 1);
    assert.equal(bRelations.outgoing[0].artifactId, a.id);

    const c = await createArtifact(store, { title: "C", content: "c" });
    const updated = await updateArtifact(store, c.id, {
      content: "c2",
      relations: [{ toId: a.id, relation: "supersedes" }, { toId: b.id, relation: "references" }]
    });
    assert.equal(updated.latestVersion, 2);
    const cRelations = await listRelations(store, updated.id);
    assert.equal(cRelations.outgoing.length, 2);
    const relationNames = cRelations.outgoing.map((entry) => entry.relation).sort();
    assert.deepEqual(relationNames, ["references", "supersedes"]);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("personal API token scopes: defaults, validation, admin restriction, and legacy rows", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-token-scopes-"));
  try {
    const store = createStore({ home });
    const admin = await createUser(store, {
      email: "scopes-admin@example.com",
      name: "Scopes Admin",
      role: "admin",
      password: "password-123"
    });
    const member = await createUser(store, {
      email: "scopes-member@example.com",
      name: "Scopes Member",
      role: "user",
      password: "password-123"
    });

    const defaultToken = await createApiToken(store, member.id, { name: "Default" });
    assert.deepEqual(defaultToken.record.scopes, ["read", "write"]);
    const defaultAuth = await authenticateApiToken(store, defaultToken.token);
    assert.deepEqual(defaultAuth.scopes, ["read", "write"]);

    const readOnlyToken = await createApiToken(store, member.id, { name: "Read only", scopes: ["read"] });
    assert.deepEqual(readOnlyToken.record.scopes, ["read"]);
    const listed = await listApiTokens(store, member.id);
    const readOnlyRecord = listed.find((token) => token.id === readOnlyToken.record.id);
    assert.deepEqual(readOnlyRecord.scopes, ["read"]);

    await assert.rejects(
      createApiToken(store, member.id, { name: "Bad scope", scopes: ["delete"] }),
      /Unsupported token scope/
    );

    await assert.rejects(
      createApiToken(store, member.id, { name: "Admin for non-admin", scopes: ["admin"] }),
      /admin scope requires an admin user/
    );

    const adminToken = await createApiToken(store, admin.id, { name: "Admin token", scopes: ["read", "write", "admin"] });
    assert.deepEqual(adminToken.record.scopes, ["read", "write", "admin"]);
    const adminAuth = await authenticateApiToken(store, adminToken.token);
    assert.deepEqual(adminAuth.scopes, ["read", "write", "admin"]);

    // Simulate a token row whose scopes_json is empty/unparseable (e.g. a
    // pre-scopes row backfilled with an empty string rather than the column
    // default); both listApiTokens and authenticateApiToken should fall
    // back to the full legacy default rather than surfacing null/garbage.
    const db = new DatabaseSync(store.dbPath);
    try {
      db.prepare("UPDATE api_tokens SET scopes_json = '' WHERE id = ?").run(defaultToken.record.id);
    } finally {
      db.close();
    }
    const legacyListed = await listApiTokens(store, member.id);
    const legacyRecord = legacyListed.find((token) => token.id === defaultToken.record.id);
    assert.deepEqual(legacyRecord.scopes, ["read", "write"]);
    const legacyAuth = await authenticateApiToken(store, defaultToken.token);
    assert.deepEqual(legacyAuth.scopes, ["read", "write"]);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("listArtifactsPage filters by artifactType, publisher, createdAfter, createdBefore, and reviewStatus", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-list-filters-"));
  try {
    const store = createStore({ home });
    const early = await createArtifact(store, {
      title: "Early Handoff",
      content: "a",
      artifactType: "handoff",
      audit: { publisherId: "agent-a" }
    });
    const later = await createArtifact(store, {
      title: "Later Doc",
      content: "b",
      artifactType: "document",
      audit: { publisherId: "agent-b" }
    });

    const byType = await listArtifactsPage(store, { artifactType: "handoff" });
    assert.equal(byType.total, 1);
    assert.equal(byType.artifacts[0].id, early.id);

    const byPublisher = await listArtifactsPage(store, { publisher: "agent-b" });
    assert.equal(byPublisher.total, 1);
    assert.equal(byPublisher.artifacts[0].id, later.id);

    const noMatchPublisher = await listArtifactsPage(store, { publisher: "nobody" });
    assert.equal(noMatchPublisher.total, 0);

    const futureOnly = await listArtifactsPage(store, { createdAfter: "2999-01-01" });
    assert.equal(futureOnly.total, 0);

    const pastOnly = await listArtifactsPage(store, { createdBefore: "2000-01-01" });
    assert.equal(pastOnly.total, 0);

    const bothInRange = await listArtifactsPage(store, {
      createdAfter: "2000-01-01",
      createdBefore: "2999-01-01"
    });
    assert.equal(bothInRange.total, 2);

    const byReviewStatus = await listArtifactsPage(store, { reviewStatus: "none" });
    assert.equal(byReviewStatus.total, 2, "review_status defaults to 'none'");

    const noReviewMatch = await listArtifactsPage(store, { reviewStatus: "approved" });
    assert.equal(noReviewMatch.total, 0);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("listArtifactsPage rejects invalid createdAfter/createdBefore with code invalid_filter", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-list-filter-dates-"));
  try {
    const store = createStore({ home });
    await createArtifact(store, { title: "A", content: "a" });

    await assert.rejects(
      () => listArtifactsPage(store, { createdAfter: "not-a-date" }),
      (error) => {
        assert.equal(error.code, "invalid_filter");
        assert.equal(error.statusCode, 400);
        return true;
      }
    );

    await assert.rejects(
      () => listArtifactsPage(store, { createdBefore: "also-not-a-date" }),
      (error) => {
        assert.equal(error.code, "invalid_filter");
        assert.equal(error.statusCode, 400);
        return true;
      }
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifactType, publisher, createdAfter/Before, and reviewStatus filters combine with FTS query results", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-list-filter-fts-"));
  try {
    const store = createStore({ home });
    const match = await createArtifact(store, {
      title: "Deployment Runbook",
      content: "deployment steps for production",
      artifactType: "handoff",
      audit: { publisherId: "agent-a" }
    });
    await createArtifact(store, {
      title: "Deployment Notes",
      content: "deployment steps for staging",
      artifactType: "document",
      audit: { publisherId: "agent-b" }
    });

    const page = await listArtifactsPage(store, { query: "deployment", artifactType: "handoff" });
    assert.ok(page.artifacts.some((artifact) => artifact.id === match.id));
    assert.ok(page.artifacts.every((artifact) => artifact.artifactType === "handoff"));

    const noMatch = await listArtifactsPage(store, { query: "deployment", publisher: "nobody" });
    assert.equal(noMatch.artifacts.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("createSavedView rejects filter keys outside the allowlist", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-views-allowlist-"));
  try {
    const store = createStore({ home });
    await assert.rejects(
      () => createSavedView(store, { name: "Bad View", filters: { notAllowed: "x" } }),
      (error) => {
        assert.equal(error.code, "invalid_filter");
        return true;
      }
    );

    for (const key of SAVED_VIEW_FILTER_KEYS) {
      assert.equal(typeof key, "string");
    }

    const view = await createSavedView(store, { name: "Good View", filters: { query: "x", tag: "y" } });
    assert.equal(view.name, "Good View");
    assert.deepEqual(view.filters, { query: "x", tag: "y" });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("saved views are global in single-user mode and resolvable by id or name", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-views-single-user-"));
  try {
    const store = createStore({ home });
    const view = await createSavedView(store, { name: "Open Reviews", filters: { reviewStatus: "pending" } });

    const listed = await listSavedViews(store, {});
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, view.id);
    assert.equal(listed[0].ownerUserId, null);

    const byId = await resolveSavedView(store, view.id, {});
    assert.equal(byId.id, view.id);

    const byName = await resolveSavedView(store, "open reviews", {});
    assert.equal(byName.id, view.id, "resolveSavedView should match by name case-insensitively");

    const missing = await resolveSavedView(store, "does-not-exist", {});
    assert.equal(missing, null);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("saved view ownership and sharing visibility in team mode", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-views-team-"));
  try {
    const store = createStore({ home });
    const owner = await createUser(store, { email: "views-owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const other = await createUser(store, { email: "views-other@example.com", name: "Other", role: "user", password: "password-123" });
    const admin = await createUser(store, { email: "views-admin@example.com", name: "Admin", role: "admin", password: "password-123" });
    const ownerAccess = { userId: owner.id, role: owner.role };
    const otherAccess = { userId: other.id, role: other.role };
    const adminAccess = { userId: admin.id, role: admin.role };

    const privateView = await createSavedView(store, { name: "Private View", filters: { tag: "x" }, shared: false, access: ownerAccess });
    const sharedView = await createSavedView(store, { name: "Shared View", filters: { tag: "y" }, shared: true, access: ownerAccess });

    assert.equal(privateView.ownerUserId, owner.id);
    assert.equal(privateView.shared, false);
    assert.equal(sharedView.shared, true);

    const ownerListed = await listSavedViews(store, { access: ownerAccess });
    assert.deepEqual(new Set(ownerListed.map((v) => v.id)), new Set([privateView.id, sharedView.id]));

    const otherListed = await listSavedViews(store, { access: otherAccess });
    assert.deepEqual(otherListed.map((v) => v.id), [sharedView.id], "other user should only see the shared view");

    const adminListed = await listSavedViews(store, { access: adminAccess });
    assert.deepEqual(new Set(adminListed.map((v) => v.id)), new Set([privateView.id, sharedView.id]), "admin sees every view");

    assert.equal(await resolveSavedView(store, privateView.id, { access: otherAccess }), null, "other user cannot resolve a private view they do not own");
    const resolvedByOther = await resolveSavedView(store, sharedView.id, { access: otherAccess });
    assert.equal(resolvedByOther.id, sharedView.id);

    await assert.rejects(
      () => deleteSavedView(store, privateView.id, { access: otherAccess }),
      (error) => {
        assert.equal(error.code, "forbidden");
        return true;
      }
    );

    const deleted = await deleteSavedView(store, privateView.id, { access: ownerAccess });
    assert.equal(deleted.id, privateView.id);
    const afterDelete = await listSavedViews(store, { access: ownerAccess });
    assert.deepEqual(afterDelete.map((v) => v.id), [sharedView.id]);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("comments: add, list, thread depth limit, size cap, anchor pass-through", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-storage-"));
  try {
    const store = createStore({ home });
    const artifact = await createArtifact(store, { title: "Doc", content: "line one\nline two" });

    const root = await addComment(store, artifact.id, {
      body: "Looks good, minor nit.",
      anchor: { line: 2 },
      audit: { actor: "reviewer@example.com", publisherName: "Reviewer" }
    });
    assert.equal(root.version, artifact.latestVersion);
    assert.equal(root.parentId, null);
    assert.equal(root.status, "open");
    assert.equal(root.authorLabel, "Reviewer");
    assert.deepEqual(root.anchor, { line: 2 });

    const reply = await addComment(store, artifact.id, {
      body: "Fixed in the next version.",
      parentId: root.id,
      sourceAgent: "cli"
    });
    assert.equal(reply.parentId, root.id);
    assert.equal(reply.sourceAgent, "cli");

    // Thread depth limit: replying to a reply is rejected.
    await assert.rejects(
      () => addComment(store, artifact.id, { body: "nested reply", parentId: reply.id }),
      (error) => error.code === "THREAD_TOO_DEEP"
    );

    // Size cap.
    await assert.rejects(
      () => addComment(store, artifact.id, { body: "x".repeat(MAX_COMMENT_BYTES + 1) }),
      (error) => error.code === "COMMENT_TOO_LARGE"
    );

    // Empty body rejected.
    await assert.rejects(
      () => addComment(store, artifact.id, { body: "   " }),
      (error) => error.code === "INVALID_COMMENT"
    );

    // Unknown parent rejected.
    await assert.rejects(
      () => addComment(store, artifact.id, { body: "x", parentId: "missing" }),
      (error) => error.code === "COMMENT_NOT_FOUND"
    );

    // Unknown version rejected.
    await assert.rejects(
      () => addComment(store, artifact.id, { body: "x", version: 99 }),
      (error) => error.code === "ARTIFACT_VERSION_NOT_FOUND"
    );

    const comments = await listComments(store, artifact.id);
    assert.equal(comments.length, 2);
    assert.deepEqual(comments.map((c) => c.id).sort(), [root.id, reply.id].sort());
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("comments: resolve and soft delete hide from list but keep audit history", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-storage-"));
  try {
    const store = createStore({ home });
    const artifact = await createArtifact(store, { title: "Doc", content: "hello" });
    const comment = await addComment(store, artifact.id, { body: "Please fix this." });

    const resolved = await resolveComment(store, artifact.id, comment.id, { audit: { publisherName: "Owner" } });
    assert.equal(resolved.status, "resolved");
    assert.ok(resolved.resolvedAt);
    assert.equal(resolved.resolvedBy, "Owner");

    const openOnly = await listComments(store, artifact.id, { status: "open" });
    assert.equal(openOnly.length, 0);

    const second = await addComment(store, artifact.id, { body: "Another note." });
    const deleted = await deleteComment(store, artifact.id, second.id);
    assert.ok(deleted.deletedAt);

    const visible = await listComments(store, artifact.id);
    assert.deepEqual(visible.map((c) => c.id), [comment.id]);

    const withDeleted = await listComments(store, artifact.id, { includeDeleted: true });
    assert.equal(withDeleted.length, 2);

    const auditEvents = await listAuditEvents(store, { artifactId: artifact.id });
    const actions = auditEvents.map((event) => event.action);
    assert.ok(actions.includes("comment-add"));
    assert.ok(actions.includes("comment-resolve"));
    assert.ok(actions.includes("comment-delete"));

    await assert.rejects(
      () => resolveComment(store, artifact.id, second.id),
      (error) => error.code === "COMMENT_NOT_FOUND"
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("review status: set, reset to pending on new version after approved, and access denial on private artifacts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-storage-"));
  try {
    const store = createStore({ home });
    assert.deepEqual(REVIEW_STATUSES, ["none", "pending", "changes-requested", "approved"]);

    const artifact = await createArtifact(store, { title: "Doc", content: "v1" });
    assert.equal(artifact.reviewStatus, "none");

    const approved = await setReviewStatus(store, artifact.id, "approved");
    assert.equal(approved.reviewStatus, "approved");

    const updated = await updateArtifact(store, artifact.id, { content: "v2" });
    assert.equal(updated.reviewStatus, "pending");

    const auditEvents = await listAuditEvents(store, { artifactId: artifact.id });
    const updateEvent = auditEvents.find((event) => event.action === "update" && event.version === updated.version.version);
    assert.deepEqual(updateEvent.metadata.reviewStatusReset, { from: "approved", to: "pending" });

    await assert.rejects(
      () => setReviewStatus(store, artifact.id, "not-a-status"),
      (error) => error.code === "INVALID_REVIEW_STATUS"
    );

    // Access denial: private artifact, non-owner cannot add a comment or
    // change review status; owner and admin can.
    const owner = await createUser(store, { email: "owner@example.com", name: "Owner", role: "user", password: "password-123" });
    const stranger = await createUser(store, { email: "stranger@example.com", name: "Stranger", role: "user", password: "password-123" });
    const admin = await createUser(store, { email: "admin@example.com", name: "Admin", role: "admin", password: "password-123" });
    const privateArtifact = await createArtifact(store, {
      title: "Private",
      content: "secret",
      visibility: "private",
      ownerUserId: owner.id
    });

    const ownerAccess = { userId: owner.id, role: "user" };
    const strangerAccess = { userId: stranger.id, role: "user" };
    const adminAccess = { userId: admin.id, role: "admin" };

    await assert.rejects(
      () => addComment(store, privateArtifact.id, { body: "peeking", access: strangerAccess }),
      (error) => error.code === "ARTIFACT_NOT_FOUND"
    );
    await assert.rejects(
      () => listComments(store, privateArtifact.id, { access: strangerAccess }),
      (error) => error.code === "ARTIFACT_NOT_FOUND"
    );
    await assert.rejects(
      () => setReviewStatus(store, privateArtifact.id, "approved", { access: strangerAccess }),
      (error) => error.code === "ARTIFACT_NOT_FOUND"
    );

    const ownerComment = await addComment(store, privateArtifact.id, { body: "owner note", access: ownerAccess });
    assert.ok(ownerComment.id);
    const ownerStatus = await setReviewStatus(store, privateArtifact.id, "approved", { access: ownerAccess });
    assert.equal(ownerStatus.reviewStatus, "approved");
    const adminStatus = await setReviewStatus(store, privateArtifact.id, "pending", { access: adminAccess });
    assert.equal(adminStatus.reviewStatus, "pending");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function bundleContent({ files = [] } = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    artifactType: "bundle",
    title: "Doc bundle",
    text: "bundle with document assets",
    files
  });
}

function base64Of(bytes) {
  return Buffer.alloc(bytes, "a").toString("base64");
}

test("bundle document assets: accepts an allowed binary content type and rejects an unlisted one", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-bundle-types-"));
  try {
    const store = createStore({ home });
    assert.ok(BUNDLE_BINARY_CONTENT_TYPES.has("application/pdf"));
    assert.ok(BUNDLE_BINARY_CONTENT_TYPES.has("application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
    assert.ok(BUNDLE_BINARY_CONTENT_TYPES.has("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    assert.ok(BUNDLE_BINARY_CONTENT_TYPES.has("application/zip"));

    const accepted = await createArtifact(store, {
      title: "PDF bundle",
      artifactType: "bundle",
      format: "json",
      sourceAgent: "test",
      content: bundleContent({
        files: [{ path: "report.pdf", contentType: "application/pdf", encoding: "base64", content: base64Of(16) }]
      })
    });
    assert.equal(accepted.artifactType, "bundle");

    await assert.rejects(
      () => createArtifact(store, {
        title: "Executable bundle",
        artifactType: "bundle",
        format: "json",
        sourceAgent: "test",
        content: bundleContent({
          files: [{ path: "tool.exe", contentType: "application/x-msdownload", encoding: "base64", content: base64Of(16) }]
        })
      }),
      (error) => error.code === "UNSUPPORTED_BUNDLE_FILE_TYPE"
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("bundle document assets: rejects a binary file entry over the per-file cap", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-bundle-cap-"));
  try {
    const store = createStore({ home });
    const oversized = base64Of(MAX_BUNDLE_FILE_BYTES + 1024);

    await assert.rejects(
      () => createArtifact(store, {
        title: "Oversized bundle",
        artifactType: "bundle",
        format: "json",
        sourceAgent: "test",
        content: bundleContent({
          files: [{ path: "huge.zip", contentType: "application/zip", encoding: "base64", content: oversized }]
        })
      }),
      (error) => error.code === "BUNDLE_FILE_TOO_LARGE"
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("bundle document assets: file paths must be safe relative paths", async () => {
  assert.equal(isSafeBundleFilePath("docs/report.pdf"), true);
  assert.equal(isSafeBundleFilePath("../escape.pdf"), false);
  assert.equal(isSafeBundleFilePath("/etc/passwd"), false);
  assert.equal(isSafeBundleFilePath("C:/windows/system32"), false);
  assert.equal(isSafeBundleFilePath("a/../../b.pdf"), false);
  assert.equal(isSafeBundleFilePath("bad\u0000name.pdf"), false);

  const home = await mkdtemp(path.join(tmpdir(), "artifacty-bundle-path-"));
  try {
    const store = createStore({ home });
    await assert.rejects(
      () => createArtifact(store, {
        title: "Unsafe path bundle",
        artifactType: "bundle",
        format: "json",
        sourceAgent: "test",
        content: bundleContent({
          files: [{ path: "../../etc/passwd", contentType: "application/pdf", encoding: "base64", content: base64Of(16) }]
        })
      }),
      (error) => error.code === "INVALID_BUNDLE_FILE_PATH"
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("bundle document assets: updateArtifact re-validates binary file entries on new versions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-bundle-update-"));
  try {
    const store = createStore({ home });
    const created = await createArtifact(store, {
      title: "Bundle v1",
      artifactType: "bundle",
      format: "json",
      sourceAgent: "test",
      content: bundleContent({
        files: [{ path: "report.pdf", contentType: "application/pdf", encoding: "base64", content: base64Of(16) }]
      })
    });

    await assert.rejects(
      () => updateArtifact(store, created.id, {
        artifactType: "bundle",
        format: "json",
        sourceAgent: "test",
        content: bundleContent({
          files: [{ path: "report.bin", contentType: "application/octet-stream", encoding: "base64", content: base64Of(16) }]
        })
      }),
      (error) => error.code === "UNSUPPORTED_BUNDLE_FILE_TYPE"
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("bundle document assets: secret scanning skips binary file content but still scans file names and text entries", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-bundle-secrets-"));
  try {
    const store = createStore({ home });

    // A secret-shaped string sitting in a *binary* file entry's content must
    // not trip the scanner: binary entries are excluded from secret
    // scanning entirely, regardless of what their content decodes to.
    const allowed = await createArtifact(store, {
      title: "Binary bundle with a secret-shaped payload",
      artifactType: "bundle",
      format: "json",
      sourceAgent: "test",
      content: bundleContent({
        files: [{ path: "notes.pdf", contentType: "application/pdf", encoding: "base64", content: `sk-ant-${"x".repeat(30)}` }]
      })
    });
    assert.equal(allowed.artifactType, "bundle");

    // A secret embedded in a *text* file entry's content must still be
    // caught.
    await assert.rejects(
      () => createArtifact(store, {
        title: "Text bundle with a leaked key",
        artifactType: "bundle",
        format: "json",
        sourceAgent: "test",
        content: bundleContent({
          files: [{ path: "README.md", content: `token: sk-ant-${"x".repeat(30)}` }]
        })
      }),
      (error) => error.code === "SECRET_DETECTED"
    );

    // A secret embedded in a file *name* must still be caught.
    await assert.rejects(
      () => createArtifact(store, {
        title: "Bundle with a secret in the file name",
        artifactType: "bundle",
        format: "json",
        sourceAgent: "test",
        content: bundleContent({
          files: [{ path: `sk-ant-${"x".repeat(30)}.pdf`, contentType: "application/pdf", encoding: "base64", content: base64Of(16) }]
        })
      }),
      (error) => error.code === "SECRET_DETECTED"
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("opening a store whose stored store_version is newer than this build's STORE_VERSION throws a clear error", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-store-version-guard-"));
  try {
    const store = createStore({ home });
    await createArtifact(store, { title: "Doc", content: "hello", format: "text", sourceAgent: "test" });

    const db = new DatabaseSync(store.dbPath);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'store_version'").run(String(999));
    db.close();

    await assert.rejects(
      () => createArtifact(store, { title: "Other", content: "x", format: "text", sourceAgent: "test" }),
      /newer version/i
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("listAuditEvents filters by action, as a string or an array, with and without an artifactId", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-audit-action-filter-"));
  try {
    const store = createStore({ home });
    const artifact = await createArtifact(store, { title: "Doc", content: "v1", format: "text", sourceAgent: "test" });
    await updateArtifact(store, artifact.id, { content: "v2", format: "text" });
    await archiveArtifact(store, artifact.id);
    await restoreArtifact(store, artifact.id);

    const scopedByArtifact = await listAuditEvents(store, { artifactId: artifact.id, action: "archive" });
    assert.equal(scopedByArtifact.length, 1);
    assert.equal(scopedByArtifact[0].action, "archive");

    const scopedGlobally = await listAuditEvents(store, { action: "archive", limit: 500 });
    assert.ok(scopedGlobally.length >= 1);
    assert.ok(scopedGlobally.every((event) => event.action === "archive"));

    const multiAction = await listAuditEvents(store, { artifactId: artifact.id, action: ["archive", "restore"] });
    assert.deepEqual(multiAction.map((event) => event.action).sort(), ["archive", "restore"]);

    const noMatch = await listAuditEvents(store, { artifactId: artifact.id, action: "webhook-create" });
    assert.deepEqual(noMatch, []);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("readBundleFile serves a bundle's binary file entries by path or name, reusing the same rules as validateBundleFileEntries", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-read-bundle-file-"));
  try {
    const store = createStore({ home });
    const pdfBytes = base64Of(16);
    const content = bundleContent({
      files: [
        { path: "reports/report.pdf", contentType: "application/pdf", encoding: "base64", content: pdfBytes },
        { name: "notes.txt", encoding: "utf8", content: "not binary" }
      ]
    });
    const artifact = await createArtifact(store, {
      title: "Doc bundle",
      artifactType: "bundle",
      format: "json",
      sourceAgent: "test",
      content
    });

    const found = readBundleFile(artifact, content, "reports/report.pdf");
    assert.ok(found);
    assert.equal(found.contentType, "application/pdf");
    assert.equal(found.fileName, "report.pdf");
    assert.ok(Buffer.isBuffer(found.body));
    assert.equal(found.body.toString("base64"), pdfBytes);

    // Non-bundle artifact, missing file, non-base64 entry, and an unsafe
    // path all resolve to null rather than throwing.
    assert.equal(readBundleFile(artifact, content, "does-not-exist.pdf"), null);
    assert.equal(readBundleFile(artifact, content, "notes.txt"), null, "a non-base64 entry is not a servable binary file");
    assert.equal(readBundleFile({ artifactType: "document" }, content, "reports/report.pdf"), null);

    const unsafeContent = bundleContent({
      files: [{ path: "../escape.pdf", contentType: "application/pdf", encoding: "base64", content: pdfBytes }]
    });
    assert.equal(readBundleFile(artifact, unsafeContent, "../escape.pdf"), null);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function readdirIfExists(dir) {
  const { readdir } = await import("node:fs/promises");
  try {
    return await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
