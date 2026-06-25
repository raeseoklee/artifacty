# Repository Guidelines

## Project Structure & Module Organization

Artifacty shares LLM artifacts over HTTP, CLI, and MCP.

- `src/server.js`: localhost HTTP server, browser routes, and JSON API.
- `src/mcp-server.js`: MCP stdio server exposing Artifacty tools.
- `src/cli.js`: command-line interface for serving, publishing, importing, listing, and reading artifacts.
- `src/lib/storage.js`: SQLite metadata store and immutable version-file handling.
- `src/lib/converters.js`: agent artifact conversion rules for Claude, Codex, Gemini, GitHub Copilot, Cursor, and generic payloads.
- `src/lib/installer.js`: MCP config installers for Claude, Codex, and Gemini.
- `src/lib/render.js`: server-rendered dashboard, viewer, and editor HTML.
- `test/*.test.js`: Node test runner suites.
- `docs/integrations.md`: setup notes for Claude Code, Codex, Gemini CLI, GitHub Copilot in VS Code, and Cursor.

## Build, Test, and Development Commands

- `npm start`: run the HTTP dashboard on `127.0.0.1:8787`.
- `npm test`: run all tests with Node’s built-in test runner.
- `npm run lint`: syntax-check source and test files with `node --check`.
- `node src/mcp-server.js`: run the MCP stdio server.
- `node src/cli.js import --agent claude --file artifact.html`: convert and store an external artifact.
- `node src/cli.js install claude --dry-run`: preview generated MCP config.
- `node src/cli.js check`: verify MCP tool discovery.
- `node src/cli.js index rebuild`: rebuild the optional SQLite FTS5 search index.
- `node src/cli.js integrity`: verify version files, hashes, and orphaned files.

## Coding Style & Naming Conventions

Use modern ESM JavaScript and Node built-ins where practical. Keep modules small and route shared behavior through `src/lib/*` instead of duplicating logic in CLI, HTTP, and MCP layers. Use two-space indentation, semicolons only where already present, `camelCase` for functions and variables, and descriptive tool names such as `artifacty_create`.

Do not add new dependencies unless the operational value clearly outweighs the extra install and security surface.

## Testing Guidelines

Use `node:test` and `node:assert/strict`. Name tests `*.test.js` and keep them close to verified behavior: storage, converters, installers, HTTP routes, and MCP protocol flow. Add regression tests for every new artifact format, route, tool, installer, migration, or storage behavior. Run `npm run lint` and `npm test` before reporting completion.

## Commit & Pull Request Guidelines

This repository has no existing Git history to infer from. Use concise, intent-first commit messages, and include useful trailers when relevant:

```text
Add MCP artifact creation tool

Tested: npm test
Scope-risk: narrow
```

PRs should explain behavior, changed surfaces, verification, and security or compatibility risks.

## Security & Configuration Tips

Artifact content is untrusted. HTML renders in a sandboxed iframe, and the server binds to localhost by default. Keep `ARTIFACTY_HOME` private unless intentionally sharing a store, and avoid exposing the HTTP server on `0.0.0.0` without authentication.
