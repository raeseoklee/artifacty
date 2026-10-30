// Builds the OpenAPI 3.1 document served at GET /openapi.json and the
// human-readable reference page at GET /docs/api (see src/server.js).
//
// The route table below is the single source of truth for both. It is not
// wired into server.js dispatch (server.js keeps its existing if-chain per
// the working rules for this change) but test/openapi.test.js greps
// server.js for its route literals and cross-checks them against this table
// so the two cannot silently drift apart.
import { inlineSchema, schemas } from "./schemas.js";
import { createI18n, availableLanguages, defaultLocale } from "./i18n.js";

const OPENAPI_VERSION = "3.1.0";

export const routeTable = [
  { method: "GET", path: "/api/categories", auth: "read", summary: "List personal and team categories", description: "Requires an active personal account. Counts include only readable artifacts. Team categories require membership or administrator role.", parameters: [{ name: "artifactId", in: "query", schema: { type: "string" } }], responseSchema: "CategoryList" },
  { method: "POST", path: "/api/categories", auth: "write", summary: "Create a personal or team category", description: "Categories organize references without changing artifact visibility. Team scope requires teamId and current team membership or administrator role.", responseSchema: "Category", responseStatus: 201 },
  { method: "PATCH", path: "/api/categories/{id}", auth: "write", summary: "Rename a category", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responseSchema: "Category" },
  { method: "DELETE", path: "/api/categories/{id}", auth: "write", summary: "Delete a category without deleting its artifacts", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] },
  ...["PUT", "DELETE"].map((method) => ({ method, path: "/api/categories/{id}/artifacts/{artifactId}", auth: "write", summary: method === "PUT" ? "Add an artifact to a category" : "Remove an artifact from a category", description: "Requires category access and permission to read the artifact. Does not grant artifact access to other category members.", parameters: ["id", "artifactId"].map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })) })),
  { method: "GET", path: "/api/category-teams", auth: "read", summary: "List teams available for shared categories", description: "Returns the account's teams, or all teams for an administrator. Requires an active personal account.", responseSchema: "CategoryTeams" },

  {
    method: "GET",
    path: "/api/artifacts",
    auth: "read",
    summary: "List artifacts",
    description: "List artifacts with optional query, tag, sourceAgent, artifactType, publisher, date range, reviewStatus, relation, mode, and archive filters, paginated with limit/offset. `?view=<name|id>` expands a saved view's filters first; any other query param passed alongside it overrides that filter.",
    parameters: [
      { name: "q", in: "query", schema: { type: "string" }, description: "Search query." },
      { name: "categoryId", in: "query", schema: { type: "string" }, description: "Filter by an accessible personal or team category before pagination." },
      { name: "tag", in: "query", schema: { type: "string" } },
      { name: "sourceAgent", in: "query", schema: { type: "string" } },
      { name: "artifactType", in: "query", schema: { type: "string" } },
      { name: "publisher", in: "query", schema: { type: "string" }, description: "Matches publisher id, publisher user id, or owner user id." },
      { name: "createdAfter", in: "query", schema: { type: "string", format: "date-time" } },
      { name: "createdBefore", in: "query", schema: { type: "string", format: "date-time" } },
      { name: "reviewStatus", in: "query", schema: { type: "string" } },
      { name: "relatedTo", in: "query", schema: { type: "string" } },
      { name: "relation", in: "query", schema: { type: "string" } },
      { name: "mode", in: "query", schema: { type: "string", enum: ["keyword", "semantic", "hybrid"] }, description: "Search mode. `hybrid` is the default when `q` is set and an embedding provider is configured (ARTIFACTY_EMBEDDINGS_URL or ARTIFACTY_EMBEDDINGS_COMMAND); otherwise `keyword` is used and the response's `search.fallback` is `true` if `semantic`/`hybrid` was requested." },
      { name: "view", in: "query", schema: { type: "string" }, description: "Name or id of a saved view whose filters are expanded and merged in." },
      { name: "includeArchived", in: "query", schema: { type: "boolean" } },
      { name: "limit", in: "query", schema: { type: "number" } },
      { name: "offset", in: "query", schema: { type: "number" } }
    ],
    responseSchema: "ArtifactListPage"
  },
  {
    method: "POST",
    path: "/api/artifacts",
    auth: "write",
    summary: "Create an artifact",
    description: "Create a new Artifacty-native artifact and its first version. Optional provenance {tool, provider, model} records self-reported tool and model details; user identity is assigned by the server. For a collection page, use format and artifactType collection, with content containing a serialized Collection document. References never grant access to their targets.",
    requestSchema: "ArtifactWithContent",
    responseSchema: "ArtifactWithContent",
    responseStatus: 201
  },
  {
    method: "POST",
    path: "/api/import",
    auth: "write",
    summary: "Import an external artifact",
    description: "Convert an artifact produced by another agent family into Artifacty format and store it.",
    responseSchema: "ArtifactWithContent",
    responseStatus: 201
  },
  {
    method: "GET",
    path: "/api/artifacts/{id}",
    auth: "read",
    summary: "Get an artifact",
    description: "Read artifact metadata and content by ID, optionally at a specific version.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "version", in: "query", schema: { type: "number" } }
    ],
    responseSchema: "ArtifactWithContent"
  },
  {
    method: "POST",
    path: "/api/artifacts/{id}",
    auth: "write",
    summary: "Append a new artifact version",
    description: "Append an immutable new version to an existing artifact. Supports optimistic concurrency via an `expectedVersion` request field; a stale expectedVersion returns 409.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ],
    responseSchema: "ArtifactWithContent",
    conflictResponse: true
  },
  {
    method: "POST",
    path: "/api/artifacts/{id}/archive",
    auth: "write",
    summary: "Archive an artifact",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ],
    responseSchema: "ArtifactWithContent"
  },
  {
    method: "POST",
    path: "/api/artifacts/{id}/restore",
    auth: "write",
    summary: "Restore an archived artifact",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ],
    responseSchema: "ArtifactWithContent"
  },
  {
    method: "POST",
    path: "/api/artifacts/{id}/visibility",
    auth: "write",
    summary: "Change an artifact's visibility",
    description: "Set visibility to 'public', 'team', or 'private'. Requires the artifact's owner or an admin. Public permits anonymous reading only in public server mode; private server mode still enforces sharing permissions.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ],
    responseSchema: "ArtifactWithContent"
  },
  {
    method: "POST",
    path: "/api/artifacts/{id}/owner",
    auth: "write",
    summary: "Reassign an artifact's owner",
    description: "Set ownerUserId. Requires the artifact's current owner or an admin.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ],
    responseSchema: "ArtifactWithContent"
  },
  {
    method: "GET",
    path: "/api/artifacts/{id}/diff",
    auth: "read",
    summary: "Diff two artifact versions",
    description: "Diff two versions of an artifact. `structured` is the default view for JSON-like formats (json, sarif, csv, notebook, bundle); `lines` otherwise.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "from", in: "query", schema: { type: "number" }, description: "Defaults to latestVersion - 1." },
      { name: "to", in: "query", schema: { type: "number" }, description: "Defaults to latestVersion." },
      { name: "view", in: "query", schema: { type: "string", enum: ["structured", "lines"] } }
    ],
    responseSchema: "DiffResult"
  },
  {
    method: "GET",
    path: "/api/artifacts/{id}/relations",
    auth: "read",
    summary: "List artifact relations",
    description: "List directed relations where the given artifact is either endpoint.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ],
    responseSchema: "RelationEntry",
    responseIsArray: true
  },
  {
    method: "POST",
    path: "/api/artifacts/{id}/relations",
    auth: "write",
    summary: "Create an artifact relation",
    description: "Link the given artifact to another artifact with a named relation type.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ],
    responseSchema: "RelationEntry",
    responseStatus: 201
  },
  {
    method: "DELETE",
    path: "/api/artifacts/{id}/relations/{relationId}",
    auth: "write",
    summary: "Delete an artifact relation",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "relationId", in: "path", required: true, schema: { type: "string" } }
    ],
    responseStatus: 204
  },
  {
    method: "GET",
    path: "/api/artifacts/{id}/comments",
    auth: "read",
    summary: "List artifact comments",
    description: "List comments and review-thread replies on an artifact, optionally filtered to one version or status. Soft-deleted comments are hidden unless includeDeleted=true.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "version", in: "query", schema: { type: "number" } },
      { name: "status", in: "query", schema: { type: "string", enum: ["open", "resolved"] } },
      { name: "includeDeleted", in: "query", schema: { type: "boolean" } }
    ],
    responseSchema: "CommentList"
  },
  {
    method: "POST",
    path: "/api/artifacts/{id}/comments",
    auth: "write",
    summary: "Add a comment",
    description: "Add a comment or a reply to a root comment (threads are one level deep) on the given artifact version, defaulting to the latest version. body is Markdown, capped at 16 KB.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ],
    responseSchema: "CommentEntry",
    responseStatus: 201
  },
  {
    method: "POST",
    path: "/api/artifacts/{id}/comments/{commentId}/resolve",
    auth: "write",
    summary: "Resolve a comment",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "commentId", in: "path", required: true, schema: { type: "string" } }
    ],
    responseSchema: "CommentEntry"
  },
  {
    method: "DELETE",
    path: "/api/artifacts/{id}/comments/{commentId}",
    auth: "write",
    summary: "Delete a comment",
    description: "Soft-deletes the comment; it is hidden from listComments but its audit-log record is kept.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "commentId", in: "path", required: true, schema: { type: "string" } }
    ],
    responseSchema: "CommentEntry"
  },
  {
    method: "POST",
    path: "/api/artifacts/{id}/review-status",
    auth: "write",
    summary: "Set an artifact's review status",
    description: "Set reviewStatus to 'none', 'pending', 'changes-requested', or 'approved'. Requires the artifact's owner or an admin. Automatically resets to 'pending' when a new version is appended after 'approved'.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ],
    responseSchema: "ArtifactWithContent"
  },
  {
    method: "GET",
    path: "/api/audit",
    auth: "read",
    summary: "List audit events",
    parameters: [
      { name: "artifactId", in: "query", schema: { type: "string" } },
      { name: "limit", in: "query", schema: { type: "number" } }
    ],
    responseSchema: "AuditEventList"
  },
  {
    method: "GET",
    path: "/api/admin/backup",
    auth: "admin",
    summary: "Export a store backup",
    description: "Download artifacts and versions as one JSON backup bundle. With `?scope=full`, also includes users, API token records (hashed), audit log, artifact relations, and webhooks (without secrets). Requires admin privileges.",
    parameters: [
      { name: "scope", in: "query", schema: { type: "string", enum: ["artifacts", "full"] }, description: "Bundle scope. Defaults to \"artifacts\"." }
    ]
  },
  {
    method: "POST",
    path: "/api/admin/backup/import",
    auth: "admin",
    summary: "Import a store backup",
    description: "Restore artifacts and versions from a previously exported backup bundle. A `full`-scope bundle also replaces users, API tokens, audit log, relations, and webhooks; it requires `confirm: \"replace-all\"` and refuses when the target already has users unless `forceUsers` is set. Accepts either the raw bundle as the request body or `{ bundle, confirm, forceUsers }`. Requires admin privileges and a local request origin.",
    requestSchema: null
  },
  {
    method: "POST",
    path: "/mcp",
    auth: "read",
    summary: "MCP JSON-RPC endpoint",
    description: "Streamable-HTTP MCP transport. Accepts one or a batch of JSON-RPC 2.0 request objects when the server was started with --mcp-http.",
    requestSchema: null,
    responseSchema: null
  },
  {
    method: "GET",
    path: "/api/events",
    auth: "read",
    summary: "Stream or poll change-notification events",
    description: "With `Accept: text/event-stream`, opens a Server-Sent Events stream of change events, replaying from `Last-Event-ID` when set. Without that header, returns a JSON page of events newer than `?since=` (a seq number).",
    parameters: [
      { name: "since", in: "query", schema: { type: "number" }, description: "Replay events with seq greater than this value (JSON polling mode)." },
      { name: "type", in: "query", schema: { type: "string" } },
      { name: "tag", in: "query", schema: { type: "string" } },
      { name: "artifactId", in: "query", schema: { type: "string" } },
      { name: "sourceAgent", in: "query", schema: { type: "string" } }
    ],
    responseSchema: "EventList"
  },
  {
    method: "GET",
    path: "/api/webhooks",
    auth: "write",
    summary: "List webhooks",
    responseSchema: "WebhookList"
  },
  {
    method: "POST",
    path: "/api/webhooks",
    auth: "write",
    summary: "Create a webhook",
    description: "Registers an outbound webhook. The response includes `secret` once; it is used to verify the `X-Artifacty-Signature` header on deliveries and is never returned again. Admin-only once user accounts exist.",
    responseSchema: "Webhook",
    responseStatus: 201
  },
  {
    method: "DELETE",
    path: "/api/webhooks/{id}",
    auth: "write",
    summary: "Delete a webhook",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ],
    responseSchema: "Webhook"
  },
  {
    method: "POST",
    path: "/api/webhooks/{id}/test",
    auth: "write",
    summary: "Send a test delivery to a webhook",
    description: "Delivers a synthetic artifact.updated event to the webhook immediately, bypassing the event bus, to verify the endpoint and signature.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ]
  },
  {
    method: "GET",
    path: "/api/views",
    auth: "read",
    summary: "List saved views",
    description: "Lists saved dashboard filter sets. In single-user mode (no users) all views are returned; in team mode a caller sees their own views plus any view another user marked shared.",
    responseSchema: "SavedViewList"
  },
  {
    method: "POST",
    path: "/api/views",
    auth: "write",
    summary: "Save a filter set as a view",
    description: "Creates a saved view from a name and an allowlisted filters object (query, tag, sourceAgent, artifactType, publisher, createdAfter, createdBefore, reviewStatus, relatedTo, relation, includeArchived, mode). Set `shared: true` so it appears for every user in team mode.",
    responseSchema: "SavedView",
    responseStatus: 201
  },
  {
    method: "DELETE",
    path: "/api/views/{id}",
    auth: "write",
    summary: "Delete a saved view",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ],
    responseSchema: "SavedView"
  },
  {
    method: "GET",
    path: "/api/admin/retention",
    auth: "admin",
    summary: "Get the retention policy",
    description: "Returns the current retention policy (archive/purge windows, audit and event pruning, keep tags). Requires admin privileges.",
    responseSchema: "RetentionPolicy"
  },
  {
    method: "PUT",
    path: "/api/admin/retention",
    auth: "admin",
    summary: "Set the retention policy",
    description: "Replaces the retention policy. Unset fields are normalized to null/empty defaults. Requires admin privileges and a local request origin.",
    requestSchema: "RetentionPolicy",
    responseSchema: "RetentionPolicy"
  },
  {
    method: "POST",
    path: "/api/admin/retention/run",
    auth: "admin",
    summary: "Run a retention sweep",
    description: "Evaluates the retention policy against the store. With `{ dryRun: true }` (the default), returns a report and makes no changes. With `{ dryRun: false }`, archives and (only when ARTIFACTY_RETENTION_ALLOW_PURGE=true and `allowPurge: true`) purges eligible artifacts, prunes audit and event rows, and writes a retention-sweep audit summary. Requires admin privileges and a local request origin.",
    responseSchema: "RetentionReport"
  },
  {
    method: "GET",
    path: "/artifacts/{id}/export",
    auth: "read",
    browserRoute: true,
    summary: "Download a filtered/sorted CSV or SARIF export",
    description: "Re-parses the stored original content (the immutable `/raw` source is untouched) and streams a fresh file with `Content-Disposition: attachment`, capped at the server's max artifact byte size. `format=csv` requires a CSV artifact and accepts `sort` (column name or 0-based index), `dir` (`asc`|`desc`), and `filter` (`col:text[,col:text...]`, case-insensitive contains match). `format=sarif` requires a SARIF artifact and accepts `level` (comma-separated `error,warning,note,none`) and `rule` (case-insensitive rule id substring match); the exported document keeps only matching results per run. Invalid parameters return 400 with `code: \"invalid_export\"`.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "version", in: "query", schema: { type: "number" } },
      { name: "format", in: "query", required: true, schema: { type: "string", enum: ["csv", "sarif"] } },
      { name: "sort", in: "query", schema: { type: "string" }, description: "CSV only: column name or 0-based index to sort by." },
      { name: "dir", in: "query", schema: { type: "string", enum: ["asc", "desc"] }, description: "CSV only: sort direction." },
      { name: "filter", in: "query", schema: { type: "string" }, description: "CSV only: col:text[,col:text...] contains filter." },
      { name: "level", in: "query", schema: { type: "string" }, description: "SARIF only: comma-separated levels to keep (error, warning, note, none)." },
      { name: "rule", in: "query", schema: { type: "string" }, description: "SARIF only: case-insensitive rule id substring filter." }
    ]
  }
];

