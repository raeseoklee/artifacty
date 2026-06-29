import { readFile } from "node:fs/promises";
import path from "node:path";
import { arch, platform } from "node:os";
import { backgroundStatus } from "./background.js";
import { checkMcpTools } from "./check.js";
import { securityConfig, validateServerExposure, exposureWarning } from "./security.js";
import { serviceCommand } from "./service.js";
import { checkStoreIntegrity, createStore } from "./storage.js";

const MIN_NODE_VERSION = "22.5.0";

export async function runDoctor(options = {}) {
  const packageRoot = path.resolve(options.packageRoot || process.cwd());
  const store = createStore({ home: options.home });
  const checks = [];

  await collect(checks, "runtime", () => runtimeCheck(packageRoot));
  await collect(checks, "security", () => securityCheck(options));
  await collect(checks, "storage", () => storageCheck(store));
  await collect(checks, "server", () => serverCheck(store));
  await collect(checks, "service", () => serviceCheck(options));
  if (options.skipMcp) {
    checks.push({
      name: "mcp",
      status: "skip",
      message: "MCP discovery skipped by --skip-mcp"
    });
  } else {
    await collect(checks, "mcp", () => mcpCheck(packageRoot, options));
  }

  const failures = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");

  return {
    ok: failures.length === 0,
    checkedAt: new Date().toISOString(),
    version: await packageVersion(packageRoot),
    home: store.home,
    platform: process.platform,
    checks,
    failures: failures.map(({ name, message }) => ({ name, message })),
    warnings: warnings.map(({ name, message }) => ({ name, message }))
  };
}

async function collect(checks, name, fn) {
  try {
    checks.push({ name, ...(await fn()) });
  } catch (error) {
    checks.push({
      name,
      status: "fail",
      message: error.message,
      error: {
        name: error.name,
        code: error.code
      }
    });
  }
}

async function runtimeCheck(packageRoot) {
  const version = await packageVersion(packageRoot);
  const supported = compareVersions(process.versions.node, MIN_NODE_VERSION) >= 0;
  return {
    status: supported ? "pass" : "fail",
    message: supported
      ? `Node ${process.versions.node} satisfies >=${MIN_NODE_VERSION}`
      : `Node ${process.versions.node} is below required >=${MIN_NODE_VERSION}`,
    data: {
      artifactyVersion: version,
      nodeVersion: process.versions.node,
      requiredNodeVersion: `>=${MIN_NODE_VERSION}`,
      platform: platform(),
      arch: arch()
    }
  };
}

function securityCheck(options = {}) {
  const host = options.host || process.env.ARTIFACTY_HOST || "127.0.0.1";
  const config = securityConfig(options);
  validateServerExposure({ host, config });
  const warning = exposureWarning({ host, config });
  if (warning) {
    return {
      status: "warn",
      message: warning,
      data: {
        host,
        shareMode: config.shareMode,
        hasApiToken: Boolean(config.apiToken)
      }
    };
  }
  return {
    status: "pass",
    message: "Server exposure settings are local-first",
    data: {
      host,
      shareMode: config.shareMode,
      hasApiToken: Boolean(config.apiToken)
    }
  };
}

async function storageCheck(store) {
  const integrity = await checkStoreIntegrity(store);
  return {
    status: integrity.ok ? "pass" : "fail",
    message: integrity.ok
      ? `Store is consistent with ${integrity.artifactCount} artifacts and ${integrity.versionCount} versions`
      : "Store integrity check found missing, changed, orphaned, or inconsistent files",
    data: integrity
  };
}

async function serverCheck(store) {
  const status = await backgroundStatus({ home: store.home });
  if (status.running) {
    return {
      status: "pass",
      message: `Managed server is healthy at ${status.url}`,
      data: status
    };
  }
  if (status.processRunning || status.pidFileExists) {
    return {
      status: "fail",
      message: "Recorded server process or pid file exists but health check is not passing",
      data: status
    };
  }
  return {
    status: "warn",
    message: "No managed Artifacty server is currently running",
    data: status
  };
}

async function serviceCheck(options = {}) {
  const definitions = [];
  for (const action of ["plist", "unit", "task"]) {
    const result = await serviceCommand(action, {
      projectDir: options.packageRoot || process.cwd(),
      serverPath: options.serverPath,
      host: options.host,
      port: options.port,
      home: options.home,
      apiToken: options.apiToken,
      shareMode: options.shareMode,
      allowSecrets: options.allowSecrets,
      dryRun: true
    });
    definitions.push({
      action,
      platform: result.platform,
      path: result.path,
      contentBytes: Buffer.byteLength(result.content || "", "utf8")
    });
  }
  return {
    status: "pass",
    message: "Service definitions render for macOS, Linux, and Windows",
    data: { definitions }
  };
}

async function mcpCheck(packageRoot, options = {}) {
  const result = await checkMcpTools({
    projectDir: packageRoot,
    serverPath: options.serverPath,
    url: options.url,
    home: options.home,
    timeout: options.timeout
  });
  return {
    status: result.ok ? "pass" : "fail",
    message: result.ok
      ? `MCP discovery found ${result.toolCount} tools, ${result.resourceCount} resources, and ${result.promptCount} prompts`
      : "MCP discovery is missing required tools, resources, or prompts",
    data: result
  };
}

async function packageVersion(packageRoot) {
  const file = path.join(packageRoot, "package.json");
  const parsed = JSON.parse(await readFile(file, "utf8"));
  return parsed.version;
}

function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart > rightPart) {
      return 1;
    }
    if (leftPart < rightPart) {
      return -1;
    }
  }
  return 0;
}

function versionParts(value) {
  return String(value)
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}
