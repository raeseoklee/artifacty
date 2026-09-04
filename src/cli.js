#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateToken } from "./lib/token.js";
import { parseSseFrames } from "./lib/sse.js";
import { groupArtifactIds, paginationJson } from "./lib/listing.js";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseArgs(args);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${await packageVersion()}\n`);
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

  const {
    addComment,
    addRelation,
    archiveArtifact,
    checkStoreIntegrity,
    createArtifact,
    createSavedView,
    createStore,
    deleteSavedView,
    getArtifact,
    importUsersFromCsv,
    listAuditEvents,
    listArtifactsPage,
    listComments,
    listRelations,
    listSavedViews,
    rebuildEmbeddingIndex,
    rebuildSearchIndex,
    removeRelation,
    resolveComment,
    resolveSavedView,
    restoreArtifact,
    setArtifactVisibility,
    setReviewStatus,
    updateArtifact,
    VersionConflictError
  } = await import("./lib/storage.js");
  const { exportStore, importStore, defaultBackupPath } = await import("./lib/backup.js");
  const { convertAgentArtifact } = await import("./lib/converters.js");
  const { checkMcpTools } = await import("./lib/check.js");
  const { installAgent } = await import("./lib/installer.js");
  const { serviceCommand } = await import("./lib/service.js");
  const { backgroundStatus, startBackgroundServer, stopBackgroundServer } = await import("./lib/background.js");
  const { runDoctor } = await import("./lib/doctor.js");
  const { getRetentionPolicy, normalizeRetentionPolicy, runRetention, setRetentionPolicy } = await import("./lib/retention.js");
  const { parseArchiveAfterDaysPairs } = await import("./lib/retention-form.js");
  const { startServer } = await import("./server.js");
  const store = createStore({ home: options.home });

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
      visibility: options.visibility,
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
    try {
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
        expectedVersion: options.expectedVersion,
        audit: cliAuditContext()
      });
      const finalArtifact = options.visibility
        ? await setArtifactVisibility(store, id, options.visibility, { audit: cliAuditContext() })
        : artifact;
      printJson(await withUrls(store, finalArtifact));
    } catch (error) {
      if (error instanceof VersionConflictError) {
        printJson({
          error: error.message,
          code: error.code,
          latestVersion: error.latestVersion
        });
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    return;
  }

  if (command === "list") {
    let baseFilters = {};
    if (options.view) {
      const view = await resolveSavedView(store, options.view, {});
      if (view) {
        baseFilters = view.filters;
      }
    }
    const explicit = {
      query: options.query,
      tag: Array.isArray(options.tag) ? options.tag[0] : options.tag,
      sourceAgent: options.source,
      artifactType: options.type,
      publisher: options.publisher,
      createdAfter: options.createdAfter,
      createdBefore: options.createdBefore,
      reviewStatus: options.reviewStatus,
      relatedTo: options.relatedTo,
      relation: options.relation,
      mode: options.mode,
      includeArchived: options.includeArchived
    };
    const filters = { ...baseFilters };
    for (const [key, value] of Object.entries(explicit)) {
      if (value !== undefined) {
        filters[key] = value;
      }
    }
    const page = await listArtifactsPage(store, {
      ...filters,
      limit: options.limit,
      offset: options.offset
    });
    const result = {
      artifacts: page.artifacts,
      pagination: paginationJson(page),
      search: page.search
    };
    if (options.groupBy) {
      result.groups = groupArtifactIds(page.artifacts, options.groupBy);
    }
    printJson(result);
    return;
  }

  if (command === "views") {
    const subcommand = options._[0];

    if (subcommand === "save") {
      const name = options._[1];
      if (!name) {
        throw new Error("views save requires a name");
      }
      const filterSource = {
        query: options.query,
        tag: Array.isArray(options.tag) ? options.tag[0] : options.tag,
        sourceAgent: options.source,
        artifactType: options.type,
        publisher: options.publisher,
        createdAfter: options.createdAfter,
        createdBefore: options.createdBefore,
        reviewStatus: options.reviewStatus,
        relatedTo: options.relatedTo,
        relation: options.relation,
        mode: options.mode
      };
      const filters = {};
      for (const [key, value] of Object.entries(filterSource)) {
        if (value !== undefined) {
          filters[key] = value;
        }
      }
      if (options.includeArchived) {
        filters.includeArchived = true;
      }
      const view = await createSavedView(store, {
        name,
        filters,
        shared: Boolean(options.shared),
        audit: cliAuditContext()
      });
      printJson(view);
      return;
    }

    if (subcommand === "delete") {
      const id = options._[1];
      if (!id) {
        throw new Error("views delete requires a view id");
      }
      const view = await deleteSavedView(store, id, { audit: cliAuditContext() });
      printJson(view);
      return;
    }

    const views = await listSavedViews(store, {});
    printJson({ views });
    return;
  }

  if ((command === "index" || command === "search") && options._[0] === "rebuild") {
    const result = await rebuildSearchIndex(store);
    if (options.embeddings) {
      result.embeddings = await rebuildEmbeddingIndex(store);
    }
    printJson(result);
    if (!result.fts5 || (options.embeddings && result.embeddings.configured && !result.embeddings.ok)) {
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

  if (command === "retention") {
    const subcommand = options._[0];

    if (subcommand === "show") {
      printJson(await getRetentionPolicy(store));
      return;
    }

    if (subcommand === "set") {
      const current = await getRetentionPolicy(store);
      const byType = parseArchiveAfterDaysPairs(options.archiveAfterDaysFor || [], {
        base: current.archiveAfterDays.byType,
        onInvalid: (entry) => {
          throw new Error(`--archive-after-days-for expects type=days, got: ${entry}`);
        }
      });
      const next = normalizeRetentionPolicy({
        archiveAfterDays: {
          default: options.archiveAfterDays !== undefined ? options.archiveAfterDays : current.archiveAfterDays.default,
          byType
        },
        purgeArchivedAfterDays: options.purgeArchivedAfterDays !== undefined ? options.purgeArchivedAfterDays : current.purgeArchivedAfterDays,
        auditRetentionDays: options.auditRetentionDays !== undefined ? options.auditRetentionDays : current.auditRetentionDays,
        eventRetentionRows: options.eventRetentionRows !== undefined ? options.eventRetentionRows : current.eventRetentionRows,
        keepTags: options.keepTag !== undefined ? options.keepTag : current.keepTags
      });
      const saved = await setRetentionPolicy(store, next, { audit: cliAuditContext() });
      printJson(saved);
      return;
    }

    if (subcommand === "run") {
      const result = await runRetention(store, { dryRun: Boolean(options.dryRun), allowPurge: options.allowPurge });
      printJson(result);
      return;
    }

    throw new Error("retention requires a subcommand: show, set, or run");
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

  if (command === "visibility") {
    const id = options._[0];
    const visibility = options._[1];
    if (!id || !visibility) {
      throw new Error("visibility requires an artifact id and a value: private or team");
    }
    const artifact = await setArtifactVisibility(store, id, visibility, { audit: cliAuditContext() });
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
    printJson(await exportStore(store, file, { scope: options.full ? "full" : "artifacts" }));
    return;
  }

  if (command === "import-store") {
    printJson(await importStore(store, requireOption(options, "file"), {
      confirm: options.confirm,
      forceUsers: Boolean(options.forceUsers)
    }));
    return;
  }

  if (command === "users") {
    const action = options._[0];
    if (action === "import") {
      const csv = await readContent(options);
      printJson(await importUsersFromCsv(store, csv, {
        passwordResetRequired: !options.noPasswordReset
      }));
      return;
    }
    throw new Error("users requires an action: import");
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
    if (options.relations) {
      printJson(artifact.relations);
      return;
    }
    printJson(await withUrls(store, artifact));
    return;
  }

  if (command === "link" || command === "unlink") {
    const [fromId, relation, toId] = options._;
    if (!fromId || !relation || !toId) {
      throw new Error(`${command} requires: <from> <relation> <to>`);
    }
    const result = command === "link"
      ? await addRelation(store, { fromId, toId, relation, audit: cliAuditContext() })
      : await removeRelation(store, { fromId, toId, relation, audit: cliAuditContext() });
    printJson(result);
    return;
  }

  if (command === "relations") {
    const id = options._[0];
    if (!id) {
      throw new Error("relations requires an artifact id");
    }
    printJson(await listRelations(store, id, {
      direction: options.direction,
      relation: options.relation
    }));
    return;
  }

  if (command === "comment") {
    const id = options._[0];
    if (!id) {
      throw new Error("comment requires an artifact id");
    }
    if (!options.body) {
      throw new Error("comment requires --body <text>");
    }
    const comment = await addComment(store, id, {
      version: options.version,
      body: options.body,
      parentId: options.parent,
      anchor: Number.isFinite(options.line) ? { line: options.line } : undefined,
      sourceAgent: "cli",
      audit: cliAuditContext()
    });
    printJson(comment);
    return;
  }

  if (command === "comments") {
    const id = options._[0];
    if (!id) {
      throw new Error("comments requires an artifact id");
    }
    printJson(await listComments(store, id, {
      version: options.version,
      status: options.status
    }));
    return;
  }

  if (command === "resolve-comment") {
    const [id, commentId] = options._;
    if (!id || !commentId) {
      throw new Error("resolve-comment requires: <id> <commentId>");
    }
    printJson(await resolveComment(store, id, commentId, { audit: cliAuditContext() }));
    return;
  }

  if (command === "review-status") {
    const [id, status] = options._;
    if (!id || !status) {
      throw new Error("review-status requires: <id> none|pending|changes-requested|approved");
    }
    printJson(await withUrls(store, await setReviewStatus(store, id, status, { audit: cliAuditContext() })));
    return;
  }

  if (command === "diff") {
    const id = options._[0];
    if (!id) {
      throw new Error("diff requires an artifact id");
    }
    const { createStructuredDiff, createLineDiff, diffFormatFor, renderUnifiedDiffText, resolveDiffView } = await import("./lib/diff.js");
    const latest = await getArtifact(store, id);
    const defaultFrom = Math.max(1, latest.latestVersion - 1);
    const fromNumber = Number.isFinite(options.from) ? options.from : defaultFrom;
    const toNumber = Number.isFinite(options.to) ? options.to : latest.latestVersion;
    const from = await getArtifact(store, id, { version: fromNumber });
    const to = await getArtifact(store, id, { version: toNumber });
    const diffFormat = diffFormatFor(latest.artifactType, to.version.format);
    const useStructured = options.structured ||
      resolveDiffView({ artifactType: latest.artifactType, format: to.version.format, requestedView: undefined }) === "structured";

    if (options.json) {
      if (useStructured) {
        printJson({
          id: latest.id,
          from: from.version.version,
          to: to.version.version,
          view: "structured",
          format: diffFormat,
          structuredDiff: createStructuredDiff(from.content, to.content, { format: diffFormat })
        });
        return;
      }
      printJson({
        id: latest.id,
        from: from.version.version,
        to: to.version.version,
        view: "lines",
        format: diffFormat,
        diffRows: createLineDiff(from.content, to.content)
      });
      return;
    }

    if (useStructured) {
      const structuredDiff = createStructuredDiff(from.content, to.content, { format: diffFormat });
      process.stdout.write(`${renderUnifiedDiffText(structuredDiff)}\n`);
      return;
    }

    const rows = createLineDiff(from.content, to.content);
    for (const row of rows) {
      if (row.type === "same") {
        process.stdout.write(`  ${row.text}\n`);
      } else if (row.type === "added") {
        process.stdout.write(`+ ${row.text}\n`);
      } else {
        process.stdout.write(`- ${row.text}\n`);
      }
    }
    return;
  }

  if (command === "watch") {
    return runWatchCommand(store, options);
  }

  throw new Error(`Unknown command: ${command}`);
}

// `artifacty watch` connects to a running server's SSE endpoint
// (/api/events; see src/server.js handleEventStream) and prints one line
// per matching event, optionally piping each event to --exec. Reconnects
// with Last-Event-ID on drop so a brief server restart does not lose
// events. --once resolves after the first match, making this usable as a
// shell-friendly, no-dependency alternative to the artifacty_wait MCP tool.
async function runWatchCommand(store, options) {
  const { resolvePublicBaseUrl } = await import("./lib/server-state.js");
  const baseUrl = await resolvePublicBaseUrl(store, { url: options.url });
  const token = options.apiToken || process.env.ARTIFACTY_API_TOKEN || "";
  const filter = {};
  if (options.tag) filter.tag = Array.isArray(options.tag) ? options.tag[options.tag.length - 1] : options.tag;
  if (options.artifact) filter.artifactId = options.artifact;
  if (options.type) filter.type = options.type;

  let lastEventId = null;
  // SIGINT exits immediately (process.exit is synchronous-enough that the
  // while loop below never observes another iteration), so there is no
  // "stopped" state for the loop condition to check.
  process.on("SIGINT", () => {
    process.exit(0);
  });

  for (;;) {
    const matched = await watchOnce({ baseUrl, token, filter, lastEventId, options });
    if (matched.stop) {
      return;
    }
    if (matched.lastEventId) {
      lastEventId = matched.lastEventId;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function watchOnce({ baseUrl, token, filter, lastEventId, options }) {
  const url = new URL("/api/events", baseUrl);
  for (const [key, value] of Object.entries(filter)) {
    url.searchParams.set(key, value);
  }
  const headers = { accept: "text/event-stream" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (lastEventId) {
    headers["last-event-id"] = String(lastEventId);
  }

  let response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    process.stderr.write(`artifacty watch: connection failed: ${error.message}\n`);
    return {};
  }
  if (!response.ok || !response.body) {
    process.stderr.write(`artifacty watch: server returned ${response.status}\n`);
    return {};
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let seenLastEventId = lastEventId;
  let readyPrinted = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      // handleEventStream (src/server.js) writes ": connected\n\n" as the
      // very first frame once the SSE subscription is actually live, before
      // any replayed or new events. A caller scripting against `watch`
      // (tests included) needs a deterministic point to know the stream is
      // subscribed rather than sleeping and hoping; print the ready marker
      // once we've seen it, before parsing frames as events (parseSseFrames
      // filters comment-only frames like this one out anyway).
      if (!readyPrinted && buffer.includes(": connected\n\n")) {
        readyPrinted = true;
        printWatchReady(options);
      }
      const { frames, rest } = parseSseFrames(buffer);
      buffer = rest;
      for (const parsed of frames) {
        if (parsed.id) {
          seenLastEventId = parsed.id;
        }
        const event = JSON.parse(parsed.data);
        await emitWatchEvent(event, options);
        if (options.once) {
          await reader.cancel().catch(() => {});
          return { stop: true };
        }
      }
    }
  } catch (error) {
    process.stderr.write(`artifacty watch: stream error: ${error.message}\n`);
  }
  return { lastEventId: seenLastEventId };
}

function printWatchReady(options) {
  if (options.json) {
    process.stderr.write(`${JSON.stringify({ ready: true })}\n`);
  } else {
    process.stderr.write("# connected\n");
  }
}

async function emitWatchEvent(event, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  } else {
    process.stdout.write(`${event.type} ${event.artifactId || ""} v${event.version ?? ""}\n`);
  }
  if (options.exec) {
    await execWatchCommand(options.exec, event);
  }
}

async function execWatchCommand(command, event) {
  const { spawn } = await import("node:child_process");
  await new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "inherit", "inherit"],
      env: {
        ...process.env,
        ARTIFACTY_EVENT_TYPE: event.type || "",
        ARTIFACTY_EVENT_ARTIFACT_ID: event.artifactId || "",
        ARTIFACTY_EVENT_VERSION: event.version !== undefined && event.version !== null ? String(event.version) : ""
      }
    });
    child.stdin.write(`${JSON.stringify(event)}\n`);
    child.stdin.end();
    child.on("error", (error) => {
      process.stderr.write(`artifacty watch: --exec failed: ${error.message}\n`);
      resolve();
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        process.stderr.write(`artifacty watch: --exec exited with code ${code}\n`);
      }
      resolve();
    });
  });
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
    if (key === "raw" || key === "dry-run" || key === "trust" || key === "include-archived" || key === "allow-secrets" || key === "generate-token" || key === "detach" || key === "foreground" || key === "force" || key === "skip-mcp" || key === "mcp-http" || key === "no-password-reset" || key === "relations" || key === "structured" || key === "json" || key === "once" || key === "full" || key === "force-users" || key === "allow-purge" || key === "shared" || key === "embeddings") {
      options[toCamelCase(key)] = true;
      continue;
    }

    const value = args[++index];
    if (value === undefined) {
      throw new Error(`Missing value for --${key}`);
    }

    if (key === "tag") {
      options.tag = [...(options.tag || []), value];
    } else if (key === "keep-tag") {
      options.keepTag = [...(options.keepTag || []), value];
    } else if (key === "archive-after-days-for") {
      options.archiveAfterDaysFor = [...(options.archiveAfterDaysFor || []), value];
    } else if (key === "port" || key === "limit" || key === "offset" || key === "version" || key === "schema-version" || key === "timeout" || key === "bytes" || key === "expected-version" || key === "from" || key === "to" || key === "archive-after-days" || key === "purge-archived-after-days" || key === "audit-retention-days" || key === "event-retention-rows" || key === "line") {
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
  const { resolvePublicBaseUrl } = await import("./lib/server-state.js");
  const publicBaseUrl = await resolvePublicBaseUrl(store);
  return {
    ...artifact,
    url: `${publicBaseUrl}/artifacts/${encodeURIComponent(artifact.id)}`,
    rawUrl: `${publicBaseUrl}/artifacts/${encodeURIComponent(artifact.id)}/raw?version=${artifact.version.version}`
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

async function packageVersion() {
  const packageJson = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  return packageJson.version;
}

function printHelp() {
  process.stdout.write(`Artifacty

