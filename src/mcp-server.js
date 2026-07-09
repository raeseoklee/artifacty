#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_FORMATS,
  ARTIFACT_TYPES,
  archiveArtifact,
  createArtifact,
  createStore,
  getArtifact,
  listAuditEvents,
  listArtifactsPage,
  restoreArtifact,
  updateArtifact
} from "./lib/storage.js";
import { convertAgentArtifact } from "./lib/converters.js";
import { resolvePublicBaseUrl } from "./lib/server-state.js";

const PROTOCOL_VERSION = "2025-06-18";
const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MCP_HTTP_TIMEOUT_MS = 30000;

const nativeArtifactInputSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Human-readable artifact title." },
    content: { type: "string", description: "Artifact content." },
    format: {
      type: "string",
      enum: ARTIFACT_FORMATS,
      description: "Content format."
    },
    artifactType: {
      type: "string",
      enum: ARTIFACT_TYPES
    },
    schemaVersion: {
      type: "number",
      enum: [1]
    },
    sourceAgent: { type: "string", description: "Agent or tool that produced the artifact." },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Searchable labels."
    },
    metadata: {
      type: "object",
      description: "Optional JSON metadata."
    },
    allowSecrets: {
      type: "boolean",
      description: "Set true only when intentionally storing content that matches secret patterns."
    }
  },
  required: ["title", "content"]
};

const mutatingArtifactAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};

const tools = [
  {
    name: "artifacty_create",
    title: "Create Artifact",
    description: "Create a new Artifacty-native artifact from title, content, format, tags, and metadata.",
    inputSchema: nativeArtifactInputSchema,
    annotations: mutatingArtifactAnnotations
  },
  {
    name: "artifacty_publish",
    title: "Publish Artifact",
    description: "Backwards-compatible alias for artifacty_create.",
    inputSchema: nativeArtifactInputSchema,
    annotations: mutatingArtifactAnnotations
  },
  {
    name: "artifacty_list",
    title: "List Artifacts",
    description: "List artifacts from the Artifacty store.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        tag: { type: "string" },
        sourceAgent: { type: "string" },
        includeArchived: { type: "boolean" },
        limit: { type: "number" },
        offset: { type: "number" }
      }
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
    name: "artifacty_import",
    title: "Import Agent Artifact",
    description: "Convert an artifact produced by Claude, Codex, Gemini, GitHub Copilot, Cursor, or another agent into Artifacty format and save it.",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: ["auto", "claude", "codex", "gemini", "copilot", "cursor", "artifacty", "generic"],
          description: "Original agent family. Use auto when unsure."
        },
        title: { type: "string", description: "Optional title override." },
        content: { type: "string", description: "Raw artifact file contents or serialized agent payload." },
        payload: { type: "object", description: "Structured agent payload when available." },
        format: {
          type: "string",
          enum: ARTIFACT_FORMATS
        },
        artifactType: {
          type: "string",
          enum: ARTIFACT_TYPES
        },
        schemaVersion: {
          type: "number",
          enum: [1]
        },
        contentType: { type: "string" },
        fileName: { type: "string" },
        sourcePath: { type: "string" },
        tags: {
          type: "array",
          items: { type: "string" }
        },
        metadata: { type: "object" },
        allowSecrets: {
          type: "boolean",
          description: "Set true only when intentionally storing content that matches secret patterns."
        }
      },
      required: []
    },
    annotations: mutatingArtifactAnnotations
  },
  {
    name: "artifacty_get",
    title: "Get Artifact",
    description: "Get artifact metadata and content by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Artifact ID." },
        version: { type: "number", description: "Optional version number." },
        includeContent: { type: "boolean", description: "Include content in the response. Defaults to true." }
      },
      required: ["id"]
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
    name: "artifacty_update",
    title: "Update Artifact",
    description: "Append a new version to an existing artifact.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Artifact ID." },
        title: { type: "string" },
        content: { type: "string" },
        format: {
          type: "string",
          enum: ARTIFACT_FORMATS
        },
        artifactType: {
          type: "string",
          enum: ARTIFACT_TYPES
        },
        schemaVersion: {
          type: "number",
          enum: [1]
        },
        sourceAgent: { type: "string" },
        tags: {
          type: "array",
          items: { type: "string" }
        },
        metadata: { type: "object" },
        allowSecrets: {
          type: "boolean",
          description: "Set true only when intentionally storing content that matches secret patterns."
        }
      },
      required: ["id", "content"]
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: "artifacty_archive",
    title: "Archive Artifact",
    description: "Mark an artifact archived without deleting its versions.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Artifact ID." }
      },
      required: ["id"]
    },
    annotations: mutatingArtifactAnnotations
  },
  {
    name: "artifacty_restore",
    title: "Restore Artifact",
    description: "Restore a previously archived artifact.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Artifact ID." }
      },
      required: ["id"]
    },
    annotations: mutatingArtifactAnnotations
  },
  {
    name: "artifacty_audit",
    title: "List Audit Events",
    description: "List recent audit events for the Artifacty store or a single artifact.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string" },
        limit: { type: "number" }
      }
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
    name: "artifacty_info",
    title: "Artifacty Info",
    description: "Return local Artifacty store and browser URL information.",
    inputSchema: {
      type: "object",
      properties: {}
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  }
];

