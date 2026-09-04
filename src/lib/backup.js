import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  countUsers,
  createStore,
  exportFullStoreTables,
  importFullStoreTables,
  loadIndex,
  openDatabase,
  STORE_VERSION,
  writeIndex
} from "./storage.js";

export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
const BUNDLE_VERSION = 2;

export async function exportStore(store = createStore(), outputPath, { scope = "artifacts" } = {}) {
  if (!outputPath) {
    throw new Error("export requires --file <path>");
  }
  const normalizedScope = scope === "full" ? "full" : "artifacts";
  const bundle = await buildStoreBackup(store, { scope: normalizedScope });
  const resolvedOutputPath = path.resolve(outputPath);
  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  const content = `${JSON.stringify(bundle, null, 2)}\n`;
  if (normalizedScope === "full") {
    // The full scope carries password hashes and API token hashes. Write to
    // a private temp file (mode 0o600 from creation, "wx" so it fails
    // instead of following a symlink or clobbering something already
    // there) and rename it into place, so the destination is never briefly
    // readable with the process's default (typically 0o644) mode the way a
    // plain writeFile-then-chmod leaves it for the duration of the write.
    const tempPath = `${resolvedOutputPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(tempPath, resolvedOutputPath);
    } catch (error) {
      // Don't leave a stray 0o600 temp file containing password/API-token
      // hashes behind if the rename (or the write itself) fails.
      await rm(tempPath, { force: true });
      throw error;
    }
  } else {
    await writeFile(resolvedOutputPath, content, "utf8");
  }
  return {
    path: resolvedOutputPath,
    artifactCount: bundle.artifacts.length,
    scope: normalizedScope,
    exportedAt: bundle.exportedAt
  };
}

export async function exportStoreToString(store = createStore(), { scope = "artifacts" } = {}) {
  const bundle = await buildStoreBackup(store, { scope: scope === "full" ? "full" : "artifacts" });
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export async function buildStoreBackup(store = createStore(), { scope = "artifacts" } = {}) {
  const normalizedScope = scope === "full" ? "full" : "artifacts";
  const index = await loadIndex(store);
  const artifacts = [];
  for (const artifact of index.artifacts) {
    const versions = [];
    for (const version of artifact.versions) {
      versions.push({
        ...version,
        path: normalizeBackupRelativePath(version.path),
        content: await readFile(path.join(store.home, version.path), "utf8")
      });
    }
    artifacts.push({ ...artifact, versions });
  }

  const bundle = {
    bundleVersion: BUNDLE_VERSION,
    scope: normalizedScope,
    storeVersion: STORE_VERSION,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    artifacts
  };

  if (normalizedScope === "full") {
    bundle.full = await exportFullStoreTables(store);
  }

  return bundle;
}

export async function importStore(store = createStore(), inputPath, options = {}) {
  if (!inputPath) {
    throw new Error("import-store requires --file <path>");
  }
  const bundle = JSON.parse(await readFile(inputPath, "utf8"));
  const result = await importStoreBundle(store, bundle, options);
  return {
    path: path.resolve(inputPath),
    ...result
  };
}

export async function importStoreFromString(store = createStore(), content, options = {}) {
  if (!String(content || "").trim()) {
    throw new Error("Artifacty backup JSON is required");
  }
  let bundle;
  try {
    bundle = JSON.parse(content);
  } catch (error) {
    throw Object.assign(new Error(`Invalid Artifacty backup JSON: ${error.message}`), {
      statusCode: 400,
      code: "INVALID_BACKUP_JSON"
    });
  }
  return importStoreBundle(store, bundle, options);
}

export async function importStoreBundle(store = createStore(), bundle, { confirm, forceUsers = false } = {}) {
  if (!bundle || typeof bundle !== "object") {
    throw Object.assign(new Error("Invalid Artifacty backup: JSON object expected"), {
      statusCode: 400,
      code: "INVALID_BACKUP"
    });
  }
  if (!Array.isArray(bundle.artifacts)) {
    throw Object.assign(new Error("Invalid Artifacty backup: artifacts array missing"), {
      statusCode: 400,
      code: "INVALID_BACKUP"
    });
  }

  // Bundles written before bundleVersion 2 (roadmap section 13) have no
  // `scope` field; they were always artifacts-only.
  const scope = bundle.scope === "full" ? "full" : "artifacts";
  const warnings = [];

  if (scope === "full") {
    if (confirm !== "replace-all") {
      throw Object.assign(new Error('Full-scope restore requires confirm: "replace-all"'), {
        statusCode: 400,
        code: "confirm_required"
      });
    }
    if (!forceUsers) {
      const existingUsers = await countUsers(store);
      if (existingUsers > 0) {
        throw Object.assign(new Error("Target store already has users; pass forceUsers to overwrite them"), {
          statusCode: 409,
          code: "users_exist"
        });
      }
    }
    // Validate bundle.full's shape *before* writeIndex below replaces the
    // artifacts table and deletes version files: importFullStoreTables runs
    // after that point, and a malformed bundle.full throwing partway
    // through it would otherwise leave the store with the backup's
    // artifacts but the *target's* original users/tokens/comments — an
    // unrecoverable half-restore. This check doesn't guarantee
    // importFullStoreTables can't still fail for other reasons (disk
    // errors, etc.), but it catches the common case of a malformed or
    // hand-edited bundle up front.
    assertValidFullBackupTables(bundle.full);
    if (!Array.isArray(bundle.full?.embeddings)) {
      warnings.push(
        "Backup predates embeddings in full-scope backups; run `artifacty index rebuild --embeddings` after this restore to rebuild semantic search."
      );
    }
  } else {
    // writeIndex's DELETE FROM artifacts cascades to every existing
    // artifact's comments/relations/embeddings (foreign keys, ON DELETE
    // CASCADE) — but an artifacts-scope bundle never carries or restores
    // those tables. Silently wiping a target store's comment/relation
    // history because someone ran an artifacts-only restore would be a
    // surprising, unrecoverable data loss, so refuse unless the caller
    // explicitly opts in the same way a full-scope restore does.
    const dependents = countArtifactDependents(store);
    if (dependents.comments > 0 || dependents.relations > 0) {
      if (confirm !== "replace-all") {
        throw Object.assign(
          new Error(
            'Target store has comments and/or relations that this artifacts-scope restore would delete without restoring equivalents. Pass confirm: "replace-all" to proceed anyway, or use a full-scope backup.'
          ),
          { statusCode: 409, code: "dependents_exist" }
        );
      }
      warnings.push(
        `Target store's ${dependents.comments} comment(s) and ${dependents.relations} relation(s) were deleted by this artifacts-scope restore and are not restored (only a full-scope backup carries them).`
      );
    }
  }

  const index = {
    version: 3,
    artifacts: []
  };

  for (const artifact of bundle.artifacts) {
    const versions = [];
    for (const version of artifact.versions || []) {
      const cleanVersion = { ...version };
      delete cleanVersion.content;
      cleanVersion.path = normalizeBackupRelativePath(cleanVersion.path);
      const content = version.content || "";
      const absolutePath = backupVersionPath(store, cleanVersion.path);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
      versions.push(cleanVersion);
    }
    index.artifacts.push({ ...artifact, versions });
  }

  await writeIndex(store, index);
  await pruneUnreferencedArtifactFiles(store, index);

  const result = {
    artifactCount: index.artifacts.length,
    scope,
    importedAt: new Date().toISOString()
  };
  if (warnings.length > 0) {
    result.warnings = warnings;
  }

  if (scope === "full") {
    result.tableCounts = await importFullStoreTables(store, bundle.full || {}, { forceUsers });
  }

  return result;
}

