# MCP Public API

English | [한국어](ko/mcp-public-api.md)

Artifacty's MCP server is the primary interface for agent-to-agent integration.
It uses local stdio MCP by default. The browser server can also expose a
token-protected HTTP `/mcp` endpoint. Stdio bridge mode lets a client use local
stdio configuration to write to a central Artifacty server. The server targets
MCP protocol `2025-06-18`.

## Capabilities

`initialize` advertises:

- `tools`: Artifact create, import, list, get, update, archive, restore, link, unlink, diff, audit, and info.
- `resources`: static and dynamic read-only artifact resources, with `subscribe: true` and `listChanged: true`.
- `prompts`: reusable workflow prompt templates.

## Visibility and Access Control

Administrators can select a site-wide `public` or `private` access mode
at `/admin/access`. Public mode preserves the visibility rules below. Private
mode requires a personal identity: artifact reads are limited to the owner,
administrators, and explicitly shared users or team members; shared recipients
have read, comment, or edit grants. Artifacty applies the strongest permission
from the user's direct and team grants.
Comment grants permit feedback and resolution of the caller's own comments;
edit grants also permit new versions. Sharing, archive/restore, and review-status
management stay owner/admin-only. Token scopes are an additional restriction:
a read-scoped token cannot mutate even when its user has an edit grant.
In private mode, a shared server token or an anonymous stdio connection cannot
read or create artifacts. Use a personal API token for
agent access. Revoking shares or team membership affects subsequent resource
reads, searches, and live notifications. The HTTP transport also obeys the
administrator's IP/CIDR allowlist, using the TCP peer address, not forwarding
headers; local stdio has no HTTP source address.

In public mode, artifact `visibility` and `ownerUserId` control access after the
server has a user account. A personal API token identifies the user. The shared
`ARTIFACTY_API_TOKEN` has no personal identity. Artifacty treats it as an
anonymous team principal: it can read and write `team` artifacts, but cannot
read `private` artifacts.

Local stdio uses a personal identity only when `ARTIFACTY_API_TOKEN` resolves to
a personal token in the local store. Otherwise, it is anonymous after the store
has users. Before the store has users, public mode does not apply these user
access checks.

If a caller cannot read an artifact, `artifacty_get` and resource reads return
`ARTIFACT_NOT_FOUND`. List results omit the artifact. These rules prevent
disclosure of its existence. If a caller can read the artifact but lacks the
required write or management permission, the tool result contains
`structuredContent.code === "forbidden"`. See the README Security Model section
for the full rule table.

## Tools

Stable tool names:

- `artifacty_create`: create a native Artifacty artifact. Accepts an optional `relations` array (`[{ toId, relation }]`) to link the new artifact to others in the same call, and an optional `visibility` (`"private"` or `"team"`; defaults to `"team"`).
- `artifacty_publish`: backwards-compatible alias for `artifacty_create`.
- `artifacty_import`: convert external Claude, Codex, Gemini, Copilot, Cursor, Artifacty, or generic payloads.
- `artifacty_list`: list artifacts with `query`, `tag`, `sourceAgent`, `artifactType`, `publisher`, `createdAfter`, `createdBefore`, `reviewStatus`, `relatedTo`, `relation`, `mode`, `includeArchived`, `view`, `limit`, and `offset`. `relatedTo` restricts results to artifacts related (in either direction) to the given artifact ID; `relation` further restricts to that relation name. `publisher` matches `publisherId`, `publisherUserId`, or `ownerUserId`. `createdAfter`/`createdBefore` take an ISO date or date-time and return an `isError: true` result with `structuredContent.code === "invalid_filter"` if unparseable. `view` names a saved view (by id or name, see docs/roadmap-design.md section 8) whose filters are expanded first; any other argument passed alongside `view` overrides that one filter. `mode` is `"keyword"`, `"semantic"`, or `"hybrid"` (see docs/roadmap-design.md section 6): `hybrid` is the default once an embedding provider is configured (`ARTIFACTY_EMBEDDINGS_URL` or `ARTIFACTY_EMBEDDINGS_COMMAND`) and `query` is set; without a provider, `semantic`/`hybrid` silently fall back to `keyword` and the response's `search.fallback` is `true`. Responses carry `search.mode` and, for `semantic`/`hybrid` results, a per-artifact `searchScore`.
- `artifacty_get`: read one artifact by `id` and optional `version`. The response includes `relations: { outgoing, incoming }`, where each entry carries the related artifact's summary (or `missing: true` if the target no longer exists). Pass `includeComments: true` to also return `comments`, the requested version's open (unresolved, non-deleted) comments; omitted by default.
- `artifacty_update`: append an immutable version. Accepts an optional `expectedVersion` (the `latestVersion` returned by `artifacty_get`); if the artifact has since moved to a different `latestVersion`, the call returns an `isError: true` tool result with `structuredContent.code === "version_conflict"` and `structuredContent.latestVersion` instead of creating a version that would silently discard a concurrent change. Agents should pass back `latestVersion` from their last `artifacty_get` as `expectedVersion` when updating. Also accepts an optional `relations` array like `artifacty_create`.
- `artifacty_archive` / `artifacty_restore`: toggle archive state. Requires the artifact's owner or an admin once any user account exists.
- `artifacty_set_visibility`: change `id`'s `visibility` to `"private"` or `"team"`. Requires the artifact's owner or an admin once any user account exists.
- `artifacty_link`: create a typed, directional relation from one artifact (`id`) to another (`toId`) with a `relation` name: `derived-from`, `supersedes`, `reviews`, `references`, or `part-of`.
- `artifacty_unlink`: remove a previously created relation given the same `id`, `toId`, and `relation`.
- `artifacty_comment`: add a comment or a reply to an artifact (`id`), given `body` (Markdown, up to 16 KB), and optional `version` (defaults to the latest), `anchor` (a format-specific rendering hint, e.g. `{ line: 42 }`, not validated against content), and `parentId` (reply to a root comment; threads are one level deep, so the target must not itself be a reply).
- `artifacty_resolve_comment`: mark a comment (`id`, `commentId`) resolved.
- `artifacty_set_review_status`: set an artifact's (`id`) `status` to `none`, `pending`, `changes-requested`, or `approved`. Requires the artifact's owner or an admin once any user account exists. Automatically resets to `pending` (noted in that update's audit metadata) when a new version is appended after `approved`.
- `artifacty_diff`: diff two versions of an artifact given `id` and optional `from`/`to` (defaults: `to` = latest version, `from` = `to - 1`) and `view` (`structured` or `lines`; defaults to `structured` for JSON-like formats — `json`, `sarif`, `csv`, `notebook`, `bundle` — and `lines` otherwise). Returns a compact unified-diff text in `content[].text` and the structured diff (JSON path entries, CSV row/cell entries, line entries with word-level highlight ranges, or bundle per-file entries) in `structuredContent`, capped at `ARTIFACTY_MAX_DIFF_ENTRIES` (default 5000) with `structuredContent.structuredDiff.truncated` set when the cap is hit.
- `artifacty_audit`: list audit events.
- `artifacty_info`: return store, browser URL, transport, and protocol information, plus `embeddings: { provider, model } | null` reporting whether a semantic-search embedding provider is configured.
- `artifacty_wait`: `{ artifactId?, tag?, type?, timeoutMs }` blocks up to `timeoutMs` (default 30000, max 120000) for the first change event matching the filter, and returns it as `structuredContent.event`, or `{ timedOut: true }` if none arrived in time. Works over any transport, including the stateless HTTP transport where `resources/subscribe` cannot push notifications (see Resources below) — it is a long-poll primitive for clients that cannot receive pushed notifications.

Tool schemas use Artifacty schema v1 formats and artifact types. During 0.x releases, maintainers may add optional
properties. They should not rename existing properties without a documented
migration.

Storage validation errors and not-found errors carry a machine-readable `code`.
This includes relation and comment errors. `tools/call` returns an
`isError: true` tool result with `structuredContent.code`, rather than a
JSON-RPC protocol error. Example codes include `INVALID_RELATION`,
`SELF_RELATION`, `ARTIFACT_NOT_FOUND`, `RELATION_NOT_FOUND`,
`COMMENT_NOT_FOUND`, `THREAD_TOO_DEEP`, `COMMENT_TOO_LARGE`, and
`INVALID_REVIEW_STATUS`. Clients can use the code without parsing error text.

## Resources

Static resources:

- `artifacty://recent`: JSON list of recent artifacts with pagination and browser URLs.
- `artifacty://schema/v1`: Markdown reference for Artifacty schema v1.

Resource templates:

- `artifacty://artifacts/{id}`: JSON artifact metadata, selected version, content, and URLs.
- `artifacty://artifacts/{id}/raw{?version}`: raw artifact content for latest or specified version.
- `artifacty://artifacts/{id}/graph`: JSON depth-2 adjacency list of artifacts reachable from `{id}` through relations, as `{ rootId, nodes, edges }` where `nodes` are artifact summaries and each edge is `{ from, to, relation }`.

Resources are read-only and may record an audit `read` event for artifact content.

### Subscriptions

`resources/subscribe` accepts `{ uri }` for `artifacty://artifacts/{id}` (that
artifact only) or `artifacty://recent` (every artifact). While subscribed, a
matching change event sends `notifications/resources/updated` with the same
`{ uri }`. `resources/unsubscribe` accepts the same `{ uri }` shape and stops
delivery.

Subscriptions deliver notifications only over the **stdio transport**. One MCP
context lasts for the whole process and writes notifications to stdout.

The streamable-HTTP `/mcp` transport creates a stateless JSON-RPC context for
each POST request. The stdio bridge (`ARTIFACTY_MCP_MODE=bridge`) uses the same
HTTP transport. After the server sends a response, no connection remains for
push notifications. These transports accept `resources/subscribe`, as the
protocol requires, but do not deliver notifications. Clients should use
`artifacty_wait` for a bounded long-poll within one request. Alternatively,
clients can poll with `artifacty_list`.

## Prompts

Prompt names:

- `artifacty_handoff`
- `artifacty_review`
- `artifacty_test_report`
- `artifacty_visual_qa`
- `artifacty_release_notes`

Each prompt returns one user message. The message instructs an agent to create
or update an artifact with searchable `artifactType`, `sourceAgent`, and tags.
Prompts accept optional context arguments such as `artifactId`, `goal`, `scope`,
`target`, or `version`. `artifacty_handoff` and `artifacty_review` additionally
instruct the agent to pass `relations` on the create/update call so the graph
stays populated automatically: `artifacty_handoff` recommends
`relations: [{ toId: <source artifact ID>, relation: "derived-from" }]`, and
`artifacty_review` recommends `relations: [{ toId: <reviewed artifact ID>, relation: "reviews" }]`.
For a short review with a few findings, `artifacty_review` recommends
`artifacty_comment`. It recommends `artifacty_set_review_status` to record the
verdict. Longer reviews and reviews of multiple files use a separate review
artifact.

## OpenAPI

An OpenAPI 3.1 document describes every `/api/*` HTTP route and the `/mcp`
JSON-RPC endpoint. The HTTP routes include artifacts, versions, import, audit,
and admin backup:

- `GET /openapi.json`: the machine-readable document. No authentication
  required; served with `cache-control: no-store` so it always reflects the
  running server's route set.
- `GET /docs/api`: a server-rendered HTML reference built from the same
  document (no external UI bundle, no CDN dependency).
- `artifacty_info` (MCP tool) and `artifacty doctor` both report the
  document's URL as `<serverUrl>/openapi.json`.

The document uses the JSON Schemas from the MCP tool `outputSchema`
definitions (see `src/lib/schemas.js`). The HTTP API and MCP tools therefore
use the same artifact summaries, full artifact records, versions, audit events,
and relation entries. They also use the same `{ error, code?, details? }`
error shape. `test/openapi.test.js`
keeps the document's route table in sync with `src/server.js`'s dispatch.

## Compatibility Notes

### Protocol version compatibility matrix

| Client-requested `protocolVersion` | Server behavior |
| --- | --- |
| `2025-06-18` | Echoed back; this is the only protocol version the implementation has been verified against the public MCP specification. |
| Any other value (older or a newer version this server hasn't been verified against) | Server falls back to `2025-06-18` in its `initialize` response rather than rejecting the connection, so unfamiliar clients still get a usable session. |

`tools/list` reports an `outputSchema` for every tool that returns
`structuredContent`, generated from the shared schema table described above.

- Local stdio remains the default. Enable the central HTTP endpoint with
  `artifacty serve --mcp-http` and install bridge mode with
  `artifacty install <agent> --mcp-url http://host:8787/mcp --api-token <token>`.
- On central servers, use a personal token from `/account` so created artifacts
  include the token owner's email as `publisherId` and audit logs record the
  same identity as `actor`.
- Remote MCP uses bearer or header token authentication. Personal tokens support
  `read`, `write`, and `admin` scopes. OAuth is not supported.
- Binary media resources return stored base64 text through MCP; browser `/raw`
  decodes first-class `image` and `video` artifacts into bytes.
- Clients may display resources and prompts differently. Tools remain the most
  widely supported integration path across Claude, Codex, Gemini, Copilot, and
  Cursor.
