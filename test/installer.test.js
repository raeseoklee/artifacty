import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpServerConfig, installAgent, replaceTomlBlock } from "../src/lib/installer.js";

test("installs Claude and Gemini project MCP config files", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "artifacty-install-"));
  try {
    const claude = await installAgent("claude", {
      projectDir,
      serverPath: path.join(projectDir, "src", "mcp-server.js"),
      url: "http://127.0.0.1:8787"
    });
    assert.equal(claude.agent, "claude");
    assert.equal(claude.changed, true);

    const claudeJson = JSON.parse(await readFile(path.join(projectDir, ".mcp.json"), "utf8"));
    assert.equal(claudeJson.mcpServers.artifacty.command, "node");
    assert.equal(claudeJson.mcpServers.artifacty.env.ARTIFACTY_URL, "http://127.0.0.1:8787");
    assert.equal("timeout" in claudeJson.mcpServers.artifacty, false);

    const gemini = await installAgent("gemini", {
      projectDir,
      serverPath: path.join(projectDir, "src", "mcp-server.js")
    });
    assert.equal(gemini.agent, "gemini");

    const geminiJson = JSON.parse(await readFile(path.join(projectDir, ".gemini", "settings.json"), "utf8"));
    assert.equal(geminiJson.mcpServers.artifacty.timeout, 30000);
    assert.equal(geminiJson.mcpServers.artifacty.trust, false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("applies install timeout where agent configs support it", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "artifacty-install-timeout-"));
  try {
    const codexConfigPath = path.join(projectDir, "config.toml");
    await installAgent("codex", {
      projectDir,
      configPath: codexConfigPath,
      serverPath: path.join(projectDir, "src", "mcp-server.js"),
      timeout: 45000
    });
    const codexConfig = await readFile(codexConfigPath, "utf8");
    assert.match(codexConfig, /startup_timeout_sec = 45\.0/);

    await installAgent("gemini", {
      projectDir,
      serverPath: path.join(projectDir, "src", "mcp-server.js"),
      timeout: 45000
    });
    const geminiJson = JSON.parse(await readFile(path.join(projectDir, ".gemini", "settings.json"), "utf8"));
    assert.equal(geminiJson.mcpServers.artifacty.timeout, 45000);

    await installAgent("claude", {
      projectDir,
      serverPath: path.join(projectDir, "src", "mcp-server.js"),
      timeout: 45000
    });
    const claudeJson = JSON.parse(await readFile(path.join(projectDir, ".mcp.json"), "utf8"));
    assert.equal("timeout" in claudeJson.mcpServers.artifacty, false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("installs Codex MCP config block without duplicating it", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "artifacty-codex-install-"));
  try {
    const configPath = path.join(projectDir, "config.toml");
    await installAgent("codex", {
      projectDir,
      configPath,
      serverPath: path.join(projectDir, "src", "mcp-server.js"),
      home: path.join(projectDir, "store")
    });
    await installAgent("codex", {
      projectDir,
      configPath,
      serverPath: path.join(projectDir, "src", "mcp-server.js"),
      home: path.join(projectDir, "store")
    });

    const content = await readFile(configPath, "utf8");
    assert.equal(content.match(/\[mcp_servers\.artifacty\]/g).length, 1);
    assert.match(content, /startup_timeout_sec = 30\.0/);
    assert.match(content, /ARTIFACTY_HOME/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("replaces existing TOML server block", () => {
  const next = replaceTomlBlock("[mcp_servers.artifacty]\ncommand = \"old\"\n\n[features]\njs_repl = false\n", "mcp_servers.artifacty", "[mcp_servers.artifacty]\ncommand = \"new\"\n");
  assert.match(next, /command = "new"/);
  assert.doesNotMatch(next, /command = "old"/);
  assert.match(next, /\[features\]/);
});

test("uses packageDir for MCP server path when installing from another project", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "artifacty-install-project-"));
  const packageDir = await mkdtemp(path.join(tmpdir(), "artifacty-install-package-"));
  try {
    const config = createMcpServerConfig({ projectDir, packageDir });
    assert.equal(config.args[0], path.join(packageDir, "src", "mcp-server.js"));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(packageDir, { recursive: true, force: true });
  }
});

test("does not pin ARTIFACTY_URL unless explicitly configured", async () => {
  const originalUrl = process.env.ARTIFACTY_URL;
  const projectDir = await mkdtemp(path.join(tmpdir(), "artifacty-install-url-"));
  try {
    delete process.env.ARTIFACTY_URL;
    const discovered = createMcpServerConfig({ projectDir });
    assert.equal("ARTIFACTY_URL" in discovered.env, false);

    const pinned = createMcpServerConfig({
      projectDir,
      url: "http://127.0.0.1:9000"
    });
    assert.equal(pinned.env.ARTIFACTY_URL, "http://127.0.0.1:9000");
  } finally {
    if (originalUrl === undefined) {
      delete process.env.ARTIFACTY_URL;
    } else {
      process.env.ARTIFACTY_URL = originalUrl;
    }
    await rm(projectDir, { recursive: true, force: true });
  }
});
