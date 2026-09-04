import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isUnknownSourceAgent, normalizeSourceAgent } from "./agents.js";
import { assertNoSecrets, normalizeTokenScopes, securityConfig } from "./security.js";
import { EVENT_TYPES, eventFromAudit, eventHistoryLimit, eventVisibleTo, matchesFilter, publish as publishEvent } from "./events.js";
import { assertPublicWebhookUrl } from "./webhooks.js";
import {
  blobToVector,
  cosineSimilarity,
  createEmbeddingProvider,
  embeddingTextForArtifact,
  reciprocalRankFusion,
  vectorToBlob
} from "./embeddings.js";

export const STORE_VERSION = 8;
// Not exported: no caller outside this file reads the constant itself, only
// the numeric schemaVersion field it seeds on artifacts.
const ARTIFACT_SCHEMA_VERSION = 1;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
// Shape produced by makeArtifactId(): a lowercase slug of the title
// (letters/digits/hyphens) followed by "-" and an 8-hex-char UUID suffix.
// Used to validate ids coming from untrusted sources (e.g. restored backup
// bundles) before they are used to build filesystem paths.
export const ARTIFACT_ID_PATTERN = /^[a-z0-9-]{1,80}$/;

export function isValidArtifactId(id) {
  return typeof id === "string" && ARTIFACT_ID_PATTERN.test(id) && !id.includes("..");
}
// Comments and review threads (roadmap section 5). Comment bodies are
// Markdown, rendered through the same sanitized pipeline as artifact
// content, and capped at this many UTF-8 bytes.
export const MAX_COMMENT_BYTES = 16 * 1024;
// Document assets in bundles (roadmap section 17). Binary bundle file
// entries (base64-encoded) are capped individually; the overall bundle
// artifact still has to fit under MAX_ARTIFACT_BYTES.
export const MAX_BUNDLE_FILE_BYTES = 32 * 1024 * 1024;
export const BUNDLE_BINARY_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip"
]);
export const REVIEW_STATUSES = ["none", "pending", "changes-requested", "approved"];
export { TOKEN_SCOPES } from "./security.js";
const SOURCE_AGENT_NORMALIZATION_VERSION = "1";
export const USER_ROLES = ["admin", "user"];
export const ARTIFACT_FORMATS = [
  "html",
  "markdown",
  "text",
  "json",
  "code",
  "svg",
  "mermaid",
  "react",
  "sarif",
  "csv",
  "image",
  "video",
  "notebook"
];
export const ARTIFACT_TYPES = [
  "document",
  "html-page",
  "handoff",
  "code-review",
  "test-report",
  "dashboard",
  "design-option",
  "diff-walkthrough",
  "bundle",
  "asset",
  "diagram",
  "component",
  "snippet",
  "analysis-report",
  "table",
  "unknown"
];

export const RELATION_TYPES = ["derived-from", "supersedes", "reviews", "references", "part-of"];

export const VISIBILITY_VALUES = ["private", "team"];

// Allowlisted filter keys a saved view may capture. Keeps saved views forward
// compatible with filters that are recognized but not yet acted on (e.g.
// "mode", reserved for Section 6 semantic search).
export const SAVED_VIEW_FILTER_KEYS = [
  "query",
  "tag",
  "sourceAgent",
  "artifactType",
  "publisher",
  "createdAfter",
  "createdBefore",
  "reviewStatus",
  "relatedTo",
  "relation",
  "includeArchived",
  "mode"
];

const RELATION_INVERSES = {
  "derived-from": "derives",
  "derives": "derived-from",
  "supersedes": "superseded-by",
  "superseded-by": "supersedes",
  "reviews": "reviewed-by",
  "reviewed-by": "reviews",
  "references": "referenced-by",
  "referenced-by": "references",
  "part-of": "contains",
  "contains": "part-of"
};

export function inverseRelation(name) {
  return RELATION_INVERSES[name] || null;
}

const FORMAT_TO_EXTENSION = {
  html: "html",
  markdown: "md",
  text: "txt",
  json: "json",
  code: "code",
  svg: "svg",
  mermaid: "mmd",
  react: "jsx",
  sarif: "sarif",
  csv: "csv",
  image: "image",
  video: "video",
  notebook: "ipynb"
};

const FORMAT_TO_CONTENT_TYPE = {
  html: "text/html; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  text: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  code: "text/x-source-code; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  mermaid: "text/vnd.mermaid; charset=utf-8",
  react: "text/jsx; charset=utf-8",
  sarif: "application/sarif+json; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  image: "application/vnd.artifacty.image+base64; charset=utf-8",
  video: "application/vnd.artifacty.video+base64; charset=utf-8",
  notebook: "application/x-ipynb+json; charset=utf-8"
};

export class VersionConflictError extends Error {
  constructor(artifactId, latestVersion) {
    super("Version conflict");
    this.name = "VersionConflictError";
    this.code = "version_conflict";
    this.statusCode = 409;
    this.artifactId = artifactId;
    this.latestVersion = latestVersion;
    this.details = { latestVersion };
  }
}

export function artifactEtag(artifact) {
  return `${artifact.id}:${artifact.latestVersion}`;
}

export class ForbiddenError extends Error {
  constructor(message, statusCode = 403) {
    super(message);
    this.name = "ForbiddenError";
    this.code = "forbidden";
    this.statusCode = statusCode;
  }
}

function normalizeVisibility(value) {
  if (value === undefined || value === null || value === "") {
    return "team";
  }
  const normalized = String(value).trim().toLowerCase();
  if (!VISIBILITY_VALUES.includes(normalized)) {
    throw Object.assign(new Error(`Unsupported visibility: ${value}`), {
      code: "INVALID_VISIBILITY",
      statusCode: 400
    });
  }
  return normalized;
}

function teamWriteRestrictedToOwner() {
  return normalizeOptionalString(process.env.ARTIFACTY_TEAM_WRITE).toLowerCase() === "owner";
}

function userCountSync(db) {
  return db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
}

// Single-user mode: no users have ever been created, so there is nothing to
// scope visibility against. Every access check below short-circuits in that
// case, matching pre-Section-10 behavior.
function isSingleUserMode(db) {
  return userCountSync(db) === 0;
}

// Shared SQL visibility predicate, mirroring canReadArtifactMeta: a falsy
// `access` sees everything (empty clause); otherwise a private row is only
// visible to its own owner or an admin. `prefix` is a table alias including
// the trailing dot (e.g. "a."), or "" for an unaliased query. The `? != ''`
// guard keeps an empty/anonymous access.userId from matching rows whose
// owner_user_id happens to be stored as an empty string.
export function visibilityClause(prefix, access) {
  if (!access) {
    return { sql: "", params: [] };
  }
  const userId = access.userId || "";
  const isAdmin = access.role === "admin" ? 1 : 0;
  return {
    sql: `(${prefix}visibility != 'private' OR (? != '' AND ${prefix}owner_user_id = ?) OR ? = 1)`,
    params: [userId, userId, isAdmin]
  };
}

function isOwnerOrAdmin(access, ownerUserId) {
  if (!access) {
    return false;
  }
  if (access.role === "admin") {
    return true;
  }
  return Boolean(access.userId) && Boolean(ownerUserId) && access.userId === ownerUserId;
}

function artifactVisibilityOf(artifact) {
  return artifact.visibility || "team";
}

function canReadArtifactMeta(db, artifact, access) {
  if (!access || isSingleUserMode(db)) {
    return true;
  }
  if (artifactVisibilityOf(artifact) !== "private") {
    return true;
  }
  return isOwnerOrAdmin(access, artifact.ownerUserId);
}

function canWriteArtifactMeta(db, artifact, access) {
  if (!access || isSingleUserMode(db)) {
    return true;
  }
  if (artifactVisibilityOf(artifact) === "private") {
    return isOwnerOrAdmin(access, artifact.ownerUserId);
  }
  if (access.anonymous) {
    return !teamWriteRestrictedToOwner();
  }
  if (teamWriteRestrictedToOwner()) {
    return isOwnerOrAdmin(access, artifact.ownerUserId);
  }
  return Boolean(access.userId) || access.role === "admin";
}

function canManageArtifactMeta(db, artifact, access) {
  if (!access || isSingleUserMode(db)) {
    return true;
  }
  return isOwnerOrAdmin(access, artifact.ownerUserId);
}

// Reads by non-owners of a private artifact 404 instead of 403 to avoid
// leaking existence of artifacts the caller cannot see.
function assertArtifactReadable(db, artifact, access) {
  if (!canReadArtifactMeta(db, artifact, access)) {
    throw Object.assign(new Error(`Artifact not found: ${artifact.id}`), {
      code: "ARTIFACT_NOT_FOUND",
      statusCode: 404
    });
  }
}

function assertArtifactWritable(db, artifact, access) {
  if (!canWriteArtifactMeta(db, artifact, access)) {
    throw new ForbiddenError(`Not permitted to modify artifact: ${artifact.id}`);
  }
}

function assertArtifactManageable(db, artifact, access) {
  if (!canManageArtifactMeta(db, artifact, access)) {
    throw new ForbiddenError(`Not permitted to manage artifact: ${artifact.id}`);
  }
}

export function createStore(options = {}) {
  const home =
    options.home ||
    process.env.ARTIFACTY_HOME ||
    path.join(homedir(), ".artifacty");

  return {
    home: path.resolve(home),
    dbPath: path.resolve(home, "artifacty.sqlite"),
    indexPath: path.resolve(home, "index.json"),
    artifactsDir: path.resolve(home, "artifacts")
  };
}

export async function ensureStore(store = createStore()) {
  const db = openDatabase(store);
  db.close();
  return store;
}

export async function loadIndex(store = createStore()) {
  const db = openDatabase(store);
  try {
    return {
      version: STORE_VERSION,
      artifacts: loadArtifacts(db)
    };
  } finally {
    db.close();
  }
}

export async function writeIndex(store, index) {
  if (!index || !Array.isArray(index.artifacts)) {
    throw new Error("Artifacty index must contain an artifacts array");
  }

  const db = openDatabase(store);
  try {
    transaction(db, () => {
      clearSearchIndex(db);
      db.prepare("DELETE FROM artifact_versions").run();
      db.prepare("DELETE FROM artifacts").run();
      for (const artifact of index.artifacts) {
        insertArtifactRecord(db, artifact);
        for (const version of artifact.versions || []) {
          insertVersionRecord(db, artifact.id, version);
        }
      }
      normalizeStoredSourceAgents(db, store, {
        force: true,
        inTransaction: true,
        rebuildSearch: false
      });
      rebuildSearchIndexInDb(db, store);
    });
  } finally {
    db.close();
  }
}

export async function createArtifact(store = createStore(), input = {}) {
  const secretScan = assertNoSecrets(input, securityConfig());
  input = withSecretScan(input, secretScan);
  const normalized = normalizeArtifactInput(input, { requireContent: true, requireTitle: true });
  validateBundleFileEntries(normalized);
  const db = openDatabase(store);

  let writtenVersionPath;
  try {
    let artifact;
    try {
      transaction(db, () => {
      const now = new Date().toISOString();
      const id = makeArtifactId(normalized.title);
      const version = writeVersionFile(store, id, 1, normalized, now);
      writtenVersionPath = version.path;
      const publisher = publisherFromAudit(input.audit);
      const visibility = normalizeVisibility(input.visibility);
      const ownerUserId = normalizeOptionalString(input.ownerUserId) || publisher.publisherUserId || null;

      artifact = {
        id,
        title: normalized.title,
        artifactType: normalized.artifactType,
        schemaVersion: normalized.schemaVersion,
        sourceAgent: normalized.sourceAgent,
        publisherId: publisher.publisherId,
        publisherName: publisher.publisherName,
        publisherUserId: publisher.publisherUserId,
        visibility,
        ownerUserId,
        reviewStatus: "none",
        tags: normalized.tags,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestVersion: 1,
        versions: [version]
      };

      insertArtifactRecord(db, artifact);
      insertVersionRecord(db, id, version);
      upsertSearchIndex(db, artifact, version, normalized.content);
      insertAuditRecord(db, {
        action: input.auditAction || "create",
        artifactId: id,
        version: 1,
        sourceAgent: normalized.sourceAgent,
        audit: input.audit,
        metadata: { title: normalized.title, artifactType: normalized.artifactType },
        tags: artifact.tags,
        artifactType: artifact.artifactType
      });
      insertRelationsForInput(db, artifact, input.relations, input.audit);
      });
    } catch (error) {
      // The version file was just created at a path that could not
      // previously exist (a brand-new artifact id); a rollback of the DB
      // transaction that was meant to reference it must not leave it
      // behind as an orphan.
      if (writtenVersionPath) {
        removeVersionFile(store, writtenVersionPath);
      }
      throw error;
    }

    scheduleEmbeddingIndexing(store, artifact, artifact.versions[artifact.versions.length - 1], normalized.content);
    return withLatestContent(store, artifact);
  } finally {
    db.close();
  }
}

