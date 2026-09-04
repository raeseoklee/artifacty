# Artifacty Enhancement Roadmap Design

This document specifies the design for the next set of Artifacty capabilities.
Each feature is written so it can be implemented and tested independently, but
the features are grouped by theme and ordered by recommended priority. Every
feature follows the existing architecture rules: shared behavior lives in
`src/lib/*`, the HTTP, CLI, and MCP surfaces stay thin adapters, versions stay
append-only, artifact content stays untrusted, and no new runtime dependency is
added unless the section says so explicitly.

Implementation status: all sections below are implemented as of 2026-09-04; `STORE_VERSION` is now `8`. The original planning text follows.

Store schema changes bump `STORE_VERSION` (originally `4`) and use the existing
`ensureColumn` / `CREATE TABLE IF NOT EXISTS` migration path so older stores
upgrade on first access.

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

Every new mutation writes an audit row through `insertAuditRecord`. New action
names introduced in this document:

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

MCP tools map the same `code` into `isError: true` results with the code in
`structuredContent.code`.

### 1.4 Feature flags

New behavior that changes defaults for existing installs is gated by an
environment variable listed in each section, and every flag is reported by
`artifacty doctor` and `artifacty_info`.

### 1.5 Testing

Each feature adds tests to the matching suite (`storage.test.js`,
`server.test.js`, `mcp-server.test.js`, `cli.test.js`, `converters.test.js`) and,
where behavior is externally visible, a smoke assertion in `npm run smoke`.

---

## 2. Artifact Relations

### Problem

Artifacts are linked only through shared tags. A handoff, its review, and the
resulting release notes cannot be discovered from one another without knowing
the tag scheme used by the publishing agent.

### Goals

- Typed, directional links between artifacts.
- Discoverable from list, get, MCP resources, and the browser viewer.
- Links survive archive and restore; a dangling link is reported, not deleted.

### Data model

New table:

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

Relation vocabulary (validated, closed set for v1):

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
(`[{ toId, relation }]`) so an agent can link in one call. `getArtifact`
returns `relations: { outgoing: [...], incoming: [...] }` with each entry
carrying `toArtifactSummary` of the other side plus `missing: true` when the
target row no longer exists.

### Surfaces

| Surface | Change |
| --- | --- |
| HTTP | `GET /api/artifacts/:id/relations`, `POST /api/artifacts/:id/relations` (body `{ toId, relation }`), `DELETE /api/artifacts/:id/relations/:relationId`. `GET /api/artifacts` accepts `relatedTo=<id>` and `relation=<name>`. |
| MCP | `artifacty_link`, `artifacty_unlink` tools; `artifacty_get` output includes `relations`; `artifacty_list` accepts `relatedTo`. New resource `artifacty://artifacts/{id}/graph` returning a depth-2 adjacency list. |
| CLI | `artifacty link <from> <relation> <to>`, `artifacty unlink ...`, `artifacty show --relations`. |
| Browser | Viewer sidebar "Related" panel; edit form gets a relation picker with search. |

### Handoff prompt integration

The `artifacty_handoff` and `artifacty_review` prompt templates instruct the
agent to pass `relations: [{ toId: <source>, relation: "derived-from" }]` so the
graph is populated without user intervention.

### Tests

Round trip, uniqueness constraint, cascade on artifact delete, dangling
reporting after admin version delete does not touch relations, `relatedTo`
filter with pagination, MCP tool schema exposure.

---

## 3. Change Notifications

### Problem

Agents that wait for another agent's output must poll `artifacty_list`.
There is no push channel.

### Goals

- In-process event bus that every mutation publishes to.
- Browser and CLI consumers via Server-Sent Events.
- External consumers via signed webhooks.
- MCP consumers via `notifications/resources/updated` when the transport
  supports it (`/mcp` HTTP transport and the stdio bridge).

### Non-goals

- Durable delivery guarantees beyond bounded retry.
- Cross-process fan-out between two server processes sharing one store.

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

Events are derived from audit rows. `insertAuditRecord` becomes the single
publish point: after the transaction commits, the storage layer calls
`events.publish(eventFromAudit(row))`. Events are never published for
uncommitted transactions.

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

Retention: keep the newest `ARTIFACTY_EVENT_HISTORY` rows (default 10000);
prune on insert.

### SSE endpoint

