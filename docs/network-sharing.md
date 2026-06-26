# Network Sharing

Artifacty is local-first. The default server binds to `127.0.0.1` and is intended for a single machine. Binding to a non-local address is supported for short, intentional sharing sessions, but it increases the exposed surface area.

## Recommended Defaults

Use the local server for normal work:

```bash
artifacty serve
```

If another device on a trusted LAN or private VPN needs read access, prefer binding to a specific interface address instead of every interface:

```bash
artifacty serve --host 192.168.1.20 --share-mode lan --generate-token
```

Use `0.0.0.0` only when you intentionally want Artifacty to listen on every network interface:

```bash
artifacty serve --host 0.0.0.0 --share-mode lan --generate-token
```

## Required Safeguards

Non-local hosts require both `ARTIFACTY_SHARE_MODE=lan|team` and an API token. This prevents accidentally exposing an unauthenticated Artifacty server.

The generated token protects HTTP API routes and browser write forms. Prefer the `x-artifacty-token` or `Authorization: Bearer <token>` header for scripts. URLs with `?token=...` are convenient for local foreground sessions, but can be stored in browser history, shell history, reverse-proxy logs, or referrers.

Artifacty does not terminate TLS. Do not expose it directly on the public internet. If a shared instance must cross an untrusted network, put it behind a TLS reverse proxy or a private VPN.

When Artifacty binds outside loopback, startup output includes a warning that the server is reachable beyond the local machine and that TLS is not provided by Artifacty.

## Browser Write Behavior

Remote browsers can read shared pages, but write actions are intentionally conservative. Mutating browser routes reject non-local `Origin` headers to reduce CSRF risk. For LAN sharing, prefer API or MCP writes with an explicit token header.

Do not relax the origin check just to make remote browser writes easier. A future team dashboard should use a dedicated policy that combines same-origin remote requests, explicit token validation, and clear operator intent.

## Renderer Guidance

Artifact content is untrusted. HTML, SVG, Mermaid, and React artifacts are rendered with sandboxing and CSP controls, but shared viewing still means content reaches another user's browser. Keep `ARTIFACTY_ENABLE_REACT_RENDERER` disabled for LAN sessions unless every viewer trusts the artifact source.

See [threat-model.md](threat-model.md) for the full trust-boundary summary.
