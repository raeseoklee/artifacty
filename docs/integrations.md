# Agent Integration

Artifacty exposes one shared MCP stdio server and one local browser server.

## Start the Browser Server

```bash
npm start
```

The dashboard prefers `http://127.0.0.1:8787`. If that port is busy and no explicit port is configured, the server starts on the next available local port and records the actual URL in the store. The store defaults to `~/.artifacty`; set `ARTIFACTY_HOME` to share a different local directory.

Create artifacts directly in the browser at `http://127.0.0.1:8787/new`.

The browser create/import/edit screens use CodeMirror 6 for Markdown, HTML, JSON, and plain text editing. Editor assets are served from local npm dependencies through `/assets/editor.js` and allowlisted `/vendor/npm/*` module routes.

The browser UI defaults to English. Add `?lang=ko` to browser routes to use Korean UI labels; API and MCP payloads are not localized.

## MCP Server Command

Use this stdio command from this repository root:

```bash
node /path/to/artifacty/src/mcp-server.js
```

Useful environment variables:

- `ARTIFACTY_HOME`: store directory, shared by all agents.
- `ARTIFACTY_URL`: optional browser URL override. Leave it unset to let MCP read the last running server URL from `server.json`.
- `ARTIFACTY_API_TOKEN`: required token for HTTP API routes when configured.
- `ARTIFACTY_SHARE_MODE`: set to `lan` or `team` before binding outside localhost.
- `ARTIFACTY_ALLOW_SECRETS`: set to `true` only when intentionally storing detected secrets.

## Automatic Install

Artifacty can write MCP configuration for supported local agents:

```bash
node src/cli.js install claude
node src/cli.js install codex --dry-run
node src/cli.js install gemini
node src/cli.js install all
node src/cli.js check
```

- Claude: writes project `.mcp.json`.
- Codex: writes or replaces the `[mcp_servers.artifacty]` block in `~/.codex/config.toml` unless `--config` is provided.
- Gemini: writes project `.gemini/settings.json`.
- `--dry-run` returns the generated config without writing it.
- `check` starts the local MCP server and verifies required tools through `initialize` and `tools/list`.

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

Claude plugins can bundle MCP servers, so this MCP server can later be wrapped as a plugin. The MVP keeps the server standalone so Claude, Codex, Gemini, and other MCP clients use the same integration surface.

## Codex

Add a local MCP server entry to the Codex config:

```toml
[mcp_servers.artifacty]
command = "node"
args = ["/path/to/artifacty/src/mcp-server.js"]
startup_timeout_sec = 5.0
env = { ARTIFACTY_HOME = "/absolute/path/to/artifacty-store" }
```

Restart the Codex session after editing config so the MCP server is loaded.

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
- `artifacty_import`: convert a Claude, Codex, Gemini, Artifacty, or generic artifact payload into Artifacty format and save it.
- `artifacty_list`: discover artifacts by query, tag, or source agent.
- `artifacty_get`: read artifact metadata and content.
- `artifacty_update`: append a new version.
- `artifacty_archive`: hide an artifact without deleting versions.
- `artifacty_restore`: clear archive state.
- `artifacty_audit`: list recent audit events.
- `artifacty_info`: inspect local server/store settings.

Mutating MCP tools scan content for common API keys and private keys before storage. Pass `allowSecrets: true` only for intentional exceptions.

## Importing Agent Artifacts

Use `artifacty_import` or the CLI `import` command when the artifact was produced by another agent and needs normalization before sharing.

```bash
node src/cli.js import --agent claude --file ./artifact.html --tag review
node src/cli.js import --agent codex --file ./handoff.md --tag handoff
node src/cli.js import --agent gemini --content '{"title":"Options","returnDisplay":"# Options\n- A\n- B"}'
```

Supported converter inputs:

- Claude: local `.html`, `.htm`, `.md`, or JSON payloads with `title`/`content`.
- Codex: markdown/text/json handoff files, or JSON payloads with `title`, `content`, `format`, `sourceAgent`, and `tags`.
- Gemini: `returnDisplay`, `llmContent`, text blocks, or local markdown/text/json files.
- Generic: file extension, content type, HTML doctype, JSON shape, and markdown headings are used to infer format and title.

The converter adds `imported` and source-agent tags, preserves the raw content as an immutable Artifacty version, and records source details under `metadata.artifactyImport`.

## HTTP API

- `GET /`: dashboard.
- `GET /new`: browser artifact editor.
- `POST /new`: create from the browser editor and redirect to the artifact.
- `GET /import`: browser artifact import form.
- `POST /import`: convert and save pasted agent output.
- `GET /health`: health check.
- `GET /api/artifacts`: list artifacts.
- `POST /api/artifacts`: create artifact.
- `POST /api/import`: convert and save an agent-produced artifact.
- `GET /api/artifacts/:id`: read metadata and content.
- `POST /api/artifacts/:id`: append a version.
- `POST /api/artifacts/:id/archive`: archive without deleting versions.
- `POST /api/artifacts/:id/restore`: restore an archived artifact.
- `GET /api/audit`: list recent audit events, optionally filtered by `artifactId`.
- `GET /artifacts/:id`: browser viewer.
- `GET /artifacts/:id/edit`: browser version editor.
- `POST /artifacts/:id/edit`: append a version from the browser editor.
- `POST /artifacts/:id/archive`: archive from the browser.
- `POST /artifacts/:id/restore`: restore from the browser.
- `GET /artifacts/:id/diff`: compare two versions.
- `GET /artifacts/:id/raw?version=n`: raw content.

When `ARTIFACTY_API_TOKEN` is configured, `/api/*` routes require either `Authorization: Bearer <token>` or `x-artifacty-token: <token>`. Browser forms can also carry `?token=<token>` in the URL, which is copied to hidden form fields for local team workflows.

## Background Service

Generate or install a macOS LaunchAgent plist:

```bash
node src/cli.js service plist
node src/cli.js service install --dry-run
node src/cli.js service install
```

The generated service runs `src/server.js` with explicit `--host` and `--home` arguments. It includes `--port` only when you configure a port, which keeps the default port fallback available. Load or unload it manually with the `launchctl` commands returned by `service install`.

## Backup and Audit

```bash
node src/cli.js audit --limit 20
node src/cli.js backup
node src/cli.js export --file ./artifacty-backup.json
node src/cli.js import-store --file ./artifacty-backup.json
```

Backups include SQLite metadata plus immutable version file contents in one JSON bundle. Importing a store replaces the target store index, so run it against a new or intentionally chosen `ARTIFACTY_HOME`.
