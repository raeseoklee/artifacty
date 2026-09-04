#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  addComment,
  addRelation,
  ARTIFACT_FORMATS,
  ARTIFACT_TYPES,
  archiveArtifact,
  authenticateApiToken,
  createArtifact,
  createStore,
  getArtifact,
  inverseRelation,
  listAuditEvents,
  listArtifactsPage,
  listComments,
  listRelations,
  RELATION_TYPES,
  removeRelation,
  resolveComment,
  resolveSavedView,
  restoreArtifact,
  REVIEW_STATUSES,
  setArtifactVisibility,
  setReviewStatus,
  toArtifactSummary,
  updateArtifact,
  VersionConflictError,
  VISIBILITY_VALUES
} from "./lib/storage.js";
import { convertAgentArtifact } from "./lib/converters.js";
import { createStructuredDiff, diffFormatFor, renderUnifiedDiffText, resolveDiffView } from "./lib/diff.js";
import { createEmbeddingProvider } from "./lib/embeddings.js";
import { EVENT_TYPES, eventVisibleTo, sanitizeEventForDelivery, subscribe } from "./lib/events.js";
import { inlineSchema } from "./lib/schemas.js";
import { effectiveScopes, requireScope } from "./lib/security.js";
import { resolvePublicBaseUrl } from "./lib/server-state.js";

// "2025-06-18" is the version this server was originally built against and
// remains verified against the public MCP specification. We could not
// confirm a later published protocol version string from the official spec
// during this change, so only 2025-06-18 is listed; add newer versions here
// once confirmed rather than guessing at a date.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18"];
const PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];
const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MCP_HTTP_TIMEOUT_MS = 30000;
const DEFAULT_WAIT_TIMEOUT_MS = 30000;
const MAX_WAIT_TIMEOUT_MS = 120000;

