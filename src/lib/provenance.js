import { normalizeSourceAgent } from "./agents.js";

const TOOLS = new Set(["artifacty", "claude-code", "codex", "copilot", "cursor", "gemini-cli", "chatgpt"]);
const LABELS = { "claude-code": "Claude Code", codex: "Codex", copilot: "GitHub Copilot", cursor: "Cursor", "gemini-cli": "Gemini CLI", chatgpt: "ChatGPT", artifacty: "Artifacty" };

function text(value, max = 200) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

// Tool identity is descriptive, not an authentication claim. MCP clientInfo
// is supplied by the connected client; model/provider remain self-reported.
export function normalizeProvenance(input = {}, { legacy = false } = {}) {
  const supplied = input.provenance && typeof input.provenance === "object" && !Array.isArray(input.provenance) ? input.provenance : {};
  const rawSourceAgent = text(input.sourceAgent || input.source_agent || input.agent);
  const contextTool = text(input.agentContext?.tool);
  const statedTool = text(supplied.tool);
  const toolValue = contextTool || statedTool || rawSourceAgent;
  const normalizedTool = normalizeSourceAgent(toolValue, { defaultValue: "" });
  const tool = TOOLS.has(normalizedTool) ? normalizedTool : ((contextTool || statedTool) && !["claude", "gpt", "anthropic", "openai", "google", "gemini"].includes(normalizedTool) ? normalizedTool : null);
  return {
    tool,
    provider: text(supplied.provider),
    model: text(supplied.model),
    userId: text(input.access?.userId || input.audit?.userId),
    source: legacy ? "legacy" : contextTool ? "mcp-client" : toolValue || supplied.provider || supplied.model ? "self-reported" : "unknown",
    rawSourceAgent,
    toolSource: contextTool ? "mcp-client" : toolValue ? legacy ? "legacy" : "self-reported" : "unknown",
    modelSource: text(supplied.model) ? "self-reported" : "unknown"
  };
}

export function provenanceLabel(provenance) {
  if (!provenance) return "Unknown";
  const tool = LABELS[provenance.tool] || provenance.tool || provenance.rawSourceAgent || "Unknown";
  return provenance.model ? `${tool} · ${provenance.model}` : tool;
}
