# Supporting Claude Formats and Codex Continuation Artifacts

Status: Implemented. Phases 0-6 are complete; v10 records the Mermaid CORS hotfix and browser smoke evidence.

This document records how Artifacty ingests, stores, and renders Claude artifact
formats, plus the Codex continuation artifacts implemented alongside that work,
while preserving the project's invariants:
the shared-library funnel, append-only immutable versions, local-only assets, and
the "treat artifact content as untrusted" security model.

## Goal

A Claude artifact of any kind can be imported into Artifacty (via MCP
`artifacty_import`, the CLI `import`, or `POST /api/import`), stored faithfully,
listed/searched, and rendered in the browser viewer with local-only assets and
without weakening the sandbox around untrusted content. Codex continuation
artifacts can also be imported conservatively as handoffs, bundles, reviews,
diff walkthroughs, and verification reports.

## Background: Claude artifact types

Claude emits a small, fixed set of artifact types. Each carries a `type`
identifier (MIME-like), and code artifacts additionally carry a `language`.

| Claude type        | Identifier                       | Extra fields | What it is |
|--------------------|----------------------------------|--------------|------------|
| Markdown / document| `text/markdown`                  | —            | Formatted prose |
| Code               | `application/vnd.ant.code`       | `language`   | Syntax-highlighted source, not executed |
| HTML page          | `text/html`                      | —            | Single-file web page, rendered (inline CSS/JS) |
| SVG image          | `image/svg+xml`                  | —            | Vector graphic |
| Mermaid diagram    | `application/vnd.ant.mermaid`    | —            | Diagram described in Mermaid source |
| React component    | `application/vnd.ant.react`      | —            | Interactive JSX component |

> These identifiers are an external product detail. Verify them against current
> Claude documentation before implementing the converter mapping; treat the table
> as the intended mapping, not a frozen contract.

Two import shapes matter:

1. **Structured payload** (preferred) — the caller passes the artifact `type`,
   `language`, and raw source. This is lossless and is the path MCP/CLI callers
   should use.
2. **Browser-saved HTML** — "Save page as…" wraps the artifact in claude.ai chrome
   and an inner `frame.claudeusercontent.com` iframe (see how the existing imported
   artifacts were produced). The original `type` is **lost** here; only HTML/SVG
   survive as raw markup. Detection must fall back to content sniffing.

## Codex artifact categories

Codex does not currently map cleanly to a small fixed MIME-like artifact taxonomy
in the same way Claude artifacts do. For Artifacty, treat Codex output as
workflow artifacts produced while changing a repository: source files, diffs,
handoff notes, reviews, verification evidence, and local previews. The
`sourceAgent` should be `codex`, while `artifactType` describes the job the
artifact performs for the next agent.

| Codex output | Recommended Artifacty type | Format | What to preserve |
|--------------|----------------------------|--------|------------------|
| Source or file bundle | `bundle` | `json` | Paths, file contents, content types, hashes, and optional patch metadata |
| Patch / diff walkthrough | `diff-walkthrough` | `markdown` or `text` | Git diff, changed-file list, rationale, and migration notes |
| Handoff note | `handoff` | `markdown` | Goal, current state, changed files, decisions, blockers, and next steps |
| Code review result | `code-review` | `markdown` | Findings ordered by severity, file/line references, open questions, and test gaps |
| Test / verification report | `test-report` | `markdown`, `text`, or `json` | Commands run, pass/fail status, key output, environment, and residual risk |
| Plan / design document | `document` or `design-option` | `markdown` | Architecture options, sequencing, tradeoffs, and acceptance criteria |
| HTML/dashboard preview | `html-page` or `dashboard` | `html` | Self-contained local preview rendered in the existing sandboxed iframe |
| Logs / terminal transcript | `document` | `text` | Relevant command output, stack traces, and reproduction notes |

Codex continuation artifacts mostly map to existing Markdown, JSON, text, and HTML renderers. They do not require a separate renderer runtime unless the payload itself contains source that should use the `code`, `svg`, `mermaid`, or `react` formats.

