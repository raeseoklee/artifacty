# Supporting Claude Formats and Codex Continuation Artifacts

Status: Implemented. Phases 0-6 are complete. The v10 section records the
Mermaid CORS fix and browser smoke-test evidence.

This document records how Artifacty imports, stores, and renders Claude formats
and Codex continuation artifacts. The implementation preserves four rules:

- Route shared behavior through the shared library.
- Append immutable versions.
- Serve assets locally.
- Treat artifact content as untrusted.

The starting model, gap analysis, design, and phased plan describe the original
proposal. Dated implementation sections record the work completed at each stage.

## Goal

Users can import Claude artifacts through MCP `artifacty_import`, CLI `import`,
or `POST /api/import`. Artifacty preserves their source and makes them available
in lists, search results, and the browser viewer. The viewer uses local assets and keeps
untrusted content inside the existing sandbox.

Artifacty also imports Codex continuation artifacts as handoffs, bundles, reviews,
diff walkthroughs, and verification reports. Converters avoid unsupported
assumptions about the source.

## Background: Claude artifact types

Claude emits a small set of artifact types. Each has a MIME-like `type`
identifier. Code artifacts also have a `language` field.

| Claude type        | Identifier                       | Extra fields | What it is |
|--------------------|----------------------------------|--------------|------------|
| Markdown / document| `text/markdown`                  | —            | Formatted prose |
| Code               | `application/vnd.ant.code`       | `language`   | Syntax-highlighted source, not executed |
| HTML page          | `text/html`                      | —            | Single-file web page, rendered (inline CSS/JS) |
| SVG image          | `image/svg+xml`                  | —            | Vector graphic |
| Mermaid diagram    | `application/vnd.ant.mermaid`    | —            | Diagram described in Mermaid source |
| React component    | `application/vnd.ant.react`      | —            | Interactive JSX component |

> These identifiers depend on an external product. Before implementing converter
> mappings, verify the identifiers against current Claude documentation. This
> table describes the intended mapping, not a fixed external contract.

Two import shapes matter:

1. **Structured payload** (preferred): the caller supplies the artifact `type`,
   `language`, and raw source. This preserves the source without loss. MCP and
   CLI callers should use this format.
2. **Browser-saved HTML**: "Save page as…" includes the claude.ai interface and
   an inner `frame.claudeusercontent.com` iframe. Existing imported artifacts
   used this method. It loses the original `type`; only HTML and SVG remain as
   raw markup. Detection must fall back to content inspection.

## Codex artifact categories

Codex output does not use the same small MIME-like taxonomy as Claude artifacts.
For Artifacty, treat Codex output as work products from repository changes. These
include source files, diffs, handoffs, reviews, verification evidence, and local
previews. Set `sourceAgent` to `codex`. Use `artifactType` to describe how the next
agent will use the artifact.

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

Most Codex continuation artifacts use the existing Markdown, JSON, text, or HTML
renderer. A separate renderer is needed only when the payload contains source
for the `code`, `svg`, `mermaid`, or `react` formats.

Prioritize **`handoff`**, **`bundle`**, **`diff-walkthrough`**, **`code-review`**,
and **`test-report`** for Codex support. These types explain what changed, why it
changed, how to verify it, and what the next agent should do.

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

Codex conversion should not assume that every Markdown note is a handoff. It
should not assume that a diff is safe to apply or an HTML preview is trusted.
Preserve the source. Record its origin under `metadata.artifactyImport`. The
viewer must continue to treat the content as untrusted.

## Starting Artifacty model (before Phase 0)

- **Formats** are normalized to one of four values in `src/lib/storage.js`
  (`FORMAT_TO_EXTENSION`, `FORMAT_TO_CONTENT_TYPE`, `normalizeFormat`):
  `html | markdown | text | json`. `md` aliases to `markdown`. The maximum size was 16 MiB.
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

By v10, Phases 0-6 had closed these storage, conversion, and viewer gaps. React
execution remains opt-in.

## Design

### 1. Format taxonomy

Extend the four normalized formats to include the formats that need distinct
renderers. For each new format, update `storage.js` and every public interface.
Add a regression test. Apply the shared-library rule from `CLAUDE.md`:

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

