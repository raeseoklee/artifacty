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
- `unknown`

Unknown legacy or external types should be mapped to `unknown`, not rejected during conversion. Native create/update rejects unsupported explicit types.

## Version Record

Each version is immutable and points at one content file.

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
`mermaid`, and `react`.

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

## Metadata

Metadata is free-form JSON, but converter-generated metadata uses these keys:

- `artifactyImport`: converter name, original/source agent, file name/path, content type, artifact type, and conversion timestamp.
- `originalPayloadShape`: original payload family, such as `gemini-llmContent`, `content`, or `artifact-bundle`.
- `assetPolicy`: how embedded assets were preserved.
- `bundlePolicy`: how bundled files were preserved.
- `language`: source language for code or component artifacts when supplied by an
  upstream agent.
- `codexContinuation`: structured Codex handoff metadata such as changed files,
  commands, tests, blockers, decisions, next steps, findings, diff text, and
  residual risk.

## Archive Semantics

Artifacts are not deleted by P0 behavior. Archive sets `archivedAt` and hides the artifact from default list results. `includeArchived=true` includes archived records. Restore clears `archivedAt`. Versions and content files remain unchanged.

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

## Asset Policy

Base64 assets are preserved inline inside bundle JSON with `encoding: "base64"`, `mimeType`, `sizeBytes`, and `sha256`. Consumers must treat decoded assets as untrusted. Large binary asset externalization is intentionally deferred; schema v1 keeps all converted assets inspectable and portable.
