import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archiveArtifact,
  createArtifact,
  createStore,
  getArtifact,
  listAuditEvents,
  listArtifacts,
  restoreArtifact,
  updateArtifact
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

test("blocks detected secrets unless explicitly allowed", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-secrets-"));
  try {
    const store = createStore({ home });
    await assert.rejects(
      createArtifact(store, {
        title: "Secret",
        content: "token ghp_abcdefghijklmnopqrstuvwxyz123456",
        format: "text"
      }),
      /Secret scan blocked/
    );

    const artifact = await createArtifact(store, {
      title: "Allowed Secret",
      content: "token ghp_abcdefghijklmnopqrstuvwxyz123456",
      format: "text",
      allowSecrets: true
    });
    assert.equal(artifact.version.metadata.secretScan.status, "allowed");
    assert.equal(artifact.version.metadata.secretScan.findingCount, 1);
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
