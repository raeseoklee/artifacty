#!/usr/bin/env node
import readline from "node:readline";
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
const store = createStore();

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
    description: "List artifacts from the local Artifacty store.",
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

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  handleLine(line).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
  });
});

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeResponse(null, undefined, {
      code: -32700,
      message: "Parse error"
    });
    return;
  }

  if (!message.id && message.id !== 0) {
    await handleNotification(message);
    return;
  }

  try {
    const result = await handleRequest(message);
    writeResponse(message.id, result);
  } catch (error) {
    writeResponse(message.id, undefined, {
      code: error.jsonRpcCode || -32603,
      message: error.message
    });
  }
}

async function handleNotification(message) {
  if (message.method === "notifications/initialized") {
    return;
  }
  process.stderr.write(`Ignoring MCP notification: ${message.method}\n`);
}

async function handleRequest(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      serverInfo: {
        name: "artifacty",
        title: "Artifacty",
        version: "0.3.0"
      },
      instructions: "Use Artifacty to create, import, list, read, and update local artifacts that other agents can reuse."
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
    return callTool(params.name, params.arguments || {});
  }

  throw Object.assign(new Error(`Method not found: ${message.method}`), {
    jsonRpcCode: -32601
  });
}

async function callTool(name, args) {
  if (name === "artifacty_create" || name === "artifacty_publish") {
    return toolResult(await withUrls(await createNativeArtifact(args)));
  }

  if (name === "artifacty_list") {
    const publicBaseUrl = await resolvePublicBaseUrl(store);
    const page = await listArtifactsPage(store, args);
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
    const artifact = await createArtifact(store, {
      ...converted,
      allowSecrets: args.allowSecrets,
      auditAction: "import",
      audit: mcpAuditContext()
    });
    return toolResult({
      ...await withUrls(artifact),
      converted
    });
  }

  if (name === "artifacty_get") {
    const artifact = await getArtifact(store, requireArg(args, "id"), {
      version: args.version,
      audit: mcpAuditContext()
    });
    const decorated = await withUrls(artifact);
    if (args.includeContent === false) {
      delete decorated.content;
    }
    return toolResult(decorated);
  }

  if (name === "artifacty_update") {
    const artifact = await updateArtifact(store, requireArg(args, "id"), {
      title: args.title,
      content: args.content,
      format: args.format,
      artifactType: args.artifactType,
      schemaVersion: args.schemaVersion,
      sourceAgent: args.sourceAgent || "mcp",
      tags: args.tags || [],
      metadata: args.metadata || {},
      allowSecrets: args.allowSecrets,
      audit: mcpAuditContext()
    });
    return toolResult(await withUrls(artifact));
  }

  if (name === "artifacty_archive" || name === "artifacty_restore") {
    const artifact = name === "artifacty_archive"
      ? await archiveArtifact(store, requireArg(args, "id"), { audit: mcpAuditContext() })
      : await restoreArtifact(store, requireArg(args, "id"), { audit: mcpAuditContext() });
    return toolResult(await withUrls(artifact));
  }

  if (name === "artifacty_audit") {
    return toolResult({
      events: await listAuditEvents(store, {
        artifactId: args.artifactId,
        limit: args.limit
      })
    });
  }

  if (name === "artifacty_info") {
    const publicBaseUrl = await resolvePublicBaseUrl(store);
    return toolResult({
      name: "artifacty",
      store: store.home,
      url: publicBaseUrl,
      mcpProtocolVersion: PROTOCOL_VERSION,
      serverCommand: "node src/mcp-server.js",
      browserCommand: "npm start"
    });
  }

  throw Object.assign(new Error(`Unknown tool: ${name}`), {
    jsonRpcCode: -32602
  });
}

async function createNativeArtifact(args) {
  return createArtifact(store, {
    title: args.title,
    content: args.content,
    format: args.format,
    artifactType: args.artifactType,
    schemaVersion: args.schemaVersion,
    sourceAgent: args.sourceAgent || "mcp",
    tags: args.tags || [],
    metadata: args.metadata || {},
    allowSecrets: args.allowSecrets,
    audit: mcpAuditContext()
  });
}

function mcpAuditContext() {
  return {
    surface: "mcp",
    actor: "mcp-client"
  };
}

async function withUrls(artifact) {
  const publicBaseUrl = await resolvePublicBaseUrl(store);
  return {
    ...artifact,
    url: `${publicBaseUrl}/artifacts/${encodeURIComponent(artifact.id)}`,
    rawUrl: `${publicBaseUrl}/artifacts/${encodeURIComponent(artifact.id)}/raw?version=${artifact.version.version}`
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

function writeResponse(id, result, error) {
  const response = {
    jsonrpc: "2.0",
    id
  };
  if (error) {
    response.error = error;
  } else {
    response.result = result;
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
