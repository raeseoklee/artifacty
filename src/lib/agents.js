export const KNOWN_SOURCE_AGENTS = new Set([
  "artifacty",
  "claude",
  "codex",
  "copilot",
  "cursor",
  "gemini",
  "generic",
  "mcp",
  "unknown"
]);

const SOURCE_AGENT_ALIASES = new Map([
  ["anthropic", "claude"],
  ["claude-ai", "claude"],
  ["claude-code", "claude"],
  ["claude-code-cli", "claude"],
  ["claude_cli", "claude"],
  ["github-copilot", "copilot"],
  ["copilot-chat", "copilot"],
  ["vscode-copilot", "copilot"],
  ["vs-code-copilot", "copilot"],
  ["cursor-ai", "cursor"],
  ["gemini-cli", "gemini"],
  ["google", "gemini"],
  ["openai", "codex"],
  ["openai-codex", "codex"],
  ["codex-cli", "codex"],
  ["chatgpt", "codex"]
]);

export function normalizeSourceAgent(value, options = {}) {
  const defaultValue = options.defaultValue ?? "unknown";
  const allowAuto = options.allowAuto === true;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (normalized === "auto") {
    return allowAuto ? "auto" : defaultValue;
  }
  const slug = normalized.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const canonical = SOURCE_AGENT_ALIASES.get(normalized) || SOURCE_AGENT_ALIASES.get(slug) || slug;
  if (KNOWN_SOURCE_AGENTS.has(canonical)) {
    return canonical;
  }
  return canonical || defaultValue;
}

export function isUnknownSourceAgent(value) {
  const normalized = normalizeSourceAgent(value, { defaultValue: "unknown" });
  return normalized === "unknown" || normalized === "generic" || normalized === "auto";
}
