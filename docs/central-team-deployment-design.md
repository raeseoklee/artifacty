# Central Team Deployment Design

This document defines the design for running Artifacty as a shared internal
service, where many users connect Claude Code, Codex, Gemini, GitHub Copilot,
Cursor, or another MCP client to one central Artifacty server.

## Problem

Artifacty is local-first by default. The HTTP server can listen on a LAN
address, and the MCP server can either read and write the local `ARTIFACTY_HOME`
store directly or run as a stdio bridge to a central `/mcp` endpoint. The
installer `--url` option only controls the browser URL returned in MCP
responses; central MCP mode is selected with `--mcp-url`.

For a central deployment, every MCP client must write through the central
service instead of touching local SQLite or shared network files. The preferred
central surface is the native HTTP `/mcp` endpoint. A local stdio bridge remains
the default installer path for broad client compatibility.

## Goals

- One central Artifacty store per internal deployment.
- Native central MCP over Streamable HTTP for clients that support remote MCP.
- Per-user local stdio bridge compatibility for clients that only support local
  stdio MCP configuration.
- Stable install commands that can target a central server.
- Token-authenticated HTTP writes with no token leakage through query strings.
- Clear audit attribution for user, agent, host, and client surface.
- Safe defaults for LAN/team operation without weakening local-first behavior.

## Non-Goals

- Public internet hosting without a reverse proxy, TLS, and stronger auth.
- SQLite access over NFS or SMB as the recommended sharing model.
- Relaxing browser-origin checks to make remote browser writes easier.
- Removing the local stdio MCP path for single-user or legacy clients.

## Target Architecture

```text
MCP client with remote transport support
  -> https://artifacty.internal/mcp
  -> central Artifacty MCP handler
  -> central SQLite store and immutable version files
  -> browser dashboard at the same central URL

MCP client with stdio-only support
  -> local Artifacty stdio bridge
  -> https://artifacty.internal/mcp
  -> same central MCP handler
```

The central MCP handler is the canonical team integration surface. HTTP JSON API
routes remain useful for scripts, browser workflows, and compatibility, but MCP
tool semantics should not be reimplemented separately in a REST-only bridge.
Both stdio and Streamable HTTP should share the same tool/resource/prompt
dispatcher.

## Runtime Modes

Artifacty supports these explicit MCP operation modes:

- `local`: default mode; MCP reads and writes the local store directly.
- `streamable-http`: a central `/mcp` endpoint serves MCP over HTTP when
  `--mcp-http` or `ARTIFACTY_MCP_HTTP=true` is enabled.
- `bridge`: local stdio process forwards MCP JSON-RPC to a remote `/mcp`
  endpoint for clients that cannot connect to remote MCP directly.

Mode selection should be explicit. `ARTIFACTY_URL` must remain the public
browser URL override for backwards compatibility. New variables should define
remote MCP behavior:

```bash
ARTIFACTY_MCP_MODE=bridge
ARTIFACTY_MCP_URL=https://artifacty.internal/mcp
ARTIFACTY_API_TOKEN=...
```

`ARTIFACTY_URL` may default to the central browser URL when not set, but browser
links and MCP transport URLs should stay separate in the code and documentation.

## Installer UX

The installer exposes central-server options for every supported client:

```bash
artifacty install codex \
  --mcp-url https://artifacty.internal/mcp \
  --api-token "$ARTIFACTY_API_TOKEN"
```

Equivalent commands work for `claude`, `gemini`, `copilot`, `cursor`, and `all`.

The current installer generates a local bridge entry for every supported client:

```json
{
  "ARTIFACTY_MCP_MODE": "bridge",
  "ARTIFACTY_MCP_URL": "https://artifacty.internal/mcp",
  "ARTIFACTY_API_TOKEN": "..."
}
```

The installer should continue to support `--url` for link-only overrides.
`--mcp-url` should imply central MCP behavior; `--url` should not.

## Central Server Operation

A minimal LAN deployment should bind to a specific internal interface and require
token auth:

```bash
ARTIFACTY_API_TOKEN="$(artifacty token --raw)"
ARTIFACTY_SHARE_MODE=team \
artifacty serve \
  --host 10.0.0.50 \
  --port 8787 \
  --api-token "$ARTIFACTY_API_TOKEN" \
  --mcp-http
```

Open `/login` after the server starts. If no users exist, the first successful
login form creates an administrator. Administrators can create users from
`/admin/users`, and every user can create or revoke personal API tokens from
`/account`. Use those personal tokens for `artifacty install ... --api-token`
so MCP and API audit logs record the user's email as `actor`.

Production-like internal deployments should run Artifacty behind a TLS reverse
proxy, keep `ARTIFACTY_ENABLE_REACT_RENDERER` disabled unless the team trusts
all artifact authors, and store `ARTIFACTY_HOME` on local server disk with
regular backups.

The central server exposes `/mcp` only when explicitly enabled. This keeps the
local browser/API server behavior unchanged while making team MCP exposure an
intentional operating mode.

## MCP Requirements

Remote MCP mode needs complete parity with local MCP tools:

- create/import/list/get/update/archive/restore/audit/info
- resources: recent artifact list, artifact by ID, schema
- prompts: handoff, review, test report, visual QA, release notes

The stdio server and `/mcp` HTTP endpoint call the same dispatcher so tool
schemas, resources, prompts, validation, and audit behavior cannot drift.

All remote MCP requests must send `Authorization: Bearer` or an equivalent
header accepted by the central endpoint. Remote MCP should never place tokens in
URLs.

## Audit and Identity

Remote MCP requests should include headers such as:

```text
x-artifacty-client: codex
x-artifacty-actor: user@example.com
x-artifacty-host: IRAE-MACBOOK
```

The server records the authenticated user's email as the audit `actor` when a
personal token is used. The `x-artifacty-actor` header remains a compatibility
fallback for the bootstrap/global token path.

## Security Model

Central mode increases the trust boundary from one machine to a team network.
Required safeguards:

- non-loopback binding still requires `ARTIFACTY_SHARE_MODE=lan|team`
- central API always requires `ARTIFACTY_API_TOKEN`
- remote MCP uses header auth only
- shared instances should prefer TLS through a reverse proxy
- browser-origin protections remain in place
- artifact renderers continue treating stored content as untrusted

For larger organizations, the next step after personal tokens is scoped tokens,
token rotation policy, and SSO/OIDC.

## Current Implementation

- `artifacty serve --mcp-http` exposes `POST /mcp`.
- `ARTIFACTY_MCP_MODE=bridge` forwards stdio JSON-RPC to `ARTIFACTY_MCP_URL`.
- `artifacty install <agent> --mcp-url ... --api-token ...` writes bridge env
  config for Claude, Codex, Gemini, GitHub Copilot, and Cursor.
- `/login`, `/account`, and `/admin/users` provide server-side user management,
  administrator/user roles, and personal token issue/revoke flows.
- Remote MCP requests use header auth and never put tokens in URLs.
- Tests cover direct HTTP MCP calls and stdio bridge calls to a token-protected
  central server.

## Remaining Work

- Client-specific direct remote MCP config generation where the client supports
  it.
- Scoped tokens, token rotation policy, and stronger audit identity.
- Optional reverse proxy examples for TLS termination.

## Acceptance Criteria

- A user can install Artifacty MCP against a central `/mcp` endpoint without
  sharing a filesystem.
- Artifacts created from any supported MCP client appear in the central
  dashboard and are visible to other clients.
- Local MCP behavior remains unchanged when remote mode is not configured.
- Tokens are sent only in headers.
- CI covers remote MCP parity against the HTTP API.