export async function updateArtifact(store = createStore(), id, input = {}) {
  const secretScan = assertNoSecrets(input, securityConfig());
  input = withSecretScan(input, secretScan);
  const normalized = normalizeArtifactInput(input, {
    requireContent: true,
    requireTitle: false,
    defaultSourceAgent: ""
  });
  validateBundleFileEntries(normalized);
  const expectedVersion = Number.isFinite(input.expectedVersion) ? input.expectedVersion : null;
  const db = openDatabase(store);

  let versionCreated = false;
  let writtenVersionPath;
  try {
    let artifact;
    try {
      transaction(db, () => {
      artifact = findArtifactById(db, id);
      assertArtifactReadable(db, artifact, input.access);
      assertArtifactWritable(db, artifact, input.access);
      if (expectedVersion !== null && artifact.latestVersion !== expectedVersion) {
        throw new VersionConflictError(artifact.id, artifact.latestVersion);
      }
      const latest = artifact.versions.find((version) => version.version === artifact.latestVersion);
      if (input.skipNoop && latest) {
        const latestContent = readFileSync(path.join(store.home, latest.path), "utf8");
        if (isNoopVersionUpdate(artifact, latest, latestContent, normalized)) {
          insertAuditRecord(db, {
            action: "update-noop",
            artifactId: artifact.id,
            version: artifact.latestVersion,
            sourceAgent: artifact.sourceAgent,
            audit: input.audit,
            metadata: { reason: "no changes detected" }
          });
          return;
        }
      }
      versionCreated = true;
      const now = new Date().toISOString();
      const nextVersion = artifact.latestVersion + 1;
      const version = writeVersionFile(store, artifact.id, nextVersion, normalized, now);
      writtenVersionPath = version.path;

      artifact.title = normalized.title || artifact.title;
      artifact.sourceAgent = normalized.sourceAgent || artifact.sourceAgent;
      artifact.artifactType = normalized.artifactType || artifact.artifactType;
      artifact.schemaVersion = normalized.schemaVersion || artifact.schemaVersion;
      artifact.tags = normalized.tags.length > 0 ? normalized.tags : artifact.tags;
      artifact.updatedAt = now;
      artifact.latestVersion = nextVersion;
      artifact.versions.push(version);

      // A new version invalidates a prior approval (roadmap section 5): an
      // approved artifact automatically drops back to "pending" review so
      // the new content gets re-reviewed, noted in this update's audit
      // metadata rather than a separate review-status-change event.
      const previousReviewStatus = artifact.reviewStatus || "none";
      const reviewStatusReset = previousReviewStatus === "approved";
      if (reviewStatusReset) {
        artifact.reviewStatus = "pending";
      }

      db.prepare(`
        UPDATE artifacts
        SET title = ?, source_agent = ?, artifact_type = ?, schema_version = ?, tags_json = ?, updated_at = ?, latest_version = ?, review_status = ?
        WHERE id = ?
      `).run(
        artifact.title,
        artifact.sourceAgent,
        artifact.artifactType,
        artifact.schemaVersion,
        JSON.stringify(artifact.tags),
        artifact.updatedAt,
        artifact.latestVersion,
        artifact.reviewStatus || previousReviewStatus,
        artifact.id
      );
      insertVersionRecord(db, artifact.id, version);
      upsertSearchIndex(db, artifact, version, normalized.content);
      insertAuditRecord(db, {
        action: input.auditAction || "update",
        artifactId: artifact.id,
        version: nextVersion,
        sourceAgent: normalized.sourceAgent,
        audit: input.audit,
        metadata: {
          title: artifact.title,
          artifactType: artifact.artifactType,
          ...(reviewStatusReset ? { reviewStatusReset: { from: previousReviewStatus, to: "pending" } } : {})
        },
        tags: artifact.tags,
        artifactType: artifact.artifactType
      });
      insertRelationsForInput(db, artifact, input.relations, input.audit);
      });
    } catch (error) {
      // Same rationale as createArtifact: the new version file is written
      // at a path (v<nextVersion>.<ext>) that could not previously exist,
      // so a rolled-back transaction must not leave it as an orphan.
      if (versionCreated && writtenVersionPath) {
        removeVersionFile(store, writtenVersionPath);
      }
      throw error;
    }

    if (versionCreated) {
      scheduleEmbeddingIndexing(store, artifact, artifact.versions[artifact.versions.length - 1], normalized.content);
    }
    return withLatestContent(store, artifact);
  } catch (error) {
    if (error instanceof VersionConflictError) {
      transaction(db, () => {
        insertAuditRecord(db, {
          action: "update-conflict",
          artifactId: error.artifactId,
          version: error.latestVersion,
          sourceAgent: normalized.sourceAgent,
          audit: input.audit,
          metadata: { expectedVersion, latestVersion: error.latestVersion }
        });
      });
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function replaceArtifactVersion(store = createStore(), id, versionNumber, input = {}) {
  const secretScan = assertNoSecrets(input, securityConfig());
  input = withSecretScan(input, secretScan);
  const normalized = normalizeArtifactInput(input, {
    requireContent: true,
    requireTitle: false,
    defaultSourceAgent: ""
  });
  const targetVersion = Number(versionNumber);
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw Object.assign(new Error(`Invalid artifact version: ${versionNumber}`), {
      code: "INVALID_VERSION",
      statusCode: 400
    });
  }
  const db = openDatabase(store);

  try {
    let artifact;
    let replacement;
    let previousPath;
    let previousBytes = null;
    let fileWritten = false;
    try {
      transaction(db, () => {
        artifact = findArtifactById(db, id);
        assertArtifactReadable(db, artifact, input.access);
        assertArtifactManageable(db, artifact, input.access);
        const existing = artifact.versions.find((version) => version.version === targetVersion);
        if (!existing) {
          throw Object.assign(new Error(`Artifact version not found: ${id}@${targetVersion}`), {
            code: "ARTIFACT_VERSION_NOT_FOUND",
            statusCode: 404
          });
        }

        const now = new Date().toISOString();
        previousPath = existing.path;
        const repairedMetadata = {
          ...existing.metadata,
          ...normalized.metadata,
          adminRepair: {
            repairedAt: now,
            reason: normalizeOptionalString(input.reason),
            previousSha256: existing.sha256,
            previousSizeBytes: existing.sizeBytes,
            previousPath
          }
        };

        // Back up the previous bytes before writeVersionFile touches disk:
        // that write is not part of this DB transaction, so if anything
        // below throws and the transaction rolls back, a same-path
        // overwrite must be restored by hand rather than left mismatched
        // against the row that now (again) points at the old sha256/size.
        const previousAbsolutePath = path.join(store.home, previousPath);
        previousBytes = existsSync(previousAbsolutePath) ? readFileSync(previousAbsolutePath) : null;

        replacement = writeVersionFile(store, artifact.id, targetVersion, {
          ...normalized,
          metadata: repairedMetadata
        }, existing.createdAt);
        fileWritten = true;

        db.prepare(`
          UPDATE artifact_versions
          SET created_at = ?, format = ?, content_type = ?, path = ?, size_bytes = ?, sha256 = ?, metadata_json = ?
          WHERE artifact_id = ? AND version = ?
        `).run(
          replacement.createdAt,
          replacement.format,
          replacement.contentType,
          replacement.path,
          replacement.sizeBytes,
          replacement.sha256,
          JSON.stringify(replacement.metadata || {}),
          artifact.id,
          targetVersion
        );

        artifact.versions = artifact.versions.map((version) => version.version === targetVersion ? replacement : version);
        artifact.updatedAt = now;
        db.prepare("UPDATE artifacts SET updated_at = ? WHERE id = ?").run(now, artifact.id);
        if (targetVersion === artifact.latestVersion) {
          upsertSearchIndex(db, artifact, replacement, normalized.content);
        }
        insertAuditRecord(db, {
          action: "version-repair",
          artifactId: artifact.id,
          version: targetVersion,
          sourceAgent: artifact.sourceAgent,
          audit: input.audit,
          metadata: {
            reason: normalizeOptionalString(input.reason),
            previousSha256: existing.sha256,
            newSha256: replacement.sha256,
            previousPath
          },
          tags: artifact.tags,
          artifactType: artifact.artifactType
        });
      });
    } catch (error) {
      // The DB transaction rolled back (or never committed); undo the
      // file-side effects of the write above so the on-disk content and the
      // (unchanged) row stay consistent with each other.
      if (fileWritten && replacement) {
        if (previousPath !== replacement.path) {
          removeVersionFile(store, replacement.path);
        } else if (previousBytes !== null) {
          writeFileSync(path.join(store.home, previousPath), previousBytes);
        }
      }
      throw error;
    }

    // Only remove the superseded file (when the format/extension changed,
    // so replacement landed at a new path) after the transaction has
    // committed successfully.
    if (previousPath !== replacement.path) {
      removeVersionFile(store, previousPath);
    }

    return getArtifact(store, id, { version: targetVersion });
  } finally {
    db.close();
  }
}

export async function deleteArtifactVersion(store = createStore(), id, versionNumber, options = {}) {
  const targetVersion = Number(versionNumber);
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw Object.assign(new Error(`Invalid artifact version: ${versionNumber}`), {
      code: "INVALID_VERSION",
      statusCode: 400
    });
  }
  const db = openDatabase(store);

  try {
    let artifact;
    let existing;
    let latest;
    transaction(db, () => {
      artifact = findArtifactById(db, id);
      assertArtifactReadable(db, artifact, options.access);
      assertArtifactManageable(db, artifact, options.access);
      if (artifact.versions.length <= 1) {
        throw Object.assign(new Error("Cannot delete the only version of an artifact"), {
          code: "ONLY_VERSION_DELETE_BLOCKED",
          statusCode: 400
        });
      }
      existing = artifact.versions.find((version) => version.version === targetVersion);
      if (!existing) {
        throw Object.assign(new Error(`Artifact version not found: ${id}@${targetVersion}`), {
          code: "ARTIFACT_VERSION_NOT_FOUND",
          statusCode: 404
        });
      }

      const now = new Date().toISOString();
      db.prepare("DELETE FROM artifact_versions WHERE artifact_id = ? AND version = ?").run(artifact.id, targetVersion);
      artifact.versions = artifact.versions.filter((version) => version.version !== targetVersion);
      artifact.latestVersion = Math.max(...artifact.versions.map((version) => version.version));
      artifact.updatedAt = now;
      db.prepare("UPDATE artifacts SET latest_version = ?, updated_at = ? WHERE id = ?").run(
        artifact.latestVersion,
        now,
        artifact.id
      );

      latest = artifact.versions.find((version) => version.version === artifact.latestVersion);
      const latestContent = readFileSync(path.join(store.home, latest.path), "utf8");
      upsertSearchIndex(db, artifact, latest, latestContent);

      // The deleted version's embedding row (if any provider/model had it
      // on record) is now stale; drop it here so semantic search never
      // scores against content that no longer exists. A fresh embedding of
      // the new latest version is scheduled below, once the transaction
      // (and therefore the file removal after it) has committed.
      db.prepare("DELETE FROM artifact_embeddings WHERE artifact_id = ? AND version = ?").run(artifact.id, targetVersion);

      insertAuditRecord(db, {
        action: "version-delete",
        artifactId: artifact.id,
        version: targetVersion,
        sourceAgent: artifact.sourceAgent,
        audit: options.audit,
        metadata: {
          reason: normalizeOptionalString(options.reason),
          deletedSha256: existing.sha256,
          deletedPath: existing.path
        },
        tags: artifact.tags,
        artifactType: artifact.artifactType
      });
    });

    // Remove the version file only after the DB transaction has committed
    // successfully, so a later failure inside the transaction rolls back
    // the row without the file it still references having already been
    // deleted out from under it.
    removeVersionFile(store, existing.path);

    if (latest) {
      const latestContent = await readFile(path.join(store.home, latest.path), "utf8");
      scheduleEmbeddingIndexing(store, artifact, latest, latestContent);
    }

    return withLatestContent(store, artifact);
  } finally {
    db.close();
  }
}

export async function archiveArtifact(store = createStore(), id, options = {}) {
  const db = openDatabase(store);
  try {
    let artifact;
    transaction(db, () => {
      artifact = findArtifactById(db, id);
      assertArtifactReadable(db, artifact, options.access);
      assertArtifactManageable(db, artifact, options.access);
      const archivedAt = options.archivedAt || new Date().toISOString();
      db.prepare("UPDATE artifacts SET archived_at = ?, updated_at = ? WHERE id = ?").run(
        archivedAt,
        archivedAt,
        id
      );
      artifact.archivedAt = archivedAt;
      artifact.updatedAt = archivedAt;
      insertAuditRecord(db, {
        action: options.action || "archive",
        artifactId: id,
        version: artifact.latestVersion,
        sourceAgent: artifact.sourceAgent,
        audit: options.audit,
        metadata: {},
        tags: artifact.tags,
        artifactType: artifact.artifactType
      });
    });
    return withLatestContent(store, artifact);
  } finally {
    db.close();
  }
}

export async function restoreArtifact(store = createStore(), id, options = {}) {
  const db = openDatabase(store);
  try {
    let artifact;
    transaction(db, () => {
      artifact = findArtifactById(db, id);
      assertArtifactReadable(db, artifact, options.access);
      assertArtifactManageable(db, artifact, options.access);
      const now = new Date().toISOString();
      db.prepare("UPDATE artifacts SET archived_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
      artifact.archivedAt = null;
      artifact.updatedAt = now;
      insertAuditRecord(db, {
        action: "restore",
        artifactId: id,
        version: artifact.latestVersion,
        sourceAgent: artifact.sourceAgent,
        audit: options.audit,
        metadata: {},
        tags: artifact.tags,
        artifactType: artifact.artifactType
      });
    });
    return withLatestContent(store, artifact);
  } finally {
    db.close();
  }
}

export async function setArtifactVisibility(store = createStore(), id, visibility, options = {}) {
  const nextVisibility = normalizeVisibility(visibility);
  const db = openDatabase(store);
  try {
    let artifact;
    transaction(db, () => {
      artifact = findArtifactById(db, id);
      assertArtifactReadable(db, artifact, options.access);
      assertArtifactManageable(db, artifact, options.access);
      const now = new Date().toISOString();
      const previousVisibility = artifact.visibility;
      db.prepare("UPDATE artifacts SET visibility = ?, updated_at = ? WHERE id = ?").run(nextVisibility, now, id);
      artifact.visibility = nextVisibility;
      artifact.updatedAt = now;
      insertAuditRecord(db, {
        action: "visibility-change",
        artifactId: id,
        version: artifact.latestVersion,
        sourceAgent: artifact.sourceAgent,
        audit: options.audit,
        metadata: { from: previousVisibility, to: nextVisibility },
        tags: artifact.tags,
        artifactType: artifact.artifactType
      });
    });
    return withLatestContent(store, artifact);
  } finally {
    db.close();
  }
}

export async function setArtifactOwner(store = createStore(), id, ownerUserId, options = {}) {
  const nextOwnerUserId = normalizeOptionalString(ownerUserId) || null;
  const db = openDatabase(store);
  try {
    let artifact;
    transaction(db, () => {
      artifact = findArtifactById(db, id);
      assertArtifactReadable(db, artifact, options.access);
      assertArtifactManageable(db, artifact, options.access);
      const now = new Date().toISOString();
      const previousOwnerUserId = artifact.ownerUserId;
      db.prepare("UPDATE artifacts SET owner_user_id = ?, updated_at = ? WHERE id = ?").run(nextOwnerUserId, now, id);
      artifact.ownerUserId = nextOwnerUserId;
      artifact.updatedAt = now;
      insertAuditRecord(db, {
        action: "owner-change",
        artifactId: id,
        version: artifact.latestVersion,
        sourceAgent: artifact.sourceAgent,
        audit: options.audit,
        metadata: { from: previousOwnerUserId, to: nextOwnerUserId },
        tags: artifact.tags,
        artifactType: artifact.artifactType
      });
    });
    return withLatestContent(store, artifact);
  } finally {
    db.close();
  }
}

export async function listArtifacts(store = createStore(), filters = {}) {
  return (await listArtifactsPage(store, filters)).artifacts;
}

// Search modes (roadmap section 6). "keyword" is the pre-existing FTS5/LIKE
// path. "semantic" and "hybrid" require an embedding provider (configured
// through the environment or injected via filters.embeddingProvider /
// setEmbeddingProvider) and fall back to "keyword" — with
// `search.fallback = true` — when none is configured.
const SEARCH_MODES = ["keyword", "semantic", "hybrid"];

function normalizeSearchMode(value) {
  const normalized = normalizeOptionalString(value).toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!SEARCH_MODES.includes(normalized)) {
    throw Object.assign(new Error(`Invalid mode: ${value}`), {
      code: "INVALID_MODE",
      statusCode: 400
    });
  }
  return normalized;
}

export async function listArtifactsPage(store = createStore(), filters = {}) {
  const db = openDatabase(store);
  const limit = clampInteger(filters.limit, 1, 200, 50);
  const offset = clampInteger(filters.offset, 0, 1_000_000, 0);
  const query = normalizeOptionalString(filters.query);
  const normalizedQuery = query.toLowerCase();
  const tag = normalizeOptionalString(filters.tag).toLowerCase();
  const sourceAgent = normalizeSourceAgent(filters.sourceAgent, { defaultValue: "" }).toLowerCase();
  const relatedTo = normalizeOptionalString(filters.relatedTo);
  const relation = normalizeOptionalString(filters.relation);
  const artifactType = normalizeOptionalString(filters.artifactType).toLowerCase();
  const publisher = normalizeOptionalString(filters.publisher);
  const reviewStatus = normalizeOptionalString(filters.reviewStatus).toLowerCase();
  const createdAfter = parseFilterDate(filters.createdAfter, "createdAfter");
  const createdBefore = parseFilterDate(filters.createdBefore, "createdBefore");
  const access = filters.access || null;
  const bypassVisibility = !access || isSingleUserMode(db);
  const visibility = filters.visibility ? normalizeVisibility(filters.visibility) : undefined;
  const ownerUserId = normalizeOptionalString(filters.ownerUserId) || undefined;
  const requestedMode = normalizeSearchMode(filters.mode);

  const baseFilters = {
    tag,
    sourceAgent,
    relatedTo,
    relation,
    artifactType,
    publisher,
    reviewStatus,
    createdAfter,
    createdBefore,
    includeArchived: filters.includeArchived,
    limit,
    offset,
    access,
    bypassVisibility,
    visibility,
    ownerUserId
  };

  try {
    const keywordPage = (overrides = {}) =>
      listArtifactsPageKeyword(db, { ...baseFilters, rawQuery: query, query: normalizedQuery, ...overrides });

    if (!query || requestedMode === "keyword") {
      const page = keywordPage();
      page.search = { ...page.search, mode: "keyword" };
      return page;
    }

    const provider = resolveEmbeddingProvider(filters.embeddingProvider);
    if (!provider) {
      const page = keywordPage();
      page.search = { ...page.search, mode: "keyword", ...(requestedMode ? { fallback: true } : {}) };
      return page;
    }

    const effectiveMode = requestedMode || "hybrid";
    if (effectiveMode === "semantic") {
      const page = await listArtifactsPageSemantic(db, { ...baseFilters, query }, provider);
      page.search = { ...page.search, mode: "semantic" };
      return page;
    }

    const page = await listArtifactsPageHybrid(db, { ...baseFilters, query }, provider);
    page.search = { ...page.search, mode: "hybrid" };
    return page;
  } finally {
    db.close();
  }
}

// Shared keyword search: tries the FTS5 index first (when the raw query
// tokenizes to a usable MATCH expression and returns at least one row), then
// falls back to the LIKE-based metadata scan. Used directly for `mode:
// "keyword"` and as one ranking input for `mode: "hybrid"`.
function listArtifactsPageKeyword(db, filters) {
  if (filters.rawQuery && searchIndexAvailable(db)) {
    const ftsQuery = toFtsQuery(filters.rawQuery);
    if (ftsQuery) {
      try {
        const page = listArtifactsPageWithFts(db, { ...filters, ftsQuery });
        if (page.total > 0) {
          return page;
        }
      } catch {
        // Keep search usable even if the SQLite FTS parser rejects a query.
      }
    }
  }
  return listArtifactsPageWithSql(db, filters);
}

// Hard cap on embedding rows read per semantic/hybrid query, independent of
// pagination. Without this, a store with many embedded artifacts would force
// every matching vector to be decoded and scored on every search request.
function embeddingsMaxCandidates() {
  const raw = Number(process.env.ARTIFACTY_EMBEDDINGS_MAX_CANDIDATES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20000;
}

// Selects only artifact_id/version/vector rows (plus the summary columns
// needed to build a result row) for candidates that match both the same
// non-text filters as listArtifactsPage (tag, visibility, owner, etc. via
// artifactWhereClauses) and the requested provider/model — filtered in SQL
// rather than decoded-then-discarded in JS — and capped at
// embeddingsMaxCandidates() rows.
function candidateEmbeddingRows(db, filters, provider, maxCandidates) {
  const { clauses, params } = artifactWhereClauses(filters, "a");
  const allClauses = [...clauses, "e.provider = ?", "e.model = ?"];
  const allParams = [...params, provider.name, provider.model, maxCandidates];
  return db.prepare(`
    SELECT ${artifactColumns("a.")}, e.vector
    FROM artifact_embeddings e
    JOIN artifacts a ON a.id = e.artifact_id
    WHERE ${allClauses.join(" AND ")}
    LIMIT ?
  `).all(...allParams);
}

async function semanticRanking(db, filters, provider) {
  const maxCandidates = embeddingsMaxCandidates();
  const rows = candidateEmbeddingRows(db, filters, provider, maxCandidates);
  const candidatesTruncated = rows.length >= maxCandidates;
  const rowById = new Map();
  const [queryVector] = await provider.embed([filters.query]);
  const scored = [];
  // Iterate once: decode each vector only as it's scored, and stash the row
  // (for the eventual summary) without pre-building a full separate map of
  // every candidate's vector up front.
  for (const row of rows) {
    rowById.set(row.id, row);
    if (queryVector) {
      const vector = blobToVector(row.vector);
      scored.push({ id: row.id, score: cosineSimilarity(queryVector, vector) });
    }
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { rowById, scored, candidatesTruncated };
}

async function listArtifactsPageSemantic(db, filters, provider) {
  const { rowById, scored, candidatesTruncated } = await semanticRanking(db, filters, provider);
  return pageFromScored(db, scored, rowById, filters.limit, filters.offset, "semantic", candidatesTruncated);
}

async function listArtifactsPageHybrid(db, filters, provider) {
  const keywordFilters = { ...filters, rawQuery: filters.query, query: filters.query.toLowerCase(), limit: 500, offset: 0 };
  const keywordPage = listArtifactsPageKeyword(db, keywordFilters);
  const keywordIds = keywordPage.artifacts.map((artifact) => artifact.id);

  const { rowById, scored, candidatesTruncated } = await semanticRanking(db, filters, provider);
  const semanticIds = scored.map((entry) => entry.id);

  // rowById is scoped to the semantic candidate set (built from the same
  // non-text filters); keyword results that satisfy those same filters are
  // guaranteed to already be present in it.
  const fused = reciprocalRankFusion([keywordIds, semanticIds]);
  return pageFromScored(db, fused, rowById, filters.limit, filters.offset, "hybrid", candidatesTruncated);
}

function pageFromScored(db, scored, rowById, limit, offset, backend, candidatesTruncated = false) {
  const total = scored.length;
  const paged = scored.slice(offset, offset + limit);
  const artifacts = paged
    .map(({ id, score }) => {
      const row = rowById.get(id);
      if (!row) {
        return null;
      }
      return { ...toArtifactSummary(artifactFromRow(db, row)), searchScore: score };
    })
    .filter(Boolean);
  return pagedResult({ artifacts, total, limit, offset, searchBackend: backend, candidatesTruncated });
}

// Validates and normalizes an ISO date filter value (createdAfter/createdBefore).
// Throws a 400 error with code "invalid_filter" when the value cannot be parsed.
function parseFilterDate(value, fieldName) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) {
    throw Object.assign(new Error(`Invalid ${fieldName} filter: ${value}`), {
      code: "invalid_filter",
      statusCode: 400
    });
  }
  return new Date(timestamp).toISOString();
}

export async function rebuildSearchIndex(store = createStore()) {
  const db = openDatabase(store);
  try {
    if (!searchIndexAvailable(db)) {
      return {
        ok: false,
        fts5: false,
        indexed: 0,
        skipped: [],
        message: "SQLite FTS5 is unavailable; metadata search fallback remains active."
      };
    }

    return transaction(db, () => rebuildSearchIndexInDb(db, store));
  } finally {
    db.close();
  }
}

// Embeddings provider configuration (roadmap section 6). `undefined` means
// "not configured explicitly, auto-detect from the environment on every
// call"; `null` (set via setEmbeddingProvider(null) or resetEmbeddingProvider)
// means "no provider" without re-checking the environment.
let configuredEmbeddingProvider;

// Lets server/CLI/MCP entry points configure (or disable) the embedding
// provider once per process instead of re-reading environment variables on
// every search. Tests should call resetEmbeddingProvider() in a `finally`
// block to avoid leaking state across cases.
export function setEmbeddingProvider(provider) {
  configuredEmbeddingProvider = provider || null;
}

export function resetEmbeddingProvider() {
  configuredEmbeddingProvider = undefined;
}

function resolveEmbeddingProvider(explicit) {
  if (explicit !== undefined) {
    return explicit;
  }
  if (configuredEmbeddingProvider !== undefined) {
    return configuredEmbeddingProvider;
  }
  return createEmbeddingProvider(process.env);
}

function embeddingMaxChars() {
  const raw = Number(process.env.ARTIFACTY_EMBEDDINGS_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8000;
}

// Schedules non-blocking embedding indexing after create/update so writes
// never wait on a network call or a spawned command. Failures are logged to
// stderr (never thrown) and picked up later by `artifacty index rebuild
// --embeddings`.
// Jobs scheduled by scheduleEmbeddingIndexing that have not yet settled.
// Tracked so tests can await completion deterministically instead of
// sleeping a fixed duration and hoping the setImmediate callback (which can
// fire after the test that scheduled it has already torn its store down)
// has run by then.
const inFlightEmbeddingIndexing = new Set();

// Test/diagnostic helper: resolves once every embedding-indexing job
// scheduled so far via scheduleEmbeddingIndexing has settled (including any
// scheduled while this call was already waiting).
export async function awaitEmbeddingIndexing() {
  while (inFlightEmbeddingIndexing.size > 0) {
    await Promise.allSettled([...inFlightEmbeddingIndexing]);
  }
}

function scheduleEmbeddingIndexing(store, artifact, version, content) {
  const provider = resolveEmbeddingProvider();
  if (!provider || !artifact || !version) {
    return;
  }
  // The tracking placeholder is added to inFlightEmbeddingIndexing
  // synchronously, before this function returns, not inside the
  // setImmediate callback below: a caller that awaits
  // awaitEmbeddingIndexing() immediately after create/updateArtifact (as
  // tests do) must see this job as in-flight even though the setImmediate
  // hop that actually starts it hasn't fired yet.
  let markDone;
  const tracked = new Promise((resolve) => {
    markDone = resolve;
  });
  inFlightEmbeddingIndexing.add(tracked);

  const run = () => {
    indexArtifactEmbedding(store, artifact, version, content, provider)
      .catch((error) => {
        process.stderr.write(`[artifacty] embedding index failed for ${artifact.id}: ${error.message}\n`);
      })
      .finally(() => {
        inFlightEmbeddingIndexing.delete(tracked);
        markDone();
      });
  };
  // ARTIFACTY_EMBEDDINGS_SYNC is an escape hatch for tests: it still doesn't
  // block the caller (create/updateArtifact isn't awaited on this), but it
  // skips the setImmediate hop so the job starts immediately and, combined
  // with awaitEmbeddingIndexing(), is deterministically awaitable instead
  // of requiring a fixed sleep.
  if (process.env.ARTIFACTY_EMBEDDINGS_SYNC === "true") {
    run();
    return;
  }
  setImmediate(run);
}

async function indexArtifactEmbedding(store, artifact, version, content, provider) {
  const text = embeddingTextForArtifact(
    { title: artifact.title, tags: artifact.tags, metadata: version.metadata, format: version.format },
    content,
    embeddingMaxChars()
  );
  if (!text) {
    return;
  }
  const [vector] = await provider.embed([text]);
  if (!vector || !vector.length) {
    return;
  }
  await upsertArtifactEmbedding(store, {
    artifactId: artifact.id,
    version: version.version,
    provider: provider.name,
    model: provider.model,
    vector
  });
}

export async function upsertArtifactEmbedding(store = createStore(), { artifactId, version, provider, model, vector } = {}) {
  if (!artifactId || !provider || !model || !vector) {
    throw new Error("upsertArtifactEmbedding requires artifactId, provider, model, and vector");
  }
  const db = openDatabase(store);
  try {
    upsertArtifactEmbeddingInDb(db, { artifactId, version, provider, model, vector });
    return { ok: true };
  } finally {
    db.close();
  }
}

function upsertArtifactEmbeddingInDb(db, { artifactId, version, provider, model, vector }) {
  const blob = vectorToBlob(vector);
  db.prepare(`
    INSERT INTO artifact_embeddings (artifact_id, version, provider, model, dimensions, vector, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(artifact_id, provider, model) DO UPDATE SET
      version = excluded.version,
      dimensions = excluded.dimensions,
      vector = excluded.vector,
      created_at = excluded.created_at
  `).run(artifactId, version, provider, model, vector.length, blob, new Date().toISOString());
}

// Lists stored embedding vectors for a provider/model, applying the same
// visibility predicate as listArtifactsPage (archived and access-restricted
// artifacts are excluded) so callers never see vectors for artifacts the
// caller cannot read.
export async function listArtifactEmbeddings(store = createStore(), { provider, model, access } = {}) {
  const db = openDatabase(store);
  try {
    const bypassVisibility = !access || isSingleUserMode(db);
    const params = [provider, model];
    let sql = `
      SELECT e.artifact_id, e.version, e.vector
      FROM artifact_embeddings e
      JOIN artifacts a ON a.id = e.artifact_id
      WHERE e.provider = ? AND e.model = ? AND a.archived_at IS NULL
    `;
    if (!bypassVisibility) {
      const clause = visibilityClause("a.", access);
      sql += ` AND ${clause.sql}`;
      params.push(...clause.params);
    }
    const rows = db.prepare(sql).all(...params);
    return rows.map((row) => ({
      artifactId: row.artifact_id,
      version: row.version,
      vector: blobToVector(row.vector)
    }));
  } finally {
    db.close();
  }
}

export async function deleteArtifactEmbeddings(store = createStore(), artifactId) {
  const db = openDatabase(store);
  try {
    const result = db.prepare("DELETE FROM artifact_embeddings WHERE artifact_id = ?").run(artifactId);
    return { ok: true, deleted: result.changes };
  } finally {
    db.close();
  }
}

// Re-embeds every non-archived artifact's latest version, batching provider
// calls (default 16 texts per call) so large stores don't issue one request
// per artifact. Used by `artifacty index rebuild --embeddings`.
export async function rebuildEmbeddingIndex(store = createStore(), options = {}) {
  const provider = resolveEmbeddingProvider(options.embeddingProvider);
  if (!provider) {
    return {
      ok: false,
      configured: false,
      indexed: 0,
      skipped: [],
      message: "No embedding provider is configured (set ARTIFACTY_EMBEDDINGS_URL or ARTIFACTY_EMBEDDINGS_COMMAND)."
    };
  }
  const db = openDatabase(store);
  const batchSize = clampInteger(options.batchSize, 1, 64, 16);
  const maxChars = embeddingMaxChars();
  try {
    const skipped = [];
    const jobs = [];
    for (const artifact of loadArtifacts(db)) {
      if (artifact.archivedAt) {
        continue;
      }
      const latest = artifact.versions.find((version) => version.version === artifact.latestVersion);
      if (!latest) {
        skipped.push({ artifactId: artifact.id, reason: "latest version row missing" });
        continue;
      }
      const absolutePath = path.join(store.home, latest.path);
      if (!existsSync(absolutePath)) {
        skipped.push({ artifactId: artifact.id, version: latest.version, reason: "version file missing" });
        continue;
      }
      const isBinary = latest.format === "image" || latest.format === "video";
      const content = isBinary ? "" : readFileSync(absolutePath, "utf8");
      const text = embeddingTextForArtifact(
        { title: artifact.title, tags: artifact.tags, metadata: latest.metadata, format: latest.format },
        content,
        maxChars
      );
      if (!text) {
        skipped.push({ artifactId: artifact.id, version: latest.version, reason: "no embeddable text" });
        continue;
      }
      jobs.push({ artifact, version: latest, text });
    }

    let indexed = 0;
    for (let start = 0; start < jobs.length; start += batchSize) {
      const batch = jobs.slice(start, start + batchSize);
      const vectors = await provider.embed(batch.map((job) => job.text));
      batch.forEach((job, index) => {
        const vector = vectors[index];
        if (!vector || !vector.length) {
          skipped.push({ artifactId: job.artifact.id, version: job.version.version, reason: "provider returned no vector" });
          return;
        }
        upsertArtifactEmbeddingInDb(db, {
          artifactId: job.artifact.id,
          version: job.version.version,
          provider: provider.name,
          model: provider.model,
          vector
        });
        indexed += 1;
      });
    }

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_index_built_at', ?)").run(new Date().toISOString());

    return {
      ok: skipped.length === 0,
      configured: true,
      provider: provider.name,
      model: provider.model,
      indexed,
      skipped
    };
  } finally {
    db.close();
  }
}

export async function checkStoreIntegrity(store = createStore()) {
  const db = openDatabase(store);
  const checkedAt = new Date().toISOString();
  try {
    const artifacts = loadArtifacts(db);
    const referencedPaths = new Set();
    const missingFiles = [];
    const hashMismatches = [];
    const sizeMismatches = [];
    const dbInconsistencies = [];
    let totalBytes = 0;
    let versionCount = 0;

    for (const artifact of artifacts) {
      if (!artifact.versions.length) {
        dbInconsistencies.push({
          artifactId: artifact.id,
          issue: "artifact has no version rows"
        });
      }
      if (!artifact.versions.some((version) => version.version === artifact.latestVersion)) {
        dbInconsistencies.push({
          artifactId: artifact.id,
          issue: `latest version ${artifact.latestVersion} has no version row`
        });
      }

      for (const version of artifact.versions) {
        versionCount += 1;
        const absolutePath = path.resolve(store.home, version.path);
        referencedPaths.add(absolutePath);
        if (!existsSync(absolutePath)) {
          missingFiles.push({
            artifactId: artifact.id,
            version: version.version,
            path: version.path
          });
          continue;
        }

        const content = readFileSync(absolutePath);
        const actualSize = content.byteLength;
        const actualSha256 = createHash("sha256").update(content).digest("hex");
        totalBytes += actualSize;

        if (actualSize !== version.sizeBytes) {
          sizeMismatches.push({
            artifactId: artifact.id,
            version: version.version,
            path: version.path,
            expected: version.sizeBytes,
            actual: actualSize
          });
        }
        if (actualSha256 !== version.sha256) {
          hashMismatches.push({
            artifactId: artifact.id,
            version: version.version,
            path: version.path,
            expected: version.sha256,
            actual: actualSha256
          });
        }
      }
    }

    const orphanFiles = listStoreFiles(store.artifactsDir)
      .filter((filePath) => !referencedPaths.has(filePath))
      .map((filePath) => {
        const stat = statSync(filePath);
        return {
          path: path.relative(store.home, filePath),
          sizeBytes: stat.size
        };
      });
    const orphanBytes = orphanFiles.reduce((sum, file) => sum + file.sizeBytes, 0);
    const ok =
      missingFiles.length === 0 &&
      hashMismatches.length === 0 &&
      sizeMismatches.length === 0 &&
      orphanFiles.length === 0 &&
      dbInconsistencies.length === 0;

    return {
      ok,
      checkedAt,
      store: store.home,
      artifactCount: artifacts.length,
      versionCount,
      totalBytes,
      orphanBytes,
      missingFiles,
      hashMismatches,
      sizeMismatches,
      orphanFiles,
      dbInconsistencies
    };
  } finally {
    db.close();
  }
}

function listArtifactsPageWithSql(db, filters) {
  const { clauses, params } = artifactWhereClauses(filters);
  if (filters.query) {
    const like = `%${escapeLike(filters.query)}%`;
    clauses.push(`(
      LOWER(id) LIKE ? ESCAPE '\\' OR
      LOWER(title) LIKE ? ESCAPE '\\' OR
      LOWER(source_agent) LIKE ? ESCAPE '\\' OR
      LOWER(COALESCE(publisher_id, '')) LIKE ? ESCAPE '\\' OR
      LOWER(COALESCE(publisher_name, '')) LIKE ? ESCAPE '\\' OR
      LOWER(tags_json) LIKE ? ESCAPE '\\'
    )`);
    params.push(like, like, like, like, like, like);
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS total FROM artifacts ${whereSql}`).get(...params).total;
  const rows = db.prepare(`
    SELECT ${artifactColumns()}
    FROM artifacts
    ${whereSql}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, filters.limit, filters.offset);

  return pagedResult({
    artifacts: rows.map((row) => toArtifactSummary(artifactFromRow(db, row))),
    total,
    limit: filters.limit,
    offset: filters.offset,
    searchBackend: filters.query ? "metadata" : "sqlite"
  });
}

function listArtifactsPageWithFts(db, filters) {
  const { clauses, params } = artifactWhereClauses(filters, "a");
  clauses.unshift("artifact_search MATCH ?");
  params.unshift(filters.ftsQuery);
  const whereSql = `WHERE ${clauses.join(" AND ")}`;
  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM artifact_search
    JOIN artifacts a ON a.id = artifact_search.artifact_id
    ${whereSql}
  `).get(...params).total;
  const rows = db.prepare(`
    SELECT
      ${artifactColumns("a.")},
      bm25(artifact_search) AS search_rank,
      snippet(artifact_search, -1, '', '', '...', 24) AS search_snippet
    FROM artifact_search
    JOIN artifacts a ON a.id = artifact_search.artifact_id
    ${whereSql}
    ORDER BY search_rank ASC, a.updated_at DESC, a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, filters.limit, filters.offset);

  return pagedResult({
    artifacts: rows.map((row) => ({
      ...toArtifactSummary(artifactFromRow(db, row)),
      searchScore: row.search_rank,
      searchSnippet: normalizeWhitespace(row.search_snippet)
    })),
    total,
    limit: filters.limit,
    offset: filters.offset,
    searchBackend: "fts5"
  });
}

function artifactWhereClauses(filters, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const clauses = [];
  const params = [];

  if (!filters.includeArchived) {
    clauses.push(`${prefix}archived_at IS NULL`);
  }
  if (filters.tag) {
    clauses.push(`LOWER(${prefix}tags_json) LIKE ? ESCAPE '\\'`);
    params.push(`%"${escapeLike(filters.tag)}"%`);
  }
  if (filters.sourceAgent) {
    clauses.push(`LOWER(${prefix}source_agent) = ?`);
    params.push(filters.sourceAgent);
  }
  if (filters.artifactType) {
    clauses.push(`LOWER(${prefix}artifact_type) = ?`);
    params.push(filters.artifactType);
  }
  if (filters.publisher) {
    clauses.push(`(${prefix}publisher_id = ? OR ${prefix}publisher_user_id = ? OR ${prefix}owner_user_id = ?)`);
    params.push(filters.publisher, filters.publisher, filters.publisher);
  }
  if (filters.createdAfter) {
    clauses.push(`${prefix}created_at >= ?`);
    params.push(filters.createdAfter);
  }
  if (filters.createdBefore) {
    clauses.push(`${prefix}created_at <= ?`);
    params.push(filters.createdBefore);
  }
  if (filters.reviewStatus) {
    clauses.push(`LOWER(COALESCE(${prefix}review_status, 'none')) = ?`);
    params.push(filters.reviewStatus);
  }
  if (filters.relatedTo) {
    const outerId = alias ? `${alias}.id` : "artifacts.id";
    if (filters.relation) {
      clauses.push(`EXISTS (
        SELECT 1 FROM artifact_relations r
        WHERE r.relation = ? AND (
          (r.from_id = ${outerId} AND r.to_id = ?) OR
          (r.to_id = ${outerId} AND r.from_id = ?)
        )
      )`);
      params.push(filters.relation, filters.relatedTo, filters.relatedTo);
    } else {
      clauses.push(`EXISTS (
        SELECT 1 FROM artifact_relations r
        WHERE (r.from_id = ${outerId} AND r.to_id = ?) OR
              (r.to_id = ${outerId} AND r.from_id = ?)
      )`);
      params.push(filters.relatedTo, filters.relatedTo);
    }
  }
  if (filters.access && !filters.bypassVisibility) {
    const clause = visibilityClause(prefix, filters.access);
    clauses.push(clause.sql);
    params.push(...clause.params);
  }
  if (filters.visibility) {
    clauses.push(`${prefix}visibility = ?`);
    params.push(filters.visibility);
  }
  if (filters.ownerUserId) {
    clauses.push(`${prefix}owner_user_id = ?`);
    params.push(filters.ownerUserId);
  }

  return { clauses, params };
}

function pagedResult({ artifacts, total, limit, offset, searchBackend, candidatesTruncated = false }) {
  return {
    artifacts,
    total,
    limit,
    offset,
    hasMore: offset + artifacts.length < total,
    nextOffset: offset + artifacts.length < total ? offset + limit : null,
    previousOffset: offset > 0 ? Math.max(0, offset - limit) : null,
    search: {
      backend: searchBackend,
      ...(candidatesTruncated ? { candidatesTruncated: true } : {})
    }
  };
}

// The full set of `artifacts` columns needed to build one artifact row
// (minus its versions, loaded separately). Shared by every SELECT that
// reads whole artifact rows so the column list is declared exactly once.
const ARTIFACT_COLUMN_NAMES = [
  "id", "title", "artifact_type", "schema_version", "source_agent",
  "publisher_id", "publisher_name", "publisher_user_id", "visibility",
  "owner_user_id", "tags_json", "created_at", "updated_at",
  "latest_version", "archived_at", "review_status"
];

function artifactColumns(prefix = "") {
  return ARTIFACT_COLUMN_NAMES.map((name) => `${prefix}${name}`).join(", ");
}

function artifactFromRow(db, row) {
  return {
    id: row.id,
    title: row.title,
    artifactType: row.artifact_type,
    schemaVersion: row.schema_version,
    sourceAgent: row.source_agent,
    publisherId: row.publisher_id || null,
    publisherName: row.publisher_name || null,
    publisherUserId: row.publisher_user_id || null,
    visibility: row.visibility || "team",
    ownerUserId: row.owner_user_id || null,
    reviewStatus: row.review_status || "none",
    tags: parseJson(row.tags_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    latestVersion: row.latest_version,
    versions: loadVersions(db, row.id)
  };
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function normalizeWhitespace(value) {
  return normalizeOptionalString(value).replace(/\s+/g, " ");
}

function publisherFromAudit(audit = {}) {
  const publisherId = normalizeOptionalString(audit.publisherId || audit.actor) || null;
  return {
    publisherId,
    publisherName: normalizeOptionalString(audit.publisherName || audit.userName) || null,
    publisherUserId: normalizeOptionalString(audit.publisherUserId || audit.userId) || null
  };
}

function toFtsQuery(value) {
  const tokens = normalizeOptionalString(value).match(/[\p{L}\p{N}_-]+/gu) || [];
  return tokens
    .slice(0, 12)
    .map((token) => `"${token.replaceAll("\"", "\"\"")}"`)
    .join(" AND ");
}

export async function getArtifact(store = createStore(), id, options = {}) {
  const db = openDatabase(store);
  try {
    const artifact = findArtifactById(db, id);
    assertArtifactReadable(db, artifact, options.access);
    const versionNumber = options.version ? Number(options.version) : artifact.latestVersion;
    const version = artifact.versions.find((item) => item.version === versionNumber);

    if (!version) {
      throw Object.assign(new Error(`Artifact version not found: ${id}@${versionNumber}`), {
        code: "ARTIFACT_VERSION_NOT_FOUND",
        statusCode: 404
      });
    }

    const content = await readFile(path.join(store.home, version.path), "utf8");
    insertAuditRecord(db, {
      action: "read",
      artifactId: id,
      version: version.version,
      sourceAgent: artifact.sourceAgent,
      audit: options.audit,
      metadata: { format: version.format }
    });
    return {
      ...artifact,
      version,
      content,
      relations: relationsForArtifact(db, id, { access: options.access })
    };
  } finally {
    db.close();
  }
}

export async function addRelation(store = createStore(), { fromId, toId, relation, audit, metadata, access } = {}) {
  assertValidRelation(relation);
  if (!fromId || !toId) {
    throw Object.assign(new Error("fromId and toId are required"), {
      code: "INVALID_RELATION",
      statusCode: 400
    });
  }
  if (fromId === toId) {
    throw Object.assign(new Error("An artifact cannot be related to itself"), {
      code: "SELF_RELATION",
      statusCode: 400
    });
  }

  const db = openDatabase(store);
  try {
    let relationRow;
    transaction(db, () => {
      const from = findArtifactById(db, fromId);
      const to = findArtifactById(db, toId);
      assertArtifactReadable(db, from, access);
      assertArtifactWritable(db, from, access);
      assertArtifactReadable(db, to, access);
      insertRelationRecord(db, from.id, to.id, relation, audit, metadata);
      insertAuditRecord(db, {
        action: "relation-add",
        artifactId: from.id,
        sourceAgent: from.sourceAgent,
        audit,
        metadata: { toId: to.id, relation },
        tags: from.tags,
        artifactType: from.artifactType
      });
      relationRow = db.prepare(`
        SELECT id, from_id, to_id, relation, created_at, created_by, metadata_json
        FROM artifact_relations
        WHERE from_id = ? AND to_id = ? AND relation = ?
      `).get(from.id, to.id, relation);
    });
    return relationFromRow(relationRow);
  } finally {
    db.close();
  }
}

export async function removeRelation(store = createStore(), { fromId, toId, relation, relationId, audit, access } = {}) {
  const db = openDatabase(store);
  try {
    let removedRow;
    transaction(db, () => {
      let row;
      if (relationId) {
        row = db.prepare(`SELECT * FROM artifact_relations WHERE id = ?`).get(relationId);
      } else {
        if (!fromId || !toId || !relation) {
          throw Object.assign(new Error("fromId, toId, and relation (or relationId) are required"), {
            code: "INVALID_RELATION",
            statusCode: 400
          });
        }
        assertValidRelation(relation);
        row = db.prepare(`
          SELECT * FROM artifact_relations WHERE from_id = ? AND to_id = ? AND relation = ?
        `).get(fromId, toId, relation);
      }

      if (!row) {
        throw Object.assign(new Error("Relation not found"), {
          code: "RELATION_NOT_FOUND",
          statusCode: 404
        });
      }

      const from = findArtifactById(db, row.from_id);
      assertArtifactReadable(db, from, access);
      assertArtifactWritable(db, from, access);

      db.prepare(`DELETE FROM artifact_relations WHERE id = ?`).run(row.id);
      insertAuditRecord(db, {
        action: "relation-remove",
        artifactId: row.from_id,
        audit,
        metadata: { toId: row.to_id, relation: row.relation }
      });
      removedRow = row;
    });
    return relationFromRow(removedRow);
  } finally {
    db.close();
  }
}

export async function listRelations(store = createStore(), id, options = {}) {
  const db = openDatabase(store);
  try {
    const artifact = findArtifactById(db, id);
    assertArtifactReadable(db, artifact, options.access);
    return relationsForArtifact(db, id, options);
  } finally {
    db.close();
  }
}

// --- Comments and review threads (roadmap section 5) ---------------------

function maxCommentsPerArtifact() {
  const raw = Number(process.env.ARTIFACTY_MAX_COMMENTS_PER_ARTIFACT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000;
}

function maxSavedViewsPerUser() {
  const raw = Number(process.env.ARTIFACTY_MAX_SAVED_VIEWS_PER_USER);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
}

export async function addComment(store = createStore(), id, input = {}) {
  const body = normalizeCommentBody(input.body);
  const anchor = normalizeCommentAnchor(input.anchor);
  const db = openDatabase(store);
  try {
    let comment;
    transaction(db, () => {
      const artifact = findArtifactById(db, id);
      assertArtifactReadable(db, artifact, input.access);
      assertArtifactWritable(db, artifact, input.access);

      const commentCap = maxCommentsPerArtifact();
      const { count: existingComments } = db
        .prepare("SELECT COUNT(*) AS count FROM artifact_comments WHERE artifact_id = ?")
        .get(id);
      if (existingComments >= commentCap) {
        throw Object.assign(new Error(`Artifact already has the maximum of ${commentCap} comments`), {
          code: "limit_exceeded",
          statusCode: 409
        });
      }

      const versionNumber = input.version !== undefined && input.version !== null
        ? Number(input.version)
        : artifact.latestVersion;
      if (!artifact.versions.some((entry) => entry.version === versionNumber)) {
        throw Object.assign(new Error(`Artifact version not found: ${id}@${versionNumber}`), {
          code: "ARTIFACT_VERSION_NOT_FOUND",
          statusCode: 404
        });
      }

      let parentId = null;
      if (input.parentId) {
        const parentRow = db.prepare(`
          SELECT id, artifact_id, parent_id, deleted_at FROM artifact_comments WHERE id = ?
        `).get(input.parentId);
        if (!parentRow || parentRow.artifact_id !== id || parentRow.deleted_at) {
          throw Object.assign(new Error(`Parent comment not found: ${input.parentId}`), {
            code: "COMMENT_NOT_FOUND",
            statusCode: 404
          });
        }
        // Threads are one level deep: a reply must target a root comment,
        // never another reply.
        if (parentRow.parent_id) {
          throw Object.assign(new Error("Comment threads are one level deep; reply to the root comment instead"), {
            code: "THREAD_TOO_DEEP",
            statusCode: 400
          });
        }
        parentId = parentRow.id;
      }

      const publisher = publisherFromAudit(input.audit);
      const sourceAgent = normalizeOptionalString(input.sourceAgent) || normalizeOptionalString(input.audit?.surface) || null;
      const authorLabel = publisher.publisherName || publisher.publisherId || sourceAgent || "anonymous";
      const now = new Date().toISOString();

      comment = {
        id: randomUUID(),
        artifactId: id,
        version: versionNumber,
        parentId,
        authorUserId: publisher.publisherUserId || null,
        authorLabel,
        sourceAgent,
        body,
        anchor,
        status: "open",
        createdAt: now,
        resolvedAt: null,
        resolvedBy: null,
        deletedAt: null
      };
      insertCommentRecord(db, comment);
      insertAuditRecord(db, {
        action: "comment-add",
        artifactId: id,
        version: versionNumber,
        sourceAgent: artifact.sourceAgent,
        audit: input.audit,
        metadata: { commentId: comment.id, parentId, anchor: anchor || undefined },
        tags: artifact.tags,
        artifactType: artifact.artifactType
      });
    });
    return comment;
  } finally {
    db.close();
  }
}

export async function listComments(store = createStore(), id, options = {}) {
  const db = openDatabase(store);
  try {
    const artifact = findArtifactById(db, id);
    assertArtifactReadable(db, artifact, options.access);

    const clauses = ["artifact_id = ?"];
    const params = [id];
    if (options.version !== undefined && options.version !== null) {
      clauses.push("version = ?");
      params.push(Number(options.version));
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (!options.includeDeleted) {
      clauses.push("deleted_at IS NULL");
    } else if (!isSingleUserMode(db) && options.access && options.access.role !== "admin") {
      // includeDeleted only surfaces a soft-deleted comment's body to an
      // admin or to the comment's own author (they already know what they
      // wrote); for anyone else it is silently ignored, i.e. deleted
      // comments from other authors stay hidden exactly as if the flag had
      // not been passed. Matches the rest of this file's convention (see
      // canReadArtifactMeta et al.): with no users table at all, or no
      // access context passed in, there is no real access-control boundary
      // to enforce here.
      clauses.push("(deleted_at IS NULL OR author_user_id = ?)");
      params.push(options.access.userId || "\0no-user\0");
    }

    const rows = db.prepare(`
      SELECT * FROM artifact_comments
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC
    `).all(...params);
    return rows.map(commentFromRow);
  } finally {
    db.close();
  }
}

export async function resolveComment(store = createStore(), id, commentId, options = {}) {
  const db = openDatabase(store);
  try {
    let comment;
    transaction(db, () => {
      const artifact = findArtifactById(db, id);
      assertArtifactReadable(db, artifact, options.access);
      assertArtifactWritable(db, artifact, options.access);

      const row = db.prepare(`SELECT * FROM artifact_comments WHERE id = ? AND artifact_id = ?`).get(commentId, id);
      if (!row || row.deleted_at) {
        throw Object.assign(new Error(`Comment not found: ${commentId}`), {
          code: "COMMENT_NOT_FOUND",
          statusCode: 404
        });
      }

      const now = new Date().toISOString();
      const publisher = publisherFromAudit(options.audit);
      const resolvedBy = publisher.publisherName || publisher.publisherId || null;
      db.prepare(`
        UPDATE artifact_comments SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id = ?
      `).run(now, resolvedBy, commentId);
      insertAuditRecord(db, {
        action: "comment-resolve",
        artifactId: id,
        version: row.version,
        sourceAgent: artifact.sourceAgent,
        audit: options.audit,
        metadata: { commentId }
      });
      comment = commentFromRow({ ...row, status: "resolved", resolved_at: now, resolved_by: resolvedBy });
    });
    return comment;
  } finally {
    db.close();
  }
}

export async function deleteComment(store = createStore(), id, commentId, options = {}) {
  const db = openDatabase(store);
  try {
    let comment;
    transaction(db, () => {
      const artifact = findArtifactById(db, id);
      assertArtifactReadable(db, artifact, options.access);
      assertArtifactWritable(db, artifact, options.access);

      const row = db.prepare(`SELECT * FROM artifact_comments WHERE id = ? AND artifact_id = ?`).get(commentId, id);
      if (!row || row.deleted_at) {
        throw Object.assign(new Error(`Comment not found: ${commentId}`), {
          code: "COMMENT_NOT_FOUND",
          statusCode: 404
        });
      }

      const now = new Date().toISOString();
      db.prepare(`UPDATE artifact_comments SET deleted_at = ? WHERE id = ?`).run(now, commentId);
      // Soft-deleted: the row (and this audit record) stays for history,
      // but listComments hides it unless includeDeleted is passed.
      insertAuditRecord(db, {
        action: "comment-delete",
        artifactId: id,
        version: row.version,
        sourceAgent: artifact.sourceAgent,
        audit: options.audit,
        metadata: { commentId }
      });
      comment = commentFromRow({ ...row, deleted_at: now });
    });
    return comment;
  } finally {
    db.close();
  }
}

export async function setReviewStatus(store = createStore(), id, status, options = {}) {
  if (!REVIEW_STATUSES.includes(status)) {
    throw Object.assign(new Error(`Unsupported review status: ${status}`), {
      code: "INVALID_REVIEW_STATUS",
      statusCode: 400
    });
  }
  const db = openDatabase(store);
  try {
    let artifact;
    transaction(db, () => {
      artifact = findArtifactById(db, id);
      assertArtifactReadable(db, artifact, options.access);
      assertArtifactManageable(db, artifact, options.access);

      const now = new Date().toISOString();
      const previousStatus = artifact.reviewStatus || "none";
      db.prepare("UPDATE artifacts SET review_status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
      artifact.reviewStatus = status;
      artifact.updatedAt = now;
      insertAuditRecord(db, {
        action: "review-status-change",
        artifactId: id,
        version: artifact.latestVersion,
        sourceAgent: artifact.sourceAgent,
        audit: options.audit,
        metadata: { from: previousStatus, to: status },
        tags: artifact.tags,
        artifactType: artifact.artifactType
      });
    });
    return withLatestContent(store, artifact);
  } finally {
    db.close();
  }
}

function normalizeCommentBody(value) {
  const body = String(value ?? "").trim();
  if (!body) {
    throw Object.assign(new Error("Comment body is required"), {
      code: "INVALID_COMMENT",
      statusCode: 400
    });
  }
  if (Buffer.byteLength(body, "utf8") > MAX_COMMENT_BYTES) {
    throw Object.assign(new Error(`Comment exceeds ${MAX_COMMENT_BYTES} bytes`), {
      code: "COMMENT_TOO_LARGE",
      statusCode: 413
    });
  }
  return body;
}

// Anchors are format-specific hints for rendering ({ line }, { path }, or
// { row }) and are deliberately not validated against the artifact's actual
// content (roadmap section 5).
function normalizeCommentAnchor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return { ...value };
}

function insertCommentRecord(db, comment) {
  db.prepare(`
    INSERT INTO artifact_comments (
      id, artifact_id, version, parent_id, author_user_id, author_label, source_agent, body, anchor_json, status, created_at, resolved_at, resolved_by, deleted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    comment.id,
    comment.artifactId,
    comment.version,
    comment.parentId,
    comment.authorUserId,
    comment.authorLabel,
    comment.sourceAgent,
    comment.body,
    comment.anchor ? JSON.stringify(comment.anchor) : null,
    comment.status,
    comment.createdAt,
    comment.resolvedAt,
    comment.resolvedBy,
    comment.deletedAt
  );
}

function commentFromRow(row) {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    version: row.version,
    parentId: row.parent_id || null,
    authorUserId: row.author_user_id || null,
    authorLabel: row.author_label,
    sourceAgent: row.source_agent || null,
    body: row.body,
    anchor: parseJson(row.anchor_json, null),
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null,
    resolvedBy: row.resolved_by || null,
    deletedAt: row.deleted_at || null
  };
}

// `filters.action`, when given, restricts to that action (a string) or any
// of a set of actions (an array) — used e.g. by callers that only want the
// most recent "retention-sweep" row instead of scanning recent audit rows
// in JS.
export async function listAuditEvents(store = createStore(), filters = {}) {
  const db = openDatabase(store);
  try {
    const limit = clampInteger(filters.limit, 1, 500, 100);
    const bypassVisibility = !filters.access || isSingleUserMode(db);
    const baseVisibility = bypassVisibility ? { sql: "", params: [] } : visibilityClause("a.", filters.access);
    const visibilityClauseSql = bypassVisibility ? "" : `AND (a.id IS NULL OR ${baseVisibility.sql})`;
    const visibilityParams = bypassVisibility ? [] : baseVisibility.params;

    const actionClauses = [];
    const actionParams = [];
    const actions = Array.isArray(filters.action) ? filters.action.filter(Boolean) : (filters.action ? [filters.action] : []);
    if (actions.length > 0) {
      actionClauses.push(`audit_log.action IN (${actions.map(() => "?").join(", ")})`);
      actionParams.push(...actions);
    }

    if (filters.artifactId) {
      const clauses = ["audit_log.artifact_id = ?", ...actionClauses];
      return db.prepare(`
        SELECT audit_log.id, audit_log.created_at, audit_log.action, audit_log.artifact_id, audit_log.version,
               audit_log.source_agent, audit_log.actor, audit_log.surface, audit_log.metadata_json
        FROM audit_log
        LEFT JOIN artifacts a ON a.id = audit_log.artifact_id
        WHERE ${clauses.join(" AND ")}
        ${visibilityClauseSql}
        ORDER BY audit_log.created_at DESC
        LIMIT ?
      `).all(filters.artifactId, ...actionParams, ...visibilityParams, limit).map(auditFromRow);
    }

    const whereParts = [...actionClauses];
    if (!bypassVisibility) {
      whereParts.push(baseVisibility.sql.startsWith("(") ? `(a.id IS NULL OR ${baseVisibility.sql})` : baseVisibility.sql);
    }
    const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
    return db.prepare(`
      SELECT audit_log.id, audit_log.created_at, audit_log.action, audit_log.artifact_id, audit_log.version,
             audit_log.source_agent, audit_log.actor, audit_log.surface, audit_log.metadata_json
      FROM audit_log
      LEFT JOIN artifacts a ON a.id = audit_log.artifact_id
      ${whereSql}
      ORDER BY audit_log.created_at DESC
      LIMIT ?
    `).all(...actionParams, ...visibilityParams, limit).map(auditFromRow);
  } finally {
    db.close();
  }
}

/**
 * Replay events with seq > sinceSeq, oldest first, applying `filter`
 * ({ type, tag, artifactId, sourceAgent }) and `access` (private-artifact
 * visibility; falsy means an internal/trusted caller and skips the check),
 * capped at `limit`. Used by both the SSE Last-Event-ID replay and the
 * /api/events?since= JSON polling mode.
 *
 * The SQL fetch itself is bounded rather than reading the whole table: when
 * a `filter` or `access` is present (so an unknown number of rows will be
 * dropped after the fact) it over-fetches up to `limit * 4` rows before
 * filtering in JS; with neither, `limit` rows already satisfy the request.
 * This is a heuristic, not a guarantee — a very sparse match against a busy
 * table can still return fewer than `limit` results even though more exist
 * further down the seq order; callers that need exhaustive replay should
 * page using the returned `seq` of the last item.
 */
export async function listEventsSince(store = createStore(), sinceSeq = 0, filter = {}, limit = 200, access = null) {
  const db = openDatabase(store);
  try {
    const hasNarrowingFilter = Boolean(filter.type || filter.artifactId || filter.sourceAgent || filter.tag || access);
    const fetchLimit = hasNarrowingFilter ? limit * 4 : limit;
    const rows = db.prepare(`
      SELECT e.seq, e.id, e.created_at, e.type, e.artifact_id, e.payload_json,
             a.visibility AS live_visibility, a.owner_user_id AS live_owner_user_id
      FROM events e
      LEFT JOIN artifacts a ON a.id = e.artifact_id
      WHERE e.seq > ?
      ORDER BY e.seq ASC
      LIMIT ?
    `).all(Number(sinceSeq) || 0, fetchLimit);

    const matched = [];
    for (const row of rows) {
      const event = { ...parseJson(row.payload_json, {}), seq: row.seq };
      // Events carry a visibility/ownerUserId snapshot from the moment they
      // were written. Re-derive both from the live artifact row so a later
      // visibility change (e.g. setArtifactVisibility to private) is
      // reflected in replayed history (SSE Last-Event-ID replay, /api/events
      // ?since=, MCP subscriptions) instead of leaking through a stale
      // snapshot. Fall back to the frozen values when the artifact row no
      // longer exists (e.g. purged by retention).
      if (row.artifact_id && row.live_visibility !== null && row.live_visibility !== undefined) {
        event.visibility = row.live_visibility;
        event.ownerUserId = row.live_owner_user_id || null;
      }
      if (matchesFilter(event, filter) && eventVisibleTo(event, access)) {
        matched.push(event);
        if (matched.length >= limit) {
          break;
        }
      }
    }
    return matched;
  } finally {
    db.close();
  }
}

export async function latestEventSeq(store = createStore()) {
  const db = openDatabase(store);
  try {
    return db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get().seq;
  } finally {
    db.close();
  }
}

export async function createWebhook(store = createStore(), input = {}) {
  const url = normalizeOptionalString(input.url);
  assertPublicWebhookUrl(url);
  const eventTypes = Array.isArray(input.eventTypes) ? input.eventTypes.filter(Boolean) : [];
  for (const type of eventTypes) {
    if (!EVENT_TYPES.includes(type)) {
      throw Object.assign(new Error(`Unknown event type: ${type}`), { code: "INVALID_EVENT_TYPE", statusCode: 400 });
    }
  }
  const secret = generateOpaqueToken("whsec");
  const secretHash = hashToken(secret);
  const record = {
    id: randomUUID(),
    url,
    eventTypes,
    filter: input.filter || {},
    ownerUserId: input.ownerUserId || null,
    createdAt: new Date().toISOString()
  };
  const db = openDatabase(store);
  try {
    transaction(db, () => {
      db.prepare(`
        INSERT INTO webhooks (id, url, secret_hash, event_types_json, filter_json, owner_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(record.id, record.url, secretHash, JSON.stringify(eventTypes), JSON.stringify(record.filter), record.ownerUserId, record.createdAt);
      insertAuditRecord(db, {
        action: "webhook-create",
        artifactId: "",
        audit: input.audit,
        metadata: { webhookId: record.id, url: record.url }
      });
    });
    return { ...webhookFromRow(findWebhookRowById(db, record.id)), secret };
  } finally {
    db.close();
  }
}

export async function listWebhooks(store = createStore(), options = {}) {
  const db = openDatabase(store);
  try {
    const rows = db.prepare(`SELECT * FROM webhooks ORDER BY created_at DESC`).all();
    return rows
      .map(webhookFromRow)
      .filter((webhook) => (options.enabledOnly ? !webhook.disabledAt : true))
      .filter((webhook) => (options.ownerUserId ? webhook.ownerUserId === options.ownerUserId : true));
  } finally {
    db.close();
  }
}

export async function getWebhook(store = createStore(), id) {
  const db = openDatabase(store);
  try {
    const row = findWebhookRowById(db, id);
    if (!row) {
      throw Object.assign(new Error(`Webhook not found: ${id}`), { code: "WEBHOOK_NOT_FOUND", statusCode: 404 });
    }
    return webhookFromRow(row);
  } finally {
    db.close();
  }
}

export async function deleteWebhook(store = createStore(), id, options = {}) {
  const db = openDatabase(store);
  try {
    let removed;
    transaction(db, () => {
      const row = findWebhookRowById(db, id);
      if (!row) {
        throw Object.assign(new Error(`Webhook not found: ${id}`), { code: "WEBHOOK_NOT_FOUND", statusCode: 404 });
      }
      db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
      insertAuditRecord(db, {
        action: "webhook-delete",
        artifactId: "",
        audit: options.audit,
        metadata: { webhookId: id, url: row.url }
      });
      removed = webhookFromRow(row);
    });
    return removed;
  } finally {
    db.close();
  }
}

export async function recordWebhookDelivery(store = createStore(), id, { ok, status, disable = false } = {}) {
  const db = openDatabase(store);
  try {
    const now = new Date().toISOString();
    if (ok) {
      db.prepare(`
        UPDATE webhooks SET last_delivery_at = ?, last_status = ?, failure_count = 0 WHERE id = ?
      `).run(now, status || null, id);
    } else {
      db.prepare(`
        UPDATE webhooks
        SET last_delivery_at = ?, last_status = ?, failure_count = failure_count + 1, disabled_at = CASE WHEN ? THEN ? ELSE disabled_at END
        WHERE id = ?
      `).run(now, status || null, disable ? 1 : 0, now, id);
    }
    return webhookFromRow(findWebhookRowById(db, id));
  } finally {
    db.close();
  }
}

function assertValidSavedViewFilters(filters) {
  if (filters === null || filters === undefined) {
    return {};
  }
  if (typeof filters !== "object" || Array.isArray(filters)) {
    throw Object.assign(new Error("Saved view filters must be an object"), {
      code: "invalid_filter",
      statusCode: 400
    });
  }
  for (const key of Object.keys(filters)) {
    if (!SAVED_VIEW_FILTER_KEYS.includes(key)) {
      throw Object.assign(new Error(`Unsupported saved view filter: ${key}`), {
        code: "invalid_filter",
        statusCode: 400
      });
    }
  }
  return filters;
}

function savedViewFromRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    ownerUserId: row.owner_user_id || null,
    name: row.name,
    filters: parseJson(row.filters_json, {}),
    shared: Boolean(row.shared),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function findSavedViewRowById(db, id) {
  return db.prepare("SELECT * FROM saved_views WHERE id = ?").get(id);
}

export async function createSavedView(store = createStore(), { name, filters, shared, access, audit } = {}) {
  const trimmedName = normalizeOptionalString(name);
  if (!trimmedName) {
    throw Object.assign(new Error("Saved view name is required"), {
      code: "INVALID_SAVED_VIEW",
      statusCode: 400
    });
  }
  const normalizedFilters = assertValidSavedViewFilters(filters);
  const db = openDatabase(store);
  try {
    const ownerUserId = isSingleUserMode(db) ? null : (access?.userId || null);
    const viewCap = maxSavedViewsPerUser();
    const { count: existingViews } = ownerUserId
      ? db.prepare("SELECT COUNT(*) AS count FROM saved_views WHERE owner_user_id = ?").get(ownerUserId)
      : db.prepare("SELECT COUNT(*) AS count FROM saved_views WHERE owner_user_id IS NULL").get();
    if (existingViews >= viewCap) {
      throw Object.assign(new Error(`Already have the maximum of ${viewCap} saved views`), {
        code: "limit_exceeded",
        statusCode: 409
      });
    }
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      ownerUserId,
      name: trimmedName,
      filters: normalizedFilters,
      shared: Boolean(shared),
      createdAt: now,
      updatedAt: now
    };
    transaction(db, () => {
      db.prepare(`
        INSERT INTO saved_views (id, owner_user_id, name, filters_json, shared, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(record.id, record.ownerUserId, record.name, JSON.stringify(record.filters), record.shared ? 1 : 0, record.createdAt, record.updatedAt);
      insertAuditRecord(db, {
        action: "view-create",
        artifactId: "",
        audit,
        // audit_log rows with an empty artifactId aren't attached to an
        // artifact, so listAuditEvents' per-artifact visibility predicate
        // (LEFT JOIN artifacts -> a.id IS NULL) can't hide them from other
        // users the way listSavedViews hides private views. Omit the name
        // for a private (non-shared) view so /api/audit never leaks it to a
        // reader who couldn't otherwise see the view.
        metadata: { viewId: record.id, shared: record.shared, ...(record.shared ? { name: record.name } : {}) }
      });
    });
    return savedViewFromRow(findSavedViewRowById(db, record.id));
  } finally {
    db.close();
  }
}

// In single-user mode (no users table rows) views are global, matching
// pre-Section-10 visibility semantics. In team mode, a caller sees their own
// views plus any view another user marked shared.
export async function listSavedViews(store = createStore(), { access } = {}) {
  const db = openDatabase(store);
  try {
    const rows = db.prepare("SELECT * FROM saved_views ORDER BY name ASC").all();
    if (isSingleUserMode(db) || !access) {
      return rows.map(savedViewFromRow);
    }
    return rows
      .filter((row) => row.shared || row.owner_user_id === access.userId || access.role === "admin")
      .map(savedViewFromRow);
  } finally {
    db.close();
  }
}

export async function deleteSavedView(store = createStore(), id, { access, audit } = {}) {
  const db = openDatabase(store);
  try {
    let removed;
    transaction(db, () => {
      const row = findSavedViewRowById(db, id);
      if (!row) {
        throw Object.assign(new Error(`Saved view not found: ${id}`), {
          code: "SAVED_VIEW_NOT_FOUND",
          statusCode: 404
        });
      }
      if (!isSingleUserMode(db) && access && access.role !== "admin" && row.owner_user_id !== access.userId) {
        throw new ForbiddenError(`Not permitted to delete saved view: ${id}`);
      }
      db.prepare("DELETE FROM saved_views WHERE id = ?").run(id);
      insertAuditRecord(db, {
        action: "view-delete",
        artifactId: "",
        audit,
        // See the matching comment in createSavedView: omit the name for a
        // private (non-shared) view.
        metadata: { viewId: id, shared: Boolean(row.shared), ...(row.shared ? { name: row.name } : {}) }
      });
      removed = savedViewFromRow(row);
    });
    return removed;
  } finally {
    db.close();
  }
}

// Resolves a saved view by id or name for expansion into filters (e.g. a
// dashboard `?view=` link or the `artifacty_list` MCP tool's `view` arg).
// Ownership/sharing visibility is scoped directly into the WHERE clause
// (rather than picking a row by name first and visibility-checking it
// afterward) so another user's private view of the same name can never be
// selected in the first place, "shadowing" the caller's own view with a
// null (not-found) result.
export async function resolveSavedView(store = createStore(), nameOrId, { access } = {}) {
  const lookup = normalizeOptionalString(nameOrId);
  if (!lookup) {
    return null;
  }
  const db = openDatabase(store);
  try {
    const bypassVisibility = isSingleUserMode(db) || !access;
    const params = [lookup, lookup];
    let sql = "SELECT * FROM saved_views WHERE (id = ? OR LOWER(name) = LOWER(?))";
    if (!bypassVisibility) {
      sql += " AND (shared = 1 OR owner_user_id = ? OR ? = 1)";
      params.push(access.userId || "", access.role === "admin" ? 1 : 0);
    }
    sql += " ORDER BY (id = ?) DESC";
    params.push(lookup);
    if (!bypassVisibility) {
      sql += ", (owner_user_id = ?) DESC";
      params.push(access.userId || "");
    }
    sql += " LIMIT 1";
    const row = db.prepare(sql).get(...params);
    return row ? savedViewFromRow(row) : null;
  } finally {
    db.close();
  }
}

// Records a not-artifact-scoped security audit row (e.g. token-scope-denied,
// rate-limited). Callers throttle how often they call this themselves.
export async function insertSecurityAudit(store = createStore(), { action, actor, surface, metadata } = {}) {
  const db = openDatabase(store);
  try {
    transaction(db, () => {
      insertAuditRecord(db, {
        action,
        artifactId: "",
        audit: { actor, surface },
        metadata: metadata || {}
      });
    });
  } finally {
    db.close();
  }
}

export async function insertWebhookFailureAudit(store = createStore(), webhook, event, result) {
  const db = openDatabase(store);
  try {
    transaction(db, () => {
      insertAuditRecord(db, {
        action: "webhook-deliver-failed",
        artifactId: event?.artifactId || "",
        audit: { surface: "webhook" },
        metadata: { webhookId: webhook.id, url: webhook.url, eventType: event?.type, error: result?.error }
      });
    });
  } finally {
    db.close();
  }
}

function findWebhookRowById(db, id) {
  return db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id);
}

function webhookFromRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    url: row.url,
    secretHash: row.secret_hash,
    eventTypes: parseJson(row.event_types_json, []),
    filter: parseJson(row.filter_json, {}),
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    lastDeliveryAt: row.last_delivery_at,
    lastStatus: row.last_status,
    failureCount: row.failure_count
  };
}

export async function countUsers(store = createStore()) {
  const db = openDatabase(store);
  try {
    return db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  } finally {
    db.close();
  }
}

export async function createUser(store = createStore(), input = {}) {
  const db = openDatabase(store);
  try {
    return insertUser(db, input);
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) {
      throw Object.assign(new Error(`User already exists: ${normalizeEmail(input.email)}`), { statusCode: 409, code: "USER_EXISTS" });
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function importUsersFromCsv(store = createStore(), csv, options = {}) {
  const records = parseUserCsv(csv);
  const result = {
    created: [],
    skipped: [],
    failed: [],
    totalRows: records.length
  };
  const db = openDatabase(store);
  try {
    for (const record of records) {
      const email = normalizeEmail(record.email);
      if (!email) {
        result.failed.push({
          row: record.row,
          email: "",
          error: "User email is required",
          code: "USER_EMAIL_REQUIRED"
        });
        continue;
      }

      const providedPassword = normalizeOptionalString(record.password || record.temporary_password);
      const password = providedPassword || generateTemporaryPassword();
      const resetFromCsv = firstDefined(
        record.password_reset_required,
        record.require_password_reset,
        record.force_password_reset,
        record.reset_required
      );
      const passwordResetRequired = !providedPassword || (resetFromCsv === undefined
        ? options.passwordResetRequired !== false
        : parseBooleanOption(resetFromCsv));

      try {
        const user = insertUser(db, {
          email,
          name: record.name || email,
          role: record.role || "user",
          password,
          passwordResetRequired
        });
        result.created.push({
          user,
          passwordGenerated: !providedPassword,
          temporaryPassword: !providedPassword ? password : undefined
        });
      } catch (error) {
        if (error.code === "USER_EXISTS" || /UNIQUE/i.test(error.message)) {
          result.skipped.push({
            row: record.row,
            email,
            reason: "User already exists"
          });
          continue;
        }
        result.failed.push({
          row: record.row,
          email,
          error: error.message,
          code: error.code || "USER_IMPORT_FAILED"
        });
      }
    }
    return result;
  } finally {
    db.close();
  }
}

export async function listUsers(store = createStore()) {
  const db = openDatabase(store);
  try {
    return db.prepare(`
      SELECT id, email, name, role, active, password_reset_required, created_at, updated_at
      FROM users
      ORDER BY created_at ASC
    `).all().map(userFromRow);
  } finally {
    db.close();
  }
}

export async function setUserActive(store = createStore(), id, active) {
  const db = openDatabase(store);
  try {
    const now = new Date().toISOString();
    const result = db.prepare("UPDATE users SET active = ?, updated_at = ? WHERE id = ?").run(active ? 1 : 0, now, id);
    if (result.changes === 0) {
      throw Object.assign(new Error(`User not found: ${id}`), { statusCode: 404, code: "USER_NOT_FOUND" });
    }
    return userFromRow(db.prepare(`
      SELECT id, email, name, role, active, password_reset_required, created_at, updated_at FROM users WHERE id = ?
    `).get(id));
  } finally {
    db.close();
  }
}

export async function changeUserPassword(store = createStore(), userId, input = {}) {
  const password = String(input.password || input.newPassword || "");
  if (password.length < 8) {
    throw Object.assign(new Error("User password must be at least 8 characters"), { statusCode: 400, code: "USER_PASSWORD_WEAK" });
  }
  const db = openDatabase(store);
  try {
    const existing = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId);
    if (!existing) {
      throw Object.assign(new Error(`User not found: ${userId}`), { statusCode: 404, code: "USER_NOT_FOUND" });
    }
    if (input.currentPassword !== undefined && !verifyPassword(input.currentPassword, existing.password_hash)) {
      throw Object.assign(new Error("Current password is incorrect"), { statusCode: 400, code: "CURRENT_PASSWORD_INVALID" });
    }
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE users
      SET password_hash = ?, password_reset_required = ?, updated_at = ?
      WHERE id = ?
    `).run(hashPassword(password), input.passwordResetRequired ? 1 : 0, now, userId);
    return userFromRow(db.prepare(`
      SELECT id, email, name, role, active, password_reset_required, created_at, updated_at
      FROM users
      WHERE id = ?
    `).get(userId));
  } finally {
    db.close();
  }
}

export async function verifyUserPassword(store = createStore(), email, password) {
  const db = openDatabase(store);
  try {
    const row = db.prepare(`
      SELECT id, email, name, role, password_hash, active, password_reset_required, created_at, updated_at
      FROM users
      WHERE email = ?
    `).get(normalizeEmail(email));
    if (!row || !row.active || !verifyPassword(password, row.password_hash)) {
      return null;
    }
    return userFromRow(row);
  } finally {
    db.close();
  }
}

export async function createSession(store = createStore(), userId, options = {}) {
  const token = generateOpaqueToken("arts");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Number(options.ttlMs || 7 * 24 * 60 * 60 * 1000)).toISOString();
  const session = {
    id: randomUUID(),
    userId,
    createdAt: now.toISOString(),
    expiresAt
  };
  const db = openDatabase(store);
  try {
    db.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(session.id, userId, hashToken(token), session.createdAt, expiresAt);
    return { token, session };
  } finally {
    db.close();
  }
}

export async function getSessionUser(store = createStore(), token) {
  if (!token) {
    return null;
  }
  const db = openDatabase(store);
  try {
    const row = db.prepare(`
      SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.name, u.role, u.active, u.password_reset_required, u.created_at, u.updated_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL
    `).get(hashToken(token));
    if (!row || !row.active || Date.parse(row.expires_at) <= Date.now()) {
      return null;
    }
    return {
      ...userFromRow(row),
      sessionId: row.session_id
    };
  } finally {
    db.close();
  }
}

export async function revokeSession(store = createStore(), token) {
  if (!token) {
    return false;
  }
  const db = openDatabase(store);
  try {
    const result = db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), hashToken(token));
    return result.changes > 0;
  } finally {
    db.close();
  }
}

export async function createApiToken(store = createStore(), userId, input = {}) {
  const db = openDatabase(store);
  try {
    const owner = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
    const scopes = normalizeTokenScopes(input.scopes, { userRole: owner?.role || "user" });
    const token = generateOpaqueToken("arty");
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      userId,
      name: normalizeOptionalString(input.name) || "Artifacty token",
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
      scopes
    };
    db.prepare(`
      INSERT INTO api_tokens (id, user_id, name, token_hash, created_at, scopes_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.id, userId, record.name, hashToken(token), now, JSON.stringify(scopes));
    return { token, record };
  } finally {
    db.close();
  }
}

export async function listApiTokens(store = createStore(), userId) {
  const db = openDatabase(store);
  try {
    return db.prepare(`
      SELECT id, user_id, name, created_at, last_used_at, revoked_at, scopes_json
      FROM api_tokens
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(userId).map(apiTokenFromRow);
  } finally {
    db.close();
  }
}

export async function revokeApiToken(store = createStore(), tokenId, userId) {
  const db = openDatabase(store);
  try {
    const result = db.prepare(`
      UPDATE api_tokens
      SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), tokenId, userId);
    return result.changes > 0;
  } finally {
    db.close();
  }
}

export async function authenticateApiToken(store = createStore(), token) {
  if (!token) {
    return null;
  }
  const db = openDatabase(store);
  try {
    const tokenHash = hashToken(token);
    const row = db.prepare(`
      SELECT t.id AS token_id, t.name AS token_name, t.scopes_json AS token_scopes_json, u.id, u.email, u.name, u.role, u.active, u.password_reset_required, u.created_at, u.updated_at
      FROM api_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL
    `).get(tokenHash);
    if (!row || !row.active) {
      return null;
    }
    db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), row.token_id);
    return {
      type: "api-token",
      actor: row.email,
      tokenId: row.token_id,
      tokenName: row.token_name,
      scopes: row.token_scopes_json ? parseJson(row.token_scopes_json, ["read", "write"]) : ["read", "write"],
      user: userFromRow(row)
    };
  } finally {
    db.close();
  }
}

// Non-artifact tables carried by a "full" scope backup bundle (roadmap
// section 13). Sessions are deliberately excluded: they are short-lived and
// never exported. Row shape is generic (SELECT *, camelCased) so newly added
// columns (e.g. artifacts.visibility, api_tokens.scopes_json) are carried
// automatically without touching this code.
const FULL_BACKUP_CORE_TABLES = {
  users: "users",
  apiTokens: "api_tokens",
  auditLog: "audit_log",
  relations: "artifact_relations",
  webhooks: "webhooks",
  comments: "artifact_comments"
};

export async function exportFullStoreTables(store = createStore()) {
  const db = openDatabase(store);
  try {
    const tables = {};
    for (const [key, table] of Object.entries(FULL_BACKUP_CORE_TABLES)) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all().map(rowToCamelCase);
      tables[key] = key === "webhooks" ? rows.map(withoutWebhookSecret) : rows;
    }
    if (tableExistsInDb(db, "saved_views")) {
      tables.savedViews = db.prepare(`SELECT * FROM saved_views`).all().map(rowToCamelCase);
    }
    // artifact_embeddings carries a BLOB vector column that JSON can't
    // represent directly; base64-encode it explicitly rather than routing
    // through the generic rowToCamelCase path (which would leave a raw
    // Buffer/Uint8Array that JSON.stringify mangles into a numeric-keyed
    // object).
    if (tableExistsInDb(db, "artifact_embeddings")) {
      tables.embeddings = db.prepare(`
        SELECT artifact_id, version, provider, model, dimensions, vector, created_at
        FROM artifact_embeddings
      `).all().map((row) => ({
        artifactId: row.artifact_id,
        version: row.version,
        provider: row.provider,
        model: row.model,
        dimensions: row.dimensions,
        vector: Buffer.from(row.vector).toString("base64"),
        createdAt: row.created_at
      }));
    }
    tables.meta = db.prepare(`SELECT * FROM meta WHERE key != 'store_version'`).all().map(rowToCamelCase);
    return tables;
  } finally {
    db.close();
  }
}

function replaceEmbeddingRows(db, rows) {
  db.prepare("DELETE FROM artifact_embeddings").run();
  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }
  const insert = db.prepare(`
    INSERT INTO artifact_embeddings (artifact_id, version, provider, model, dimensions, vector, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object" || !row.artifactId || !row.provider || !row.model || typeof row.vector !== "string") {
      continue;
    }
    let blob;
    try {
      blob = Buffer.from(row.vector, "base64");
    } catch {
      continue;
    }
    if (blob.byteLength === 0) {
      continue;
    }
    try {
      insert.run(
        row.artifactId,
        Number.isFinite(Number(row.version)) ? Number(row.version) : null,
        row.provider,
        row.model,
        Number.isFinite(Number(row.dimensions)) ? Number(row.dimensions) : Math.floor(blob.byteLength / 8),
        blob,
        row.createdAt || new Date().toISOString()
      );
      count += 1;
    } catch {
      // A FOREIGN KEY failure (embedding for an artifact id not present in
      // this restore) or any other constraint violation just skips the row
      // rather than aborting the whole full-scope restore.
    }
  }
  return count;
}

export async function importFullStoreTables(store = createStore(), tables = {}, { forceUsers = false } = {}) {
  const db = openDatabase(store);
  try {
    let counts;
    transaction(db, () => {
      const existingUsers = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
      if (existingUsers > 0 && !forceUsers) {
        throw Object.assign(new Error("Target store already has users; pass forceUsers to overwrite them"), {
          statusCode: 409,
          code: "users_exist"
        });
      }

      // Sessions are never part of a backup bundle; invalidate whatever
      // sessions the target had (they would otherwise dangle once users are
      // replaced) rather than trying to reconcile them.
      db.prepare("DELETE FROM sessions").run();

      counts = {
        users: replaceTableRows(db, "users", tables.users),
        apiTokens: replaceTableRows(db, "api_tokens", tables.apiTokens),
        relations: replaceTableRows(db, "artifact_relations", tables.relations),
        webhooks: replaceWebhookRows(db, tables.webhooks),
        comments: replaceTableRows(db, "artifact_comments", tables.comments),
        auditLog: replaceTableRows(db, "audit_log", tables.auditLog)
      };
      if (tableExistsInDb(db, "saved_views") && Array.isArray(tables.savedViews)) {
        counts.savedViews = replaceTableRows(db, "saved_views", tables.savedViews);
      }
      if (Array.isArray(tables.embeddings)) {
        counts.embeddings = replaceEmbeddingRows(db, tables.embeddings);
      }
      counts.meta = replaceMetaRows(db, tables.meta);

      insertAuditRecord(db, {
        action: "backup-import",
        artifactId: "",
        metadata: { scope: "full", counts }
      });
    });
    return counts;
  } finally {
    db.close();
  }
}

export function tableExistsInDb(db, table) {
  return Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

function snakeToCamel(value) {
  return value.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function rowToCamelCase(row) {
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    result[snakeToCamel(key)] = value;
  }
  return result;
}

function withoutWebhookSecret(webhook) {
  const { secretHash, ...rest } = webhook;
  return { ...rest, secretMissing: true };
}

// Inserts `rows` (camelCase keys, generic backup shape) into `table` using
// its *current* column set, so a bundle exported before a schema change
// still imports and new columns picked up from a later migration are
// populated automatically. Shared by replaceTableRows (which deletes first)
// and replaceWebhookRows (which pre-processes rows but never deletes here —
// its caller already did).
function insertRowsIntoTable(db, table, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }
  const columns = tableColumns(db, table);
  const insert = db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
  let count = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const values = columns.map((column) => {
      const camelKey = snakeToCamel(column);
      const value = row[camelKey] !== undefined ? row[camelKey] : row[column];
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      return value === undefined ? null : value;
    });
    insert.run(...values);
    count += 1;
  }
  return count;
}

// Deletes every row in `table`, then re-inserts `rows` via insertRowsIntoTable.
function replaceTableRows(db, table, rows) {
  db.prepare(`DELETE FROM ${table}`).run();
  return insertRowsIntoTable(db, table, rows);
}

// Webhooks never carry a usable secret across a backup (the raw secret is
// shown once and only its hash is stored; that hash is stripped on export).
// Re-issue a random placeholder hash so the NOT NULL column is satisfied and
// force the webhook disabled so it cannot sign deliveries with a hash the
// original secret holder doesn't have.
function replaceWebhookRows(db, rows) {
  db.prepare("DELETE FROM webhooks").run();
  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }
  const now = new Date().toISOString();
  const prepared = rows.map((row) => ({
    ...row,
    secretHash: row.secretHash || hashToken(generateOpaqueToken("whsec")),
    disabledAt: row.disabledAt || now
  }));
  return insertRowsIntoTable(db, "webhooks", prepared);
}

// Policy meta keys carried by a full backup (anything but store_version,
// which each store computes for itself). Upserted rather than replaced
// wholesale so unrelated operational meta keys (search index bookkeeping,
// etc.) that are not part of the bundle are left alone.
function replaceMetaRows(db, rows) {
  if (!Array.isArray(rows)) {
    return 0;
  }
  const upsert = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  let count = 0;
  for (const row of rows) {
    if (!row || !row.key || row.key === "store_version") {
      continue;
    }
    upsert.run(row.key, row.value);
    count += 1;
  }
  return count;
}

// Not exported: only used internally by withLatestContent. Kept as a plain
// function (previously an unused export) rather than removed outright since
// its defense-in-depth access re-check is still exercised on every read.
async function readArtifactVersion(store, artifact, versionNumber, options = {}) {
  const version = artifact.versions.find((item) => item.version === versionNumber);
  if (!version) {
    throw Object.assign(new Error(`Artifact version not found: ${artifact.id}@${versionNumber}`), {
      code: "ARTIFACT_VERSION_NOT_FOUND",
      statusCode: 404
    });
  }
  // Defense in depth only: callers are expected to have already resolved the
  // artifact through getArtifact()/access-checked helpers, which know
  // whether the store is running in single-user mode.
  if (options.access && (artifact.visibility || "team") === "private" && !isOwnerOrAdmin(options.access, artifact.ownerUserId)) {
    throw Object.assign(new Error(`Artifact not found: ${artifact.id}`), {
      code: "ARTIFACT_NOT_FOUND",
      statusCode: 404
    });
  }

  return {
    version,
    content: await readFile(path.join(store.home, version.path), "utf8")
  };
}

export function toArtifactSummary(artifact) {
  const latest = artifact.versions.find((version) => version.version === artifact.latestVersion);
  return {
    id: artifact.id,
    title: artifact.title,
    artifactType: artifact.artifactType,
    schemaVersion: artifact.schemaVersion,
    sourceAgent: artifact.sourceAgent,
    publisherId: artifact.publisherId || null,
    publisherName: artifact.publisherName || null,
    publisherUserId: artifact.publisherUserId || null,
    visibility: artifact.visibility || "team",
    ownerUserId: artifact.ownerUserId || null,
    reviewStatus: artifact.reviewStatus || "none",
    tags: artifact.tags,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    archivedAt: artifact.archivedAt,
    latestVersion: artifact.latestVersion,
    etag: artifactEtag(artifact),
    versionCount: artifact.versions.length,
    format: latest?.format,
    contentType: latest?.contentType,
    sizeBytes: latest?.sizeBytes
  };
}

export function normalizeFormat(value = "text") {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "md") {
    return "markdown";
  }
  if (normalized === "svg+xml") {
    return "svg";
  }
  if (normalized === "mmd") {
    return "mermaid";
  }
  if (normalized === "jsx" || normalized === "tsx") {
    return "react";
  }
  if (normalized === "sarif+json") {
    return "sarif";
  }
  if (normalized === "ipynb" || normalized === "x-ipynb+json") {
    return "notebook";
  }
  if (ARTIFACT_FORMATS.includes(normalized)) {
    return normalized;
  }
  throw Object.assign(new Error(`Unsupported artifact format: ${value}`), {
    code: "INVALID_FORMAT",
    statusCode: 400
  });
}