`GET /api/events` with `Accept: text/event-stream`.

Query filters: `type`, `tag`, `artifactId`, `sourceAgent`. Auth uses the same
token rules as other API routes. Heartbeat comment every 25 seconds. On
connect with `Last-Event-ID`, replay from that sequence. Max concurrent
connections per server: `ARTIFACTY_SSE_MAX_CLIENTS` (default 64); excess
connections get `503`.

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
- Retry: 3 attempts with 2s, 10s, 60s backoff. After 20 consecutive failures the
  webhook is disabled and a `webhook-deliver-failed` audit row is written.
- SSRF guard: the target URL must be `http` or `https`; loopback, link-local,
  and private ranges are rejected unless `ARTIFACTY_WEBHOOK_ALLOW_PRIVATE=true`.
  Redirects are not followed.
- Admin only for creation in team mode; the token owner in single-user mode.

Routes: `GET/POST /api/webhooks`, `DELETE /api/webhooks/:id`,
`POST /api/webhooks/:id/test`. Browser page `/admin/webhooks`.

### MCP

- `initialize` advertises `resources: { subscribe: true, listChanged: true }`.
- `resources/subscribe` on `artifacty://artifacts/{id}` or `artifacty://recent`
  registers the session; matching events send
  `notifications/resources/updated` with the URI.
- The stdio bridge forwards notifications received from the remote `/mcp`
  stream to the local client.
- New tool `artifacty_wait` with `{ artifactId?, tag?, type?, timeoutMs }`
  blocks up to `timeoutMs` (max 120000) and returns the first matching event or
  `{ timedOut: true }`. This gives clients without subscription support a
  long-poll primitive.

### CLI

See section 18 for `artifacty watch`.

### Tests

Event ordering matches audit sequence, replay by `Last-Event-ID`, filter
matching, webhook signature verification, SSRF rejection, retry then disable,
MCP subscribe round trip through the HTTP transport, `artifacty_wait` timeout.

---

## 4. Optimistic Concurrency

### Problem

Two agents that both read version 3 and both call `artifacty_update` produce
versions 4 and 5. The second write silently discards the first agent's work
from the "latest" view.

### Design

- Every artifact response exposes `latestVersion` (already present) and an
  `etag` string equal to `"<id>:<latestVersion>"`.
- `updateArtifact` accepts `expectedVersion` (number). Inside the existing
  transaction, if `artifact.latestVersion !== expectedVersion`, throw
  `VersionConflictError` carrying `latestVersion`, and write an
  `update-conflict` audit row.
- HTTP: `POST /api/artifacts/:id/versions` (and the browser edit form) accept
  `If-Match: "<etag>"` or body `expectedVersion`. Conflict returns `409` with
  `code: "version_conflict"` and the current summary so the client can rebase.
  `GET /api/artifacts/:id` returns `ETag` and honors `If-None-Match` with
  `304`.
- MCP: `artifacty_update` gains optional `expectedVersion`. The
  `artifacty_get` output already carries `latestVersion`; the tool description
  tells agents to pass it back.
- CLI: `artifacty update --expected-version N`.
- Browser editor: hidden field with the version being edited; on `409` the
  editor shows a banner with a link to the diff between the edited base and the
  new latest version, and keeps the unsaved text.

`expectedVersion` is optional so existing clients keep working. A future
`ARTIFACTY_REQUIRE_EXPECTED_VERSION=true` flag can make it mandatory for API
and MCP writes.

### Tests

Conflict raised inside the transaction (no version file written), success path
with matching version, `If-Match` header parsing including weak validators,
`304` on `If-None-Match`, browser banner rendering, MCP conflict result shape.

---

## 5. Comments and Review Threads

### Problem

Feedback on an artifact today requires publishing a whole new version or a
separate review artifact. Lightweight, version-anchored notes are missing.

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
- `body` is Markdown, rendered through the same sanitized Markdown pipeline as
  artifact content and size-capped at 16 KB.
- Comments are soft-deleted; the audit log keeps the action.
- Threads are one level deep (`parent_id` points to a root comment).

### Review state

An artifact-level `reviewStatus` column (`none`, `pending`, `changes-requested`,
`approved`) is added to `artifacts`. It is set explicitly via
`POST /api/artifacts/:id/review-status` and reset to `pending` automatically
when a new version is appended after an approval, which is recorded in the
audit metadata. This is deliberately minimal: no multi-approver rules.

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

