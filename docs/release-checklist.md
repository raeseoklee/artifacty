# Release Checklist

Use this checklist before publishing or distributing Artifacty.

## Required Verification

```bash
npm run release:check
```

This command runs syntax checks, the full Node test suite, and a local smoke test. The smoke test checks these operations:

- Start the HTTP server with token authentication.
- Create an artifact.
- Block detected secrets.
- Read audit logs.
- Write a backup.
- Discover MCP tools, resources, and prompts.

Run the local diagnostics pass:

```bash
artifacty doctor
```

## Packaging

- Confirm `package.json` `version` and `files` are intentional.
- Run `npm pack --dry-run`.
- Inspect the paths in the package output.
- Review the package size with renderer dependencies included. Mermaid is a default dependency.
  React, ReactDOM, and Babel standalone are optional dependencies for the gated React renderer.
- Verify the global commands resolve after install: `artifacty`, `artifacty-mcp`.

## Security

- Keep the default HTTP bind address at `127.0.0.1`.
- Require `ARTIFACTY_API_TOKEN` and `ARTIFACTY_SHARE_MODE=lan` or `team` before binding to `0.0.0.0`.
- Confirm non-loopback startup output includes the LAN/team warning.
- Confirm `artifacty serve` starts a managed background server and returns JSON.
- Use `artifacty serve --foreground` to check attached logs.
- Confirm `artifacty service plist|unit|task --dry-run` renders macOS, Linux, and Windows service definitions.
- Prefer `x-artifacty-token` or `Authorization: Bearer <token>` over query tokens in scripts.
- Review each secret-scan bypass. Use `--allow-secrets` and `ARTIFACTY_ALLOW_SECRETS=true` only for deliberate, temporary exceptions.
- Review [../SECURITY.md](../SECURITY.md) and [threat-model.md](threat-model.md) when changing auth, rendering, MCP, or network-sharing behavior.
- Treat artifact HTML and imported agent payloads as untrusted content.
- Confirm scripted artifact iframes never include `allow-same-origin`.
- Confirm `/assets/*` and `/vendor/npm/*` JavaScript responses return
  `Access-Control-Allow-Origin: null` only for `Origin: null` requests, so
  opaque-origin sandbox iframes can import local ESM without weakening sandbox
  flags or using a wildcard CORS policy.
- Confirm SVG viewer output removes `<script>`, `on*` attributes, and `javascript:` links.
- Confirm `/raw` preserves the original source.
- Test each renderer that executes client code in a browser. Confirm the rendered output.
  A successful route response does not prove that Mermaid or React rendered inside the iframe.
- Keep `ARTIFACTY_ENABLE_REACT_RENDERER` disabled by default. Enable it only when the operator accepts arbitrary component execution risk.
- Confirm the parent app CSP excludes `unsafe-eval`.
- Confirm only the React frame response CSP permits `unsafe-eval`.
- Confirm CodeQL, Scorecard, and Dependabot configuration changes are intentional.
- Confirm npm publish still uses OIDC Trusted Publishing rather than a long-lived npm token.

## Operations

- Before an upgrade or server move, export a backup. Use `artifacty backup` for artifacts only. Use `artifacty backup --full` to also include users, tokens, audit logs, relations, and webhooks.
- Confirm `artifacty audit --limit 20` shows recent create/update/read/archive events.
- Confirm `artifacty doctor` reports no failures. A stopped server warning is acceptable when intentionally checking an offline store.
- Before installing a background service, run `artifacty service install --dry-run`.
- To review a definition for another operating system, use `--platform macos|linux|windows`.
