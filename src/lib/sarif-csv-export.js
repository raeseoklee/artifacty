// Roadmap section 7: SARIF and CSV sort, filter, download.
//
// Shared, storage-agnostic logic for GET /artifacts/:id/export. The route in
// src/server.js re-parses the *stored original* content (never /raw itself)
// and calls into this module to filter, sort, and serialize a fresh export
// file, capped at a byte budget.
import { parseCsv } from "./csv.js";

export const SARIF_LEVELS = ["error", "warning", "note", "none"];

// Hard cap on results considered for export, independent of the byte budget,
// so a pathological input (e.g. many tiny results) can't force an unbounded
// number of loop iterations even when each iteration is now O(1).
export const MAX_SARIF_EXPORT_RESULTS = 50000;

// --- CSV --------------------------------------------------------------

export function parseCsvTable(content) {
  const parsed = parseCsv(content);
  if (!parsed.ok) {
    return { ok: false, error: `CSV parse error: ${parsed.error}` };
  }
  if (parsed.rows.length === 0) {
    return { ok: false, error: "CSV artifact is empty" };
  }
  return { ok: true, header: parsed.rows[0], rows: parsed.rows.slice(1) };
}

export function serializeCsvRow(row) {
  return row.map(escapeCsvField).join(",");
}

function escapeCsvField(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll("\"", "\"\"")}"`;
  }
  return text;
}

function resolveCsvColumn(header, columnParam) {
  if (columnParam === undefined || columnParam === null || columnParam === "") {
    return -1;
  }
  const exact = header.indexOf(columnParam);
  if (exact !== -1) {
    return exact;
  }
  if (/^\d+$/.test(columnParam)) {
    const index = Number(columnParam);
    if (index >= 0 && index < header.length) {
      return index;
    }
  }
  return null;
}

// col:text pairs separated by commas, e.g. "name:Codex,count:1". The column
// text (after the first colon) may itself contain colons.
export function parseCsvFilterParam(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return { ok: true, filters: [] };
  }
  const filters = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) {
      continue;
    }
    const separatorIndex = entry.indexOf(":");
    if (separatorIndex === -1) {
      return { ok: false, error: `Invalid filter clause (expected col:text): ${entry}` };
    }
    const col = entry.slice(0, separatorIndex).trim();
    const text = entry.slice(separatorIndex + 1);
    if (!col) {
      return { ok: false, error: `Invalid filter clause (missing column): ${entry}` };
    }
    filters.push({ col, text });
  }
  return { ok: true, filters };
}