// Request examples describe accepted inputs, independently of response records.
const requestExamples = {
  "POST /api/categories": { name: "Research", scope: "personal" },
  "PATCH /api/categories/{id}": { name: "Research notes" },
  "POST /api/artifacts": { title: "Release notes", content: "# Release notes\nFirst release.", format: "markdown", tags: ["release"], visibility: "private" },
  "POST /api/import": { agent: "generic", title: "Imported notes", content: "# Notes", format: "markdown" },
  "POST /api/artifacts/{id}": { content: "# Release notes\nUpdated release.", format: "markdown", expectedVersion: 1 },
  "POST /api/artifacts/{id}/visibility": { visibility: "private" },
  "POST /api/artifacts/{id}/owner": { ownerUserId: "user-example" },
  "POST /api/artifacts/{id}/relations": { toId: "artifact-related", relation: "references" },
  "POST /api/artifacts/{id}/comments": { body: "Please review this section.", version: 1 },
  "POST /api/artifacts/{id}/review-status": { status: "approved" },
  "POST /api/webhooks": { url: "https://example.com/artifacty-webhook", eventTypes: ["artifact.created"] },
  "POST /api/views": { name: "Release notes", filters: { tag: "release" }, shared: false },
  "PUT /api/admin/retention": { archiveAfterDays: { default: null, byType: {} }, purgeArchivedAfterDays: null, auditRetentionDays: null, eventRetentionRows: null, keepTags: ["keep"] },
  "POST /api/admin/retention/run": { dryRun: true },
  "POST /mcp": { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
};

function exampleInputSchema(value) {
  if (value === null) return { type: ["number", "null"] };
  if (Array.isArray(value)) return { type: "array", items: value.length ? exampleInputSchema(value[0]) : {} };
  if (typeof value === "object") return { type: "object", properties: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, exampleInputSchema(item)])) };
  return { type: typeof value === "number" ? "integer" : typeof value };
}