const resourceTemplates = [
  {
    uriTemplate: "artifacty://artifacts/{id}",
    name: "artifact-by-id",
    title: "Artifact by ID",
    description: "Read an Artifacty artifact with metadata, latest version, content, and browser URLs.",
    mimeType: "application/json"
  },
  {
    uriTemplate: "artifacty://artifacts/{id}/raw{?version}",
    name: "artifact-raw-content",
    title: "Artifact Raw Content",
    description: "Read raw artifact content by ID and optional version.",
    mimeType: "text/plain"
  }
];

const prompts = [
  {
    name: "artifacty_handoff",
    title: "Create Artifact Handoff",
    description: "Prepare a concise continuation artifact for another agent.",
    arguments: [
      { name: "goal", description: "Current goal or handoff objective.", required: false },
      { name: "artifactId", description: "Existing Artifacty artifact to continue from.", required: false }
    ]
  },
  {
    name: "artifacty_review",
    title: "Create Review Artifact",
    description: "Capture code review findings as a shareable Artifacty artifact.",
    arguments: [
      { name: "scope", description: "Files, branch, PR, or behavior under review.", required: false },
      { name: "artifactId", description: "Existing artifact with review context.", required: false }
    ]
  },
  {
    name: "artifacty_test_report",
    title: "Create Test Report Artifact",
    description: "Summarize verification commands, status, failures, and residual risk.",
    arguments: [
      { name: "goal", description: "Feature or release being verified.", required: false },
      { name: "artifactId", description: "Existing artifact with implementation context.", required: false }
    ]
  },
  {
    name: "artifacty_visual_qa",
    title: "Create Visual QA Artifact",
    description: "Record browser, screenshot, media, or visual regression evidence.",
    arguments: [
      { name: "target", description: "URL, artifact ID, or UI surface under visual review.", required: false },
      { name: "artifactId", description: "Existing visual evidence artifact.", required: false }
    ]
  },
  {
    name: "artifacty_release_notes",
    title: "Create Release Notes Artifact",
    description: "Draft release notes from changed artifacts, tests, and known risks.",
    arguments: [
      { name: "version", description: "Release version.", required: false },
      { name: "artifactId", description: "Existing roadmap, checklist, or handoff artifact.", required: false }
    ]
  }
];

export function createMcpJsonRpcHandler(options = {}) {
  const context = createMcpContext(options);
  const requestHandler = createMcpRequestHandler(context);
  return (message) => handleJsonRpcMessage(message, requestHandler);
}