const relationsInputSchema = {
  type: "array",
  description: "Directed relations to create from this artifact to others in the same call, e.g. [{ toId: \"a-123\", relation: \"derived-from\" }].",
  items: {
    type: "object",
    properties: {
      toId: { type: "string", description: "Target artifact ID." },
      relation: { type: "string", enum: RELATION_TYPES }
    },
    required: ["toId", "relation"]
  }
};

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
    },
    visibility: {
      type: "string",
      enum: VISIBILITY_VALUES,
      description: "'team' (default) is visible to any authenticated user; 'private' is visible only to the owner and admins."
    },
    relations: relationsInputSchema
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
    outputSchema: inlineSchema("ArtifactWithContent"),
    annotations: mutatingArtifactAnnotations
  },
  {
    name: "artifacty_publish",
    title: "Publish Artifact",
    description: "Backwards-compatible alias for artifacty_create.",
    inputSchema: nativeArtifactInputSchema,
    outputSchema: inlineSchema("ArtifactWithContent"),
    annotations: mutatingArtifactAnnotations
  },
  {
    name: "artifacty_list",
    title: "List Artifacts",
    description: "List artifacts from the Artifacty store. Accepts a `view` argument naming a saved view (id or name); its filters are expanded first and any other argument passed alongside it overrides that filter.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        tag: { type: "string" },
        sourceAgent: { type: "string" },
        artifactType: { type: "string", enum: ARTIFACT_TYPES },
        publisher: { type: "string", description: "Matches publisher id, publisher user id, or owner user id." },
        createdAfter: { type: "string", description: "ISO date/time lower bound on the artifact's created_at." },
        createdBefore: { type: "string", description: "ISO date/time upper bound on the artifact's created_at." },
        reviewStatus: { type: "string", description: "Filter by artifact-level review status (none, pending, changes-requested, approved)." },
        relatedTo: { type: "string", description: "Restrict to artifacts related (in either direction) to this artifact ID." },
        relation: { type: "string", enum: RELATION_TYPES, description: "Restrict relatedTo matches to this relation name." },
        mode: { type: "string", enum: ["keyword", "semantic", "hybrid"], description: "Search mode. `hybrid` (default when an embedding provider is configured and `query` is set) combines keyword and semantic ranking; falls back to `keyword` with `search.fallback: true` when no provider is configured." },
        includeArchived: { type: "boolean" },
        view: { type: "string", description: "Name or id of a saved view whose filters should be expanded and merged in." },
        limit: { type: "number" },
        offset: { type: "number" }
      }
    },
    outputSchema: inlineSchema("ArtifactListPage"),
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
    outputSchema: inlineSchema("ArtifactWithContent"),
    annotations: mutatingArtifactAnnotations
  },
  {
    name: "artifacty_get",
    title: "Get Artifact",
    description: "Get artifact metadata and content by ID. The response includes latestVersion; pass it back as expectedVersion on artifacty_update to avoid overwriting a concurrent change.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Artifact ID." },
        version: { type: "number", description: "Optional version number." },
        includeContent: { type: "boolean", description: "Include content in the response. Defaults to true." },
        includeComments: { type: "boolean", description: "Include open comments on the requested version as `comments` in the response. Defaults to false." }
      },
      required: ["id"]
    },
    outputSchema: inlineSchema("ArtifactWithContent"),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
    name: "artifacty_update",
    title: "Update Artifact",
    description: "Append a new version to an existing artifact. Pass expectedVersion (the latestVersion you last read from artifacty_get) so a concurrent update from another agent is rejected instead of silently overwritten.",
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
        },
        expectedVersion: {
          type: "number",
          description: "The latestVersion this update was based on. If the artifact's current latestVersion differs, the update is rejected with a version_conflict error instead of creating a version that discards a concurrent change."
        },
        visibility: {
          type: "string",
          enum: VISIBILITY_VALUES,
          description: "'team' (default) is visible to any authenticated user; 'private' is visible only to the owner and admins. Prefer artifacty_set_visibility to change visibility on its own."
        },
        relations: relationsInputSchema
      },
      required: ["id", "content"]
    },
    outputSchema: inlineSchema("ArtifactWithContent"),
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: "artifacty_set_visibility",
    title: "Set Artifact Visibility",
    description: "Change an artifact's visibility between 'team' and 'private'. Requires the artifact's owner or an admin.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Artifact ID." },
        visibility: { type: "string", enum: VISIBILITY_VALUES }
      },
      required: ["id", "visibility"]
    },
    outputSchema: inlineSchema("ArtifactWithContent"),
    annotations: mutatingArtifactAnnotations
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
    outputSchema: inlineSchema("ArtifactWithContent"),
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
    outputSchema: inlineSchema("ArtifactWithContent"),
    annotations: mutatingArtifactAnnotations
  },
  {
    name: "artifacty_link",
    title: "Link Artifacts",
    description: "Create a typed, directional relation from one artifact to another (e.g. derived-from, supersedes, reviews, references, part-of).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Source artifact ID (the `from` side of the relation)." },
        toId: { type: "string", description: "Target artifact ID (the `to` side of the relation)." },
        relation: { type: "string", enum: RELATION_TYPES }
      },
      required: ["id", "toId", "relation"]
    },
    outputSchema: inlineSchema("RelationEntry"),
    annotations: mutatingArtifactAnnotations
  },
  {
    name: "artifacty_unlink",
    title: "Unlink Artifacts",
    description: "Remove a previously created relation between two artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Source artifact ID (the `from` side of the relation)." },
        toId: { type: "string", description: "Target artifact ID (the `to` side of the relation)." },
        relation: { type: "string", enum: RELATION_TYPES }
      },
      required: ["id", "toId", "relation"]
    },
    outputSchema: inlineSchema("RelationEntry"),
    annotations: mutatingArtifactAnnotations
  },
  {
    name: "artifacty_comment",
    title: "Add Comment",
    description: "Add a comment or a reply to a root comment (threads are one level deep) on an artifact version, defaulting to the latest version. body is Markdown, rendered through the same sanitized pipeline as artifact content, capped at 16 KB.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Artifact ID." },
        version: { type: "number", description: "Defaults to the artifact's latest version." },
        body: { type: "string", description: "Comment body, Markdown, up to 16 KB." },
        anchor: {
          type: "object",
          description: "Optional format-specific rendering hint, e.g. { line: 42 } for text formats, { path: \"$.runs[0].results[3]\" } for JSON/SARIF, { row: 7 } for CSV. Not validated against content."
        },
        parentId: { type: "string", description: "Reply to this root comment. Threads are one level deep; the target must not itself be a reply." }
      },
      required: ["id", "body"]
    },
    outputSchema: inlineSchema("CommentEntry"),
    annotations: mutatingArtifactAnnotations
  },
  {
    name: "artifacty_resolve_comment",
    title: "Resolve Comment",
    description: "Mark a comment resolved.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Artifact ID." },
        commentId: { type: "string", description: "Comment ID." }
      },
      required: ["id", "commentId"]
    },
    outputSchema: inlineSchema("CommentEntry"),
    annotations: mutatingArtifactAnnotations
  },
  {
    name: "artifacty_set_review_status",
    title: "Set Review Status",
    description: "Set an artifact's review status. Requires the artifact's owner or an admin. Automatically resets to 'pending' when a new version is appended after 'approved'.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Artifact ID." },
        status: { type: "string", enum: REVIEW_STATUSES }
      },
      required: ["id", "status"]
    },
    outputSchema: inlineSchema("ArtifactWithContent"),
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
    outputSchema: inlineSchema("AuditEventList"),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
    name: "artifacty_diff",
    title: "Diff Artifact Versions",
    description: "Diff two versions of an artifact. Returns a compact unified-diff text in content[].text and the structured diff (JSON path, CSV row/cell, line, or bundle per-file entries) in structuredContent. Defaults to the two latest versions.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Artifact ID." },
        from: { type: "number", description: "Defaults to latestVersion - 1." },
        to: { type: "number", description: "Defaults to latestVersion." },
        view: {
          type: "string",
          enum: ["structured", "lines"],
          description: "Defaults to structured for JSON-like formats (json, sarif, csv, notebook, bundle artifacts), lines otherwise."
        }
      },
      required: ["id"]
    },
    outputSchema: inlineSchema("DiffResult"),
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
    outputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        store: { type: "string" },
        url: { type: "string", format: "uri" },
        transport: { type: "string" },
        mcpProtocolVersion: { type: "string" },
        supportedProtocolVersions: { type: "array", items: { type: "string" } },
        openApiUrl: { type: "string", format: "uri" },
        serverCommand: { type: "string" },
        browserCommand: { type: "string" }
      },
      required: ["name", "store", "url", "transport", "mcpProtocolVersion"]
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
    name: "artifacty_wait",
    title: "Wait For Change Notification",
    description: "Block up to timeoutMs for the first change event matching the given filter, and return it (or { timedOut: true }). A long-poll primitive for clients that cannot use resources/subscribe (see docs/mcp-public-api.md).",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", description: "Only match events for this artifact." },
        tag: { type: "string", description: "Only match events for artifacts tagged with this tag." },
        type: {
          type: "string",
          enum: EVENT_TYPES,
          description: "Only match this event type."
        },
        timeoutMs: {
          type: "number",
          description: `Maximum time to wait, in milliseconds. Default ${DEFAULT_WAIT_TIMEOUT_MS}, max ${MAX_WAIT_TIMEOUT_MS}.`
        }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        timedOut: { type: "boolean" },
        event: { ...inlineSchema("Event"), description: "Present when timedOut is false." }
      },
      required: ["timedOut"]
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  }
];