function compareCsvCells(a, b) {
  const trimmedA = a.trim();
  const trimmedB = b.trim();
  const numericA = trimmedA !== "" && Number.isFinite(Number(trimmedA));
  const numericB = trimmedB !== "" && Number.isFinite(Number(trimmedB));
  if (numericA && numericB) {
    return Number(trimmedA) - Number(trimmedB);
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function buildCsvExport({ content, sortCol, dir, filters = [], maxBytes = Infinity }) {
  const parsed = parseCsvTable(content);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  const { header, rows } = parsed;

  if (dir && dir !== "asc" && dir !== "desc") {
    return { ok: false, error: "dir must be \"asc\" or \"desc\"" };
  }

  const sortIndex = resolveCsvColumn(header, sortCol);
  if (sortIndex === null) {
    return { ok: false, error: `Unknown sort column: ${sortCol}` };
  }

  const resolvedFilters = [];
  for (const filter of filters) {
    const index = resolveCsvColumn(header, filter.col);
    if (index === null) {
      return { ok: false, error: `Unknown filter column: ${filter.col}` };
    }
    resolvedFilters.push({ index, text: filter.text.toLowerCase() });
  }

  let body = rows.filter((row) =>
    resolvedFilters.every((filter) => String(row[filter.index] || "").toLowerCase().includes(filter.text))
  );

  if (sortIndex !== -1) {
    const direction = dir === "desc" ? -1 : 1;
    body = body.slice().sort((a, b) =>
      direction * compareCsvCells(String(a[sortIndex] || ""), String(b[sortIndex] || ""))
    );
  }

  const headerLine = serializeCsvRow(header);
  let size = Buffer.byteLength(`${headerLine}\n`, "utf8");
  const kept = [];
  for (const row of body) {
    const line = `${serializeCsvRow(row)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (size + lineBytes > maxBytes) {
      break;
    }
    size += lineBytes;
    kept.push(row);
  }

  const csv = `${[headerLine, ...kept.map(serializeCsvRow)].join("\n")}\n`;
  return {
    ok: true,
    csv,
    matchedCount: body.length,
    rowCount: kept.length,
    truncated: kept.length < body.length
  };
}

// --- SARIF --------------------------------------------------------------

export function isSarifDocument(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray(value.runs) &&
    (typeof value.version === "string" || String(value.$schema || "").toLowerCase().includes("sarif"))
  );
}

export function normalizeSarifLevel(value) {
  const normalized = String(value || "warning").toLowerCase();
  return SARIF_LEVELS.includes(normalized) ? normalized : "warning";
}

export function sarifResultLevel(result, rulesById, rulesByIndex) {
  const rule = rulesById.get(result.ruleId) || rulesByIndex.get(result.ruleIndex);
  return normalizeSarifLevel(result.level || rule?.defaultConfiguration?.level);
}

export function sarifResultRuleId(result, rulesById, rulesByIndex) {
  if (result.ruleId) {
    return result.ruleId;
  }
  const rule = rulesById.get(result.ruleId) || rulesByIndex.get(result.ruleIndex);
  if (rule?.id) {
    return rule.id;
  }
  return Number.isInteger(result.ruleIndex) ? `#${result.ruleIndex}` : "unknown";
}

export function rulesMapsForRun(run) {
  const rulesById = new Map();
  const rulesByIndex = new Map();
  for (const [index, rule] of (run?.tool?.driver?.rules || []).entries()) {
    if (rule?.id) {
      rulesById.set(rule.id, rule);
    }
    rulesByIndex.set(index, rule);
  }
  return { rulesById, rulesByIndex };
}

export function buildSarifExport({ content, levels = [], ruleFilter = "", maxBytes = Infinity }) {
  let sarif;
  try {
    sarif = JSON.parse(content);
  } catch (error) {
    return { ok: false, error: `Invalid SARIF JSON: ${error.message}` };
  }
  if (!isSarifDocument(sarif)) {
    return { ok: false, error: "Artifact content is not a valid SARIF document" };
  }

  const invalidLevel = levels.find((level) => !SARIF_LEVELS.includes(level));
  if (invalidLevel) {
    return { ok: false, error: `Unknown SARIF level: ${invalidLevel}` };
  }

  const ruleNeedle = ruleFilter.toLowerCase();
  const matchedByRun = sarif.runs.map((run) => {
    const { rulesById, rulesByIndex } = rulesMapsForRun(run);
    return (run?.results || []).filter((result) => {
      const level = sarifResultLevel(result, rulesById, rulesByIndex);
      if (levels.length > 0 && !levels.includes(level)) {
        return false;
      }
      if (ruleNeedle) {
        const ruleId = String(sarifResultRuleId(result, rulesById, rulesByIndex)).toLowerCase();
        if (!ruleId.includes(ruleNeedle)) {
          return false;
        }
      }
      return true;
    });
  });

  const matchedCount = matchedByRun.reduce((sum, results) => sum + results.length, 0);

  // Single pass: track the running byte cost of each accepted result instead of
  // re-serializing the whole candidate document per result (was O(n^2)).
  // Results live inside `runs[i].results`, an array nested 4 levels deep in the
  // pretty-printed (indent: 2) output, so each array element is indented by 8
  // spaces relative to its own standalone `JSON.stringify(result, null, 2)`
  // rendering. Prepending 8 spaces to every line of that rendering reproduces
  // exactly what the nested serialization would have produced, byte-for-byte.
  const RESULT_INDENT = 8;
  let size = Buffer.byteLength(
    JSON.stringify({ ...sarif, runs: sarif.runs.map((run) => ({ ...run, results: [] })) }, null, 2),
    "utf8"
  );
  let truncated = false;
  let keptCount = 0;

  const kept = matchedByRun.map(() => []);
  const maxResults = MAX_SARIF_EXPORT_RESULTS;

  outer:
  for (let runIndex = 0; runIndex < matchedByRun.length; runIndex += 1) {
    const runResults = matchedByRun[runIndex];
    for (let i = 0; i < runResults.length; i += 1) {
      if (keptCount >= maxResults) {
        truncated = true;
        break outer;
      }
      const result = runResults[i];
      const resultJson = JSON.stringify(result, null, 2);
      const lineCount = (resultJson.match(/\n/g)?.length || 0) + 1;
      const resultBytes = Buffer.byteLength(resultJson, "utf8") + lineCount * RESULT_INDENT;
      const separatorBytes = kept[runIndex].length > 0 ? 2 : 0; // ",\n" between array elements
      const candidateSize = size + resultBytes + separatorBytes;
      if (candidateSize > maxBytes) {
        truncated = true;
        break outer;
      }
      kept[runIndex].push(result);
      size = candidateSize;
      keptCount += 1;
    }
  }

  const runsOut = sarif.runs.map((run, index) => ({ ...run, results: kept[index] }));
  const doc = { ...sarif, runs: runsOut };
  const json = JSON.stringify(doc, null, 2);
  return {
    ok: true,
    sarif: doc,
    json,
    matchedCount,
    resultCount: keptCount,
    truncated: truncated || keptCount < matchedCount,
    sizeBytes: Buffer.byteLength(json, "utf8")
  };
}
