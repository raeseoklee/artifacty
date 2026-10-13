# Central Team Deployment Design

This document defines the design for a shared internal Artifacty service.
Users connect Claude Code, Codex, Gemini, GitHub Copilot, Cursor, or another MCP
client to one central Artifacty server.

## Problem

Artifacty uses a local store by default. The HTTP server can listen on a LAN
address. The MCP server can read and write the local `ARTIFACTY_HOME` store
directly. It can also run as a stdio bridge to a central `/mcp` endpoint.

The installer `--url` option controls only the browser URL in MCP responses.
Use `--mcp-url` to select central MCP mode.

For a central deployment, every MCP client must write through the central
service. Clients must not write to local SQLite or shared network files. Use
the native HTTP `/mcp` endpoint when the client supports it. The installer
uses a local stdio bridge by default for compatibility with more clients.

## Goals

- One central Artifacty store per internal deployment.
- Native central MCP over Streamable HTTP for clients that support remote MCP.
- Per-user local stdio bridge compatibility for clients that only support local
  stdio MCP configuration.
- Stable install commands that can target a central server.
- HTTP writes authenticated by tokens. Query strings must not contain tokens.
- Clear audit attribution for user, agent, host, and client surface.
- Safe defaults for LAN and team operation. Local operation must retain its
  existing protections.

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

The central MCP handler is the main team integration interface. HTTP JSON API
routes remain available for scripts, browser workflows, and compatibility.
A REST-only bridge should not implement a separate set of MCP tool behavior.
Both stdio and Streamable HTTP should use the same tool, resource, and prompt
dispatcher.

## Runtime Modes

Artifacty supports these explicit MCP operation modes:

- `local`: default mode; MCP reads and writes the local store directly.
- `streamable-http`: a central `/mcp` endpoint serves MCP over HTTP when
  `--mcp-http` or `ARTIFACTY_MCP_HTTP=true` is enabled.
- `bridge`: local stdio process forwards MCP JSON-RPC to a remote `/mcp`
  endpoint for clients that cannot connect to remote MCP directly.

Select the mode explicitly. For backward compatibility, `ARTIFACTY_URL` must
remain the public browser URL override. Use new variables to define remote
MCP behavior:

```bash
ARTIFACTY_MCP_MODE=bridge
ARTIFACTY_MCP_URL=https://artifacty.internal/mcp
ARTIFACTY_API_TOKEN=...
```

If `ARTIFACTY_URL` is not set, it may default to the central browser URL. Keep
browser links separate from MCP transport URLs in the code and documentation.

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

For a minimal LAN deployment, bind to a specific internal interface. Require
token authentication:

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
`/admin/users` or paste CSV data to import users. Each user can create or revoke
personal API tokens from `/account`.

CSV imports support `email,name,role,password,password_reset_required`. If a
password is blank, the importer generates it once. The user must change that
password at first sign-in. Use personal tokens with
`artifacty install ... --api-token`. MCP and API audit logs then record the
user's email as `actor`. Created artifacts record the same email as `publisherId`.

For internal production deployments, run Artifacty behind a TLS reverse proxy.
Keep `ARTIFACTY_ENABLE_REACT_RENDERER` disabled unless the team trusts all
artifact authors. Store `ARTIFACTY_HOME` on the server's local disk and make
regular backups.

Administrators can export and restore artifact backup bundles from
`/admin/backup`. For large migrations, run `artifacty backup` on the old server.
Then run `artifacty import-store --file <backup.json>` on the new server.

For Linux user-service deployments, enable systemd lingering for the service
account:

```bash
sudo loginctl enable-linger artifacty
loginctl show-user artifacty -p Linger
```

Use the actual service account name. Without lingering, `systemctl --user`
services depend on the user's login manager. They can stop after logout. The
central dashboard and `/mcp` endpoint then remain unavailable until that user
logs in again. A system-level unit is another option for central servers.

The central server exposes `/mcp` only when explicitly enabled. This requirement
keeps the local browser and API behavior unchanged. Operators must choose to
enable MCP access for a team.

## MCP Requirements

Remote MCP mode needs complete parity with local MCP tools:

- create/import/list/get/update/archive/restore/audit/info
- resources: recent artifact list, artifact by ID, schema
- prompts: handoff, review, test report, visual QA, release notes

The stdio server and `/mcp` HTTP endpoint call the same dispatcher. This keeps
tool schemas, resources, prompts, validation, and audit behavior consistent.

All remote MCP requests must send `Authorization: Bearer` or an equivalent
header that the central endpoint accepts. Remote MCP must not put tokens in URLs.

## Audit and Identity

Remote MCP requests should include headers such as:

```text
x-artifacty-client: codex
x-artifacty-actor: user@example.com
x-artifacty-host: IRAE-MACBOOK
```

The server records the authenticated user's email as the artifact `publisherId`
and audit `actor` when a personal token is used. The `x-artifacty-actor` header
remains a compatibility fallback for the bootstrap/global token path.

## Security Model

Central mode extends access from one machine to a team network. It requires
these safeguards:

- non-loopback binding still requires `ARTIFACTY_SHARE_MODE=lan|team`
- central API always requires `ARTIFACTY_API_TOKEN`
- remote MCP uses header auth only
- shared instances should prefer TLS through a reverse proxy
- browser-origin protections remain in place
- artifact renderers continue treating stored content as untrusted

For larger organizations, the planned next steps after personal tokens are
scoped tokens, a token rotation policy, and SSO/OIDC.

## Current Implementation

- `artifacty serve --mcp-http` exposes `POST /mcp`.
- `ARTIFACTY_MCP_MODE=bridge` forwards stdio JSON-RPC to `ARTIFACTY_MCP_URL`.
- `artifacty install <agent> --mcp-url ... --api-token ...` writes bridge env
  config for Claude, Codex, Gemini, GitHub Copilot, and Cursor.
- `/login`, `/account`, and `/admin/users` provide server-side user management,
  administrator/user roles, CSV user import, required password reset, password
  change, and personal token issue/revoke flows.
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