Thread depth limit, anchor pass-through, soft delete hides from list but audit
remains, review status reset on new version, MCP tool round trip, Markdown
sanitization of comment bodies.

---

## 6. Semantic Search

### Problem

FTS5 handles keyword queries. Natural-language questions such as "the analysis
of last week's failed deploy" miss when the wording differs.

### Design principles

- No mandatory dependency and no bundled model. Embeddings come from a
  pluggable provider.
- Semantic search is additive: when disabled or unavailable, behavior is
  unchanged.
- Vectors are stored in SQLite as BLOBs; similarity is computed in JavaScript.
  This is adequate for the expected store size (tens of thousands of artifacts)
  and avoids a native vector extension.

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

Indexing runs through the existing background module (`src/lib/background.js`)
after each create/update so writes never wait on a network call. Failures are
logged and retried by `artifacty index rebuild --embeddings`.

### Query

`GET /api/artifacts?q=...&mode=semantic|keyword|hybrid`.

- `keyword`: current FTS5 path.
- `semantic`: embed the query, cosine similarity over all vectors for the
  configured provider/model, top `limit` after `offset`.
- `hybrid` (default when a provider is configured): reciprocal rank fusion of
  keyword and semantic rankings, `k = 60`.

Responses add `search.mode` and per-row `search_score`. `artifacty_list` gets
the same `mode` argument. The dashboard exposes a mode toggle only when
`artifacty_info` reports a provider.

### Tests

Provider-less path unchanged, `command` provider with a fixture script,
cosine ordering, RRF merge determinism, rebuild command, secret redaction of
the API key in doctor output.

---

## 7. SARIF and CSV Sort, Filter, Download

Completes the "Future Extensions" list in `docs/sarif-csv-artifact-plan.md`.

### Design

- Rendering stays server-side and bounded; interactivity is progressive
  enhancement in `src/client/viewer.js` using data already in the table.
- SARIF viewer: level filter chips (`error`, `warning`, `note`), rule id text
  filter, sort by level, rule, or location. Filtering operates on the bounded
  set already rendered; a notice states when results were truncated.
- CSV viewer: click column header to sort; per-column contains filter; row
  count shown.
- Download: `GET /artifacts/:id/export?format=csv&filter=...&sort=...` for CSV,
  and `?format=sarif&level=error` for SARIF. The server re-parses the stored
  original, applies the filter, and streams a fresh file. `/raw` is untouched.
  Filtered exports are capped at `MAX_ARTIFACT_BYTES`.
- Real-world fixtures for CodeQL, Semgrep, and Trivy are added under
  `test/fixtures/sarif/` and used in converter and server tests.

### Tests

Fixture parsing, filter/sort parameter validation, export content type and
byte cap, viewer script has no inline event handlers (CSP compatibility).

---

## 8. Dashboard Filters and Saved Views

### Design

- List filters extend to `artifactType`, `publisher`, `createdAfter`,
  `createdBefore`, `reviewStatus`, `relatedTo`, and `mode` (search). All are
  query-string driven so URLs remain shareable and the CLI/MCP list surfaces
  reuse the same `listArtifactsPage` filters.
- Saved views:

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

In single-user mode (no users table rows) views are global; in team mode they
belong to a user and can be marked `shared` so they appear for everyone.

- Routes: `GET/POST /api/views`, `DELETE /api/views/:id`; browser sidebar
  lists views and a "Save current filters" action.
- MCP: `artifacty_list` accepts `view: "<name or id>"` which expands to the
  saved filters, so a prompt can say "list the `open-reviews` view".
- Dashboard grouping: optional `groupBy=artifactType|sourceAgent|day` renders
  section headers; purely presentational.

### Tests

Filter parsing edge cases (invalid dates), view ownership and sharing
visibility, MCP view expansion, i18n keys present for `en` and `ko`.

---

## 9. Retention Policies

### Problem

Artifacts, audit rows, and (after section 3) events grow without bound.

### Design

Policies are declarative and evaluated by a background sweep in
`src/lib/background.js` every `ARTIFACTY_RETENTION_INTERVAL` (default 1h) and
on demand via `artifacty retention run`.

