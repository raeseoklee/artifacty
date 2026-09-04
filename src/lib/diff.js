import { detectFormat } from "./converters.js";
import { parseCsv } from "./csv.js";

const ARRAY_MATCH_KEYS = ["id", "ruleId", "path"];
const DEFAULT_MAX_DIFF_ENTRIES = 5000;

// Formats createStructuredDiff renders structurally rather than as a plain
// line diff. Shared by server.js, cli.js, and mcp-server.js so the three
// adapters can't drift on which formats count as "structured" (they had
// triplicated this Set before).
export const STRUCTURED_DIFF_FORMATS = new Set(["json", "sarif", "csv", "notebook", "bundle"]);

// The diff format to use for a given artifact type/version-format pair:
// bundle artifacts always diff per-file regardless of the version's own
// stored format (a bundle version's `format` is the container format, not
// any one file's), everything else diffs using its version format
// directly.
export function diffFormatFor(artifactType, format) {
  if (artifactType === "bundle") {
    return "bundle";
  }
  return format;
}

// Resolves the requested diff view ("structured" | "lines" | anything else,
// meaning "let the format decide") the same way across all three adapters.
export function resolveDiffView({ artifactType, format, requestedView }) {
  if (requestedView === "structured" || requestedView === "lines") {
    return requestedView;
  }
  const diffFormat = diffFormatFor(artifactType, format);
  return STRUCTURED_DIFF_FORMATS.has(diffFormat) ? "structured" : "lines";
}

