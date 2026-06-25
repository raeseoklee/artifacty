import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ARTIFACT_FORMATS,
  ARTIFACT_TYPES,
  archiveArtifact,
  contentTypeForFormat,
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

test("stores extended artifact formats and taxonomy", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-format-taxonomy-"));
  try {
    assert.ok(ARTIFACT_FORMATS.includes("code"));
    assert.ok(ARTIFACT_FORMATS.includes("svg"));
    assert.ok(ARTIFACT_FORMATS.includes("mermaid"));
    assert.ok(ARTIFACT_FORMATS.includes("react"));
    assert.ok(ARTIFACT_FORMATS.includes("sarif"));
    assert.ok(ARTIFACT_FORMATS.includes("csv"));
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
      }
    ];

    for (const item of cases) {
      const artifact = await createArtifact(store, {
        title: item.title,
        content: item.content,
        format: item.format,
        artifactType: item.artifactType,
        sourceAgent: "test"
      });
      assert.equal(artifact.version.format, item.format);
      assert.equal(artifact.version.contentType, contentTypeForFormat(item.format));
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
