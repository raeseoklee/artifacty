// Shared JSON Schema definitions used by both the MCP tool surface
// (src/mcp-server.js `outputSchema`) and the OpenAPI document
// (src/lib/openapi.js). Keeping these in one module means the HTTP and MCP
// surfaces describe the same shapes instead of drifting apart.
import { ARTIFACT_FORMATS, ARTIFACT_TYPES, REVIEW_STATUSES, VISIBILITY_VALUES } from "./storage.js";

export const artifactVersionSchema = {
  type: "object",
  description: "One immutable, append-only artifact version.",
  properties: {
    version: { type: "number", description: "1-based version number." },
    createdAt: { type: "string", format: "date-time" },
    format: { type: "string", enum: ARTIFACT_FORMATS },
    contentType: { type: "string" },
    path: { type: "string", description: "Storage-relative path of the version file." },
    sizeBytes: { type: "number" },
    sha256: { type: "string" },
    metadata: { type: "object" }
  },
  required: ["version", "createdAt", "format", "sizeBytes"]
};

export const artifactSummarySchema = {
  type: "object",
  description: "Artifact metadata without content, as returned by list endpoints.",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    artifactType: { type: "string", enum: ARTIFACT_TYPES },
    schemaVersion: { type: "number" },
    sourceAgent: { type: "string" },
    publisherId: { type: ["string", "null"] },
    publisherName: { type: ["string", "null"] },
    publisherUserId: { type: ["string", "null"] },
    visibility: { type: "string", enum: VISIBILITY_VALUES, description: "'team' is visible to any authenticated user; 'private' is visible only to the owner and admins." },
    ownerUserId: { type: ["string", "null"] },
    reviewStatus: { type: "string", enum: REVIEW_STATUSES, description: "Set via POST /api/artifacts/{id}/review-status. Resets to 'pending' when a new version is appended after an 'approved' status." },
    tags: { type: "array", items: { type: "string" } },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    archivedAt: { type: ["string", "null"], format: "date-time" },
    latestVersion: { type: "number" },
    versionCount: { type: "number" },
    format: { type: "string", enum: ARTIFACT_FORMATS },
    contentType: { type: "string" },
    sizeBytes: { type: "number" },
    url: { type: "string", format: "uri" },
    rawUrl: { type: "string", format: "uri" },
    searchSnippet: { type: "string" }
  },
  required: ["id", "title", "sourceAgent", "createdAt", "updatedAt", "latestVersion"]
};

export const artifactWithContentSchema = {
  type: "object",
  description: "Full artifact record including metadata, selected version, and its content.",
  allOf: [
    { $ref: "#/components/schemas/ArtifactSummary" },
    {
      type: "object",
      properties: {
        versions: {
          type: "array",
          items: { $ref: "#/components/schemas/ArtifactVersion" }
        },
        version: { $ref: "#/components/schemas/ArtifactVersion" },
        content: { type: "string" }
      },
      required: ["version"]
    }
  ]
};

export const auditEventSchema = {
  type: "object",
  description: "One recorded audit-log entry.",
  properties: {
    id: { type: "number" },
    createdAt: { type: "string", format: "date-time" },
    action: { type: "string" },
    artifactId: { type: ["string", "null"] },
    version: { type: ["number", "null"] },
    sourceAgent: { type: ["string", "null"] },
    actor: { type: ["string", "null"] },
    surface: { type: ["string", "null"] },
    metadata: { type: "object" }
  },
  required: ["id", "createdAt", "action"]
};

export const paginationSchema = {
  type: "object",
  properties: {
    total: { type: "number" },
    limit: { type: "number" },
    offset: { type: "number" },
    hasMore: { type: "boolean" },
    nextOffset: { type: ["number", "null"] },
    previousOffset: { type: ["number", "null"] }
  },
  required: ["total", "limit", "offset", "hasMore"]
};

