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
- `/raw` always returns the original stored source.

## Browser Rendering

- SARIF renders a bounded findings summary with run, result, error, warning,
  and note counts.
- SARIF result rows show level, rule id, message, first location, and tool name.
- The full formatted SARIF JSON remains available in a details panel.
- CSV renders as an escaped table with bounded rows and columns.
- Malformed CSV or non-SARIF JSON fails closed to escaped source or formatted
  JSON fallback.

## Verification Coverage

- Storage round trips cover format enums, content types, extensions, and type
  inference.
- Converter tests cover SARIF extension/MIME/object detection, findings CSV,
  and generic CSV.
- Server tests cover SARIF summary rendering, CSV escaping, `/raw` fidelity,
  and browser form options.
- MCP tests assert the new format and artifact type enums are exposed.

## Future Extensions

- Add real-world fixtures from CodeQL, Semgrep, Trivy, and other scanners.
- Add sorting/filtering for SARIF levels and CSV columns.
- Add optional download helpers for filtered CSV/SARIF views without changing
  immutable source storage.
