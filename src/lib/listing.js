// Shared list/pagination presentation helpers used by the CLI JSON output,
// the HTTP JSON API, and the server-rendered dashboard, so the three
// surfaces group and paginate artifacts identically.

export const GROUP_BY_VALUES = ["artifactType", "sourceAgent", "day"];

// Computes the presentational group key for one artifact under a
// `--group-by`/`groupBy` value. Purely presentational: it never changes
// which artifacts were fetched, only how an already-fetched page is
// labeled/bucketed.
export function groupKeyFor(artifact, groupBy) {
  if (groupBy === "sourceAgent") {
    return artifact.sourceAgent || "unknown";
  }
  if (groupBy === "day") {
    return (artifact.createdAt || "").slice(0, 10) || "unknown";
  }
  return artifact.artifactType || "document";
}

// Groups an already-fetched page of artifacts into { [key]: [artifactId] }
// for JSON-facing surfaces (CLI `artifacty list --group-by`, HTTP API).
export function groupArtifactIds(artifacts, groupBy) {
  const groups = {};
  for (const artifact of artifacts) {
    const key = groupKeyFor(artifact, groupBy);
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(artifact.id);
  }
  return groups;
}

// Normalizes a storage listArtifactsPage() result into the pagination
// envelope shared by the CLI JSON output and the HTTP JSON API.
export function paginationJson(page) {
  return {
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    hasMore: page.hasMore,
    nextOffset: page.nextOffset,
    previousOffset: page.previousOffset
  };
}