export const artifactListPageSchema = {
  type: "object",
  description: "A page of artifact summaries with pagination metadata.",
  properties: {
    artifacts: {
      type: "array",
      items: { $ref: "#/components/schemas/ArtifactSummary" }
    },
    pagination: { $ref: "#/components/schemas/Pagination" },
    search: { type: "object" }
  },
  required: ["artifacts", "pagination"]
};

// Relation entries describe a directed link between two artifacts (added by
// the concurrent relations feature). Kept here so both HTTP and MCP surfaces
// share one shape once artifacty_link/artifacty_unlink and the
// /api/artifacts/{id}/relations routes land.
export const relationEntrySchema = {
  type: "object",
  description: "A directed relation between two artifacts.",
  properties: {
    id: { type: "string" },
    fromArtifactId: { type: "string" },
    toArtifactId: { type: "string" },
    relationType: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    createdBy: { type: ["string", "null"] },
    metadata: { type: "object" }
  },
  required: ["id", "fromArtifactId", "toArtifactId", "relationType", "createdAt"]
};

// A comment or review-thread reply (roadmap section 5). `anchor` is a
// format-specific rendering hint ({ line }, { path }, or { row }) and is not
// validated against the artifact's actual content.
export const commentEntrySchema = {
  type: "object",
  description: "A comment or reply on one artifact version. Threads are one level deep: parentId, when set, always points to a root comment.",
  properties: {
    id: { type: "string" },
    artifactId: { type: "string" },
    version: { type: "number" },
    parentId: { type: ["string", "null"] },
    authorUserId: { type: ["string", "null"] },
    authorLabel: { type: "string" },
    sourceAgent: { type: ["string", "null"] },
    body: { type: "string", description: "Markdown, rendered through the same sanitized pipeline as artifact content." },
    anchor: { type: ["object", "null"] },
    status: { type: "string", enum: ["open", "resolved"] },
    createdAt: { type: "string", format: "date-time" },
    resolvedAt: { type: ["string", "null"], format: "date-time" },
    resolvedBy: { type: ["string", "null"] },
    deletedAt: { type: ["string", "null"], format: "date-time" }
  },
  required: ["id", "artifactId", "version", "authorLabel", "body", "status", "createdAt"]
};

export const commentListSchema = {
  type: "object",
  properties: {
    comments: {
      type: "array",
      items: { $ref: "#/components/schemas/CommentEntry" }
    }
  },
  required: ["comments"]
};

// Structured diff entries vary in shape by `kind` (json path entries, CSV
// row/cell entries, line entries with word-level highlights, or bundle
// per-file entries). Kept intentionally loose (`type: "object"`) here since
// OpenAPI/JSON Schema oneOf across those shapes would be more noise than
// signal for a diff payload that is primarily consumed structurally by
// agents, not validated field-by-field.
export const structuredDiffSchema = {
  type: "object",
  description: "A structured diff between two artifact versions, keyed by format-specific strategy (JSON path, CSV row/cell, line, or bundle per-file).",
  properties: {
    kind: { type: "string", enum: ["json", "csv", "lines", "bundle"] },
    entries: { type: "array", items: { type: "object" } },
    truncated: { type: "boolean" },
    summary: {
      type: "object",
      properties: {
        added: { type: "number" },
        removed: { type: "number" },
        changed: { type: "number" }
      }
    }
  },
  required: ["kind", "entries", "truncated", "summary"]
};

export const diffResultSchema = {
  type: "object",
  description: "The diff between two versions of an artifact, in structured or line form.",
  properties: {
    id: { type: "string" },
    from: { type: "number" },
    to: { type: "number" },
    view: { type: "string", enum: ["structured", "lines"] },
    format: { type: "string" },
    diffRows: { type: "array", items: { type: "object" } },
    structuredDiff: structuredDiffSchema
  },
  required: ["id", "from", "to", "view"]
};

export const errorSchema = {
  type: "object",
  description: "Standard Artifacty error response.",
  properties: {
    error: { type: "string" },
    code: { type: "string" },
    details: { type: "object" }
  },
  required: ["error"]
};

