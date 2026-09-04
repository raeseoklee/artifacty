import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildCsvExport,
  buildSarifExport,
  parseCsvFilterParam,
  parseCsvTable,
  serializeCsvRow
} from "../src/lib/sarif-csv-export.js";

const CSV_CONTENT = "name,count,note\nCodex,2,\"Validate, then open\"\nArtifacty,10,ok\nZeta,1,ok";

test("parseCsvTable splits header and rows, and rejects unterminated quotes", () => {
  const parsed = parseCsvTable(CSV_CONTENT);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.header, ["name", "count", "note"]);
  assert.equal(parsed.rows.length, 3);

  const broken = parseCsvTable('a,"b');
  assert.equal(broken.ok, false);
  assert.match(broken.error, /unterminated/);

  const empty = parseCsvTable("");
  assert.equal(empty.ok, false);
});

test("serializeCsvRow quotes fields containing commas, quotes, or newlines", () => {
  assert.equal(serializeCsvRow(["a", "b"]), "a,b");
  assert.equal(serializeCsvRow(["a,b", "c"]), '"a,b",c');
  assert.equal(serializeCsvRow(['say "hi"']), '"say ""hi"""');
  assert.equal(serializeCsvRow(["line1\nline2"]), '"line1\nline2"');
});

test("parseCsvFilterParam parses col:text pairs and rejects malformed clauses", () => {
  const parsed = parseCsvFilterParam("name:Codex,note:then open");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.filters, [{ col: "name", text: "Codex" }, { col: "note", text: "then open" }]);

  assert.deepEqual(parseCsvFilterParam(""), { ok: true, filters: [] });

  const invalid = parseCsvFilterParam("nocolon");
  assert.equal(invalid.ok, false);
});

test("buildCsvExport filters by column contains, case-insensitive", () => {
  const result = buildCsvExport({
    content: CSV_CONTENT,
    filters: [{ col: "note", text: "OK" }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.rowCount, 2);
  assert.match(result.csv, /Artifacty/);
  assert.match(result.csv, /Zeta/);
  assert.doesNotMatch(result.csv, /Codex/);
});

test("buildCsvExport sorts numeric-aware by column name or index, asc/desc", () => {
  const ascByCount = buildCsvExport({ content: CSV_CONTENT, sortCol: "count", dir: "asc" });
  assert.equal(ascByCount.ok, true);
  const ascRows = ascByCount.csv.trim().split("\n").slice(1);
  assert.deepEqual(ascRows.map((row) => row.split(",")[0]), ["Zeta", "Codex", "Artifacty"]);

  const descByIndex = buildCsvExport({ content: CSV_CONTENT, sortCol: "1", dir: "desc" });
  assert.equal(descByIndex.ok, true);
  const descRows = descByIndex.csv.trim().split("\n").slice(1);
  assert.deepEqual(descRows.map((row) => row.split(",")[0]), ["Artifacty", "Codex", "Zeta"]);
});

test("buildCsvExport rejects unknown sort/filter columns and bad dir", () => {
  assert.equal(buildCsvExport({ content: CSV_CONTENT, sortCol: "nope" }).ok, false);
  assert.equal(buildCsvExport({ content: CSV_CONTENT, filters: [{ col: "nope", text: "x" }] }).ok, false);
  assert.equal(buildCsvExport({ content: CSV_CONTENT, sortCol: "count", dir: "sideways" }).ok, false);
});

test("buildCsvExport caps output at maxBytes, dropping trailing rows", () => {
  const header = "name,count".length + 1; // rough header line size incl newline
  const result = buildCsvExport({ content: CSV_CONTENT, maxBytes: header + 12 });
  assert.equal(result.ok, true);
  assert.ok(result.rowCount < result.matchedCount);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.csv, "utf8") <= header + 12);
});

for (const tool of ["codeql", "semgrep", "trivy"]) {
  test(`buildSarifExport filters the real-world ${tool} fixture by level and rule`, async () => {
    const content = await readFile(`test/fixtures/sarif/${tool}.sarif.json`, "utf8");
    const full = buildSarifExport({ content });
    assert.equal(full.ok, true);
    assert.ok(full.resultCount > 0);

    const errorsOnly = buildSarifExport({ content, levels: ["error"] });
    assert.equal(errorsOnly.ok, true);
    for (const run of errorsOnly.sarif.runs) {
      for (const result of run.results) {
        assert.ok(result.level === "error" || (!result.level && errorsOnly.matchedCount === 0));
      }
    }
    assert.ok(errorsOnly.matchedCount <= full.resultCount);

    // The exported document remains valid, minimal SARIF: version + runs[].
    assert.equal(errorsOnly.sarif.version, "2.1.0");
    assert.ok(Array.isArray(errorsOnly.sarif.runs));
  });
}

test("buildSarifExport rejects invalid JSON, non-SARIF documents, and unknown levels", () => {
  assert.equal(buildSarifExport({ content: "not json" }).ok, false);
  assert.equal(buildSarifExport({ content: JSON.stringify({ foo: "bar" }) }).ok, false);
  const sarif = JSON.stringify({ version: "2.1.0", runs: [] });
  assert.equal(buildSarifExport({ content: sarif, levels: ["critical"] }).ok, false);
});

test("buildSarifExport rule filter matches case-insensitively across runs", async () => {
  const content = await readFile("test/fixtures/sarif/codeql.sarif.json", "utf8");
  const result = buildSarifExport({ content, ruleFilter: "path-injection" });
  assert.equal(result.ok, true);
  assert.equal(result.resultCount, 2);
  for (const run of result.sarif.runs) {
    for (const res of run.results) {
      assert.equal(res.ruleId, "js/path-injection");
    }
  }
});

test("buildSarifExport caps output at maxBytes, dropping trailing results", async () => {
  const content = await readFile("test/fixtures/sarif/codeql.sarif.json", "utf8");
  const uncapped = buildSarifExport({ content });
  const cap = 2000;
  const capped = buildSarifExport({ content, maxBytes: cap });
  assert.equal(capped.ok, true);
  assert.ok(capped.resultCount < uncapped.resultCount);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.json, "utf8") <= cap);
  // Still a structurally valid SARIF document.
  assert.equal(capped.sarif.version, "2.1.0");
  assert.ok(Array.isArray(capped.sarif.runs));
});
