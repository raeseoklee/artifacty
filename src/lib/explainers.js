// Explainers are declarative content, never executable code or generated measurements.
export const MAX_EXPLAINER_BYTES = 1000000;
const fail = (message) => { throw Object.assign(new Error(message), { code: "INVALID_EXPLAINER", statusCode: 400 }); };
const object = (value, name, allowed) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(`${name} contains an unsupported field`);
};
const string = (value, name, max, required = true) => {
  if (!required && value === undefined) return "";
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) fail(`${name} must be ${required ? "nonempty text" : "text"} (maximum ${max} characters)`);
  return value;
};
const identifier = (value, name) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail(`${name} must contain 1–80 letters, numbers, underscores or hyphens`);
  return value;
};

export function parseExplainer(content) {
  if (typeof content === "string" && Buffer.byteLength(content, "utf8") > MAX_EXPLAINER_BYTES) fail("Explainer content is too large");
  let value;
  try { value = typeof content === "string" ? JSON.parse(content) : content; } catch { fail("Explainer content must be valid JSON"); }
  object(value, "Explainer", ["schemaVersion", "goal", "summary", "limitations", "blocks"]);
  if (value.schemaVersion !== 1) fail("Unsupported explainer schema version");
  const goal = string(value.goal, "Goal", 500);
  const summary = string(value.summary, "Summary", 5000, false);
  const limits = value.limitations ?? [];
  if (!Array.isArray(limits) || limits.length > 20) fail("Limitations must contain at most 20 entries");
  const limitations = limits.map((entry) => string(entry, "Limitation", 1000));
  if (!Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > 20) fail("Explainer must contain 1–20 blocks");
  const blockIds = new Set();
  let itemCount = 0;
  const blocks = value.blocks.map((block) => {
    object(block, "Block", ["id", "title", "type", "items", "connections", "parameter", "diagram"]);
    const id = identifier(block.id, "Block ID");
    if (blockIds.has(id)) fail("Block IDs must be unique");
    blockIds.add(id);
    const title = string(block.title, "Block title", 200);
    const type = block.type;
    if (!["steps", "compare", "diagram", "scenarios"].includes(type)) fail("Unsupported explainer block type");
    if (!Array.isArray(block.items) || block.items.length < (type === "scenarios" ? 2 : 1) || block.items.length > 40) fail("Block has an invalid number of items (maximum 40; scenarios require at least 2)");
    const itemIds = new Set();
    let previousValue = -Infinity;
    const items = block.items.map((item) => {
      if (++itemCount > 200) fail("Explainer may contain at most 200 items");
      object(item, "Item", ["id", "label", "explanation", "basis", "citation", "value"]);
      const itemId = identifier(item.id, "Item ID");
      if (itemIds.has(itemId)) fail("Item IDs must be unique within a block");
      itemIds.add(itemId);
      const result = { id: itemId, label: string(item.label, "Item label", 200), explanation: string(item.explanation, "Explanation", 10000), basis: item.basis };
      if (!["source", "interpretation", "assumption"].includes(item.basis)) fail("Item basis must be source, interpretation or assumption");
      if (item.citation !== undefined) result.citation = string(item.citation, "Citation", 1000);
      if (item.basis === "source" && !result.citation) fail("Source-based items require a citation");
      if (type === "scenarios") {
        if (typeof item.value !== "number" || !Number.isFinite(item.value) || item.value <= previousValue) fail("Scenario values must be finite and strictly increasing");
        previousValue = item.value;
        result.value = item.value;
      } else if (item.value !== undefined) fail("Only scenario items may have values");
      return result;
    });
    const result = { id, title, type, items };
    if (type === "diagram") {
      const links = block.connections ?? [];
      if (!Array.isArray(links) || links.length > 100) fail("Diagram may contain at most 100 connections");
      const keys = new Set();
      result.connections = links.map((link) => {
        object(link, "Connection", ["from", "to", "label"]);
        if (!itemIds.has(link.from) || !itemIds.has(link.to) || link.from === link.to) fail("Connection endpoints must reference distinct items in this block");
        const key = `${link.from}:${link.to}`;
        if (keys.has(key)) fail("Duplicate diagram connection");
        keys.add(key);
        return { from: link.from, to: link.to, label: string(link.label, "Connection label", 200, false) };
      });
      if (block.diagram !== undefined) {
        object(block.diagram, "Diagram navigation", ["direction", "start"]);
        if (!["LR", "TB"].includes(block.diagram.direction)) fail("Diagram direction must be LR or TB");
        const start = identifier(block.diagram.start, "Diagram start");
        if (!itemIds.has(start)) fail("Diagram start must reference an item in this block");
        result.diagram = { direction: block.diagram.direction, start };
      }
    } else {
      if (block.connections !== undefined) fail("Only diagram blocks may have connections");
      if (block.diagram !== undefined) fail("Only diagram blocks may have diagram navigation");
    }
    if (type === "scenarios") {
      object(block.parameter, "Scenario parameter", ["label", "unit"]);
      result.parameter = { label: string(block.parameter.label, "Parameter label", 200), unit: string(block.parameter.unit, "Parameter unit", 40, false) };
    } else if (block.parameter !== undefined) fail("Only scenario blocks may have a parameter");
    return result;
  });
  const normalized = { schemaVersion: 1, goal, summary, limitations, blocks };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_EXPLAINER_BYTES) fail("Explainer content is too large");
  return normalized;
}

