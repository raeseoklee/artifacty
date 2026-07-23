# Agent Integration

Artifacty exposes one shared MCP stdio server and one local browser server.

## Start the Browser Server

```bash
npm start
```

The dashboard prefers `http://127.0.0.1:8787`. If that port is busy and no explicit port is configured, the server starts on the next available local port and records the actual URL in the store. The store defaults to `~/.artifacty`; set `ARTIFACTY_HOME` to share a different local directory.

Use a generated startup token when running a protected foreground server:

```bash
node src/cli.js serve --foreground --generate-token
node src/cli.js serve --foreground --host 0.0.0.0 --share-mode lan --generate-token
npm start -- --generate-token
```

Foreground runs print the generated token with ready-to-open create and import URLs. Background runs return the same values in JSON.

For prompt-friendly local background runs, use the lifecycle commands:

```bash
node src/cli.js serve --port 8787
node src/cli.js start --port 8787
node src/cli.js status
node src/cli.js stop
```

`serve`, `serve --detach`, and `start` use the same detached-process path. They write `server.pid`, `server.json`, and logs under `ARTIFACTY_HOME` (default `~/.artifacty`). `serve --generate-token` and `start --generate-token` generate the API token in the parent CLI process and return it in JSON along with ready-to-open create/import URLs. Use `serve --foreground` when you want attached logs for debugging.

The lifecycle commands are intended to be cross-platform:

- macOS and Linux: `stop` signals the detached process group first, then falls back to the server process id.
- Windows: `start` hides the child console window, and `stop` uses `taskkill /PID <pid> /T`, falling back to `/F` when Windows requires forceful termination. `--force` uses `/F` immediately.
- All platforms: `status` combines the managed pid file with the HTTP `/health` endpoint, so a stale pid alone is not reported as healthy.

Run diagnostics when setup behaves unexpectedly:

```bash
node src/cli.js doctor
node src/cli.js doctor --skip-mcp
```

`doctor` checks Node version support, local exposure settings, store integrity, managed server health, service definition rendering, and MCP discovery. A stopped server is reported as a warning, not a failure.

For login/startup persistence, use the operating system's service manager. Artifacty's `service` command can generate macOS LaunchAgent, Linux systemd user-unit, and Windows Task Scheduler definitions.

Create artifacts directly in the browser at `http://127.0.0.1:8787/new`.

For LAN or VPN sharing, keep the default local binding unless you intentionally need another machine to reach the server. See [network-sharing.md](network-sharing.md) before using `--host 0.0.0.0`.

The browser create/import/edit screens use CodeMirror 6 for Markdown, HTML, JSON, source-like text, SVG, Mermaid, React, SARIF, CSV, image, and video artifact editing. Editor and renderer assets are served from local npm dependencies through `/assets/*.js` and allowlisted `/vendor/npm/*` module routes. For sandboxed iframe imports, `Origin: null` requests receive `Access-Control-Allow-Origin: null`, which lets opaque-origin iframes import local ESM without `allow-same-origin`.

The browser UI defaults to English. Add `?lang=ko` to browser routes to use Korean UI labels; API and MCP payloads are not localized.

## MCP Server Command

Use this stdio command from this repository root:

```bash
node /path/to/artifacty/src/mcp-server.js
```

Useful environment variables:

- `ARTIFACTY_HOME`: store directory, shared by all agents.
- `ARTIFACTY_URL`: optional browser URL override. Leave it unset to let MCP read the last running server URL from `server.json`.
- `ARTIFACTY_MCP_MODE`: `local` by default, or `bridge` to forward stdio MCP to a central HTTP MCP endpoint.
- `ARTIFACTY_MCP_URL`: central MCP endpoint used by bridge mode, for example `http://10.0.0.50:8787/mcp`.
- `ARTIFACTY_API_TOKEN`: required token for HTTP API routes when configured. Generate one with `node src/cli.js token --raw`.
- `ARTIFACTY_SHARE_MODE`: set to `lan` or `team` before binding outside localhost.
- `ARTIFACTY_ALLOW_SECRETS`: set to `true` only when intentionally storing detected secrets.

## Automatic Install

Artifacty can write MCP configuration for supported local agents:

```bash
node src/cli.js install claude
node src/cli.js install codex --dry-run
node src/cli.js install gemini
node src/cli.js install copilot
node src/cli.js install cursor
node src/cli.js install all
node src/cli.js check
```

Central team server setup:

