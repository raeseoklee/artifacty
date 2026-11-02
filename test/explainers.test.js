import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseExplainer, createExplainerDraft, explainerSearchText } from "../src/lib/explainers.js";
import { createStore, createArtifact, updateArtifact, replaceArtifactVersion, getArtifact, contentTypeForFormat, listArtifactsPage } from "../src/lib/storage.js";

import { exportStore, importStore } from "../src/lib/backup.js";

const item = (id = "one") => ({ id, label: "First", explanation: "Heat passes from the warmer object.", basis: "source", citation: "Section 2" });
const payload = () => ({ schemaVersion: 1, goal: "Understand heat transfer", summary: "Follow the transfer", limitations: [], blocks: [{ id: "transfer", title: "Heat transfer", type: "steps", items: [item()] }] });

test("explainer normalizes all four modes without executable fields", () => {
  const value = payload();
  value.blocks.push({ id: "comparison", title: "Compare", type: "compare", items: [{ ...item(), basis: "interpretation" }] });
  value.blocks.push({ id: "graph", title: "Connections", type: "diagram", items: [item("hot"), item("cold")], connections: [{ from: "hot", to: "cold", label: "transfers heat to" }] });
  value.blocks.push({ id: "samples", title: "Samples", type: "scenarios", parameter: { label: "Time", unit: "s" }, items: [{ ...item("a"), value: 0 }, { ...item("b"), value: 5 }] });
  assert.deepEqual(parseExplainer(JSON.stringify(value)), value);
  const search = explainerSearchText(value);
  assert.match(search, /transfers heat to/);
  assert.doesNotMatch(search, /schemaVersion/);
});

test("explainer rejects malformed, unsupported and unbounded content", () => {
  for (const value of [null, "broken", [], { ...payload(), schemaVersion: 2 }, { ...payload(), script: "alert(1)" }, { ...payload(), goal: " " }, { ...payload(), blocks: [] }, { ...payload(), blocks: Array(21).fill(payload().blocks[0]) }, { ...payload(), limitations: Array(21).fill("x") }, { ...payload(), goal: "x".repeat(501) }]) assert.throws(() => parseExplainer(value), { code: "INVALID_EXPLAINER" });
  for (const mutate of [
    (v) => v.blocks.push(v.blocks[0]),
    (v) => v.blocks[0].items.push(item()),
    (v) => { v.blocks[0].items[0].citation = ""; },
    (v) => { delete v.blocks[0].items[0].citation; },
    (v) => { v.blocks[0].items[0].citation = "   "; },
    (v) => { v.blocks[0].items[0].basis = "verified"; },
    (v) => { v.blocks[0].items[0].value = 1; },
    (v) => { v.blocks[0].items[0].onclick = "run()"; },
    (v) => { v.blocks[0].id = "../escape"; },
    (v) => { v.blocks[0].items = Array.from({ length: 41 }, (_, i) => item(`i${i}`)); },
    (v) => { v.blocks = Array.from({ length: 6 }, (_, i) => ({ ...v.blocks[0], id: `b${i}`, items: Array.from({ length: 40 }, (_, j) => item(`i${j}`)) })); }
  ]) { const value = payload(); mutate(value); assert.throws(() => parseExplainer(value), { code: "INVALID_EXPLAINER" }); }
});

test("diagram edges cannot invent nodes, cross blocks, or duplicate links", () => {
  for (const connections of [[{ from: "one", to: "missing" }], [{ from: "one", to: "one" }], [{ from: "one", to: "two" }, { from: "one", to: "two" }]]) {
    const value = payload(); Object.assign(value.blocks[0], { type: "diagram", items: [item(), item("two")], connections });
    assert.throws(() => parseExplainer(value), { code: "INVALID_EXPLAINER" });
  }
});

test("scenario values represent ordered authored samples, never arbitrary formulas", () => {
  for (const values of [[0], [0, 0], [5, 1], [0, Infinity], [0, NaN], [0, "5"]]) {
    const value = payload(); Object.assign(value.blocks[0], { type: "scenarios", parameter: { label: "Time" }, items: values.map((value, i) => ({ ...item(`i${i}`), value })) });
    assert.throws(() => parseExplainer(value), { code: "INVALID_EXPLAINER" });
  }
  const value = payload(); Object.assign(value.blocks[0], { type: "scenarios", items: [{ ...item("a"), value: 0 }, { ...item("b"), value: 1 }] });
  assert.throws(() => parseExplainer(value), { code: "INVALID_EXPLAINER" });
});

test("source draft preserves excerpts and line references with explicit limits", () => {
  const source = { format: "markdown", title: "Heat", content: "# Observation\n\nHot and cold objects touch.\nHeat flows.\n\n## Result\n\nTemperature changes." };
  const draft = createExplainerDraft(source);
  assert.deepEqual(draft.blocks[0].items.map((entry) => [entry.explanation, entry.citation]), [["Hot and cold objects touch.\nHeat flows.", "Lines 3–4"], ["Temperature changes.", "Lines 8–8"]]);
  assert.ok(draft.blocks[0].items.every((entry) => entry.basis === "source" && source.content.includes(entry.explanation)));
  assert.match(draft.limitations.join(" "), /not an AI-generated explanation/);
  assert.equal(createExplainerDraft({ format: "text", content: Array.from({ length: 15 }, (_, i) => `Paragraph ${i}`).join("\n\n") }).blocks[0].items.length, 12);
  for (const source of [{ format: "image", content: "pixels" }, { format: "text", content: "" }, { format: "text", content: "x".repeat(10001) }]) assert.throws(() => createExplainerDraft(source), { code: "UNSUPPORTED_EXPLAINER_SOURCE" });
});