export function schemaExample(schema, definitions = schemas, name = "", depth = 0) {
  if (!schema || depth > 12) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.$ref) return schemaExample(definitions[schema.$ref.split("/").pop()], definitions, name, depth + 1);
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((part) => schemaExample(part, definitions, name, depth + 1)));
  if (schema.enum) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (type === "object" || schema.properties) return Object.fromEntries((schema.required || []).map((key) => [key, schemaExample(schema.properties?.[key] || {}, definitions, key, depth + 1)]));
  if (type === "array") return [];
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return schema.minimum ?? (/(version|from|to)/i.test(name) ? 1 : 0);
  if (schema.format === "date-time") return "2026-01-01T00:00:00.000Z";
  if (schema.format === "uri") return "https://example.com/artifact";
  return ({ id: "artifact-example", title: "Release notes", sourceAgent: "generic", content: "# Release notes", body: "Please review this section.", authorLabel: "Example user" })[name] || "example";
}

export function listDocumentedRoutes() {
  return routeTable.map(({ method, path }) => ({ method, path }));
}

export function buildOpenApiDocument({ baseUrl = "http://127.0.0.1:8787" } = {}) {
  const paths = {};
  for (const route of routeTable) {
    const openApiPath = route.path;
    paths[openApiPath] = paths[openApiPath] || {};
    paths[openApiPath][route.method.toLowerCase()] = buildOperation(route);
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "Artifacty API",
      version: "1",
      description: "Local, agent-to-agent artifact exchange. This document covers the /api/* JSON routes and the /mcp JSON-RPC endpoint; see docs/mcp-public-api.md for the full MCP tool surface."
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }, { tokenHeader: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Personal or global API token as `Authorization: Bearer <token>`."
        },
        tokenHeader: {
          type: "apiKey",
          in: "header",
          name: "x-artifacty-token",
          description: "Personal or global API token as an `x-artifacty-token` header. A `token` query parameter is also accepted for browser links."
        }
      },
      schemas: { ...schemas, ArtifactRecord: { allOf: [{ $ref: "#/components/schemas/ArtifactSummary" }, { type: "object", properties: { versions: { type: "array", items: { $ref: "#/components/schemas/ArtifactVersion" } } }, required: ["versions"] }] } }
    },
    paths
  };
}

