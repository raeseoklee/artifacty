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

- Mutating browser routes reject non-local `Origin` headers.
- API routes require a token when configured.
- LAN/team mode does not relax browser-origin checks.

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

## Out of Scope

- Public internet hosting without a separate TLS/auth proxy.
- Multi-user browser write access.
- OAuth, scoped tokens, or per-user remote MCP authorization.
- Per-artifact ACLs.
- Encrypted-at-rest storage.
- Malware analysis of arbitrary artifact content.

## Security Review Checklist

- Run `npm run release:check`.
- Run `artifacty integrity` against important stores.
- Confirm non-local sharing uses a token and trusted LAN/VPN.
- Keep `ARTIFACTY_ENABLE_REACT_RENDERER` disabled unless required.
- Prefer token headers over query tokens in scripts.
- Review generated MCP configs before committing workspace files.
