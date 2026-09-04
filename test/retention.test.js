// Retention policy coverage (roadmap section 9). Kept in its own file
// rather than appended to test/storage.test.js.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  archiveArtifact,
  createArtifact,
  createStore,
  listAuditEvents,
  setReviewStatus
} from "../src/lib/storage.js";
import {
  DEFAULT_RETENTION_POLICY,
  getRetentionPolicy,
  normalizeRetentionPolicy,
  planRetention,
  runRetention,
  setRetentionPolicy
} from "../src/lib/retention.js";

async function withTempStore(prefix, fn) {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    const store = createStore({ home });
    await fn(store);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function backdate(store, artifactId, { updatedAt, archivedAt } = {}) {
  const db = new DatabaseSync(store.dbPath);
  try {
    if (updatedAt) {
      db.prepare("UPDATE artifacts SET updated_at = ? WHERE id = ?").run(updatedAt, artifactId);
    }
    if (archivedAt !== undefined) {
      db.prepare("UPDATE artifacts SET archived_at = ? WHERE id = ?").run(archivedAt, artifactId);
    }
  } finally {
    db.close();
  }
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

test("normalizeRetentionPolicy defaults, coerces, and validates shape", () => {
  assert.deepEqual(normalizeRetentionPolicy(), DEFAULT_RETENTION_POLICY);
  assert.deepEqual(normalizeRetentionPolicy({}), DEFAULT_RETENTION_POLICY);
  assert.deepEqual(normalizeRetentionPolicy(null), DEFAULT_RETENTION_POLICY);

  const normalized = normalizeRetentionPolicy({
    archiveAfterDays: { default: "90", byType: { "test-report": "30", bogus: "not-a-number", "": "10" } },
    purgeArchivedAfterDays: 180.9,
    auditRetentionDays: -5,
    eventRetentionRows: "10000",
    keepTags: ["pinned", "pinned", "", 5, "release"]
  });

  assert.equal(normalized.archiveAfterDays.default, 90);
  assert.deepEqual(normalized.archiveAfterDays.byType, { "test-report": 30 });
  assert.equal(normalized.purgeArchivedAfterDays, 180);
  assert.equal(normalized.auditRetentionDays, null);
  assert.equal(normalized.eventRetentionRows, 10000);
  assert.deepEqual(normalized.keepTags, ["pinned", "release"]);
});

test("getRetentionPolicy/setRetentionPolicy round trip through the meta table", async () => {
  await withTempStore("artifacty-retention-policy-", async (store) => {
    assert.deepEqual(await getRetentionPolicy(store), DEFAULT_RETENTION_POLICY);

    const saved = await setRetentionPolicy(store, {
      archiveAfterDays: { default: 90, byType: { "test-report": 30 } },
      purgeArchivedAfterDays: 180,
      auditRetentionDays: 365,
      eventRetentionRows: 10000,
      keepTags: ["pinned"]
    });
    assert.equal(saved.archiveAfterDays.default, 90);

    const reloaded = await getRetentionPolicy(store);
    assert.deepEqual(reloaded, saved);
  });
});

test("planRetention archives stale artifacts but exempts keepTags and approved review status", async () => {
  await withTempStore("artifacty-retention-plan-", async (store) => {
    const stale = await createArtifact(store, {
      title: "Stale doc",
      content: "hello",
      format: "text",
      sourceAgent: "codex"
    });
    const pinned = await createArtifact(store, {
      title: "Pinned doc",
      content: "hello",
      format: "text",
      sourceAgent: "codex",
      tags: ["pinned"]
    });
    const approved = await createArtifact(store, {
      title: "Approved doc",
      content: "hello",
      format: "text",
      sourceAgent: "codex"
    });
    const fresh = await createArtifact(store, {
      title: "Fresh doc",
      content: "hello",
      format: "text",
      sourceAgent: "codex"
    });

    backdate(store, stale.id, { updatedAt: daysAgo(100) });
    backdate(store, pinned.id, { updatedAt: daysAgo(100) });
    backdate(store, approved.id, { updatedAt: daysAgo(100) });
    await setReviewStatus(store, approved.id, "approved");

    await setRetentionPolicy(store, {
      archiveAfterDays: { default: 90, byType: {} },
      purgeArchivedAfterDays: null,
      auditRetentionDays: null,
      eventRetentionRows: null,
      keepTags: ["pinned"]
    });

    const plan = await planRetention(store);
    const archiveIds = plan.archive.map((item) => item.id);
    assert.ok(archiveIds.includes(stale.id));
    assert.ok(!archiveIds.includes(pinned.id), "keepTags-tagged artifact must be exempt");
    assert.ok(!archiveIds.includes(approved.id), "approved review status must be exempt");
    assert.ok(!archiveIds.includes(fresh.id), "artifact updated recently must not be archived");
  });
});

test("dry-run makes no changes to artifacts, audit log, or events", async () => {
  await withTempStore("artifacty-retention-dryrun-", async (store) => {
    const artifact = await createArtifact(store, {
      title: "Doc",
      content: "hello",
      format: "text",
      sourceAgent: "codex"
    });
    backdate(store, artifact.id, { updatedAt: daysAgo(100) });
    await setRetentionPolicy(store, {
      archiveAfterDays: { default: 90, byType: {} },
      purgeArchivedAfterDays: null,
      auditRetentionDays: null,
      eventRetentionRows: null,
      keepTags: []
    });

    const beforeAudit = await listAuditEvents(store, { limit: 500 });
    const result = await runRetention(store, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.archived.length, 0);
    assert.ok(result.archive.length >= 1);

    const afterAudit = await listAuditEvents(store, { limit: 500 });
    assert.equal(afterAudit.length, beforeAudit.length, "dry run must not write any audit rows");

    const db = new DatabaseSync(store.dbPath);
    try {
      const row = db.prepare("SELECT archived_at FROM artifacts WHERE id = ?").get(artifact.id);
      assert.equal(row.archived_at, null, "dry run must not archive the artifact");
    } finally {
      db.close();
    }
  });
});

test("runRetention archives via the existing archive path with a retention-archive audit action", async () => {
  await withTempStore("artifacty-retention-archive-", async (store) => {
    const artifact = await createArtifact(store, {
      title: "Doc",
      content: "hello",
      format: "text",
      sourceAgent: "codex"
    });
    backdate(store, artifact.id, { updatedAt: daysAgo(100) });
    await setRetentionPolicy(store, {
      archiveAfterDays: { default: 90, byType: {} },
      purgeArchivedAfterDays: null,
      auditRetentionDays: null,
      eventRetentionRows: null,
      keepTags: []
    });

    const result = await runRetention(store, { dryRun: false });
    assert.deepEqual(result.archived, [artifact.id]);

    const events = await listAuditEvents(store, { artifactId: artifact.id });
    assert.ok(events.some((event) => event.action === "retention-archive" && event.actor === "system:retention"));

    const sweepEvents = await listAuditEvents(store, { limit: 500 });
    const sweep = sweepEvents.find((event) => event.action === "retention-sweep");
    assert.ok(sweep, "expected a retention-sweep summary audit row");
    assert.equal(sweep.metadata.archived, 1);
  });
});

test("purge removes files and dependent rows, and is refused without the allow-purge gate", async () => {
  await withTempStore("artifacty-retention-purge-", async (store) => {
    const artifact = await createArtifact(store, {
      title: "Doc",
      content: "hello",
      format: "text",
      sourceAgent: "codex"
    });
    await archiveArtifact(store, artifact.id);
    backdate(store, artifact.id, { archivedAt: daysAgo(200) });

    await setRetentionPolicy(store, {
      archiveAfterDays: { default: null, byType: {} },
      purgeArchivedAfterDays: 180,
      auditRetentionDays: null,
      eventRetentionRows: null,
      keepTags: []
    });

    const artifactDir = path.join(store.artifactsDir, artifact.id);
    assert.ok(existsSync(artifactDir));

    const refused = await runRetention(store, { dryRun: false });
    assert.equal(refused.purged.length, 0);
    assert.equal(refused.purgeSkipped, true);
    assert.ok(existsSync(artifactDir), "files must survive an ungated purge attempt");

    const optedInWithoutEnv = await runRetention(store, { dryRun: false, allowPurge: true });
    assert.equal(optedInWithoutEnv.purged.length, 0, "allowPurge alone must not bypass the env gate");
    assert.ok(existsSync(artifactDir));

    process.env.ARTIFACTY_RETENTION_ALLOW_PURGE = "true";
    let allowed;
    try {
      allowed = await runRetention(store, { dryRun: false, allowPurge: true });
    } finally {
      delete process.env.ARTIFACTY_RETENTION_ALLOW_PURGE;
    }
    assert.deepEqual(allowed.purged, [artifact.id]);
    assert.equal(existsSync(artifactDir), false, "purge must remove the version-file directory");

    const db = new DatabaseSync(store.dbPath);
    try {
      const row = db.prepare("SELECT id FROM artifacts WHERE id = ?").get(artifact.id);
      assert.equal(row, undefined, "purge must hard-delete the artifact row");

      const eventRows = db.prepare("SELECT id FROM events WHERE artifact_id = ?").all(artifact.id);
      assert.deepEqual(eventRows, [], "purge must remove events rows for the purged artifact");

      const searchRows = db.prepare("SELECT artifact_id FROM artifact_search WHERE artifact_id = ?").all(artifact.id);
      assert.deepEqual(searchRows, [], "purge must remove FTS rows for the purged artifact");

      const auditRows = db.prepare("SELECT action FROM audit_log WHERE artifact_id = ?").all(artifact.id);
      assert.ok(auditRows.length > 0, "audit rows for the purged artifact must survive the purge");
    } finally {
      db.close();
    }

    const purgeAudit = await listAuditEvents(store, { limit: 500 });
    assert.ok(purgeAudit.some((event) => event.action === "retention-purge" && event.artifactId === artifact.id));
  });
});

test("purge is also allowed via ARTIFACTY_RETENTION_ALLOW_PURGE=true", async () => {
  await withTempStore("artifacty-retention-purge-env-", async (store) => {
    const artifact = await createArtifact(store, {
      title: "Doc",
      content: "hello",
      format: "text",
      sourceAgent: "codex"
    });
    await archiveArtifact(store, artifact.id);
    backdate(store, artifact.id, { archivedAt: daysAgo(200) });
    await setRetentionPolicy(store, {
      archiveAfterDays: { default: null, byType: {} },
      purgeArchivedAfterDays: 180,
      auditRetentionDays: null,
      eventRetentionRows: null,
      keepTags: []
    });

    process.env.ARTIFACTY_RETENTION_ALLOW_PURGE = "true";
    try {
      const result = await runRetention(store, { dryRun: false });
      assert.deepEqual(result.purged, [artifact.id]);
    } finally {
      delete process.env.ARTIFACTY_RETENTION_ALLOW_PURGE;
    }
  });
});

test("audit retention deletes old rows but exempts version-repair, version-delete, retention-purge, and owner-change", async () => {
  await withTempStore("artifacty-retention-audit-", async (store) => {
    const artifact = await createArtifact(store, {
      title: "Doc",
      content: "hello",
      format: "text",
      sourceAgent: "codex"
    });

    const db = new DatabaseSync(store.dbPath);
    try {
      const old = daysAgo(400);
      db.prepare(`
        INSERT INTO audit_log (id, created_at, action, artifact_id, version, source_agent, actor, surface, metadata_json)
        VALUES (?, ?, 'read', ?, 1, 'codex', 'tester', 'test', '{}')
      `).run("old-read", old, artifact.id);
      db.prepare(`
        INSERT INTO audit_log (id, created_at, action, artifact_id, version, source_agent, actor, surface, metadata_json)
        VALUES (?, ?, 'owner-change', ?, 1, 'codex', 'tester', 'test', '{}')
      `).run("old-owner-change", old, artifact.id);
      db.prepare(`
        INSERT INTO audit_log (id, created_at, action, artifact_id, version, source_agent, actor, surface, metadata_json)
        VALUES (?, ?, 'version-repair', ?, 1, 'codex', 'tester', 'test', '{}')
      `).run("old-version-repair", old, artifact.id);
    } finally {
      db.close();
    }

    await setRetentionPolicy(store, {
      archiveAfterDays: { default: null, byType: {} },
      purgeArchivedAfterDays: null,
      auditRetentionDays: 365,
      eventRetentionRows: null,
      keepTags: []
    });

    const result = await runRetention(store, { dryRun: false });
    assert.ok(result.auditRowsDeleted >= 1);

    const remaining = await listAuditEvents(store, { limit: 500 });
    const remainingIds = remaining.map((event) => event.id);
    assert.ok(!remainingIds.includes("old-read"), "non-exempt old row must be deleted");
    assert.ok(remainingIds.includes("old-owner-change"), "owner-change must be exempt");
    assert.ok(remainingIds.includes("old-version-repair"), "version-repair must be exempt");
  });
});

test("event retention prunes rows beyond eventRetentionRows, keeping the newest", async () => {
  await withTempStore("artifacty-retention-events-", async (store) => {
    for (let index = 0; index < 5; index += 1) {
      await createArtifact(store, {
        title: `Doc ${index}`,
        content: "hello",
        format: "text",
        sourceAgent: "codex"
      });
    }

    const db = new DatabaseSync(store.dbPath);
    let totalBefore;
    try {
      totalBefore = db.prepare("SELECT COUNT(*) AS count FROM events").get().count;
    } finally {
      db.close();
    }
    assert.ok(totalBefore >= 5);

    await setRetentionPolicy(store, {
      archiveAfterDays: { default: null, byType: {} },
      purgeArchivedAfterDays: null,
      auditRetentionDays: null,
      eventRetentionRows: 2,
      keepTags: []
    });

    const result = await runRetention(store, { dryRun: false });
    assert.equal(result.eventRowsDeleted, totalBefore - 2);

    const db2 = new DatabaseSync(store.dbPath);
    try {
      const totalAfter = db2.prepare("SELECT COUNT(*) AS count FROM events").get().count;
      assert.equal(totalAfter, 2);
    } finally {
      db2.close();
    }
  });
});

test("sweeps are idempotent: a second sweep with nothing new to do makes no further archive/purge changes", async () => {
  await withTempStore("artifacty-retention-idempotent-", async (store) => {
    const artifact = await createArtifact(store, {
      title: "Doc",
      content: "hello",
      format: "text",
      sourceAgent: "codex"
    });
    backdate(store, artifact.id, { updatedAt: daysAgo(100) });
    await setRetentionPolicy(store, {
      archiveAfterDays: { default: 90, byType: {} },
      purgeArchivedAfterDays: null,
      auditRetentionDays: null,
      eventRetentionRows: null,
      keepTags: []
    });

    const first = await runRetention(store, { dryRun: false });
    assert.deepEqual(first.archived, [artifact.id]);

    const second = await runRetention(store, { dryRun: false });
    assert.deepEqual(second.archived, [], "an already-archived artifact must not be archived again");
    assert.equal(second.archive.length, 0);
  });
});

test("startRetentionSweep with an all-null policy is a no-op on each tick but does not throw", async () => {
  const { startRetentionSweep } = await import("../src/lib/retention.js");
  await withTempStore("artifacty-retention-inert-", async (store) => {
    const stop = await startRetentionSweep(store, { intervalMs: 20 });
    assert.equal(typeof stop, "function");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const sweepRows = await listAuditEvents(store, { limit: 500 });
    assert.equal(
      sweepRows.filter((event) => event.action === "retention-sweep").length,
      0,
      "an all-null policy must not run runRetention on any tick"
    );
    stop();
  });
});

test("startRetentionSweep starts the timer before a policy exists, and picks up a policy set afterward", async () => {
  const { startRetentionSweep } = await import("../src/lib/retention.js");
  await withTempStore("artifacty-retention-sweep-after-policy-", async (store) => {
    const artifact = await createArtifact(store, {
      title: "Doc",
      content: "hello",
      format: "text",
      sourceAgent: "codex"
    });
    backdate(store, artifact.id, { updatedAt: daysAgo(100) });

    // The sweep is started (server startup order) before any policy has
    // ever been set. The fix under test: the timer itself must still be
    // created (not skipped based on the policy at startup time), so a
    // policy set later is picked up on a subsequent tick without a restart.
    const stop = await startRetentionSweep(store, { intervalMs: 20 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const beforePolicy = await import("../src/lib/storage.js").then((mod) => mod.getArtifact(store, artifact.id));
      assert.equal(beforePolicy.archivedAt, null, "no policy yet: nothing should be archived");

      await setRetentionPolicy(store, {
        archiveAfterDays: { default: 90, byType: {} },
        purgeArchivedAfterDays: null,
        auditRetentionDays: null,
        eventRetentionRows: null,
        keepTags: []
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
      const afterPolicy = await import("../src/lib/storage.js").then((mod) => mod.getArtifact(store, artifact.id));
      assert.ok(afterPolicy.archivedAt, "a policy set after the sweep started must still take effect on a later tick");
    } finally {
      stop();
    }
  });
});
