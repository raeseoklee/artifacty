// Retention policy sweep (see docs/roadmap-design.md section 9).
//
// Policies are declarative JSON stored in the `meta` table under key
// `retention_policy`. A background sweep (started next to the events poller
// in src/server.js) and `artifacty retention run` both call planRetention()
// / runRetention() below.
//
// Direct table access this module needs beyond storage.js's own exported
// functions (dependent-table cascade cleanup, bulk audit/event pruning,
// meta get/set) goes through storage.js's exported
// openDatabase/transaction/tableExistsInDb/insertAuditRow rather than a
// second, independently configured node:sqlite connection, so both modules
// agree on PRAGMAs, schema migrations, and the audit-row-derives-an-event
// pipeline.
// It reuses storage.js's archiveArtifact() for the archive path itself, per
// the roadmap design ("Archive via the existing archive path").
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  archiveArtifact,
  createStore,
  ensureStore,
  insertAuditRow,
  isValidArtifactId,
  openDatabase,
  tableExistsInDb,
  transaction
} from "./storage.js";

export const DEFAULT_RETENTION_POLICY = {
  archiveAfterDays: { default: null, byType: {} },
  purgeArchivedAfterDays: null,
  auditRetentionDays: null,
  eventRetentionRows: null,
  keepTags: []
};

