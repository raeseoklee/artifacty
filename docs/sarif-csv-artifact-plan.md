# SARIF and CSV Artifact Support Plan

This plan scopes SARIF and CSV support to **output artifacts** that Codex or
other agents generate for downstream review. It does not cover Codex input
context, appshots, thread state, or client-specific UI state.

## Goals

- Preserve SARIF and CSV files as immutable Artifacty versions.
- Classify common Codex Security exports without requiring manual
  `artifactType` overrides.
- Render CSV outputs in a readable table view while keeping `/raw` unchanged.
- Keep SARIF as JSON-first, with future room for a findings-focused viewer.

## Current Behavior

- `.sarif` content is stored as `json` when the payload is valid JSON, but it
  currently falls back to `artifactType: "unknown"`.
- `.csv` and `text/csv` content can be stored as `text`, but there is no CSV
  detection, table renderer, or artifact-type inference.
- Security findings exported as JSON, CSV, or SARIF can be shared today, but the
  browsing experience is not yet tailored to review workflows.

## Phase 1: Detection and Taxonomy

- Detect `.sarif` and `application/sarif+json` as `json`.
- Detect SARIF shape (`version`, `runs[]`, `tool.driver`) and classify as
  `code-review`.
- Detect `.csv` and `text/csv` as either a new `csv` format or `text` with
  `metadata.delimitedText`.
- Infer `code-review` for CSV/SARIF files named like `findings`, `security`,
  `review`, or containing columns such as `severity`, `file`, and `message`.

Exit criteria: CLI, HTTP, and MCP imports classify SARIF and common findings CSV
without explicit overrides.

## Phase 2: CSV Viewer

- Add a lightweight RFC 4180-style CSV parser for browser rendering.
- Render CSV as a scrollable table with sticky headers and escaped cell content.
- Cap rendered rows and columns for very large files, with a visible truncation
  notice and a link to `/raw`.
- Preserve plain text fallback when parsing fails.

Exit criteria: CSV artifacts are readable in the browser and raw fidelity is
unchanged.

## Phase 3: SARIF Summary Viewer

- Keep SARIF source as JSON.
- Add an optional summary above the JSON view: rule id, severity/level, message,
  file URI, region, and result count by level.
- Avoid implementing the complete SARIF spec in v1; parse only stable top-level
  fields and fail closed to JSON rendering.

Exit criteria: SARIF exports are useful for quick triage while preserving the
full JSON source.

## Tests

- Converter fixtures: Codex Security SARIF, findings CSV, generic CSV, malformed
  CSV, and large CSV.
- Storage round trips: content type, extension, size, hash, and `/raw` fidelity.
- Server rendering: CSV table escaping, truncation notice, SARIF summary fallback.
- MCP schema and import tests for explicit and inferred artifact types.