The highest-value Codex support should prioritize **`handoff`**, **`bundle`**,
**`diff-walkthrough`**, **`code-review`**, and **`test-report`**. Together these
cover the common agent-to-agent continuation path: what changed, why it changed,
how to verify it, and what another agent should do next.

Practical import shapes for Codex:

1. **Direct Artifacty publish** — Codex calls MCP/CLI with `sourceAgent: "codex"`,
   explicit `artifactType`, and Markdown/JSON content.
2. **File bundle import** — Codex uses or extends Artifacty's existing
   `files[]`/`bundle` conversion path by packaging generated or modified files;
   Artifacty stores them as a portable `bundle` JSON artifact.
3. **Handoff JSON** — Codex exports a structured object containing `title`,
   `content` or `markdown`, `artifactType: "handoff"`, `tags`, and optional
   verification metadata.
4. **Patch-oriented handoff** — Codex includes a unified diff plus a prose summary;
   Artifacty stores it as `diff-walkthrough` unless full files are included, in
   which case use `bundle`.

Codex-specific conversion should remain conservative: do not infer that every
Markdown note is a handoff, every diff is safe to apply, or every HTML preview is
trusted. Preserve the source faithfully, add provenance under
`metadata.artifactyImport`, and let the viewer continue treating the content as
untrusted.

## Starting Artifacty model (before Phase 0)

- **Formats** are normalized to one of four values in `src/lib/storage.js`
  (`FORMAT_TO_EXTENSION`, `FORMAT_TO_CONTENT_TYPE`, `normalizeFormat`):
  `html | markdown | text | json`. `md` aliases to `markdown`. Max 16 MiB.
- **`artifactType`** is a *separate*, descriptive taxonomy (not a renderer):
  `document, html-page, handoff, code-review, test-report, dashboard,
  design-option, diff-walkthrough, bundle, asset, unknown`.
- **Rendering** lives in `src/lib/render.js` `renderContent(format, content)`:
  - `html` → sandboxed `<iframe srcdoc>` with `sandbox="allow-scripts allow-forms
    allow-popups"` (no `allow-same-origin`) plus a height-reporter that lets the
    parent auto-size the frame (`htmlFrameContent` + `frameResizeScript`).
  - `markdown` → in-house `markdownToHtml` into `.artifact-doc`.
  - `json` / `text` → escaped `<pre><code>`.
- **Detection** lives in `src/lib/converters.js` `detectFormat(...)` (content-type,
  extension, then content sniffing) and `normalizeArtifactType(...)`.
- **Client assets are vendored locally**, never from a CDN: the `/vendor/npm/<pkg>`
  route in `src/server.js` serves ESM from `node_modules` for an allowlist in
  `src/lib/editor-assets.js` (`EDITOR_VENDOR_PACKAGES`), wired through an importmap.
  The editor already vendors the CodeMirror 6 family this way.
- **CSP** (`sendHtml` in `src/server.js`) is local-only:
  `default-src 'self' data: blob:; frame-src 'self' data: blob:;
  img-src 'self' data: blob:; style-src 'self' 'unsafe-inline';
  script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none';
  form-action 'self'`. A `srcdoc` iframe **inherits this CSP**, so artifact code may
  only use inline + same-origin (`/vendor/npm/*`) resources — never a CDN.

## Gap analysis (before Phase 0)

| Claude type | Today | Target |
|-------------|-------|--------|
| Markdown    | Supported (`markdown`) | Keep; optionally upgrade the renderer (tables, fenced-lang) |
| HTML        | Supported (`html`, sandboxed iframe + auto-resize) | Keep as-is |
| Code        | Falls back to `text` (no language, no highlight) | New `code` format with `language` metadata + read-only highlight (reuse vendored CodeMirror) |
| SVG         | Sniffs to `text` (shown as source) | New `svg` format, rendered as an image in a **scriptless** sandbox |
| Mermaid     | `text` (source only) | New `mermaid` format, rendered to SVG by a vendored Mermaid runtime in a sandboxed iframe |
| React       | `text` (source only) | New `react` format, compiled + run in a sandboxed iframe with vendored React/ReactDOM + a JSX transform |

