# Security Policy

## Supported Versions

Artifacty is pre-1.0. Security fixes are provided for the latest published
minor release. Upgrade to the latest `artifacty` version before reporting a
suspected issue.

## Reporting a Vulnerability

Use GitHub private vulnerability reporting if it is enabled for this repository.
If private reporting is unavailable, open a GitHub issue with a minimal summary
and avoid including exploit details, secrets, private artifacts, or sensitive
network information.

Please include:

- Artifacty version and install method.
- Node.js version and operating system.
- Whether the HTTP server was localhost-only, LAN/team mode, or behind a proxy.
- Whether `ARTIFACTY_API_TOKEN` and `ARTIFACTY_ENABLE_REACT_RENDERER` were set.
- Reproduction steps using non-sensitive sample content.

## Security Model

Artifacty is local-first. The default HTTP server binds to `127.0.0.1`; binding
outside loopback requires `ARTIFACTY_SHARE_MODE=lan|team` and an API token.

The project treats artifact content as untrusted:

- HTML, SVG, Mermaid, and React rendering use sandboxed frames and scoped CSP.
- React execution is disabled unless `ARTIFACTY_ENABLE_REACT_RENDERER=true`.
- Mutating browser routes reject non-local `Origin` headers.
- API token checks use constant-time digest comparison.
- Artifact content is scanned for common API keys and private keys before
  storage unless explicitly allowed.

Artifacty does not provide TLS termination, remote OAuth, multi-user access
control, or a hosted sync service. Do not expose the server directly to the
public internet.

## Supply Chain

npm releases are published through GitHub Actions using npm Trusted Publishing
OIDC. The release workflow runs lint, tests, and smoke checks on supported Node
versions before publishing.

See [docs/threat-model.md](docs/threat-model.md) and
[docs/network-sharing.md](docs/network-sharing.md) for operational guidance.
