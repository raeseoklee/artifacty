# MCP Public API

Artifacty's MCP stdio server is the primary agent-to-agent integration surface.
The server currently targets MCP protocol `2025-06-18`.

## Capabilities

`initialize` advertises:

- `tools`: Artifact create, import, list, get, update, archive, restore, audit, and info.
- `resources`: static and dynamic read-only artifact resources.
- `prompts`: reusable workflow prompt templates.

## Tools

Stable tool names:

- `artifacty_create`: create a native Artifacty artifact.
- `artifacty_publish`: backwards-compatible alias for `artifacty_create`.
- `artifacty_import`: convert external Claude, Codex, Gemini, Copilot, Cursor, Artifacty, or generic payloads.
- `artifacty_list`: list artifacts with `query`, `tag`, `sourceAgent`, `includeArchived`, `limit`, and `offset`.
- `artifacty_get`: read one artifact by `id` and optional `version`.
- `artifacty_update`: append an immutable version.
- `artifacty_archive` / `artifacty_restore`: toggle archive state.
- `artifacty_audit`: list audit events.
- `artifacty_info`: return local store and browser URL information.

Tool schemas use Artifacty schema v1 formats and artifact types. New optional
properties may be added during 0.x releases; existing names should not be
renamed without a documented migration.

## Resources

Static resources:

- `artifacty://recent`: JSON list of recent artifacts with pagination and browser URLs.
- `artifacty://schema/v1`: Markdown reference for Artifacty schema v1.

Resource templates:

- `artifacty://artifacts/{id}`: JSON artifact metadata, selected version, content, and URLs.
- `artifacty://artifacts/{id}/raw{?version}`: raw artifact content for latest or specified version.

Resources are read-only and may record an audit `read` event for artifact content.

## Prompts

Prompt names:

- `artifacty_handoff`
- `artifacty_review`
- `artifacty_test_report`
- `artifacty_visual_qa`
- `artifacty_release_notes`

Each prompt returns one user message that instructs an agent to create or update
an Artifacty artifact with discoverable `artifactType`, `sourceAgent`, and tags.
Prompts accept optional context arguments such as `artifactId`, `goal`, `scope`,
`target`, or `version`.

## Compatibility Notes

- The MCP server is local stdio only. Remote MCP auth/OAuth is out of scope.
- Binary media resources return stored base64 text through MCP; browser `/raw`
  decodes first-class `image` and `video` artifacts into bytes.
- Clients may display resources and prompts differently. Tools remain the most
  widely supported integration path across Claude, Codex, Gemini, Copilot, and
  Cursor.