By v10, Phases 0-6 close the listed storage, conversion, and viewer gaps. React execution remains opt-in by design.

## Design

### 1. Format taxonomy

Extend the normalized format set from 4 to the renderer-relevant set. Each new
format is a change in `storage.js` **plus** every surface and a regression test —
this is the shared-library funnel from `CLAUDE.md`, applied per format:

- `storage.js`: add to `FORMAT_TO_EXTENSION`, `FORMAT_TO_CONTENT_TYPE`,
  `normalizeFormat` (and any alias, e.g. `jsx → react`, `svg+xml → svg`).
- `converters.js`: map Claude identifiers and sniff fallbacks in `detectFormat`.
- `render.js`: a `renderContent` branch per format.
- MCP (`mcp-server.js`): extend the `format` enum on the relevant tool schemas.
- CLI (`cli.js`): no enum to change, but document the new `--format` values.
- Browser editor (`render.js` `formatSelect`, `editor-assets.js` language modes):
  add the option and a CodeMirror language mode where one exists.
- Badges (`render.js`): add `.badge.f-svg/.f-mermaid/.f-react/.f-code` colors.

Proposed new formats: **`code`, `svg`, `mermaid`, `react`**. Keep `language`
(for `code`) in the version record `metadata`, not as a new column.

Alternative considered: keep 4 formats and push the renderer choice into
`artifactType` + `metadata.renderer`. Rejected — `format` is already the field that
selects a renderer in `renderContent`, and the MCP/CLI/editor all key off it.
Splitting renderer selection across two fields would blur that contract.

### 2. Detection / conversion (`converters.js`)

Priority order in `convertAgentArtifact` → `detectFormat`:

1. Explicit `format` argument (caller override) wins.
2. Structured payload `type`/`mimeType` → map identifier to format:
   - `text/markdown` → `markdown`
   - `text/html` → `html`
   - `image/svg+xml` → `svg`
   - `application/vnd.ant.code` → `code` (carry `language` into metadata)
   - `application/vnd.ant.mermaid` → `mermaid`
   - `application/vnd.ant.react` → `react`
3. Filename extension (`.svg`, `.jsx`/`.tsx`, `.mmd`).
4. Content sniffing fallback (for browser-saved/raw input):
   - starts with `<svg` or `<?xml … <svg` → `svg`
   - first non-comment line matches a Mermaid graph keyword
     (`graph`, `flowchart`, `sequenceDiagram`, `classDiagram`, `stateDiagram`,
     `erDiagram`, `gantt`, `pie`, `mindmap`, `journey`) → `mermaid`
   - contains JSX/`export default`/`import React` signals → `react`
   - existing html/markdown/json/text rules otherwise.

Record provenance under `metadata.artifactyImport` as today (originalAgent, the
Claude `type`, `language`), so the mapping is auditable.

### 3. Rendering pipeline (`render.js renderContent`)

Source of truth is always the **artifact source** (jsx/mermaid/svg/code text).
Rendering is derived at view time — never store compiled output. `/raw` keeps
returning the original bytes; immutable version files stay faithful.

Per-format rendering, all inside the existing sandboxed-iframe pattern so the
height auto-resizes and untrusted code stays contained:

- **`code`** → render read-only highlighted source. Reuse the vendored CodeMirror
  language modes (`@codemirror/lang-*`) in a read-only EditorView, or a lighter
  static highlighter. No iframe needed (it is inert text); escape as today but with
  token spans. Show the `language` label in the meta strip.
- **`svg`** → embed the SVG in a sandboxed iframe **without** `allow-scripts`
  (SVG can carry `<script>`/`on*` handlers). Optionally also strip script nodes and
  event-handler attributes server-side as defense-in-depth. Center it, fit width.
