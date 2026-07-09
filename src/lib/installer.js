import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const INSTALL_TARGETS = ["claude", "codex", "gemini", "copilot", "cursor"];
const SUPPORTED_AGENTS = new Set(["all", ...INSTALL_TARGETS, "github-copilot", "vscode"]);
const DEFAULT_MCP_TIMEOUT_MS = 30000;

export async function installAgent(agent, options = {}) {
  const normalized = normalizeAgent(agent);
  if (!SUPPORTED_AGENTS.has(normalized)) {
    throw new Error(`Unsupported agent: ${agent}`);
  }

  if (normalized === "all") {
    const results = [];
    for (const target of INSTALL_TARGETS) {
      results.push(await installAgent(target, options));
    }
    return {
      agent: "all",
      results
    };
  }

  if (normalized === "claude") {
    return installClaude(options);
  }
  if (normalized === "codex") {
    return installCodex(options);
  }
  if (normalized === "gemini") {
    return installGemini(options);
  }
  if (normalized === "copilot") {
    return installCopilot(options);
  }
  return installCursor(options);
}

export function createMcpServerConfig(options = {}) {
  const serverRoot = path.resolve(options.packageDir || options.projectDir || process.cwd());
  const serverPath = path.resolve(options.serverPath || path.join(serverRoot, "src", "mcp-server.js"));
  const env = {};

  if (options.url || process.env.ARTIFACTY_URL) {
    env.ARTIFACTY_URL = options.url || process.env.ARTIFACTY_URL;
  }

  if (options.mcpUrl || process.env.ARTIFACTY_MCP_URL) {
    env.ARTIFACTY_MCP_MODE = normalizeMcpMode(options.transport || "bridge");
    env.ARTIFACTY_MCP_URL = normalizeMcpEndpoint(options.mcpUrl || process.env.ARTIFACTY_MCP_URL);
  } else if (options.transport || process.env.ARTIFACTY_MCP_MODE) {
    env.ARTIFACTY_MCP_MODE = normalizeMcpMode(options.transport || process.env.ARTIFACTY_MCP_MODE);
  }

  if (options.apiToken || process.env.ARTIFACTY_API_TOKEN) {
    env.ARTIFACTY_API_TOKEN = options.apiToken || process.env.ARTIFACTY_API_TOKEN;
  }

  if (options.home || process.env.ARTIFACTY_HOME) {
    env.ARTIFACTY_HOME = path.resolve(options.home || process.env.ARTIFACTY_HOME);
  }

  return {
    command: "node",
    args: [serverPath],
    env
  };
}

export async function installClaude(options = {}) {
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const targetPath = path.resolve(options.configPath || path.join(projectDir, ".mcp.json"));
  const existing = await readJsonFile(targetPath, {});
  const next = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers || {}),
      artifacty: createMcpServerConfig(options)
    }
  };

  return writeInstallFile({
    agent: "claude",
    path: targetPath,
    dryRun: options.dryRun,
    content: `${JSON.stringify(next, null, 2)}\n`
  });
}

export async function installGemini(options = {}) {
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const targetPath = path.resolve(options.configPath || path.join(projectDir, ".gemini", "settings.json"));
  const existing = await readJsonFile(targetPath, {});
  const next = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers || {}),
      artifacty: {
        ...createMcpServerConfig(options),
        timeout: normalizeTimeoutMs(options.timeout),
        trust: Boolean(options.trust)
      }
    }
  };

  return writeInstallFile({
    agent: "gemini",
    path: targetPath,
    dryRun: options.dryRun,
    content: `${JSON.stringify(next, null, 2)}\n`
  });
}

export async function installCopilot(options = {}) {
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const targetPath = path.resolve(options.configPath || path.join(projectDir, ".vscode", "mcp.json"));
  const existing = await readJsonFile(targetPath, {});
  const next = {
    ...existing,
    servers: {
      ...(existing.servers || {}),
      artifacty: {
        type: "stdio",
        ...createMcpServerConfig(options)
      }
    }
  };

  return writeInstallFile({
    agent: "copilot",
    path: targetPath,
    dryRun: options.dryRun,
    content: `${JSON.stringify(next, null, 2)}\n`
  });
}

