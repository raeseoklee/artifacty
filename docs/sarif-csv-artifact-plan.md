# SARIF and CSV Artifact Support

Artifacty supports SARIF and CSV as **output artifacts** that Codex and other
agents can hand off for downstream review. This scope excludes Codex input
context, appshots, thread state, and client-specific UI state.

## Implemented Behavior

- `sarif` and `csv` are first-class `format` values across HTTP, CLI, MCP,
  storage, and browser forms.
- `.sarif`, `.sarif.json`, `application/sarif+json`, `.csv`, and `text/csv`
  inputs are detected during import.
- SARIF top-level objects with `version` and `runs[]` are imported as
  `analysis-report` artifacts.
- CSV inputs default to `table`; CSV files that look like security or review
  findings infer `analysis-report`.
- `/raw` always returns the original stored source, unaffected by rendering,
  sort/filter, or export.

## Browser Rendering

- SARIF renders a bounded findings summary with run, result, error, warning,
  and note counts.
- SARIF result rows show level, rule id, message, first location, and tool name.
- The full formatted SARIF JSON remains available in a details panel.
- CSV renders as an escaped table with bounded rows and columns.
- Malformed CSV or non-SARIF JSON fails closed to escaped source or formatted
  JSON fallback.

## Sort, Filter, and Download (roadmap section 7)

- The rendered SARIF and CSV tables are progressively enhanced client-side in
  `src/client/viewer.js`, over the data already in the bounded server-rendered
  set; the server output is fully correct and readable with JavaScript
  disabled.
  - SARIF: level filter chips (`error`, `warning`, `note`), a rule id text
    filter, and click-to-sort on the Level/Rule/Location columns, plus a
    visible result count.
  - CSV: click-to-sort column headers (numeric-aware), a per-column contains
    filter, and a visible row count.
- `GET /artifacts/:id/export` downloads a filtered/sorted copy without
  touching immutable storage or `/raw`:
  - `?format=csv&sort=<col>&dir=asc|desc&filter=<col>:<text>[,...]` — `col`
    is a header name or 0-based index; `filter` accepts comma-separated
    `col:text` clauses, matched case-insensitively as a substring.
  - `?format=sarif&level=error,warning&rule=<text>` — `level` is a
    comma-separated subset of `error`, `warning`, `note`, `none`; `rule` is a
    case-insensitive rule id substring match. The exported document keeps
    only the matching results per run and stays structurally valid SARIF.
  - The route re-parses the stored original content (never `/raw` itself),
    streams the result with `Content-Disposition: attachment` and the
    matching content type, and is capped at the store's max artifact byte
    size (trailing rows/results are dropped deterministically once the cap
    would be exceeded).
  - Invalid parameters (unknown format, unknown sort/filter column, bad
    `dir`, unknown SARIF level, or an artifact whose stored format doesn't
    match `format`) return HTTP 400 with `code: "invalid_export"`.
  - Shared filter/sort/serialization logic lives in
    `src/lib/sarif-csv-export.js`, independent of the presentation-focused
    parsing in `src/lib/render.js`.

## Verification Coverage

- Storage round trips cover format enums, content types, extensions, and type
  inference.
- Converter tests cover SARIF extension/MIME/object detection, findings CSV,
  generic CSV, and real-world CodeQL/Semgrep/Trivy SARIF fixtures.
- Server tests cover SARIF summary rendering, CSV escaping, `/raw` fidelity,
  browser form options, the export route's content type/disposition/byte cap,
  export parameter validation, and that the viewer script has no inline
  event handlers.
- `test/sarif-csv-export.test.js` unit-tests CSV parsing/serialization,
  filter/sort/cap behavior, and SARIF filter/cap behavior directly, including
  against the real-world fixtures under `test/fixtures/sarif/`.
- MCP tests assert the new format and artifact type enums are exposed.

## Future Extensions

- None currently planned; see roadmap-design.md for the broader roadmap.