export function contentTypeForFormat(format) {
  return FORMAT_TO_CONTENT_TYPE[normalizeFormat(format)];
}

export function extensionForFormat(format) {
  return FORMAT_TO_EXTENSION[normalizeFormat(format)];
}

export function normalizeArtifactType(value = "document") {
  const normalized = normalizeOptionalString(value).toLowerCase();
  if (!normalized) {
    return "document";
  }
  if (ARTIFACT_TYPES.includes(normalized)) {
    return normalized;
  }
  throw Object.assign(new Error(`Unsupported artifact type: ${value}`), {
    code: "INVALID_ARTIFACT_TYPE",
    statusCode: 400
  });
}

// Exported so other modules that need direct table access not covered by
// this file's own exported functions (currently retention.js) share the
// same connection setup (PRAGMAs, schema init/migration) instead of opening
// a second, differently-configured DatabaseSync against the same file.
export function openDatabase(store) {
  mkdirSync(store.home, { recursive: true });
  mkdirSync(store.artifactsDir, { recursive: true });

  const db = new DatabaseSync(store.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  initializeSchema(db);
  migrateJsonIndex(db, store);
  normalizeStoredSourceAgents(db, store);
  syncSearchIndexIfEmpty(db, store);
  return db;
}

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artifact_type TEXT NOT NULL DEFAULT 'document',
      schema_version INTEGER NOT NULL DEFAULT 1,
      source_agent TEXT NOT NULL,
      publisher_id TEXT,
      publisher_name TEXT,
      publisher_user_id TEXT,
      tags_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      latest_version INTEGER NOT NULL,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS artifact_versions (
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      format TEXT NOT NULL,
      content_type TEXT NOT NULL,
      path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      PRIMARY KEY (artifact_id, version),
      FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      action TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      version INTEGER,
      source_agent TEXT,
      actor TEXT,
      surface TEXT,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      password_reset_required INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS artifact_relations (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE (from_id, to_id, relation),
      FOREIGN KEY (from_id) REFERENCES artifacts(id) ON DELETE CASCADE,
      FOREIGN KEY (to_id) REFERENCES artifacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      type TEXT NOT NULL,
      artifact_id TEXT,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      event_types_json TEXT NOT NULL,
      filter_json TEXT NOT NULL DEFAULT '{}',
      owner_user_id TEXT,
      created_at TEXT NOT NULL,
      disabled_at TEXT,
      last_delivery_at TEXT,
      last_status INTEGER,
      failure_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS saved_views (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT,
      name TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      shared INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifact_comments (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      parent_id TEXT,
      author_user_id TEXT,
      author_label TEXT NOT NULL,
      source_agent TEXT,
      body TEXT NOT NULL,
      anchor_json TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      deleted_at TEXT,
      FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS artifact_embeddings (
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (artifact_id, provider, model),
      FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_updated_at ON artifacts(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_source_agent ON artifacts(source_agent);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_artifact_id ON audit_log(artifact_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_relations_from ON artifact_relations(from_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to ON artifact_relations(to_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_artifact_id ON events(artifact_id);
    CREATE INDEX IF NOT EXISTS idx_saved_views_owner_user_id ON saved_views(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_comments_artifact ON artifact_comments(artifact_id, version);
    CREATE INDEX IF NOT EXISTS idx_embeddings_provider_model ON artifact_embeddings(provider, model);
  `);
  const storedVersionRow = db.prepare("SELECT value FROM meta WHERE key = 'store_version'").get();
  if (storedVersionRow) {
    const storedVersion = Number(storedVersionRow.value);
    if (Number.isFinite(storedVersion) && storedVersion > STORE_VERSION) {
      throw new Error(
        `Artifacty store was written by a newer version (store_version ${storedVersion}) than this build supports ` +
        `(STORE_VERSION ${STORE_VERSION}). Upgrade artifacty before opening this store.`
      );
    }
  }
  ensureColumn(db, "artifacts", "artifact_type", "TEXT NOT NULL DEFAULT 'document'");
  ensureColumn(db, "artifacts", "schema_version", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "artifacts", "archived_at", "TEXT");
  ensureColumn(db, "artifacts", "publisher_id", "TEXT");
  ensureColumn(db, "artifacts", "publisher_name", "TEXT");
  ensureColumn(db, "artifacts", "publisher_user_id", "TEXT");
  ensureColumn(db, "users", "password_reset_required", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "artifacts", "visibility", "TEXT NOT NULL DEFAULT 'team'");
  ensureColumn(db, "artifacts", "owner_user_id", "TEXT");
  ensureColumn(db, "api_tokens", "scopes_json", "TEXT NOT NULL DEFAULT '[\"read\",\"write\"]'");
  ensureColumn(db, "artifacts", "review_status", "TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(db, "artifact_relations", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "webhooks", "filter_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "webhooks", "owner_user_id", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artifacts_publisher_id ON artifacts(publisher_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artifacts_visibility ON artifacts(visibility)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artifacts_owner_user_id ON artifacts(owner_user_id)");
  backfillArtifactOwnersAndPublishers(db);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('store_version', ?)").run(String(STORE_VERSION));
  ensureSearchTable(db);
}

// Deliberately NOT gated behind a "ran once" sentinel the way
// normalizeStoredSourceAgents is: both backfills are self-healing (see
// "migration backfills owner_user_id from publisher_user_id for legacy
// rows" and "records artifact publishers and backfills legacy rows from
// audit actors" in the test suite, which corrupt a row via direct SQLite
// access mid-test and expect the *next* openDatabase() to repair it) and a
// once-ever sentinel would permanently stop repairing rows a later restore,
// migration, or direct DB edit reintroduces. Each backfill instead runs a
// cheap `SELECT 1 ... LIMIT 1` pre-check first and skips its full
// scan/UPDATE whenever nothing currently qualifies, so a store in steady
// state pays a short indexed-or-early-exit probe per open, not a table
// scan plus UPDATE.
function backfillArtifactOwnersAndPublishers(db) {
  backfillArtifactPublishers(db);
  backfillArtifactOwners(db);
}

const OWNER_BACKFILL_PRECHECK_SQL = `
  SELECT 1 FROM artifacts
  WHERE owner_user_id IS NULL AND publisher_user_id IS NOT NULL AND TRIM(publisher_user_id) != ''
  LIMIT 1
`;

function backfillArtifactOwners(db) {
  const needsBackfill = db.prepare(OWNER_BACKFILL_PRECHECK_SQL).get();
  if (!needsBackfill) {
    return;
  }
  db.prepare(`
    UPDATE artifacts
    SET owner_user_id = publisher_user_id
    WHERE owner_user_id IS NULL AND publisher_user_id IS NOT NULL AND TRIM(publisher_user_id) != ''
  `).run();
}

const PUBLISHER_BACKFILL_PRECHECK_SQL = `
  SELECT 1 FROM artifacts
  WHERE publisher_id IS NULL
    OR TRIM(publisher_id) = ''
    OR publisher_id LIKE 'curl/%'
    OR publisher_id LIKE 'Wget/%'
    OR publisher_id LIKE 'HTTPie/%'
    OR publisher_id LIKE 'PostmanRuntime/%'
    OR publisher_id LIKE 'undici%'
    OR publisher_id LIKE 'node-fetch%'
    OR publisher_id LIKE 'Mozilla/%'
  LIMIT 1
`;

function backfillArtifactPublishers(db) {
  const needsBackfill = db.prepare(PUBLISHER_BACKFILL_PRECHECK_SQL).get();
  if (!needsBackfill) {
    enrichPublisherUsers(db);
    return;
  }

  const rows = db.prepare(`
    SELECT
      id,
      publisher_id,
      (
        SELECT actor
        FROM audit_log
        WHERE audit_log.artifact_id = artifacts.id
          AND action IN ('create', 'import')
          AND actor IS NOT NULL
          AND TRIM(actor) != ''
        ORDER BY created_at ASC
        LIMIT 1
      ) AS actor
    FROM artifacts
    WHERE publisher_id IS NULL
      OR TRIM(publisher_id) = ''
      OR publisher_id LIKE 'curl/%'
      OR publisher_id LIKE 'Wget/%'
      OR publisher_id LIKE 'HTTPie/%'
      OR publisher_id LIKE 'PostmanRuntime/%'
      OR publisher_id LIKE 'undici%'
      OR publisher_id LIKE 'node-fetch%'
      OR publisher_id LIKE 'Mozilla/%'
  `).all();

  if (rows.length === 0) {
    enrichPublisherUsers(db);
    return;
  }

  const update = db.prepare(`
    UPDATE artifacts
    SET publisher_id = ?, publisher_name = ?, publisher_user_id = ?
    WHERE id = ?
  `);

  transaction(db, () => {
    for (const row of rows) {
      const existingPublisherId = normalizeOptionalString(row.publisher_id);
      if (existingPublisherId && !isLikelyUserAgentActor(existingPublisherId)) {
        continue;
      }
      const actor = normalizeOptionalString(row.actor);
      const publisher = publisherForActor(db, actor);
      if (!publisher.publisherId && !existingPublisherId) {
        continue;
      }
      update.run(publisher.publisherId, publisher.publisherName, publisher.publisherUserId, row.id);
    }
    enrichPublisherUsers(db);
  });
}

const PUBLISHER_ENRICHMENT_PRECHECK_SQL = `
  SELECT 1 FROM artifacts
  WHERE publisher_id IS NOT NULL AND TRIM(publisher_id) != ''
    AND (
      publisher_user_id IS NULL
      OR publisher_name IS NULL
      OR TRIM(publisher_name) = ''
    )
    AND EXISTS (
      SELECT 1 FROM users WHERE LOWER(users.email) = LOWER(artifacts.publisher_id)
    )
  LIMIT 1
`;

function enrichPublisherUsers(db) {
  const needsEnrichment = db.prepare(PUBLISHER_ENRICHMENT_PRECHECK_SQL).get();
  if (!needsEnrichment) {
    return;
  }
  db.prepare(`
    UPDATE artifacts
    SET
      publisher_user_id = COALESCE(
        publisher_user_id,
        (SELECT id FROM users WHERE LOWER(users.email) = LOWER(artifacts.publisher_id) LIMIT 1)
      ),
      publisher_name = COALESCE(
        NULLIF(publisher_name, ''),
        (SELECT name FROM users WHERE LOWER(users.email) = LOWER(artifacts.publisher_id) LIMIT 1)
      )
    WHERE publisher_id IS NOT NULL AND TRIM(publisher_id) != ''
  `).run();
}

function publisherForActor(db, actor) {
  const publisherId = normalizeOptionalString(actor);
  if (!publisherId || isLikelyUserAgentActor(publisherId)) {
    return {
      publisherId: null,
      publisherName: null,
      publisherUserId: null
    };
  }

  const user = db.prepare("SELECT id, email, name FROM users WHERE LOWER(email) = LOWER(?)").get(publisherId);
  return {
    publisherId: user?.email || publisherId,
    publisherName: user?.name || null,
    publisherUserId: user?.id || null
  };
}

function isLikelyUserAgentActor(value) {
  if (/^(curl|Wget|HTTPie|PostmanRuntime)\//i.test(value)) {
    return true;
  }
  if (/^(undici|node-fetch)(\/|$)/i.test(value)) {
    return true;
  }
  if (value.length < 24) {
    return false;
  }
  return /\b(Mozilla|AppleWebKit|Chrome|Safari|Firefox|Edg)\b/i.test(value);
}

function migrateJsonIndex(db, store) {
  if (!existsSync(store.indexPath)) {
    return;
  }

  const count = db.prepare("SELECT COUNT(*) AS count FROM artifacts").get().count;
  const migrated = db.prepare("SELECT value FROM meta WHERE key = 'json_index_migrated'").get();
  if (count > 0 || migrated?.value === "true") {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(store.indexPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read legacy Artifacty index: ${error.message}`);
  }

  if (!Array.isArray(parsed.artifacts)) {
    throw new Error(`Unsupported legacy Artifacty index at ${store.indexPath}`);
  }

  transaction(db, () => {
    for (const artifact of parsed.artifacts) {
      insertArtifactRecord(db, artifact);
      for (const version of artifact.versions || []) {
        insertVersionRecord(db, artifact.id, version);
      }
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('json_index_migrated', 'true')").run();
  });
}

function metaValue(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value || "";
}

const INFERABLE_SOURCE_AGENTS = new Set(["claude", "codex", "copilot", "cursor", "gemini"]);

function normalizeStoredSourceAgents(db, store, options = {}) {
  if (!options.force && metaValue(db, "source_agent_normalized_version") === SOURCE_AGENT_NORMALIZATION_VERSION) {
    return;
  }

  const run = () => normalizeStoredSourceAgentsInDb(db, store, options);
  if (options.inTransaction) {
    run();
  } else {
    transaction(db, run);
  }
}

function normalizeStoredSourceAgentsInDb(db, store, options = {}) {
  const rows = db.prepare(`
    SELECT id, source_agent, tags_json
    FROM artifacts
  `).all();
  const updateArtifact = db.prepare("UPDATE artifacts SET source_agent = ?, tags_json = ? WHERE id = ?");
  let changed = false;

  for (const row of rows) {
    const normalized = normalizeSourceAgent(row.source_agent, { defaultValue: "unknown" });
    const inferred = isUnknownSourceAgent(normalized)
      ? inferStoredSourceAgent(db, row)
      : normalized;
    const nextSourceAgent = inferred || normalized;
    const nextTags = normalizeStoredSourceTags(row.tags_json, nextSourceAgent);
    if (nextSourceAgent !== row.source_agent || nextTags !== row.tags_json) {
      updateArtifact.run(nextSourceAgent, nextTags, row.id);
      changed = true;
    }
  }

  const auditRows = db.prepare(`
    SELECT id, source_agent
    FROM audit_log
    WHERE source_agent IS NOT NULL
      AND TRIM(source_agent) != ''
  `).all();
  const updateAudit = db.prepare("UPDATE audit_log SET source_agent = ? WHERE id = ?");
  for (const row of auditRows) {
    const normalized = normalizeSourceAgent(row.source_agent, { defaultValue: "" });
    if (normalized && normalized !== row.source_agent) {
      updateAudit.run(normalized, row.id);
      changed = true;
    }
  }

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('source_agent_normalized_version', ?)").run(SOURCE_AGENT_NORMALIZATION_VERSION);

  if (changed && options.rebuildSearch !== false) {
    rebuildSearchIndexInDb(db, store);
  }
}

function inferStoredSourceAgent(db, artifactRow) {
  const tagCandidate = firstInferableSourceAgent(parseJson(artifactRow.tags_json, []));
  if (tagCandidate) {
    return tagCandidate;
  }

  const versionRows = db.prepare(`
    SELECT metadata_json
    FROM artifact_versions
    WHERE artifact_id = ?
    ORDER BY version DESC
  `).all(artifactRow.id);
  for (const row of versionRows) {
    const metadata = parseJson(row.metadata_json, {});
    const candidate = firstInferableSourceAgent([
      metadata.sourceAgent,
      metadata.source_agent,
      metadata.agent,
      metadata.artifactyImport?.sourceAgent,
      metadata.artifactyImport?.originalAgent
    ]);
    if (candidate) {
      return candidate;
    }
  }

  const auditRows = db.prepare(`
    SELECT source_agent
    FROM audit_log
    WHERE artifact_id = ?
      AND source_agent IS NOT NULL
      AND TRIM(source_agent) != ''
    ORDER BY created_at DESC
  `).all(artifactRow.id);
  return firstInferableSourceAgent(auditRows.map((row) => row.source_agent));
}

function normalizeStoredSourceTags(tagsJson, sourceAgent) {
  const tags = parseJson(tagsJson, []);
  if (!Array.isArray(tags)) {
    return JSON.stringify([]);
  }
  const normalizedTags = [];
  for (const tag of tags) {
    const trimmed = normalizeOptionalString(tag);
    if (!trimmed) {
      continue;
    }
    const canonical = inferableSourceAgent(trimmed);
    const next = canonical || (trimmed === "unknown" && INFERABLE_SOURCE_AGENTS.has(sourceAgent) ? sourceAgent : trimmed);
    if (!normalizedTags.includes(next)) {
      normalizedTags.push(next);
    }
  }
  return JSON.stringify(normalizedTags);
}

function firstInferableSourceAgent(values) {
  for (const value of values || []) {
    const candidate = inferableSourceAgent(value);
    if (candidate) {
      return candidate;
    }
  }
  return "";
}

function inferableSourceAgent(value) {
  const normalized = normalizeSourceAgent(value, { defaultValue: "" });
  return INFERABLE_SOURCE_AGENTS.has(normalized) ? normalized : "";
}

function ensureSearchTable(db) {
  try {
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_search'").get();
    if (existing && !searchTableHasPublisherColumns(db)) {
      db.exec("DROP TABLE artifact_search");
    }
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search USING fts5(
        artifact_id UNINDEXED,
        title,
        source_agent,
        publisher_id,
        publisher_name,
        artifact_type,
        tags,
        format,
        metadata,
        content
      );
    `);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fts5_enabled', 'true')").run();
    return true;
  } catch (error) {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fts5_enabled', ?)").run(`false:${error.message}`);
    return false;
  }
}

function searchTableHasPublisherColumns(db) {
  const columns = db.prepare("PRAGMA table_info(artifact_search)").all().map((row) => row.name);
  return columns.includes("publisher_id") && columns.includes("publisher_name");
}

function searchIndexAvailable(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_search'").get();
  return (Boolean(row) && searchTableHasPublisherColumns(db)) || ensureSearchTable(db);
}

function syncSearchIndexIfEmpty(db, store) {
  if (!searchIndexAvailable(db)) {
    return;
  }
  const artifactCount = db.prepare("SELECT COUNT(*) AS count FROM artifacts").get().count;
  if (artifactCount === 0) {
    return;
  }
  const indexedCount = db.prepare("SELECT COUNT(*) AS count FROM artifact_search").get().count;
  if (indexedCount === 0) {
    transaction(db, () => rebuildSearchIndexInDb(db, store));
  }
}

function clearSearchIndex(db) {
  if (searchIndexAvailable(db)) {
    db.prepare("DELETE FROM artifact_search").run();
  }
}

function rebuildSearchIndexInDb(db, store) {
  if (!searchIndexAvailable(db)) {
    return {
      ok: false,
      fts5: false,
      indexed: 0,
      skipped: []
    };
  }

  db.prepare("DELETE FROM artifact_search").run();
  const skipped = [];
  let indexed = 0;
  for (const artifact of loadArtifacts(db)) {
    const latest = artifact.versions.find((version) => version.version === artifact.latestVersion);
    if (!latest) {
      skipped.push({ artifactId: artifact.id, reason: "latest version row missing" });
      continue;
    }
    const absolutePath = path.join(store.home, latest.path);
    if (!existsSync(absolutePath)) {
      skipped.push({ artifactId: artifact.id, version: latest.version, reason: "version file missing" });
      continue;
    }
    upsertSearchIndex(db, artifact, latest, readFileSync(absolutePath, "utf8"));
    indexed += 1;
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('search_index_built_at', ?)").run(new Date().toISOString());
  return {
    ok: skipped.length === 0,
    fts5: true,
    indexed,
    skipped
  };
}

function upsertSearchIndex(db, artifact, version, content) {
  if (!searchIndexAvailable(db)) {
    return;
  }
  db.prepare("DELETE FROM artifact_search WHERE artifact_id = ?").run(artifact.id);
  db.prepare(`
    INSERT INTO artifact_search (
      artifact_id, title, source_agent, publisher_id, publisher_name, artifact_type, tags, format, metadata, content
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifact.id,
    artifact.title,
    artifact.sourceAgent,
    artifact.publisherId || "",
    artifact.publisherName || "",
    artifact.artifactType,
    artifact.tags.join(" "),
    version.format,
    metadataSearchText({
      ...(version.metadata || {}),
      publisherId: artifact.publisherId || undefined,
      publisherName: artifact.publisherName || undefined
    }),
    content
  );
}

// Exported so embeddings.js's embeddingTextForArtifact can reuse this
// instead of re-implementing metadata-to-text summarization. maxChars
// differs by caller: the FTS index (this file's default) keeps up to 64KB,
// while embeddingTextForArtifact caps its metadata summary at 2000 chars.
export function metadataSearchText(metadata, maxChars = 64 * 1024) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "";
  }
  try {
    return JSON.stringify(metadata).slice(0, maxChars);
  } catch {
    return "";
  }
}

function listStoreFiles(root) {
  if (!existsSync(root)) {
    return [];
  }

  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listStoreFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(path.resolve(fullPath));
    }
  }
  return files;
}

function loadArtifacts(db) {
  const rows = db.prepare(`
    SELECT ${artifactColumns()}
    FROM artifacts
    ORDER BY updated_at DESC, created_at DESC
  `).all();

  return rows.map((row) => artifactFromRow(db, row));
}

function loadVersions(db, artifactId) {
  return db.prepare(`
    SELECT version, created_at, format, content_type, path, size_bytes, sha256, metadata_json
    FROM artifact_versions
    WHERE artifact_id = ?
    ORDER BY version ASC
  `).all(artifactId).map(versionFromRow);
}

function findArtifactById(db, id) {
  const row = db.prepare(`
    SELECT ${artifactColumns()}
    FROM artifacts
    WHERE id = ?
  `).get(id);

  if (!row) {
    throw Object.assign(new Error(`Artifact not found: ${id}`), {
      code: "ARTIFACT_NOT_FOUND",
      statusCode: 404
    });
  }

  return artifactFromRow(db, row);
}

function assertValidRelation(relation) {
  if (!RELATION_TYPES.includes(relation)) {
    throw Object.assign(new Error(`Unsupported relation: ${relation}`), {
      code: "INVALID_RELATION",
      statusCode: 400
    });
  }
}

function insertRelationRecord(db, fromId, toId, relation, audit = {}, metadata = {}) {
  assertValidRelation(relation);
  const publisher = publisherFromAudit(audit);
  return db.prepare(`
    INSERT OR IGNORE INTO artifact_relations (id, from_id, to_id, relation, created_at, created_by, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    fromId,
    toId,
    relation,
    new Date().toISOString(),
    publisher.publisherId || publisher.publisherName || null,
    JSON.stringify(metadata || {})
  );
}

// Relations passed inline on create/update. Each inserted relation writes
// the same relation-add audit row (and therefore event) as addRelation().
function insertRelationsForInput(db, artifact, relations, audit) {
  if (!Array.isArray(relations)) {
    return;
  }
  const fromId = typeof artifact === "string" ? artifact : artifact.id;
  const from = typeof artifact === "string" ? null : artifact;
  for (const entry of relations) {
    if (!entry || !entry.toId || !entry.relation) {
      continue;
    }
    if (entry.toId === fromId) {
      continue;
    }
    assertValidRelation(entry.relation);
    const to = findArtifactById(db, entry.toId);
    const result = insertRelationRecord(db, fromId, to.id, entry.relation, audit, entry.metadata);
    if (result.changes > 0) {
      insertAuditRecord(db, {
        action: "relation-add",
        artifactId: fromId,
        sourceAgent: from?.sourceAgent,
        audit,
        metadata: { toId: to.id, relation: entry.relation },
        tags: from?.tags,
        artifactType: from?.artifactType
      });
    }
  }
}

function relationFromRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation,
    fromArtifactId: row.from_id,
    toArtifactId: row.to_id,
    relationType: row.relation,
    createdAt: row.created_at,
    createdBy: row.created_by || null,
    metadata: parseJson(row.metadata_json, {})
  };
}

function relationsForArtifact(db, id, options = {}) {
  const direction = options.direction || "both";
  const relationFilter = normalizeOptionalString(options.relation);
  const outgoing = [];
  const incoming = [];

  if (direction === "both" || direction === "out") {
    const rows = db.prepare(`
      SELECT id, from_id, to_id, relation, created_at
      FROM artifact_relations
      WHERE from_id = ?
      ORDER BY created_at ASC
    `).all(id);
    for (const row of rows) {
      if (relationFilter && row.relation !== relationFilter) {
        continue;
      }
      outgoing.push(relationEntryFromRow(db, row, "out", options.access));
    }
  }

  if (direction === "both" || direction === "in") {
    const rows = db.prepare(`
      SELECT id, from_id, to_id, relation, created_at
      FROM artifact_relations
      WHERE to_id = ?
      ORDER BY created_at ASC
    `).all(id);
    for (const row of rows) {
      if (relationFilter && row.relation !== relationFilter) {
        continue;
      }
      incoming.push(relationEntryFromRow(db, row, "in", options.access));
    }
  }

  return { outgoing, incoming };
}

function relationEntryFromRow(db, row, direction, access) {
  const otherId = direction === "out" ? row.to_id : row.from_id;
  const otherRow = db.prepare(`
    SELECT ${artifactColumns()}
    FROM artifacts
    WHERE id = ?
  `).get(otherId);
  const otherArtifact = otherRow ? artifactFromRow(db, otherRow) : null;
  const restricted = Boolean(otherArtifact) && !canReadArtifactMeta(db, otherArtifact, access);
  // A restricted neighbour's summary is withheld entirely (null), not
  // replaced with a truthy placeholder object - callers must branch on the
  // sibling `restricted` flag, not on `artifact` being present.
  const artifact = otherRow && !restricted ? toArtifactSummary(otherArtifact) : null;

  return {
    id: row.id,
    relation: direction === "out" ? row.relation : inverseRelation(row.relation),
    // A restricted neighbour's id is itself sensitive (ids are slugified
    // titles), so it is withheld along with the summary rather than only
    // blanking `artifact`.
    artifactId: restricted ? null : otherId,
    artifact,
    restricted,
    missing: !otherRow,
    createdAt: row.created_at
  };
}

function insertArtifactRecord(db, artifact) {
  const reviewStatus = artifact.reviewStatus || artifact.review_status;
  db.prepare(`
    INSERT INTO artifacts (
      id, title, artifact_type, schema_version, source_agent, publisher_id, publisher_name, publisher_user_id, visibility, owner_user_id, tags_json, created_at, updated_at, latest_version, archived_at, review_status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifact.id,
    artifact.title,
    normalizeArtifactType(artifact.artifactType || artifact.artifact_type || "document"),
    normalizeSchemaVersion(artifact.schemaVersion || artifact.schema_version),
    normalizeSourceAgent(artifact.sourceAgent || artifact.source_agent, { defaultValue: "unknown" }),
    normalizeOptionalString(artifact.publisherId || artifact.publisher_id) || null,
    normalizeOptionalString(artifact.publisherName || artifact.publisher_name) || null,
    normalizeOptionalString(artifact.publisherUserId || artifact.publisher_user_id) || null,
    normalizeVisibility(artifact.visibility),
    normalizeOptionalString(artifact.ownerUserId || artifact.owner_user_id) || null,
    JSON.stringify(artifact.tags || []),
    artifact.createdAt || artifact.created_at,
    artifact.updatedAt || artifact.updated_at,
    artifact.latestVersion || artifact.latest_version || 1,
    artifact.archivedAt || artifact.archived_at || null,
    REVIEW_STATUSES.includes(reviewStatus) ? reviewStatus : "none"
  );
}

function insertVersionRecord(db, artifactId, version) {
  db.prepare(`
    INSERT INTO artifact_versions (
      artifact_id, version, created_at, format, content_type, path, size_bytes, sha256, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifactId,
    version.version,
    version.createdAt || version.created_at,
    normalizeFormat(version.format),
    version.contentType || version.content_type || contentTypeForFormat(version.format),
    version.path,
    version.sizeBytes || version.size_bytes || 0,
    version.sha256,
    JSON.stringify(version.metadata || {})
  );
}

// Exported so every mutation writes its audit row through one insert path
// (docs/roadmap-design.md's stated convention), including retention.js's
// (currently raw-SQL) audit rows. Must be called inside a transaction()
// against the same `db` for its derived event (if any) to be queued and
// published; called outside one, the audit row is still written but no
// event reaches SSE clients, webhooks, or MCP subscribers.
export function insertAuditRow(db, params) {
  insertAuditRecord(db, params);
}

function insertAuditRecord(db, { action, artifactId, version, sourceAgent, audit = {}, metadata = {}, tags, artifactType }) {
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO audit_log (
      id, created_at, action, artifact_id, version, source_agent, actor, surface, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    createdAt,
    action,
    artifactId,
    version || null,
    sourceAgent || null,
    audit.actor || null,
    audit.surface || null,
    JSON.stringify(metadata || {})
  );

  let eventVisibility = null;
  let eventOwnerUserId = null;
  if (artifactId) {
    const artifactRow = db.prepare(`SELECT visibility, owner_user_id FROM artifacts WHERE id = ?`).get(artifactId);
    if (artifactRow) {
      eventVisibility = artifactRow.visibility || "team";
      eventOwnerUserId = artifactRow.owner_user_id || null;
    }
  }

  const event = eventFromAudit({
    action,
    artifactId,
    version: version || null,
    sourceAgent: sourceAgent || null,
    actor: audit.actor || null,
    surface: audit.surface || null,
    createdAt,
    tags: tags || [],
    artifactType: artifactType || null,
    visibility: eventVisibility,
    ownerUserId: eventOwnerUserId
  });
  if (event) {
    insertEventRow(db, event);
    pendingEvents.push(event);
  }
}

function insertEventRow(db, event) {
  db.prepare(`
    INSERT INTO events (id, created_at, type, artifact_id, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(event.id, event.createdAt, event.type, event.artifactId, JSON.stringify(event));

  const limit = eventHistoryLimit();
  db.prepare(`
    DELETE FROM events
    WHERE seq <= (SELECT COALESCE(MAX(seq), 0) FROM events) - ?
  `).run(limit);
}

function auditFromRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    action: row.action,
    artifactId: row.artifact_id,
    version: row.version,
    sourceAgent: row.source_agent,
    actor: row.actor,
    surface: row.surface,
    metadata: parseJson(row.metadata_json, {})
  };
}

function userFromRow(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    active: Boolean(row.active),
    passwordResetRequired: Boolean(row.password_reset_required),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function apiTokenFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    scopes: row.scopes_json ? parseJson(row.scopes_json, ["read", "write"]) : ["read", "write"]
  };
}

function versionFromRow(row) {
  return {
    version: row.version,
    createdAt: row.created_at,
    format: row.format,
    contentType: row.content_type,
    path: row.path,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    metadata: parseJson(row.metadata_json, {})
  };
}

// Events queued by insertAuditRecord() during the *current* transaction.
// Not nested: every top-level exported function opens at most one
// transaction() per call, so a simple module-level array (saved/restored
// around each call) is sufficient and avoids threading extra state through
// every call site.
let pendingEvents = [];

// Exported so callers with their own db handle opened via openDatabase()
// (currently retention.js) get the same BEGIN IMMEDIATE / COMMIT-or-
// ROLLBACK-then-publish semantics as every write in this file, instead of
// hand-rolling their own transaction block that can't queue/publish events.
export function transaction(db, fn) {
  const outerPending = pendingEvents;
  pendingEvents = [];
  db.exec("BEGIN IMMEDIATE");
  let result;
  try {
    result = fn();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    pendingEvents = outerPending;
    throw error;
  }
  // Publish only after COMMIT has succeeded, and outside the try/catch
  // above: if publishEvent itself threw here (not a listener exception —
  // those are caught inside events.js — but e.g. a bug in markPublished),
  // being inside the try would run ROLLBACK against a transaction that
  // already committed, raising a second error that masks the first and
  // discards `result`.
  const toPublish = pendingEvents;
  pendingEvents = outerPending;
  for (const event of toPublish) {
    publishEvent(event);
  }
  return result;
}

function writeVersionFile(store, id, versionNumber, input, createdAt) {
  const contentBuffer = Buffer.from(input.content, "utf8");
  if (contentBuffer.byteLength > MAX_ARTIFACT_BYTES) {
    throw Object.assign(new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`), {
      code: "ARTIFACT_TOO_LARGE",
      statusCode: 413
    });
  }

  const artifactDir = path.join(store.artifactsDir, id);
  mkdirSync(artifactDir, { recursive: true });

  const format = normalizeFormat(input.format);
  const relativePath = path.join("artifacts", id, `v${versionNumber}.${extensionForFormat(format)}`);
  const absolutePath = path.join(store.home, relativePath);
  const tempPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, input.content, "utf8");
  renameSync(tempPath, absolutePath);

  return {
    version: versionNumber,
    createdAt,
    format,
    contentType: input.contentType || contentTypeForFormat(format),
    path: relativePath,
    sizeBytes: contentBuffer.byteLength,
    sha256: createHash("sha256").update(contentBuffer).digest("hex"),
    metadata: input.metadata
  };
}

function removeVersionFile(store, relativePath) {
  const absolutePath = path.join(store.home, relativePath);
  if (existsSync(absolutePath)) {
    rmSync(absolutePath, { force: true });
  }
}

function isNoopVersionUpdate(artifact, latest, latestContent, normalized) {
  const nextTitle = normalized.title || artifact.title;
  const nextSourceAgent = normalized.sourceAgent || artifact.sourceAgent;
  const nextArtifactType = normalized.artifactType || artifact.artifactType;
  const nextSchemaVersion = normalized.schemaVersion || artifact.schemaVersion;
  const nextTags = normalized.tags.length > 0 ? normalized.tags : artifact.tags;
  const nextContentType = normalized.contentType || contentTypeForFormat(normalized.format);

  return nextTitle === artifact.title &&
    nextSourceAgent === artifact.sourceAgent &&
    nextArtifactType === artifact.artifactType &&
    nextSchemaVersion === artifact.schemaVersion &&
    tagsEqual(nextTags, artifact.tags) &&
    normalized.content === latestContent &&
    normalized.format === latest.format &&
    nextContentType === latest.contentType;
}

function tagsEqual(left = [], right = []) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

async function withLatestContent(store, artifact) {
  const latest = await readArtifactVersion(store, artifact, artifact.latestVersion);
  return {
    ...artifact,
    version: latest.version,
    content: latest.content
  };
}

// Validates `files` entries of a bundle artifact (roadmap section 17:
// Document Assets in Bundles). Binary entries (encoding: "base64") must use
// an allowed document content type and stay under the per-file byte cap;
// every entry's path must be a safe relative path. No-op for non-bundle
// artifacts or bundle content that isn't valid JSON (surfaced elsewhere).
function validateBundleFileEntries(normalized) {
  if (normalized.artifactType !== "bundle" || typeof normalized.content !== "string") {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(normalized.content);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.files)) {
    return;
  }

  for (const file of parsed.files) {
    if (!file || typeof file !== "object") {
      continue;
    }
    const filePath = typeof file.path === "string" && file.path
      ? file.path
      : (typeof file.name === "string" ? file.name : "");
    if (!isSafeBundleFilePath(filePath)) {
      throw Object.assign(new Error(`Unsafe bundle file path: ${filePath || "(empty)"}`), {
        code: "INVALID_BUNDLE_FILE_PATH",
        statusCode: 400
      });
    }

    if (file.encoding !== "base64") {
      continue;
    }

    const contentType = typeof file.contentType === "string"
      ? file.contentType.toLowerCase().split(";")[0].trim()
      : "";
    if (!BUNDLE_BINARY_CONTENT_TYPES.has(contentType)) {
      throw Object.assign(new Error(`Unsupported bundle binary content type: ${contentType || "(none)"}`), {
        code: "UNSUPPORTED_BUNDLE_FILE_TYPE",
        statusCode: 400
      });
    }

    const raw = typeof file.content === "string" ? file.content : "";
    let decodedBytes = 0;
    try {
      decodedBytes = Buffer.from(raw, "base64").byteLength;
    } catch {
      decodedBytes = 0;
    }
    if (decodedBytes > MAX_BUNDLE_FILE_BYTES) {
      throw Object.assign(new Error(`Bundle file exceeds ${MAX_BUNDLE_FILE_BYTES} bytes: ${filePath}`), {
        code: "BUNDLE_FILE_TOO_LARGE",
        statusCode: 413
      });
    }
  }
}

// A safe bundle file path: relative, no drive letters/UNC prefixes, no
// "." / ".." segments, no control characters.
export function isSafeBundleFilePath(value) {
  const text = typeof value === "string" ? value : "";
  if (!text || text.length > 1024 || hasControlCharacters(text)) {
    return false;
  }
  const normalized = text.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:\//.test(normalized)) {
    return false;
  }
  const segments = normalized.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

// Reads one binary file entry out of a bundle artifact's content, enforcing
// the same rules validateBundleFileEntries checks at write time (safe
// relative path, base64 encoding, allowlisted content type) so a server/CLI
// caller never has to re-implement the bundle file format. `artifact` only
// needs `artifactType`; `content` is the bundle's raw JSON text (the
// version's content, not necessarily the artifact's live latest version).
// Returns null for anything that doesn't resolve to a servable file.
export function readBundleFile(artifact, content, fileName) {
  if (!artifact || artifact.artifactType !== "bundle" || typeof content !== "string") {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.files)) {
    return null;
  }

  const file = parsed.files.find(
    (entry) => entry && typeof entry === "object" && (entry.path === fileName || entry.name === fileName)
  );
  if (!file) {
    return null;
  }

  const filePath = typeof file.path === "string" && file.path
    ? file.path
    : (typeof file.name === "string" ? file.name : "");
  if (!isSafeBundleFilePath(filePath)) {
    return null;
  }
  if (file.encoding !== "base64" || typeof file.content !== "string") {
    return null;
  }

  const contentType = String(file.contentType || "").toLowerCase().split(";")[0].trim();
  if (!BUNDLE_BINARY_CONTENT_TYPES.has(contentType)) {
    return null;
  }

  let body;
  try {
    body = Buffer.from(file.content, "base64");
  } catch {
    return null;
  }

  return {
    body,
    contentType,
    fileName: filePath.split("/").pop()
  };
}

function hasControlCharacters(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function normalizeArtifactInput(input, options) {
  const title = normalizeOptionalString(input.title);
  const content = typeof input.content === "string" ? input.content : undefined;

  if (!title && options.requireTitle) {
    throw Object.assign(new Error("Artifact title is required"), {
      code: "TITLE_REQUIRED",
      statusCode: 400
    });
  }

  if (options.requireContent && typeof content !== "string") {
    throw Object.assign(new Error("Artifact content must be a string"), {
      code: "CONTENT_REQUIRED",
      statusCode: 400
    });
  }

  return {
    title,
    content,
    format: normalizeFormat(input.format || inferFormat(input.contentType, content)),
    contentType: normalizeOptionalString(input.contentType),
    artifactType: normalizeArtifactType(input.artifactType || input.artifact_type || inferArtifactType(input)),
    schemaVersion: normalizeSchemaVersion(input.schemaVersion || input.schema_version),
    sourceAgent: normalizeSourceAgent(input.sourceAgent || input.source_agent || input.agent, {
      defaultValue: options.defaultSourceAgent ?? "unknown"
    }),
    tags: normalizeTags(input.tags),
    metadata: normalizeMetadata(input.metadata)
  };
}

function withSecretScan(input, secretScan) {
  return {
    ...input,
    metadata: {
      ...normalizeMetadata(input.metadata),
      secretScan: {
        ...secretScan,
        scannedAt: new Date().toISOString()
      }
    }
  };
}

function normalizeSchemaVersion(value) {
  const parsed = Number(value || ARTIFACT_SCHEMA_VERSION);
  if (parsed !== ARTIFACT_SCHEMA_VERSION) {
    throw Object.assign(new Error(`Unsupported artifact schema version: ${value}`), {
      code: "INVALID_SCHEMA_VERSION",
      statusCode: 400
    });
  }
  return ARTIFACT_SCHEMA_VERSION;
}

function inferArtifactType(input) {
  let format;
  try {
    format = normalizeFormat(input.format || inferFormat(input.contentType, input.content));
  } catch {
    format = normalizeOptionalString(input.format || inferFormat(input.contentType, input.content));
  }
  if (format === "html") {
    return "html-page";
  }
  if (format === "svg" || format === "mermaid") {
    return "diagram";
  }
  if (format === "react") {
    return "component";
  }
  if (format === "code") {
    return "snippet";
  }
  if (format === "sarif" || format === "notebook") {
    return "analysis-report";
  }
  if (format === "csv") {
    return looksLikeAnalysisCsv(input.content) ||
      /findings?|security|review|scan/i.test(normalizeOptionalString(input.title))
      ? "analysis-report"
      : "table";
  }
  if (format === "image" || format === "video") {
    return "asset";
  }
  return "document";
}

function looksLikeAnalysisCsv(content) {
  const [header = ""] = normalizeOptionalString(content).split(/\r?\n/, 1);
  const normalized = header.toLowerCase();
  return normalized.includes("severity") &&
    (normalized.includes("message") || normalized.includes("description")) &&
    (normalized.includes("file") || normalized.includes("path") || normalized.includes("rule"));
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }
  return [...new Set(tags.map(normalizeOptionalString).filter(Boolean))].slice(0, 20);
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  return metadata;
}

function normalizeEmail(value) {
  return normalizeOptionalString(value).toLowerCase();
}

function normalizeUserRole(value) {
  const role = normalizeOptionalString(value) || "user";
  if (!USER_ROLES.includes(role)) {
    throw Object.assign(new Error(`Unsupported user role: ${value}`), {
      statusCode: 400,
      code: "INVALID_USER_ROLE"
    });
  }
  return role;
}

function insertUser(db, input = {}) {
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");
  if (!email) {
    throw Object.assign(new Error("User email is required"), { statusCode: 400, code: "USER_EMAIL_REQUIRED" });
  }
  if (password.length < 8) {
    throw Object.assign(new Error("User password must be at least 8 characters"), { statusCode: 400, code: "USER_PASSWORD_WEAK" });
  }
  const role = normalizeUserRole(input.role || "user");
  const name = normalizeOptionalString(input.name) || email;
  const now = new Date().toISOString();
  const user = {
    id: randomUUID(),
    email,
    name,
    role,
    active: true,
    passwordResetRequired: Boolean(input.passwordResetRequired),
    createdAt: now,
    updatedAt: now
  };
  try {
    db.prepare(`
      INSERT INTO users (id, email, name, role, password_hash, active, password_reset_required, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      user.id,
      user.email,
      user.name,
      user.role,
      hashPassword(password),
      user.passwordResetRequired ? 1 : 0,
      now,
      now
    );
    return user;
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) {
      throw Object.assign(new Error(`User already exists: ${email}`), { statusCode: 409, code: "USER_EXISTS" });
    }
    throw error;
  }
}

function parseUserCsv(csv) {
  const rows = parseCsvRows(csv).filter((row) => row.some((cell) => normalizeOptionalString(cell)));
  if (rows.length === 0) {
    return [];
  }
  const headers = rows[0].map(normalizeCsvHeader);
  if (!headers.includes("email")) {
    throw Object.assign(new Error("User CSV requires an email header"), {
      statusCode: 400,
      code: "USER_CSV_EMAIL_REQUIRED"
    });
  }
  return rows.slice(1).map((row, index) => {
    const record = { row: index + 2 };
    headers.forEach((header, columnIndex) => {
      if (header) {
        record[header] = normalizeOptionalString(row[columnIndex]);
      }
    });
    return record;
  });
}

function parseCsvRows(csv) {
  const text = String(csv || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (quoted) {
    throw Object.assign(new Error("User CSV has an unterminated quoted field"), {
      statusCode: 400,
      code: "USER_CSV_INVALID"
    });
  }
  row.push(cell.replace(/\r$/, ""));
  rows.push(row);
  return rows;
}

function normalizeCsvHeader(value) {
  const header = normalizeOptionalString(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (header === "mail" || header === "email_address") {
    return "email";
  }
  if (header === "display_name" || header === "full_name") {
    return "name";
  }
  if (header === "temporary_password" || header === "temp_password") {
    return "temporary_password";
  }
  if (header === "force_reset" || header === "must_change_password") {
    return "password_reset_required";
  }
  return header;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== "");
}

function parseBooleanOption(value) {
  const normalized = normalizeOptionalString(value).toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw Object.assign(new Error(`Invalid boolean value: ${value}`), {
    statusCode: 400,
    code: "INVALID_BOOLEAN"
  });
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function generateTemporaryPassword() {
  return `tmp_${randomBytes(18).toString("base64url")}`;
}

function generateOpaqueToken(prefix) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function hashToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(String(password), salt, 64).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored || "").split(":");
  if (scheme !== "scrypt" || !salt || !expected) {
    return false;
  }
  const actualBuffer = scryptSync(String(password), salt, 64);
  const expectedBuffer = Buffer.from(expected, "base64url");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function inferFormat(contentType, content = "") {
  const value = normalizeOptionalString(contentType).toLowerCase();
  if (value.includes("vnd.ant.code") || value.includes("source-code")) {
    return "code";
  }
  if (value.includes("sarif")) {
    return "sarif";
  }
  if (value.includes("csv")) {
    return "csv";
  }
  if (value.includes("svg")) {
    return "svg";
  }
  if (value.startsWith("image/")) {
    return "image";
  }
  if (value.startsWith("video/")) {
    return "video";
  }
  if (value.includes("vnd.ant.mermaid") || value.includes("mermaid")) {
    return "mermaid";
  }
  if (value.includes("vnd.ant.react") || value.includes("jsx")) {
    return "react";
  }
  if (value.includes("ipynb") || value.includes("notebook")) {
    return "notebook";
  }
  if (value.includes("html")) {
    return "html";
  }
  if (value.includes("markdown")) {
    return "markdown";
  }
  const trimmed = normalizeOptionalString(content);
  if (value.includes("json")) {
    return looksLikeNotebookObject(trimmed) ? "notebook" : "json";
  }
  if (looksLikeHtml(trimmed)) {
    return "html";
  }
  if (looksLikeNotebookObject(trimmed)) {
    return "notebook";
  }
  return "text";
}

function looksLikeNotebookObject(value) {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return Boolean(
      parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        parsed.nbformat !== undefined &&
        Array.isArray(parsed.cells)
    );
  } catch {
    return false;
  }
}

function looksLikeHtml(value) {
  if (/^<!doctype html/i.test(value) || /^<html[\s>]/i.test(value)) {
    return true;
  }
  const withoutLeadingComment = value.replace(/^<!--[\s\S]*?-->\s*/, "");
  return /^<\/?(?:a|article|aside|body|br|button|canvas|code|div|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|iframe|img|input|label|li|link|main|meta|nav|ol|option|p|pre|script|section|select|span|style|table|tbody|td|textarea|tfoot|th|thead|title|tr|ul|video|audio)(?:\s|>|\/)/i.test(withoutLeadingComment);
}

function makeArtifactId(title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "artifact";

  return `${slug}-${randomUUID().slice(0, 8)}`;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function ensureColumn(db, table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
