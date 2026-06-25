import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertNoSecrets, securityConfig } from "./security.js";

export const STORE_VERSION = 3;
export const ARTIFACT_SCHEMA_VERSION = 1;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
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
  "video"
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
  video: "video"
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
  video: "application/vnd.artifacty.video+base64; charset=utf-8"
};

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
  const db = openDatabase(store);

  try {
    let artifact;
    transaction(db, () => {
      const now = new Date().toISOString();
      const id = makeArtifactId(normalized.title);
      const version = writeVersionFile(store, id, 1, normalized, now);

      artifact = {
        id,
        title: normalized.title,
        artifactType: normalized.artifactType,
        schemaVersion: normalized.schemaVersion,
        sourceAgent: normalized.sourceAgent,
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
        metadata: { title: normalized.title, artifactType: normalized.artifactType }
      });
    });

    return withLatestContent(store, artifact);
  } finally {
    db.close();
  }
}

export async function updateArtifact(store = createStore(), id, input = {}) {
  const secretScan = assertNoSecrets(input, securityConfig());
  input = withSecretScan(input, secretScan);
  const normalized = normalizeArtifactInput(input, { requireContent: true, requireTitle: false });
  const db = openDatabase(store);

  try {
    let artifact;
    transaction(db, () => {
      artifact = findArtifactById(db, id);
      const now = new Date().toISOString();
      const nextVersion = artifact.latestVersion + 1;
      const version = writeVersionFile(store, artifact.id, nextVersion, normalized, now);

      artifact.title = normalized.title || artifact.title;
      artifact.sourceAgent = normalized.sourceAgent || artifact.sourceAgent;
      artifact.artifactType = normalized.artifactType || artifact.artifactType;
      artifact.schemaVersion = normalized.schemaVersion || artifact.schemaVersion;
      artifact.tags = normalized.tags.length > 0 ? normalized.tags : artifact.tags;
      artifact.updatedAt = now;
      artifact.latestVersion = nextVersion;
      artifact.versions.push(version);

      db.prepare(`
        UPDATE artifacts
        SET title = ?, source_agent = ?, artifact_type = ?, schema_version = ?, tags_json = ?, updated_at = ?, latest_version = ?
        WHERE id = ?
      `).run(
        artifact.title,
        artifact.sourceAgent,
        artifact.artifactType,
        artifact.schemaVersion,
        JSON.stringify(artifact.tags),
        artifact.updatedAt,
        artifact.latestVersion,
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
        metadata: { title: artifact.title, artifactType: artifact.artifactType }
      });
    });

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
      const archivedAt = options.archivedAt || new Date().toISOString();
      db.prepare("UPDATE artifacts SET archived_at = ?, updated_at = ? WHERE id = ?").run(
        archivedAt,
        archivedAt,
        id
      );
      artifact.archivedAt = archivedAt;
      artifact.updatedAt = archivedAt;
      insertAuditRecord(db, {
        action: "archive",
        artifactId: id,
        version: artifact.latestVersion,
        sourceAgent: artifact.sourceAgent,
        audit: options.audit,
        metadata: {}
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
        metadata: {}
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

export async function listArtifactsPage(store = createStore(), filters = {}) {
  const db = openDatabase(store);
  const limit = clampInteger(filters.limit, 1, 200, 50);
  const offset = clampInteger(filters.offset, 0, 1_000_000, 0);
  const query = normalizeOptionalString(filters.query);
  const normalizedQuery = query.toLowerCase();
  const tag = normalizeOptionalString(filters.tag).toLowerCase();
  const sourceAgent = normalizeOptionalString(filters.sourceAgent).toLowerCase();

  try {
    if (query && searchIndexAvailable(db)) {
      const ftsQuery = toFtsQuery(query);
      if (ftsQuery) {
        try {
          const page = listArtifactsPageWithFts(db, {
            ftsQuery,
            tag,
            sourceAgent,
            includeArchived: filters.includeArchived,
            limit,
            offset
          });
          if (page.total > 0) {
            return page;
          }
        } catch {
          // Keep search usable even if the SQLite FTS parser rejects a query.
        }
      }
    }

    return listArtifactsPageWithSql(db, {
      query: normalizedQuery,
      tag,
      sourceAgent,
      includeArchived: filters.includeArchived,
      limit,
      offset
    });
  } finally {
    db.close();
  }
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
      LOWER(tags_json) LIKE ? ESCAPE '\\'
    )`);
    params.push(like, like, like, like);
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS total FROM artifacts ${whereSql}`).get(...params).total;
  const rows = db.prepare(`
    SELECT id, title, artifact_type, schema_version, source_agent, tags_json, created_at, updated_at, latest_version, archived_at
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
      a.id,
      a.title,
      a.artifact_type,
      a.schema_version,
      a.source_agent,
      a.tags_json,
      a.created_at,
      a.updated_at,
      a.latest_version,
      a.archived_at,
      bm25(artifact_search) AS search_rank,
      snippet(artifact_search, 7, '', '', '...', 24) AS search_snippet
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

  return { clauses, params };
}

function pagedResult({ artifacts, total, limit, offset, searchBackend }) {
  return {
    artifacts,
    total,
    limit,
    offset,
    hasMore: offset + artifacts.length < total,
    nextOffset: offset + artifacts.length < total ? offset + limit : null,
    previousOffset: offset > 0 ? Math.max(0, offset - limit) : null,
    search: {
      backend: searchBackend
    }
  };
}

function artifactFromRow(db, row) {
  return {
    id: row.id,
    title: row.title,
    artifactType: row.artifact_type,
    schemaVersion: row.schema_version,
    sourceAgent: row.source_agent,
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
      content
    };
  } finally {
    db.close();
  }
}

export async function listAuditEvents(store = createStore(), filters = {}) {
  const db = openDatabase(store);
  try {
    const limit = clampInteger(filters.limit, 1, 500, 100);
    if (filters.artifactId) {
      return db.prepare(`
        SELECT id, created_at, action, artifact_id, version, source_agent, actor, surface, metadata_json
        FROM audit_log
        WHERE artifact_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(filters.artifactId, limit).map(auditFromRow);
    }
    return db.prepare(`
      SELECT id, created_at, action, artifact_id, version, source_agent, actor, surface, metadata_json
      FROM audit_log
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit).map(auditFromRow);
  } finally {
    db.close();
  }
}

export async function readArtifactVersion(store, artifact, versionNumber) {
  const version = artifact.versions.find((item) => item.version === versionNumber);
  if (!version) {
    throw Object.assign(new Error(`Artifact version not found: ${artifact.id}@${versionNumber}`), {
      code: "ARTIFACT_VERSION_NOT_FOUND",
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
    tags: artifact.tags,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    archivedAt: artifact.archivedAt,
    latestVersion: artifact.latestVersion,
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

function openDatabase(store) {
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

    CREATE INDEX IF NOT EXISTS idx_artifacts_updated_at ON artifacts(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_source_agent ON artifacts(source_agent);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_artifact_id ON audit_log(artifact_id);
  `);
  ensureColumn(db, "artifacts", "artifact_type", "TEXT NOT NULL DEFAULT 'document'");
  ensureColumn(db, "artifacts", "schema_version", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "artifacts", "archived_at", "TEXT");
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('store_version', ?)").run(String(STORE_VERSION));
  ensureSearchTable(db);
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

function ensureSearchTable(db) {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search USING fts5(
        artifact_id UNINDEXED,
        title,
        source_agent,
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

function searchIndexAvailable(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_search'").get();
  return Boolean(row) || ensureSearchTable(db);
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
      artifact_id, title, source_agent, artifact_type, tags, format, metadata, content
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifact.id,
    artifact.title,
    artifact.sourceAgent,
    artifact.artifactType,
    artifact.tags.join(" "),
    version.format,
    metadataSearchText(version.metadata),
    content
  );
}

function metadataSearchText(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "";
  }
  return JSON.stringify(metadata).slice(0, 64 * 1024);
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
    SELECT id, title, artifact_type, schema_version, source_agent, tags_json, created_at, updated_at, latest_version, archived_at
    FROM artifacts
    ORDER BY updated_at DESC, created_at DESC
  `).all();

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    artifactType: row.artifact_type,
    schemaVersion: row.schema_version,
    sourceAgent: row.source_agent,
    tags: parseJson(row.tags_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    latestVersion: row.latest_version,
    versions: loadVersions(db, row.id)
  }));
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
    SELECT id, title, artifact_type, schema_version, source_agent, tags_json, created_at, updated_at, latest_version, archived_at
    FROM artifacts
    WHERE id = ?
  `).get(id);

  if (!row) {
    throw Object.assign(new Error(`Artifact not found: ${id}`), {
      code: "ARTIFACT_NOT_FOUND",
      statusCode: 404
    });
  }

  return {
    id: row.id,
    title: row.title,
    artifactType: row.artifact_type,
    schemaVersion: row.schema_version,
    sourceAgent: row.source_agent,
    tags: parseJson(row.tags_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    latestVersion: row.latest_version,
    versions: loadVersions(db, row.id)
  };
}

function insertArtifactRecord(db, artifact) {
  db.prepare(`
    INSERT INTO artifacts (
      id, title, artifact_type, schema_version, source_agent, tags_json, created_at, updated_at, latest_version, archived_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifact.id,
    artifact.title,
    normalizeArtifactType(artifact.artifactType || artifact.artifact_type || "document"),
    normalizeSchemaVersion(artifact.schemaVersion || artifact.schema_version),
    artifact.sourceAgent || artifact.source_agent || "unknown",
    JSON.stringify(artifact.tags || []),
    artifact.createdAt || artifact.created_at,
    artifact.updatedAt || artifact.updated_at,
    artifact.latestVersion || artifact.latest_version || 1,
    artifact.archivedAt || artifact.archived_at || null
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

function insertAuditRecord(db, { action, artifactId, version, sourceAgent, audit = {}, metadata = {} }) {
  db.prepare(`
    INSERT INTO audit_log (
      id, created_at, action, artifact_id, version, source_agent, actor, surface, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    new Date().toISOString(),
    action,
    artifactId,
    version || null,
    sourceAgent || null,
    audit.actor || null,
    audit.surface || null,
    JSON.stringify(metadata || {})
  );
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

function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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

async function withLatestContent(store, artifact) {
  const latest = await readArtifactVersion(store, artifact, artifact.latestVersion);
  return {
    ...artifact,
    version: latest.version,
    content: latest.content
  };
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
    format: normalizeFormat(input.format || inferFormat(input.contentType)),
    contentType: normalizeOptionalString(input.contentType),
    artifactType: normalizeArtifactType(input.artifactType || input.artifact_type || inferArtifactType(input)),
    schemaVersion: normalizeSchemaVersion(input.schemaVersion || input.schema_version),
    sourceAgent: normalizeOptionalString(input.sourceAgent || input.source_agent || input.agent) || "unknown",
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
    format = normalizeFormat(input.format || inferFormat(input.contentType));
  } catch {
    format = normalizeOptionalString(input.format || inferFormat(input.contentType));
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
  if (format === "sarif") {
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

function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function inferFormat(contentType) {
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
  if (value.includes("html")) {
    return "html";
  }
  if (value.includes("markdown")) {
    return "markdown";
  }
  if (value.includes("json")) {
    return "json";
  }
  return "text";
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

function ensureColumn(db, table, column, definition) {
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