// Audit actions that are never pruned by auditRetentionDays, regardless of
// age.
export const AUDIT_RETENTION_EXEMPT_ACTIONS = [
  "version-repair",
  "version-delete",
  "retention-purge",
  "retention-policy-update",
  "owner-change"
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function normalizeRetentionPolicy(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const archiveAfterDaysSource =
    source.archiveAfterDays && typeof source.archiveAfterDays === "object" ? source.archiveAfterDays : {};
  const byTypeSource =
    archiveAfterDaysSource.byType && typeof archiveAfterDaysSource.byType === "object"
      ? archiveAfterDaysSource.byType
      : {};

  const byType = {};
  for (const [type, value] of Object.entries(byTypeSource)) {
    const days = normalizePositiveIntegerOrNull(value);
    if (typeof type === "string" && type.trim() && days !== null) {
      byType[type.trim()] = days;
    }
  }

  return {
    archiveAfterDays: {
      default: normalizePositiveIntegerOrNull(archiveAfterDaysSource.default),
      byType
    },
    purgeArchivedAfterDays: normalizePositiveIntegerOrNull(source.purgeArchivedAfterDays),
    auditRetentionDays: normalizePositiveIntegerOrNull(source.auditRetentionDays),
    eventRetentionRows: normalizePositiveIntegerOrNull(source.eventRetentionRows),
    keepTags: normalizeKeepTags(source.keepTags)
  };
}

function normalizePositiveIntegerOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

// Parses `type=days` pairs — one entry per array element — into a byType
// map. Shared shape underlying both the CLI's repeated
// --archive-after-days-for flag (already an array of "type=days" strings)
// and the browser admin form's newline-separated archiveAfterDaysByType
// textarea (split on "\n" by the caller first). Malformed entries (no "=",
// empty type, empty/non-numeric days) are skipped unless `strict` is set,
// in which case they throw — the CLI historically threw on a bad flag value
// while the form historically ignored a bad line, and this preserves both.
export function parseArchiveAfterDaysPairs(lines, { strict = false } = {}) {
  const byType = {};
  for (const line of Array.isArray(lines) ? lines : []) {
    const text = String(line ?? "");
    const separatorIndex = text.indexOf("=");
    if (separatorIndex === -1) {
      if (strict) {
        throw new Error(`--archive-after-days-for expects type=days, got: ${text}`);
      }
      continue;
    }
    const type = text.slice(0, separatorIndex).trim();
    const days = text.slice(separatorIndex + 1).trim();
    if (!type || !days) {
      if (strict) {
        throw new Error(`--archive-after-days-for expects type=days, got: ${text}`);
      }
      continue;
    }
    byType[type] = Number(days);
  }
  return byType;
}

function normalizeKeepTags(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const tags = [];
  for (const item of value) {
    const tag = typeof item === "string" ? item.trim() : "";
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return tags;
}

function policyIsAllNull(policy) {
  return (
    policy.archiveAfterDays.default === null &&
    Object.keys(policy.archiveAfterDays.byType).length === 0 &&
    policy.purgeArchivedAfterDays === null &&
    policy.auditRetentionDays === null &&
    policy.eventRetentionRows === null
  );
}

export function isRetentionPolicyInert(policy) {
  return policyIsAllNull(normalizeRetentionPolicy(policy));
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Every retention-originated audit row is written through storage.js's
// shared insertAuditRow (docs/roadmap-design.md's "every mutation writes an
// audit row through insertAuditRecord" convention) rather than a raw
// INSERT, so retention actions can also derive an event when
// events.js:ACTION_TO_EVENT_TYPE maps them (see "retention-archive").
function insertRetentionAuditRow(db, { action, artifactId = "", actor = "system:retention", surface = "retention", metadata = {} }) {
  insertAuditRow(db, {
    action,
    artifactId: artifactId || "",
    audit: { actor, surface },
    metadata: metadata || {}
  });
}

export async function getRetentionPolicy(store = createStore()) {
  await ensureStore(store);
  const db = openDatabase(store);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'retention_policy'").get();
    if (!row) {
      return normalizeRetentionPolicy(DEFAULT_RETENTION_POLICY);
    }
    try {
      return normalizeRetentionPolicy(JSON.parse(row.value));
    } catch {
      return normalizeRetentionPolicy(DEFAULT_RETENTION_POLICY);
    }
  } finally {
    db.close();
  }
}

export async function setRetentionPolicy(store = createStore(), policy = {}, options = {}) {
  await ensureStore(store);
  const normalized = normalizeRetentionPolicy(policy);
  const db = openDatabase(store);
  try {
    transaction(db, () => {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('retention_policy', ?)").run(
        JSON.stringify(normalized)
      );
      insertRetentionAuditRow(db, {
        action: "retention-policy-update",
        actor: options.audit?.actor || "system:retention",
        surface: options.audit?.surface || "retention",
        metadata: { policy: normalized }
      });
    });
    return normalized;
  } finally {
    db.close();
  }
}

function archiveCutoffDays(policy, artifactType) {
  const perType = policy.archiveAfterDays.byType[artifactType];
  return perType !== undefined ? perType : policy.archiveAfterDays.default;
}

// The environment gate is mandatory: a request body or CLI flag can opt in to
// purging only when the operator has also set ARTIFACTY_RETENTION_ALLOW_PURGE.
// The scheduled sweep passes no options, so the env var alone enables it.
function isPurgeAllowed(options = {}) {
  if (process.env.ARTIFACTY_RETENTION_ALLOW_PURGE !== "true") {
    return false;
  }
  return options.allowPurge !== false;
}

// Builds the dry-run report: which artifacts would be archived, which
// archived artifacts would be purged, and how many audit/event rows would
// be pruned. Makes no changes.
export async function planRetention(store = createStore(), options = {}) {
  const policy = await getRetentionPolicy(store);
  const now = options.now ? new Date(options.now) : new Date();
  const db = openDatabase(store);
  try {
    return computePlan(db, policy, now);
  } finally {
    db.close();
  }
}

function computePlan(db, policy, now) {
  // openDatabase() always runs storage.js's schema migrations, which
  // include ensureColumn(db, "artifacts", "review_status", ...); the column
  // is therefore unconditionally present here.
  const archive = [];
  const purge = [];

  const activeRows = db
    .prepare(`
      SELECT id, artifact_type, tags_json, updated_at, review_status
      FROM artifacts
      WHERE archived_at IS NULL
    `)
    .all();

  for (const row of activeRows) {
    const cutoffDays = archiveCutoffDays(policy, row.artifact_type);
    if (cutoffDays === null) {
      continue;
    }
    const tags = parseJsonArray(row.tags_json);
    if (policy.keepTags.some((tag) => tags.includes(tag))) {
      continue;
    }
    if (row.review_status === "approved") {
      continue;
    }
    const ageMs = now.getTime() - new Date(row.updated_at).getTime();
    if (Number.isFinite(ageMs) && ageMs >= cutoffDays * MS_PER_DAY) {
      archive.push({
        id: row.id,
        reason: "archiveAfterDays",
        artifactType: row.artifact_type,
        ageDays: Math.floor(ageMs / MS_PER_DAY),
        thresholdDays: cutoffDays
      });
    }
  }

  if (policy.purgeArchivedAfterDays !== null) {
    const archivedRows = db
      .prepare(`SELECT id, archived_at FROM artifacts WHERE archived_at IS NOT NULL`)
      .all();
    for (const row of archivedRows) {
      const ageMs = now.getTime() - new Date(row.archived_at).getTime();
      if (Number.isFinite(ageMs) && ageMs >= policy.purgeArchivedAfterDays * MS_PER_DAY) {
        purge.push({
          id: row.id,
          reason: "purgeArchivedAfterDays",
          ageDays: Math.floor(ageMs / MS_PER_DAY),
          thresholdDays: policy.purgeArchivedAfterDays
        });
      }
    }
  }

  let auditRowsToDelete = 0;
  if (policy.auditRetentionDays !== null) {
    const cutoff = new Date(now.getTime() - policy.auditRetentionDays * MS_PER_DAY).toISOString();
    const placeholders = AUDIT_RETENTION_EXEMPT_ACTIONS.map(() => "?").join(", ");
    auditRowsToDelete = db
      .prepare(`
        SELECT COUNT(*) AS count FROM audit_log
        WHERE created_at < ? AND action NOT IN (${placeholders})
      `)
      .get(cutoff, ...AUDIT_RETENTION_EXEMPT_ACTIONS).count;
  }

  let eventRowsToDelete = 0;
  if (policy.eventRetentionRows !== null) {
    const total = db.prepare("SELECT COUNT(*) AS count FROM events").get().count;
    eventRowsToDelete = Math.max(0, total - policy.eventRetentionRows);
  }

  return {
    generatedAt: now.toISOString(),
    policy,
    archive,
    purge,
    auditRowsToDelete,
    eventRowsToDelete
  };
}

// `artifact_comments`, `artifact_relations`, and `artifact_embeddings` all
// declare `FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE
// CASCADE` (storage.js's initializeSchema) and PRAGMA foreign_keys = ON is
// set on every connection (via storage.js's openDatabase), so SQLite itself
// cascades those three tables when the DELETE FROM artifacts below runs.
// What is *not* covered by a foreign key is `events` (no FK column at all)
// and the `artifact_search` FTS5 virtual table (synced only by explicit
// DELETE/INSERT elsewhere, no triggers) — both are cleared here explicitly
// so a purge doesn't leave orphaned rows that SSE Last-Event-ID replay can
// still emit, or that FTS keeps scoring forever. Audit rows deliberately
// survive a purge (see AUDIT_RETENTION_EXEMPT_ACTIONS): the purge itself,
// and everything that happened to the artifact before it, remain in
// audit_log as the historical record.
function purgeArtifactDependents(db, artifactId) {
  db.prepare("DELETE FROM events WHERE artifact_id = ?").run(artifactId);
  if (tableExistsInDb(db, "artifact_search")) {
    db.prepare("DELETE FROM artifact_search WHERE artifact_id = ?").run(artifactId);
  }
}

// Applies the retention plan. With dryRun (the default), only returns the
// plan report and makes no changes at all -- not even a retention-sweep
// audit row. Without dryRun, archives/purges artifacts, prunes audit and
// event rows, and writes one `retention-sweep` summary audit row.
export async function runRetention(store = createStore(), options = {}) {
  const dryRun = options.dryRun === undefined ? true : Boolean(options.dryRun);
  const now = options.now ? new Date(options.now) : new Date();
  const plan = await planRetention(store, { now });

  if (dryRun) {
    return { ...plan, dryRun: true, archived: [], purged: [], purgeSkipped: plan.purge.length > 0, auditRowsDeleted: 0, eventRowsDeleted: 0 };
  }

  const archived = [];
  const purged = [];
  let purgeSkipped = false;

  for (const candidate of plan.archive) {
    try {
      await archiveArtifact(store, candidate.id, {
        audit: { actor: "system:retention", surface: "retention" },
        action: "retention-archive"
      });
      archived.push(candidate.id);
    } catch {
      // Artifact may have been deleted/archived concurrently; skip it.
    }
  }

  const purgeAllowed = isPurgeAllowed(options);
  if (plan.purge.length > 0 && !purgeAllowed) {
    purgeSkipped = true;
  } else if (plan.purge.length > 0) {
    const db = openDatabase(store);
    try {
      for (const candidate of plan.purge) {
        transaction(db, () => {
          insertRetentionAuditRow(db, {
            action: "retention-purge",
            artifactId: candidate.id,
            metadata: { reason: candidate.reason, ageDays: candidate.ageDays }
          });
          purgeArtifactDependents(db, candidate.id);
          db.prepare("DELETE FROM artifacts WHERE id = ?").run(candidate.id);
        });
        // candidate.id came from the artifacts table, which normally only
        // ever holds ids shaped by makeArtifactId(). A restored backup
        // bundle can insert arbitrary row ids (see replaceTableRows in
        // storage.js), so validate the id and confirm the resolved path
        // stays inside the store's artifacts directory before recursively
        // deleting anything on disk.
        if (isValidArtifactId(candidate.id)) {
          const artifactsRoot = path.resolve(store.artifactsDir);
          const artifactDir = path.resolve(artifactsRoot, candidate.id);
          const isContained = artifactDir === artifactsRoot
            ? false
            : artifactDir.startsWith(artifactsRoot + path.sep);
          if (isContained && existsSync(artifactDir)) {
            rmSync(artifactDir, { recursive: true, force: true });
          }
        }
        purged.push(candidate.id);
      }
    } finally {
      db.close();
    }
  }

  const db = openDatabase(store);
  let auditRowsDeleted = 0;
  let eventRowsDeleted = 0;
  try {
    transaction(db, () => {
      const policy = plan.policy;
      if (policy.auditRetentionDays !== null) {
        const cutoff = new Date(now.getTime() - policy.auditRetentionDays * MS_PER_DAY).toISOString();
        const placeholders = AUDIT_RETENTION_EXEMPT_ACTIONS.map(() => "?").join(", ");
        const result = db
          .prepare(`DELETE FROM audit_log WHERE created_at < ? AND action NOT IN (${placeholders})`)
          .run(cutoff, ...AUDIT_RETENTION_EXEMPT_ACTIONS);
        auditRowsDeleted = result.changes || 0;
      }
      if (policy.eventRetentionRows !== null) {
        const result = db
          .prepare(`
            DELETE FROM events
            WHERE seq <= (SELECT COALESCE(MAX(seq), 0) FROM events) - ?
          `)
          .run(policy.eventRetentionRows);
        eventRowsDeleted = result.changes || 0;
      }
      insertRetentionAuditRow(db, {
        action: "retention-sweep",
        metadata: {
          archived: archived.length,
          purged: purged.length,
          purgeSkipped,
          auditRowsDeleted,
          eventRowsDeleted
        }
      });
    });
  } finally {
    db.close();
  }

  return {
    ...plan,
    dryRun: false,
    archived,
    purged,
    purgeSkipped,
    auditRowsDeleted,
    eventRowsDeleted
  };
}

export function retentionIntervalMs() {
  const parsed = Number.parseInt(process.env.ARTIFACTY_RETENTION_INTERVAL_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3600000;
}

// Starts a background sweep timer unconditionally (checking the policy on
// every tick, not just once at startup): a store opened with an all-null
// policy that later gets a policy set via setRetentionPolicy() must still
// have a running sweep to act on it, and there was previously no signal
// that would make startRetentionSweep re-evaluate that after the fact.
// Returns a stop function; safe to call even if the timer never did
// anything.
export async function startRetentionSweep(store = createStore(), options = {}) {
  let running = false;
  const intervalMs = options.intervalMs || retentionIntervalMs();
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    (async () => {
      const policy = await getRetentionPolicy(store);
      if (policyIsAllNull(policy)) {
        return;
      }
      await runRetention(store, { dryRun: false });
    })()
      .catch((error) => {
        process.stderr.write(`Artifacty retention sweep error: ${error.stack || error.message}\n`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
