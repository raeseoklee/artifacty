# Threat Model

English | [한국어](ko/threat-model.md)

Artifacty is a local artifact exchange for LLM agents. Its default deployment
uses one operator, one local store, and trusted local MCP clients.

## Assets

- Artifact content, including generated code, reports, screenshots, and media.
- Artifact metadata, tags, audit records, and version history.
- API tokens and generated startup tokens.
- User accounts, password hashes, browser sessions, and personal API tokens.
- Local MCP client configuration files.
- The Artifacty SQLite database and immutable version files.

## Trust Boundaries

- **HTTP browser server**: local by default. An operator can configure access
  from LAN or team networks.
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

Guidance:

- Rotate tokens after sharing sessions.
- Use token headers in scripts.
- Use generated startup tokens only for temporary interactive shares.

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

- Artifacty scans common API key and private key patterns before storage.
- Writes fail unless `allowSecrets` or `ARTIFACTY_ALLOW_SECRETS=true` is set.
- Artifacty records the scan status in version metadata.

Limitation: pattern scanning can miss sensitive data. A successful scan does
not prove that content is safe to share.

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

Guidance:

- Install Artifacty MCP only in trusted clients and workspaces.
- For central deployments, use TLS through a reverse proxy.
- Rotate shared tokens after team changes.

### Personal API Token Scopes

Risk: an attacker can use a leaked personal API token. A read-only reporting
token should not permit artifact changes or access to admin routes, such as
backup and webhooks.

Controls:

- Each personal token carries a `scopes_json` list drawn from `read`,
  `write`, `admin` (default `["read", "write"]` for both new tokens and
  tokens created before scopes existed).
- Only a user with the admin role can own a token with the `admin` scope.
  `createApiToken` rejects other requests for this scope.
- `requireScope` (`src/lib/security.js`) is called on every `/api/*` HTTP
  route: read routes need `read`, mutating routes need `write`, and
  admin-only routes (`/api/webhooks*`, `/api/admin/backup*`) need `admin` in
  addition to the existing admin-role check. A denial returns `403` with
  `code: "scope_denied"` and writes a `token-scope-denied` audit row,
  throttled to one per token per minute.
- The shared `ARTIFACTY_API_TOKEN` and browser sessions always have full
  scopes — scoping only narrows a *personal* token.
- For HTTP MCP, `tools/list` omits write tools when the token lacks `write`.
  A direct call to one of these tools returns an `isError` result with
  `structuredContent.code: "scope_denied"`. The tool does not execute.
- Local stdio is a trusted local process and does not enforce token scopes.
  If its configured token identifies a personal account, artifact access rules
  still apply to that account. Private site mode requires that personal identity.

Guidance: issue read-only tokens to reporting and analytics integrations.
Reserve tokens with the `admin` scope for operator tools.

### HTTP and MCP Rate Limiting

Risk: a compromised or faulty client could send excessive writes or searches.
An attacker could also send repeated password guesses to `/login`.

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

Guidance: increase the `*_PER_MIN` environment variables for integrations that
need higher throughput. Keep rate limiting enabled on non-loopback interfaces.

### Request and Content Size Limits

Artifacty enforces the following byte limits in its server process. These
limits are independent of reverse proxy limits:

| Limit | Value | Constant / env |
| --- | --- | --- |
| Artifact version content | 16 MiB | `MAX_ARTIFACT_BYTES` (`src/lib/storage.js`) |
| Backup import body | see `src/lib/backup.js` | `MAX_BACKUP_BYTES` |
| Comment body | 16 KiB | `MAX_COMMENT_BYTES` (`src/lib/storage.js`) |
| Generic JSON/form request body | `MAX_ARTIFACT_BYTES + 1024` | default `limitBytes` in `readJsonBody`/`readFormBody` (`src/server.js`) |

Artifacty rejects a request body over its limit with `413` before parsing it.

### Webhook SSRF and Secret Handling

Risk: an attacker who controls a webhook URL can influence outbound HTTP
requests from the Artifacty server. A leaked webhook secret lets an attacker
forge signed deliveries.

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
- Deliveries use `redirect: "manual"` and never follow redirects. A webhook
  target cannot use a 3xx response to send delivery to a blocked address.
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
- After 20 consecutive delivery failures, Artifacty disables the webhook and
  writes a `webhook-deliver-failed` audit row. The webhook stays disabled until
  an administrator deletes and recreates it.

Guidance:

- Register only webhook endpoints that you control or trust.
- Prefer HTTPS targets.
- If you suspect secret exposure, delete the webhook.
- Recreate the webhook with a new secret. This also rotates its signing
  `secretHash`.

### Artifact Visibility and Ownership

Risk: one user could read or change another user's artifacts without permission.
This includes sensitive drafts that the owner did not intend to share.

Controls:

- Administrators select public or private site mode at `/admin/access`.
- In public mode, every artifact has `visibility` (`private` or `team`, default
  `team`) and an `ownerUserId`. Only the owner or an administrator can read or
  write `private` artifacts through normal artifact routes. Anonymous browser
  visitors can read `team` artifacts. Authenticated principals can write them.
  API authentication requirements still apply. `ARTIFACTY_TEAM_WRITE=owner` restricts these writes to owners and
  administrators.
- Private site mode requires a personal identity. Owners and administrators
  retain access. Other users need a direct or team grant. Grants permit
  reading, commenting, or editing. Artifacty applies the strongest matching
  grant. Token scopes impose an additional restriction.
- Archiving, restoring, sharing, and changes to visibility or ownership require
  the owner or an administrator. These rules apply in both site modes.
- If a caller cannot read an artifact, the server returns
  `404`/`ARTIFACT_NOT_FOUND`. This prevents disclosure of the artifact's
  existence. If the caller can read it but lacks the required write or management
  permission, the server returns `403` with `code: "forbidden"`.
- List queries apply access checks in SQL for both metadata and FTS search.
  Relations to unreadable targets return `{ restricted: true }` without the
  target summary.
- A shared `ARTIFACTY_API_TOKEN` has no personal identity. In public mode, it can
  read and write `team` artifacts but cannot see `private` artifacts. In private
  mode, it cannot read or create artifacts. Its administrative privileges on
  other server routes do not grant a personal artifact identity.
- In public mode with no user accounts, user access checks do not apply.

Guidance: use separate stores for mutually untrusted parties. Administrators can
read, write, and reassign any artifact in their store.

### Public Share Links and Network Restrictions

Risk: a copied share link can disclose an artifact to anyone who holds the link.
An incorrect network policy can either expose the server or lock out its
administrator.

Controls:

- Share links provide read-only access. The owner or an administrator creates
  and revokes them. A link can select the latest version or one fixed version.
- Links expire. Private site mode disables them unless an administrator enables
  them. The server stores token hashes and shows the raw token only at creation.
- Share pages omit artifact ownership, tags, history, and internal artifact URLs.
  They use `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- All HTTP requests, including share links, obey the configured IP/CIDR allowlist.
  The server checks the TCP peer address and ignores forwarding headers.
- A network change must include the administrator's current address. It remains
  pending until confirmed. If it expires without confirmation, Artifacty restores
  the previous policy. Administrators can also roll back a pending change.

Guidance: treat share links as credentials. Revoke a link if it reaches an
unintended recipient. When using a reverse proxy, account for its TCP peer
address in the network policy.

### Retention Purge Gate

Risk: an incorrect retention policy can permanently delete artifacts and their
version files. For example, an operator could set `purgeArchivedAfterDays` too
low or apply it without reviewing the affected artifacts. Purge is the only
irreversible action that retention settings can trigger.

Controls:

- Changing `archiveAfterDays`, `purgeArchivedAfterDays`, `auditRetentionDays`,
  `eventRetentionRows`, or `keepTags` does not delete data. The new policy takes
  effect on the next sweep or explicit `artifacty retention run`.
- `artifacty retention run` and `POST /api/admin/retention/run` default to
  `dryRun: true`, returning a report of what would be archived/purged/pruned
  without changing the store. `/admin/retention` renders that same report so
  an admin can review it before applying anything.
- Archiving removes an artifact from active lists without deleting content.
  `artifacty restore` reverses it. The existing owner or administrator check
  on `archiveArtifact` is the only access requirement.
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
- OAuth. Personal API token scopes and direct or team artifact grants are
  supported, as described above.
- Encrypted-at-rest storage.
- Malware analysis of arbitrary artifact content.

## Security Review Checklist

- Run `npm run release:check`.
- Run `artifacty integrity` against important stores.
- Confirm non-local sharing uses a token and trusted LAN/VPN.
- Keep `ARTIFACTY_ENABLE_REACT_RENDERER` disabled unless required.
- Prefer token headers over query tokens in scripts.
- Review generated MCP configs before committing workspace files.