export function createLineDiff(before, after, options = {}) {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const maxCells = options.maxCells || 250000;

  if (beforeLines.length * afterLines.length > maxCells) {
    return [
      ...beforeLines.map((text, index) => ({
        type: "removed",
        beforeLine: index + 1,
        afterLine: "",
        text
      })),
      ...afterLines.map((text, index) => ({
        type: "added",
        beforeLine: "",
        afterLine: index + 1,
        text
      }))
    ];
  }

  const width = afterLines.length + 1;
  const table = new Uint32Array((beforeLines.length + 1) * width);

  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      const offset = i * width + j;
      if (beforeLines[i] === afterLines[j]) {
        table[offset] = table[(i + 1) * width + j + 1] + 1;
      } else {
        table[offset] = Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      rows.push({ type: "same", beforeLine: i + 1, afterLine: j + 1, text: beforeLines[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      rows.push({ type: "removed", beforeLine: i + 1, afterLine: "", text: beforeLines[i] });
      i += 1;
    } else {
      rows.push({ type: "added", beforeLine: "", afterLine: j + 1, text: afterLines[j] });
      j += 1;
    }
  }

  while (i < beforeLines.length) {
    rows.push({ type: "removed", beforeLine: i + 1, afterLine: "", text: beforeLines[i] });
    i += 1;
  }

  while (j < afterLines.length) {
    rows.push({ type: "added", beforeLine: "", afterLine: j + 1, text: afterLines[j] });
    j += 1;
  }

  return rows;
}

function splitLines(value) {
  return String(value).split(/\r?\n/);
}

// --- Structured diff -----------------------------------------------------
//
// createStructuredDiff(before, after, { format, maxEntries }) picks a
// per-format diff strategy and returns { kind, entries, truncated, summary }.
// renderUnifiedDiffText(structuredDiff) turns that structure into a compact
// human-readable text block for surfaces (MCP content[].text) that want a
// plain-text rendering instead of the structure itself.

export function createStructuredDiff(before, after, options = {}) {
  const cap = normalizeMaxEntries(options.maxEntries);
  const format = options.format || "text";
  const beforeStr = before == null ? "" : String(before);
  const afterStr = after == null ? "" : String(after);

  if (format === "json" || format === "sarif" || format === "notebook") {
    return buildJsonKindDiff(beforeStr, afterStr, cap);
  }
  if (format === "csv") {
    const csvResult = buildCsvKindDiff(beforeStr, afterStr, cap);
    if (csvResult) {
      return csvResult;
    }
  }
  if (format === "bundle") {
    const bundleResult = buildBundleKindDiff(beforeStr, afterStr, cap);
    if (bundleResult) {
      return bundleResult;
    }
  }
  return buildLineKindDiff(beforeStr, afterStr, cap);
}

export function renderUnifiedDiffText(structuredDiff) {
  if (!structuredDiff || !Array.isArray(structuredDiff.entries)) {
    return "";
  }

  const lines = [];
  for (const entry of structuredDiff.entries) {
    lines.push(...renderEntryLines(structuredDiff.kind, entry));
  }
  if (structuredDiff.truncated) {
    lines.push(`... diff truncated at ${structuredDiff.entries.length} entries ...`);
  }
  return lines.join("\n");
}

function renderEntryLines(kind, entry) {
  if (kind === "lines") {
    if (entry.op === "same") {
      return [];
    }
    if (entry.op === "removed") {
      return [`- ${entry.text}`];
    }
    if (entry.op === "added") {
      return [`+ ${entry.text}`];
    }
    return [`- ${entry.before}`, `+ ${entry.after}`];
  }

  if (kind === "json") {
    if (entry.op === "added") {
      return [`+ ${entry.path} = ${stringifyValue(entry.after)}`];
    }
    if (entry.op === "removed") {
      return [`- ${entry.path} = ${stringifyValue(entry.before)}`];
    }
    return [`~ ${entry.path}: ${stringifyValue(entry.before)} -> ${stringifyValue(entry.after)}`];
  }

  if (kind === "csv") {
    const rowLabel = entry.row === "header" ? "header" : `row ${entry.row}`;
    if (entry.op === "added") {
      return [`+ ${rowLabel}: ${JSON.stringify(entry.cells)}`];
    }
    if (entry.op === "removed") {
      return [`- ${rowLabel}: ${JSON.stringify(entry.cells)}`];
    }
    return [`~ ${rowLabel} col ${entry.column}: ${stringifyValue(entry.before)} -> ${stringifyValue(entry.after)}`];
  }

  if (kind === "bundle") {
    const prefix = entry.file ? `${entry.file}: ` : "";
    if (entry.op === "added" && entry.path === undefined && entry.row === undefined) {
      return [`+ ${prefix}(file added)`];
    }
    if (entry.op === "removed" && entry.path === undefined && entry.row === undefined) {
      return [`- ${prefix}(file removed)`];
    }
    const inner = renderEntryLines(entry.kind || "lines", entry);
    if (inner.length > 0) {
      return inner.map((line) => `${prefix}${line}`);
    }
    return [`~ ${prefix}${entry.path || entry.row || ""}`];
  }

  return [];
}

function stringifyValue(value) {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

export function normalizeMaxEntries(maxEntries) {
  if (Number.isFinite(maxEntries) && maxEntries > 0) {
    return Math.floor(maxEntries);
  }
  const fromEnv = Number(process.env.ARTIFACTY_MAX_DIFF_ENTRIES);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_MAX_DIFF_ENTRIES;
}

function createDiffState(cap) {
  return { entries: [], counters: { added: 0, removed: 0, changed: 0 }, truncated: false, cap };
}

function pushEntry(state, entry) {
  if (state.entries.length >= state.cap) {
    state.truncated = true;
    return false;
  }
  state.entries.push(entry);
  if (entry.op !== "same" && Object.prototype.hasOwnProperty.call(state.counters, entry.op)) {
    state.counters[entry.op] += 1;
  }
  return true;
}

// --- Line diff + word-level highlighting ---------------------------------

function buildLineKindDiff(beforeStr, afterStr, cap) {
  const rows = createLineDiff(beforeStr, afterStr);
  const state = createDiffState(cap);
  let i = 0;

  while (i < rows.length && !state.truncated) {
    const row = rows[i];

    if (row.type === "same") {
      pushEntry(state, { op: "same", beforeLine: row.beforeLine, afterLine: row.afterLine, text: row.text });
      i += 1;
      continue;
    }

    if (row.type === "removed") {
      const removedBlock = [];
      let j = i;
      while (j < rows.length && rows[j].type === "removed") {
        removedBlock.push(rows[j]);
        j += 1;
      }
      const addedBlock = [];
      let k = j;
      while (k < rows.length && rows[k].type === "added") {
        addedBlock.push(rows[k]);
        k += 1;
      }
      const pairCount = Math.min(removedBlock.length, addedBlock.length);
      for (let p = 0; p < pairCount && !state.truncated; p += 1) {
        const b = removedBlock[p];
        const a = addedBlock[p];
        pushEntry(state, {
          op: "changed",
          beforeLine: b.beforeLine,
          afterLine: a.afterLine,
          before: b.text,
          after: a.text,
          words: diffWords(b.text, a.text)
        });
      }
      for (let p = pairCount; p < removedBlock.length && !state.truncated; p += 1) {
        pushEntry(state, { op: "removed", beforeLine: removedBlock[p].beforeLine, text: removedBlock[p].text });
      }
      for (let p = pairCount; p < addedBlock.length && !state.truncated; p += 1) {
        pushEntry(state, { op: "added", afterLine: addedBlock[p].afterLine, text: addedBlock[p].text });
      }
      i = k;
      continue;
    }

    // Standalone "added" run with no preceding "removed" run.
    const addedBlock = [];
    let j = i;
    while (j < rows.length && rows[j].type === "added") {
      addedBlock.push(rows[j]);
      j += 1;
    }
    for (const r of addedBlock) {
      if (state.truncated) {
        break;
      }
      pushEntry(state, { op: "added", afterLine: r.afterLine, text: r.text });
    }
    i = j;
  }

  return { kind: "lines", entries: state.entries, truncated: state.truncated, summary: { ...state.counters } };
}

function diffWords(beforeText, afterText) {
  const beforeTokens = tokenizeWords(beforeText);
  const afterTokens = tokenizeWords(afterText);
  const maxCells = 20000;

  if (beforeTokens.length * afterTokens.length > maxCells) {
    return [
      ...beforeTokens.map((text) => ({ op: "removed", text })),
      ...afterTokens.map((text) => ({ op: "added", text }))
    ];
  }

  const width = afterTokens.length + 1;
  const table = new Uint32Array((beforeTokens.length + 1) * width);

  for (let i = beforeTokens.length - 1; i >= 0; i -= 1) {
    for (let j = afterTokens.length - 1; j >= 0; j -= 1) {
      const offset = i * width + j;
      if (beforeTokens[i] === afterTokens[j]) {
        table[offset] = table[(i + 1) * width + j + 1] + 1;
      } else {
        table[offset] = Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
  }

  const words = [];
  let i = 0;
  let j = 0;
  while (i < beforeTokens.length && j < afterTokens.length) {
    if (beforeTokens[i] === afterTokens[j]) {
      words.push({ op: "same", text: beforeTokens[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      words.push({ op: "removed", text: beforeTokens[i] });
      i += 1;
    } else {
      words.push({ op: "added", text: afterTokens[j] });
      j += 1;
    }
  }
  while (i < beforeTokens.length) {
    words.push({ op: "removed", text: beforeTokens[i] });
    i += 1;
  }
  while (j < afterTokens.length) {
    words.push({ op: "added", text: afterTokens[j] });
    j += 1;
  }
  return words;
}

function tokenizeWords(value) {
  return String(value).match(/\s+|[^\s]+/g) || [];
}

// --- JSON / SARIF / notebook diff (recursive, JSON-path keyed) -----------

function buildJsonKindDiff(beforeStr, afterStr, cap) {
  let beforeValue;
  let afterValue;
  try {
    beforeValue = beforeStr.trim() === "" ? undefined : JSON.parse(beforeStr);
    afterValue = afterStr.trim() === "" ? undefined : JSON.parse(afterStr);
  } catch {
    return buildLineKindDiff(beforeStr, afterStr, cap);
  }

  const state = createDiffState(cap);
  diffJsonValue("$", beforeValue, afterValue, state);
  return { kind: "json", entries: state.entries, truncated: state.truncated, summary: { ...state.counters } };
}

function diffJsonValue(path, before, after, state) {
  if (state.truncated) {
    return;
  }
  const beforeDefined = before !== undefined;
  const afterDefined = after !== undefined;

  if (!beforeDefined && !afterDefined) {
    return;
  }
  if (!beforeDefined) {
    pushEntry(state, { op: "added", path, after });
    return;
  }
  if (!afterDefined) {
    pushEntry(state, { op: "removed", path, before });
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    diffJsonArray(path, before, after, state);
    return;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    diffJsonObject(path, before, after, state);
    return;
  }
  if (!deepEqual(before, after)) {
    pushEntry(state, { op: "changed", path, before, after });
  }
}

function diffJsonObject(path, before, after, state) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (state.truncated) {
      return;
    }
    diffJsonValue(appendJsonPath(path, key), before[key], after[key], state);
  }
}

function diffJsonArray(path, before, after, state) {
  const matchKey = findArrayMatchKey(before, after);

  if (matchKey) {
    const beforeByKey = new Map(before.map((item, index) => [item[matchKey], { item, index }]));
    const afterByKey = new Map(after.map((item, index) => [item[matchKey], { item, index }]));
    const order = [];
    const seen = new Set();
    for (const item of before) {
      const key = item[matchKey];
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
    for (const item of after) {
      const key = item[matchKey];
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
    for (const key of order) {
      if (state.truncated) {
        return;
      }
      const beforeEntry = beforeByKey.get(key);
      const afterEntry = afterByKey.get(key);
      const index = beforeEntry ? beforeEntry.index : afterEntry.index;
      diffJsonValue(`${path}[${index}]`, beforeEntry?.item, afterEntry?.item, state);
    }
    return;
  }

  const maxLen = Math.max(before.length, after.length);
  for (let index = 0; index < maxLen; index += 1) {
    if (state.truncated) {
      return;
    }
    diffJsonValue(`${path}[${index}]`, before[index], after[index], state);
  }
}

function findArrayMatchKey(before, after) {
  if (before.length === 0 && after.length === 0) {
    return null;
  }
  for (const key of ARRAY_MATCH_KEYS) {
    if (arrayHasUniqueKey(before, key) && arrayHasUniqueKey(after, key)) {
      return key;
    }
  }
  return null;
}

function arrayHasUniqueKey(array, key) {
  if (array.length === 0) {
    return true;
  }
  const seen = new Set();
  for (const item of array) {
    if (!isPlainObject(item)) {
      return false;
    }
    const value = item[key];
    if (value === undefined || (typeof value !== "string" && typeof value !== "number")) {
      return false;
    }
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
  }
  return true;
}

function appendJsonPath(base, key) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return `${base}.${key}`;
  }
  return `${base}[${JSON.stringify(key)}]`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (a && b && typeof a === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

// --- CSV diff (header-aware, row/cell keyed) ------------------------------

function buildCsvKindDiff(beforeStr, afterStr, cap) {
  const beforeParsed = parseCsv(beforeStr);
  const afterParsed = parseCsv(afterStr);
  if (!beforeParsed.ok || !afterParsed.ok) {
    // Fail closed the same way the CSV renderer does: an unterminated
    // quoted field is not silently treated as a bogus single-cell row, it
    // falls through to the line diff so the same artifact doesn't render
    // as an error but diff as data.
    return null;
  }
  const beforeRows = beforeParsed.rows;
  const afterRows = afterParsed.rows;
  const state = createDiffState(cap);

  const beforeHeader = beforeRows[0] || [];
  const afterHeader = afterRows[0] || [];
  const headerWidth = Math.max(beforeHeader.length, afterHeader.length);
  for (let col = 0; col < headerWidth && !state.truncated; col += 1) {
    const b = beforeHeader[col];
    const a = afterHeader[col];
    if (b !== a) {
      pushEntry(state, { op: "changed", row: "header", column: col, before: b, after: a });
    }
  }

  const beforeData = beforeRows.slice(1);
  const afterData = afterRows.slice(1);
  const keyUnique = beforeData.length > 0 && afterData.length > 0 &&
    hasUniqueFirstColumn(beforeData) && hasUniqueFirstColumn(afterData);

  if (keyUnique) {
    diffCsvRowsByKey(beforeData, afterData, state);
  } else {
    diffCsvRowsByPosition(beforeData, afterData, state);
  }

  return { kind: "csv", entries: state.entries, truncated: state.truncated, summary: { ...state.counters } };
}

function hasUniqueFirstColumn(rows) {
  const seen = new Set();
  for (const row of rows) {
    const key = row[0];
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

function diffCsvRowsByKey(beforeData, afterData, state) {
  const beforeByKey = new Map(beforeData.map((row) => [row[0], row]));
  const afterByKey = new Map(afterData.map((row) => [row[0], row]));
  const order = [];
  const seen = new Set();
  for (const row of beforeData) {
    if (!seen.has(row[0])) {
      seen.add(row[0]);
      order.push(row[0]);
    }
  }
  for (const row of afterData) {
    if (!seen.has(row[0])) {
      seen.add(row[0]);
      order.push(row[0]);
    }
  }
  for (const key of order) {
    if (state.truncated) {
      return;
    }
    diffCsvRowPair(key, beforeByKey.get(key), afterByKey.get(key), state);
  }
}

function diffCsvRowsByPosition(beforeData, afterData, state) {
  const maxLen = Math.max(beforeData.length, afterData.length);
  for (let index = 0; index < maxLen; index += 1) {
    if (state.truncated) {
      return;
    }
    diffCsvRowPair(index, beforeData[index], afterData[index], state);
  }
}

function diffCsvRowPair(row, beforeRow, afterRow, state) {
  if (beforeRow && !afterRow) {
    pushEntry(state, { op: "removed", row, cells: beforeRow });
    return;
  }
  if (!beforeRow && afterRow) {
    pushEntry(state, { op: "added", row, cells: afterRow });
    return;
  }
  const width = Math.max(beforeRow.length, afterRow.length);
  for (let col = 0; col < width; col += 1) {
    if (state.truncated) {
      return;
    }
    if (beforeRow[col] !== afterRow[col]) {
      pushEntry(state, { op: "changed", row, column: col, before: beforeRow[col], after: afterRow[col] });
    }
  }
}

// --- Bundle diff (per-file diff using each file's own format) ------------

function buildBundleKindDiff(beforeStr, afterStr, cap) {
  let beforeBundle;
  let afterBundle;
  try {
    beforeBundle = JSON.parse(beforeStr);
    afterBundle = JSON.parse(afterStr);
  } catch {
    return null;
  }
  if (!isPlainObject(beforeBundle) || !isPlainObject(afterBundle)) {
    // A version that predates the bundle shape (or any other non-object
    // JSON) has no `.files` to diff structurally. Fall through to the line
    // diff instead of throwing on the property access below.
    return null;
  }

  const beforeFiles = Array.isArray(beforeBundle.files) ? beforeBundle.files : [];
  const afterFiles = Array.isArray(afterBundle.files) ? afterBundle.files : [];
  const beforeByPath = new Map(beforeFiles.map((file) => [file.path, file]));
  const afterByPath = new Map(afterFiles.map((file) => [file.path, file]));
  const order = [];
  const seen = new Set();
  for (const file of beforeFiles) {
    if (!seen.has(file.path)) {
      seen.add(file.path);
      order.push(file.path);
    }
  }
  for (const file of afterFiles) {
    if (!seen.has(file.path)) {
      seen.add(file.path);
      order.push(file.path);
    }
  }

  const state = createDiffState(cap);
  for (const filePath of order) {
    if (state.truncated) {
      break;
    }
    const beforeFile = beforeByPath.get(filePath);
    const afterFile = afterByPath.get(filePath);

    if (beforeFile && !afterFile) {
      pushEntry(state, { op: "removed", file: filePath });
      continue;
    }
    if (!beforeFile && afterFile) {
      pushEntry(state, { op: "added", file: filePath });
      continue;
    }
    if (beforeFile.content === afterFile.content) {
      continue;
    }

    const fileFormat = detectBundleFileFormat(afterFile) || detectBundleFileFormat(beforeFile);
    const remainingCap = state.cap - state.entries.length;
    const sub = createStructuredDiff(beforeFile.content, afterFile.content, {
      format: fileFormat,
      maxEntries: remainingCap
    });
    for (const entry of sub.entries) {
      if (state.truncated) {
        break;
      }
      if (entry.op === "same") {
        continue;
      }
      const merged = { ...entry, file: filePath, kind: sub.kind };
      const ok = pushEntry(state, merged);
      if (!ok) {
        break;
      }
    }
    if (sub.truncated) {
      state.truncated = true;
    }
  }

  return { kind: "bundle", entries: state.entries, truncated: state.truncated, summary: { ...state.counters } };
}

function detectBundleFileFormat(file) {
  if (!file) {
    return undefined;
  }
  return detectFormat({ content: file.content || "", contentType: file.contentType || "", fileName: file.path || "" });
}
