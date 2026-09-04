# Artifact Schema v1

Artifacty schema v1 defines the stable envelope shared by HTTP, CLI, MCP, converters, and SQLite storage.

## Artifact Record

```json
{
  "id": "artifact-id",
  "schemaVersion": 1,
  "artifactType": "document",
  "title": "Readable title",
  "sourceAgent": "codex",
  "publisherId": "user@example.com",
  "publisherName": "User Name",
  "publisherUserId": "user-record-id",
  "visibility": "team",
  "ownerUserId": "user-record-id",
  "reviewStatus": "none",
  "tags": ["handoff"],
  "createdAt": "2026-06-24T00:00:00.000Z",
  "updatedAt": "2026-06-24T00:00:00.000Z",
  "archivedAt": null,
  "latestVersion": 1,
  "versions": []
}
```

Allowed `artifactType` values:

- `document`
- `html-page`
- `handoff`
- `code-review`
- `test-report`
- `dashboard`
- `design-option`
- `diff-walkthrough`
- `bundle`
- `asset`
- `diagram`
- `component`
- `snippet`
- `analysis-report`
- `table`
- `unknown`

Unknown legacy or external types should be mapped to `unknown`, not rejected during conversion. Native create/update rejects unsupported explicit types.

`sourceAgent` identifies the tool or model surface that produced the artifact,
such as `codex` or `claude`. `publisherId` identifies who published it to the
Artifacty store. For authenticated central servers this is the personal token
owner's email; `publisherName` and `publisherUserId` are included when the
server can map the request to a local user record. Legacy artifacts are
best-effort backfilled from the first `create` or `import` audit actor.
Known source-agent aliases are canonicalized before storage. For example,
`claude-code`, `Claude Code`, and `anthropic` become `claude`;
`github-copilot` becomes `copilot`; and `gemini-cli` becomes `gemini`.
Existing `unknown` rows are upgraded only when version metadata, audit data, or
source-agent tags provide one of the known agent identities.

`visibility` is `"private"` or `"team"` (default `"team"`) and `ownerUserId`
identifies the artifact's owner. Once any user account exists, `team`
artifacts are readable and writable by any authenticated principal (writes
can be restricted to the owner or an admin with `ARTIFACTY_TEAM_WRITE=owner`);
`private` artifacts are readable and writable only by their owner or an
admin. Archiving, restoring, and changing visibility or ownership always
require the owner or an admin. In single-user mode (no user accounts) these
checks do not apply. `ownerUserId` defaults to the creating user (from
`publisherUserId`) and is backfilled the same way on migration for older
rows. See the Security Model section of the README for the full rule table.

`reviewStatus` is one of `none` (default), `pending`, `changes-requested`, or
`approved`. It is set explicitly via `POST /api/artifacts/:id/review-status`
(or `artifacty_set_review_status`, or `artifacty review-status`), which
requires the artifact's owner or an admin, and resets to `pending`
automatically — noted in that `update` audit row's metadata as
`reviewStatusReset: { from: "approved", to: "pending" }` — whenever a new
version is appended after an `approved` status.

## Version Record

Normal create and update flows append versions, and each version points at one
content file. Administrator repair/delete actions are exceptional maintenance
operations for correcting accidental or sensitive historical versions; they
write `version-repair` or `version-delete` audit events.

```json
{
  "version": 1,
  "createdAt": "2026-06-24T00:00:00.000Z",
  "format": "markdown",
  "contentType": "text/markdown; charset=utf-8",
  "path": "artifacts/id/v1.md",
  "sizeBytes": 128,
  "sha256": "...",
  "metadata": {}
}
```

Allowed `format` values are `html`, `markdown`, `text`, `json`, `code`, `svg`,
`mermaid`, `react`, `sarif`, `csv`, `image`, `video`, and `notebook`.

Common `artifactType` values include `document`, `handoff`, `code-review`,
`test-report`, `dashboard`, `bundle`, `diagram`, `component`, `snippet`,
`analysis-report`, and `table`.

## Renderer Policy

Storage preserves artifact source as immutable content. Browser rendering is a
viewer concern and must treat all source as untrusted:

- `code`: read-only CodeMirror viewer with escaped source fallback.
- `svg`: scriptless sandboxed iframe after viewer-side sanitization; `/raw`
  preserves the original source.
- `mermaid`: vendored local Mermaid bundle in a sandboxed iframe without
  `allow-same-origin`. Local JavaScript assets use
  `Access-Control-Allow-Origin: null` for `Origin: null` requests so the
  opaque-origin frame can import ESM.
- `react`: source-only by default. `ARTIFACTY_ENABLE_REACT_RENDERER=true`
  enables a separate sandboxed frame with frame-scoped CSP for JSX transform and
  execution.
- `sarif`: bounded findings summary plus a formatted raw JSON details panel.
- `csv`: RFC 4180-style escaped table rendering with bounded rows and columns.
- `image`: base64 media source rendered with `<img>`; `/raw` decodes bytes.
- `video`: base64 media source rendered with `<video controls>`; `/raw` decodes
  bytes.