Configuration lives in the `meta` table as JSON under key `retention_policy`
and is edited through `/admin/retention` or `artifacty retention set`:

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
  `owner-change` which are kept indefinitely.
- Every sweep writes a summary row (`retention-sweep`) so operators can see
  when it ran and what it touched.

`artifacty integrity` gains a check that no orphaned files remain after a
purge.

### Tests

Policy parsing and defaults, `keepTags` exemption, dry-run produces no
changes, purge removes files and dependent rows, audit exemptions, sweep
idempotency.

---

## 10. Artifact Visibility and Ownership

### Problem

In team mode every user sees and can update every artifact. There are only two
roles.

### Data model

New columns on `artifacts`:

- `visibility TEXT NOT NULL DEFAULT 'team'` with values `private`, `team`.
- `owner_user_id TEXT` backfilled from `publisher_user_id` on migration.

Optional teams are out of scope for v1; `team` means "all authenticated users
of this server". A later version can add a `groups` table without changing
the API shape.

### Rules

| Action | `private` | `team` |
| --- | --- | --- |
| Read, list, raw, diff | owner, admin | any authenticated user |
| Update, comment, link | owner, admin | any authenticated user unless `ARTIFACTY_TEAM_WRITE=owner` |
| Archive, restore, change visibility, change owner | owner, admin | owner, admin |
| Admin version repair/delete | admin | admin |

- In single-user mode (no users) everything is allowed as today.
- Anonymous access with a shared `ARTIFACTY_API_TOKEN` but no personal token
  is treated as `team` read/write and cannot see `private` artifacts.
- List queries add a `WHERE visibility = 'team' OR owner_user_id = ?` clause;
  FTS and semantic search apply the same predicate before ranking.
- `createArtifact` accepts `visibility`; MCP `artifacty_create`/`update`
  expose it with a description that defaults to `team`.
- `POST /api/artifacts/:id/visibility` and `POST /api/artifacts/:id/owner`
  (admin or owner) write `visibility-change` / `owner-change` audit rows.
- Backup export includes both columns; import of an older bundle defaults them.

### Browser

Viewer shows a visibility badge; the edit form offers the toggle to owners and
admins; the account page lists "My private artifacts".

### Tests

Predicate applied on every read path including `/raw`, relation listing hides
private targets from non-owners (returns `restricted: true` instead of the
summary), MCP resource read denial, migration backfill of `owner_user_id`.

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

- `authenticateApiToken` returns `scopes`; a new `requireScope(auth, scope)`
  helper in `src/lib/security.js` is called by each HTTP route and MCP tool
  handler. Denials return `403` with `code: "scope_denied"` and write a
  `token-scope-denied` audit row (rate-limited to one per token per minute to
  avoid log flooding).
- MCP `tools/list` filters out mutating tools when the authenticated token
  lacks `write`, so read-only agents never see tools they cannot call.
- `/account` token creation form adds scope checkboxes; `artifacty token`
  CLI (server-issued personal tokens) gains `--scope read`.
- Existing tokens keep full scopes through the column default.

### Tests

Scope enforcement per route, MCP tool list filtering, admin scope requires
admin role, default for legacy tokens.

---

## 12. Rate Limiting

### Design

A fixed-window counter in memory keyed by `(principal, bucket)` where principal
is the token id, user id, or remote address, in that order of preference.

| Bucket | Default limit | Env |
| --- | --- | --- |
| `write` (create, import, update, comment, link) | 120 / minute | `ARTIFACTY_RATE_WRITE_PER_MIN` |
| `auth` (login, token exchange) | 10 / minute per address | `ARTIFACTY_RATE_AUTH_PER_MIN` |
| `search` | 300 / minute | `ARTIFACTY_RATE_SEARCH_PER_MIN` |

- Disabled on loopback binds unless `ARTIFACTY_RATE_LIMIT=always`.
- Responses over the limit return `429` with `Retry-After` and
  `code: "rate_limited"`. MCP tools return the same as an error result.
- Body size limits already exist (`MAX_ARTIFACT_BYTES`, `MAX_BACKUP_BYTES`);
  this section adds `MAX_COMMENT_BYTES` (16 KB) and documents all limits in
  `docs/threat-model.md`.

### Tests

Window reset, principal selection order, loopback bypass, `Retry-After`
header.

---

## 13. Full Backup Bundles

### Problem

