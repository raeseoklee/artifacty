# MCP Public API

Artifacty's MCP server is the primary agent-to-agent integration surface. It
supports local stdio MCP by default, a token-protected HTTP `/mcp` endpoint when
enabled on the browser server, and stdio bridge mode for clients that need local
stdio config but should write to a central Artifacty server. The server
currently targets MCP protocol `2025-06-18`.

## Capabilities

`initialize` advertises:

- `tools`: Artifact create, import, list, get, update, archive, restore, link, unlink, diff, audit, and info.
- `resources`: static and dynamic read-only artifact resources, with `subscribe: true` and `listChanged: true`.
- `prompts`: reusable workflow prompt templates.

## Visibility and Access Control

Once any user account exists on the server, every tool call and resource read
is scoped by artifact `visibility` and `ownerUserId`: over the streamable-HTTP
transport, a personal API token or session scopes access to that user; the
shared `ARTIFACTY_API_TOKEN` (or any connection before the first user is
created) has no personal identity and is treated as an anonymous team
principal that can read/write `team` artifacts but never sees `private` ones.
The local stdio transport is a fully trusted process: it is scoped to a
personal user only when the local `ARTIFACTY_API_TOKEN` resolves to a
personal API token, and is otherwise anonymous once the store has users. A
`private` artifact a caller cannot see 404s (`ARTIFACT_NOT_FOUND`) from
`artifacty_get`, resource reads, and list results, to avoid leaking its
existence; write and manage operations (`artifacty_update`,
`artifacty_archive`/`artifacty_restore`, `artifacty_set_visibility`) on an
artifact the caller can see but does not own return
`structuredContent.code === "forbidden"`. In single-user mode (no user
accounts) none of this applies. See the README Security Model section for
the full rule table.

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

Tool schemas use Artifacty schema v1 formats and artifact types. New optional
properties may be added during 0.x releases; existing names should not be
renamed without a documented migration.

Storage-layer validation and not-found errors (relation and comment errors
included) carry a machine-readable `code`. `tools/call` surfaces those as an
`isError: true` tool result with `structuredContent.code` set (for example
`INVALID_RELATION`, `SELF_RELATION`, `ARTIFACT_NOT_FOUND`,
`RELATION_NOT_FOUND`, `COMMENT_NOT_FOUND`, `THREAD_TOO_DEEP`,
`COMMENT_TOO_LARGE`, `INVALID_REVIEW_STATUS`) instead of a JSON-RPC protocol
error, so clients can branch on the code without inspecting error text.

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

Subscriptions only deliver over the **stdio transport**, where one MCP
context lives for the whole process and notifications are written directly
to stdout. The streamable-HTTP `/mcp` transport (and the stdio bridge that
proxies to it, `ARTIFACTY_MCP_MODE=bridge`) builds a fresh, stateless
JSON-RPC context per POST request/response cycle — there is no open
connection left to push a notification over once the response is sent, so
`resources/subscribe` there is accepted (as the protocol requires) but never
delivers anything. Clients on that transport should poll with `artifacty_list`
or, better, use the `artifacty_wait` tool, which works as a bounded long-poll
within a single request regardless of transport.

## Prompts

Prompt names:

- `artifacty_handoff`
- `artifacty_review`
- `artifacty_test_report`
- `artifacty_visual_qa`
- `artifacty_release_notes`

Each prompt returns one user message that instructs an agent to create or update
an Artifacty artifact with discoverable `artifactType`, `sourceAgent`, and tags.
Prompts accept optional context arguments such as `artifactId`, `goal`, `scope`,
`target`, or `version`. `artifacty_handoff` and `artifacty_review` additionally
instruct the agent to pass `relations` on the create/update call so the graph
stays populated automatically: `artifacty_handoff` recommends
`relations: [{ toId: <source artifact ID>, relation: "derived-from" }]`, and
`artifacty_review` recommends `relations: [{ toId: <reviewed artifact ID>, relation: "reviews" }]`.
`artifacty_review` also prefers `artifacty_comment` (with `artifacty_set_review_status`
to record the verdict) over publishing a separate review artifact when the
review is short — a handful of findings — reserving a full review artifact
for longer or multi-file reviews.

## OpenAPI

Every `/api/*` HTTP route (artifacts, versions, import, audit, admin backup)
plus the `/mcp` JSON-RPC endpoint is described by an OpenAPI 3.1 document:

- `GET /openapi.json`: the machine-readable document. No authentication
  required; served with `cache-control: no-store` so it always reflects the
  running server's route set.
- `GET /docs/api`: a server-rendered HTML reference built from the same
  document (no external UI bundle, no CDN dependency).
- `artifacty_info` (MCP tool) and `artifacty doctor` both report the
  document's URL as `<serverUrl>/openapi.json`.

The document reuses the same JSON Schemas as the MCP tool `outputSchema`
definitions (see `src/lib/schemas.js`), so an artifact summary, a full
artifact-with-content record, a version, an audit event, a relation entry,
and the standard `{ error, code?, details? }` error shape mean the same thing
whether you're calling the HTTP API or an MCP tool. `test/openapi.test.js`
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
- Remote MCP currently uses bearer/header token auth. OAuth and per-user scoped
  tokens are future hardening work.
- Binary media resources return stored base64 text through MCP; browser `/raw`
  decodes first-class `image` and `video` artifacts into bytes.
- Clients may display resources and prompts differently. Tools remain the most
  widely supported integration path across Claude, Codex, Gemini, Copilot, and
  Cursor.