export const auditEventListSchema = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: { $ref: "#/components/schemas/AuditEvent" }
    }
  },
  required: ["events"]
};

// Change-notification event (roadmap section 3). Shared by the SSE stream,
// the /api/events?since= JSON poll, artifacty_wait's tool result, and
// resources/updated notification payloads.
export const eventSchema = {
  type: "object",
  description: "A published change-notification event, derived from an audit-log row.",
  properties: {
    seq: { type: "number", description: "Monotonic replay position; pass as Last-Event-ID or ?since= to resume." },
    id: { type: "string" },
    type: {
      type: "string",
      enum: [
        "artifact.created",
        "artifact.updated",
        "artifact.archived",
        "artifact.restored",
        "artifact.relation.added",
        "artifact.comment.added",
        "artifact.review_status.changed",
        "artifact.version.repaired",
        "artifact.version.deleted"
      ]
    },
    createdAt: { type: "string", format: "date-time" },
    artifactId: { type: ["string", "null"] },
    version: { type: ["number", "null"] },
    actor: { type: ["string", "null"] },
    sourceAgent: { type: ["string", "null"] },
    surface: { type: ["string", "null"] },
    tags: { type: "array", items: { type: "string" } },
    artifactType: { type: ["string", "null"] }
  },
  required: ["id", "type", "createdAt"]
};

export const eventListSchema = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: { $ref: "#/components/schemas/Event" }
    },
    seq: { type: "number", description: "Highest seq returned; pass back as ?since= to continue polling." }
  },
  required: ["events"]
};

export const webhookSchema = {
  type: "object",
  description: "A registered outbound webhook. `secret` is present only in the create response.",
  properties: {
    id: { type: "string" },
    url: { type: "string", format: "uri" },
    eventTypes: { type: "array", items: { type: "string" } },
    filter: { type: "object" },
    ownerUserId: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
    disabledAt: { type: ["string", "null"] },
    lastDeliveryAt: { type: ["string", "null"] },
    lastStatus: { type: ["number", "null"] },
    failureCount: { type: "number" },
    secret: { type: "string", description: "Shown once, only in the create response." }
  },
  required: ["id", "url", "createdAt"]
};

export const webhookListSchema = {
  type: "object",
  properties: {
    webhooks: {
      type: "array",
      items: { $ref: "#/components/schemas/Webhook" }
    }
  },
  required: ["webhooks"]
};

export const retentionPolicySchema = {
  type: "object",
  description: "Declarative retention policy stored in `meta` under key `retention_policy`. See docs/roadmap-design.md section 9.",
  properties: {
    archiveAfterDays: {
      type: "object",
      properties: {
        default: { type: ["number", "null"], description: "Days of inactivity before an artifact is archived. null disables default archiving." },
        byType: {
          type: "object",
          description: "Per-artifactType override of archiveAfterDays.default, keyed by artifact type.",
          additionalProperties: { type: "number" }
        }
      },
      required: ["default", "byType"]
    },
    purgeArchivedAfterDays: { type: ["number", "null"], description: "Days an artifact stays archived before it is eligible for hard-delete." },
    auditRetentionDays: { type: ["number", "null"], description: "Days audit_log rows are kept, excluding exempt actions." },
    eventRetentionRows: { type: ["number", "null"], description: "Maximum number of events rows to retain; older rows beyond this count are pruned." },
    keepTags: { type: "array", items: { type: "string" }, description: "Artifacts carrying any of these tags are never auto-archived or purged." }
  },
  required: ["archiveAfterDays", "purgeArchivedAfterDays", "auditRetentionDays", "eventRetentionRows", "keepTags"]
};