// Tools without readOnlyHint: true mutate the store (create, publish,
// import, update, archive, restore, link, unlink). tools/list filters these
// out for a token lacking the write scope, and tools/call rejects a direct
// call to one with a scope_denied error result (see requireScope in
// src/lib/security.js and docs/roadmap-design.md section 11).
const MUTATING_TOOL_NAMES = new Set(
  tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name)
);

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
  },
  {
    uriTemplate: "artifacty://artifacts/{id}/graph",
    name: "artifact-relation-graph",
    title: "Artifact Relation Graph",
    description: "Depth-2 adjacency list of artifacts reachable from this artifact through relations, with nodes and edges.",
    mimeType: "application/json"
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
    // The auth context behind this connection, when known (set by the
    // streamable-HTTP transport from the request's resolved
    // request.artifactyAuth; left undefined for stdio, which is always a
    // local, fully-trusted connection and so gets full scopes from
    // effectiveScopes()). Drives tools/list filtering and the write-scope
    // check on tools/call below.
    auth: options.auth,
    // Non-throwing rate-limit check for a bucket name, returning
    // { allowed, retryAfterSeconds? }. Only meaningful over the
    // streamable-HTTP transport (see handleMcpHttpRequest in server.js);
    // stdio connections are always allowed.
    enforceRateLimit: options.enforceRateLimit || (async () => ({ allowed: true })),
    auditContext: options.auditContext || (() => ({
      surface: options.auditSurface || "mcp",
      actor: options.actor || "mcp-client"
    })),
    resolvePublicBaseUrl: options.resolvePublicBaseUrl || (() => resolvePublicBaseUrl(store, {
      url: options.publicBaseUrl
    })),
    serverCommand: options.serverCommand || "node src/mcp-server.js",
    browserCommand: options.browserCommand || "npm start",
    // Push channel for notifications/resources/updated (see
    // resources/subscribe below). Only meaningful when this context is
    // long-lived for the connection it serves: the stdio transport creates
    // exactly one context per process (see createStdioJsonRpcHandler) so a
    // real subscription can deliver real pushes by writing to stdout. The
    // streamable-HTTP transport (see handleMcpHttpRequest in server.js)
    // creates a fresh context per POST, so resources/subscribe there is
    // accepted (the spec requires clients be able to call it) but cannot
    // deliver anything — there is no open connection left to push over once
    // the response is sent. Clients on that transport should use the
    // artifacty_wait tool (a long-poll that works within one request)
    // instead. See docs/mcp-public-api.md.
    notify: options.notify || (() => {}),
    subscriptions: options.subscriptions || new Map()
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
    transport: "stdio",
    notify: options.notify || writeJsonRpcResponse
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
      protocolVersion: negotiateProtocolVersion(message.params?.protocolVersion),
      capabilities: {
        tools: {
          listChanged: false
        },
        resources: {
          subscribe: true,
          listChanged: true
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
    if (effectiveScopes(context.auth).includes("write")) {
      return { tools };
    }
    return { tools: tools.filter((tool) => tool.annotations?.readOnlyHint === true) };
  }

  if (message.method === "tools/call") {
    const params = message.params || {};
    if (MUTATING_TOOL_NAMES.has(params.name)) {
      try {
        requireScope(context.auth, "write");
      } catch (error) {
        if (error.code === "scope_denied") {
          return toolErrorResult(error.message, { code: "scope_denied" });
        }
        throw error;
      }
      const rateLimit = await context.enforceRateLimit("write");
      if (!rateLimit.allowed) {
        return toolErrorResult(
          `Rate limit exceeded. Retry after ${rateLimit.retryAfterSeconds}s.`,
          { code: "rate_limited", retryAfterSeconds: rateLimit.retryAfterSeconds }
        );
      }
    } else if (params.name === "artifacty_wait") {
      // artifacty_wait is readOnlyHint: true, so it skips the write-scope
      // rate limit above; hold long-poll connections to the same bucket as
      // artifacty_list's search so a read-scoped token cannot open
      // unbounded connections for free.
      const rateLimit = await context.enforceRateLimit("search");
      if (!rateLimit.allowed) {
        return toolErrorResult(
          `Rate limit exceeded. Retry after ${rateLimit.retryAfterSeconds}s.`,
          { code: "rate_limited", retryAfterSeconds: rateLimit.retryAfterSeconds }
        );
      }
    }
    try {
      return await callTool(context, params.name, params.arguments || {});
    } catch (error) {
      if (error instanceof VersionConflictError) {
        return toolErrorResult(
          `Version conflict: artifact ${error.artifactId} is now at version ${error.latestVersion}. Re-read the artifact and retry with expectedVersion: ${error.latestVersion}.`,
          { code: "version_conflict", latestVersion: error.latestVersion }
        );
      }
      // Storage-layer validation/not-found errors carry a machine-readable
      // `code` and HTTP-style `statusCode` (see CLAUDE.md error-shape
      // convention). Surface those as a business-level tool error instead of
      // a JSON-RPC protocol error so clients can branch on
      // structuredContent.code. Errors that only carry `jsonRpcCode` (e.g.
      // missing/unknown arguments) are protocol-level and keep propagating.
      if (error.code && error.statusCode) {
        return toolErrorResult(error.message, { code: error.code });
      }
      throw error;
    }
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

  if (message.method === "resources/subscribe") {
    return await subscribeResource(context, requireParam(message.params, "uri"));
  }

  if (message.method === "resources/unsubscribe") {
    return unsubscribeResource(context, requireParam(message.params, "uri"));
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
    const access = await mcpAccessContext(context);
    const listFilters = await expandSavedViewArgs(context, args, access);
    const page = await listArtifactsPage(context.store, { ...listFilters, access });
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
      access: await mcpAccessContext(context),
      audit: mcpAuditContext(context)
    });
    const decorated = await withUrls(context, artifact);
    if (args.includeContent === false) {
      delete decorated.content;
    }
    if (args.includeComments) {
      decorated.comments = await listComments(context.store, artifact.id, {
        version: artifact.version.version,
        status: "open",
        access: await mcpAccessContext(context)
      });
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
      expectedVersion: args.expectedVersion,
      relations: args.relations,
      access: await mcpAccessContext(context),
      audit: mcpAuditContext(context)
    });
    return toolResult(await withUrls(context, artifact));
  }

  if (name === "artifacty_set_visibility") {
    const artifact = await setArtifactVisibility(context.store, requireArg(args, "id"), requireArg(args, "visibility"), {
      access: await mcpAccessContext(context),
      audit: mcpAuditContext(context)
    });
    return toolResult(await withUrls(context, artifact));
  }

  if (name === "artifacty_archive" || name === "artifacty_restore") {
    const access = await mcpAccessContext(context);
    const artifact = name === "artifacty_archive"
      ? await archiveArtifact(context.store, requireArg(args, "id"), { access, audit: mcpAuditContext(context) })
      : await restoreArtifact(context.store, requireArg(args, "id"), { access, audit: mcpAuditContext(context) });
    return toolResult(await withUrls(context, artifact));
  }

  if (name === "artifacty_link") {
    const relation = await addRelation(context.store, {
      fromId: requireArg(args, "id"),
      toId: requireArg(args, "toId"),
      relation: requireArg(args, "relation"),
      access: await mcpAccessContext(context),
      audit: mcpAuditContext(context)
    });
    return toolResult(relation);
  }

  if (name === "artifacty_unlink") {
    const relation = await removeRelation(context.store, {
      fromId: requireArg(args, "id"),
      toId: requireArg(args, "toId"),
      relation: requireArg(args, "relation"),
      access: await mcpAccessContext(context),
      audit: mcpAuditContext(context)
    });
    return toolResult(relation);
  }

  if (name === "artifacty_comment") {
    const comment = await addComment(context.store, requireArg(args, "id"), {
      version: args.version,
      body: requireArg(args, "body"),
      anchor: args.anchor,
      parentId: args.parentId,
      sourceAgent: "mcp",
      access: await mcpAccessContext(context),
      audit: mcpAuditContext(context)
    });
    return toolResult(comment);
  }

  if (name === "artifacty_resolve_comment") {
    const comment = await resolveComment(context.store, requireArg(args, "id"), requireArg(args, "commentId"), {
      access: await mcpAccessContext(context),
      audit: mcpAuditContext(context)
    });
    return toolResult(comment);
  }

  if (name === "artifacty_set_review_status") {
    const artifact = await setReviewStatus(context.store, requireArg(args, "id"), requireArg(args, "status"), {
      access: await mcpAccessContext(context),
      audit: mcpAuditContext(context)
    });
    return toolResult(await withUrls(context, artifact));
  }

  if (name === "artifacty_audit") {
    return toolResult({
      events: await listAuditEvents(context.store, {
        artifactId: args.artifactId,
        limit: args.limit,
        access: await mcpAccessContext(context)
      })
    });
  }

  if (name === "artifacty_diff") {
    const id = requireArg(args, "id");
    const diffAccess = await mcpAccessContext(context);
    const latest = await getArtifact(context.store, id, { access: diffAccess, audit: mcpAuditContext(context) });
    const defaultFrom = Math.max(1, latest.latestVersion - 1);
    const fromNumber = Number(args.from ?? defaultFrom);
    const toNumber = Number(args.to ?? latest.latestVersion);
    const from = await getArtifact(context.store, id, { version: fromNumber, access: diffAccess, audit: mcpAuditContext(context) });
    const to = await getArtifact(context.store, id, { version: toNumber, access: diffAccess, audit: mcpAuditContext(context) });
    const diffFormat = diffFormatFor(latest.artifactType, to.version.format);
    const view = resolveDiffView({ artifactType: latest.artifactType, format: to.version.format, requestedView: args.view });
    const structuredDiff = createStructuredDiff(from.content, to.content, {
      format: view === "lines" ? "text" : diffFormat
    });
    const data = {
      id: latest.id,
      from: from.version.version,
      to: to.version.version,
      view,
      format: diffFormat,
      structuredDiff
    };
    return {
      content: [
        {
          type: "text",
          text: renderUnifiedDiffText(structuredDiff)
        }
      ],
      structuredContent: data,
      isError: false
    };
  }

  if (name === "artifacty_info") {
    const publicBaseUrl = await context.resolvePublicBaseUrl();
    const embeddingProvider = createEmbeddingProvider(process.env);
    return toolResult({
      name: "artifacty",
      store: context.store.home,
      url: publicBaseUrl,
      transport: context.transport,
      mcpProtocolVersion: PROTOCOL_VERSION,
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      openApiUrl: `${publicBaseUrl}/openapi.json`,
      serverCommand: context.serverCommand,
      browserCommand: context.browserCommand,
      embeddings: embeddingProvider ? { provider: embeddingProvider.name, model: embeddingProvider.model } : null
    });
  }

  if (name === "artifacty_wait") {
    if (activeWaits >= maxConcurrentWaits()) {
      return toolErrorResult(
        `Too many concurrent artifacty_wait calls (limit ${maxConcurrentWaits()}). Try again shortly.`,
        { code: "too_many_waits" }
      );
    }
    activeWaits += 1;
    try {
      return toolResult(await waitForEvent({
        artifactId: args.artifactId,
        tag: args.tag,
        type: args.type,
        timeoutMs: args.timeoutMs,
        access: await mcpAccessContext(context)
      }));
    } finally {
      activeWaits -= 1;
    }
  }

  throw Object.assign(new Error(`Unknown tool: ${name}`), {
    jsonRpcCode: -32602
  });
}

