# Artifacty

Artifacty is a local, agent-to-agent artifact exchange for LLM workflows. Claude, Codex, Gemini, and other MCP-capable tools can publish an artifact once, then other agents can list, read, update, and continue from it without copying content through chat.

![Artifacty overview showing multiple AI agents sharing artifacts through a local exchange](docs/assets/artifacty.png)

## Why MCP

Claude Code artifacts are useful because they turn session output into shareable, versioned pages. Artifacty keeps that local and cross-agent: the browser server renders artifacts for people, while the MCP stdio server gives agents a common tool interface.

## Quick Start

Install and start Artifacty:

```bash
npm install -g artifacty
artifacty serve
```

For local development from a checkout:

```bash
npm install
npm test
npm start
```

Open the URL printed by the server. Artifacty prefers `http://127.0.0.1:8787`; if that default port is busy and no explicit port was configured, it starts on the next available local port and records the actual URL for CLI and MCP responses.

Run the production-readiness check:

```bash
npm run release:check
```

Create an artifact in the browser:

```text
http://127.0.0.1:8787/new
```

Publish from the CLI:

```bash
node src/cli.js publish --title "handoff note" --format markdown --source codex --content "# Next step\nReview the API plan."
```

Import an artifact produced by another agent and convert it to Artifacty format:

```bash
node src/cli.js import --agent claude --file ./deploy-failures.html --tag review
node src/cli.js import --agent gemini --content '{"title":"Plan","returnDisplay":"# Plan\n- Ship it"}'
```

List artifacts:

```bash
node src/cli.js list
```

Run the MCP server:

```bash
node src/mcp-server.js
```

MCP clients can create artifacts with `artifacty_create`. `artifacty_publish` remains as a backwards-compatible alias.

Install MCP configuration for local agents:

```bash
node src/cli.js install claude
node src/cli.js install codex --dry-run
node src/cli.js install gemini
node src/cli.js install all
node src/cli.js check
```

See [docs/integrations.md](docs/integrations.md) for Claude Code, Codex, and Gemini CLI setup.

Operational commands:

```bash
node src/cli.js audit --limit 20
node src/cli.js backup
node src/cli.js export --file ./artifacty-backup.json
node src/cli.js import-store --file ./artifacty-backup.json
node src/cli.js service install --dry-run
```

After global installation, the same commands are available as `artifacty` and `artifacty-mcp`.

## Storage

By default Artifacty stores files under `~/.artifacty`.

```bash
ARTIFACTY_HOME=/path/to/shared/store npm start
```

Artifact metadata is stored in `artifacty.sqlite`; artifact content is stored as immutable version files under `artifacts/`. The current browser server URL is written to `server.json` so MCP tools can return the correct links when the default port falls back. Existing `index.json` stores are migrated automatically on first access.

## API Example

```bash
curl -s http://127.0.0.1:8787/api/artifacts \
  -H 'content-type: application/json' \
  -H "x-artifacty-token: $ARTIFACTY_API_TOKEN" \
  -d '{
    "title": "PR review dashboard",
    "content": "<h1>Review</h1>",
    "format": "html",
    "sourceAgent": "claude",
    "tags": ["review"]
  }'
```

Convert-and-save an external agent artifact:

```bash
curl -s http://127.0.0.1:8787/api/import \
  -H 'content-type: application/json' \
  -H "x-artifacty-token: $ARTIFACTY_API_TOKEN" \
  -d '{
    "agent": "claude",
    "fileName": "deploy-failures.html",
    "content": "<html><head><title>Deploy failures</title></head><body>...</body></html>",
    "tags": ["review"]
  }'
```

Browser routes:

- `/`: list artifacts with search, tag, and source filters.
- `/new`: create an Artifacty-native artifact with the CodeMirror editor.
- `/import`: paste an external agent artifact and convert it with automatic editor mode detection.
- `/artifacts/:id/edit`: save a new version with Markdown, HTML, JSON, or text syntax support.
- `/artifacts/:id/diff`: compare versions.
- `/api/audit`: list audit events.

## Interface Language

The browser UI defaults to English. Add `?lang=ko` to any browser route to use Korean, for example `http://127.0.0.1:8787/new?lang=ko`. Forms and in-app links preserve the selected language. Documentation is maintained in English only.

Schema and storage:

- Metadata lives in SQLite with `schemaVersion: 1`, `artifactType`, and `archivedAt`.
- Archive hides artifacts from default lists without deleting versions.
- Bundle artifacts store multiple files or base64 assets as portable JSON.
- See [docs/artifact-schema-v1.md](docs/artifact-schema-v1.md).

## Security Model

- The HTTP server binds to `127.0.0.1` by default.
- If `ARTIFACTY_API_TOKEN` is set, HTTP API routes require `Authorization: Bearer <token>` or `x-artifacty-token`.
- Binding outside localhost requires both `ARTIFACTY_SHARE_MODE=lan` or `team` and `ARTIFACTY_API_TOKEN`.
- Artifact content is scanned for common API keys and private keys before storage. Use `--allow-secrets` or `ARTIFACTY_ALLOW_SECRETS=true` only for intentional exceptions.
- Creates, updates, reads, imports, archives, and restores write audit events to SQLite.
- CodeMirror editor assets are served from local npm dependencies through a package allowlist, not from a public CDN.
- Mutating HTTP routes reject non-local browser origins.
- HTML artifacts render in a sandboxed iframe.
- Artifact content should still be treated as untrusted; use the raw view when handing content back to an agent.

See [docs/release-checklist.md](docs/release-checklist.md) before publishing or running a shared instance.
