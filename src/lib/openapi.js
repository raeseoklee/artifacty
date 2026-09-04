// Builds the OpenAPI 3.1 document served at GET /openapi.json and the
// human-readable reference page at GET /docs/api (see src/server.js).
//
// The route table below is the single source of truth for both. It is not
// wired into server.js dispatch (server.js keeps its existing if-chain per
// the working rules for this change) but test/openapi.test.js greps
// server.js for its route literals and cross-checks them against this table
// so the two cannot silently drift apart.
import { inlineSchema, schemas } from "./schemas.js";

const OPENAPI_VERSION = "3.1.0";

export const routeTable = [
  {
    method: "GET",
    path: "/api/artifacts",
    auth: "read",
    summary: "List artifacts",
    description: "List artifacts with optional query, tag, sourceAgent, artifactType, publisher, date range, reviewStatus, relation, mode, and archive filters, paginated with limit/offset. `?view=<name|id>` expands a saved view's filters first; any other query param passed alongside it overrides that filter.",
    parameters: [
      { name: "q", in: "query", schema: { type: "string" }, description: "Search query." },
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
    description: "Create a new Artifacty-native artifact and its first version.",
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
    description: "Set visibility to 'team' or 'private'. Requires the artifact's owner or an admin.",
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
    description: "Evaluates the retention policy against the store. With `{ dryRun: true }` (the default), returns a report and makes no changes. With `{ dryRun: false }`, archives and (if ARTIFACTY_RETENTION_ALLOW_PURGE=true or `allowPurge: true`) purges eligible artifacts, prunes audit and event rows, and writes a retention-sweep audit summary. Requires admin privileges and a local request origin.",
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
      schemas
    },
    paths
  };
}

function buildOperation(route) {
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
  if (route.auth === "admin") {
    operation.responses = { ...responses, 403: errorResponse("Admin privileges required.") };
  } else {
    operation.responses = responses;
  }
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

export function renderApiDocsHtml({ baseUrl = "" } = {}) {
  const document = buildOpenApiDocument({ baseUrl });
  const rows = Object.entries(document.paths)
    .flatMap(([apiPath, operations]) =>
      Object.entries(operations).map(([method, operation]) => ({ method, apiPath, operation }))
    )
    .sort((left, right) => left.apiPath.localeCompare(right.apiPath) || left.method.localeCompare(right.method));

  const routeSections = rows
    .map(({ method, apiPath, operation }) => renderRouteSection(method, apiPath, operation))
    .join("\n");

  const schemaSections = Object.entries(document.components.schemas)
    .map(([name, schema]) => renderSchemaSection(name, schema))
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifacty API reference</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 2rem; max-width: 960px; color: #1a1a1a; background: #fff; }
  h1 { margin-bottom: 0.25rem; }
  .lede { color: #555; margin-top: 0; }
  .route { border: 1px solid #ddd; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
  .route h3 { margin: 0 0 0.25rem; font-family: ui-monospace, monospace; }
  .method { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: bold; color: #fff; margin-right: 0.5rem; }
  .method-get { background: #2563eb; }
  .method-post { background: #16a34a; }
  .method-delete { background: #dc2626; }
  .params { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.9rem; }
  .params th, .params td { text-align: left; border-bottom: 1px solid #eee; padding: 0.25rem 0.5rem; }
  pre { background: #f6f6f6; padding: 0.75rem; border-radius: 6px; overflow-x: auto; font-size: 0.85rem; }
  nav a { margin-right: 0.75rem; }
  section.schema { margin: 0.75rem 0; }
</style>
</head>
<body>
<h1>Artifacty API reference</h1>
<p class="lede">${escapeHtml(document.info.description)} Machine-readable spec: <a href="/openapi.json">/openapi.json</a>.</p>
<nav><a href="#routes">Routes</a><a href="#schemas">Schemas</a></nav>
<h2 id="routes">Routes</h2>
${routeSections}
<h2 id="schemas">Schemas</h2>
${schemaSections}
</body>
</html>
`;
}

function renderRouteSection(method, apiPath, operation) {
  const paramRows = (operation.parameters || [])
    .map((param) => `<tr><td>${escapeHtml(param.name)}</td><td>${escapeHtml(param.in)}</td><td>${escapeHtml(param.schema?.type || "string")}</td><td>${param.required ? "yes" : "no"}</td></tr>`)
    .join("");
  const paramsTable = paramRows
    ? `<table class="params"><thead><tr><th>Name</th><th>In</th><th>Type</th><th>Required</th></tr></thead><tbody>${paramRows}</tbody></table>`
    : "";
  const description = operation.description ? `<p>${escapeHtml(operation.description)}</p>` : "";
  const responseCodes = Object.keys(operation.responses || {}).join(", ");
  return `<article class="route" id="${escapeHtml(`${method.toLowerCase()}-${apiPath}`)}">
  <h3><span class="method method-${escapeHtml(method.toLowerCase())}">${escapeHtml(method)}</span>${escapeHtml(apiPath)}</h3>
  <p>${escapeHtml(operation.summary || "")}</p>
  ${description}
  ${paramsTable}
  <p><strong>Responses:</strong> ${escapeHtml(responseCodes)}</p>
</article>`;
}

function renderSchemaSection(name, schema) {
  return `<section class="schema" id="schema-${escapeHtml(name)}">
  <h3>${escapeHtml(name)}</h3>
  <pre>${escapeHtml(JSON.stringify(schema, null, 2))}</pre>
</section>`;
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
