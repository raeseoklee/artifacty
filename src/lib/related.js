import { listArtifactsPage } from "./storage.js";

// Finds artifacts that a new artifact may relate to, so an agent can ask the
// person whether to link one as a reference or publish the new content as a
// new version of it. Candidates are limited to the caller's own artifacts
// when the caller is a known user, and always to what the caller may read.
//
// The ranking is deliberately simple and explainable: title-token overlap,
// shared tags, and, when an embedding provider is configured, the search
// index's own semantic or hybrid ranking for the title and an excerpt.

const MAX_LIMIT = 10;
const DEFAULT_LIMIT = 5;
const POOL_PER_QUERY = 20;
const MAX_TOKEN_QUERIES = 6;
const MIN_SCORE = 0.2;
const SAME_DOCUMENT_SCORE = 0.8;

export function titleTokens(value) {
  return [...new Set(String(value || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2))];
}

function overlap(left, right) {
  if (!left.length || !right.length) return 0;
  const set = new Set(right);
  const shared = left.filter((token) => set.has(token)).length;
  return shared / new Set([...left, ...right]).size;
}

function normalizedTitle(value) {
  return titleTokens(value).join(" ");
}

export async function findRelatedArtifacts(store, input = {}, { access, excludeIds = [], embeddingProvider } = {}) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw Object.assign(new Error("title is required"), { code: "INVALID_INPUT", statusCode: 400 });
  const tags = Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean).slice(0, 20) : [];
  const excerpt = typeof input.content === "string" ? input.content.slice(0, 2000) : "";
  const limit = Math.min(Math.max(Number.isSafeInteger(input.limit) ? input.limit : DEFAULT_LIMIT, 1), MAX_LIMIT);
  const ownerUserId = access?.userId || undefined;
  const excluded = new Set(excludeIds);

  const pool = new Map();
  const semanticRank = new Map();
  const collect = async (filters, { semantic = false } = {}) => {
    let page;
    try {
      page = await listArtifactsPage(store, { ...filters, ownerUserId, access, limit: POOL_PER_QUERY, embeddingProvider });
    } catch {
      return;
    }
    page.artifacts.forEach((artifact, index) => {
      if (excluded.has(artifact.id)) return;
      pool.set(artifact.id, artifact);
      if (semantic && ["semantic", "hybrid"].includes(page.search?.mode) && !semanticRank.has(artifact.id)) {
        semanticRank.set(artifact.id, index);
      }
    });
  };

  const tokens = titleTokens(title);
  await collect({ query: title, mode: "keyword" });
  for (const token of tokens.slice(0, MAX_TOKEN_QUERIES)) await collect({ query: token, mode: "keyword" });
  for (const tag of tags.slice(0, 5)) await collect({ tag });
  await collect({ query: [title, excerpt].filter(Boolean).join("\n").slice(0, 2000) }, { semantic: true });

  const sameTitle = normalizedTitle(title);
  const candidates = [...pool.values()].map((artifact) => {
    const titleScore = overlap(tokens, titleTokens(artifact.title));
    const tagScore = overlap(tags, (artifact.tags || []).map((tag) => String(tag).toLowerCase()));
    const rank = semanticRank.get(artifact.id);
    const semanticScore = rank === undefined ? 0 : 1 - rank / POOL_PER_QUERY;
    const exactTitle = normalizedTitle(artifact.title) === sameTitle;
    const score = exactTitle ? 1 : Math.min(1, titleScore * 0.6 + tagScore * 0.25 + semanticScore * 0.3);
    const matched = [titleScore > 0 && "title", tagScore > 0 && "tags", rank !== undefined && "semantic"].filter(Boolean);
    return { artifact, score, matched, likelySameDocument: exactTitle || titleScore >= SAME_DOCUMENT_SCORE };
  })
    .filter((candidate) => candidate.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || String(b.artifact.updatedAt).localeCompare(String(a.artifact.updatedAt)))
    .slice(0, limit);

  return candidates.map(({ artifact, score, matched, likelySameDocument }) => ({
    id: artifact.id,
    title: artifact.title,
    artifactType: artifact.artifactType,
    format: artifact.format,
    latestVersion: artifact.latestVersion,
    updatedAt: artifact.updatedAt,
    tags: artifact.tags || [],
    score: Math.round(score * 100) / 100,
    matched,
    likelySameDocument
  }));
}

// What the agent should do with the candidates. Kept beside the lookup so
// every surface gives the same instruction.
export const RELATED_NEXT_STEPS = "Ask the person before acting, and offer three choices: link one or more candidates as references (artifacty_create with references: [ids], or artifacty_link with relation \"references\" after creating), publish the content as a new version of one candidate (artifacty_update with its id; prefer this when likelySameDocument is true), or create a separate artifact with no link. Do not choose for the person.";
