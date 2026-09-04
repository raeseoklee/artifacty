// Single shared CSV parser used by the CSV renderer (render.js), the CSV
// diff (diff.js), and the SARIF/CSV export route (sarif-csv-export.js). All
// three previously carried byte-identical copies of this state machine that
// had already diverged in behavior on malformed input (an unterminated
// quoted field): the render.js copy failed closed while the diff.js copy
// silently emitted a bogus single-cell row for the same input, so the same
// artifact rendered as an error but diffed as data. This module is the one
// source of truth: it always fails closed on an unterminated quoted field.
export function parseCsv(content) {
  const text = String(content || "");
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\"") {
      if (inQuotes && text[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.length > 1 || row[0] !== "") {
        rows.push(row);
      }
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (inQuotes) {
    return { ok: false, error: "unterminated quoted field", rows: [] };
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== "") {
    rows.push(row);
  }
  return { ok: true, rows };
}