export function createMcpRequestHandler(options = {}) {
  const context = options.store ? createMcpContext(options) : options;
  return (message) => handleMcpRequest(context, message);
}

export function createMcpContext(options = {}) {
  const store = options.store || createStore();
  return {
    store,
    transport: options.transport || "stdio",
    auditContext: options.auditContext || (() => ({
      surface: options.auditSurface || "mcp",
      actor: options.actor || "mcp-client"
    })),
    resolvePublicBaseUrl: options.resolvePublicBaseUrl || (() => resolvePublicBaseUrl(store, {
      url: options.publicBaseUrl
    })),
    serverCommand: options.serverCommand || "node src/mcp-server.js",
    browserCommand: options.browserCommand || "npm start"
  };
}

export async function handleJsonRpcMessage(message, requestHandler) {
  if (!message || typeof message !== "object") {
    return jsonRpcError(null, -32600, "Invalid Request");
  }

  if (!message.id && message.id !== 0) {
    await handleNotification(message);
    return null;
  }

  try {
    const result = await requestHandler(message);
    return {
      jsonrpc: "2.0",
      id: message.id,
      result
    };
  } catch (error) {
    return jsonRpcError(message.id, error.jsonRpcCode || -32603, error.message);
  }
}

export function createRemoteMcpJsonRpcHandler(options = {}) {
  const endpoint = normalizeMcpUrl(options.url || process.env.ARTIFACTY_MCP_URL);
  if (!endpoint) {
    throw new Error("ARTIFACTY_MCP_URL is required when ARTIFACTY_MCP_MODE=bridge");
  }
  const token = options.apiToken || process.env.ARTIFACTY_API_TOKEN || "";
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs || process.env.ARTIFACTY_MCP_TIMEOUT_MS);

  return async (message) => {
    try {
      return await postMcpJsonRpc({
        url: endpoint,
        token,
        message,
        timeoutMs
      });
    } catch (error) {
      if (!message?.id && message?.id !== 0) {
        process.stderr.write(`Remote MCP notification failed: ${error.message}\n`);
        return null;
      }
      return jsonRpcError(message?.id ?? null, -32603, error.message);
    }
  };
}

async function runStdioServer(options = {}) {
  const jsonRpcHandler = createStdioJsonRpcHandler(options);
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  rl.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    handleLine(line, jsonRpcHandler).catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
    });
  });
}

function createStdioJsonRpcHandler(options = {}) {
  const mode = String(options.mode || process.env.ARTIFACTY_MCP_MODE || "local").toLowerCase();
  if (mode === "bridge" || mode === "remote") {
    return createRemoteMcpJsonRpcHandler(options);
  }
  return createMcpJsonRpcHandler({
    ...options,
    transport: "stdio"
  });
}

async function handleLine(line, jsonRpcHandler) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeJsonRpcResponse(jsonRpcError(null, -32700, "Parse error"));
    return;
  }

  const response = await jsonRpcHandler(message);
  if (response) {
    writeJsonRpcResponse(response);
  }
}

async function handleNotification(message) {
  if (message.method === "notifications/initialized") {
    return;
  }
  process.stderr.write(`Ignoring MCP notification: ${message.method}\n`);
}

export async function handleMcpRequest(context, message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: false
        },
        resources: {
          subscribe: false,
          listChanged: false
        },
        prompts: {
          listChanged: false
        }
      },
      serverInfo: {
        name: "artifacty",
        title: "Artifacty",
        version: "0.4.0"
      },
      instructions: "Use Artifacty to create, import, list, read, update, and resource-read artifacts that other agents can reuse."
    };
  }

  if (message.method === "ping") {
    return {};
  }

  if (message.method === "tools/list") {
    return { tools };
  }

  if (message.method === "tools/call") {
    const params = message.params || {};
    return callTool(context, params.name, params.arguments || {});
  }

  if (message.method === "resources/list") {
    return listResources(context);
  }

  if (message.method === "resources/templates/list") {
    return { resourceTemplates };
  }

  if (message.method === "resources/read") {
    return readResource(context, requireParam(message.params, "uri"));
  }

  if (message.method === "prompts/list") {
    return { prompts };
  }

  if (message.method === "prompts/get") {
    const params = message.params || {};
    return getPrompt(requireParam(params, "name"), params.arguments || {});
  }

  throw Object.assign(new Error(`Method not found: ${message.method}`), {
    jsonRpcCode: -32601
  });
}