- **`mermaid`** → a sandboxed iframe (`allow-scripts`, no `allow-same-origin`) whose
  `srcdoc` contains: an importmap to the vendored Mermaid module, an inline boot
  script that calls `mermaid.render(source)`, and the height reporter. The Mermaid
  source is injected as a data island, not interpolated into script.
- **`react`** → a sandboxed iframe (`allow-scripts`, no `allow-same-origin`) that
  imports vendored React + ReactDOM and a JSX transform, compiles the component
  source at runtime, and mounts it. Same height reporter. This is the most
  security-sensitive and heaviest path (see Security).

The parent listener (`frameResizeScript`) and reporter injection already exist for
HTML and are reused unchanged for the SVG/Mermaid/React iframes.

### 4. Vendored client assets (`editor-assets.js`)

New runtimes are added to the same allowlist-and-route mechanism that serves
CodeMirror, so everything stays same-origin and CSP-clean:

- Mermaid: `mermaid` (note: this is a **large** ESM bundle).
- React: `react`, `react-dom`, plus a JSX transform. Prefer a small standalone JSX
  transformer over full Babel if feasible; Babel-standalone is large.
- Add each to `EDITOR_VENDOR_PACKAGES` (or a parallel `RENDER_VENDOR_PACKAGES`) and,
  if their entry point differs, to `EDITOR_VENDOR_ENTRY_OVERRIDES`.

These become real `dependencies` in `package.json`. That is a deliberate departure
from the original "zero runtime dependencies" stance, which CodeMirror already
began; the doc's phasing keeps the heavy additions opt-in.

### 5. Storage & schema

- No new columns. `language` and any render hint go in the version
  `metadata` JSON. `format` gains the new enum values.
- `artifactType` mapping suggestions: `mermaid`/`svg` → `asset` or a new
  `diagram`; `react` → `design-option` or a new `component`; `code` → `code-review`
  is wrong semantically, prefer a new `snippet`/`code` artifactType. Decide as part
  of the taxonomy review (Open Questions).

## Security considerations

The viewer renders **untrusted** content. The non-negotiables:

- Keep CSP local-only. Vendored libs are served from `/vendor/npm/*` (same origin);
  no CDN, no `unsafe-eval` unless a renderer strictly requires it (a JSX transform
  may — scope it to the artifact iframe via a per-iframe CSP, not the whole app).
- Keep `allow-same-origin` **off** for any scripted artifact iframe (Mermaid,
  React, HTML). Without it the iframe is an opaque origin and cannot touch the
  store, cookies, or `server.json`; cross-frame messaging stays `postMessage`-only
  and the parent validates `event.source` (already done).
- SVG renders **scriptless**; additionally sanitize `<script>` and `on*` attributes
  server-side.
- React/JSX runs arbitrary author code. If a runtime needs `eval`/`new Function`,
  confine it with a dedicated, tighter CSP applied to that iframe's `srcdoc`, and
  document the residual risk. Consider gating `react` rendering behind an explicit
  opt-in (config flag) given the blast radius.
- Enforce `MAX_ARTIFACT_BYTES` and the existing secret-scan before persisting, for
  all new formats.

## Phased plan

The implementation should move from durable contracts to progressively riskier
renderers. Each phase must be independently shippable, include regression tests,
and preserve the invariant that artifact source is stored faithfully while rendered
output is derived at view time.

### Phase 0 — Contract lock and fixtures

**Goal:** freeze the target behavior before adding new renderers.

- Confirm Claude artifact identifiers and the exact `language` field shape against
  current Claude documentation or exported payloads.
- Add fixture files for every target input: Claude markdown, code, HTML, SVG,
  Mermaid, React, plus Codex handoff, bundle, diff, review, and test report.
- Add failing regression tests for converter mapping, storage round-trip, MCP tool
  schemas, browser rendering containers, and `/raw` source fidelity.
- Decide the taxonomy additions before implementation: either reuse existing
  `artifactType` values or add `diagram`, `component`, and `snippet`.

