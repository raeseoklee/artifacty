import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildStoreBackup, importStoreBundle } from "../src/lib/backup.js";
import { normalizeSourceAgent } from "../src/lib/agents.js";
import { normalizeProvenance, provenanceLabel } from "../src/lib/provenance.js";
import { createArtifact, createStore, getArtifact, updateArtifact, replaceArtifactVersion, deleteArtifactVersion } from "../src/lib/storage.js";

process.env.ARTIFACTY_EMBEDDINGS_PROVIDER = "disabled";

test("agent aliases distinguish tools from model families and providers", () => {
  assert.equal(normalizeSourceAgent("Claude Code"), "claude-code");
  assert.equal(normalizeSourceAgent("codex-cli"), "codex");
  assert.equal(normalizeSourceAgent("Gemini CLI"), "gemini-cli");
  for (const value of ["Claude", "GPT", "Anthropic", "OpenAI", "Google", "Gemini"]) {
    const provenance = normalizeProvenance({ sourceAgent: value });
    assert.equal(provenance.tool, null);
    assert.equal(provenance.rawSourceAgent, value);
    assert.equal(provenance.model, null);
  }
  assert.equal(normalizeSourceAgent("ChatGPT"), "chatgpt");
  assert.equal(normalizeProvenance({ agentContext: { tool: "My custom client" } }).tool, "my-custom-client");
});

test("transport identity and self-reported model have separate evidence", () => {
  const provenance = normalizeProvenance({
    sourceAgent: "Claude", provenance: { tool: "cursor", provider: "Anthropic", model: "model-example", userId: "forged", source: "verified" },
    agentContext: { tool: "Claude Code" }, access: { userId: "actual-user" }
  });
  assert.equal(provenance.tool, "claude-code");
  assert.equal(provenance.userId, "actual-user");
  assert.equal(provenance.toolSource, "mcp-client");
  assert.equal(provenance.modelSource, "self-reported");
  assert.equal(provenanceLabel(provenance), "Claude Code · model-example");
  assert.equal(normalizeProvenance({ provenance: { userId: "forged" } }).userId, null);
});

test("creator and each version retain independent attribution, including repair and deletion", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-provenance-"));
  try {
    const store = createStore({ home });
    const created = await createArtifact(store, { title: "Attribution", content: "one", format: "text", sourceAgent: "Claude Code", provenance: { provider: "Anthropic", model: "first-model" }, audit: { userId: "writer-a" } });
    const updated = await updateArtifact(store, created.id, { content: "two", format: "text", sourceAgent: "codex", provenance: { provider: "OpenAI", model: "second-model", userId: "fake" }, audit: { userId: "writer-b" } });
    assert.deepEqual(updated.createdBy, created.createdBy);
    assert.equal(updated.versions[0].provenance.model, "first-model");
    assert.equal(updated.versions[1].provenance.model, "second-model");
    assert.equal(updated.provenance.userId, "writer-b");
    await replaceArtifactVersion(store, created.id, 1, { content: "repaired", format: "text", provenance: { tool: "cursor" }, reason: "repair fixture" });
    const repaired = await getArtifact(store, created.id);
    assert.deepEqual(repaired.createdBy, created.createdBy);
    assert.equal(repaired.versions[0].provenance.tool, "claude-code");
    await deleteArtifactVersion(store, created.id, 1);
    const deleted = await getArtifact(store, created.id);
    assert.deepEqual(deleted.createdBy, created.createdBy);
    const unknown = await updateArtifact(store, created.id, { content: "three", format: "text" });
    assert.equal(unknown.provenance.tool, null, "must not reuse previous version's author");
    assert.equal(unknown.provenance.model, null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("legacy migration preserves raw ambiguity and never infers a tool from tags", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-provenance-legacy-"));
  try {
    const store = createStore({ home });
    const created = await createArtifact(store, { title: "Legacy", content: "one", format: "text", sourceAgent: "unknown", tags: ["codex"] });
    const unknown = await createArtifact(store, { title: "Unknown", content: "unknown", format: "text", sourceAgent: "unknown", tags: ["codex"] });
    const db = new DatabaseSync(store.dbPath);
    db.prepare("UPDATE artifacts SET source_agent = 'GPT', created_by_json = NULL WHERE id = ?").run(created.id);
    db.prepare("UPDATE artifact_versions SET provenance_json = NULL WHERE artifact_id = ?").run(created.id);
    db.prepare("DELETE FROM audit_log WHERE artifact_id = ?").run(created.id);
    db.prepare("UPDATE artifacts SET created_by_json = NULL WHERE id = ?").run(unknown.id);
    db.prepare("UPDATE artifact_versions SET provenance_json = NULL WHERE artifact_id = ?").run(unknown.id);
    db.prepare("DELETE FROM audit_log WHERE artifact_id = ?").run(unknown.id);
    db.prepare("DELETE FROM meta WHERE key = 'source_agent_normalized_version'").run();
    db.close();
    const migrated = await getArtifact(store, created.id);
    assert.equal(migrated.createdBy.rawSourceAgent, "GPT");
    assert.equal(migrated.createdBy.tool, null);
    assert.equal(migrated.createdBy.source, "legacy");
    assert.equal(migrated.sourceAgent, "gpt");
    assert.deepEqual((await getArtifact(store, created.id)).createdBy, migrated.createdBy);
    const unknownMigrated = await getArtifact(store, unknown.id);
    assert.equal(unknownMigrated.sourceAgent, "unknown");
    assert.equal(unknownMigrated.createdBy.tool, null);
  } finally { await rm(home, { recursive: true, force: true }); }
});


test("backup roundtrip preserves creator and version provenance", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-provenance-backup-"));
  try {
    const source = createStore({ home: path.join(home, "source") });
    const destination = createStore({ home: path.join(home, "destination") });
    const created = await createArtifact(source, { title: "Backup attribution", content: "first", format: "text", sourceAgent: "Claude Code", provenance: { model: "model-a" } });
    const updated = await updateArtifact(source, created.id, { content: "second", format: "text", sourceAgent: "codex", provenance: { model: "model-b" } });
    await importStoreBundle(destination, await buildStoreBackup(source), { confirm: "replace-all" });
    const restored = await getArtifact(destination, created.id);
    assert.deepEqual(restored.createdBy, updated.createdBy);
    assert.deepEqual(restored.versions.map((version) => version.provenance), updated.versions.map((version) => version.provenance));
  } finally { await rm(home, { recursive: true, force: true }); }
});
