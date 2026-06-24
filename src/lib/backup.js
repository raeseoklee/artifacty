import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createStore, loadIndex, writeIndex } from "./storage.js";

export async function exportStore(store = createStore(), outputPath) {
  if (!outputPath) {
    throw new Error("export requires --file <path>");
  }
  const index = await loadIndex(store);
  const artifacts = [];
  for (const artifact of index.artifacts) {
    const versions = [];
    for (const version of artifact.versions) {
      versions.push({
        ...version,
        content: await readFile(path.join(store.home, version.path), "utf8")
      });
    }
    artifacts.push({ ...artifact, versions });
  }

  const bundle = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    artifacts
  };
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return {
    path: path.resolve(outputPath),
    artifactCount: artifacts.length,
    exportedAt: bundle.exportedAt
  };
}

export async function importStore(store = createStore(), inputPath) {
  if (!inputPath) {
    throw new Error("import-store requires --file <path>");
  }
  const bundle = JSON.parse(await readFile(inputPath, "utf8"));
  if (!Array.isArray(bundle.artifacts)) {
    throw new Error("Invalid Artifacty backup: artifacts array missing");
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
      const content = version.content || "";
      const absolutePath = path.join(store.home, cleanVersion.path);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
      versions.push(cleanVersion);
    }
    index.artifacts.push({ ...artifact, versions });
  }

  await writeIndex(store, index);
  return {
    path: path.resolve(inputPath),
    artifactCount: index.artifacts.length,
    importedAt: new Date().toISOString()
  };
}

export function defaultBackupPath(store = createStore()) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(store.home, "backups", `artifacty-${stamp}.json`);
}
