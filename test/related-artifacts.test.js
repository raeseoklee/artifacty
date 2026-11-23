import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { createApiToken, createArtifact, createUser, getArtifact } from "../src/lib/storage.js";
import { findRelatedArtifacts, titleTokens } from "../src/lib/related.js";

async function mcpCall(url, token, method, params = {}) {
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  return (await response.json()).result;
}
const callTool = async (url, token, name, args) => (await mcpCall(url, token, "tools/call", { name, arguments: args })).structuredContent;

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-related-"));
  const app = await startServer({ port: 0, home, mcpHttp: true });
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const owner = await createUser(app.store, { email: "owner@example.test", name: "Owner", role: "user", password: "password-123" });
  const other = await createUser(app.store, { email: "other@example.test", name: "Other", role: "user", password: "password-123" });
  const mine = { userId: owner.id, role: "user" };
  const theirs = { userId: other.id, role: "user" };
  const log = await createArtifact(app.store, { title: "OG 로그 데이터 정리", content: "# 로그", format: "markdown", sourceAgent: "test", tags: ["og", "log"], ownerUserId: owner.id, visibility: "team" }, { access: mine });
  const metrics = await createArtifact(app.store, { title: "OG 사용자 분석 지표", content: "# 지표", format: "markdown", sourceAgent: "test", tags: ["og", "kpi"], ownerUserId: owner.id, visibility: "team" }, { access: mine });
  const unrelated = await createArtifact(app.store, { title: "Weekly lunch menu", content: "# Menu", format: "markdown", sourceAgent: "test", tags: ["food"], ownerUserId: owner.id, visibility: "team" }, { access: mine });
  const foreign = await createArtifact(app.store, { title: "OG 로그 데이터 정리", content: "# Theirs", format: "markdown", sourceAgent: "test", tags: ["og"], ownerUserId: other.id, visibility: "team" }, { access: theirs });
  const token = (await createApiToken(app.store, owner.id, { name: "agent", scopes: ["read", "write"] })).token;
  const readOnly = (await createApiToken(app.store, owner.id, { name: "reader", scopes: ["read"] })).token;
  return { app, owner, mine, log, metrics, unrelated, foreign, token, readOnly };
}

test("title tokens ignore punctuation and single characters in any script", () => {
  assert.deepEqual(titleTokens("OG 로그 데이터 정리 — v2 (a)"), ["og", "로그", "데이터", "정리", "v2"]);
});

test("related artifacts are the caller's own, ranked, and flag a likely same document", async (t) => {
  const { app, mine, log, metrics, unrelated, foreign } = await fixture(t);
  const candidates = await findRelatedArtifacts(app.store, { title: "OG 로그 데이터 정리", tags: ["og"] }, { access: mine });
  const ids = candidates.map((item) => item.id);
  assert.equal(ids[0], log.id, "the exact title ranks first");
  assert.equal(candidates[0].likelySameDocument, true);
  assert.ok(ids.includes(metrics.id), "a shared tag and title token make a candidate");
  assert.equal(candidates.find((item) => item.id === metrics.id).likelySameDocument, false);
  assert.ok(!ids.includes(unrelated.id), "unrelated artifacts stay out");
  assert.ok(!ids.includes(foreign.id), "another person's artifact is not offered");
  assert.ok(candidates.every((item) => item.score >= 0.2 && item.score <= 1 && Array.isArray(item.matched)));
  assert.deepEqual(await findRelatedArtifacts(app.store, { title: "OG 로그 데이터 정리" }, { access: mine, excludeIds: [log.id, metrics.id] }), []);
  await assert.rejects(findRelatedArtifacts(app.store, { title: " " }, { access: mine }), { code: "INVALID_INPUT" });
});

test("MCP offers artifacty_find_related to read-only tokens and tells agents to ask first", async (t) => {
  const { app, log, readOnly } = await fixture(t);
  const init = await mcpCall(app.url, readOnly, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.match(init.instructions, /artifacty_find_related[\s\S]*ask the person/);
  const tools = (await mcpCall(app.url, readOnly, "tools/list")).tools;
  const tool = tools.find((item) => item.name === "artifacty_find_related");
  assert.ok(tool, "read-only tokens can look up related artifacts");
  assert.equal(tool.annotations.readOnlyHint, true);
  const result = await callTool(app.url, readOnly, "artifacty_find_related", { title: "OG 로그 데이터 정리" });
  assert.equal(result.candidates[0].id, log.id);
  assert.match(result.candidates[0].url, new RegExp(`/artifacts/${log.id}$`));
  assert.match(result.nextSteps, /references[\s\S]*new version[\s\S]*separate/);
  const none = await callTool(app.url, readOnly, "artifacty_find_related", { title: "Completely different subject zzz" });
  assert.deepEqual(none.candidates, []);
  assert.match(none.nextSteps, /without asking/);
});

test("artifacty_create links chosen references and otherwise lists related candidates", async (t) => {
  const { app, mine, log, metrics, token } = await fixture(t);
  const linked = await callTool(app.url, token, "artifacty_create", { title: "OG 로그 보고서", content: "# 보고서", format: "markdown", references: [log.id, metrics.id, log.id] });
  assert.equal(linked.relatedCandidates, undefined, "a person who chose references is not asked again");
  const relations = (await getArtifact(app.store, linked.id, { access: mine })).relations;
  const outgoing = (relations.outgoing || relations).filter((item) => (item.relationType || item.relation) === "references").map((item) => item.artifactId);
  assert.deepEqual(outgoing.sort(), [log.id, metrics.id].sort());

  const unlinked = await callTool(app.url, token, "artifacty_create", { title: "OG 로그 데이터 정리 2차", content: "# 2차", format: "markdown", tags: ["og"] });
  assert.ok(unlinked.relatedCandidates.some((item) => item.id === log.id));
  assert.ok(!unlinked.relatedCandidates.some((item) => item.id === unlinked.id), "the new artifact is not its own candidate");
  assert.match(unlinked.relatedNextSteps, /references[\s\S]*artifacty_update/);

  const skipped = await callTool(app.url, token, "artifacty_create", { title: "OG 로그 데이터 정리 3차", content: "# 3차", format: "markdown", skipRelatedCheck: true });
  assert.equal(skipped.relatedCandidates, undefined);
  const legacy = await callTool(app.url, token, "artifacty_publish", { title: "OG 로그 데이터 정리 4차", content: "# 4차", format: "markdown" });
  assert.equal(legacy.relatedCandidates, undefined, "the legacy alias keeps its original result");
});