async function callTool(context, name, args) {
  if (name === "artifacty_create" || name === "artifacty_publish") {
    return toolResult(await withUrls(context, await createNativeArtifact(context, args)));
  }

  if (name === "artifacty_list") {
    const publicBaseUrl = await context.resolvePublicBaseUrl();
    const page = await listArtifactsPage(context.store, args);
    return toolResult({
      artifacts: page.artifacts.map((artifact) => ({
        ...artifact,
        url: `${publicBaseUrl}/artifacts/${encodeURIComponent(artifact.id)}`
      })),
      pagination: {
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        hasMore: page.hasMore,
        nextOffset: page.nextOffset,
        previousOffset: page.previousOffset
      },
      search: page.search
    });
  }

  if (name === "artifacty_import") {
    const converted = convertAgentArtifact(args);
    const artifact = await createArtifact(context.store, {
      ...converted,
      allowSecrets: args.allowSecrets,
      auditAction: "import",
      audit: mcpAuditContext(context)
    });
    return toolResult({
      ...await withUrls(context, artifact),
      converted
    });
  }

  if (name === "artifacty_get") {
    const artifact = await getArtifact(context.store, requireArg(args, "id"), {
      version: args.version,
      audit: mcpAuditContext(context)
    });
    const decorated = await withUrls(context, artifact);
    if (args.includeContent === false) {
      delete decorated.content;
    }
    return toolResult(decorated);
  }

  if (name === "artifacty_update") {
    const artifact = await updateArtifact(context.store, requireArg(args, "id"), {
      title: args.title,
      content: args.content,
      format: args.format,
      artifactType: args.artifactType,
      schemaVersion: args.schemaVersion,
      sourceAgent: args.sourceAgent || "mcp",
      tags: args.tags || [],
      metadata: args.metadata || {},
      allowSecrets: args.allowSecrets,
      audit: mcpAuditContext(context)
    });
    return toolResult(await withUrls(context, artifact));
  }

  if (name === "artifacty_archive" || name === "artifacty_restore") {
    const artifact = name === "artifacty_archive"
      ? await archiveArtifact(context.store, requireArg(args, "id"), { audit: mcpAuditContext(context) })
      : await restoreArtifact(context.store, requireArg(args, "id"), { audit: mcpAuditContext(context) });
    return toolResult(await withUrls(context, artifact));
  }

  if (name === "artifacty_audit") {
    return toolResult({
      events: await listAuditEvents(context.store, {
        artifactId: args.artifactId,
        limit: args.limit
      })
    });
  }

  if (name === "artifacty_info") {
    const publicBaseUrl = await context.resolvePublicBaseUrl();
    return toolResult({
      name: "artifacty",
      store: context.store.home,
      url: publicBaseUrl,
      transport: context.transport,
      mcpProtocolVersion: PROTOCOL_VERSION,
      serverCommand: context.serverCommand,
      browserCommand: context.browserCommand
    });
  }

  throw Object.assign(new Error(`Unknown tool: ${name}`), {
    jsonRpcCode: -32602
  });
}