- `markdown`: fenced code blocks render as server-escaped
  `<pre><code class="language-x">`, upgraded client-side to a read-only
  CodeMirror view using the vendored language packages; the escaped markup
  alone is already correct without JS. ```mermaid``` fences render through
  the same sandboxed Mermaid iframe as whole-document Mermaid artifacts, one
  iframe per diagram created lazily via `IntersectionObserver`, capped per
  document by `ARTIFACTY_MAX_INLINE_DIAGRAMS` (default 20; fences beyond the
  cap stay as escaped source with a notice). Task list items (`- [ ]`/`- [x]`)
  render as disabled checkboxes; tables render inside a horizontally
  scrolling container. Inline HTML in Markdown source is always escaped, not
  interpreted.
- `notebook`: stored content is the original `.ipynb` JSON, parsed only for
  rendering (parse failures fail closed to formatted JSON). Cells render in
  order: Markdown cells through the same Markdown pipeline above, code cells
  as escaped highlighted source with their execution count. Cell outputs are
  limited to `text/plain`, `text/markdown`, `image/png`, `image/jpeg`
  (decoded from base64), `image/svg+xml` (scriptless sandboxed iframe), and
  `text/html` (sandboxed iframe); other MIME types show a placeholder naming
  the type, `stream`/`error` outputs render as escaped text, and any output
  over 2 MB is replaced with a truncated notice. Rendering is bounded to the
  first 500 cells, with a notice when a notebook has more.

## Metadata

Metadata is free-form JSON, but converter-generated metadata uses these keys:

- `artifactyImport`: converter name, original/source agent, file name/path, content type, artifact type, and conversion timestamp.
- `originalPayloadShape`: original payload family, such as `gemini-llmContent`, `content`, or `artifact-bundle`.
- `assetPolicy`: how embedded assets were preserved.
- `bundlePolicy`: how bundled files were preserved.
- `language`: source language for code or component artifacts when supplied by an
  upstream agent.
- `continuation`: structured handoff/review/verification metadata for agent
  outputs, including changed files, commands, tests, blockers, decisions, next
  steps, findings, diff text, and residual risk.
- `<agent>Continuation`: compatibility mirror for structured continuation
  metadata, such as `codexContinuation`, `copilotContinuation`, or
  `cursorContinuation`.

## Relations

Artifacts can carry typed, directional relations to other artifacts, stored in
an `artifact_relations` table (`from_id`, `to_id`, `relation`, `created_at`,
`created_by`, `metadata_json`, unique per `(from_id, to_id, relation)`).

Allowed `relation` values (closed set for v1):

- `derived-from` — `from` was produced by reading `to`
- `supersedes` — `from` replaces `to`
- `reviews` — `from` is a review of `to`
- `references` — loose citation
- `part-of` — `from` belongs to bundle/collection `to`

Inverse names are computed, not stored, and shown on the other artifact:
`derived-from` ↔ `derives`, `supersedes` ↔ `superseded-by`, `reviews` ↔
`reviewed-by`, `references` ↔ `referenced-by`, `part-of` ↔ `contains`.

`createArtifact` and `updateArtifact` accept an optional `relations` array
(`[{ toId, relation }]`) to link an artifact in the same call it is created or
updated. `getArtifact` responses include:

```json
{
  "relations": {
    "outgoing": [
      { "id": "rel-id", "relation": "derived-from", "artifactId": "other-id", "artifact": { "...": "summary" }, "missing": false, "createdAt": "2026-06-24T00:00:00.000Z" }
    ],
    "incoming": []
  }
}
```

`artifact` is a summary of the other side of the link, or `null` with
`missing: true` when the target artifact no longer exists — a dangling
relation is reported, not silently dropped. Self-links (`fromId === toId`) and
relation names outside the closed set are rejected.

`GET /api/artifacts` and `artifacty_list` accept `relatedTo=<id>` (and
optionally `relation=<name>`) to restrict results to artifacts linked, in
either direction, to a given artifact.

## Comments and Review Status

Comments are lightweight, version-anchored notes stored in an
`artifact_comments` table (`id`, `artifact_id`, `version`, `parent_id`,
`author_user_id`, `author_label`, `source_agent`, `body`, `anchor_json`,
`status`, `created_at`, `resolved_at`, `resolved_by`, `deleted_at`).

```json
{
  "id": "comment-id",
  "artifactId": "artifact-id",
  "version": 3,
  "parentId": null,
  "authorUserId": "user-record-id",
  "authorLabel": "User Name",
  "sourceAgent": "mcp",
  "body": "Please add a test for the empty-input case.",
  "anchor": { "line": 42 },
  "status": "open",
  "createdAt": "2026-06-24T00:00:00.000Z",
  "resolvedAt": null,
  "resolvedBy": null,
  "deletedAt": null
}
```

- `version` defaults to the artifact's `latestVersion` when omitted.
- `body` is Markdown, rendered through the same sanitized Markdown pipeline as
  markdown-format artifact content, and capped at 16 KB (`MAX_COMMENT_BYTES`).
