#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveArtifact,
  checkStoreIntegrity,
  createArtifact,
  createStore,
  getArtifact,
  listAuditEvents,
  listArtifactsPage,
  rebuildSearchIndex,
  restoreArtifact,
  updateArtifact
} from "./lib/storage.js";
import { exportStore, importStore, defaultBackupPath } from "./lib/backup.js";
import { convertAgentArtifact } from "./lib/converters.js";
import { checkMcpTools } from "./lib/check.js";
import { installAgent } from "./lib/installer.js";
import { serviceCommand } from "./lib/service.js";
import { backgroundStatus, startBackgroundServer, stopBackgroundServer } from "./lib/background.js";
import { resolvePublicBaseUrl } from "./lib/server-state.js";
import { generateToken } from "./lib/token.js";
import { runDoctor } from "./lib/doctor.js";
import { startServer } from "./server.js";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseArgs(args);
  const store = createStore({ home: options.home });

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "token" || command === "generate-token") {
    const token = generateToken(options);
    if (options.raw) {
      process.stdout.write(`${token.token}\n`);
      return;
    }
    printJson(token);
    return;
  }

  if (command === "serve") {
    if (options.detach && options.foreground) {
      throw new Error("Use either --foreground or --detach, not both");
    }
    if (!options.foreground) {
      printJson(await startBackgroundServer({
        ...serverOptions(options),
        serverPath: path.join(PACKAGE_ROOT, "src", "server.js")
      }));
      return;
    }
    if (options.generateToken && options.apiToken) {
      throw new Error("Use either --api-token or --generate-token, not both");
    }
    const generatedToken = options.generateToken ? generateToken(options) : null;
    const server = await startServer({
      host: options.host,
      port: options.port,
      home: options.home,
      apiToken: generatedToken?.token || options.apiToken,
      shareMode: options.shareMode,
      allowSecrets: options.allowSecrets,
      mcpHttp: options.mcpHttp
    });
    process.stderr.write(`Artifacty listening on ${server.url}\n`);
    process.stderr.write(`Store: ${server.store.home}\n`);
    if (server.securityWarning) {
      process.stderr.write(`${server.securityWarning}\n`);
    }
    if (generatedToken) {
      process.stderr.write(`API token: ${generatedToken.token}\n`);
      process.stderr.write(`HTTP header: ${generatedToken.header}\n`);
      process.stderr.write(`Create URL: ${server.url}/new?token=${encodeURIComponent(generatedToken.token)}\n`);
      process.stderr.write(`Import URL: ${server.url}/import?token=${encodeURIComponent(generatedToken.token)}\n`);
    }
    return;
  }

  if (command === "start") {
    printJson(await startBackgroundServer({
      ...serverOptions(options),
      serverPath: path.join(PACKAGE_ROOT, "src", "server.js")
    }));
    return;
  }

  if (command === "stop") {
    printJson(await stopBackgroundServer({
      home: options.home,
      timeout: options.timeout,
      force: options.force
    }));
    return;
  }

  if (command === "status") {
    printJson(await backgroundStatus({ home: options.home }));
    return;
  }

  if (command === "doctor") {
    const result = await runDoctor({
      packageRoot: PACKAGE_ROOT,
      serverPath: options.serverPath,
      url: options.url,
      home: options.home,
      host: options.host,
      port: options.port,
      apiToken: options.apiToken,
      shareMode: options.shareMode,
      allowSecrets: options.allowSecrets,
      timeout: options.timeout,
      skipMcp: options.skipMcp
    });
    printJson(result);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "publish") {
    const content = await readContent(options);
    const artifact = await createArtifact(store, {
      title: requireOption(options, "title"),
      content,
      format: options.format,
      artifactType: options.artifactType,
      schemaVersion: options.schemaVersion,
      sourceAgent: options.source || "cli",
      tags: options.tag || [],
      metadata: options.metadata ? JSON.parse(options.metadata) : {},
      allowSecrets: options.allowSecrets,
      audit: cliAuditContext()
    });
    printJson(await withUrls(store, artifact));
    return;
  }

  if (command === "import") {
    const content = await readContent(options);
    const sourcePath = options.file ? path.resolve(options.file) : "";
    const converted = convertAgentArtifact({
      agent: options.agent || options.source || "auto",
      title: options.title,
      content,
      format: options.format,
      artifactType: options.artifactType,
      schemaVersion: options.schemaVersion,
      contentType: options.contentType,
      fileName: options.file ? path.basename(options.file) : options.fileName,
      sourcePath,
      sourceAgent: options.sourceAgent,
      tags: options.tag || [],
      metadata: options.metadata ? JSON.parse(options.metadata) : {}
    });
    const artifact = await createArtifact(store, {
      ...converted,
      allowSecrets: options.allowSecrets,
      auditAction: "import",
      audit: cliAuditContext()
    });
    printJson(await withUrls(store, artifact));
    return;
  }

  if (command === "install") {
    const agent = options._[0];
    if (!agent) {
      throw new Error("install requires an agent: claude, codex, gemini, copilot, cursor, or all");
    }
    const result = await installAgent(agent, {
      projectDir: options.projectDir || process.cwd(),
      packageDir: PACKAGE_ROOT,
      configPath: options.config,
      serverPath: options.serverPath,
      url: options.url,
      mcpUrl: options.mcpUrl,
      apiToken: options.apiToken,
      transport: options.transport,
      home: options.home,
      dryRun: options.dryRun,
      trust: options.trust,
      timeout: options.timeout
    });
    printJson(stripInstallContentUnlessDryRun(result));
    return;
  }

  if (command === "check") {
    const result = await checkMcpTools({
      projectDir: options.projectDir || PACKAGE_ROOT,
      serverPath: options.serverPath,
      url: options.url,
      home: options.home,
      timeout: options.timeout
    });
    printJson(result);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "update") {
    const id = args.find((arg) => !arg.startsWith("-"));
    if (!id) {
      throw new Error("update requires an artifact id");
    }
    const content = await readContent(options);
    const artifact = await updateArtifact(store, id, {
      title: options.title,
      content,
      format: options.format,
      artifactType: options.artifactType,
      schemaVersion: options.schemaVersion,
      sourceAgent: options.source || "cli",
      tags: options.tag || [],
      metadata: options.metadata ? JSON.parse(options.metadata) : {},
      allowSecrets: options.allowSecrets,
      audit: cliAuditContext()
    });
    printJson(await withUrls(store, artifact));
    return;
  }

  if (command === "list") {
    const page = await listArtifactsPage(store, {
      query: options.query,
      tag: Array.isArray(options.tag) ? options.tag[0] : options.tag,
      sourceAgent: options.source,
      includeArchived: options.includeArchived,
      limit: options.limit,
      offset: options.offset
    });
    printJson({
      artifacts: page.artifacts,
      pagination: paginationJson(page),
      search: page.search
    });
    return;
  }

  if ((command === "index" || command === "search") && options._[0] === "rebuild") {
    const result = await rebuildSearchIndex(store);
    printJson(result);
    if (!result.fts5) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "integrity" || command === "check-store") {
    const result = await checkStoreIntegrity(store);
    printJson(result);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "archive" || command === "restore") {
    const id = options._[0];
    if (!id) {
      throw new Error(`${command} requires an artifact id`);
    }
    const artifact = command === "archive"
      ? await archiveArtifact(store, id, { audit: cliAuditContext() })
      : await restoreArtifact(store, id, { audit: cliAuditContext() });
    printJson(await withUrls(store, artifact));
    return;
  }

  if (command === "audit") {
    const events = await listAuditEvents(store, {
      artifactId: options.artifact,
      limit: options.limit
    });
    printJson({ events });
    return;
  }

  if (command === "export" || command === "backup") {
    const file = command === "backup" ? options.file || defaultBackupPath(store) : requireOption(options, "file");
    printJson(await exportStore(store, file));
    return;
  }

  if (command === "import-store") {
    printJson(await importStore(store, requireOption(options, "file")));
    return;
  }

  if (command === "service") {
    const action = options._[0] || "plist";
    printJson(await serviceCommand(action, {
      projectDir: options.projectDir || PACKAGE_ROOT,
      serverPath: options.serverPath,
      plistPath: options.plist,
      unitPath: options.unit,
      scriptPath: options.script,
      servicePath: options.path,
      platform: options.platform,
      apiToken: options.apiToken,
      shareMode: options.shareMode,
      allowSecrets: options.allowSecrets,
      mcpHttp: options.mcpHttp,
      host: options.host,
      port: options.port,
      home: options.home,
      dryRun: options.dryRun
    }));
    return;
  }

  if (command === "show") {
    const id = args.find((arg) => !arg.startsWith("-"));
    if (!id) {
      throw new Error("show requires an artifact id");
    }
    const artifact = await getArtifact(store, id, { version: options.version });
    if (options.raw) {
      process.stdout.write(artifact.content);
      return;
    }
    printJson(await withUrls(store, artifact));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseArgs(args) {
  const options = {};
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const key = arg.slice(2);
    if (key === "raw" || key === "dry-run" || key === "trust" || key === "include-archived" || key === "allow-secrets" || key === "generate-token" || key === "detach" || key === "foreground" || key === "force" || key === "skip-mcp" || key === "mcp-http") {
      options[toCamelCase(key)] = true;
      continue;
    }

    const value = args[++index];
    if (value === undefined) {
      throw new Error(`Missing value for --${key}`);
    }

    if (key === "tag") {
      options.tag = [...(options.tag || []), value];
    } else if (key === "port" || key === "limit" || key === "offset" || key === "version" || key === "schema-version" || key === "timeout" || key === "bytes") {
      options[toCamelCase(key)] = Number(value);
    } else {
      options[toCamelCase(key)] = value;
    }
  }

  options._ = positional;
  return options;
}

