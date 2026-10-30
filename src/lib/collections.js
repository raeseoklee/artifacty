// Collections reference existing versions; they never copy or grant access to them.
const fail = (message) => { throw Object.assign(new Error(message), { code: "INVALID_COLLECTION", statusCode: 400 }); };
export function parseCollection(content) {
  let value;
  try { value = typeof content === "string" ? JSON.parse(content) : content; } catch { fail("Collection content must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Collection must be an object");
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 50000)) fail("Collection description must be at most 50000 characters");
  if (!Array.isArray(value.sections) || value.sections.length > 50) fail("Collection must contain at most 50 sections");
  const ids = new Set();
  let count = 0;
  const sections = value.sections.map((section) => {
    if (!section || typeof section !== "object" || !/^[a-zA-Z0-9_-]{1,80}$/.test(section.id || "") || ids.has(section.id)) fail("Collection section IDs must be unique letters, numbers, underscores or hyphens");
    ids.add(section.id);
    if (typeof section.title !== "string" || !section.title.trim() || section.title.length > 200) fail("Collection section title is required (maximum 200 characters)");
    if (!Array.isArray(section.items)) fail("Collection section items must be an array");
    const items = section.items.map((item) => {
      if (++count > 200) fail("Collection may reference at most 200 artifacts");
      if (!item || typeof item !== "object" || typeof item.artifactId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(item.artifactId)) fail("Collection artifact ID is invalid");
      const version = item.version ?? "latest";
      if (version !== "latest" && (!Number.isSafeInteger(version) || version < 1)) fail("Collection version must be latest or a positive integer");
      const display = item.display ?? "card";
      if (!["inline", "card"].includes(display)) fail("Collection display must be inline or card");
      return { artifactId: item.artifactId, version, display };
    });
    return { id: section.id, title: section.title.trim(), items };
  });
  return { description: value.description || "", sections };
}

export async function resolveCollection(content, { readArtifact }) {
  const collection = parseCollection(content);
  let unavailableCount = 0;
  const sections = [];
  for (const section of collection.sections) {
    const items = [];
    for (const item of section.items) {
      try {
        const artifact = await readArtifact(item.artifactId, item.version === "latest" ? undefined : item.version);
        if (!artifact || artifact.archivedAt) { unavailableCount++; continue; }
        items.push({ ...item, artifact });
      } catch (error) {
        if ([403, 404].includes(error.statusCode) || ["FORBIDDEN", "NOT_FOUND", "ARTIFACT_NOT_FOUND", "VERSION_NOT_FOUND"].includes(error.code)) unavailableCount++;
        else throw error;
      }
    }
    sections.push({ ...section, items });
  }
  return { description: collection.description, sections, unavailableCount };
}

export function collectionContentForReader(resolved) {
  return JSON.stringify({ description: resolved.description, sections: resolved.sections.map((section) => ({ id: section.id, title: section.title, items: section.items.map(({ artifactId, version, display }) => ({ artifactId, version, display })) })) }, null, 2);
}
