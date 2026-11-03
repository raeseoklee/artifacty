# Remote connection profiles

English | [한국어](ko/newremote-connections.md)

Remote connection profiles are available from Artifacty 0.18.1. A profile gives an MCP server a stable local name. Clients that follow the active profile can change servers without editing each client's MCP configuration again.

Use a stable DNS name for the server when possible. Changing its DNS or reverse-proxy destination can avoid a client configuration change entirely. Profiles help when the actual public URL must change.

## Connect clients through a profile

The destination must expose Artifacty's HTTP MCP endpoint. Enable HTTP MCP on that server and obtain a token for that server if authentication is required.

```sh
artifacty remote add company https://artifacty.example.com
artifacty remote use company
artifacty remote check
artifacty install all --remote active
```

`add` saves the server's base URL. `use` selects the active profile. `check` verifies MCP initialization and tool discovery; it does not create an artifact. `install` registers the local stdio bridge with supported clients. Restart or reconnect those clients after the initial installation.

If the server requires authentication, set its token when adding the profile:

```sh
artifacty remote add company https://artifacty.example.com --api-token YOUR_SERVER_TOKEN
artifacty remote check company
```

`YOUR_SERVER_TOKEN` is a placeholder. Avoid putting a real token in shell history or shared command logs. Profile output does not reveal the stored token.

Use `artifacty remote list` to inspect saved profile names and the active choice. `artifacty remote check company` checks a named profile without selecting it.

## Change the selected server

```sh
artifacty remote add backup https://backup.example.com
artifacty remote check backup
artifacty remote use backup
```

A bridge installed with `--remote active` resolves the selected profile for each request. New requests follow the selected server; this is not a transfer of server-side sessions, pending operations, artifacts, users, or permissions. Reconnect a client if it retains state from the previous server.

`artifacty install codex --remote company` pins that client to the named profile. It follows changes to `company`, but `remote use backup` does not change its selected profile. Use `--remote active` when clients should follow `remote use`.

Changing an existing HTTPS profile or migrating an HTTPS connection to HTTP requires `--allow-insecure-downgrade`. Prefer HTTPS for non-local servers.

Updating an existing profile's URL clears its stored token. Supply a token issued for the new destination before checking or using authenticated tools. Artifacty does not forward the previous destination's token automatically and does not follow HTTP redirects during the connection check.

## Migrate existing client settings

First preview which Artifacty entries match the old URL:

```sh
artifacty remote migrate http://192.0.2.10:8787 \
  --to https://artifacty.example.com --dry-run
```

The address above is documentation-only example data. Replace it with the old server's URL.

Apply the migration after reviewing the preview:

```sh
artifacty remote migrate http://192.0.2.10:8787 \
  --to https://artifacty.example.com
```

By default, migration checks the current project’s `.mcp.json`, `.gemini/settings.json`, `.vscode/mcp.json`, and `.cursor/mcp.json`, plus `~/.codex/config.toml`. Use `--project-dir` to select another project or `--agent` to select one client. Missing default files are skipped.

The migration only changes matching Artifacty entries in supported client configuration files. It preserves unrelated servers and settings, creates a private backup of each changed file, and checks the new connection before applying changes. Credentials and native HTTP headers from the old Artifacty connection are removed rather than sent to the new server. Reapply any required destination-specific headers after migration. If authentication is required, use a token issued for the new destination with `--api-token`.

To target a specific configuration file, use both options:

```sh
artifacty remote migrate http://192.0.2.10:8787 \
  --to https://artifacty.example.com \
  --agent codex --config /path/to/config.toml --dry-run
```

Supported agents are `claude`, `codex`, `gemini`, `copilot`, and `cursor`. Configuration files with unsupported syntax are rejected without rewriting them. In particular, a JSON file containing comments is not treated as ordinary JSON. Review the reported result and reconnect the affected clients after applying changes. Native HTTP client connections still need that reconnect; they do not use the dynamic local profile bridge.

A settings migration does not move the server's data. Back up and transfer the actual Artifacty store separately, and verify access at the destination before retiring the old server.

## Configuration and credentials

`ARTIFACTY_REMOTE` selects a named profile; `active` follows `remote use`. Profiles live under `ARTIFACTY_CONFIG_HOME`, which defaults to `~/.config/artifacty`. The profile file is private to the local account; its tokens are stored locally and are not encrypted. Protect the directory and its backups. Use a separate configuration home for isolated tests or separate local identities.

Tokens belong to one profile and destination. An unrelated `ARTIFACTY_API_TOKEN` is not implicitly attached to a profile connection. Keep a backup of the old client configuration until the new connection has been verified. Do not commit profiles, configuration backups, or tokens to a repository.