The current bundle excludes users, sessions, tokens, and audit logs, so a
server move needs manual steps.

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

Round trip of every table, v1 bundle compatibility, refusal conditions,
sessions absent, file mode.

---

## 14. Markdown Embedded Rendering

### Design

- Fenced code blocks in Markdown artifacts get syntax highlighting using the
  already-vendored CodeMirror language packages in read-only mode, applied
  client-side by `viewer.js` to `<pre><code class="language-x">` elements.
  Server output remains plain escaped HTML so no-JS and CSP-strict contexts
  still work.
- ```` ```mermaid ```` fences render through the existing sandboxed Mermaid
  iframe path, one iframe per diagram, lazily created when scrolled into view.
  A per-document cap (`ARTIFACTY_MAX_INLINE_DIAGRAMS`, default 20) prevents
  resource exhaustion.
- Task lists (`- [ ]`) render as disabled checkboxes; tables get horizontal
  scroll containers.
- No change to stored content or to `/raw`.

### Tests

Highlight class assignment, Mermaid fence extraction, cap enforcement,
sanitization unchanged for inline HTML in Markdown.

---

## 15. Jupyter Notebook Format

### Design

- New format `notebook` (`.ipynb`, `application/x-ipynb+json`), default
  artifact type `analysis-report`.
- Import detection: JSON object with `nbformat` and `cells[]`.
- Converter produces a normalized structure for rendering only; the stored
  content is the original notebook JSON.
- Viewer renders cells in order: Markdown cells through the Markdown pipeline,
  code cells as highlighted source, outputs limited to `text/plain`,
  `text/markdown`, `image/png`, `image/jpeg`, `image/svg+xml` (sanitized, in
  the scriptless SVG iframe). `text/html` outputs render inside the sandboxed
  HTML iframe like HTML artifacts. Other MIME types show a placeholder with
  the type name.
- Size guard: outputs larger than 2 MB are replaced with a "truncated" notice.
- `artifacty import --agent generic --file notebook.ipynb` and the browser
  import page detect it automatically.

### Tests

Detection, cell rendering order, output MIME allowlist, oversized output
truncation, `/raw` fidelity.

---

## 16. Structured Diff

### Design

`src/lib/diff.js` gains:

```js
createStructuredDiff(before, after, { format })
```

| Format | Strategy |
| --- | --- |
| `json`, `sarif`, `notebook` | Recursive object diff producing `added`, `removed`, `changed` entries keyed by JSON path; arrays of objects with an `id`, `ruleId`, or `path` key are matched by that key, otherwise by index. |
| `csv` | Header-aware row diff: rows matched by the first column when it is unique, otherwise by position; reports added, removed, changed cells. |
| `markdown`, `text`, `code`, `html` | Existing line diff plus word-level highlighting inside changed lines. |
| `bundle` | Per-file diff using the strategy of each file's format. |

- `/artifacts/:id/diff?from=1&to=2&view=structured|lines` picks the renderer;
  `structured` is default for JSON-like formats.
- `GET /api/artifacts/:id/diff?from&to` returns the diff as JSON.
- MCP: `artifacty_diff` tool `{ id, from, to, view }` returns both a unified
  text rendering in `content[].text` and the structure in `structuredContent`.
- Output is capped at `ARTIFACTY_MAX_DIFF_ENTRIES` (default 5000) with a
  truncation flag.

### Tests

Key-matched array diff, positional fallback, CSV header change, word-level
highlight escaping, cap flag, MCP tool shape.

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
- Per-file cap 32 MB and total bundle cap remains `MAX_ARTIFACT_BYTES`.
- Secret scanning is skipped for binary entries but file names are still
  checked.

### Tests

Type allowlist, disposition headers, size caps, download route auth.

---

## 18. CLI Watch and Diff Commands

### `artifacty watch`

```bash
artifacty watch --tag handoff --type artifact.updated --json
artifacty watch --artifact release-handoff-abc12345 --exec "./on-change.sh"
```

- Connects to `/api/events` using the URL from `server.json` or
  `ARTIFACTY_URL`, reconnects with `Last-Event-ID` on drop.
- Prints one JSON line per event with `--json`, or a human line otherwise.
- `--exec` runs the command with the event JSON on stdin and `ARTIFACTY_EVENT_*`
  environment variables; failures are printed but do not stop the watch.
- `--once` exits after the first match (a shell-friendly `artifacty_wait`).

### `artifacty diff`

```bash
artifacty diff <id> [--from N] [--to M] [--structured] [--json]
```

Defaults `--to` to latest and `--from` to `to - 1`. Uses section 16.

### `artifacty relations`, `artifacty comment`, `artifacty retention`, `artifacty views`

Thin wrappers over the storage APIs described in their sections, following the
existing `cli.js` command table pattern and JSON output conventions.

### Tests

Argument parsing, reconnect logic with a mocked SSE server, `--once` exit
code, `--exec` environment injection.

---

## 19. OpenAPI Specification

### Design

- `src/lib/openapi.js` builds an OpenAPI 3.1 document from a single route
  table that `server.js` also uses for dispatch, so the spec cannot drift
  from the implementation. The route table entry shape:

```js
{ method: "POST", path: "/api/artifacts", handler, auth: "write", summary, requestSchema, responseSchema }
```

- Served at `GET /openapi.json` (no auth) and rendered as a static reference
  page at `/docs/api` using server-side HTML (no external UI bundle).
- JSON Schemas reuse `ARTIFACT_FORMATS`, `ARTIFACT_TYPES`, and the MCP tool
  input schemas so one definition feeds both HTTP and MCP.
- A test asserts every registered route appears in the spec and every spec
  path has a handler.
- `docs/mcp-public-api.md` links to the spec; `artifacty_info` reports the
  URL.

---

## 20. MCP Protocol Refresh

### Design

- Re-verify the hand-rolled implementation against the newest MCP
  specification before implementing sections 3 and 5. The checklist:
  - Negotiate the newest protocol version while continuing to accept
    `2025-06-18` from older clients.
  - `tools/list` `outputSchema` for every tool that returns
    `structuredContent`, generated from the same schema table as section 19.
  - `resources/subscribe`, `listChanged` notifications (section 3).
  - Elicitation: if the client advertises `elicitation`, `artifacty_update`
    without `expectedVersion` on a conflict may ask the user whether to rebase;
    otherwise return the conflict error.
  - Pagination cursors on `tools/list`, `resources/list`, and
    `prompts/list` when result counts exceed 50.
  - Streamable HTTP session resumption on `/mcp` (`Mcp-Session-Id`, event
    replay) reusing the events table.
- `artifacty check` validates the negotiated version and capability set and
  fails when a client requires a capability the server does not report.
- `docs/mcp-public-api.md` gains a compatibility matrix by protocol version.

### Tests

Version negotiation with old and new clients, `outputSchema` presence,
subscribe flow, cursor pagination, session resume through the HTTP transport.

---

## 21. Delivery Plan

| Phase | Features | Store version | Rationale |
| --- | --- | --- | --- |
| 1 | 4 Optimistic concurrency, 2 Relations, 20 MCP refresh (schema table), 19 OpenAPI | 5 | Smallest changes with the largest effect on multi-agent correctness; the shared schema table unblocks later work. |
| 2 | 3 Notifications, 18 CLI watch/diff, 16 Structured diff | 6 | Push channel and diff make "continue from another agent's output" real. |
| 3 | 10 Visibility, 11 Token scopes, 12 Rate limiting, 13 Full backups | 7 | Team-mode hardening before wider LAN use. |
| 4 | 5 Comments, 8 Filters and views, 9 Retention | 8 | Day-to-day usability and long-running store health. |
| 5 | 6 Semantic search, 14 Markdown rendering, 15 Notebook, 7 SARIF/CSV, 17 Document assets | 8 (no bump; new tables are created idempotently) | Content and discovery improvements that build on everything above. |

Each phase ends with `npm run release:check`, an update to `README.md`,
`docs/mcp-public-api.md`, `docs/threat-model.md`, and `docs/artifact-schema-v1.md`
(or a `v2` schema document when the artifact envelope changes), and a
`STORE_VERSION` bump only when a table or column was added in that phase.

### Compatibility guarantees across all phases

- Existing HTTP responses keep their current top-level keys; new keys are
  additive.
- `artifacty_publish` remains an alias of `artifacty_create`.
- Stores without users keep single-user semantics for every new permission
  check.
- `/raw` always returns the stored bytes unchanged.
- No generated MCP config hard-codes `http://127.0.0.1:8787`.
