import { archiveArtifact, createArtifact, ForbiddenError, openDatabase, restoreArtifact } from "./storage.js";
import { sampleCatalog } from "./sample-content.js";

const SAMPLE_NAMESPACE = "artifacty-manuals-v1";

function managedSamples(store, access) {
  const db = openDatabase(store);
  try {
    const accountCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    if (access && accountCount) {
      const user = db.prepare("SELECT role, active FROM users WHERE id = ?").get(access.userId || "");
      if (!user?.active || user.role !== "admin") {
        throw new ForbiddenError("Only active administrators may manage sample artifacts");
      }
    }
    const scope = access?.userId || "local";
    // The installation marker lives in the first immutable version: editing a
    // manual must neither lose its managed identity nor overwrite user work.
    const rows = db.prepare(`
      SELECT artifacts.id, artifacts.archived_at, artifact_versions.metadata_json
      FROM artifacts JOIN artifact_versions ON artifact_versions.artifact_id = artifacts.id
      WHERE artifact_versions.version = 1
    `).all();
    const samples = rows.flatMap((row) => {
      const marker = JSON.parse(row.metadata_json).artifactySample;
      return marker?.namespace === SAMPLE_NAMESPACE && marker.scope === scope
        ? [{ id: row.id, archivedAt: row.archived_at, key: marker.key }] : [];
    });
    return { samples, scope };
  } finally {
    db.close();
  }
}

export async function installSamples(store, { access, audit, catalog = sampleCatalog } = {}) {
  const { samples, scope } = managedSamples(store, access);
  const result = { installed: 0, restored: 0, skipped: 0, artifactIds: [] };
  for (const entry of catalog) {
    const existing = samples.find((sample) => sample.key === entry.key);
    if (existing) {
      if (existing.archivedAt) {
        await restoreArtifact(store, existing.id, { access, audit });
        result.restored += 1;
      } else {
        result.skipped += 1;
      }
      result.artifactIds.push(existing.id);
      continue;
    }
    const artifact = await createArtifact(store, {
      ...entry,
      sourceAgent: "generic",
      access,
      audit,
      metadata: { ...entry.metadata, artifactySample: { namespace: SAMPLE_NAMESPACE, scope, key: entry.key } }
    });
    samples.push({ id: artifact.id, key: entry.key, archivedAt: null });
    result.installed += 1;
    result.artifactIds.push(artifact.id);
  }
  return result;
}

export async function removeSamples(store, { access, audit } = {}) {
  const { samples } = managedSamples(store, access);
  const result = { archived: 0, artifactIds: [] };
  for (const sample of samples) {
    if (sample.archivedAt) continue;
    await archiveArtifact(store, sample.id, { access, audit, action: "samples-remove" });
    result.archived += 1;
    result.artifactIds.push(sample.id);
  }
  return result;
}