```bash
ARTIFACTY_BOOTSTRAP_TOKEN="$(node src/cli.js token --raw)"
node src/cli.js serve --foreground \
  --host 10.0.0.50 \
  --share-mode team \
  --api-token "$ARTIFACTY_BOOTSTRAP_TOKEN" \
  --mcp-http
# Open http://10.0.0.50:8787/login, create the first admin, then create a personal token at /account.
node src/cli.js install all \
  --mcp-url http://10.0.0.50:8787/mcp \
  --api-token "$ARTIFACTY_PERSONAL_TOKEN"
```

Administrators can create users one at a time from `/admin/users` or import a
CSV from the same page. The CLI can import the same file when run on the server:

```csv
email,name,role,password,password_reset_required
user@example.com,User,user,,
admin2@example.com,Admin Two,admin,temporary-password,true
```

```bash
artifacty users import --file users.csv
```

Rows without a password receive a generated temporary password. Generated
passwords are shown only in the import result, and imported users must change
their password before they can continue to `/account` and issue MCP/API tokens.

- Claude: writes project `.mcp.json`. Claude Code's startup timeout is controlled by the parent `MCP_TIMEOUT` environment variable and defaults to 30 seconds, so Artifacty does not add a per-server `.mcp.json` `timeout` field.
- Codex: writes or replaces the `[mcp_servers.artifacty]` block in `~/.codex/config.toml` unless `--config` is provided. The generated block uses a 30 second startup timeout so slower Windows or cold-start environments can load the MCP server reliably.
- Gemini: writes project `.gemini/settings.json` with a 30 second timeout.
- GitHub Copilot in VS Code: writes workspace `.vscode/mcp.json` using the VS Code `servers` shape. Pass `--config` to target a user-profile `mcp.json` instead.
- Cursor: writes project `.cursor/mcp.json` using the Cursor `mcpServers` shape. Pass `--config ~/.cursor/mcp.json` for global Cursor setup.
- `--dry-run` returns the generated config without writing it.
- `--mcp-url <url>` installs stdio bridge mode for central Artifacty. If the URL has no path, `/mcp` is appended.
- `--api-token <token>` is written into the generated MCP environment for bridge mode. For central servers, prefer a personal token issued from `/account`.
- `--url <url>` remains a browser-link override and does not enable central MCP by itself.
- `--timeout <ms>` adjusts Codex `startup_timeout_sec` and Gemini `timeout`. It does not change Claude Code startup behavior; set `MCP_TIMEOUT` before launching Claude Code if you need a larger value there.
- Do not use `artifacty install all --config <path>`. Each MCP client uses a
  different config file shape, so shared config overrides are rejected. Use
  `artifacty install <agent> --config <path>` only when targeting one agent.
- JSON-based installers preserve unrelated servers and replace only the
  `artifacty` entry. If `mcpServers` or `servers` already exists but is not a
  JSON object, Artifacty stops with an error instead of rewriting the file.
- `check` starts the local MCP server and verifies required tools, resources, and prompts through MCP discovery methods.
- `doctor` combines MCP discovery with runtime, storage, server, and service diagnostics.

Codex troubleshooting:

- If Codex reports a duplicate `mcp_servers.artifacty.env` or `artifacty.env`
  key, update Artifacty and rerun the Codex installer. Older installs could
  leave a legacy `[mcp_servers.artifacty.env]` child table behind while adding a
  new inline `env = { ... }` value.

```bash
npm install -g artifacty@latest
artifacty install codex \
  --mcp-url http://10.0.0.50:8787/mcp \
  --api-token "$ARTIFACTY_PERSONAL_TOKEN"
```

## Client Compatibility Matrix

| Client | Config shape | Scope | Timeout behavior | Restart requirement | Notes |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `.mcp.json` `mcpServers` | project | parent `MCP_TIMEOUT`, default 30s | restart Claude Code | no per-server startup timeout field |
| Codex | TOML `[mcp_servers.artifacty]` | user or explicit config | `startup_timeout_sec = 30.0` | restart Codex session | Windows cold starts may need the 30s default |
| Gemini CLI | JSON `mcpServers` | user or project | `timeout: 30000` | reload `/mcp` or restart | `trust` is preserved from installer options |
| GitHub Copilot in VS Code | `.vscode/mcp.json` `servers` | workspace or user profile | client-managed | reload VS Code MCP server | tools are the primary tested surface |
| Cursor | `.cursor/mcp.json` `mcpServers` | workspace or global | client-managed | restart/reload Cursor MCP | tools are the primary tested surface |

