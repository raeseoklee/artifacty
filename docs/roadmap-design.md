# Artifacty Enhancement Roadmap Design

This document records the design for a set of Artifacty capabilities.
Each feature can be implemented and tested independently. Features are grouped
by theme and listed in the recommended priority order.

Apply these architecture rules to every feature:

- Put shared behavior in `src/lib/*`.
- Keep the HTTP, CLI, and MCP interfaces as thin adapters.
- Keep versions append-only.
- Treat artifact content as untrusted.
- Add no runtime dependency unless the section explicitly permits it.

Status recorded on 2026-09-04: the original sections 1–21 were implemented, and
`STORE_VERSION` was `8`. Their original planning text follows. Section 22 is a
new proposal deferred to the next version; it is not a current capability.

Store schema changes increase `STORE_VERSION` (originally `4`). They use the
existing `ensureColumn` / `CREATE TABLE IF NOT EXISTS` migration path. Older
stores upgrade on first access.

## Contents

1. [Cross-Cutting Conventions](#1-cross-cutting-conventions)
2. [Artifact Relations](#2-artifact-relations)
3. [Change Notifications](#3-change-notifications)
4. [Optimistic Concurrency](#4-optimistic-concurrency)
5. [Comments and Review Threads](#5-comments-and-review-threads)
6. [Semantic Search](#6-semantic-search)
7. [SARIF and CSV Sort, Filter, Download](#7-sarif-and-csv-sort-filter-download)
8. [Dashboard Filters and Saved Views](#8-dashboard-filters-and-saved-views)
9. [Retention Policies](#9-retention-policies)
10. [Artifact Visibility and Ownership](#10-artifact-visibility-and-ownership)
11. [API Token Scopes](#11-api-token-scopes)
12. [Rate Limiting](#12-rate-limiting)
13. [Full Backup Bundles](#13-full-backup-bundles)
14. [Markdown Embedded Rendering](#14-markdown-embedded-rendering)
15. [Jupyter Notebook Format](#15-jupyter-notebook-format)
16. [Structured Diff](#16-structured-diff)
17. [Document Assets in Bundles](#17-document-assets-in-bundles)
18. [CLI Watch and Diff Commands](#18-cli-watch-and-diff-commands)
19. [OpenAPI Specification](#19-openapi-specification)
20. [MCP Protocol Refresh](#20-mcp-protocol-refresh)
21. [Delivery Plan](#21-delivery-plan)
22. [Optional Artifact Encryption at Rest — Planned](#22-optional-artifact-encryption-at-rest--planned)

---

## 1. Cross-Cutting Conventions

### 1.1 Module placement

| Concern | Module |
| --- | --- |
| Relations, comments, retention, visibility, scopes | `src/lib/storage.js` (or split into `src/lib/storage/*.js` if the file passes ~3000 lines) |
| Event bus and SSE/webhook fan-out | `src/lib/events.js` (new) |
| Embeddings | `src/lib/embeddings.js` (new) |
| Structured diff | `src/lib/diff.js` (extend) |
| Rate limiting | `src/lib/security.js` (extend) |
| OpenAPI document | `src/lib/openapi.js` (new) |
| Notebook conversion | `src/lib/converters.js` (extend) |

### 1.2 Audit actions

Every new mutation writes an audit row through `insertAuditRecord`. This
document introduces these action names:

`relation-add`, `relation-remove`, `comment-add`, `comment-resolve`,
`comment-delete`, `webhook-create`, `webhook-delete`, `webhook-deliver-failed`,
`retention-archive`, `retention-purge`, `visibility-change`, `owner-change`,
`token-scope-denied`, `update-conflict`, `rate-limited`.

### 1.3 Error shape

HTTP JSON errors keep the existing `{ error: string }` body and add an optional
machine-readable `code`:

```json
{ "error": "Version conflict", "code": "version_conflict", "details": { "latestVersion": 4 } }
```

MCP tools return the same `code` in `structuredContent.code` and set
`isError: true`.

### 1.4 Feature flags

If new behavior changes an existing installation's defaults, control it with an
environment variable. Each section lists its variable. `artifacty doctor` and
`artifacty_info` report every flag.

### 1.5 Testing

Add tests for each feature to the matching suite: `storage.test.js`,
`server.test.js`, `mcp-server.test.js`, `cli.test.js`, or `converters.test.js`.
If the behavior is externally visible, add a smoke assertion in `npm run smoke`.

---

## 2. Artifact Relations

### Problem

Artifacts are linked only through shared tags. To find a handoff, its review,
and its release notes, users must know the publishing agent's tag scheme.

### Goals

- Provide typed, directional links between artifacts.
- Make links discoverable through list and get operations, MCP resources, and
  the browser viewer.
- Preserve links through archive and restore. Report dangling links without
  deleting them.

### Data model

Add this table:

```sql
CREATE TABLE IF NOT EXISTS artifact_relations (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (from_id, to_id, relation),
  FOREIGN KEY (from_id) REFERENCES artifacts(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON artifact_relations(from_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON artifact_relations(to_id);
```

Validate relations against this closed vocabulary for v1:

| Relation | Meaning |
| --- | --- |
| `derived-from` | `from` was produced by reading `to` |
| `supersedes` | `from` replaces `to` |
| `reviews` | `from` is a review of `to` |
| `references` | loose citation |
| `part-of` | `from` belongs to bundle/collection `to` |

Inverse names are computed, not stored (`derived-from` ↔ `derives`,
`supersedes` ↔ `superseded-by`, `reviews` ↔ `reviewed-by`, `part-of` ↔
`contains`, `references` ↔ `referenced-by`).

### Storage API

```js
addRelation(store, { fromId, toId, relation, audit, metadata })
removeRelation(store, { fromId, toId, relation, audit })
listRelations(store, id, { direction: "out" | "in" | "both", relation })
```

`createArtifact` and `updateArtifact` accept an optional `relations` array
(`[{ toId, relation }]`). This lets an agent add links in the same call.
`getArtifact` returns `relations: { outgoing: [...], incoming: [...] }`. Each
entry includes `toArtifactSummary` for the related artifact. If the target row
no longer exists, the entry includes `missing: true`.

### Surfaces

| Surface | Change |
| --- | --- |
| HTTP | `GET /api/artifacts/:id/relations`, `POST /api/artifacts/:id/relations` (body `{ toId, relation }`), `DELETE /api/artifacts/:id/relations/:relationId`. `GET /api/artifacts` accepts `relatedTo=<id>` and `relation=<name>`. |
| MCP | `artifacty_link`, `artifacty_unlink` tools; `artifacty_get` output includes `relations`; `artifacty_list` accepts `relatedTo`. New resource `artifacty://artifacts/{id}/graph` returning a depth-2 adjacency list. |
| CLI | `artifacty link <from> <relation> <to>`, `artifacty unlink ...`, `artifacty show --relations`. |
| Browser | Viewer sidebar "Related" panel; edit form gets a relation picker with search. |

### Handoff prompt integration

The `artifacty_handoff` and `artifacty_review` prompt templates instruct the
agent to pass `relations: [{ toId: <source>, relation: "derived-from" }]`. The
agent can then add the graph links without user intervention.

### Tests

Test relation round trips, the uniqueness constraint, and cascading deletion
when an artifact is deleted. Verify dangling-link reporting and confirm that
admin version deletion does not change relations. Test the `relatedTo` filter
with pagination and verify MCP tool schema exposure.

---

## 3. Change Notifications

### Problem

Agents that wait for another agent's output must poll `artifacty_list`.
There is no push channel.

### Goals

- Publish every mutation to an in-process event bus.
- Support browser and CLI consumers through Server-Sent Events.
- Support external consumers through signed webhooks.
- Notify MCP consumers through `notifications/resources/updated` when the
  transport supports it (`/mcp` HTTP transport and the stdio bridge).

### Non-goals

- This design does not guarantee durable delivery beyond bounded retries.
- This design does not provide cross-process fan-out between two server
  processes that share one store.

### Event model

```json
{
  "id": "evt_01J...",
  "type": "artifact.updated",
  "createdAt": "2026-09-04T10:00:00.000Z",
  "artifactId": "release-handoff-abc12345",
  "version": 3,
  "actor": "user@example.com",
  "sourceAgent": "claude",
  "surface": "mcp",
  "tags": ["handoff"],
  "artifactType": "handoff"
}
```

Event types: `artifact.created`, `artifact.updated`, `artifact.archived`,
`artifact.restored`, `artifact.relation.added`, `artifact.comment.added`,
`artifact.version.repaired`, `artifact.version.deleted`.

The storage layer derives events from audit rows. `insertAuditRecord` becomes
the single place that starts event publication. After the transaction commits,
the storage layer calls `events.publish(eventFromAudit(row))`. It must not
publish events for uncommitted transactions.

### Persistence

Events are stored for replay in a bounded table so a reconnecting SSE client
can resume with `Last-Event-ID`:

```sql
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  type TEXT NOT NULL,
  artifact_id TEXT,
  payload_json TEXT NOT NULL
);
```

Keep the newest `ARTIFACTY_EVENT_HISTORY` rows (default 10000). Prune older
rows when inserting a new event.

### SSE endpoint

Request `GET /api/events` with `Accept: text/event-stream`.

Query filters are `type`, `tag`, `artifactId`, and `sourceAgent`. Authentication
uses the same token rules as other API routes. The server sends a heartbeat
comment every 25 seconds. If a client connects with `Last-Event-ID`, the server
replays events from that sequence.

`ARTIFACTY_SSE_MAX_CLIENTS` limits concurrent connections per server (default
64). The server returns `503` for connections above this limit.

### Webhooks

```sql
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  event_types_json TEXT NOT NULL,
  filter_json TEXT NOT NULL DEFAULT '{}',
  owner_user_id TEXT,
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  last_delivery_at TEXT,
  last_status INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0
);
```

- Delivery: `POST` JSON body, headers `X-Artifacty-Event`,
  `X-Artifacty-Delivery`, `X-Artifacty-Signature: sha256=<hmac>` over the raw
  body using the secret shown once at creation.
- Retry: 3 attempts with delays of 2s, 10s, and 60s. After 20 consecutive
  failures, the server disables the webhook. It writes a
  `webhook-deliver-failed` audit row.
- SSRF guard: the target URL must be `http` or `https`; loopback, link-local,
  and private ranges are rejected unless `ARTIFACTY_WEBHOOK_ALLOW_PRIVATE=true`.
  Redirects are not followed.
- In team mode, only administrators can create webhooks. In single-user mode,
  the token owner can create them.

Expose `GET/POST /api/webhooks`, `DELETE /api/webhooks/:id`, and
`POST /api/webhooks/:id/test`. Use `/admin/webhooks` as the browser page.

### MCP

- `initialize` advertises `resources: { subscribe: true, listChanged: true }`.
- `resources/subscribe` on `artifacty://artifacts/{id}` or `artifacty://recent`
  registers the session; matching events send
  `notifications/resources/updated` with the URI.
- The stdio bridge forwards notifications received from the remote `/mcp`
  stream to the local client.
- New tool `artifacty_wait` accepts `{ artifactId?, tag?, type?, timeoutMs }`.
  It waits up to `timeoutMs` (max 120000). It returns the first matching event
  or `{ timedOut: true }`. Clients without subscription support can use this
  tool for long polling.

### CLI

See section 18 for `artifacty watch`.

### Tests

Verify that event ordering matches the audit sequence. Test replay through
`Last-Event-ID`, filter matching, webhook signatures, and SSRF rejection. Test
webhook retries and disabling after repeated failures. Test an MCP subscription
round trip through HTTP and an `artifacty_wait` timeout.

---

## 4. Optimistic Concurrency

### Problem

If two agents read version 3 and both call `artifacty_update`, they produce
versions 4 and 5. The latest version then omits the first agent's work without
reporting a conflict.

### Design

- Every artifact response exposes `latestVersion` (already present) and an
  `etag` string equal to `"<id>:<latestVersion>"`.
- `updateArtifact` accepts `expectedVersion` (number). In the existing
  transaction, check whether `artifact.latestVersion !== expectedVersion`.
  If the versions differ, throw `VersionConflictError` with `latestVersion`.
  Write an `update-conflict` audit row.
- HTTP: `POST /api/artifacts/:id/versions` (and the browser edit form) accept
  `If-Match: "<etag>"` or body `expectedVersion`. Conflict returns `409` with
  `code: "version_conflict"` and the current summary so the client can rebase.
  `GET /api/artifacts/:id` returns `ETag` and honors `If-None-Match` with
  `304`.
- MCP: `artifacty_update` gains optional `expectedVersion`. The
  `artifacty_get` output already carries `latestVersion`; the tool description
  tells agents to pass it back.
- CLI: `artifacty update --expected-version N`.
- Browser editor: use a hidden field for the version being edited. On `409`,
  keep the unsaved text and show a banner. The banner links to a diff between
  the edited base version and the new latest version.

`expectedVersion` is optional so existing clients keep working. A future
`ARTIFACTY_REQUIRE_EXPECTED_VERSION=true` flag can make it mandatory for API
and MCP writes.

### Tests

Verify that a conflict is raised inside the transaction without writing a
version file. Test successful updates with a matching version. Test `If-Match`
parsing, including weak validators, and a `304` response to `If-None-Match`.
Verify the browser conflict banner and the MCP conflict result shape.

---

## 5. Comments and Review Threads

### Problem

Feedback on an artifact requires a new version or a separate review artifact.
Users cannot add a short note to a specific version.

### Data model

```sql
CREATE TABLE IF NOT EXISTS artifact_comments (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_id TEXT,
  author_user_id TEXT,
  author_label TEXT NOT NULL,
  source_agent TEXT,
  body TEXT NOT NULL,
  anchor_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  deleted_at TEXT,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_artifact ON artifact_comments(artifact_id, version);
```

- `anchor_json` is optional and format-specific: `{ "line": 42 }` for text
  formats, `{ "path": "$.runs[0].results[3]" }` for JSON/SARIF, `{ "row": 7 }`
  for CSV. Anchors are hints for rendering and are not validated against
  content.
- `body` is Markdown with a 16 KB size limit. The renderer uses the same
  sanitized Markdown pipeline as artifact content.
- Soft-delete comments and retain the action in the audit log.
- Threads are one level deep (`parent_id` points to a root comment).

### Review state

Add a `reviewStatus` column to `artifacts`. Its values are `none`, `pending`,
`changes-requested`, and `approved`. Set it explicitly through
`POST /api/artifacts/:id/review-status`. If a new version is appended after an
approval, reset the status to `pending` and record the reset in audit metadata.
This design does not include rules for multiple approvers.

### Surfaces

| Surface | Change |
| --- | --- |
| HTTP | `GET/POST /api/artifacts/:id/comments`, `POST /api/artifacts/:id/comments/:cid/resolve`, `DELETE /api/artifacts/:id/comments/:cid`, `POST /api/artifacts/:id/review-status`. |
| MCP | `artifacty_comment` `{ id, version?, body, anchor?, parentId? }`, `artifacty_resolve_comment`, `artifacty_set_review_status`. `artifacty_get` gains `includeComments` (default false, returns open comments on the requested version). |
| CLI | `artifacty comment <id> --body ...`, `artifacty comments <id>`. |
| Browser | Viewer side panel listing comments by version with resolve/reply; line-anchored comments show gutter markers in the CodeMirror read-only viewer. |
| Events | `artifact.comment.added`, `artifact.review_status.changed`. |

The `artifacty_review` prompt template is updated to prefer comments over
publishing a separate review artifact when the review is short.

### Tests

Test the thread depth limit and anchor pass-through. Verify that soft-deleted
comments disappear from lists while their audit records remain. Test review
status reset on a new version, MCP tool round trips, and Markdown sanitization
of comment bodies.

---

## 6. Semantic Search

### Problem

FTS5 handles keyword queries. A natural-language question can miss relevant
results if it uses different words. For example, a user might search for
"the analysis of last week's failed deploy".

### Design principles

- Do not require an additional dependency or bundle a model. Use a
  configurable provider to supply embeddings.
- If semantic search is disabled or unavailable, keep the existing search
  behavior.
- Store vectors in SQLite as BLOBs. Compute similarity in JavaScript. This
  supports the expected store size of tens of thousands of artifacts without
  a native vector extension.

### Provider interface (`src/lib/embeddings.js`)

```js
export function createEmbeddingProvider(config) // returns null when disabled
provider.name          // "openai-compatible" | "command" | "none"
provider.dimensions    // integer
provider.embed(texts)  // Promise<Float32Array[]>
```

Providers in v1:

| Provider | Config |
| --- | --- |
| `openai-compatible` | `ARTIFACTY_EMBEDDINGS_URL`, `ARTIFACTY_EMBEDDINGS_MODEL`, `ARTIFACTY_EMBEDDINGS_API_KEY` (calls `POST {url}/embeddings`) |
| `command` | `ARTIFACTY_EMBEDDINGS_COMMAND` (a local executable that reads JSON lines on stdin and writes vectors on stdout, so users can wire Ollama or any local model without Artifacty depending on it) |

The API key is read from the environment only and never written to the store
or logs.

### Storage

```sql
CREATE TABLE IF NOT EXISTS artifact_embeddings (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, provider, model),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
```

The embedded text is `title + tags + metadata summary + first
ARTIFACTY_EMBEDDINGS_MAX_CHARS (default 8000) characters of the latest version`.
Binary formats (`image`, `video`) embed metadata only.

Run indexing through the existing background module (`src/lib/background.js`)
after each create or update. Writes must not wait for a network call. Log
failures. Use `artifacty index rebuild --embeddings` to retry indexing.

### Query

`GET /api/artifacts?q=...&mode=semantic|keyword|hybrid`.

- `keyword`: use the current FTS5 search path.
- `semantic`: embed the query. Calculate cosine similarity across all vectors
  for the configured provider and model. Return the top `limit` results after
  `offset`.
- `hybrid` (default when a provider is configured): combine keyword and
  semantic rankings through reciprocal rank fusion with `k = 60`.

Responses add `search.mode` and per-row `search_score`. `artifacty_list` gets
the same `mode` argument. The dashboard exposes a mode toggle only when
`artifacty_info` reports a provider.

### Tests

Verify that search without a provider remains unchanged. Test the `command`
provider with a fixture script, cosine ordering, deterministic RRF merging,
and the rebuild command. Confirm that doctor output redacts the API key.

---

## 7. SARIF and CSV Sort, Filter, Download

This section completes the "Future Extensions" list in
`docs/sarif-csv-artifact-plan.md`.

### Design

- The server renders a limited set of results. `src/client/viewer.js` adds
  browser controls that use the data already in the table.
- SARIF viewer: add level filter chips (`error`, `warning`, `note`) and a rule
  id text filter. Allow sorting by level, rule, or location. Filter only the
  rendered results. Show a notice if the result set was truncated.
- In the CSV viewer, let users click a column header to sort. Provide a
  per-column contains filter and show the row count.
- Download: `GET /artifacts/:id/export?format=csv&filter=...&sort=...` for CSV,
  and `?format=sarif&level=error` for SARIF. The server re-parses the stored
  original, applies the filter, and streams a fresh file. `/raw` is untouched.
  Filtered exports are capped at `MAX_ARTIFACT_BYTES`.
- Real-world fixtures for CodeQL, Semgrep, and Trivy are added under
  `test/fixtures/sarif/` and used in converter and server tests.

### Tests

Test fixture parsing, filter/sort parameter validation, export content types,
and the export byte cap. Confirm that the viewer script has no inline event
handlers, as required for CSP compatibility.

---

## 8. Dashboard Filters and Saved Views

### Design

- Add list filters for `artifactType`, `publisher`, `createdAfter`,
  `createdBefore`, `reviewStatus`, `relatedTo`, and `mode` (search). Put the
  filters in query strings so users can share URLs. The CLI and MCP list
  interfaces reuse the same `listArtifactsPage` filters.
- Store saved views in this table:

```sql
CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  name TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

In single-user mode (no users table rows), views are global. In team mode,
each view belongs to a user. Mark a view as `shared` to make it appear for
everyone.

- Expose `GET/POST /api/views` and `DELETE /api/views/:id`. The browser sidebar
  lists views and provides a "Save current filters" action.
- MCP: `artifacty_list` accepts `view: "<name or id>"` which expands to the
  saved filters, so a prompt can say "list the `open-reviews` view".
- The optional `groupBy=artifactType|sourceAgent|day` parameter renders
  dashboard section headers. It changes presentation only.

### Tests

Test filter parsing edge cases, including invalid dates. Verify view ownership,
sharing visibility, and MCP view expansion. Confirm that the i18n keys exist
for `en` and `ko`.

---

## 9. Retention Policies

### Problem

Artifacts and audit rows grow without bound. After section 3, events do too.

### Design

Define retention rules in a policy. A background sweep in
`src/lib/background.js` evaluates the policy every `ARTIFACTY_RETENTION_INTERVAL`
(default 1h). Run `artifacty retention run` to evaluate it on demand.

Store the configuration as JSON in the `meta` table under `retention_policy`.
Edit it through `/admin/retention` or `artifacty retention set`:

```json
{
  "archiveAfterDays": { "default": null, "byType": { "test-report": 30 } },
  "purgeArchivedAfterDays": 180,
  "auditRetentionDays": 365,
  "eventRetentionRows": 10000,
  "keepTags": ["pinned", "release"]
}
```

Semantics:

- `archiveAfterDays`: artifacts not updated within the window are archived
  (`retention-archive` audit action, actor `system:retention`). Artifacts with
  a tag in `keepTags` or with `reviewStatus = approved` are skipped.
- `purgeArchivedAfterDays`: archived artifacts older than the window are
  hard-deleted, including version files, relations, comments, and embeddings.
  This is the only path that deletes whole artifacts, and it always runs with
  a dry-run report first (`artifacty retention run --dry-run`) that admins can
  inspect on `/admin/retention`. Purge is disabled unless
  `ARTIFACTY_RETENTION_ALLOW_PURGE=true`.
- `auditRetentionDays`: audit rows older than the window are deleted, except
  `version-repair`, `version-delete`, `retention-purge`, and
  `owner-change`, which are kept indefinitely.
- Every sweep writes a summary row (`retention-sweep`). The row shows when
  the sweep ran and what it changed.

`artifacty integrity` gains a check that no orphaned files remain after a
purge.

### Tests

Test policy parsing, defaults, and the `keepTags` exemption. Confirm that a
dry run makes no changes and that a purge removes files and dependent rows.
Verify audit exemptions and sweep idempotency.

---

## 10. Artifact Visibility and Ownership

### Problem

In team mode, every user can see and update every artifact. The system has
only two roles.

### Data model

Add these columns to `artifacts`:

- `visibility TEXT NOT NULL DEFAULT 'team'` with values `private`, `team`.
- `owner_user_id TEXT` backfilled from `publisher_user_id` on migration.

Optional teams are outside the v1 scope. In this design, `team` means "all
authenticated users of this server". A later version can add a `groups` table
without changing the API shape.

### Rules

| Action | `private` | `team` |
| --- | --- | --- |
| Read, list, raw, diff | owner, admin | any authenticated user |
| Update, comment, link | owner, admin | any authenticated user unless `ARTIFACTY_TEAM_WRITE=owner` |
| Archive, restore, change visibility, change owner | owner, admin | owner, admin |
| Admin version repair/delete | admin | admin |

- In single-user mode (no users), keep the existing behavior that allows
  every operation.
- Anonymous access with a shared `ARTIFACTY_API_TOKEN` but no personal token
  is treated as `team` read/write and cannot see `private` artifacts.
- List queries add a `WHERE visibility = 'team' OR owner_user_id = ?` clause;
  FTS and semantic search apply the same predicate before ranking.
- `createArtifact` accepts `visibility`; MCP `artifacty_create`/`update`
  expose it with a description that defaults to `team`.
- `POST /api/artifacts/:id/visibility` and `POST /api/artifacts/:id/owner`
  (admin or owner) write `visibility-change` / `owner-change` audit rows.
- Include both columns in backup exports. When importing an older bundle,
  supply their default values.

### Browser

The viewer shows a visibility badge. The edit form gives owners and
administrators a visibility toggle. The account page lists "My private
artifacts".

### Tests

Verify the visibility predicate on every read path, including `/raw`. Confirm
that relation lists hide private targets from non-owners by returning
`restricted: true` instead of a summary. Test MCP resource read denial and
migration backfill of `owner_user_id`.

---

## 11. API Token Scopes

### Design

`api_tokens` gains `scopes_json TEXT NOT NULL DEFAULT '["read","write"]'`.

Scopes:

| Scope | Grants |
| --- | --- |
| `read` | list, get, raw, diff, relations, comments (read), events (SSE) |
| `write` | create, import, update, link, comment, archive/restore of own artifacts |
| `admin` | everything the user role allows; only available to admin users |

- `authenticateApiToken` returns `scopes`. Each HTTP route and MCP tool handler
  calls a new `requireScope(auth, scope)` helper in `src/lib/security.js`.
  A denial returns `403` with `code: "scope_denied"` and writes a
  `token-scope-denied` audit row. Limit these audit rows to one per token per
  minute to prevent excessive logging.
- MCP `tools/list` filters out mutating tools when the authenticated token
  lacks `write`, so read-only agents never see tools they cannot call.
- `/account` token creation form adds scope checkboxes; `artifacty token`
  CLI (server-issued personal tokens) gains `--scope read`.
- Existing tokens keep full scopes through the column default.

### Tests

Test scope enforcement on each route and MCP tool list filtering. Verify that
admin scope requires an admin role and that legacy tokens receive the default.

---

## 12. Rate Limiting

### Design

Use a fixed-window counter in memory, keyed by `(principal, bucket)`. Select
the principal in this order: token id, user id, then remote address.

| Bucket | Default limit | Env |
| --- | --- | --- |
| `write` (create, import, update, comment, link) | 120 / minute | `ARTIFACTY_RATE_WRITE_PER_MIN` |
| `auth` (login, token exchange) | 10 / minute per address | `ARTIFACTY_RATE_AUTH_PER_MIN` |
| `search` | 300 / minute | `ARTIFACTY_RATE_SEARCH_PER_MIN` |

- Disable rate limiting on loopback binds unless
  `ARTIFACTY_RATE_LIMIT=always`.
- Responses over the limit return `429` with `Retry-After` and
  `code: "rate_limited"`. MCP tools return the same as an error result.
- Body size limits already exist (`MAX_ARTIFACT_BYTES`, `MAX_BACKUP_BYTES`);
  this section adds `MAX_COMMENT_BYTES` (16 KB) and documents all limits in
  `docs/threat-model.md`.

### Tests

Test window reset, principal selection order, and loopback bypass. Verify the
`Retry-After` header.

---

## 13. Full Backup Bundles

### Problem

The current bundle excludes users, sessions, tokens, and audit logs. Moving
the store to another server therefore requires manual steps.

### Design

- `buildStoreBackup(store, { scope: "artifacts" | "full" })`. `full` adds
  `users` (with password hashes), `api_tokens` (hashes and scopes),
  `audit_log`, `artifact_relations`, `artifact_comments`, `saved_views`,
  `webhooks` (without secrets; they must be re-issued), and `meta` policy
  keys. Sessions are never exported.
- Bundle header gains `bundleVersion: 2`, `scope`, and `storeVersion`.
  Version 1 bundles import as before.
- Import of a `full` bundle is admin-only, requires
  `confirm: "replace-all"` in the request body, and refuses when the target
  store already has users unless `--force-users` is passed. It runs in one
  transaction and writes a `backup-import` audit row summarizing counts.
- CLI: `artifacty backup --full`, `artifacty import-store --file x.json`
  auto-detects scope; `artifacty export` keeps the artifacts-only default.
- Bundles containing password or token hashes are written with mode `0600`.

### Tests

Test a round trip for every table, compatibility with v1 bundles, and the
conditions that refuse an import. Confirm that sessions are absent and that
backup files have the required mode.

---

## 14. Markdown Embedded Rendering

### Design

- Use the bundled CodeMirror language packages in read-only mode to highlight
  fenced code blocks in Markdown artifacts. In the browser, `viewer.js` applies
  highlighting to `<pre><code class="language-x">` elements. The server returns
  plain escaped HTML. Rendering must still work without JavaScript and with
  strict CSP settings.
- ```` ```mermaid ```` fences render through the existing sandboxed Mermaid
  iframe path, one iframe per diagram, lazily created when scrolled into view.
  A per-document cap (`ARTIFACTY_MAX_INLINE_DIAGRAMS`, default 20) prevents
  resource exhaustion.
- Render task lists (`- [ ]`) as disabled checkboxes. Put tables in
  containers that allow horizontal scrolling.
- Leave stored content and `/raw` unchanged.

### Tests

Test highlight class assignment, Mermaid fence extraction, and cap enforcement.
Confirm that sanitization of inline HTML in Markdown remains unchanged.

---

## 15. Jupyter Notebook Format

### Design

- Add the `notebook` format (`.ipynb`, `application/x-ipynb+json`) with
  `analysis-report` as the default artifact type.
- Detect an import as a notebook when its JSON object has `nbformat` and
  `cells[]`.
- The converter produces a normalized structure only for rendering. Store
  the original notebook JSON.
- The viewer renders cells in order. Render Markdown cells through the
  Markdown pipeline and code cells as highlighted source. Allow these output
  types: `text/plain`, `text/markdown`, `image/png`, `image/jpeg`, and
  `image/svg+xml`. Sanitize SVG output and render it in the scriptless SVG
  iframe. Render `text/html` output in the sandboxed HTML iframe, as for HTML
  artifacts. For other MIME types, show a placeholder with the type name.
- Size guard: outputs larger than 2 MB are replaced with a "truncated" notice.
- `artifacty import --agent generic --file notebook.ipynb` and the browser
  import page detect it automatically.

### Tests

Test detection, cell rendering order, and the output MIME allowlist. Verify
truncation of oversized outputs and `/raw` fidelity.

---

## 16. Structured Diff

### Design

`src/lib/diff.js` gains:

```js
createStructuredDiff(before, after, { format })
```

| Format | Strategy |
| --- | --- |
| `json`, `sarif`, `notebook` | Compare objects recursively. Produce `added`, `removed`, and `changed` entries keyed by JSON path. Match array objects by `id`, `ruleId`, or `path` when available. Otherwise, match by index. |
| `csv` | Compare rows using their headers. If the first column is unique, match rows by that column. Otherwise, match by position. Report added, removed, and changed cells. |
| `markdown`, `text`, `code`, `html` | Existing line diff plus word-level highlighting inside changed lines. |
| `bundle` | Per-file diff using the strategy of each file's format. |

- `/artifacts/:id/diff?from=1&to=2&view=structured|lines` picks the renderer;
  `structured` is the default for JSON-like formats.
- `GET /api/artifacts/:id/diff?from&to` returns the diff as JSON.
- MCP: `artifacty_diff` tool `{ id, from, to, view }` returns both a unified
  text rendering in `content[].text` and the structure in `structuredContent`.
- Output is capped at `ARTIFACTY_MAX_DIFF_ENTRIES` (default 5000) with a
  truncation flag.

### Tests

Test array diffs matched by key and their positional fallback. Test CSV header
changes, escaping in word-level highlights, the cap flag, and the MCP tool shape.

---

## 17. Document Assets in Bundles

### Design

- Bundle file entries gain optional `contentType`. Allowed binary types are
  extended with `application/pdf`,
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, and
  `application/zip`.
- Viewer: PDFs render in a sandboxed iframe via `/raw?file=<name>` with
  `Content-Disposition: inline`; other document types show metadata and a
  download link with `Content-Disposition: attachment` and `X-Content-Type-
  Options: nosniff`.
- Cap each file at 32 MB. Keep the total bundle cap at `MAX_ARTIFACT_BYTES`.
- Skip secret scanning for binary entries, but continue checking file names.

### Tests

Test the type allowlist, disposition headers, size caps, and authentication
on the download route.

---

## 18. CLI Watch and Diff Commands

### `artifacty watch`

```bash
artifacty watch --tag handoff --type artifact.updated --json
artifacty watch --artifact release-handoff-abc12345 --exec "./on-change.sh"
```

- Connect to `/api/events` using the URL from `server.json` or
  `ARTIFACTY_URL`. If the connection drops, reconnect with `Last-Event-ID`.
- With `--json`, print one JSON line per event. Otherwise, print a
  human-readable line.
- `--exec` runs the command with event JSON on stdin and `ARTIFACTY_EVENT_*`
  environment variables. It prints failures and continues watching.
- `--once` exits after the first match (a shell-friendly `artifacty_wait`).

### `artifacty diff`

```bash
artifacty diff <id> [--from N] [--to M] [--structured] [--json]
```

Default `--to` to the latest version and `--from` to `to - 1`. Use the diff
behavior from section 16.

### `artifacty relations`, `artifacty comment`, `artifacty retention`, `artifacty views`

Implement these commands as thin wrappers over the storage APIs described in
their sections. Follow the existing `cli.js` command table pattern and JSON
output conventions.

### Tests

Test argument parsing and reconnect logic with a mocked SSE server. Verify
the `--once` exit code and `--exec` environment injection.

---

## 19. OpenAPI Specification

### Design

- `src/lib/openapi.js` builds an OpenAPI 3.1 document from a single route
  table. `server.js` uses the same table to dispatch requests. This keeps the
  specification consistent with the implementation. Each route entry has this
  shape:

```js
{ method: "POST", path: "/api/artifacts", handler, auth: "write", summary, requestSchema, responseSchema }
```

- Serve the document at `GET /openapi.json` without authentication. Render
  a static reference page at `/docs/api` with server-side HTML and no
  external UI bundle.
- JSON Schemas reuse `ARTIFACT_FORMATS`, `ARTIFACT_TYPES`, and the MCP tool
  input schemas so one definition feeds both HTTP and MCP.
- A test asserts every registered route appears in the spec and every spec
  path has a handler.
- `docs/mcp-public-api.md` links to the spec; `artifacty_info` reports the
  URL.

---

## 20. MCP Protocol Refresh

### Design

- Before implementing sections 3 and 5, check the custom implementation
  against the newest MCP specification. Use this checklist:
  - Negotiate the newest protocol version while continuing to accept
    `2025-06-18` from older clients.
  - Generate `tools/list` `outputSchema` for every tool that returns
    `structuredContent`. Use the same schema table as section 19.
  - Support `resources/subscribe` and `listChanged` notifications (section 3).
  - Elicitation: if a conflict occurs and the client advertises `elicitation`,
    `artifacty_update` without `expectedVersion` may ask the user whether to
    rebase. Otherwise, return the conflict error.
  - Provide pagination cursors on `tools/list`, `resources/list`, and
    `prompts/list` when result counts exceed 50.
  - Support Streamable HTTP session resumption on `/mcp` with
    `Mcp-Session-Id` and event replay. Reuse the events table.
- `artifacty check` validates the negotiated version and capability set and
  fails when a client requires a capability the server does not report.
- `docs/mcp-public-api.md` gains a compatibility matrix by protocol version.

### Tests

Test version negotiation with old and new clients. Verify `outputSchema`
presence, subscription flow, cursor pagination, and session resumption through
the HTTP transport.

---

## 21. Delivery Plan

| Phase | Features | Store version | Rationale |
| --- | --- | --- | --- |
| 1 | 4 Optimistic concurrency, 2 Relations, 20 MCP refresh (schema table), 19 OpenAPI | 5 | Smallest changes with the largest effect on multi-agent correctness; the shared schema table unblocks later work. |
| 2 | 3 Notifications, 18 CLI watch/diff, 16 Structured diff | 6 | Push channel and diff make "continue from another agent's output" real. |
| 3 | 10 Visibility, 11 Token scopes, 12 Rate limiting, 13 Full backups | 7 | Team-mode hardening before wider LAN use. |
| 4 | 5 Comments, 8 Filters and views, 9 Retention | 8 | Day-to-day usability and long-running store health. |
| 5 | 6 Semantic search, 14 Markdown rendering, 15 Notebook, 7 SARIF/CSV, 17 Document assets | 8 (no bump; new tables are created idempotently) | Content and discovery improvements that build on everything above. |

At the end of each phase, run `npm run release:check`. Update `README.md`,
`docs/mcp-public-api.md`, `docs/threat-model.md`, and `docs/artifact-schema-v1.md`.
If the artifact envelope changes, use a `v2` schema document. Increase
`STORE_VERSION` only if the phase added a table or column.

### Compatibility guarantees across all phases

- Existing HTTP responses keep their current top-level keys; new keys are
  additive.
- `artifacty_publish` remains an alias of `artifacty_create`.
- Stores without users keep single-user semantics for every new permission
  check.
- `/raw` always returns the stored bytes unchanged.
- No generated MCP config hard-codes `http://127.0.0.1:8787`.


---

## 22. Optional Artifact Encryption at Rest — Planned

**Status (2026-10-14): deferred to the next version. Design and implementation
are pending.** This is a substantial storage change, not a current feature.
Existing SMTP configuration encryption does not encrypt artifact data.

An administrator should be able to opt in or turn encryption off. Each change
must migrate the existing store between encrypted and plaintext states. A
setting that affects only future writes is insufficient. The design must cover
artifact/version blobs and bundle assets, metadata, and search indexes, including
any retained plaintext copies or derived data. Cipher and storage choices remain
open until the full design is reviewed.

Before migration, create and verify a recovery backup and check available disk
space. Hold an exclusive write lock across HTTP, CLI, MCP, and background writers.
Verify file references, hashes, and database/index integrity before committing
the new state. Define how failures and interrupted migrations recover without
leaving a mixed or silently unreadable store.

Keep encryption keys and recovery material separately secured. The design must
specify key backup, restore to a new home, key-loss behavior, and whether disabling
encryption leaves any recoverable plaintext or ciphertext copies. Review backup,
retention, and recovery behavior before implementing the administrator control.