export const retentionReportSchema = {
  type: "object",
  description: "Result of a retention sweep (dry-run or applied).",
  properties: {
    generatedAt: { type: "string", format: "date-time" },
    dryRun: { type: "boolean" },
    policy: { $ref: "#/components/schemas/RetentionPolicy" },
    archive: {
      type: "array",
      description: "Artifacts that would be (or were) archived.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          reason: { type: "string" },
          artifactType: { type: "string" },
          ageDays: { type: "number" },
          thresholdDays: { type: "number" }
        }
      }
    },
    purge: {
      type: "array",
      description: "Archived artifacts that would be (or were) hard-deleted.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          reason: { type: "string" },
          ageDays: { type: "number" },
          thresholdDays: { type: "number" }
        }
      }
    },
    archived: { type: "array", items: { type: "string" }, description: "IDs actually archived (empty on a dry run)." },
    purged: { type: "array", items: { type: "string" }, description: "IDs actually purged (empty on a dry run, or when purge is gated off)." },
    purgeSkipped: { type: "boolean", description: "True when purge candidates existed but ARTIFACTY_RETENTION_ALLOW_PURGE was not set." },
    auditRowsToDelete: { type: "number" },
    eventRowsToDelete: { type: "number" },
    auditRowsDeleted: { type: "number" },
    eventRowsDeleted: { type: "number" }
  },
  required: ["generatedAt", "dryRun", "policy", "archive", "purge"]
};

export const savedViewSchema = {
  type: "object",
  description: "A saved dashboard filter set (docs/roadmap-design.md section 8). In single-user mode (no users) views are global; in team mode a view belongs to its owner and can be marked shared to appear for everyone.",
  properties: {
    id: { type: "string" },
    ownerUserId: { type: ["string", "null"] },
    name: { type: "string" },
    filters: {
      type: "object",
      description: "Allowlisted list filters, e.g. { query, tag, sourceAgent, artifactType, publisher, createdAfter, createdBefore, reviewStatus, relatedTo, relation, includeArchived, mode }."
    },
    shared: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" }
  },
  required: ["id", "name", "filters", "shared", "createdAt", "updatedAt"]
};

export const savedViewListSchema = {
  type: "object",
  properties: {
    views: {
      type: "array",
      items: { $ref: "#/components/schemas/SavedView" }
    }
  },
  required: ["views"]
};

export const schemas = {
  ArtifactVersion: artifactVersionSchema,
  ArtifactSummary: artifactSummarySchema,
  ArtifactWithContent: artifactWithContentSchema,
  AuditEvent: auditEventSchema,
  AuditEventList: auditEventListSchema,
  Pagination: paginationSchema,
  ArtifactListPage: artifactListPageSchema,
  RelationEntry: relationEntrySchema,
  CommentEntry: commentEntrySchema,
  CommentList: commentListSchema,
  StructuredDiff: structuredDiffSchema,
  DiffResult: diffResultSchema,
  Event: eventSchema,
  EventList: eventListSchema,
  Webhook: webhookSchema,
  WebhookList: webhookListSchema,
  RetentionPolicy: retentionPolicySchema,
  RetentionReport: retentionReportSchema,
  SavedView: savedViewSchema,
  SavedViewList: savedViewListSchema,
  Error: errorSchema
};

// Inline (non-$ref) copies for embedding directly into MCP tool
// `outputSchema` documents, which are plain JSON Schema without an
// OpenAPI-style `#/components/schemas` registry to resolve against.
export function inlineSchema(name) {
  return resolveRefs(schemas[name]);
}

function resolveRefs(node, seen = new Set()) {
  if (Array.isArray(node)) {
    return node.map((item) => resolveRefs(item, seen));
  }
  if (node && typeof node === "object") {
    if (typeof node.$ref === "string") {
      const match = /^#\/components\/schemas\/(.+)$/.exec(node.$ref);
      if (match && schemas[match[1]] && !seen.has(match[1])) {
        const nextSeen = new Set(seen).add(match[1]);
        return resolveRefs(schemas[match[1]], nextSeen);
      }
      return { type: "object" };
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = resolveRefs(value, seen);
    }
    return out;
  }
  return node;
}