function buildOperation(route) {
  route = { ...route };
  if (route.method !== "GET" && route.responseSchema === "ArtifactWithContent") route.responseSchema = "ArtifactRecord";
  if (route.method === "DELETE" && route.path.includes("/relations/")) { route.responseStatus = 200; route.responseSchema = "RelationEntry"; }
  if (route.path.startsWith("/api/webhooks")) route.auth = "admin";
  const responses = {};
  const successStatus = String(route.responseStatus || 200);
  responses[successStatus] = {
    description: route.summary || "Successful response",
    ...(route.responseSchema
      ? {
        content: {
          "application/json": {
            schema: route.responseIsArray
              ? { type: "array", items: { $ref: `#/components/schemas/${route.responseSchema}` } }
              : { $ref: `#/components/schemas/${route.responseSchema}` }
          }
        }
      }
      : {})
  };
  responses["401"] = errorResponse("Missing or invalid authentication.");
  responses["403"] = errorResponse("The authenticating token lacks a required scope (code: scope_denied).");
  responses["429"] = errorResponse("Rate limit exceeded for this route's bucket (code: rate_limited). See the Retry-After response header.");
  responses["404"] = errorResponse("Artifact, version, or relation not found.");
  if (route.conflictResponse) {
    responses["409"] = errorResponse("expectedVersion did not match the artifact's current version.");
  }

  const operation = {
    operationId: operationId(route),
    summary: route.summary,
    tags: [tagFor(route.path)]
  };
  if (route.description) {
    operation.description = route.description;
  }
  if (route.parameters) {
    operation.parameters = route.parameters;
  }
  if (route.requestSchema) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${route.requestSchema}` }
        }
      }
    };
  }
  const requestExample = requestExamples[`${route.method} ${route.path}`];
  if (requestExample) operation.requestBody = { required: true, content: { "application/json": { schema: route.requestSchema === "RetentionPolicy" ? { $ref: "#/components/schemas/RetentionPolicy" } : { ...exampleInputSchema(requestExample), description: "Properties used in this request example. This is not an exhaustive list of accepted optional fields." }, example: requestExample } } };
  if (route.auth === "admin") {
    operation.responses = { ...responses, 403: errorResponse("Admin privileges required.") };
  } else {
    operation.responses = responses;
  }
  operation["x-artifacty-access"] = route.auth || "read";
  return operation;
}

function errorResponse(description) {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" }
      }
    }
  };
}

function operationId(route) {
  return `${route.method.toLowerCase()}${route.path
    .replace(/[{}]/g, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join("")}`;
}

function tagFor(path) {
  if (path.startsWith("/api/webhooks")) return "Webhooks";
  if (path.startsWith("/api/views")) return "Views";
  if (path.startsWith("/api/events")) return "Events";
  if (path.startsWith("/api/admin")) {
    return "Admin";
  }
  if (path.includes("/relations")) {
    return "Relations";
  }
  if (path.includes("/comments") || path.includes("/review-status")) {
    return "Comments";
  }
  if (path.startsWith("/api/audit")) {
    return "Audit";
  }
  if (path.startsWith("/mcp")) {
    return "MCP";
  }
  return "Artifacts";
}

export function buildCurlExample({ baseUrl, apiPath, method, operation }) {
  const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
  let url = (baseUrl || "http://127.0.0.1:8787").replace(/\/$/, "") + apiPath.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(name === "id" ? "artifact-example" : `${name}-example`));
  const query = (operation.parameters || []).filter((parameter) => parameter.in === "query" && parameter.required).map((parameter) => `${encodeURIComponent(parameter.name)}=${encodeURIComponent(schemaExample(parameter.schema))}`);
  if (query.length) url += "?" + query.join("&");
  const lines = [`curl --request ${method.toUpperCase()} ${quote(url)}`, `  --header 'Authorization: Bearer YOUR_API_TOKEN'`];
  const example = operation.requestBody?.content?.["application/json"]?.example;
  if (example !== undefined) lines.push("  --header 'Content-Type: application/json'", `  --data-raw ${quote(JSON.stringify(example))}`);
  if (apiPath === "/api/admin/backup/import") lines.push("  --header 'Content-Type: application/json'", "  --data-binary '@backup.json'");
  return lines.join(" \\\n");
}

export function renderApiDocsHtml({ baseUrl = "", locale = defaultLocale(), currentPath = "/docs/api" } = {}) {
  const document = buildOpenApiDocument({ baseUrl });
  const { t, locale: language } = createI18n(locale);
  const label = (key) => escapeHtml(t(`apiDocs.${key}`));
  const current = new URL(currentPath, "http://artifacty.local");
  const preserved = [...current.searchParams.entries()].filter(([name]) => name !== "lang")
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join("");
  const languageOptions = availableLanguages().filter((item) => item.enabled)
    .map((item) => `<option value="${escapeHtml(item.locale)}"${item.locale === language ? " selected" : ""}>${escapeHtml(item.nativeName)}</option>`).join("");
  const languageSelector = `<form class="language-switcher" data-auto-apply="all" method="get" action="${escapeHtml(`${current.pathname}${current.hash}`)}">${preserved}<label>${escapeHtml(t("language.label"))} <select class="form-select" name="lang">${languageOptions}</select></label><button class="btn btn-outline-secondary" type="submit">${escapeHtml(t("language.apply"))}</button></form>`;

  const code = (value) => `<pre><code>${escapeHtml(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</code></pre>`;
  const snippet = (value) => `<div class="snippet"><button class="btn btn-outline-secondary btn-sm" type="button" data-copy hidden>${label("copy")}</button>${code(value)}</div>`;
  const rows = Object.entries(document.paths).flatMap(([apiPath, operations]) => Object.entries(operations).map(([method, operation]) => ({ apiPath, method, operation })));
  const tags = [...new Set(rows.map(({ operation }) => operation.tags[0]))];
  const render = ({ apiPath, method, operation }) => {
    const request = operation.requestBody?.content?.["application/json"];
    const parameters = (operation.parameters || []).map((parameter) => `<tr><th scope="row">${escapeHtml(parameter.name)}</th><td>${escapeHtml(parameter.in)}</td><td>${escapeHtml(parameter.schema?.type || "string")}${parameter.required ? ` · ${label("required")}` : ""}</td><td>${escapeHtml(parameter.description || "")}${parameter.schema?.enum ? code(parameter.schema.enum) : ""}</td></tr>`).join("");
    const responses = Object.entries(operation.responses).map(([status, response]) => {
      const media = response.content?.["application/json"];
      const example = media ? media.example ?? schemaExample(media.schema, document.components.schemas) : undefined;
      return `<details class="response"><summary>${escapeHtml(status)} · ${escapeHtml(response.description)}</summary>${example !== undefined ? `<h4>${label("responseExample")}</h4>${snippet(example)}<details><summary>${label("schema")}</summary>${code(media.schema)}</details>` : `<p>${label("noSchema")}</p>`}</details>`;
    }).join("");
    return `<details class="operation" id="${escapeHtml(operation.operationId)}" data-operation data-search="${escapeHtml(`${method} ${apiPath} ${operation.summary} ${operation.tags.join(" ")}`.toLowerCase())}"><summary><span class="method ${method}">${method.toUpperCase()}</span><code class="path">${escapeHtml(apiPath)}</code><span class="summary-text">${escapeHtml(operation.summary)}</span></summary><div class="operation-body"><p>${escapeHtml(operation.description || operation.summary)}</p><p class="muted">${label("access")}: ${escapeHtml(operation["x-artifacty-access"])}</p>${parameters ? `<h3>${label("parameters")}</h3><div class="table-scroll"><table><thead><tr><th>${label("name")}</th><th>${label("location")}</th><th>${label("type")}</th><th>${label("description")}</th></tr></thead><tbody>${parameters}</tbody></table></div>` : ""}${request ? `<h3>${label("requestExample")}</h3>${snippet(request.example ?? schemaExample(request.schema, document.components.schemas))}<details><summary>${label("schema")}</summary>${code(request.schema)}</details>` : ""}<h3>curl</h3>${snippet(buildCurlExample({ baseUrl, apiPath, method, operation }))}<h3>${label("responses")}</h3>${responses}</div></details>`;
  };
  return `<!doctype html><html lang="${escapeHtml(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Artifacty ${label("title")}</title><script src="/assets/theme.js"></script><script type="module" src="/assets/auto-apply.js"></script><style>
  :root{color-scheme:light;--bg:#f5f6f8;--panel:#fff;--text:#20242b;--muted:#58616e;--line:#dce0e6;--accent:#315ca8;--code:#f0f2f5}
  :root[data-theme="dark"]{color-scheme:dark;--bg:#15171b;--panel:#1c1f24;--text:#edf0f3;--muted:#adb5c0;--line:#363c45;--accent:#9cbcf5;--code:#15171b}
  @media(prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#15171b;--panel:#1c1f24;--text:#edf0f3;--muted:#adb5c0;--line:#363c45;--accent:#9cbcf5;--code:#15171b}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--accent)}header,main{max-width:1200px;margin:auto;padding:24px 32px}header{border-bottom:1px solid var(--line)}h1{font-size:30px;letter-spacing:-.03em;margin:14px 0 4px}h2{font-size:21px;margin-top:32px}h3{font-size:16px;margin:24px 0 8px}h4{margin-bottom:8px}.muted{color:var(--muted)}nav{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.language-switcher{display:flex;align-items:center;gap:8px}.language-switcher label{display:flex;align-items:center;gap:8px}input{display:block;width:100%;padding:12px;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:6px;font:inherit;margin:8px 0 24px}.operation{background:var(--panel);border:1px solid var(--line);border-radius:6px;margin:8px 0;scroll-margin-top:16px}summary{cursor:pointer;padding:12px;overflow-wrap:anywhere}.operation>summary{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.operation>summary::before{content:"▸";color:var(--muted)}.operation[open]>summary::before{content:"▾"}.method{font-size:12px;font-weight:750;min-width:58px;color:var(--accent)}.delete{color:#bd4545}.path{font-size:13px}.summary-text{color:var(--muted);margin-left:auto}.operation-body{padding:4px 20px 20px;border-top:1px solid var(--line)}pre{background:var(--code);padding:16px;overflow:auto;border-radius:4px;font-size:12px;line-height:1.7;max-height:420px}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.snippet{position:relative}.snippet button{float:right;margin:8px}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left;font-size:13px}th,td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}.response{border-top:1px solid var(--line)}[hidden]{display:none!important}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}@media(max-width:650px){header,main{padding:20px 16px}.summary-text{width:100%;margin-left:28px}.operation-body{padding:4px 12px 16px}.path{font-size:12px}h1{font-size:25px}}
  </style><link rel="stylesheet" href="/assets/ui-controls.css"><script type="module" src="/assets/api-docs.js"></script></head><body data-copy-success="${label("copied")}" data-copy-failure="${label("copyFailed")}"><header><nav><a href="/?lang=${escapeHtml(language)}">Artifacty</a><a class="btn btn-outline-secondary" href="/openapi.json" download="artifacty-openapi.json">${label("download")}</a>${languageSelector}</nav><h1>${label("title")}</h1><p class="muted">${label("intro")}</p><nav>${tags.map((tag) => `<a href="#tag-${tag}">${tag}</a>`).join("")}<a href="#schemas">${label("schemas")}</a></nav></header><main><div data-search-controls hidden><label for="api-search">${label("search")}</label><input class="form-control" id="api-search" type="search" placeholder="${label("searchPlaceholder")}" autocomplete="off"></div><p data-no-results hidden role="status">${label("noResults")}</p><p class="muted">${label("sampleNote")}</p>${tags.map((tag) => `<section data-tag-group id="tag-${tag}"><h2>${tag}</h2>${rows.filter(({ operation }) => operation.tags[0] === tag).map(render).join("")}</section>`).join("")}<section id="schemas"><h2>${label("schemas")}</h2>${Object.entries(document.components.schemas).map(([name, schema]) => `<details class="operation"><summary>${escapeHtml(name)}</summary>${code(schema)}</details>`).join("")}</section><p role="status" aria-live="polite" data-copy-status></p></main></body></html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export { inlineSchema };