async function listResources(context) {
  const page = await listArtifactsPage(context.store, { limit: 10, access: await mcpAccessContext(context) });
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
    const page = await listArtifactsPage(context.store, { limit: 20, access: await mcpAccessContext(context) });
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
  if (parsed?.graph) {
    return resourceText(uri, "application/json", await buildRelationGraph(context, parsed.id));
  }
  if (parsed) {
    const artifact = await getArtifact(context.store, parsed.id, {
      version: parsed.version,
      access: await mcpAccessContext(context),
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
    const relationsHint = args.artifactId
      ? ` Pass relations: [{ toId: "${args.artifactId}", relation: "derived-from" }] on the create/update call so the graph links this handoff back to its source.`
      : ' If this handoff continues from an existing artifact, pass relations: [{ toId: <source artifact ID>, relation: "derived-from" }] on the create/update call so the graph links back to it.';
    return `${common}${relationsHint}

Goal: ${args.goal || "Prepare a continuation handoff for the next agent."}

Capture: current state, changed files or artifacts, commands run, decisions, blockers, residual risk, and next steps.
Recommended artifactType: handoff. Recommended tags: handoff, continuation.`;
  }
  if (name === "artifacty_review") {
    const relationsHint = args.artifactId
      ? ` Pass relations: [{ toId: "${args.artifactId}", relation: "reviews" }] on the create/update call so the graph links this review to the artifact under review.`
      : ' If this review covers an existing artifact, pass relations: [{ toId: <reviewed artifact ID>, relation: "reviews" }] on the create/update call so the graph links this review to it.';
    const commentsHint = args.artifactId
      ? ` For a short review (a handful of findings), prefer artifacty_comment on ${args.artifactId} over publishing a separate review artifact -- one comment per finding, with anchor: { line: N } when you have a line reference, and artifacty_set_review_status to record the verdict (approved, changes-requested). Reserve a full review artifact for longer or multi-file reviews.`
      : " For a short review (a handful of findings), prefer artifacty_comment on the artifact under review over publishing a separate review artifact, and artifacty_set_review_status to record the verdict. Reserve a full review artifact for longer or multi-file reviews.";
    return `${common}${relationsHint}${commentsHint}

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
    visibility: args.visibility,
    relations: args.relations,
    audit: mcpAuditContext(context)
  });
}

function mcpAuditContext(context) {
  return context.auditContext();
}

// Builds the { userId, role, anonymous } access object storage.js visibility
// checks use, from the MCP connection's auth context. The streamable-HTTP
// transport sets context.auth from the request's resolved
// request.artifactyAuth (see accessContext() in server.js, which this
// mirrors). The stdio transport is a local, fully-trusted process with no
// per-request auth; it is scoped to a personal user only when
// ARTIFACTY_API_TOKEN resolves to a personal API token, otherwise it is
// treated as anonymous team access (storage.js still bypasses everything in
// single-user mode, i.e. when the store has no users at all).
async function mcpAccessContext(context) {
  if (context.auth) {
    if (context.auth.user) {
      return { userId: context.auth.user.id, role: context.auth.user.role, anonymous: false };
    }
    return { userId: null, role: null, anonymous: true };
  }
  const token = process.env.ARTIFACTY_API_TOKEN;
  if (token) {
    const tokenAuth = await authenticateApiToken(context.store, token);
    if (tokenAuth?.user) {
      return { userId: tokenAuth.user.id, role: tokenAuth.user.role, anonymous: false };
    }
  }
  return { userId: null, role: null, anonymous: true };
}

// Expands artifacty_list's `view` argument into the saved view's filters,
// letting any other argument the caller passed alongside it override that
// filter (the caller's explicit args always win).
async function expandSavedViewArgs(context, args = {}, access) {
  const { view, ...explicit } = args;
  if (!view) {
    return explicit;
  }
  const savedView = await resolveSavedView(context.store, view, { access });
  if (!savedView) {
    return explicit;
  }
  return { ...savedView.filters, ...explicit };
}

async function withUrls(context, artifact) {
  const publicBaseUrl = await context.resolvePublicBaseUrl();
  return {
    ...artifact,
    url: `${publicBaseUrl}/artifacts/${encodeURIComponent(artifact.id)}`,
    rawUrl: `${publicBaseUrl}/artifacts/${encodeURIComponent(artifact.id)}/raw?version=${artifact.version.version}`
  };
}

async function buildRelationGraph(context, rootId) {
  const nodes = new Map();
  const edges = [];
  const edgeKeys = new Set();

  const access = await mcpAccessContext(context);
  const rootArtifact = await getArtifact(context.store, rootId, { access, audit: mcpAuditContext(context) });
  nodes.set(rootId, toArtifactSummary(rootArtifact));

  const visitedRelations = new Set();
  let frontier = [rootId];

  for (let depth = 0; depth < 2 && frontier.length > 0; depth += 1) {
    const nextFrontier = [];
    for (const currentId of frontier) {
      if (visitedRelations.has(currentId)) {
        continue;
      }
      visitedRelations.add(currentId);

      const relations = await listRelations(context.store, currentId, { access });
      for (const entry of relations.outgoing) {
        if (entry.missing || entry.restricted) {
          continue;
        }
        addEdge(edgeKeys, edges, currentId, entry.artifactId, entry.relation);
        if (!nodes.has(entry.artifactId)) {
          nodes.set(entry.artifactId, entry.artifact);
          nextFrontier.push(entry.artifactId);
        }
      }
      for (const entry of relations.incoming) {
        if (entry.missing || entry.restricted) {
          continue;
        }
        addEdge(edgeKeys, edges, entry.artifactId, currentId, inverseRelationName(entry.relation));
        if (!nodes.has(entry.artifactId)) {
          nodes.set(entry.artifactId, entry.artifact);
          nextFrontier.push(entry.artifactId);
        }
      }
    }
    frontier = nextFrontier;
  }

  return {
    rootId,
    nodes: [...nodes.values()],
    edges
  };
}

function addEdge(edgeKeys, edges, from, to, relation) {
  const key = `${from}|${to}|${relation}`;
  if (edgeKeys.has(key)) {
    return;
  }
  edgeKeys.add(key);
  edges.push({ from, to, relation });
}

// listRelations() reports incoming entries with the already-inverted
// relation name (matching what getArtifact returns). The graph wants the
// original stored relation name on the edge, so invert back.
function inverseRelationName(relation) {
  return inverseRelation(relation) || relation;
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
  if (parts.length !== 1 && !(parts.length === 2 && (parts[1] === "raw" || parts[1] === "graph"))) {
    return null;
  }
  return {
    id: decodeURIComponent(parts[0]),
    raw: parts[1] === "raw",
    graph: parts[1] === "graph",
    version: parsed.searchParams.get("version") || undefined
  };
}

// artifacty_wait's timeout-based long-poll works over any transport
// (stdio or one streamable-HTTP request) because it never outlives the
// single tool call: it subscribes, waits, and always unsubscribes before
// returning, regardless of whether a match arrived.
function waitForEvent({ artifactId, tag, type, timeoutMs, access } = {}) {
  const filter = {};
  if (artifactId) filter.artifactId = artifactId;
  if (tag) filter.tag = tag;
  if (type) filter.type = type;
  const boundedTimeoutMs = Math.max(0, Math.min(Number(timeoutMs) || DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS));

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve({ timedOut: true });
    }, boundedTimeoutMs);
    // Deliberately not unref'd: a pending wait is a live tool call and must
    // keep the process alive until it resolves or times out (max 120s).

    // A matching event for a private artifact the caller cannot see must
    // not resolve or leak the wait: keep waiting (silently) until a visible
    // match arrives or the timeout fires.
    const unsubscribe = subscribe(filter, (event) => {
      if (settled) return;
      if (!eventVisibleTo(event, access)) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve({ timedOut: false, event: sanitizeEventForDelivery(event) });
    });
  });
}

// Caps concurrent artifacty_wait long-polls so a read-scoped token cannot
// exhaust server sockets/listeners the way unbounded SSE connections would
// (SSE is already capped by ARTIFACTY_SSE_MAX_CLIENTS).
let activeWaits = 0;

function maxConcurrentWaits() {
  const parsed = Number.parseInt(process.env.ARTIFACTY_MAX_WAITS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 64;
}

async function subscribeResource(context, uri) {
  const filter = filterForSubscriptionUri(uri);
  if (!filter) {
    throw Object.assign(new Error(`Unsupported resource URI for subscribe: ${uri}`), {
      jsonRpcCode: -32602
    });
  }
  if (context.transport === "streamable-http") {
    // Each POST over streamable-http builds a fresh, per-request
    // subscriptions Map (see createMcpJsonRpcHandler call sites), so any
    // listener registered here would outlive the request with no way for a
    // later resources/unsubscribe (which gets a different empty Map) to
    // remove it — a permanent listener leak that could never deliver a
    // notification anyway, since notify() only reaches this same request.
    // Accept the call (spec-compliant) but register nothing.
    return {};
  }
  if (!context.subscriptions.has(uri)) {
    const access = await mcpAccessContext(context);
    const unsubscribe = subscribe(filter, (event) => {
      if (!eventVisibleTo(event, access)) {
        return;
      }
      context.notify({
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri }
      });
    });
    context.subscriptions.set(uri, unsubscribe);
  }
  return {};
}

function unsubscribeResource(context, uri) {
  const unsubscribe = context.subscriptions.get(uri);
  if (unsubscribe) {
    unsubscribe();
    context.subscriptions.delete(uri);
  }
  return {};
}

function filterForSubscriptionUri(uri) {
  if (uri === "artifacty://recent") {
    return {};
  }
  const parsed = parseArtifactResourceUri(uri);
  if (!parsed || parsed.raw || parsed.graph) {
    return null;
  }
  return { artifactId: parsed.id };
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

function toolErrorResult(text, structuredContent) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ],
    structuredContent,
    isError: true
  };
}

// Negotiate the protocol version per the MCP spec: if the client's requested
// version is one we support, echo it back; otherwise fall back to the
// newest version we support (the last entry in SUPPORTED_PROTOCOL_VERSIONS)
// so older and newer clients both get a usable, non-error response.
function negotiateProtocolVersion(requestedVersion) {
  if (requestedVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)) {
    return requestedVersion;
  }
  return PROTOCOL_VERSION;
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