export function explainerSearchText(content) {
  const value = parseExplainer(content);
  return [value.goal, value.summary, ...value.limitations, ...value.blocks.flatMap((block) => [block.title, block.parameter?.label || "", ...block.items.flatMap((item) => [item.label, item.explanation, item.citation || ""]), ...(block.connections || []).map((link) => link.label)])].join("\n");
}

// This draft only arranges excerpts. It does not claim to interpret figures,
// infer causality, or simulate a process from a screenshot.
export function createExplainerDraft(artifact) {
  const format = artifact.version?.format || artifact.format;
  if (!["markdown", "text"].includes(format) || typeof artifact.content !== "string") {
    throw Object.assign(new Error("Automatic excerpt drafts support Markdown and text. Create an authored explainer for other formats."), { code: "UNSUPPORTED_EXPLAINER_SOURCE", statusCode: 400 });
  }
  const lines = artifact.content.split(/\r?\n/);
  const items = [];
  let heading = "Source excerpt";
  let start = 0;
  let paragraph = [];
  let fence = null;
  const flush = () => {
    if (!paragraph.length || items.length >= 12) { paragraph = []; return; }
    const excerpt = paragraph.join("\n");
    // Do not truncate sentences: omit oversized excerpts from the starter.
    if (excerpt.length <= 10000 && excerpt.trim()) items.push({ id: `excerpt-${items.length + 1}`, label: heading.slice(0, 200), explanation: excerpt, basis: "source", citation: `Lines ${start + 1}–${start + paragraph.length}` });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    if (format === "markdown") {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index]);
      if (fence) {
        paragraph.push(lines[index]);
        if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) { fence = null; flush(); }
        continue;
      }
      if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
        flush();
        fence = { character: marker[1][0], length: marker[1].length };
        start = index;
        paragraph.push(lines[index]);
        continue;
      }
    }
    const match = format === "markdown" && /^(#{1,6})\s+(.+)$/.exec(lines[index]);
    if (match) { flush(); heading = match[2]; continue; }
    if (!lines[index].trim()) { flush(); continue; }
    if (!paragraph.length) start = index;
    paragraph.push(lines[index]);
  }
  flush();
  if (!items.length) throw Object.assign(new Error("The source has no suitable text excerpts. Write an explainer using its content instead."), { code: "UNSUPPORTED_EXPLAINER_SOURCE", statusCode: 400 });
  return parseExplainer({ schemaVersion: 1, goal: `Understand ${artifact.title || "the source"}`.slice(0, 500), summary: "A starter arranged from source excerpts. Review the order and add explanations before sharing.", limitations: ["This draft is not an AI-generated explanation. It contains up to 12 source excerpts and may omit content.", "Excerpt order does not establish causality or a sequence of operations."], blocks: [{ id: "source-excerpts", title: "Read the source in parts", type: "steps", items }] });
}
