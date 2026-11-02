import { createArtifact, getArtifact, countUsers } from "./storage.js";
import { parseExplainer } from "./explainers.js";

export function explainerSourceVersion(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const version = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(version) || version < 1) throw Object.assign(new Error("sourceVersion must be a positive integer"), { code: "INVALID_EXPLAINER", statusCode: 400 });
  return version;
}

// A new explanation is a private copy of authored content, not a grant to its source.
export async function createSourceExplainer(store, input, options = {}) {
  const { access, audit, agentContext } = options;
  if (typeof input.sourceId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.sourceId)) throw Object.assign(new Error("sourceId must be an artifact ID"), { code: "INVALID_EXPLAINER", statusCode: 400 });
  if (!access?.userId && await countUsers(store) > 0) throw Object.assign(new Error("A personal account is required to create a private explanation"), { code: "FORBIDDEN", statusCode: 403 });
  const source = await getArtifact(store, input.sourceId, { version: explainerSourceVersion(input.sourceVersion), access });
  const explainer = parseExplainer(input.explainer);
  return createArtifact(store, {
    title: input.title || `${source.title} — Interactive explanation`,
    content: JSON.stringify(explainer),
    format: "explainer", artifactType: "document", visibility: "private",
    sourceAgent: input.sourceAgent || "artifacty", provenance: input.provenance, agentContext,
    metadata: { explainerSourceVersion: source.version.version, explainerSourceSha256: source.version.sha256 },
    relations: [{ toId: source.id, relation: "derived-from", metadata: { explainerSourceVersion: source.version.version, explainerSourceSha256: source.version.sha256 } }],
    access, audit
  });
}