Rejected alternative: keep four formats and select the renderer through
`artifactType` + `metadata.renderer`. The existing `format` field already selects
the renderer in `renderContent`. MCP, CLI, and the editor also use it. A second
selection field would make the contract ambiguous.

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

Record the original agent, Claude `type`, and `language` under
`metadata.artifactyImport`. This makes the mapping auditable.

### 3. Rendering pipeline (`render.js renderContent`)

The **artifact source** is the source of truth: JSX, Mermaid, SVG, or code text.
Render it when the user opens the viewer. Never store compiled output. `/raw`
returns the original bytes, and immutable version files preserve the source.

Use the existing sandboxed iframe pattern for executable or graphical content.
It resizes the frame and contains untrusted code. Inert code text needs no frame:

- **`code`** → render read-only highlighted source. Reuse the vendored CodeMirror
  language modes (`@codemirror/lang-*`) in a read-only EditorView, or a lighter
  static highlighter. No iframe is needed because the source is inert text. Keep the existing
  escaping behavior and add token spans. Show the `language` label in the meta strip.
- **`svg`** → embed the SVG in a sandboxed iframe **without** `allow-scripts`
  (SVG can carry `<script>`/`on*` handlers). Optionally also strip script nodes and
  event-handler attributes server-side as defense-in-depth. Center the image and fit it to the available width.
- **`mermaid`** → a sandboxed iframe (`allow-scripts`, no `allow-same-origin`) whose
  `srcdoc` contains: an importmap to the vendored Mermaid module, an inline boot
  script that calls `mermaid.render(source)`, and the height reporter. The Mermaid
  source is injected as a data island, not interpolated into script.
- **`react`** → a sandboxed iframe (`allow-scripts`, no `allow-same-origin`) that
  imports vendored React + ReactDOM and a JSX transform, compiles the component
  source at runtime, and mounts it. Use the same height reporter. This path has the greatest security risk
  and the largest runtime requirements (see Security).

Reuse the existing HTML parent listener (`frameResizeScript`) and reporter
injection for SVG, Mermaid, and React frames.

### 4. Vendored client assets (`editor-assets.js`)

Add new runtimes to the allowlist and route mechanism that serves CodeMirror.
This keeps assets on the same origin and within the CSP:

- Mermaid: `mermaid` (note: this is a **large** ESM bundle).
- React: `react`, `react-dom`, plus a JSX transform. Prefer a small standalone JSX
  transformer over full Babel if feasible; Babel-standalone is large.
- Add each to `EDITOR_VENDOR_PACKAGES` (or a parallel `RENDER_VENDOR_PACKAGES`) and,
  if their entry point differs, to `EDITOR_VENDOR_ENTRY_OVERRIDES`.

These packages become `dependencies` in `package.json`. CodeMirror had already
changed the original zero-runtime-dependency policy. The phased proposal keeps
the larger additions opt-in.

### 5. Storage & schema

- No new columns. `language` and any render hint go in the version
  `metadata` JSON. `format` gains the new enum values.
- `artifactType` mapping suggestions: `mermaid`/`svg` → `asset` or a new
  `diagram`; `react` → `design-option` or a new `component`; `code` → `code-review`
  misrepresents the content. Prefer a new `snippet`/`code` artifactType. Decide as part
  of the taxonomy review (Open Questions).

## Security considerations

The viewer renders **untrusted** content. Apply these security requirements:

- Keep CSP local-only. Vendored libs are served from `/vendor/npm/*` (same origin);
  do not use a CDN. Allow `unsafe-eval` only if a renderer requires it, such as
  a JSX transform. Scope that permission to the artifact iframe through its
  own CSP, not the whole app.
- Keep `allow-same-origin` **off** for any scripted artifact iframe (Mermaid,
  React, HTML). Without it the iframe is an opaque origin and cannot touch the
  store, cookies, or `server.json`; cross-frame messaging stays `postMessage`-only
  and the parent validates `event.source` (already done).
- SVG renders **scriptless**; additionally sanitize `<script>` and `on*` attributes
  server-side.
- React/JSX runs arbitrary author code. If a runtime needs `eval`/`new Function`,
  confine it with a dedicated, tighter CSP applied to that iframe's `srcdoc`, and
  document the residual risk. Consider gating `react` rendering behind an explicit
  opt-in (config flag) because author code can execute in the frame.
