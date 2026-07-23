import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createStore, loadIndex, writeIndex } from "./storage.js";

export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;

export async function exportStore(store = createStore(), outputPath) {
  if (!outputPath) {
    throw new Error("export requires --file <path>");
  }
  const bundle = await buildStoreBackup(store);
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return {
    path: path.resolve(outputPath),
    artifactCount: bundle.artifacts.length,
    exportedAt: bundle.exportedAt
  };
}

export async function exportStoreToString(store = createStore()) {
  const bundle = await buildStoreBackup(store);
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export async function buildStoreBackup(store = createStore()) {
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

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    artifacts
  };
}

export async function importStore(store = createStore(), inputPath) {
  if (!inputPath) {
    throw new Error("import-store requires --file <path>");
  }
  const bundle = JSON.parse(await readFile(inputPath, "utf8"));
  const result = await importStoreBundle(store, bundle);
  return {
    path: path.resolve(inputPath),
    ...result
  };
}

export async function importStoreFromString(store = createStore(), content) {
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
  return importStoreBundle(store, bundle);
}

export async function importStoreBundle(store = createStore(), bundle) {
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
  return {
    artifactCount: index.artifacts.length,
    importedAt: new Date().toISOString()
  };
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