**Exit criteria:** tests describe all target formats and current behavior gaps are
visible without changing production behavior.

### Phase 1 — Schema, storage, and surface plumbing

**Goal:** let every API surface accept the new formats without rendering them yet.

- Extend `storage.js` format normalization, extensions, and content types for
  `code`, `svg`, `mermaid`, and `react`.
- Extend `artifactType` validation if the taxonomy decision adds new values.
- Update MCP schemas, CLI help text, browser form options, badges, i18n labels,
  and schema documentation.
- Store `language`, source MIME type, and converter provenance in version metadata.
- Keep unknown/unsupported legacy values mapped to `unknown` during import rather
  than rejecting external artifacts.

**Exit criteria:** all surfaces can create, update, import, list, and read the new
formats, even if the viewer still falls back to escaped source rendering.

### Phase 0-1 implementation status (2026-06-24)

Implemented in the repository:

- Added storage-level `ARTIFACT_FORMATS` for `code`, `svg`, `mermaid`, and
  `react` alongside the existing `html`, `markdown`, `text`, and `json` formats.
- Added `diagram`, `component`, and `snippet` to the `artifactType` taxonomy.
- Added converter coverage for Claude structured payload identifiers, SVG/Mermaid
  filename and content sniffing, React component payloads, and explicit Codex
  continuation artifact types.
- Updated MCP schemas, CLI help, browser form options, editor format detection,
  format/type badges, README, and schema documentation.
- Added fixtures for Claude code/SVG/Mermaid/React and Codex diff/review/test
  report artifacts.

Verification:

- `npm run release:check` passed with 25 tests.

Remaining for later phases:

- Phase 3 still needs real viewer rendering for `code` and `svg`; per user
  decision, code rendering should reuse CodeMirror in read-only mode.
- Phase 4 still needs the Mermaid dependency and sandboxed local renderer.
- Phase 5 still needs gated React execution with
  `ARTIFACTY_ENABLE_REACT_RENDERER=true` defaulting to disabled.

### Phase 2 — Codex continuation artifacts

**Goal:** make Codex output useful for agent-to-agent handoff before adding heavy
viewer dependencies.

- Add Codex-aware converter paths for structured handoff JSON, file bundles,
  patch/diff walkthroughs, code reviews, and verification reports.
- Preserve file paths, hashes, content types, changed-file summaries, commands run,
  test status, blockers, and next-step metadata.
- Add CLI/MCP examples for `sourceAgent: "codex"` with `handoff`, `bundle`,
  `diff-walkthrough`, `code-review`, and `test-report`.
- Add tests proving Codex Markdown is not over-inferred: only structured or
  explicit payloads become handoffs/reports.

**Exit criteria:** another agent can list a Codex artifact, understand what changed,
read the original source, and continue the work without copy-pasting chat context.

### Phase 2 implementation status (2026-06-24)

Implemented in the repository:

- Added Codex structured continuation conversion for handoff, diff walkthrough,
  code review, and verification report payloads when the payload explicitly
  identifies Codex through `agent` or `sourceAgent`.
- Preserved structured continuation metadata under `metadata.codexContinuation`,
  including changed files, commands, tests, test status, findings, blockers,
  decisions, next steps, diffs, and residual risk.
- Added Codex bundle metadata preservation so file bundles can carry changed-file,
  test, and next-step context alongside per-file paths, content types, sizes, and
  hashes.
- Added CLI/MCP documentation examples for Codex continuation artifacts.
- Added regression tests proving plain Codex Markdown remains a normal `document`
  unless structured payloads or explicit `artifactType` values are supplied.

Verification:

- `npm run release:check` passed with 28 tests.
- CLI structured Codex import/list/show was verified against an isolated temporary
  store.

Remaining for later phases:

- Phase 3 must implement actual viewer rendering for `code` and `svg`.
- Per user decision, `code` should use a CodeMirror read-only viewer rather than
  only escaped `<pre><code>` output.

### Phase 3 — Low-risk Claude renderers: code and SVG