- Enforce `MAX_ARTIFACT_BYTES` and the existing secret-scan before persisting, for
  all new formats.

## Phased plan

Start with stable contracts. Then add renderers in order of increasing risk.
Each phase must be independently shippable and include regression tests. Each
phase must preserve the source and derive rendered output at view time.

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

**Exit criteria:** tests describe all target formats. They expose the current
gaps without changing production behavior.

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

**Exit criteria:** another agent can find the Codex artifact and read its source.
The artifact explains the changes well enough to continue without copying chat
context.

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

**Exit criteria:** the viewer displays Claude code and SVG artifacts. Malicious
SVG handlers do not execute. `/raw` returns the original source.

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

**Exit criteria:** Mermaid artifacts render to SVG with local assets. Invalid
diagrams show readable errors without breaking the artifact page.

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
- When execution is disabled, the viewer should show the source and clearly
  state that the preview does not execute it.
- If the transform requires `eval` or `new Function`, scope the relaxed CSP to the
  artifact iframe only, never the parent app.
- Add tests proving the parent origin remains isolated and `allow-same-origin` is
  never present on scripted artifact iframes.

**Exit criteria:** operators who enable React can use React artifacts. The
default installation keeps execution disabled and remains local-first.

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

**Exit criteria:** the feature is ready for a documented minor release. The
documentation explains its security boundaries and gives reproducible
verification evidence.

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
  `format` enum values and return them in `structuredContent`.
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
- HTTP route checks passed for `/assets/viewer.js`, Mermaid, React, and Babel
  vendor assets. Route status did not prove that Mermaid rendered in its
  sandboxed iframe. The v10 section adds browser smoke-test evidence.
- Default app CSP was checked and does not include `unsafe-eval`; eval permission is limited to the gated React frame response.

Known limitations:

- React rendering remains disabled by default because it executes arbitrary component code when enabled.
- Mermaid and optional React rendering depend on bundled npm packages, so `npm pack --dry-run` remains required before publishing.


---

## v10 Mermaid CORS Hotfix and Documentation Corrections

Status: Complete.

Implemented:

- Added conditional `Access-Control-Allow-Origin: null` for `Origin: null` JavaScript asset requests served by `sendJavaScriptFile`.
- Kept Mermaid frames sandboxed with `allow-scripts` and without
  `allow-same-origin`. The fix permits opaque-origin ESM imports and preserves
  iframe isolation.
- Added regression tests for ACAO headers on `/assets/editor.js`, `/assets/viewer.js`, and the Mermaid vendor ESM route.
- Corrected this document's status, scope, historical model heading, and Phase 6 verification wording.

Verification:

- `node --test test/server.test.js`: passed.
- `npm run release:check`: passed with 28 Node tests and the local smoke test.
- `curl -I` with `Origin: null` confirmed `Access-Control-Allow-Origin: null` on `/vendor/npm/mermaid/dist/mermaid.esm.min.mjs` and `/assets/viewer.js`; ordinary same-origin requests do not receive a CORS header.
- In-app browser smoke opened `http://127.0.0.1:8787/artifacts/mermaid-cors-smoke-3d198d73`; the Mermaid iframe produced `svgCount=1`, `errorCount=0`, visible diagram labels, and no console errors.

Residual risk:

- The Node suite checks the CORS header. Before release, changes to sandbox
  flags, CSP, or vendor asset routes still need a browser smoke test to verify
  rendering.


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

- Centralized the MCP timeout default of 30 seconds used by Artifacty installers.
- Codex config generation now supports custom `--timeout <ms>` by converting it to `startup_timeout_sec`.
- Gemini config generation uses the same default and supports custom `--timeout <ms>`.
- The Claude installer does not write a per-server `timeout` field. Claude Code
  reads its startup timeout from the parent `MCP_TIMEOUT` environment variable.
  The per-server field controls tool execution timeout.
- Updated CLI help, README, and integration docs with timeout guidance.

Verification:

- `node --test test/installer.test.js`: passed.
- `npm run release:check`: passed with 29 Node tests and the local smoke test.
- `npm pack --dry-run`: passed with 28 package files.
- Dry-run install checks confirmed Codex `--timeout 45000` produces `startup_timeout_sec = 45.0`, Gemini produces `timeout: 45000`, and Claude does not emit a misleading per-server timeout field.