- `anchor` is optional and format-specific — `{ "line": 42 }` for text
  formats, `{ "path": "$.runs[0].results[3]" }` for JSON/SARIF, `{ "row": 7 }`
  for CSV — and is a rendering hint only, not validated against the
  artifact's actual content.
- Threads are one level deep: `parentId`, when set, must point to a comment
  that itself has no `parentId` (a root comment); replying to a reply is
  rejected with `code: "THREAD_TOO_DEEP"`.
- `status` is `"open"` or `"resolved"`, set via the resolve action
  (`resolvedAt`/`resolvedBy` are then populated).
- Deleting a comment is a soft delete: `deletedAt` is set and the row is
  hidden from `listComments`/`GET .../comments` by default (pass
  `includeDeleted: true` to see it), but the comment row and its
  `comment-delete` audit-log entry are both kept.
- Comments on a `private` artifact are readable and writable under the same
  owner/admin rules as the artifact itself (see Visibility above).
- `author_label` is derived from the caller's audit context (the
  authenticated user's display name/email, falling back to the publisher id,
  the `sourceAgent`, or `"anonymous"`).

`GET`/`POST /api/artifacts/:id/comments`,
`POST /api/artifacts/:id/comments/:commentId/resolve`, and
`DELETE /api/artifacts/:id/comments/:commentId` manage comments over HTTP.
`artifacty_comment` and `artifacty_resolve_comment` are the MCP equivalents;
the MCP `artifacty_get` tool additionally accepts `includeComments: true` to
return the requested version's open comments alongside the artifact (there is
no HTTP equivalent flag — fetch `GET /api/artifacts/:id/comments` separately).

## Archive Semantics

Artifacts are not deleted by P0 behavior. Archive sets `archivedAt` and hides the artifact from default list results. `includeArchived=true` includes archived records. Restore clears `archivedAt`. Regular archive/restore leaves versions and content files unchanged. Administrators may repair or delete individual versions from `/admin/artifacts/:id/versions`; the last remaining version cannot be deleted.

## Bundle Format

Bundles are JSON artifacts with `artifactType: "bundle"` and content type `application/vnd.artifacty.bundle+json; charset=utf-8`.

```json
{
  "schemaVersion": 1,
  "artifactType": "bundle",
  "title": "Patch bundle",
  "files": [
    {
      "path": "README.md",
      "content": "# Readme",
      "contentType": "text/markdown; charset=utf-8",
      "sizeBytes": 8,
      "sha256": "..."
    }
  ]
}
```

Gemini multimodal payloads use the same bundle type with `parts` and `assets`.

### Document Assets

A `files` entry may carry binary document content instead of inline text by
setting `encoding: "base64"` and a `contentType` from the allowed binary
types: `application/pdf`,
`application/vnd.openxmlformats-officedocument.wordprocessingml.document`
(`.docx`), `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
(`.xlsx`), and `application/zip`. `content` holds the base64-encoded bytes;
`sizeBytes` and `sha256` describe the *decoded* bytes.

```json
{
  "path": "report.pdf",
  "contentType": "application/pdf",
  "encoding": "base64",
  "content": "JVBERi0xLjQ...",
  "sizeBytes": 20480,
  "sha256": "..."
}
```

Rules enforced on every write (`createArtifact`/`updateArtifact` and
conversion via `convertAgentArtifact`):

- Each binary file entry is capped at 32 MB decoded; the bundle artifact as a
  whole still has to fit under the general `MAX_ARTIFACT_BYTES` limit
  (16 MB by default for text bundles; a bundle with document assets can
  legitimately exceed that only if `MAX_ARTIFACT_BYTES` is raised, since the
  base64 text itself counts toward the artifact size).
- `path` (or `name`) must be a safe relative path: no `..` segments, no
  absolute or drive-letter paths, no control characters.
- An unlisted `contentType` on a binary entry is rejected.
- Secret scanning is skipped for binary file content (and for binary asset
  `data`), since it is not text, but file/asset names and any non-binary
  `files`/`assets` text content are still scanned.

The viewer renders PDF entries in a sandboxed iframe (no `allow-same-origin`,
no scripts) pointing at `GET /artifacts/:id/raw?file=<path>`; other document
types show metadata and a download link to the same route. That route
responds with the entry's `contentType`, `X-Content-Type-Options: nosniff`,
`Cache-Control: private`, and `Content-Disposition: inline` for PDFs or
`attachment` otherwise. It honors the same `access` rules as other artifact
reads (private-artifact non-owners get 404), and returns 404 for an unknown
`file` name.

## Asset Policy

Base64 assets are preserved inline inside bundle JSON with `encoding: "base64"`, `mimeType`, `sizeBytes`, and `sha256`. Consumers must treat decoded assets as untrusted.

First-class `image` and `video` artifacts store base64 content in the immutable
version file. Importers should set `metadata.encoding: "base64"` and
`metadata.mimeType` to one of the supported media types. Browser `/raw` decodes
the stored base64 into bytes with the media content type, while API and MCP reads
return the stored base64 string. Supported media types are PNG, JPEG, GIF, WebP,
MP4, and WebM. Large binary externalization is intentionally deferred; schema v1
keeps converted assets inspectable and portable.
