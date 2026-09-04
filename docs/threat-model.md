# Threat Model

Artifacty is a local artifact exchange for LLM agents. It is designed for one
operator, one local store, and trusted local MCP clients by default.

## Assets

- Artifact content, including generated code, reports, screenshots, and media.
- Artifact metadata, tags, audit records, and version history.
- API tokens and generated startup tokens.
- User accounts, password hashes, browser sessions, and personal API tokens.
- Local MCP client configuration files.
- The Artifacty SQLite database and immutable version files.

## Trust Boundaries

- **HTTP browser server**: local by default, optionally reachable on LAN/team
  networks when explicitly configured.
- **MCP stdio server**: local process launched by an MCP client. It inherits the
  local user account's filesystem permissions. In bridge mode, it forwards
  JSON-RPC to a configured central `/mcp` endpoint instead of touching local
  storage.
- **HTTP MCP endpoint**: optional `POST /mcp` endpoint exposed only when
  `--mcp-http` or `ARTIFACTY_MCP_HTTP=true` is configured.
- **Artifact renderers**: untrusted content is rendered inside browser sandbox
  boundaries where practical.
- **Storage**: Artifacty stores content under `ARTIFACTY_HOME`; anyone with
  filesystem access to that directory can read artifacts.
- **npm package**: published through GitHub Actions OIDC after automated checks.

## Primary Threats and Controls

### Accidental Network Exposure

Risk: binding to `0.0.0.0` exposes Artifacty on every interface, including VPNs
or cloud VM public interfaces.

Controls:

- Default host is `127.0.0.1`.
- Non-loopback binding requires `ARTIFACTY_SHARE_MODE=lan|team`.
- Non-loopback binding also requires `ARTIFACTY_API_TOKEN`.
- Startup logs warn when the server binds outside loopback.

Guidance: prefer a specific private interface IP over `0.0.0.0`. Do not expose
Artifacty directly to the public internet.

### Token Leakage

Risk: query-string tokens can appear in browser history, shell history, logs, or
referrers.

Controls:

- Scripts should use `x-artifacty-token` or `Authorization: Bearer <token>`.
- Browser form token URLs exist only for local convenience.
- Token comparisons use timing-safe digest comparison.
- Personal API tokens are stored only as hashes.
- Browser sessions use `HttpOnly` and `SameSite=Lax` cookies.

Guidance: rotate tokens after sharing sessions, prefer header-based tokens for
scripts, and use generated startup tokens only for temporary interactive shares.

### Cross-Site Request Forgery

Risk: a remote website could attempt to submit writes to an Artifacty server
reachable from the user's browser.

Controls:

- Mutating browser routes allow loopback or same-origin requests and reject
  cross-origin writes.
- API routes require a token when configured.
- LAN/team mode does not allow arbitrary browser origins.

### Untrusted Artifact Rendering

Risk: HTML, SVG, Mermaid, or React content could execute code in a viewer's
browser.

Controls:

- HTML artifacts render in sandboxed iframes.
- SVG artifacts render in scriptless sandboxed iframes after viewer-side
  sanitization.
- Mermaid renders in a sandboxed iframe without `allow-same-origin`.
- React is source-only unless `ARTIFACTY_ENABLE_REACT_RENDERER=true`.
- React rendering, when enabled, runs in a separate sandboxed frame with
  frame-scoped CSP.

Guidance: keep React rendering disabled for shared sessions unless all viewers
trust the source.

### Secret Storage

Risk: agents may accidentally publish API keys or private keys into artifacts.

Controls:

- Common API key and private key patterns are scanned before storage.
- Writes fail unless `allowSecrets` or `ARTIFACTY_ALLOW_SECRETS=true` is set.
- Stored scan status is recorded in version metadata.

Limitations: pattern scanning is best-effort and does not prove content is free
of sensitive data.

### MCP Tool Abuse

Risk: an MCP client can create, update, import, archive, restore, and read
artifacts through local stdio or the central HTTP MCP endpoint.

Controls:

- Local stdio remains the default.
- The HTTP MCP endpoint is disabled unless explicitly enabled.
- Remote MCP requests require the configured API token.
- Stdio bridge mode sends tokens in headers, not URLs.
- Personal tokens map requests to a server-side user record for artifact
  `publisherId` and audit `actor` attribution.
- MCP writes go through the same secret scan and audit paths as CLI/HTTP writes.
- MCP resources are read-only.

Guidance: install Artifacty MCP only in clients and workspaces you trust. For
central deployments, prefer TLS through a reverse proxy and rotate shared tokens
after team changes.

### Personal API Token Scopes

Risk: a personal API token leaked from one integration (e.g. a read-only
reporting bot) should not also let the leaker create, modify, or delete
artifacts or reach admin-only routes (backup, webhooks).

Controls:

- Each personal token carries a `scopes_json` list drawn from `read`,
  `write`, `admin` (default `["read", "write"]` for both new tokens and
  tokens created before scopes existed).
- `admin` can only be requested for a token owned by a user with the admin
  role; `createApiToken` rejects the request otherwise.
- `requireScope` (`src/lib/security.js`) is called on every `/api/*` HTTP
  route: read routes need `read`, mutating routes need `write`, and
  admin-only routes (`/api/webhooks*`, `/api/admin/backup*`) need `admin` in
  addition to the existing admin-role check. A denial returns `403` with
  `code: "scope_denied"` and writes a `token-scope-denied` audit row,
  throttled to one per token per minute.
- The shared `ARTIFACTY_API_TOKEN` and browser sessions always have full
  scopes — scoping only narrows a *personal* token.
- Over MCP, `tools/list` omits every tool without a `readOnlyHint`
  annotation (create, publish, import, update, archive, restore, link,
  unlink) when the connection's token lacks `write`; calling one of those
  tools directly anyway returns an `isError` tool result with
  `structuredContent.code: "scope_denied"` instead of executing it. This
  only applies to the streamable-HTTP MCP transport, where the connection is
  tied to an authenticated token — local stdio MCP connections are treated
  as fully trusted, matching every other local write path.

Guidance: issue read-only tokens to reporting/analytics integrations, and
reserve `admin` scope tokens for operator tooling only.

### HTTP and MCP Rate Limiting

Risk: a compromised or misbehaving token/client could flood the server with
writes or searches, or brute-force `/login`.

Controls:

- A fixed one-minute-window in-memory limiter, keyed by
  `(principal, bucket)` where principal is the token id, else the
  authenticated user id, else the remote address.
- Buckets: `write` (mutating `/api/*` routes and browser write posts;
  default 120/min, `ARTIFACTY_RATE_WRITE_PER_MIN`), `auth` (`POST /login`;
  default 10/min per address, `ARTIFACTY_RATE_AUTH_PER_MIN`), `search`
  (`GET /api/artifacts` with a `q` query; default 300/min,
  `ARTIFACTY_RATE_SEARCH_PER_MIN`).
- Disabled by default on a loopback bind (single-user local use is not
  throttled) unless `ARTIFACTY_RATE_LIMIT=always`; `ARTIFACTY_RATE_LIMIT=off`
  disables it unconditionally.
- Exceeding a bucket's limit returns `429` with a `Retry-After` header (in
  seconds) and `code: "rate_limited"`, and writes a `rate-limited` audit
  row, throttled to one per `(bucket, principal)` window. A mutating MCP
  tool call over the streamable-HTTP transport that exceeds the `write`
  bucket returns an `isError` tool result with
  `structuredContent.code: "rate_limited"` instead of a hard HTTP error.
- The limiter is in-memory and per-process; it resets on restart and does
  not coordinate across multiple server processes sharing one store.

Guidance: raise the `*_PER_MIN` env vars for legitimate high-throughput
integrations rather than disabling rate limiting outright on a
non-loopback bind.

### Request and Content Size Limits

Artifacty enforces the following byte limits, all in-process and independent
of any reverse proxy's own limits:

| Limit | Value | Constant / env |
| --- | --- | --- |
| Artifact version content | 16 MiB | `MAX_ARTIFACT_BYTES` (`src/lib/storage.js`) |
| Backup import body | see `src/lib/backup.js` | `MAX_BACKUP_BYTES` |
| Comment body (reserved; no comments feature yet) | 16 KiB | `MAX_COMMENT_BYTES` (`src/lib/storage.js`) |
| Generic JSON/form request body | `MAX_ARTIFACT_BYTES + 1024` | default `limitBytes` in `readJsonBody`/`readFormBody` (`src/server.js`) |

A request body over its limit is rejected with `413` before being parsed.

### Webhook SSRF and Secret Handling

Risk: a webhook target URL is an attacker-influenceable outbound HTTP request
from the Artifacty server's network position; a leaked webhook secret would let
an attacker forge signed deliveries.

Controls:

- Webhook targets must be `http` or `https`.
- Loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`),
  private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
  `fc00::/7`), CGNAT (`100.64.0.0/10`), IETF protocol assignments
  (`192.0.0.0/24`), benchmarking (`198.18.0.0/15`), multicast
  (`224.0.0.0/4`), `0.0.0.0/8`, and IPv4-mapped IPv6 equivalents of all of
  the above (`::ffff:0:0/96`) are rejected as webhook target hosts unless
  `ARTIFACTY_WEBHOOK_ALLOW_PRIVATE=true` (intended for local development and
  tests only — never set it on a shared or internet-reachable server). The
  IPv4 check parses every legacy `inet_aton` literal form (decimal, octal,
  hex, and 1-3 part shorthand, e.g. `2130706433`, `0177.0.0.1`, `0x7f000001`,
  `127.1`) into its 32-bit value before range-checking it, not just
  four-part dotted-decimal, and the IPv6 check fully expands `::` and zone
  ids before comparing groups, so an equivalent, differently-written form of
  a blocked address (e.g. `[0:0:0:0:0:0:0:1]` for `::1`) is rejected the
  same as its canonical form.
- The guard is a literal-address check on the URL's hostname, evaluated only
  at webhook creation time (`assertPublicWebhookUrl`, also exercised by
  tests) — it does not resolve DNS, and it does not run again at delivery
  time. A hostname that resolves to a private/loopback address only when the
  outbound HTTP request is actually made (DNS rebinding, or a name whose
  records changed after the webhook was created) is not caught by this
  control. Treat webhook creation as an admin-only, trusted-input operation,
  not as safe to expose to untrusted callers.
- Deliveries use `redirect: "manual"` and never follow a redirect, so a
  webhook target cannot use a 3xx response to retarget delivery at an
  otherwise-blocked address.
- The webhook secret is shown once, in the create response, and never stored
  or returned again in plaintext. What is persisted is `secretHash =
  sha256(secret)`, and every delivery is signed as
  `X-Artifacty-Signature: sha256=HMAC-SHA256(key = secretHash, body =
  <raw request body>)`. A receiver that kept the raw secret from the create
  response verifies a delivery by computing `sha256(secret)` locally to
  recover the same key before checking the HMAC — the server never needs to
  read the raw secret again to sign future deliveries.
- Webhook creation is admin-only once any user account exists; in
  single-user mode (no accounts configured) it is available to whoever holds
  the configured API token, matching every other write route's trust
  boundary.
- After 20 consecutive delivery failures a webhook is automatically disabled
  and a `webhook-deliver-failed` audit row is written; it stays disabled
  until deleted and recreated.

Guidance: only register webhook endpoints you control or trust, prefer HTTPS
targets, and treat a leaked webhook secret as a credential (delete and
recreate the webhook if you suspect exposure — that also rotates the
`secretHash` used for signing).

### Artifact Visibility and Ownership

Risk: in team mode, any authenticated user could read or modify any other
user's artifacts, including sensitive drafts or work-in-progress content
that was never meant to be shared server-wide.

Controls:

- Every artifact carries a `visibility` (`private` or `team`, default
  `team`) and an `ownerUserId`. `private` artifacts are readable and
  writable only by their owner or an admin; `team` artifacts are readable
  and writable by any authenticated principal, or restricted to the owner
  and admins for writes with `ARTIFACTY_TEAM_WRITE=owner`.
- Archiving, restoring, and changing visibility or ownership always require
  the artifact's owner or an admin, independent of the write rule above.
- A read of a `private` artifact by anyone other than its owner or an admin
  returns `404`/`ARTIFACT_NOT_FOUND` rather than `403`, so the artifact's
  existence is not leaked to callers who cannot see it. Writes and manage
  actions on an artifact the caller can see but does not own return `403`
  with `code: "forbidden"`.
- The access predicate is applied at the SQL layer for list queries (both
  the metadata and FTS search paths), not filtered after the fact, and
  relation entries pointing at a target the caller cannot see are returned
  as `{ restricted: true }` instead of the target's summary.
- A shared `ARTIFACTY_API_TOKEN` (or any request before the first user
  account exists) has no personal identity and is treated as an anonymous
  team principal: it can read and write `team` artifacts but never sees
  `private` ones, even though it is admin-equivalent for server
  administration routes elsewhere.
- In single-user mode (no user accounts configured at all) every check is
  bypassed, matching pre-Section-10 behavior, since there is no second
  identity to protect against.

Guidance: treat `private` as a convenience boundary between cooperating,
already-authenticated users on one server, not a substitute for running
separate stores for genuinely untrusted parties — an admin account can
always read, write, and reassign ownership of any artifact.

### Retention Purge Gate

Risk: a misconfigured or overly broad retention policy (e.g. a low
`purgeArchivedAfterDays` set by mistake, or applied before reviewing what it
would affect) could hard-delete artifacts and their version files with no
way to recover them — the only irreversible action any retention setting
can trigger.

Controls:

- Retention policy changes (`archiveAfterDays`, `purgeArchivedAfterDays`,
  `auditRetentionDays`, `eventRetentionRows`, `keepTags`) themselves never
  delete anything; they only take effect on the next sweep or explicit
  `artifacty retention run`.
- `artifacty retention run` and `POST /api/admin/retention/run` default to
  `dryRun: true`, returning a report of what would be archived/purged/pruned
  without changing the store. `/admin/retention` renders that same report so
  an admin can review it before applying anything.
- Archiving (moving an artifact out of active listings) is reversible via
  `artifacty restore` and never deletes content, so it carries no
  additional gate beyond the existing owner/admin check on `archiveArtifact`.
- Purging is irreversible and additionally requires
  `ARTIFACTY_RETENTION_ALLOW_PURGE=true` in the server's environment. A
  policy with purge candidates but no allow-purge gate set records them as
  `purgeSkipped: true` in the sweep result instead of silently no-op'ing or
  deleting anyway; the CLI's `--allow-purge` flag and the browser's "Allow
  purge" checkbox both map to the same environment-variable check rather
  than establishing an independent bypass.
- Every applied sweep writes one `retention-sweep` audit summary row
  (actor `system:retention`), and every purged artifact gets its own
  `retention-purge` audit row before deletion — `retention-purge` rows are
  themselves exempt from `auditRetentionDays` pruning, so a purge always
  remains traceable in the audit log even after the artifact it removed is
  long gone.
- A purge deletes the artifact's dependent rows that cascade via foreign
  keys (comments, relations, embeddings) plus its `events` rows and search
  index entries (neither of which has a foreign key to the artifact, so
  those are cleared explicitly rather than relying on `ON DELETE CASCADE`).
  Its audit log rows are the one thing that deliberately survive a purge —
  they are the record that the purge happened.

## Out of Scope

- Public internet hosting without a separate TLS/auth proxy.
- Multi-user browser write access.
- OAuth or per-user remote MCP authorization beyond the `read`/`write`/`admin`
  personal API token scopes described below.
- Group- or team-scoped ACLs beyond the single owner + team/private model
  (see Artifact Visibility and Ownership above).
- Encrypted-at-rest storage.
- Malware analysis of arbitrary artifact content.

## Security Review Checklist

- Run `npm run release:check`.
- Run `artifacty integrity` against important stores.
- Confirm non-local sharing uses a token and trusted LAN/VPN.
- Keep `ARTIFACTY_ENABLE_REACT_RENDERER` disabled unless required.
- Prefer token headers over query tokens in scripts.
- Review generated MCP configs before committing workspace files.
