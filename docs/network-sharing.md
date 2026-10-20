# Network Sharing

English | [한국어](ko/network-sharing.md)

Artifacty stores artifacts locally. By default, the server binds to `127.0.0.1` for use on one machine. For a short sharing session, you can bind to a non-local address. Other machines can then reach the server.

## Recommended Defaults

Use the local server for normal work:

```bash
artifacty serve
```

If another device on a trusted LAN or private VPN needs read access, bind to a specific interface address. Avoid listening on every interface:

```bash
artifacty serve --host 192.168.1.20 --share-mode lan --generate-token
```

For a central internal MCP server, enable `/mcp` explicitly and install clients
with `--mcp-url` and a personal token from `/account`:

```bash
ARTIFACTY_BOOTSTRAP_TOKEN="$(artifacty token --raw)"
artifacty serve --host 10.0.0.50 --share-mode team --api-token "$ARTIFACTY_BOOTSTRAP_TOKEN" --mcp-http --foreground
# Open /login to create the first admin, then /account to issue a personal token.
artifacty install all --mcp-url http://10.0.0.50:8787/mcp --api-token "$ARTIFACTY_PERSONAL_TOKEN"
```

Use `0.0.0.0` only if you intend to listen on every network interface:

```bash
artifacty serve --host 0.0.0.0 --share-mode lan --generate-token
```

## Required Safeguards

Before binding to a non-local address, set both `ARTIFACTY_SHARE_MODE=lan|team` and an API token. Artifacty rejects startup without these settings.

The generated token protects HTTP API routes and browser write forms. For scripts, use the `x-artifacty-token` or `Authorization: Bearer <token>` header. Local foreground sessions can use `?token=...` URLs. These URLs can expose tokens in browser history, shell history, reverse-proxy logs, or referrers.

Artifacty does not terminate TLS. Do not expose it directly on the public internet. If a shared instance must cross an untrusted network, put it behind a TLS reverse proxy or a private VPN.

If Artifacty binds outside loopback, startup output warns that other machines can reach the server. The warning also states that Artifacty does not provide TLS. Background `serve` returns the warning in JSON. Foreground `serve` and `src/server.js` also write it to stderr.

## IP ranges and shared links

In **Administration → Access → Network access**, enter one allowed IP address
or CIDR per line. Commas also work. An empty list allows all addresses. Include
the IP address of your current connection. Save the policy, then confirm it
within 120 seconds. If you do not confirm it, Artifacty restores the previous
policy on the first access after the deadline.

**Allow shared links outside these IP ranges** is off by default. Enable it to
let people outside the allowed ranges read an artifact through its valid shared
link. Only the shared page and its raw content are exempt. The dashboard,
search, API, MCP, and ordinary artifact URLs remain restricted. Expired or
revoked links do not grant access. Private mode still requires the separate
setting that permits shared links in private mode. Saving this option uses the
same confirmation and rollback process as the IP ranges.

Artifacty applies the rules to the direct socket peer and ignores forwarded IP
headers. With a reverse proxy, the peer is the proxy. If you need client IP
restrictions, enforce them at the proxy.

## Browser Write Behavior

Remote browsers can read pages allowed by the current access mode and artifact permissions. To submit a browser form, the request origin must match the Artifacty host. For example, `Origin: http://10.0.0.50:8787` matches `Host: 10.0.0.50:8787`. Routes that change data reject cross-origin browser requests to reduce CSRF risk. For scripts and agents, use API or MCP writes with an explicit token header.

Keep the origin check enabled. A write request from the central dashboard should pass when its origin matches the server. A write from another website should fail with `NON_LOCAL_ORIGIN`.

## Renderer Guidance

Treat artifact content as untrusted. Artifacty uses sandboxing and CSP controls to render HTML, SVG, Mermaid, and React. Shared content still reaches each viewer's browser. Keep `ARTIFACTY_ENABLE_REACT_RENDERER` disabled for LAN sessions unless every viewer trusts the artifact source.

See [threat-model.md](threat-model.md) for the full trust-boundary summary.

For a durable internal deployment where many MCP clients share one central
Artifacty instance, see [central-team-deployment-design.md](central-team-deployment-design.md).
