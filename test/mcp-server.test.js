import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { awaitEmbeddingIndexing, createArtifact, createSavedView, createStore } from "../src/lib/storage.js";
import { writeServerState } from "../src/lib/server-state.js";
import { startServer } from "../src/server.js";
import { createMcpRequestHandler } from "../src/mcp-server.js";

test("initialize negotiates the protocol version for old and unrecognized clients", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-negotiate-"));
  const handler = createMcpRequestHandler({ store: createStore({ home }) });
  try {
    const withOldVersion = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old-client", version: "0.0.0" } }
    });
    assert.equal(withOldVersion.protocolVersion, "2025-06-18");

    const withNewerVersion = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "future-client", version: "0.0.0" } }
    });
    // We only confirmed "2025-06-18" against the public MCP spec at the time
    // of this change, so an unrecognized (older or newer) requested version
    // falls back to our newest supported version rather than erroring.
    assert.equal(withNewerVersion.protocolVersion, "2025-06-18");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifacty_link, artifacty_unlink, relations on get/list, and the graph resource", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-relations-"));
  const handler = createMcpRequestHandler({ store: createStore({ home }), publicBaseUrl: "http://127.0.0.1:8787" });
  try {
    const a = await handler({
      method: "tools/call",
      params: { name: "artifacty_create", arguments: { title: "A", content: "a" } }
    });
    const b = await handler({
      method: "tools/call",
      params: {
        name: "artifacty_create",
        arguments: {
          title: "B",
          content: "b",
          relations: [{ toId: a.structuredContent.id, relation: "derived-from" }]
        }
      }
    });

    const bGet = await handler({
      method: "tools/call",
      params: { name: "artifacty_get", arguments: { id: b.structuredContent.id } }
    });
    assert.equal(bGet.structuredContent.relations.outgoing.length, 1);
    assert.equal(bGet.structuredContent.relations.outgoing[0].relation, "derived-from");
    assert.equal(bGet.structuredContent.relations.outgoing[0].artifactId, a.structuredContent.id);

    const link = await handler({
      method: "tools/call",
      params: {
        name: "artifacty_link",
        arguments: { id: b.structuredContent.id, toId: a.structuredContent.id, relation: "references" }
      }
    });
    assert.equal(link.isError, false);
    assert.equal(link.structuredContent.relation, "references");

    const list = await handler({
      method: "tools/call",
      params: { name: "artifacty_list", arguments: { relatedTo: a.structuredContent.id } }
    });
    assert.equal(list.structuredContent.artifacts.length, 1);
    assert.equal(list.structuredContent.artifacts[0].id, b.structuredContent.id);

    const listByRelation = await handler({
      method: "tools/call",
      params: { name: "artifacty_list", arguments: { relatedTo: a.structuredContent.id, relation: "supersedes" } }
    });
    assert.equal(listByRelation.structuredContent.artifacts.length, 0);

    const graph = await handler({
      method: "resources/read",
      params: { uri: `artifacty://artifacts/${encodeURIComponent(a.structuredContent.id)}/graph` }
    });
    const graphBody = JSON.parse(graph.contents[0].text);
    assert.equal(graphBody.rootId, a.structuredContent.id);
    assert.ok(graphBody.nodes.some((node) => node.id === b.structuredContent.id));
    assert.ok(graphBody.edges.some((edge) =>
      edge.from === b.structuredContent.id && edge.to === a.structuredContent.id && edge.relation === "derived-from"));
    assert.ok(graphBody.edges.some((edge) =>
      edge.from === b.structuredContent.id && edge.to === a.structuredContent.id && edge.relation === "references"));

    const unlink = await handler({
      method: "tools/call",
      params: {
        name: "artifacty_unlink",
        arguments: { id: b.structuredContent.id, toId: a.structuredContent.id, relation: "references" }
      }
    });
    assert.equal(unlink.isError, false);
    assert.equal(unlink.structuredContent.relation, "references");

    const invalidRelation = await handler({
      method: "tools/call",
      params: {
        name: "artifacty_link",
        arguments: { id: b.structuredContent.id, toId: a.structuredContent.id, relation: "not-a-relation" }
      }
    });
    assert.equal(invalidRelation.isError, true);
    assert.equal(invalidRelation.structuredContent.code, "INVALID_RELATION");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifacty_comment, artifacty_resolve_comment, artifacty_set_review_status, and artifacty_get includeComments", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-comments-"));
  const handler = createMcpRequestHandler({ store: createStore({ home }), publicBaseUrl: "http://127.0.0.1:8787" });
  try {
    const created = await handler({
      method: "tools/call",
      params: { name: "artifacty_create", arguments: { title: "Doc", content: "hello" } }
    });
    const id = created.structuredContent.id;

    const withoutComments = await handler({
      method: "tools/call",
      params: { name: "artifacty_get", arguments: { id } }
    });
    assert.equal(withoutComments.structuredContent.comments, undefined);

    const commentResult = await handler({
      method: "tools/call",
      params: { name: "artifacty_comment", arguments: { id, body: "Please add a test.", anchor: { line: 3 } } }
    });
    assert.equal(commentResult.isError, false);
    assert.equal(commentResult.structuredContent.status, "open");
    assert.deepEqual(commentResult.structuredContent.anchor, { line: 3 });
    const commentId = commentResult.structuredContent.id;

    const withComments = await handler({
      method: "tools/call",
      params: { name: "artifacty_get", arguments: { id, includeComments: true } }
    });
    assert.equal(withComments.structuredContent.comments.length, 1);
    assert.equal(withComments.structuredContent.comments[0].id, commentId);

    const resolveResult = await handler({
      method: "tools/call",
      params: { name: "artifacty_resolve_comment", arguments: { id, commentId } }
    });
    assert.equal(resolveResult.isError, false);
    assert.equal(resolveResult.structuredContent.status, "resolved");

    const afterResolve = await handler({
      method: "tools/call",
      params: { name: "artifacty_get", arguments: { id, includeComments: true } }
    });
    assert.equal(afterResolve.structuredContent.comments.length, 0);

    const reviewStatusResult = await handler({
      method: "tools/call",
      params: { name: "artifacty_set_review_status", arguments: { id, status: "changes-requested" } }
    });
    assert.equal(reviewStatusResult.isError, false);
    assert.equal(reviewStatusResult.structuredContent.reviewStatus, "changes-requested");

    const invalidStatus = await handler({
      method: "tools/call",
      params: { name: "artifacty_set_review_status", arguments: { id, status: "not-a-status" } }
    });
    assert.equal(invalidStatus.isError, true);
    assert.equal(invalidStatus.structuredContent.code, "INVALID_REVIEW_STATUS");

    const missingParent = await handler({
      method: "tools/call",
      params: { name: "artifacty_comment", arguments: { id, body: "reply", parentId: "missing-comment" } }
    });
    assert.equal(missingParent.isError, true);
    assert.equal(missingParent.structuredContent.code, "COMMENT_NOT_FOUND");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifacty_list accepts the new dashboard filters and expands a saved view via `view`, with explicit args overriding it", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-list-filters-"));
  const store = createStore({ home });
  const handler = createMcpRequestHandler({ store, publicBaseUrl: "http://127.0.0.1:8787" });
  try {
    const handoff = await handler({
      method: "tools/call",
      params: { name: "artifacty_create", arguments: { title: "Handoff", content: "a", artifactType: "handoff" } }
    });
    const doc = await handler({
      method: "tools/call",
      params: { name: "artifacty_create", arguments: { title: "Doc", content: "b", artifactType: "document" } }
    });

    const byType = await handler({
      method: "tools/call",
      params: { name: "artifacty_list", arguments: { artifactType: "handoff" } }
    });
    assert.equal(byType.structuredContent.artifacts.length, 1);
    assert.equal(byType.structuredContent.artifacts[0].id, handoff.structuredContent.id);

    const invalidDate = await handler({
      method: "tools/call",
      params: { name: "artifacty_list", arguments: { createdAfter: "not-a-date" } }
    });
    assert.equal(invalidDate.isError, true);
    assert.equal(invalidDate.structuredContent.code, "invalid_filter");

    const view = await createSavedView(store, { name: "Handoffs Only", filters: { artifactType: "handoff" } });

    const expanded = await handler({
      method: "tools/call",
      params: { name: "artifacty_list", arguments: { view: view.id } }
    });
    assert.equal(expanded.structuredContent.artifacts.length, 1);
    assert.equal(expanded.structuredContent.artifacts[0].id, handoff.structuredContent.id);

    const overridden = await handler({
      method: "tools/call",
      params: { name: "artifacty_list", arguments: { view: view.id, artifactType: "document" } }
    });
    assert.equal(overridden.structuredContent.artifacts.length, 1);
    assert.equal(overridden.structuredContent.artifacts[0].id, doc.structuredContent.id);

    const byName = await handler({
      method: "tools/call",
      params: { name: "artifacty_list", arguments: { view: "handoffs only" } }
    });
    assert.equal(byName.structuredContent.artifacts.length, 1);

    const unknownView = await handler({
      method: "tools/call",
      params: { name: "artifacty_list", arguments: { view: "does-not-exist" } }
    });
    assert.equal(unknownView.structuredContent.artifacts.length, 2, "an unresolvable view name falls back to no extra filters");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifacty_list mode and artifacty_info embeddings reflect a configured embedding provider", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-mode-"));
  const store = createStore({ home });
  const handler = createMcpRequestHandler({ store, publicBaseUrl: "http://127.0.0.1:8787" });
  const previousCommand = process.env.ARTIFACTY_EMBEDDINGS_COMMAND;
  try {
    const infoWithoutProvider = await handler({
      method: "tools/call",
      params: { name: "artifacty_info", arguments: {} }
    });
    assert.equal(infoWithoutProvider.structuredContent.embeddings, null);

    await handler({
      method: "tools/call",
      params: { name: "artifacty_create", arguments: { title: "Deploy report", content: "deploy failed", sourceAgent: "test" } }
    });

    const fallback = await handler({
      method: "tools/call",
      params: { name: "artifacty_list", arguments: { query: "deploy", mode: "semantic" } }
    });
    assert.equal(fallback.structuredContent.search.mode, "keyword");
    assert.equal(fallback.structuredContent.search.fallback, true);

    process.env.ARTIFACTY_EMBEDDINGS_COMMAND = `${process.execPath} ${JSON.stringify(path.resolve("scripts/fixtures/embeddings-command.js"))}`;
    // Publishing above already scheduled background indexing without a
    // provider (a no-op); create a second artifact now that a provider is
    // configured so it gets embedded, then wait for the scheduled indexing.
    await handler({
      method: "tools/call",
      params: { name: "artifacty_create", arguments: { title: "Deploy retry", content: "deploy failed again", sourceAgent: "test" } }
    });
    await awaitEmbeddingIndexing();

    const infoWithProvider = await handler({
      method: "tools/call",
      params: { name: "artifacty_info", arguments: {} }
    });
    assert.equal(infoWithProvider.structuredContent.embeddings.provider, "command");

    const semantic = await handler({
      method: "tools/call",
      params: { name: "artifacty_list", arguments: { query: "deploy", mode: "semantic" } }
    });
    assert.equal(semantic.structuredContent.search.mode, "semantic");
  } finally {
    if (previousCommand === undefined) {
      delete process.env.ARTIFACTY_EMBEDDINGS_COMMAND;
    } else {
      process.env.ARTIFACTY_EMBEDDINGS_COMMAND = previousCommand;
    }
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("mcp server initializes and exposes artifact tools", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-"));
  await writeServerState(createStore({ home }), {
    url: "http://127.0.0.1:18888",
    host: "127.0.0.1",
    port: 18888,
    requestedPort: 8787,
    portFallback: true
  });
  const childEnv = {
    ...process.env,
    ARTIFACTY_HOME: home
  };
  delete childEnv.ARTIFACTY_URL;
  const child = spawn(process.execPath, ["src/mcp-server.js"], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const client = createLineClient(child);
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" }
    });
    assert.equal(init.protocolVersion, "2025-06-18");
    assert.equal(init.capabilities.resources.subscribe, true);
    assert.equal(init.capabilities.resources.listChanged, true);
    assert.equal(init.capabilities.prompts.listChanged, false);

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const listedTools = await client.request("tools/list", {});
    assert.ok(listedTools.tools.some((tool) => tool.name === "artifacty_create"));
    assert.ok(listedTools.tools.some((tool) => tool.name === "artifacty_publish"));
    assert.ok(listedTools.tools.some((tool) => tool.name === "artifacty_archive"));
    assert.ok(listedTools.tools.some((tool) => tool.name === "artifacty_restore"));
    assert.ok(listedTools.tools.some((tool) => tool.name === "artifacty_audit"));
    assert.ok(listedTools.tools.some((tool) => tool.name === "artifacty_link"));
    assert.ok(listedTools.tools.some((tool) => tool.name === "artifacty_unlink"));
    const createTool = listedTools.tools.find((tool) => tool.name === "artifacty_create");
    assert.ok(createTool.inputSchema.properties.format.enum.includes("code"));
    assert.ok(createTool.inputSchema.properties.format.enum.includes("svg"));
    assert.ok(createTool.inputSchema.properties.format.enum.includes("mermaid"));
    assert.ok(createTool.inputSchema.properties.format.enum.includes("react"));
    assert.ok(createTool.inputSchema.properties.format.enum.includes("sarif"));
    assert.ok(createTool.inputSchema.properties.format.enum.includes("csv"));
    assert.ok(createTool.inputSchema.properties.format.enum.includes("image"));
    assert.ok(createTool.inputSchema.properties.format.enum.includes("video"));
    assert.ok(createTool.inputSchema.properties.format.enum.includes("notebook"));
    assert.ok(createTool.inputSchema.properties.artifactType.enum.includes("diagram"));
    assert.ok(createTool.inputSchema.properties.artifactType.enum.includes("component"));
    assert.ok(createTool.inputSchema.properties.artifactType.enum.includes("snippet"));
    assert.ok(createTool.inputSchema.properties.artifactType.enum.includes("analysis-report"));
    assert.ok(createTool.inputSchema.properties.artifactType.enum.includes("table"));
    const importTool = listedTools.tools.find((tool) => tool.name === "artifacty_import");
    assert.ok(importTool.inputSchema.properties.agent.enum.includes("copilot"));
    assert.ok(importTool.inputSchema.properties.agent.enum.includes("cursor"));

    for (const tool of listedTools.tools) {
      assert.ok(tool.outputSchema, `expected outputSchema on tool ${tool.name}`);
      assert.equal(tool.outputSchema.type, "object");
    }

    const listedResources = await client.request("resources/list", {});
    assert.ok(listedResources.resources.some((resource) => resource.uri === "artifacty://recent"));
    assert.ok(listedResources.resources.some((resource) => resource.uri === "artifacty://schema/v1"));

    const listedTemplates = await client.request("resources/templates/list", {});
    assert.ok(listedTemplates.resourceTemplates.some((resource) => resource.uriTemplate === "artifacty://artifacts/{id}"));
    assert.ok(listedTemplates.resourceTemplates.some((resource) => resource.uriTemplate === "artifacty://artifacts/{id}/raw{?version}"));
    assert.ok(listedTemplates.resourceTemplates.some((resource) => resource.uriTemplate === "artifacty://artifacts/{id}/graph"));

    const listedPrompts = await client.request("prompts/list", {});
    assert.ok(listedPrompts.prompts.some((prompt) => prompt.name === "artifacty_handoff"));
    assert.ok(listedPrompts.prompts.some((prompt) => prompt.name === "artifacty_release_notes"));

    const info = await client.request("tools/call", {
      name: "artifacty_info",
      arguments: {}
    });
    assert.equal(info.structuredContent.url, "http://127.0.0.1:18888");
    assert.equal(info.structuredContent.openApiUrl, "http://127.0.0.1:18888/openapi.json");
    assert.deepEqual(info.structuredContent.supportedProtocolVersions, ["2025-06-18"]);

    const published = await client.request("tools/call", {
      name: "artifacty_create",
      arguments: {
        title: "MCP Demo",
        content: "hello",
        format: "text",
        artifactType: "document",
        sourceAgent: "test"
      }
    });
    assert.equal(published.isError, false);
    const id = published.structuredContent.id;
    assert.match(published.structuredContent.url, /^http:\/\/127\.0\.0\.1:18888\/artifacts\//);

    const fetched = await client.request("tools/call", {
      name: "artifacty_get",
      arguments: { id }
    });
    assert.equal(fetched.structuredContent.content, "hello");
    assert.equal(fetched.structuredContent.schemaVersion, 1);

    const recentResource = await client.request("resources/read", {
      uri: "artifacty://recent"
    });
    const recent = JSON.parse(recentResource.contents[0].text);
    assert.ok(recent.artifacts.some((artifact) => artifact.id === id));
    assert.equal(recent.artifacts[0].url.startsWith("http://127.0.0.1:18888/"), true);

    const artifactResource = await client.request("resources/read", {
      uri: `artifacty://artifacts/${encodeURIComponent(id)}`
    });
    const resourceArtifact = JSON.parse(artifactResource.contents[0].text);
    assert.equal(resourceArtifact.id, id);
    assert.equal(resourceArtifact.content, "hello");

    const rawResource = await client.request("resources/read", {
      uri: `artifacty://artifacts/${encodeURIComponent(id)}/raw`
    });
    assert.equal(rawResource.contents[0].mimeType, "text/plain; charset=utf-8");
    assert.equal(rawResource.contents[0].text, "hello");

    const schemaResource = await client.request("resources/read", {
      uri: "artifacty://schema/v1"
    });
    assert.match(schemaResource.contents[0].text, /# Artifact Schema v1/);

    const handoffPrompt = await client.request("prompts/get", {
      name: "artifacty_handoff",
      arguments: { artifactId: id, goal: "Continue implementation" }
    });
    assert.match(handoffPrompt.messages[0].content.text, /artifacty:\/\/artifacts\//);
    assert.match(handoffPrompt.messages[0].content.text, /Continue implementation/);

    const codeArtifact = await client.request("tools/call", {
      name: "artifacty_create",
      arguments: {
        title: "MCP Snippet",
        content: "console.log('mcp');",
        format: "code",
        artifactType: "snippet",
        sourceAgent: "codex"
      }
    });
    assert.equal(codeArtifact.isError, false);
    assert.equal(codeArtifact.structuredContent.version.format, "code");
    assert.equal(codeArtifact.structuredContent.artifactType, "snippet");

    const archived = await client.request("tools/call", {
      name: "artifacty_archive",
      arguments: { id }
    });
    assert.ok(archived.structuredContent.archivedAt);

    const restored = await client.request("tools/call", {
      name: "artifacty_restore",
      arguments: { id }
    });
    assert.equal(restored.structuredContent.archivedAt, null);

    const imported = await client.request("tools/call", {
      name: "artifacty_import",
      arguments: {
        agent: "gemini",
        payload: {
          title: "Gemini result",
          returnDisplay: "# Result"
        }
      }
    });
    assert.equal(imported.isError, false);
    assert.equal(imported.structuredContent.title, "Gemini result");
    assert.equal(imported.structuredContent.version.format, "markdown");

    const audit = await client.request("tools/call", {
      name: "artifacty_audit",
      arguments: { artifactId: id, limit: 10 }
    });
    assert.ok(audit.structuredContent.events.some((event) => event.action === "create"));
    assert.ok(audit.structuredContent.events.some((event) => event.action === "read"));
  } finally {
    child.kill("SIGTERM");
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifacty_update input schema documents expectedVersion and returns a version_conflict tool error", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-concurrency-"));
  const store = createStore({ home });
  const handler = createMcpRequestHandler({ store });
  try {
    const listedTools = await handler({ method: "tools/list" });
    const updateTool = listedTools.tools.find((tool) => tool.name === "artifacty_update");
    assert.equal(updateTool.inputSchema.properties.expectedVersion.type, "number");
    const getTool = listedTools.tools.find((tool) => tool.name === "artifacty_get");
    assert.match(getTool.description, /expectedVersion/);
    assert.match(updateTool.description, /expectedVersion/);

    const created = await createArtifact(store, {
      title: "MCP Concurrent",
      content: "v1",
      format: "text",
      sourceAgent: "test"
    });

    const okUpdate = await handler({
      method: "tools/call",
      params: {
        name: "artifacty_update",
        arguments: { id: created.id, content: "v2", format: "text", expectedVersion: 1 }
      }
    });
    assert.equal(okUpdate.isError, false);
    assert.equal(okUpdate.structuredContent.latestVersion, 2);

    const conflict = await handler({
      method: "tools/call",
      params: {
        name: "artifacty_update",
        arguments: { id: created.id, content: "v3-conflict", format: "text", expectedVersion: 1 }
      }
    });
    assert.equal(conflict.isError, true);
    assert.match(conflict.content[0].text, /conflict/i);
    assert.equal(conflict.structuredContent.code, "version_conflict");
    assert.equal(conflict.structuredContent.latestVersion, 2);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("artifacty_diff returns unified text and structured content, defaulting to the latest two versions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-diff-"));
  const store = createStore({ home });
  const handler = createMcpRequestHandler({ store });
  try {
    const listedTools = await handler({ method: "tools/list" });
    const diffTool = listedTools.tools.find((tool) => tool.name === "artifacty_diff");
    assert.ok(diffTool, "expected an artifacty_diff tool");
    assert.deepEqual(diffTool.inputSchema.required, ["id"]);
    assert.ok(diffTool.outputSchema);

    const created = await createArtifact(store, {
      title: "MCP Diff",
      content: JSON.stringify({ a: 1 }),
      format: "json",
      sourceAgent: "test"
    });

    // A single-version artifact diffs version 1 against itself (from defaults
    // to max(1, latestVersion - 1)).
    const singleVersionDiff = await handler({
      method: "tools/call",
      params: { name: "artifacty_diff", arguments: { id: created.id } }
    });
    assert.equal(singleVersionDiff.isError, false);
    assert.equal(singleVersionDiff.structuredContent.from, 1);
    assert.equal(singleVersionDiff.structuredContent.to, 1);

    const { updateArtifact } = await import("../src/lib/storage.js");
    await updateArtifact(store, created.id, {
      content: JSON.stringify({ a: 2 }),
      format: "json"
    });

    const diffResult = await handler({
      method: "tools/call",
      params: { name: "artifacty_diff", arguments: { id: created.id } }
    });
    assert.equal(diffResult.isError, false);
    assert.equal(diffResult.structuredContent.from, 1);
    assert.equal(diffResult.structuredContent.to, 2);
    assert.equal(diffResult.structuredContent.view, "structured");
    assert.equal(diffResult.structuredContent.format, "json");
    assert.equal(diffResult.structuredContent.structuredDiff.kind, "json");
    const changed = diffResult.structuredContent.structuredDiff.entries.find((entry) => entry.op === "changed");
    assert.ok(changed);
    assert.equal(changed.path, "$.a");
    assert.equal(changed.before, 1);
    assert.equal(changed.after, 2);
    assert.match(diffResult.content[0].text, /\$\.a/);

    const explicitLines = await handler({
      method: "tools/call",
      params: { name: "artifacty_diff", arguments: { id: created.id, view: "lines" } }
    });
    assert.equal(explicitLines.structuredContent.view, "lines");
    assert.equal(explicitLines.structuredContent.structuredDiff.kind, "lines");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("stdio MCP bridge forwards calls to a central HTTP MCP endpoint", async () => {
  const centralHome = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-central-"));
  const bridgeHome = await mkdtemp(path.join(tmpdir(), "artifacty-mcp-bridge-"));
  const app = await startServer({
    port: 0,
    home: centralHome,
    apiToken: "bridge-token",
    mcpHttp: true
  });
  const child = spawn(process.execPath, ["src/mcp-server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ARTIFACTY_HOME: bridgeHome,
      ARTIFACTY_MCP_MODE: "bridge",
      ARTIFACTY_MCP_URL: `${app.url}/mcp`,
      ARTIFACTY_API_TOKEN: "bridge-token"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const client = createLineClient(child);
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bridge-test", version: "0.0.0" }
    });
    assert.equal(init.protocolVersion, "2025-06-18");

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const created = await client.request("tools/call", {
      name: "artifacty_create",
      arguments: {
        title: "Bridge Demo",
        content: "shared",
        format: "text",
        sourceAgent: "bridge-test"
      }
    });
    assert.equal(created.isError, false);
    assert.match(created.structuredContent.url, new RegExp(`^${escapeRegExp(app.url)}/artifacts/`));

    const id = created.structuredContent.id;
    const fetched = await client.request("tools/call", {
      name: "artifacty_get",
      arguments: { id }
    });
    assert.equal(fetched.structuredContent.content, "shared");

    const centralRead = await fetch(`${app.url}/api/artifacts/${encodeURIComponent(id)}`, {
      headers: { "x-artifacty-token": "bridge-token" }
    });
    assert.equal(centralRead.status, 200);
    assert.equal((await centralRead.json()).content, "shared");

    const info = await client.request("tools/call", {
      name: "artifacty_info",
      arguments: {}
    });
    assert.equal(info.structuredContent.transport, "streamable-http");
    assert.equal(info.structuredContent.url, app.url);
  } finally {
    child.kill("SIGTERM");
    await app.close();
    await rm(centralHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(bridgeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function createLineClient(child) {
  let nextId = 1;
  const pending = new Map();
  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        const message = JSON.parse(line);
        const resolver = pending.get(message.id);
        if (resolver) {
          pending.delete(message.id);
          if (message.error) {
            resolver.reject(new Error(message.error.message));
          } else {
            resolver.resolve(message.result);
          }
        }
      }
      newline = buffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;
      const message = {
        jsonrpc: "2.0",
        id,
        method,
        params
      };

      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return promise;
    }
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
