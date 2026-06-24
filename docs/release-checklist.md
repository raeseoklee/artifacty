# Release Checklist

Use this checklist before publishing or distributing Artifacty.

## Required Verification

```bash
npm run release:check
```

This runs syntax checks, the full Node test suite, and a local smoke test that starts the HTTP server with token auth enabled, creates an artifact, verifies secret blocking, reads audit logs, writes a backup, and checks MCP tool discovery.

## Packaging

- Confirm `package.json` `version` and `files` are intentional.
- Run `npm pack --dry-run` and inspect the included paths.
- Review package size after renderer dependencies. Mermaid is a default dependency;
  React, ReactDOM, and Babel standalone are optional dependencies used only by the
  gated React renderer.
- Verify the global commands resolve after install: `artifacty`, `artifacty-mcp`.

## Security

- Keep the default HTTP bind address at `127.0.0.1`.
- Require `ARTIFACTY_API_TOKEN` and `ARTIFACTY_SHARE_MODE=lan` or `team` before binding to `0.0.0.0`.
- Review secret-scan bypasses. `--allow-secrets` and `ARTIFACTY_ALLOW_SECRETS=true` should be deliberate and temporary.
- Treat artifact HTML and imported agent payloads as untrusted content.
- Confirm scripted artifact iframes never include `allow-same-origin`.
- Confirm `/assets/*` and `/vendor/npm/*` JavaScript responses return
  `Access-Control-Allow-Origin: null` only for `Origin: null` requests, so
  opaque-origin sandbox iframes can import local ESM without weakening sandbox
  flags or using a wildcard CORS policy.
- Confirm SVG viewer output strips `<script>`, `on*` attributes, and `javascript:` links while `/raw` preserves original source.
- Browser-smoke each renderer that executes client code. Route status alone does
  not prove Mermaid or React rendered inside the iframe.
- Keep `ARTIFACTY_ENABLE_REACT_RENDERER` disabled by default. Enable it only when the operator accepts arbitrary component execution risk.
- Confirm parent app CSP does not include `unsafe-eval`; it should appear only on the React frame response CSP.

## Operations

- Export a backup before upgrades: `artifacty backup`.
- Confirm `artifacty audit --limit 20` shows recent create/update/read/archive events.
- For macOS background service installs, dry-run first: `artifacty service install --dry-run`.