async function readContent(options) {
  if (options.file) {
    const filePath = path.resolve(options.file);
    if (shouldReadFileAsBase64(options, filePath)) {
      return (await readFile(filePath)).toString("base64");
    }
    return readFile(filePath, "utf8");
  }
  if (options.content !== undefined) {
    return options.content;
  }
  throw new Error("Provide --file or --content");
}

function shouldReadFileAsBase64(options, filePath) {
  const format = String(options.format || "").toLowerCase();
  const contentType = String(options.contentType || "").toLowerCase();
  return format === "image" ||
    format === "video" ||
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    /\.(png|jpe?g|gif|webp|mp4|webm)$/i.test(filePath);
}

async function withUrls(store, artifact) {
  const publicBaseUrl = await resolvePublicBaseUrl(store);
  return {
    ...artifact,
    url: `${publicBaseUrl}/artifacts/${encodeURIComponent(artifact.id)}`,
    rawUrl: `${publicBaseUrl}/artifacts/${encodeURIComponent(artifact.id)}/raw?version=${artifact.version.version}`
  };
}

function paginationJson(page) {
  return {
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    hasMore: page.hasMore,
    nextOffset: page.nextOffset,
    previousOffset: page.previousOffset
  };
}

function requireOption(options, name) {
  if (!options[name]) {
    throw new Error(`Missing required option --${name}`);
  }
  return options[name];
}

function printJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(`Artifacty

Usage:
  artifacty token [--bytes 32] [--raw]
  artifacty serve [--host 127.0.0.1] [--port 8787] [--home ~/.artifacty] [--api-token token] [--generate-token] [--bytes 32] [--mcp-http] [--foreground]
  artifacty serve --foreground [--generate-token]
  artifacty start [--host 127.0.0.1] [--port 8787] [--home ~/.artifacty] [--api-token token] [--generate-token] [--mcp-http] [--timeout 30000]
  artifacty status [--home ~/.artifacty]
  artifacty stop [--home ~/.artifacty] [--timeout 30000] [--force]
  artifacty doctor [--home ~/.artifacty] [--skip-mcp] [--timeout 5000]
  artifacty publish --title <title> (--file <path> | --content <text>) [--format html|markdown|text|json|code|svg|mermaid|react] [--source agent] [--tag tag]
  artifacty import --agent claude|codex|gemini|copilot|cursor|auto (--file <path> | --content <text>) [--title <title>] [--format html|markdown|text|json|code|svg|mermaid|react] [--tag tag]
  artifacty install claude|codex|gemini|copilot|cursor|all [--dry-run] [--config <path>] [--server-path <path>] [--url http://127.0.0.1:8787] [--mcp-url http://127.0.0.1:8787/mcp] [--api-token token] [--transport local|bridge] [--timeout 30000]
  artifacty check [--server-path <path>] [--timeout 5000]
  artifacty update <id> (--file <path> | --content <text>) [--title <title>] [--format html|markdown|text|json|code|svg|mermaid|react]
  artifacty archive <id>
  artifacty restore <id>
  artifacty audit [--artifact <id>] [--limit 100]
  artifacty index rebuild
  artifacty integrity
  artifacty export --file <path>
  artifacty backup [--file <path>]
  artifacty import-store --file <path>
  artifacty service plist|unit|task|install|uninstall [--platform macos|linux|windows] [--dry-run] [--path <path>] [--mcp-http]
  artifacty list [--query text] [--tag tag] [--source agent] [--limit 50] [--offset 0] [--include-archived]
  artifacty show <id> [--version n] [--raw]

Environment:
  ARTIFACTY_HOME           Storage directory. Defaults to ~/.artifacty
  ARTIFACTY_URL            Public URL override. Otherwise CLI/MCP read the last running server URL
  ARTIFACTY_MCP_URL        Central MCP HTTP endpoint used by bridge mode
  ARTIFACTY_MCP_MODE       local or bridge. bridge forwards stdio MCP to ARTIFACTY_MCP_URL
  ARTIFACTY_API_TOKEN      Required token for HTTP API and LAN mode
  ARTIFACTY_SHARE_MODE     Use lan or team before binding outside localhost
  ARTIFACTY_ALLOW_SECRETS  Set true only to intentionally store detected secrets
`);
}

function stripInstallContentUnlessDryRun(result) {
  if (result.results) {
    return {
      ...result,
      results: result.results.map(stripInstallContentUnlessDryRun)
    };
  }
  if (result.dryRun) {
    return result;
  }
  const { content, ...rest } = result;
  return rest;
}

function serverOptions(options) {
  return {
    host: options.host,
    port: options.port,
    home: options.home,
    apiToken: options.apiToken,
    shareMode: options.shareMode,
    allowSecrets: options.allowSecrets,
    generateToken: options.generateToken,
    bytes: options.bytes,
    mcpHttp: options.mcpHttp,
    timeout: options.timeout
  };
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function cliAuditContext() {
  return {
    surface: "cli",
    actor: process.env.USER || process.env.LOGNAME || "cli"
  };
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