**Goal:** support the highest-value Claude formats without adding large runtime
dependencies or executing artifact code.

- Implement `code` rendering as inert read-only source with language metadata shown
  in the viewer. Reuse CodeMirror where practical, but avoid broad viewer coupling.
- Implement `svg` rendering inside a scriptless sandboxed iframe.
- Add SVG defense-in-depth sanitization for `<script>` nodes and `on*` attributes.
- Add tests for iframe sandbox flags, raw source fidelity, metadata display, and
  sanitizer behavior.

**Exit criteria:** Claude code and SVG artifacts render safely, while malicious SVG
handlers do not execute and `/raw` still returns the original source.

### Phase 3 implementation status (2026-06-24)

Implemented in the repository:

- Added `/assets/viewer.js`, a progressive-enhancement viewer client that mounts
  CodeMirror in read-only mode for `code` artifacts.
- Added direct `@codemirror/lang-javascript` dependency for JavaScript, TypeScript,
  JSX, and TSX read-only code viewing.
- Added `code` artifact rendering with a preserved escaped fallback and CodeMirror
  enhancement when JavaScript loads.
- Added `svg` artifact rendering in a sandboxed iframe without `allow-scripts`.
- Added SVG defense-in-depth sanitization for `<script>`, `on*` attributes, and
  `javascript:` href values while keeping `/raw` source faithful.
- Added HTTP regression tests for code viewer script wiring, SVG sandbox flags,
  sanitizer behavior, and raw source preservation.

Verification:

- `npm run release:check` passed with 28 tests.

Remaining for later phases:

- Phase 4 must add the Mermaid dependency and sandboxed local renderer.
- Phase 5 must add gated React execution behind
  `ARTIFACTY_ENABLE_REACT_RENDERER=true`.

### Phase 4 — Mermaid renderer

**Goal:** render Mermaid diagrams locally without CDN access.

- Add `mermaid` as a dependency and serve it through the existing vendored npm
  allowlist route.
- Render Mermaid inside a sandboxed iframe with `allow-scripts` but without
  `allow-same-origin`.
- Inject Mermaid source through a data island rather than interpolating it into
  executable script text.
- Add viewer error states for invalid diagrams and tests for sandbox flags, local
  asset loading, and invalid-source handling.

**Exit criteria:** Mermaid artifacts render to SVG offline/local-only and failure
states are readable without breaking the artifact page.

### Phase 4 implementation status (2026-06-24)

Implemented in the repository:

- Added Mermaid as a default dependency.
- Extended `/vendor/npm/<package>/<subpath>` serving so allowlisted package
  subpaths and Mermaid chunk imports can be loaded locally.
- Added a Mermaid importmap override to point `mermaid` at
  `/vendor/npm/mermaid/dist/mermaid.esm.min.mjs`.
- Added `mermaid` artifact rendering in a sandboxed iframe with `allow-scripts`
  and without `allow-same-origin`.
- Injected Mermaid source through a JSON data island and rendered through the
  vendored local Mermaid module.
- Added readable iframe error output for invalid Mermaid source.
- Added tests for sandbox flags, vendor subpath serving, raw source preservation,
  and blocked path traversal attempts.

Verification:

- `npm run release:check` passed with 28 tests.

Remaining for later phases:

- Phase 5 must add gated React execution behind
  `ARTIFACTY_ENABLE_REACT_RENDERER=true`.

### Phase 5 — React renderer behind an explicit gate

**Goal:** support Claude React artifacts without making arbitrary JS execution the
default behavior.

- Add React/ReactDOM and a JSX transform only after selecting the smallest viable
  runtime strategy.
- Gate React execution behind an explicit config flag such as
  `ARTIFACTY_ENABLE_REACT_RENDERER=true`.
- Default disabled behavior should show source plus a clear non-executing preview
  state.
- If the transform requires `eval` or `new Function`, scope the relaxed CSP to the
  artifact iframe only, never the parent app.
- Add tests proving the parent origin remains isolated and `allow-same-origin` is
  never present on scripted artifact iframes.