async function listResources(context) {
  const page = await listArtifactsPage(context.store, { limit: 10 });
  const artifactResources = page.artifacts.flatMap((artifact) => [
    {
      uri: artifactResourceUri(artifact.id),
      name: `artifact:${artifact.id}`,
      title: artifact.title,
      description: `${artifact.sourceAgent} ${artifact.artifactType} artifact, v${artifact.latestVersion}`,
      mimeType: "application/json"
    },
    {
      uri: artifactRawResourceUri(artifact.id),
      name: `artifact-raw:${artifact.id}`,
      title: `${artifact.title} raw`,
      description: `Raw latest ${artifact.format || "text"} content for ${artifact.id}`,
      mimeType: artifact.contentType || "text/plain"
    }
  ]);

  return {
    resources: [
      {
        uri: "artifacty://recent",
        name: "recent-artifacts",
        title: "Recent Artifacts",
        description: "Recent Artifacty artifacts with pagination metadata and browser URLs.",
        mimeType: "application/json"
      },
      {
        uri: "artifacty://schema/v1",
        name: "artifact-schema-v1",
        title: "Artifact Schema v1",
        description: "Artifacty schema v1 reference document.",
        mimeType: "text/markdown"
      },
      ...artifactResources
    ]
  };
}

async function readResource(context, uri) {
  if (uri === "artifacty://recent") {
    const publicBaseUrl = await context.resolvePublicBaseUrl();
    const page = await listArtifactsPage(context.store, { limit: 20 });
    return resourceText(uri, "application/json", {
      artifacts: page.artifacts.map((artifact) => ({
        ...artifact,
        url: `${publicBaseUrl}/artifacts/${encodeURIComponent(artifact.id)}`
      })),
      pagination: {
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        hasMore: page.hasMore,
        nextOffset: page.nextOffset,
        previousOffset: page.previousOffset
      },
      search: page.search
    });
  }

  if (uri === "artifacty://schema/v1") {
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: await readFile(path.join(PACKAGE_ROOT, "docs", "artifact-schema-v1.md"), "utf8")
        }
      ]
    };
  }

  const parsed = parseArtifactResourceUri(uri);
  if (parsed) {
    const artifact = await getArtifact(context.store, parsed.id, {
      version: parsed.version,
      audit: mcpAuditContext(context)
    });
    if (parsed.raw) {
      return {
        contents: [
          {
            uri,
            mimeType: artifact.version.contentType || "text/plain",
            text: artifact.content
          }
        ]
      };
    }
    return resourceText(uri, "application/json", await withUrls(context, artifact));
  }

  throw Object.assign(new Error(`Unknown resource: ${uri}`), {
    jsonRpcCode: -32602
  });
}

function getPrompt(name, args) {
  const definition = prompts.find((prompt) => prompt.name === name);
  if (!definition) {
    throw Object.assign(new Error(`Unknown prompt: ${name}`), {
      jsonRpcCode: -32602
    });
  }

  return {
    description: definition.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: promptText(name, args)
        }
      }
    ]
  };
}

function promptText(name, args = {}) {
  const context = args.artifactId
    ? `First read Artifacty resource ${artifactResourceUri(args.artifactId)} and use it as context.`
    : "Use the current session context and any relevant Artifacty resources.";
  const common = `${context}

Create or update an Artifacty artifact through artifacty_create, artifacty_import, or artifacty_update. Use concise Markdown unless another format is clearly better. Include sourceAgent, artifactType, and tags so another agent can discover it.`;

  if (name === "artifacty_handoff") {
    return `${common}

Goal: ${args.goal || "Prepare a continuation handoff for the next agent."}

Capture: current state, changed files or artifacts, commands run, decisions, blockers, residual risk, and next steps.
Recommended artifactType: handoff. Recommended tags: handoff, continuation.`;
  }
  if (name === "artifacty_review") {
    return `${common}

Review scope: ${args.scope || "Review the current implementation or linked artifact."}

Capture findings first, ordered by severity, with file/line references when available. Include open questions and verification gaps.
Recommended artifactType: code-review. Recommended tags: review.`;
  }
  if (name === "artifacty_test_report") {
    return `${common}

Verification goal: ${args.goal || "Summarize test and smoke evidence."}

Capture commands, status, failures, environment, manual checks, and what remains untested.
Recommended artifactType: test-report. Recommended tags: verification, test-report.`;
  }
  if (name === "artifacty_visual_qa") {
    return `${common}

Visual target: ${args.target || "Inspect the UI or visual artifact under review."}

Capture screenshots/media references, viewport, expected behavior, observed issues, and pass/fail verdict.
Recommended artifactType: design-option or bundle. Recommended tags: visual, qa.`;
  }
  if (name === "artifacty_release_notes") {
    return `${common}

Release version: ${args.version || "next"}

Capture highlights, breaking changes, migration notes, tests, known limitations, and publish evidence.
Recommended artifactType: document. Recommended tags: release-notes.`;
  }
  return common;
}