export async function installCursor(options = {}) {
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const targetPath = path.resolve(options.configPath || path.join(projectDir, ".cursor", "mcp.json"));
  const existing = await readJsonFile(targetPath, {});
  const next = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers || {}),
      artifacty: createMcpServerConfig(options)
    }
  };

  return writeInstallFile({
    agent: "cursor",
    path: targetPath,
    dryRun: options.dryRun,
    content: `${JSON.stringify(next, null, 2)}\n`
  });
}

export async function installCodex(options = {}) {
  const targetPath = path.resolve(options.configPath || path.join(homedir(), ".codex", "config.toml"));
  const existing = await readTextFile(targetPath, "");
  const block = codexTomlBlock(createMcpServerConfig(options), {
    timeoutMs: normalizeTimeoutMs(options.timeout)
  });
  const next = replaceTomlBlock(existing, "mcp_servers.artifacty", block);

  return writeInstallFile({
    agent: "codex",
    path: targetPath,
    dryRun: options.dryRun,
    content: next
  });
}

export function codexTomlBlock(config, options = {}) {
  const envPairs = Object.entries(config.env || {})
    .map(([key, value]) => `${key} = ${quoteTomlString(value)}`)
    .join(", ");
  const startupTimeoutSec = normalizeTimeoutMs(options.timeoutMs) / 1000;

  return [
    "[mcp_servers.artifacty]",
    `command = ${quoteTomlString(config.command)}`,
    `args = [${config.args.map(quoteTomlString).join(", ")}]`,
    `startup_timeout_sec = ${startupTimeoutSec.toFixed(1)}`,
    `env = { ${envPairs} }`,
    ""
  ].join("\n");
}

export function replaceTomlBlock(existing, dottedName, block) {
  const trimmed = existing.trimEnd();
  const pattern = new RegExp(`\\n?\\[${escapeRegExp(dottedName)}\\][\\s\\S]*?(?=\\n\\[[^\\]]+\\]|$)`);
  if (pattern.test(trimmed)) {
    return `${trimmed.replace(pattern, `\n${block.trimEnd()}`)}\n`;
  }
  return `${trimmed}${trimmed ? "\n\n" : ""}${block}`;
}

async function writeInstallFile({ agent, path: targetPath, dryRun, content }) {
  const current = await readTextFile(targetPath, "");
  const changed = current !== content;

  if (!dryRun && changed) {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
  }

  return {
    agent,
    path: targetPath,
    changed,
    dryRun: Boolean(dryRun),
    content
  };
}

async function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) {
    return fallback;
  }

  const raw = await readTextFile(filePath, "");
  if (!raw.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${error.message}`);
  }
}

async function readTextFile(filePath, fallback) {
  if (!existsSync(filePath)) {
    return fallback;
  }
  return readFile(filePath, "utf8");
}

function normalizeAgent(agent) {
  const normalized = String(agent || "").trim().toLowerCase();
  if (normalized === "github-copilot" || normalized === "vscode") {
    return "copilot";
  }
  return normalized;
}

function normalizeTimeoutMs(value) {
  const timeout = Number(value ?? DEFAULT_MCP_TIMEOUT_MS);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_MCP_TIMEOUT_MS;
}

function normalizeMcpMode(value) {
  const mode = String(value || "bridge").trim().toLowerCase();
  if (mode === "remote") {
    return "bridge";
  }
  if (!["local", "bridge"].includes(mode)) {
    throw new Error("MCP transport must be local or bridge");
  }
  return mode;
}

function normalizeMcpEndpoint(value) {
  const parsed = new URL(value);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname || "/mcp";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function quoteTomlString(value) {
  return JSON.stringify(String(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