All clients should support MCP tools. Resource and prompt display varies by
client, so Artifacty's core workflows continue to work through tools even when a
client does not expose resources or prompts in its UI.

Generate a token for protected HTTP routes:

```bash
node src/cli.js token
node src/cli.js serve --generate-token
npm start -- --generate-token
ARTIFACTY_API_TOKEN="$(node src/cli.js token --raw)" node src/cli.js serve --foreground
```

## Claude Code

Manual local stdio MCP server:

```bash
claude mcp add --transport stdio artifacty -- node /path/to/artifacty/src/mcp-server.js
```

Project-scoped `.mcp.json` shape:

```json
{
  "mcpServers": {
    "artifacty": {
      "command": "node",
      "args": ["/path/to/artifacty/src/mcp-server.js"],
      "env": {
        "ARTIFACTY_HOME": "/absolute/path/to/artifacty-store"
      }
    }
  }
}
```

Claude plugins can bundle MCP servers, so this MCP server can later be wrapped as a plugin. The MVP keeps the server standalone so Claude, Codex, Gemini, GitHub Copilot, Cursor, and other MCP clients use the same integration surface.

Claude Code uses a 30 second MCP startup timeout by default. If a slower
environment needs more time, launch Claude Code with a larger `MCP_TIMEOUT`
value, for example `MCP_TIMEOUT=45000 claude`. Do not add a `.mcp.json`
`timeout` field for startup; that field is for tool execution timeout.

## Codex

Add a local MCP server entry to the Codex config:

```toml
[mcp_servers.artifacty]
command = "node"
args = ["/path/to/artifacty/src/mcp-server.js"]
startup_timeout_sec = 30.0
env = { ARTIFACTY_HOME = "/absolute/path/to/artifacty-store" }
```

Restart the Codex session after editing config so the MCP server is loaded.

Codex can publish continuation artifacts directly through MCP. Prefer explicit
`sourceAgent: "codex"` and an `artifactType` when the content is already
Markdown:

```json
{
  "title": "Implementation Handoff",
  "content": "# Handoff\n\n- Continue Phase 3.",
  "format": "markdown",
  "artifactType": "handoff",
  "sourceAgent": "codex",
  "tags": ["handoff"]
}
```

For structured continuation payloads, use `artifacty_import` with `agent:
"codex"`. Artifacty converts handoffs, file bundles, diff walkthroughs, code
reviews, and verification reports into the shared schema while preserving
changed files, commands, tests, blockers, and next steps in metadata.

## Gemini CLI

Add a server to `~/.gemini/settings.json` or `.gemini/settings.json`:

```json
{
  "mcpServers": {
    "artifacty": {
      "command": "node",
      "args": ["/path/to/artifacty/src/mcp-server.js"],
      "env": {
        "ARTIFACTY_HOME": "/absolute/path/to/artifacty-store"
      },
      "timeout": 30000,
      "trust": false
    }
  }
}
```

Then run `/mcp` inside Gemini CLI to confirm that the Artifacty tools are connected.

## MCP Tools

- `artifacty_create`: create a new Artifacty-native artifact.
- `artifacty_publish`: backwards-compatible alias for `artifacty_create`.
- `artifacty_import`: convert a Claude, Codex, Gemini, GitHub Copilot, Cursor, Artifacty, or generic artifact payload into Artifacty format and save it.
- `artifacty_list`: discover artifacts by query, tag, or source agent.
- `artifacty_get`: read artifact metadata and content.
- `artifacty_update`: append a new version.
- `artifacty_archive`: hide an artifact without deleting versions.
- `artifacty_restore`: clear archive state.
- `artifacty_audit`: list recent audit events.
- `artifacty_info`: inspect local server/store settings.

Mutating MCP tools scan content for common API keys and private keys before storage. Pass `allowSecrets: true` only for intentional exceptions.

## MCP Resources and Prompts

Artifacty also exposes read-only MCP resources:

- `artifacty://recent`: recent artifacts with pagination and browser URLs.
- `artifacty://schema/v1`: Artifact schema v1 Markdown.
- `artifacty://artifacts/{id}`: artifact JSON with metadata, content, and URLs.
- `artifacty://artifacts/{id}/raw{?version}`: raw latest or versioned content.

Prompt templates:

- `artifacty_handoff`: continuation handoff.
- `artifacty_review`: findings-first code review artifact.
- `artifacty_test_report`: verification evidence.
- `artifacty_visual_qa`: screenshot/media/browser evidence.
- `artifacty_release_notes`: release notes with publish evidence and risks.

See [mcp-public-api.md](mcp-public-api.md) for the public MCP surface.

## Importing Agent Artifacts

Use `artifacty_import` or the CLI `import` command when the artifact was produced by another agent and needs normalization before sharing.

```bash
node src/cli.js import --agent claude --file ./artifact.html --tag review
node src/cli.js import --agent codex --file ./handoff.md --tag handoff
node src/cli.js import --agent codex --content '{"agent":"codex","title":"Verification","verification":{"status":"passed","commands":[{"command":"npm test","status":"passed"}]}}'
node src/cli.js import --agent copilot --content '{"agent":"github-copilot","title":"PR Review","findings":[{"severity":"medium","file":"src/app.js","line":42,"title":"Handle missing state"}]}'
node src/cli.js import --agent cursor --content '{"sourceAgent":"cursor","title":"Cursor Handoff","summary":"Editor pass complete.","nextSteps":["Run visual QA."]}'
node src/cli.js import --agent cursor --file ./browser-screenshot.png --tag visual
node src/cli.js import --agent cursor --file ./demo.webm --tag demo
node src/cli.js import --agent gemini --content '{"title":"Options","returnDisplay":"# Options\n- A\n- B"}'
```

Supported converter inputs:

- Claude: local `.html`, `.htm`, `.md`, `.svg`, `.mmd`, `.jsx`, `.tsx`, source files, or JSON payloads with `title`/`content`/Claude artifact `type`.
- Codex: markdown/text/json handoff files; Artifacty-compatible JSON payloads; structured handoff, bundle, diff, review, and verification JSON payloads with `agent` or `sourceAgent` set to `codex`.
- GitHub Copilot: markdown/text/json outputs; Artifacty-compatible JSON payloads; structured handoff, review, diff, and verification JSON payloads with `agent` or `sourceAgent` set to `github-copilot` or `copilot`.
- Cursor: markdown/text/json outputs; Artifacty-compatible JSON payloads; structured handoff, review, diff, verification, screenshot, demo/video, and visual evidence bundle JSON payloads with `agent` or `sourceAgent` set to `cursor`.
- Gemini: `returnDisplay`, `llmContent`, text blocks, or local markdown/text/json files.
- Generic: file extension, content type, HTML doctype/fragments, JSON shape, media data URLs, and markdown headings are used to infer format and title. Generic `text/plain` uploads are upgraded to a more specific format, such as `html`, when filename or content makes that clear.

The converter canonicalizes source-agent aliases, adds `imported` and source-agent tags, preserves the raw content as an immutable Artifacty version, and records source details under `metadata.artifactyImport`. For example, `claude-code` and `Claude Code` are stored as `claude`.

Fixture examples for Copilot/Cursor PR review, screenshot, demo recording, and
visual evidence bundle live under `test/fixtures/` and are covered by converter
tests.

## HTTP API

- `GET /`: dashboard.
- `GET /new`: browser artifact editor.
- `POST /new`: create from the browser editor and redirect to the artifact.
- `GET /import`: browser artifact import form.
- `POST /import`: convert and save pasted agent output.
- `GET /health`: health check.
- `POST /mcp`: token-protected MCP Streamable HTTP JSON-RPC endpoint when `--mcp-http` or `ARTIFACTY_MCP_HTTP=true` is enabled.
- `GET /api/artifacts`: list artifacts.
- `POST /api/artifacts`: create artifact.
- `POST /api/import`: convert and save an agent-produced artifact.
- `GET /api/artifacts/:id`: read metadata and content.
- `POST /api/artifacts/:id`: append a version.
- `POST /api/artifacts/:id/archive`: archive without deleting versions.
- `POST /api/artifacts/:id/restore`: restore an archived artifact.
- `GET /api/audit`: list recent audit events, optionally filtered by `artifactId`.
- `GET /artifacts/:id`: browser viewer.
- `GET /artifacts/:id/react-frame?version=n`: gated React renderer frame. Returns content only when `ARTIFACTY_ENABLE_REACT_RENDERER=true`.
- `GET /artifacts/:id/edit`: browser version editor.
- `POST /artifacts/:id/edit`: append a version from the browser editor. Unchanged browser edits record `update-noop` without creating another version.
- `POST /artifacts/:id/archive`: archive from the browser.
- `POST /artifacts/:id/restore`: restore from the browser.
- `GET /artifacts/:id/diff`: compare two versions.
- `GET /artifacts/:id/raw?version=n`: raw content.
- `GET /admin/artifacts/:id/versions`: administrator-only version repair/delete screen.
- `POST /admin/artifacts/:id/versions/:version/repair`: administrator-only replacement of one version's content and format.
- `POST /admin/artifacts/:id/versions/:version/delete`: administrator-only deletion of one version. The last remaining version cannot be deleted.