// Counts the rows an artifacts-scope restore would silently delete (via
// writeIndex's artifacts-table replace cascading through foreign keys) but
// never restores, so importStoreBundle can decide whether to warn/refuse.
function countArtifactDependents(store) {
  const db = openDatabase(store);
  try {
    return {
      comments: db.prepare("SELECT COUNT(*) AS count FROM artifact_comments").get().count,
      relations: db.prepare("SELECT COUNT(*) AS count FROM artifact_relations").get().count
    };
  } finally {
    db.close();
  }
}

const FULL_BACKUP_TABLE_ARRAY_KEYS = [
  "users",
  "apiTokens",
  "auditLog",
  "relations",
  "webhooks",
  "comments",
  "savedViews",
  "embeddings",
  "meta"
];

// Partial, fail-fast validation of a full-scope backup's `full` object,
// aimed at catching the common failure mode (a malformed or hand-edited
// bundle) before writeIndex below has made any changes. Not exhaustive:
// importFullStoreTables (storage.js) remains the source of truth for what
// is actually importable, and can still throw for reasons this doesn't
// check for.
function assertValidFullBackupTables(full) {
  if (full === undefined || full === null) {
    return;
  }
  if (typeof full !== "object" || Array.isArray(full)) {
    throw Object.assign(new Error("Invalid Artifacty backup: `full` must be an object"), {
      statusCode: 400,
      code: "INVALID_BACKUP"
    });
  }
  for (const key of FULL_BACKUP_TABLE_ARRAY_KEYS) {
    if (full[key] !== undefined && !Array.isArray(full[key])) {
      throw Object.assign(new Error(`Invalid Artifacty backup: \`full.${key}\` must be an array`), {
        statusCode: 400,
        code: "INVALID_BACKUP"
      });
    }
  }
  for (const row of full.users || []) {
    if (!row || typeof row !== "object" || !String(row.id || "").trim() || !String(row.email || "").trim()) {
      throw Object.assign(new Error("Invalid Artifacty backup: each `full.users` entry needs an id and email"), {
        statusCode: 400,
        code: "INVALID_BACKUP"
      });
    }
  }
  for (const row of full.apiTokens || []) {
    if (!row || typeof row !== "object" || !String(row.id || "").trim() || !String(row.userId || "").trim()) {
      throw Object.assign(new Error("Invalid Artifacty backup: each `full.apiTokens` entry needs an id and userId"), {
        statusCode: 400,
        code: "INVALID_BACKUP"
      });
    }
  }
}

