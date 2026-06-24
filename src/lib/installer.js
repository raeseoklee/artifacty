import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SUPPORTED_AGENTS = new Set(["all", "claude", "codex", "gemini"]);

export async function installAgent(agent, options = {}) {
  const normalized = normalizeAgent(agent);
  if (!SUPPORTED_AGENTS.has(normalized)) {
    throw new Error(`Unsupported agent: ${agent}`);
  }

  if (normalized === "all") {
    const results = [];
    for (const target of ["claude", "codex", "gemini"]) {
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
  return installGemini(options);
}

export function createMcpServerConfig(options = {}) {
  const serverRoot = path.resolve(options.packageDir || options.projectDir || process.cwd());
  const serverPath = path.resolve(options.serverPath || path.join(serverRoot, "src", "mcp-server.js"));
  const env = {};

  if (options.url || process.env.ARTIFACTY_URL) {
    env.ARTIFACTY_URL = options.url || process.env.ARTIFACTY_URL;
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
        timeout: options.timeout || 30000,
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

export async function installCodex(options = {}) {
  const targetPath = path.resolve(options.configPath || path.join(homedir(), ".codex", "config.toml"));
  const existing = await readTextFile(targetPath, "");
  const block = codexTomlBlock(createMcpServerConfig(options));
  const next = replaceTomlBlock(existing, "mcp_servers.artifacty", block);

  return writeInstallFile({
    agent: "codex",
    path: targetPath,
    dryRun: options.dryRun,
    content: next
  });
}

export function codexTomlBlock(config) {
  const envPairs = Object.entries(config.env || {})
    .map(([key, value]) => `${key} = ${quoteTomlString(value)}`)
    .join(", ");

  return [
    "[mcp_servers.artifacty]",
    `command = ${quoteTomlString(config.command)}`,
    `args = [${config.args.map(quoteTomlString).join(", ")}]`,
    "startup_timeout_sec = 5.0",
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
  return String(agent || "").trim().toLowerCase();
}

function quoteTomlString(value) {
  return JSON.stringify(String(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
