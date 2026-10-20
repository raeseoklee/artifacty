# Artifact Schema v1

English | [한국어](ko/artifact-schema-v1.md)

Artifacty schema v1 defines the stable record structure for HTTP, CLI, MCP,
converters, and SQLite storage.

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

Converters should map unknown legacy or external types to `unknown`. They should
not reject those types. Native create and update operations reject unsupported
explicit types.

`sourceAgent` identifies the tool or model surface that produced the artifact,
such as `codex` or `claude`. `publisherId` identifies who published it to the
Artifacty store. On an authenticated central server, this is the personal token
owner's email. If the server maps the request to a local user record, it also
includes `publisherName` and `publisherUserId`. For legacy artifacts, the server
tries to fill these fields from the first `create` or `import` audit actor.
Known source-agent aliases are canonicalized before storage. For example,
`claude-code`, `Claude Code`, and `anthropic` become `claude`;
`github-copilot` becomes `copilot`; and `gemini-cli` becomes `gemini`.
Existing `unknown` rows are upgraded only when version metadata, audit data, or
source-agent tags provide one of the known agent identities.

`visibility` is `"private"`, `"team"`, or `"public"` (default `"team"`).
`ownerUserId` identifies the owner. In public site mode with user accounts,
anyone can read `public` artifacts, but only the owner or an administrator can
write them. Authenticated users can read and write `team` artifacts. Set
`ARTIFACTY_TEAM_WRITE=owner` to restrict team writes to the owner or an
administrator. Through normal artifact routes, `private` artifacts require
the owner or an administrator. API authentication requirements still apply.

Private site mode requires a personal identity, even for artifacts whose
visibility is public. Owners and administrators retain access. Other users need a direct or team grant with read, comment, or edit
permission. Artifacty applies the strongest matching grant. Archiving, restoring,
sharing, and changes to visibility or ownership require the owner or an
administrator in both modes. Token scopes can further restrict access.

Owner-created share links provide a separate read-only access path. In private
site mode, these links require administrator opt-in. See
[Public share links](threat-model.md#public-share-links-and-network-restrictions) for their expiry and revocation rules.

In public mode with no user accounts, user access checks do not apply.
`ownerUserId` defaults to the creating user, from `publisherUserId`. Migration
uses the same rule to fill this field in older records. See the README Security
Model section for the full rule table.

`reviewStatus` is one of `none` (default), `pending`, `changes-requested`, or
`approved`. The owner or an administrator can set it through
`POST /api/artifacts/:id/review-status`, `artifacty_set_review_status`, or
`artifacty review-status`.

If a new version follows an `approved` version, Artifacty resets the status to
`pending`. The `update` audit row records
`reviewStatusReset: { from: "approved", to: "pending" }` in its metadata.

## Version Record

Normal create and update operations append versions. Each version points to one
content file. Administrators can repair or delete historical versions to correct
accidental or sensitive content. These exceptional maintenance operations write
`version-repair` or `version-delete` audit events.

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

Storage preserves artifact source as immutable content. The browser viewer must
treat all source as untrusted:

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
  CodeMirror view using the vendored language packages. The escaped markup
  displays correctly even without JavaScript. ```mermaid``` fences render through
  the same sandboxed Mermaid iframe as whole-document Mermaid artifacts, with one
  iframe per diagram. Frames are created when needed through
  `IntersectionObserver`. The number per document is capped by `ARTIFACTY_MAX_INLINE_DIAGRAMS` (default 20; fences beyond the
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
  `text/html` (sandboxed iframe); other MIME types show a placeholder that names
  the type. `stream`/`error` outputs render as escaped text. Any output
  over 2 MB is replaced with a truncation notice. Rendering is bounded to the
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

Artifacts can have typed, directional relations to other artifacts. Relations
are stored in an `artifact_relations` table (`from_id`, `to_id`, `relation`, `created_at`,
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

`artifact` contains a summary of the linked artifact. If the target no longer
exists, `artifact` is `null` and `missing` is `true`. The response keeps the
dangling relation. Artifacty rejects self-links (`fromId === toId`) and relation
names outside the closed set.

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
- `body` is Markdown with a 16 KB limit (`MAX_COMMENT_BYTES`). The viewer uses
  the same sanitized Markdown renderer as markdown-format artifacts.
- `anchor` is optional and format-specific: `{ "line": 42 }` for text
  formats, `{ "path": "$.runs[0].results[3]" }` for JSON/SARIF, `{ "row": 7 }`
  for CSV. It is only a rendering hint. Artifacty does not validate it against
  the artifact's actual content.
- Threads are one level deep. If supplied, `parentId` must identify a root
  comment, which has no `parentId`. A reply to another reply returns
  `code: "THREAD_TOO_DEEP"`.
- `status` is `"open"` or `"resolved"`, set via the resolve action
  (`resolvedAt`/`resolvedBy` are then populated).
- Comment deletion is a soft delete. Artifacty sets `deletedAt` and hides the
  row from `listComments` and `GET .../comments` by default. Pass
  `includeDeleted: true` to include it. Artifacty keeps the comment row and its
  `comment-delete` audit entry.
- Comment reads require access to the artifact. In private site mode, new
  comments require comment or edit permission, or the owner or administrator
  role. Comment grants allow users to resolve their own comments.
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

Archive sets `archivedAt` and hides the artifact from default list results.
Use `includeArchived=true` to include archived records. Restore clears
`archivedAt`. Normal archive and restore operations do not delete artifacts or
change version files. Administrators may repair or delete individual versions
from `/admin/artifacts/:id/versions`. They cannot delete the last version.

## Bundle Format

Bundles are JSON artifacts with `artifactType: "bundle"`. Their content type is
`application/vnd.artifacty.bundle+json; charset=utf-8`.

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
  whole must still fit under the general `MAX_ARTIFACT_BYTES` limit
  (16 MB by default for text bundles; a bundle with document assets can
  exceed that limit only if `MAX_ARTIFACT_BYTES` is raised, since the
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
`Cache-Control: no-store`, and `Content-Disposition: inline` for PDFs or
`attachment` otherwise. It applies the same `access` rules as other artifact
reads. It returns 404 when the caller cannot read the artifact or the `file`
name is unknown.

## Asset Policy

Bundle JSON preserves base64 assets inline. Each asset has `encoding: "base64"`,
`mimeType`, `sizeBytes`, and `sha256`. Consumers must treat decoded assets as
untrusted.

First-class `image` and `video` artifacts store base64 content in the immutable
version file. Importers should set `metadata.encoding: "base64"` and
`metadata.mimeType` to one of the supported media types. Browser `/raw` decodes
the stored base64 into bytes with the media content type, while API and MCP reads
return the stored base64 string. Supported media types are PNG, JPEG, GIF, WebP,
MP4, and WebM. Large binary externalization is intentionally deferred; schema v1
keeps converted assets inspectable and portable.
