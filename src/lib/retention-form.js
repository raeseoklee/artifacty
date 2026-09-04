// Shared parsing for the per-artifact-type archiveAfterDays override, used
// by both the browser retention form (src/server.js, one `type=days` pair
// per line in a textarea) and the CLI (src/cli.js, one `--archive-after-
// days-for type=days` flag per pair). Both adapters previously hand-rolled
// their own copy of this loop.
export function parseArchiveAfterDaysPairs(entries, { base = {}, onInvalid } = {}) {
  const byType = { ...base };
  for (const raw of entries || []) {
    const line = String(raw ?? "");
    if (!line.trim()) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      if (onInvalid) {
        onInvalid(line);
      }
      continue;
    }
    const type = line.slice(0, separatorIndex).trim();
    const days = line.slice(separatorIndex + 1).trim();
    if (!type || !days) {
      if (onInvalid) {
        onInvalid(line);
      }
      continue;
    }
    byType[type] = Number(days);
  }
  return byType;
}