async function createNativeArtifact(context, args) {
  return createArtifact(context.store, {
    title: args.title,
    content: args.content,
    format: args.format,
    artifactType: args.artifactType,
    schemaVersion: args.schemaVersion,
    sourceAgent: args.sourceAgent || "mcp",
    tags: args.tags || [],
    metadata: args.metadata || {},
    allowSecrets: args.allowSecrets,
    audit: mcpAuditContext(context)
  });
}

function mcpAuditContext(context) {
  return context.auditContext();
}

async function withUrls(context, artifact) {
  const publicBaseUrl = await context.resolvePublicBaseUrl();
  return {
    ...artifact,
    url: `${publicBaseUrl}/artifacts/${encodeURIComponent(artifact.id)}`,
    rawUrl: `${publicBaseUrl}/artifacts/${encodeURIComponent(artifact.id)}/raw?version=${artifact.version.version}`
  };
}

function resourceText(uri, mimeType, data) {
  return {
    contents: [
      {
        uri,
        mimeType,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2)
      }
    ]
  };
}

function artifactResourceUri(id) {
  return `artifacty://artifacts/${encodeURIComponent(id)}`;
}

function artifactRawResourceUri(id, version) {
  const suffix = version ? `?version=${encodeURIComponent(String(version))}` : "";
  return `artifacty://artifacts/${encodeURIComponent(id)}/raw${suffix}`;
}

function parseArtifactResourceUri(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }

  if (parsed.protocol !== "artifacty:" || parsed.hostname !== "artifacts") {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 1 && !(parts.length === 2 && parts[1] === "raw")) {
    return null;
  }
  return {
    id: decodeURIComponent(parts[0]),
    raw: parts[1] === "raw",
    version: parsed.searchParams.get("version") || undefined
  };
}

function toolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ],
    structuredContent: data,
    isError: false
  };
}

function requireArg(args, name) {
  if (!args[name]) {
    throw Object.assign(new Error(`Missing required argument: ${name}`), {
      jsonRpcCode: -32602
    });
  }
  return args[name];
}

function requireParam(params = {}, name) {
  if (!params[name]) {
    throw Object.assign(new Error(`Missing required parameter: ${name}`), {
      jsonRpcCode: -32602
    });
  }
  return params[name];
}

function jsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
}

function writeJsonRpcResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function postMcpJsonRpc({ url, token, message, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(message),
      signal: controller.signal
    });
    const text = await response.text();
    if (response.status === 202 && !text.trim()) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Remote MCP ${response.status}: ${text.trim() || response.statusText}`);
    }
    if (!text.trim()) {
      return null;
    }
    return JSON.parse(text);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Remote MCP request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeMcpUrl(value) {
  if (!value) {
    return "";
  }
  const parsed = new URL(value);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname) {
    parsed.pathname = "/mcp";
  } else {
    parsed.pathname = pathname;
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function normalizeTimeoutMs(value) {
  const timeout = Number(value ?? DEFAULT_MCP_HTTP_TIMEOUT_MS);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_MCP_HTTP_TIMEOUT_MS;
}

function isMain(metaUrl) {
  return process.argv[1] && metaUrl === new URL(`file://${process.argv[1]}`).href;
}

if (isMain(import.meta.url)) {
  runStdioServer().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
