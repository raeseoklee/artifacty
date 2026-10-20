# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

Artifacty is a local, agent-to-agent artifact exchange for LLM workflows. One agent publishes an artifact. Other agents can list, read, import, update, and continue from it without copying content through chat. HTTP, the browser, the CLI, and MCP stdio use the same store.

See `AGENTS.md` for repository structure, coding-style conventions, and commit/PR guidelines.

For English and Korean documentation, follow the [writing style guide](docs/writing-style.md). Apply relaxed STE-100 clarity principles to both languages. Preserve conditions, defaults, permissions, exceptions, and recovery requirements. For Korean, apply fluent-korean as well; resolve conflicts in this order: technical accuracy, natural Korean, then brevity and sentence form.

## Commands

- `npm test` — run all tests with `node --test`.
- `npm run lint` — syntax-check source and tests with `node --check`.
- `npm run smoke` — start a temporary token-protected server and verify core HTTP, backup, and MCP behavior.
- `npm run release:check` — run lint, tests, and smoke together.
- `npm start` — run the HTTP dashboard. It prefers `127.0.0.1:8787` and falls back when the default port is busy.
- `node src/mcp-server.js` or `npm run mcp` — run the MCP stdio server.
- `node src/cli.js help` — inspect CLI usage.

Run `npm run release:check` before claiming a release-ready change. There is no build step; this is plain ESM run directly by Node `>=22.12.0`.

## Architecture

### Shared Library Funnel

The three entry points are thin adapters:

- `src/server.js` handles HTTP/browser routes and JSON API.
- `src/cli.js` handles command-line workflows.
- `src/mcp-server.js` handles MCP JSON-RPC over stdio.

Shared behavior belongs in `src/lib/*`. Use `src/lib/storage.js` for storage, `src/lib/converters.js` for conversion, and `src/lib/installer.js` for installers. Security checks belong in `src/lib/security.js`; server URL discovery belongs in `src/lib/server-state.js`.

### Storage Model

The store lives at `ARTIFACTY_HOME` or `~/.artifacty` by default.

- SQLite metadata is stored in `artifacty.sqlite`.
- Immutable version files are stored under `artifacts/<id>/v<n>.<ext>`.
- `server.json` records the currently running browser server URL so CLI and MCP responses keep working when the default port falls back.
- Legacy `index.json` stores migrate automatically on first access.

Versions are append-only. To correct a historical version, use the admin repair (`replaceArtifactVersion`) or delete (`deleteArtifactVersion`) path. These paths record every change in the audit log. Do not modify prior content files through other paths.

Before changing upgrade behavior, read [upgrade snapshots and recovery](docs/upgrade-backups.md). Schema migrations require a verified snapshot through `src/lib/upgrade-backup.js`. Use `ARTIFACTY_BACKUP_ON_UPDATE=true` for optional application-update snapshots.

Keep recovery commands independent of normal storage initialization so they cannot trigger a migration. Stop every server and MCP process before restoring a store. Test recovery only with temporary stores.

### Security Model

- The HTTP server binds to `127.0.0.1` by default.
- Non-local bind addresses require `ARTIFACTY_SHARE_MODE=lan` or `team` plus `ARTIFACTY_API_TOKEN`.
- API routes require token auth when `ARTIFACTY_API_TOKEN` is configured.
- Storage rejects common secret patterns before persisting content unless an explicit allow flag is used.
- HTML artifacts render in sandboxed iframes and must remain treated as untrusted.

### Browser Editor

The create/import/edit screens use CodeMirror 6 for Markdown, HTML, JSON, and text editing. CodeMirror assets are served locally through allowlisted `/vendor/npm/*` routes, not from a CDN. UI text defaults to English and supports Korean with `?lang=ko`. Keep each document in its existing language unless a translation is requested.

Mermaid uses version 12.1.0 with the existing `classic` look, `dagre` layout, and `default` theme. Its browser code requires ES2024 support, such as Safari 17.4 or newer. The optional Babel 8 React renderer requires Node `^22.18.0 || >=24.11.0`.

### MCP Server

The MCP server is a hand-rolled line-delimited JSON-RPC 2.0 implementation using protocol version `2025-06-18`. Tool results include both `content[].text` and `structuredContent`. Keep `artifacty_publish` as a backwards-compatible alias for `artifacty_create`.

When `ARTIFACTY_URL` is unset, MCP reads the current browser URL from `server.json`. Do not reintroduce a hard-coded `http://127.0.0.1:8787` default into generated MCP configs.

### Tests

Tests use `node:test` and `node:assert/strict`. Add regression tests for every new route, CLI command, MCP tool, converter behavior, security rule, migration, or storage change. Keep tests isolated with temporary stores and cleanup in `finally`.