export function defaultBackupPath(store = createStore()) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(store.home, "backups", `artifacty-${stamp}.json`);
}

function backupVersionPath(store, relativePath) {
  const normalized = normalizeBackupRelativePath(relativePath);
  const root = path.resolve(store.home);
  const absolute = path.resolve(root, ...normalized.split("/"));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw Object.assign(new Error(`Invalid Artifacty backup version path: ${relativePath}`), {
      statusCode: 400,
      code: "INVALID_BACKUP_PATH"
    });
  }
  return absolute;
}

function normalizeBackupRelativePath(relativePath) {
  const value = String(relativePath || "");
  if (!value || path.isAbsolute(value)) {
    throw Object.assign(new Error(`Invalid Artifacty backup version path: ${value}`), {
      statusCode: 400,
      code: "INVALID_BACKUP_PATH"
    });
  }

  const portable = value.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(portable) || portable.startsWith("//")) {
    throw Object.assign(new Error(`Invalid Artifacty backup version path: ${value}`), {
      statusCode: 400,
      code: "INVALID_BACKUP_PATH"
    });
  }

  const parts = portable
    .split("/")
    .filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    throw Object.assign(new Error(`Invalid Artifacty backup version path: ${value}`), {
      statusCode: 400,
      code: "INVALID_BACKUP_PATH"
    });
  }
  return parts.join("/");
}

async function pruneUnreferencedArtifactFiles(store, index) {
  const referenced = new Set();
  for (const artifact of index.artifacts) {
    for (const version of artifact.versions || []) {
      referenced.add(backupVersionPath(store, version.path));
    }
  }

  const files = await listFiles(store.artifactsDir);
  for (const filePath of files) {
    if (!referenced.has(filePath)) {
      await rm(filePath, { force: true });
    }
  }
}

async function listFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(path.resolve(fullPath));
    }
  }
  return files;
}
