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
