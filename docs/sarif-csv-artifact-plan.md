# SARIF and CSV Artifact Support

Artifacty supports SARIF and CSV as **output artifacts**. Codex and other agents
can share these artifacts for review. This scope excludes Codex input context,
appshots, thread state, and client-specific UI state.

## Implemented Behavior

- HTTP, CLI, MCP, storage, and browser forms support `sarif` and `csv` as
  `format` values.
- `.sarif`, `.sarif.json`, `application/sarif+json`, `.csv`, and `text/csv`
  inputs are detected by the importer.
- The importer stores SARIF top-level objects with `version` and `runs[]` as
  `analysis-report` artifacts.
- CSV inputs default to `table`. If a CSV file appears to contain security
  or review findings, the importer selects `analysis-report`.
- `/raw` always returns the original stored source, unaffected by rendering,
  sort/filter, or export.

## Browser Rendering

- The SARIF viewer limits the findings summary size. The summary includes run,
  result, error, warning, and note counts.
- SARIF result rows show level, rule id, message, first location, and tool name.
- The full formatted SARIF JSON remains available in a details panel.
- CSV renders as an escaped table with bounded rows and columns.
- If CSV is malformed or JSON is not SARIF, the viewer displays escaped source
  or formatted JSON. It does not render an unsafe table.

## Sort, Filter, and Download (roadmap section 7)

- The server renders a limited set of SARIF results or CSV rows.
  `src/client/viewer.js` adds controls to that data in the browser. The server
  output remains correct and readable when JavaScript is disabled.
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
  - The route parses the original stored content again. It does not read
    `/raw`. It streams the result with `Content-Disposition: attachment` and
    the matching content type. The export cannot exceed the store's maximum
    artifact byte size. The route removes trailing rows or results in a fixed
    order when they would exceed that limit.
  - Invalid parameters (unknown format, unknown sort/filter column, bad
    `dir`, unknown SARIF level, or an artifact whose stored format doesn't
    match `format`) return HTTP 400 with `code: "invalid_export"`.
  - Shared filter, sort, and serialization functions are in
    `src/lib/sarif-csv-export.js`. They are separate from the display parsing
    functions in `src/lib/render.js`.

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

- No extensions are currently planned. See roadmap-design.md for the full roadmap.