**Exit criteria:** React artifacts are usable for operators who opt in, while the
default installation remains conservative and local-first.

### Phase 5 implementation status (2026-06-24)

Implemented in the repository:

- Added React, ReactDOM, and Babel standalone as optional dependencies.
- Added `react` artifact source-only rendering as the default behavior.
- Added `ARTIFACTY_ENABLE_REACT_RENDERER=true` gate for executing React artifacts.
- Added `/artifacts/:id/react-frame?version=n`, which renders React artifacts in
  a sandboxed frame only when the gate is enabled.
- Kept `allow-same-origin` off the React iframe.
- Scoped `unsafe-eval` to the React frame response CSP instead of the parent app
  CSP, so Babel can transform JSX without weakening the main Artifacty UI.
- Added tests for disabled default behavior, enabled iframe wiring, React frame
  CSP, vendored React/ReactDOM/Babel assets, and sandbox flags.

Verification:

- `npm run release:check` passed with 28 tests.

Remaining for later phases:

- Phase 6 must update release docs, run npm packaging checks, and record known
  limitations for Mermaid bundle size and React opt-in execution risk.

### Phase 6 — Release hardening and documentation

**Goal:** make the new format support maintainable for public users and future
agents.

- Update README, `docs/integrations.md`, `docs/artifact-schema-v1.md`, and MCP
  examples with the new formats and Codex artifact categories.
- Add release checklist items for dependency size, sandbox flags, CSP behavior,
  secret scanning, and offline rendering.
- Run full verification: lint, tests, smoke, npm pack dry run, browser smoke for
  each renderer, and MCP create/import checks.
- Record known limitations: React opt-in risk, large Mermaid bundle size, and any
  unsupported Claude payload shape.

**Exit criteria:** the feature can be released as a documented minor version with
clear security posture and reproducible verification evidence.

## Testing

Per `CLAUDE.md`, every new format/route/tool/converter behavior needs a regression
test with an isolated temporary store:

- `converters.test.js`: each Claude identifier and each sniff fallback maps to the
  right `format` (+ `language` for code); browser-saved-HTML fallback path.
- `storage.test.js`: round-trip of each new format (extension, content-type,
  size, sha) and `normalizeFormat` aliases.
- `server.test.js`: `GET /artifacts/:id` renders the expected container per format
  (iframe sandbox flags for svg/mermaid/react; highlighted block for code); `/raw`
  returns untouched source.
- `mcp-server.test.js`: `artifacty_import` and `artifacty_create` accept the new
  `format` enum values and echo them in `structuredContent`.
- A security test asserting SVG script/`on*` stripping and that scripted artifact
  iframes never carry `allow-same-origin`.

## Open questions (need a decision before building)

1. **Confirm Claude's current type identifiers and `language` field shape.**
2. **Taxonomy:** add `diagram`/`component`/`snippet` artifactTypes, or reuse
   existing ones?
3. **Dependency budget:** is vendoring Mermaid and React/JSX acceptable given the
   project's minimalism, or should Mermaid/React be opt-in extras the operator
   enables explicitly?
4. **React safety bar:** ship behind a config flag, or render a static
   "source only, click to run" affordance by default?
5. **Code highlighting:** reuse CodeMirror read-only views, or add a smaller
   static highlighter to avoid pulling more of CodeMirror into the viewer path?


---

## Phase 6 Implementation Status

Status: Complete.

Implemented:

- Updated README, integration guide, schema reference, and release checklist with renderer behavior and security boundaries.
- Narrowed npm package contents to explicit public docs so the local Claude format roadmap draft is not shipped.
- Documented CodeMirror, SVG, Mermaid, and opt-in React renderer policies for operators.

Verification:

- `npm run release:check`: passed with 28 Node tests and the local smoke test.
- `npm pack --dry-run`: passed; package contains 28 files, excludes `docs/claude-artifact-formats.md`, and reports about 1.3 MB packed size.
- Restarted the local server on `http://127.0.0.1:8787`.
- HTTP route checks passed for `/assets/viewer.js`, Mermaid, React, and Babel vendor assets. v10 adds browser smoke evidence because route status alone did not prove Mermaid rendered inside the sandboxed iframe.
- Default app CSP was checked and does not include `unsafe-eval`; eval permission is limited to the gated React frame response.

Known limitations:

- React rendering remains disabled by default because it executes arbitrary component code when enabled.
- Mermaid and optional React rendering depend on bundled npm packages, so `npm pack --dry-run` remains required before publishing.


---

## v10 Mermaid CORS Hotfix and Documentation Corrections

Status: Complete.

Implemented:

- Added conditional `Access-Control-Allow-Origin: null` for `Origin: null` JavaScript asset requests served by `sendJavaScriptFile`.
- Kept Mermaid iframes sandboxed with `allow-scripts` and without `allow-same-origin`; the fix enables opaque-origin ESM imports without weakening iframe isolation.
- Added regression tests for ACAO headers on `/assets/editor.js`, `/assets/viewer.js`, and the Mermaid vendor ESM route.
- Corrected this document's status, scope, historical model heading, and Phase 6 verification wording.

Verification:

- `node --test test/server.test.js`: passed.
- `npm run release:check`: passed with 28 Node tests and the local smoke test.
- `curl -I` with `Origin: null` confirmed `Access-Control-Allow-Origin: null` on `/vendor/npm/mermaid/dist/mermaid.esm.min.mjs` and `/assets/viewer.js`; ordinary same-origin requests do not receive a CORS header.
- In-app browser smoke opened `http://127.0.0.1:8787/artifacts/mermaid-cors-smoke-3d198d73`; the Mermaid iframe produced `svgCount=1`, `errorCount=0`, visible diagram labels, and no console errors.

Residual risk:

- The automated Node suite now guards the CORS header, but actual renderer painting still needs browser smoke before release when changing sandbox flags, CSP, or vendor asset routing.


---

## v11 Narrowed CORS Policy

Status: Complete.

Implemented:

- Replaced the wildcard JavaScript asset CORS response with a conditional policy.
- Ordinary same-origin JavaScript asset requests receive no CORS header.
- Requests with `Origin: null`, which are produced by sandboxed opaque-origin iframes, receive `Access-Control-Allow-Origin: null` and `Vary: Origin`.
- Mermaid iframe isolation remains unchanged: `allow-scripts` is present and `allow-same-origin` is still absent.

Verification:

- `node --test test/server.test.js`: passed.
- `npm run release:check`: passed with 28 Node tests and the local smoke test.
- `curl -I` confirmed no ACAO header on ordinary Mermaid/viewer asset requests.
- `curl -I -H 'Origin: null'` confirmed `Access-Control-Allow-Origin: null` and `Vary: Origin` on Mermaid/viewer asset requests.
- In-app browser smoke confirmed the Mermaid iframe still rendered with `svgCount=1`, `errorCount=0`, and no console errors.


---

## v12 MCP Timeout Alignment

Status: Complete.

Implemented:

- Centralized the 30 second MCP timeout default used by Artifacty installers.
- Codex config generation now supports custom `--timeout <ms>` by converting it to `startup_timeout_sec`.
- Gemini config generation uses the same default and supports custom `--timeout <ms>`.
- Claude installer intentionally does not write a per-server `timeout` field because Claude Code startup timeout is controlled by the parent `MCP_TIMEOUT` environment variable; the per-server field is for tool execution timeout.
- Updated CLI help, README, and integration docs with timeout guidance.

Verification:

- `node --test test/installer.test.js`: passed.
- `npm run release:check`: passed with 29 Node tests and the local smoke test.
- `npm pack --dry-run`: passed with 28 package files.
- Dry-run install checks confirmed Codex `--timeout 45000` produces `startup_timeout_sec = 45.0`, Gemini produces `timeout: 45000`, and Claude does not emit a misleading per-server timeout field.