test("storage validates explainer creation, updates and replacement versions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-explainer-"));
  const store = createStore({ home });
  try {
    const content = JSON.stringify(payload());
    const artifact = await createArtifact(store, { title: "Heat", format: "explainer", content });
    assert.equal(artifact.version.format, "explainer");
    assert.equal(artifact.artifactType, "document");
    assert.match(contentTypeForFormat("explainer"), /application\/json/);
    assert.equal((await getArtifact(store, artifact.id)).content, content);
    await assert.rejects(createArtifact(store, { title: "Invalid", format: "explainer", content: "{}" }), { code: "INVALID_EXPLAINER" });
    await assert.rejects(updateArtifact(store, artifact.id, { format: "explainer", content: "{}" }), { code: "INVALID_EXPLAINER" });
    await assert.rejects(replaceArtifactVersion(store, artifact.id, 1, { format: "explainer", content: "{}" }), { code: "INVALID_EXPLAINER" });
    assert.equal((await getArtifact(store, artifact.id)).latestVersion, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});


test("object and JSON inputs share the UTF-8 size bound", () => {
  const value = payload();
  value.blocks = Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, title: "Large", type: "steps", items: Array.from({ length: 40 }, (_, j) => ({ ...item(`i${j}`), explanation: "한".repeat(3000) })) }));
  assert.throws(() => parseExplainer(value), { code: "INVALID_EXPLAINER" });
  assert.throws(() => parseExplainer(JSON.stringify(value)), { code: "INVALID_EXPLAINER" });
});

test("fenced source code retains headings and blank lines verbatim", () => {
  for (const fence of ["```", "~~~~"]) {
    const code = `${fence}text\n# This is code, not a heading\n\nsecond line\n${fence}`;
    const content = `# Actual heading\n\n${code}\n\nFollowing paragraph.`;
    const draft = createExplainerDraft({ version: { format: "markdown" }, title: "Fences", content });
    assert.equal(draft.blocks[0].items[0].explanation, code);
    assert.equal(draft.blocks[0].items[0].label, "Actual heading");
    assert.equal(draft.blocks[0].items[0].citation, "Lines 3–7");
    assert.equal(draft.blocks[0].items[1].explanation, "Following paragraph.");
  }
});

test("explainer content is searchable and survives backup without a source artifact", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-explainer-roundtrip-"));
  const target = await mkdtemp(path.join(tmpdir(), "artifacty-explainer-restored-"));
  try {
    const store = createStore({ home });
    const created = await createArtifact(store, { title: "Standalone explanation", format: "explainer", content: JSON.stringify(payload()) });
    assert.deepEqual((await listArtifactsPage(store, { query: "warmer" })).artifacts.map(a => a.id), [created.id]);
    assert.equal((await listArtifactsPage(store, { query: "schemaVersion" })).artifacts.length, 0);
    const changed = payload(); changed.blocks[0].items[0].explanation = "Copper is conductive.";
    const updated = await updateArtifact(store, created.id, { format: "explainer", content: JSON.stringify(changed) });
    assert.equal(updated.latestVersion, 2);
    const backup = path.join(home, "backup.json");
    await exportStore(store, backup);
    const restoredStore = createStore({ home: target });
    await importStore(restoredStore, backup);
    const restored = await getArtifact(restoredStore, created.id);
    assert.equal(restored.version.format, "explainer");
    assert.deepEqual(parseExplainer(restored.content), changed);
    assert.deepEqual((await listArtifactsPage(restoredStore, { query: "conductive" })).artifacts.map(a => a.id), [created.id]);
  } finally { await rm(home, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});

test("diagram navigation preserves explicit entry points, branches and cycles", () => {
  const value = payload();
  value.blocks[0] = { id: "request", title: "Request paths", type: "diagram", diagram: { direction: "LR", start: "cache" }, items: [item("cache"), item("hit"), item("miss")], connections: [{ from: "cache", to: "hit", label: "Reusable copy" }, { from: "cache", to: "miss", label: "No copy" }, { from: "miss", to: "cache", label: "Retry" }] };
  assert.deepEqual(parseExplainer(value), value);
  value.blocks[0].diagram.direction = "TB";
  assert.equal(parseExplainer(value).blocks[0].diagram.direction, "TB");
  for (const diagram of [{ direction: "RL", start: "cache" }, { direction: "LR", start: "missing" }, { direction: "LR", start: "../cache" }, { direction: "LR" }, { start: "cache" }, null, { direction: "LR", start: "cache", script: "run()" }]) {
    value.blocks[0].diagram = diagram;
    assert.throws(() => parseExplainer(value), { code: "INVALID_EXPLAINER" });
  }
  const other = payload(); other.blocks[0].diagram = { direction: "LR", start: "one" };
  assert.throws(() => parseExplainer(other), { code: "INVALID_EXPLAINER" });
});
