import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpRequestHandler } from "../src/mcp-server.js";
import { createStore, createUser, createArtifact, getArtifact } from "../src/lib/storage.js";

process.env.ARTIFACTY_EMBEDDINGS_PROVIDER = "disabled";
const call = (handler, name, args = {}) => handler({ method: "tools/call", params: { name, arguments: args } });

test("MCP collection tools create, pin and append with concurrency protection", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-collection-"));
  try {
    const store = createStore({ home });
    const handler = createMcpRequestHandler({ store });
    await handler({ method: "initialize", params: { clientInfo: { name: "Claude Code" } } });
    const child = (await call(handler, "artifacty_create", { title: "Report", content: "first", format: "markdown", provenance: { tool: "cursor", provider: "Anthropic", model: "example-model", userId: "spoof" } })).structuredContent;
    assert.equal(child.createdBy.tool, "claude-code");
    assert.equal(child.createdBy.toolSource, "mcp-client");
    assert.equal(child.createdBy.modelSource, "self-reported");
    assert.equal(child.createdBy.userId, null);
    const sections = [{ id: "report", title: "Report", items: [{ artifactId: child.id, version: 1, display: "inline" }] }];
    const created = await call(handler, "artifacty_collection_create", { title: "Handbook", description: "Introduction", sections });
    assert.equal(created.isError, false);
    const collection = created.structuredContent;
    assert.equal(collection.version.format, "collection");
    assert.equal(JSON.parse(collection.content).sections[0].items[0].version, 1);
    const updated = await call(handler, "artifacty_collection_update", { id: collection.id, sections, expectedVersion: 1 });
    assert.equal(updated.isError, false);
    assert.equal(updated.structuredContent.latestVersion, 2);
    assert.equal((await call(handler, "artifacty_collection_update", { id: collection.id, sections, expectedVersion: 1 })).structuredContent.code, "version_conflict");
    assert.equal((await call(handler, "artifacty_collection_update", { id: child.id, sections, expectedVersion: 1 })).isError, true);
    assert.equal((await call(handler, "artifacty_collection_create", { title: "Invalid", sections: [{ id: "a", title: "a", items: [{ artifactId: child.id, version: 0 }] }] })).isError, true);
    const other = createMcpRequestHandler({ store });
    const result = await call(other, "artifacty_update", { id: child.id, content: "second", format: "text", provenance: { tool: "codex" } });
    assert.equal(result.structuredContent.createdBy.tool, "claude-code");
    assert.equal(result.structuredContent.provenance.tool, "codex");
    assert.equal(result.structuredContent.provenance.source, "self-reported");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("MCP collection reads and raw resources hide restricted child identifiers", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-collection-private-"));
  try {
    const store = createStore({ home });
    const owner = await createUser(store, { email: "owner@example.test", password: "test-password-owner", role: "admin" });
    const reader = await createUser(store, { email: "reader@example.test", password: "test-password-reader", role: "user" });
    const child = await createArtifact(store, { title: "Restricted secret title", content: "Secret content", visibility: "private", ownerUserId: owner.id });
    const collection = await createArtifact(store, { title: "Shared page", ownerUserId: reader.id, format: "collection", artifactType: "collection", visibility: "public", content: JSON.stringify({ sections: [{ id: "a", title: "References", items: [{ artifactId: child.id }] }] }) });
    const handler = createMcpRequestHandler({ store, auth: { type: "api-token", user: reader, scopes: ["read"] } });
    const read = await call(handler, "artifacty_get", { id: collection.id });
    assert.equal(read.isError, false);
    assert.equal(JSON.stringify(read).includes(child.id), false);
    assert.deepEqual(JSON.parse(read.structuredContent.content).sections[0].items, []);
    for (const uri of [`artifacty://artifacts/${collection.id}`, `artifacty://artifacts/${collection.id}/raw`]) {
      const result = await handler({ method: "resources/read", params: { uri } });
      assert.equal(JSON.stringify(result).includes(child.id), false);
    }
    const diff = await call(handler, "artifacty_diff", { id: collection.id, from: 1, to: 1 });
    assert.equal(JSON.stringify(diff).includes(child.id), false);
    const writer = createMcpRequestHandler({ store, auth: { type: "api-token", user: reader, scopes: ["read", "write"] } });
    const unsafeUpdate = await call(writer, "artifacty_update", { id: collection.id, format: "collection", content: read.structuredContent.content });
    assert.equal(unsafeUpdate.structuredContent.code, "COLLECTION_REFERENCES_UNAVAILABLE");
    const listed = await handler({ method: "tools/list" });
    assert.equal(listed.tools.some((tool) => tool.name === "artifacty_collection_create"), false);
    assert.equal((await call(handler, "artifacty_collection_create", { title: "Forbidden", sections: [] })).isError, true);
    assert.equal(JSON.parse((await getArtifact(store, collection.id)).content).sections[0].items[0].artifactId, child.id, "read redaction must not mutate persisted references");
    const recovered = await call(writer, "artifacty_collection_update", { id: collection.id, expectedVersion: 1, sections: JSON.parse(read.structuredContent.content).sections, dropUnavailableReferences: true });
    assert.equal(recovered.isError, false);
    assert.equal(recovered.structuredContent.latestVersion, 2);
    assert.equal(JSON.parse((await getArtifact(store, collection.id, { version: 1 })).content).sections[0].items[0].artifactId, child.id);

  } finally { await rm(home, { recursive: true, force: true }); }
});