When `ARTIFACTY_API_TOKEN` is configured, `/api/*` routes require either `Authorization: Bearer <token>` or `x-artifacty-token: <token>`. When users exist, personal tokens issued from `/account` also authenticate API and MCP requests, set created artifacts' `publisherId` to the token owner's email, and map audit `actor` to the same identity. Browser forms can also carry `?token=<token>` in the URL, which is copied to hidden form fields for local team workflows.

Renderer notes:

- `code` artifacts use a read-only CodeMirror viewer with escaped source fallback.
- `svg` artifacts render in a scriptless sandboxed iframe after viewer-side sanitization; `/raw` still returns the original SVG.
- `mermaid` artifacts load the vendored local Mermaid bundle from `/vendor/npm/mermaid/...` in a sandboxed iframe without `allow-same-origin`. The JavaScript asset route answers the iframe's `Origin: null` module request with `Access-Control-Allow-Origin: null`.
- `react` artifacts are source-only unless `ARTIFACTY_ENABLE_REACT_RENDERER=true` is set. When enabled, JSX transformation and React execution happen only in `/artifacts/:id/react-frame`, with `unsafe-eval` scoped to that frame CSP.
- `sarif` artifacts render a bounded findings summary and keep the complete formatted JSON available in the browser viewer and `/raw`.
- `csv` artifacts render as an escaped table with bounded rows and columns; `/raw` preserves the original CSV text.
- `image` and `video` artifacts store base64 content inline, render with native browser media elements, and decode bytes through `/raw`.

## Background Service

Generate platform-specific service definitions:

```bash
node src/cli.js service plist --dry-run
node src/cli.js service unit --dry-run
node src/cli.js service task --dry-run
```

Install the definition for the current OS:

```bash
node src/cli.js service install --dry-run
node src/cli.js service install
node src/cli.js service uninstall --dry-run
```

Use `--platform macos|linux|windows` when preparing a definition for another host. Use `--path` to choose the output path, or the platform-specific aliases `--plist`, `--unit`, and `--script`.

The generated service runs `src/server.js` with explicit `--host` and `--home` arguments. It includes `--port` only when you configure a port, which keeps the default port fallback available. `--api-token`, `--share-mode`, and `--allow-secrets` are preserved in the generated definition when explicitly provided.

Activation is still delegated to the OS service manager:

- macOS: `launchctl load ~/Library/LaunchAgents/com.artifacty.server.plist`
- Linux: `sudo loginctl enable-linger $USER`, then `systemctl --user enable --now com.artifacty.server.service`
- Windows: run the generated PowerShell script, which registers and starts the `ArtifactyServer` scheduled task.

On Linux central servers, user services stop when the user's systemd manager exits unless lingering is enabled. Verify durable operation with `loginctl show-user $USER -p Linger`; it should report `Linger=yes`. Without lingering, Artifacty may be unavailable after logout and appear to recover only after the user logs back in.

For background services, prefer a stable `ARTIFACTY_API_TOKEN` or `--api-token` value. `serve --generate-token` is intended for temporary interactive sessions; the parent CLI returns the generated token in JSON.

## Backup and Audit

Administrators can open `/admin/backup` to download an artifact backup JSON file
or restore a backup into the current server. The browser restore flow is useful
for small and medium migrations; use the CLI for large bundles.

```bash
node src/cli.js audit --limit 20
node src/cli.js backup
node src/cli.js export --file ./artifacty-backup.json
node src/cli.js import-store --file ./artifacty-backup.json
```

Backups include artifact metadata plus immutable version file contents in one
JSON bundle. They do not include users, sessions, API token records, or audit
logs. Importing a store replaces the target artifact records and prunes
unreferenced version files, so run it against a new or intentionally chosen
`ARTIFACTY_HOME`.
