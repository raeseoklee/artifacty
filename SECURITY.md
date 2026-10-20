# Security Policy

English | [한국어](SECURITY.ko.md)

## Supported Versions

Artifacty is pre-1.0. The project provides security fixes for the latest
published minor release. Upgrade to the latest `artifacty` version before reporting a
suspected issue.

## Reporting a Vulnerability

Use GitHub private vulnerability reporting if it is enabled for this repository.
If private reporting is unavailable, open a GitHub issue with a brief summary.
Do not include exploit details, secrets, private artifacts, or sensitive
network information.

Include the following information:

- Artifacty version and install method.
- Node.js version and operating system.
- Whether the HTTP server was localhost-only, LAN/team mode, or behind a proxy.
- Whether `ARTIFACTY_API_TOKEN` and `ARTIFACTY_ENABLE_REACT_RENDERER` were set.
- Reproduction steps using non-sensitive sample content.

## Security Model

Artifacty is local-first. The HTTP server binds to `127.0.0.1` by default.
To bind outside loopback, set `ARTIFACTY_SHARE_MODE=lan|team` and an API token.

Artifacty treats artifact content as untrusted:

- HTML, SVG, Mermaid, and React render in sandboxed frames. Each frame uses
  a scoped Content Security Policy (CSP).
- React execution is disabled unless `ARTIFACTY_ENABLE_REACT_RENDERER=true`.
- Mutating browser routes reject cross-origin writes. They allow loopback and
  same-origin requests.
- API token checks use constant-time digest comparison.
- Before storage, Artifacty scans content for common API keys and private keys.
  The caller can explicitly allow content that contains these keys.

Administrators can select public or private site access. Private mode requires
a personal account and limits artifact access to owners, administrators, and
users with direct or team grants. A grant permits reading, commenting, or editing.
Token scopes further restrict API and MCP actions.

Administrators can also restrict HTTP access by IP address or CIDR range.
Artifacty checks the TCP peer address and does not trust forwarding headers.
In private mode, an administrator must explicitly enable public share links.

Artifacty does not provide TLS termination, remote OAuth, or a hosted sync
service. Do not expose the server directly to the public internet.

## Supply Chain

GitHub Actions publishes npm releases through npm Trusted Publishing OIDC.
Before publication, the release workflow runs lint, tests, and smoke checks on
supported Node versions.

See [docs/threat-model.md](docs/threat-model.md) and
[docs/network-sharing.md](docs/network-sharing.md) for operational guidance.
