import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { readStoreIdentity, storeIdentity } from "../src/lib/server-state.js";
import { healthMatchesStore } from "../src/lib/self-update.js";
import { createMcpServerConfig, installAgent } from "../src/lib/installer.js";
import { babelRendererSupported, runDoctor } from "../src/lib/doctor.js";

async function tempHome(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test("/health identifies the store by an opaque ID instead of its path", async () => {
  const home = await tempHome("artifacty-health-id-");
  const app = await startServer({ home, port: 0 });
  try {
    const body = await (await fetch(`${app.url}/health`)).json();
    assert.equal(body.store, undefined);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(path.basename(home)));
    assert.match(body.storeId, /^[a-f0-9-]{36}$/);
    assert.equal(body.storeId, readStoreIdentity(home));
    assert.equal((await (await fetch(`${app.url}/health`)).json()).storeId, body.storeId, "the ID is stable");
    assert.equal(healthMatchesStore(body, home), true);
    assert.equal(healthMatchesStore(body, await tempHome("artifacty-health-other-")), false);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the updater still recognizes an older server that reports its store path", async () => {
  const home = await tempHome("artifacty-health-legacy-");
  try {
    assert.equal(healthMatchesStore({ ok: true, name: "artifacty", store: home }, home), true);
    assert.equal(healthMatchesStore({ ok: true, name: "artifacty", store: "/elsewhere" }, home), false);
    assert.equal(healthMatchesStore({ ok: true, name: "other", storeId: storeIdentity(home) }, home), false);
    assert.equal(healthMatchesStore({ ok: true, name: "artifacty", storeId: "00000000-0000-0000-0000-000000000000" }, home), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install does not write a shell token into a config for an explicit --mcp-url", async () => {
  const projectDir = await tempHome("artifacty-install-token-");
  const previous = process.env.ARTIFACTY_API_TOKEN;
  process.env.ARTIFACTY_API_TOKEN = "token-for-another-server";
  try {
    const remote = createMcpServerConfig({ projectDir, mcpUrl: "http://10.0.0.60:8787/mcp" });
    assert.equal(remote.env.ARTIFACTY_API_TOKEN, undefined);
    const explicit = createMcpServerConfig({ projectDir, mcpUrl: "http://10.0.0.60:8787/mcp", apiToken: "issued-by-that-server" });
    assert.equal(explicit.env.ARTIFACTY_API_TOKEN, "issued-by-that-server");
    const local = createMcpServerConfig({ projectDir });
    assert.equal(local.env.ARTIFACTY_API_TOKEN, "token-for-another-server", "a local install keeps the shell token it shares a context with");

    const result = await installAgent("claude", { projectDir, serverPath: path.join(projectDir, "src", "mcp-server.js"), mcpUrl: "http://10.0.0.60:8787/mcp" });
    assert.match(result.warnings[0], /--api-token/);
    const written = await readFile(path.join(projectDir, ".mcp.json"), "utf8");
    assert.doesNotMatch(written, /token-for-another-server/);
    // userHome keeps the Codex config, which otherwise lives in the real home, inside the fixture.
    const all = await installAgent("all", { projectDir, serverPath: path.join(projectDir, "src", "mcp-server.js"), mcpUrl: "http://10.0.0.60:8787/mcp", userHome: projectDir });
    assert.match(all.warnings[0], /--api-token/);
    assert.doesNotMatch(await readFile(path.join(projectDir, ".codex", "config.toml"), "utf8"), /token-for-another-server/);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTY_API_TOKEN; else process.env.ARTIFACTY_API_TOKEN = previous;
    await rm(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the favicon is served as SVG and linked from pages", async () => {
  const home = await tempHome("artifacty-favicon-");
  const app = await startServer({ home, port: 0 });
  try {
    for (const route of ["/favicon.svg", "/favicon.ico"]) {
      const response = await fetch(app.url + route);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get("content-type"), "image/svg+xml");
      assert.match(await response.text(), /^<svg /);
    }
    assert.match(await (await fetch(`${app.url}/login`)).text(), /<link rel="icon" href="\/favicon\.svg"/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("doctor reads the Node floor from package.json and reports the React renderer", async () => {
  const home = await tempHome("artifacty-doctor-renderer-");
  const packageRoot = await tempHome("artifacty-doctor-package-");
  const previous = process.env.ARTIFACTY_ENABLE_REACT_RENDERER;
  try {
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ version: "9.9.9", engines: { node: ">=99.0.0" } }));
    const old = await runDoctor({ home, packageRoot, skipMcp: true });
    assert.equal(old.checks.find((check) => check.name === "runtime").status, "fail");

    process.env.ARTIFACTY_ENABLE_REACT_RENDERER = "true";
    const report = await runDoctor({ home, packageRoot, skipMcp: true });
    const renderers = report.checks.find((check) => check.name === "renderers");
    assert.equal(renderers.status, "warn", "no Babel package exists in this fake package root");
    assert.equal(renderers.data.reactRendererEnabled, true);
    assert.equal(babelRendererSupported("22.16.0"), false);
    assert.equal(babelRendererSupported("22.18.0"), true);
    assert.equal(babelRendererSupported("24.10.0"), false);
    assert.equal(babelRendererSupported("24.11.0"), true);
    assert.equal(babelRendererSupported("26.0.0"), true);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTY_ENABLE_REACT_RENDERER; else process.env.ARTIFACTY_ENABLE_REACT_RENDERER = previous;
    await rm(home, { recursive: true, force: true });
    await rm(packageRoot, { recursive: true, force: true });
  }
});