Usage:
  artifacty --version
  artifacty token [--bytes 32] [--raw]
  artifacty serve [--host 127.0.0.1] [--port 8787] [--home ~/.artifacty] [--api-token token] [--generate-token] [--bytes 32] [--mcp-http] [--foreground]
  artifacty serve --foreground [--generate-token]
  artifacty start [--host 127.0.0.1] [--port 8787] [--home ~/.artifacty] [--api-token token] [--generate-token] [--mcp-http] [--timeout 30000]
  artifacty status [--home ~/.artifacty]
  artifacty stop [--home ~/.artifacty] [--timeout 30000] [--force]
  artifacty doctor [--home ~/.artifacty] [--skip-mcp] [--timeout 5000]
  artifacty publish --title <title> (--file <path> | --content <text>) [--format html|markdown|text|json|code|svg|mermaid|react|notebook] [--source agent] [--tag tag] [--visibility private|team]
  artifacty import --agent claude|codex|gemini|copilot|cursor|auto (--file <path> | --content <text>) [--title <title>] [--format html|markdown|text|json|code|svg|mermaid|react|notebook] [--tag tag]
  artifacty install claude|codex|gemini|copilot|cursor|all [--dry-run] [--config <path>] [--server-path <path>] [--url http://127.0.0.1:8787] [--mcp-url http://127.0.0.1:8787/mcp] [--api-token token] [--transport local|bridge] [--timeout 30000]
  artifacty check [--server-path <path>] [--timeout 5000]
  artifacty update <id> (--file <path> | --content <text>) [--title <title>] [--format html|markdown|text|json|code|svg|mermaid|react|notebook] [--expected-version N] [--visibility private|team]
  artifacty archive <id>
  artifacty restore <id>
  artifacty visibility <id> private|team
  artifacty audit [--artifact <id>] [--limit 100]
  artifacty index rebuild [--embeddings]
  artifacty integrity
  artifacty retention show
  artifacty retention set [--archive-after-days N] [--archive-after-days-for type=N] [--purge-archived-after-days N] [--audit-retention-days N] [--event-retention-rows N] [--keep-tag tag]
  artifacty retention run [--dry-run] [--allow-purge]
  artifacty export --file <path> [--full]
  artifacty backup [--file <path>] [--full]
  artifacty import-store --file <path> [--confirm replace-all] [--force-users]
  artifacty users import --file <path.csv> [--no-password-reset]
  artifacty service plist|unit|task|install|uninstall [--platform macos|linux|windows] [--dry-run] [--path <path>] [--mcp-http]
  artifacty list [--query text] [--tag tag] [--source agent] [--type <artifactType>] [--publisher <id>] [--created-after <iso-date>] [--created-before <iso-date>] [--review-status none|pending|changes-requested|approved] [--related-to <id>] [--relation derived-from|supersedes|reviews|references|part-of] [--mode keyword|semantic|hybrid] [--view <name|id>] [--group-by artifactType|sourceAgent|day] [--limit 50] [--offset 0] [--include-archived]
  artifacty views
  artifacty views save <name> [--shared] [--query text] [--tag tag] [--source agent] [--type <artifactType>] [--publisher <id>] [--created-after <iso-date>] [--created-before <iso-date>] [--review-status none|pending|changes-requested|approved] [--related-to <id>] [--relation derived-from|supersedes|reviews|references|part-of] [--include-archived]
  artifacty views delete <id>
  artifacty show <id> [--version n] [--raw] [--relations]
  artifacty link <from> <relation> <to>
  artifacty unlink <from> <relation> <to>
  artifacty relations <id> [--direction out|in|both] [--relation derived-from|supersedes|reviews|references|part-of]
  artifacty comment <id> --body "..." [--version n] [--line n] [--parent commentId]
  artifacty comments <id> [--version n] [--status open|resolved]
  artifacty resolve-comment <id> <commentId>
  artifacty review-status <id> none|pending|changes-requested|approved
  artifacty diff <id> [--from N] [--to M] [--structured] [--json]
  artifacty watch [--tag tag] [--artifact <id>] [--type artifact.updated] [--json] [--once] [--exec "<cmd>"]

Environment:
  ARTIFACTY_HOME           Storage directory. Defaults to ~/.artifacty
  ARTIFACTY_URL            Public URL override. Otherwise CLI/MCP read the last running server URL
  ARTIFACTY_HOST           Bind host for the HTTP server. Defaults to 127.0.0.1
  ARTIFACTY_PORT           Bind port for the HTTP server. Defaults to 8787
  ARTIFACTY_MCP_URL        Central MCP HTTP endpoint used by bridge mode
  ARTIFACTY_MCP_MODE       local or bridge. bridge forwards stdio MCP to ARTIFACTY_MCP_URL
  ARTIFACTY_MCP_HTTP       Set true to also expose MCP over HTTP on the running server
  ARTIFACTY_MCP_TIMEOUT_MS  Bridge-mode MCP HTTP request timeout in ms. Defaults to 30000
  ARTIFACTY_API_TOKEN      Required token for HTTP API and LAN mode
  ARTIFACTY_LOCALE         Default UI locale (e.g. en, ko) when a request does not specify one
  ARTIFACTY_EMBEDDINGS_URL      openai-compatible embeddings endpoint base URL, enables semantic/hybrid search
  ARTIFACTY_EMBEDDINGS_MODEL    Embeddings model name (defaults per provider)
  ARTIFACTY_EMBEDDINGS_API_KEY  API key for the openai-compatible provider, never logged or stored
  ARTIFACTY_EMBEDDINGS_COMMAND  Local command that reads JSON lines on stdin and writes vectors on stdout
  ARTIFACTY_EMBEDDINGS_MAX_CHARS  Max content characters embedded per artifact (default 8000)
  ARTIFACTY_EMBEDDINGS_TIMEOUT_MS  Timeout in ms for the local embeddings command. Defaults to 30000
  ARTIFACTY_EMBEDDINGS_MAX_CANDIDATES  Max embedding rows scored per semantic/hybrid search. Defaults to 20000
  ARTIFACTY_EMBEDDINGS_SYNC     Set true to index embeddings synchronously (tests only)
  ARTIFACTY_SHARE_MODE     Use lan or team before binding outside localhost
  ARTIFACTY_TEAM_WRITE     Set owner to restrict writes on team-visibility artifacts to the owner or an admin
  ARTIFACTY_ALLOW_SECRETS  Set true only to intentionally store detected secrets
  ARTIFACTY_ENABLE_REACT_RENDERER  Set true to execute React artifacts in a sandboxed frame instead of source-only
  ARTIFACTY_RETENTION_INTERVAL_MS    Background retention sweep interval in ms. Defaults to 3600000 (1 hour)
  ARTIFACTY_RETENTION_ALLOW_PURGE    Set true to allow retention sweeps to hard-delete archived artifacts
  ARTIFACTY_WEBHOOK_TIMEOUT_MS   Per-attempt webhook delivery timeout in ms. Defaults to 10000
  ARTIFACTY_WEBHOOK_ALLOW_PRIVATE  Set true to allow webhook URLs that resolve to private/loopback addresses
  ARTIFACTY_EVENT_POLL_MS   SSE poll interval in ms for new events. Defaults to 1000
  ARTIFACTY_EVENT_HISTORY   Max in-memory event history retained for replay. Defaults to 10000
  ARTIFACTY_SSE_MAX_CLIENTS  Max concurrent SSE connections. Defaults to 64
  ARTIFACTY_MAX_WAITS        Max concurrent artifacty_wait MCP long-polls. Defaults to 64
  ARTIFACTY_MAX_DIFF_ENTRIES        Max diff entries computed per artifacty diff. Defaults to 5000
  ARTIFACTY_MAX_INLINE_DIAGRAMS     Max inline Mermaid diagrams rendered per Markdown artifact. Defaults to 20
  ARTIFACTY_MAX_COMMENTS_PER_ARTIFACT   Max comments retained per artifact. Defaults to 2000
  ARTIFACTY_MAX_SAVED_VIEWS_PER_USER    Max saved views retained per user. Defaults to 100
  ARTIFACTY_RATE_LIMIT             always or off. Overrides the default (disabled on loopback, enabled otherwise)
  ARTIFACTY_RATE_WRITE_PER_MIN     Rate limit for mutating routes. Defaults to 120/min
  ARTIFACTY_RATE_AUTH_PER_MIN      Rate limit for /login per address. Defaults to 10/min
  ARTIFACTY_RATE_SEARCH_PER_MIN    Rate limit for GET /api/artifacts?q= searches. Defaults to 300/min
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
