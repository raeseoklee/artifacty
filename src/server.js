#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import {
  addComment,
  addRelation,
  archiveArtifact,
  artifactEtag,
  authenticateApiToken,
  changeUserPassword,
  checkStoreIntegrity,
  countUsers,
  createApiToken,
  createArtifact,
  createSavedView,
  createSession,
  createStore,
  createUser,
  createWebhook,
  deleteArtifactVersion,
  deleteComment,
  deleteSavedView,
  deleteWebhook,
  getArtifact,
  getSessionUser,
  getWebhook,
  importUsersFromCsv,
  insertSecurityAudit,
  insertWebhookFailureAudit,
  listApiTokens,
  listArtifactsPage,
  listAuditEvents,
  listComments,
  listEventsSince,
  latestEventSeq,
  listRelations,
  listSavedViews,
  listUsers,
  listWebhooks,
  MAX_ARTIFACT_BYTES,
  readBundleFile,
  recordWebhookDelivery,
  SAVED_VIEW_FILTER_KEYS,
  removeRelation,
  resolveComment,
  resolveSavedView,
  revokeApiToken,
  revokeSession,
  restoreArtifact,
  replaceArtifactVersion,
  setArtifactOwner,
  setArtifactVisibility,
  setReviewStatus,
  setUserActive,
  updateArtifact,
  VersionConflictError,
  verifyUserPassword
} from "./lib/storage.js";
import { MAX_BACKUP_BYTES, buildStoreBackup, exportStoreToString, importStoreBundle, importStoreFromString } from "./lib/backup.js";
import { convertAgentArtifact, decodeMediaContent, mediaContentType } from "./lib/converters.js";
import { createLineDiff, createStructuredDiff, diffFormatFor, resolveDiffView } from "./lib/diff.js";
import { EDITOR_CLIENT_PATH, VIEWER_CLIENT_PATH, editorClientFilePath, editorVendorPath, viewerClientFilePath } from "./lib/editor-assets.js";
import { createEmbeddingProvider } from "./lib/embeddings.js";
import { EVENT_TYPES, eventVisibleTo, publish, sanitizeEventForDelivery, subscribe } from "./lib/events.js";
import { localeFromBodyOrUrl, localeFromUrl, localizedHref } from "./lib/i18n.js";
import { paginationJson } from "./lib/listing.js";
import { buildOpenApiDocument, renderApiDocsHtml } from "./lib/openapi.js";
import { getRetentionPolicy, runRetention, setRetentionPolicy, startRetentionSweep } from "./lib/retention.js";
import { parseArchiveAfterDaysPairs } from "./lib/retention-form.js";
import { buildCsvExport, buildSarifExport, parseCsvFilterParam } from "./lib/sarif-csv-export.js";
import {
  accessContext,
  exposureWarning,
  rateLimitEnabled,
  rateLimitFromEnv,
  requestToken,
  requireScope,
  securityConfig,
  tokensEqual,
  validateServerExposure,
  createRateLimiter
} from "./lib/security.js";
import { writeServerState } from "./lib/server-state.js";
import { generateToken } from "./lib/token.js";
import { deliverWebhook, registerWebhookDispatcher } from "./lib/webhooks.js";
import { createMcpJsonRpcHandler } from "./mcp-server.js";
import {
  renderArtifactFormPage,
  renderArtifactPage,
  renderAccountPage,
  renderAdminBackupPage,
  renderAdminArtifactVersionsPage,
  renderAdminRetentionPage,
  renderAdminUsersPage,
  renderAdminWebhooksPage,
  renderPasswordPage,
  renderReactFramePage,
  renderDashboard,
  renderDiffPage,
  renderImportArtifactPage,
  renderLoginPage,
  renderNewArtifactPage
} from "./lib/render.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const FALLBACK_PORT_ATTEMPTS = 10;
const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SSE_HEARTBEAT_MS = 25000;
let activeSseClients = 0;

function sseMaxClients() {
  const parsed = Number.parseInt(process.env.ARTIFACTY_SSE_MAX_CLIENTS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 64;
}

function eventPollMs() {
  const parsed = Number.parseInt(process.env.ARTIFACTY_EVENT_POLL_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}

// The event bus in src/lib/events.js is in-process only: a mutation made by
// another process sharing this same store (the local stdio MCP server in
// non-bridge mode, `artifacty publish`/CLI writes, or a second HTTP server
// process) inserts its row straight into the `events` table but never calls
// this process's publish(), so it would otherwise never reach this
// process's SSE clients, webhooks, or MCP subscriptions. Poll the table for
// rows this process hasn't seen and re-publish them locally; events.publish
// dedupes by id, so an event this same process already published
// in-process (the common case) is a no-op here, not a duplicate delivery.
async function startCrossProcessEventPoller(store) {
  let lastSeenSeq = await latestEventSeq(store);
  let polling = false;
  const timer = setInterval(() => {
    if (polling) {
      return;
    }
    polling = true;
    listEventsSince(store, lastSeenSeq, {}, 500)
      .then((rows) => {
        for (const row of rows) {
          publish(row);
          if (row.seq > lastSeenSeq) {
            lastSeenSeq = row.seq;
          }
        }
      })
      .catch((error) => {
        process.stderr.write(`Artifacty event poller error: ${error.stack || error.message}\n`);
      })
      .finally(() => {
        polling = false;
      });
  }, eventPollMs());
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function startServer(options = {}) {
  const host = options.host || process.env.ARTIFACTY_HOST || DEFAULT_HOST;
  const explicitPort = options.port !== undefined || process.env.ARTIFACTY_PORT !== undefined;
  const requestedPort = Number(options.port ?? process.env.ARTIFACTY_PORT ?? DEFAULT_PORT);
  const allowPortFallback =
    options.portFallback === true ||
    (!explicitPort && options.portFallback !== false);
  const store = createStore({ home: options.home });
  const security = securityConfig(options);
  const mcpHttp = Boolean(options.mcpHttp || process.env.ARTIFACTY_MCP_HTTP === "true");
  validateServerExposure({ host, config: security });

  const { server, actualPort } = await listenWithFallback({
    host,
    requestedPort,
    allowPortFallback,
    createServer(port) {
      const candidateServer = http.createServer((request, response) => {
        handleRequest({ request, response, store, host, port: candidateServer.address()?.port || port, security, mcpHttp }).catch((error) => {
          sendError(response, error);
        });
      });
      return candidateServer;
    }
  });

  const url = `http://${host}:${actualPort}`;
  const usedPortFallback = requestedPort !== 0 && actualPort !== requestedPort;
  await writeServerState(store, {
    url,
    host,
    port: actualPort,
    requestedPort,
    portFallback: usedPortFallback
  });
  const unsubscribeWebhooks = registerWebhookDispatcher(store, {
    listWebhooks,
    recordWebhookDelivery,
    insertWebhookFailureAudit
  });
  const stopEventPoller = await startCrossProcessEventPoller(store);
  const stopRetentionSweep = await startRetentionSweep(store);
  return {
    server,
    store,
    url,
    requestedPort,
    port: actualPort,
    portFallback: usedPortFallback,
    securityWarning: exposureWarning({ host, config: security }),
    close: () => new Promise((resolve, reject) => {
      unsubscribeWebhooks();
      stopEventPoller();
      stopRetentionSweep();
      // Drop this store's rate limiter so a server that gets closed and
      // restarted against the same store (as tests do repeatedly) doesn't
      // leak one limiter Map per lifecycle.
      rateLimiterRegistry.delete(store.home);
      server.close((error) => (error ? reject(error) : resolve()));
      // Long-lived SSE connections (see handleEventStream) are intentionally
      // kept open with `connection: keep-alive` and would otherwise make
      // http.Server#close() hang forever waiting for clients to disconnect.
      // Force them closed once shutdown has been requested.
      server.closeAllConnections?.();
    })
  };
}

async function listenWithFallback({ host, requestedPort, allowPortFallback, createServer }) {
  const candidates = portCandidates(requestedPort, allowPortFallback);
  let lastError;

  for (const port of candidates) {
    const server = createServer(port);
    try {
      await listenOnce(server, port, host);
      return {
        server,
        actualPort: server.address().port
      };
    } catch (error) {
      lastError = error;
      await closeServer(server);
      if (!allowPortFallback || error.code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  throw lastError;
}

function portCandidates(port, allowPortFallback) {
  if (!allowPortFallback || port === 0) {
    return [port];
  }
  return [
    port,
    ...Array.from({ length: FALLBACK_PORT_ATTEMPTS }, (_, index) => port + index + 1),
    0
  ];
}

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

export async function handleRequest({ request, response, store, host, port, security = securityConfig(), mcpHttp = false }) {
  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
  const pathname = decodeURIComponent(url.pathname);
  const baseUrl = `http://${host}:${port}`;
  const authToken = url.searchParams.get("token") || "";
  const locale = localeFromUrl(url);
  const currentPath = `${url.pathname}${url.search}`;
  const headOnly = request.method === "HEAD";
  const method = headOnly ? "GET" : request.method;

  if (method === "GET" && pathname === EDITOR_CLIENT_PATH) {
    return sendJavaScriptFile(response, editorClientFilePath(PACKAGE_ROOT), headOnly, request);
  }

  if (method === "GET" && pathname === VIEWER_CLIENT_PATH) {
    return sendJavaScriptFile(response, viewerClientFilePath(PACKAGE_ROOT), headOnly, request);
  }

  if (method === "GET" && pathname.startsWith("/vendor/npm/")) {
    const packageName = pathname.slice("/vendor/npm/".length);
    const vendorPath = editorVendorPath(packageName, PACKAGE_ROOT);
    if (!vendorPath) {
      return sendJson(response, { error: "Not found" }, 404, headOnly);
    }
    return sendJavaScriptFile(response, vendorPath, headOnly, request);
  }

  if (method === "GET" && pathname === "/openapi.json") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    response.end(headOnly ? undefined : `${JSON.stringify(buildOpenApiDocument({ baseUrl }), null, 2)}\n`);
    return;
  }

  if (method === "GET" && pathname === "/docs/api") {
    return sendHtml(response, renderApiDocsHtml({ baseUrl }), 200, headOnly);
  }

  const userCount = await countUsers(store);
  const currentUser = userCount > 0 ? await sessionUserFromRequest(store, request) : null;
  if (currentUser?.passwordResetRequired && !["/account/password", "/logout"].includes(pathname)) {
    return sendRedirect(response, "/account/password?required=1");
  }

  if (method === "GET" && pathname === "/login") {
    return sendHtml(response, renderLoginPage({
      baseUrl,
      setup: userCount === 0,
      locale,
      currentPath
    }), 200, headOnly);
  }

  if (method === "POST" && pathname === "/login") {
    await enforceRateLimit({ store, host, request, bucket: "auth" });
    const body = await readFormBody(request);
    const email = body.email;
    const password = body.password;
    const user = userCount === 0
      ? await createUser(store, {
        email,
        name: body.name || email,
        role: "admin",
        password
      })
      : await verifyUserPassword(store, email, password);
    if (!user) {
      return sendHtml(response, renderLoginPage({
        baseUrl,
        setup: false,
        error: "Invalid email or password.",
        locale,
        currentPath
      }), 401);
    }
    const session = await createSession(store, user.id);
    return sendRedirect(response, user.passwordResetRequired ? "/account/password?required=1" : "/account", {
      "set-cookie": sessionCookie(session.token)
    });
  }

  if (method === "POST" && pathname === "/logout") {
    await revokeSession(store, sessionTokenFromRequest(request));
    return sendRedirect(response, "/login", {
      "set-cookie": clearSessionCookie()
    });
  }

  if (method === "GET" && pathname === "/account/password") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    return sendHtml(response, renderPasswordPage({
      baseUrl,
      user: currentUser,
      required: currentUser.passwordResetRequired || url.searchParams.get("required") === "1",
      locale,
      currentPath
    }), 200, headOnly);
  }

  if (method === "POST" && pathname === "/account/password") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    const body = await readFormBody(request);
    if (body.newPassword !== body.confirmPassword) {
      return sendHtml(response, renderPasswordPage({
        baseUrl,
        user: currentUser,
        required: currentUser.passwordResetRequired,
        error: "New password and confirmation do not match.",
        locale,
        currentPath
      }), 400);
    }
    try {
      const updatedUser = await changeUserPassword(store, currentUser.id, {
        currentPassword: body.currentPassword,
        newPassword: body.newPassword
      });
      return sendHtml(response, renderPasswordPage({
        baseUrl,
        user: updatedUser,
        success: "Password changed.",
        locale,
        currentPath
      }));
    } catch (error) {
      if ((error.statusCode || 500) >= 500) {
        throw error;
      }
      return sendHtml(response, renderPasswordPage({
        baseUrl,
        user: currentUser,
        required: currentUser.passwordResetRequired,
        error: error.message,
        locale,
        currentPath
      }), error.statusCode || 400);
    }
  }

  if (method === "GET" && pathname === "/account") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    const tokens = await listApiTokens(store, currentUser.id);
    const privateArtifactsPage = await listArtifactsPage(store, {
      visibility: "private",
      ownerUserId: currentUser.id,
      includeArchived: true,
      limit: 100,
      access: { userId: currentUser.id, role: currentUser.role, anonymous: false }
    });
    return sendHtml(response, renderAccountPage({
      baseUrl,
      user: currentUser,
      tokens,
      privateArtifacts: privateArtifactsPage.artifacts,
      locale,
      currentPath
    }), 200, headOnly);
  }

  if (method === "POST" && pathname === "/account/tokens") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const body = await readFormBody(request);
    const requestedScopes = [];
    if (body.scopeRead !== undefined) {
      requestedScopes.push("read");
    }
    if (body.scopeWrite !== undefined) {
      requestedScopes.push("write");
    }
    if (body.scopeAdmin !== undefined) {
      requestedScopes.push("admin");
    }
    const created = await createApiToken(store, currentUser.id, {
      name: body.name,
      scopes: requestedScopes.length > 0 ? requestedScopes : undefined
    });
    const tokens = await listApiTokens(store, currentUser.id);
    return sendHtml(response, renderAccountPage({
      baseUrl,
      user: currentUser,
      tokens,
      createdToken: created.token,
      locale,
      currentPath: "/account"
    }));
  }

  const tokenRevokeMatch = /^\/account\/tokens\/([^/]+)\/revoke$/.exec(pathname);
  if (tokenRevokeMatch && method === "POST") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    await revokeApiToken(store, tokenRevokeMatch[1], currentUser.id);
    return sendRedirect(response, "/account");
  }

  if (method === "GET" && pathname === "/admin/backup") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    return sendHtml(response, renderAdminBackupPage({
      baseUrl,
      user: currentUser,
      integrity: await checkStoreIntegrity(store),
      locale,
      currentPath
    }), 200, headOnly);
  }

  if (method === "GET" && pathname === "/admin/backup/export") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    const exportScope = url.searchParams.get("scope") === "full" ? "full" : "artifacts";
    return sendBackupDownload(response, await exportStoreToString(store, { scope: exportScope }), headOnly, exportScope);
  }

  if (method === "POST" && pathname === "/admin/backup/import") {
    assertLocalOrigin(request);
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    const body = await readFormBody(request, MAX_BACKUP_BYTES);
    try {
      const importResult = await importStoreFromString(store, body.backup || "", {
        confirm: body.confirm,
        forceUsers: body.forceUsers === "1" || body.forceUsers === "true"
      });
      return sendHtml(response, renderAdminBackupPage({
        baseUrl,
        user: currentUser,
        integrity: await checkStoreIntegrity(store),
        importResult,
        locale,
        currentPath: "/admin/backup"
      }));
    } catch (error) {
      if ((error.statusCode || 500) >= 500) {
        throw error;
      }
      return sendHtml(response, renderAdminBackupPage({
        baseUrl,
        user: currentUser,
        integrity: await checkStoreIntegrity(store),
        importError: error.message,
        locale,
        currentPath: "/admin/backup"
      }), error.statusCode || 400);
    }
  }

  if (method === "GET" && pathname === "/admin/users") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    return sendHtml(response, renderAdminUsersPage({
      baseUrl,
      user: currentUser,
      users: await listUsers(store),
      locale,
      currentPath
    }), 200, headOnly);
  }

  if (method === "POST" && pathname === "/admin/users") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    const body = await readFormBody(request);
    await createUser(store, {
      email: body.email,
      name: body.name || body.email,
      role: body.role || "user",
      password: body.password,
      passwordResetRequired: body.passwordResetRequired === "on"
    });
    return sendRedirect(response, "/admin/users");
  }

  if (method === "POST" && pathname === "/admin/users/import") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    const body = await readFormBody(request);
    try {
      const importResult = await importUsersFromCsv(store, body.csv || "", {
        passwordResetRequired: true
      });
      return sendHtml(response, renderAdminUsersPage({
        baseUrl,
        user: currentUser,
        users: await listUsers(store),
        importResult,
        locale,
        currentPath: "/admin/users"
      }));
    } catch (error) {
      if ((error.statusCode || 500) >= 500) {
        throw error;
      }
      return sendHtml(response, renderAdminUsersPage({
        baseUrl,
        user: currentUser,
        users: await listUsers(store),
        importError: error.message,
        locale,
        currentPath: "/admin/users"
      }), error.statusCode || 400);
    }
  }

  const userActiveMatch = /^\/admin\/users\/([^/]+)\/(enable|disable)$/.exec(pathname);
  if (userActiveMatch && method === "POST") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    if (userActiveMatch[1] === currentUser.id && userActiveMatch[2] === "disable") {
      throw Object.assign(new Error("Admins cannot disable their own account"), {
        statusCode: 400,
        code: "SELF_DISABLE_BLOCKED"
      });
    }
    await setUserActive(store, userActiveMatch[1], userActiveMatch[2] === "enable");
    return sendRedirect(response, "/admin/users");
  }

  const adminVersionsMatch = /^\/admin\/artifacts\/([^/]+)\/versions$/.exec(pathname);
  if (adminVersionsMatch && method === "GET") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    const artifact = await getArtifact(store, adminVersionsMatch[1], {
      version: url.searchParams.get("version") || undefined
    });
    return sendHtml(response, renderAdminArtifactVersionsPage({
      artifact,
      selectedVersion: artifact.version,
      content: artifact.content,
      baseUrl,
      user: currentUser,
      locale,
      currentPath
    }), 200, headOnly);
  }

  const adminVersionActionMatch = /^\/admin\/artifacts\/([^/]+)\/versions\/(\d+)\/(repair|delete)$/.exec(pathname);
  if (adminVersionActionMatch && method === "POST") {
    assertLocalOrigin(request);
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    request.artifactyAuth = {
      type: "session",
      actor: currentUser.email,
      user: currentUser,
      role: currentUser.role
    };
    const body = await readFormBody(request);
    const bodyLocale = localeFromBodyOrUrl(body, url);
    const artifactId = adminVersionActionMatch[1];
    const versionNumber = Number(adminVersionActionMatch[2]);
    const action = adminVersionActionMatch[3];
    if (action === "repair") {
      await replaceArtifactVersion(store, artifactId, versionNumber, {
        content: body.content,
        format: body.format,
        reason: body.reason,
        metadata: {
          repairedVia: "artifacty-admin"
        },
        audit: auditContext(request, "web-admin")
      });
    } else {
      await deleteArtifactVersion(store, artifactId, versionNumber, {
        reason: body.reason,
        audit: auditContext(request, "web-admin")
      });
    }
    return sendRedirect(response, localizedHref(`/admin/artifacts/${encodeURIComponent(artifactId)}/versions`, bodyLocale));
  }

  if (method === "GET" && pathname === "/admin/webhooks") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    const pendingSecret = consumePendingWebhookSecret(url.searchParams.get("secretNonce"));
    return sendHtml(response, renderAdminWebhooksPage({
      baseUrl,
      user: currentUser,
      webhooks: (await listWebhooks(store)).map(omitSecretHash),
      createdSecret: pendingSecret?.secret || null,
      createdWebhookId: pendingSecret?.webhookId || null,
      locale,
      currentPath
    }), 200, headOnly);
  }

  if (method === "POST" && pathname === "/admin/webhooks") {
    assertLocalOrigin(request);
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    const body = await readFormBody(request);
    const created = await createWebhook(store, {
      url: body.url,
      eventTypes: splitTags(body.eventTypes),
      ownerUserId: currentUser.id,
      audit: auditContext(request, "web-admin")
    });
    const secretNonce = stashPendingWebhookSecret(created.id, created.secret);
    return sendRedirect(response, `/admin/webhooks?created=1&secretNonce=${encodeURIComponent(secretNonce)}&webhookId=${encodeURIComponent(created.id)}`);
  }

  const webhookDeleteMatch = /^\/admin\/webhooks\/([^/]+)\/delete$/.exec(pathname);
  if (webhookDeleteMatch && method === "POST") {
    assertLocalOrigin(request);
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    await deleteWebhook(store, webhookDeleteMatch[1], { audit: auditContext(request, "web-admin") });
    return sendRedirect(response, "/admin/webhooks");
  }

  if (method === "GET" && pathname === "/admin/retention") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    return sendHtml(response, renderAdminRetentionPage({
      baseUrl,
      user: currentUser,
      policy: await getRetentionPolicy(store),
      lastSweep: await lastRetentionSweep(store),
      locale,
      currentPath
    }), 200, headOnly);
  }

  if (method === "POST" && pathname === "/admin/retention") {
    assertLocalOrigin(request);
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    const body = await readFormBody(request);
    await setRetentionPolicy(store, retentionPolicyFromForm(body), { audit: auditContext(request, "web-admin") });
    return sendRedirect(response, "/admin/retention?saved=1");
  }

  if (method === "POST" && pathname === "/admin/retention/run") {
    assertLocalOrigin(request);
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    requireAdmin(currentUser);
    const body = await readFormBody(request);
    // Checkbox semantics: an unchecked checkbox is omitted from the form
    // body entirely, so the presence of any truthy value means "checked".
    const dryRun = body.dryRun === "1" || body.dryRun === "true" || body.dryRun === "on";
    const report = await runRetention(store, {
      dryRun,
      allowPurge: body.allowPurge === "1" || body.allowPurge === "true"
    });
    return sendHtml(response, renderAdminRetentionPage({
      baseUrl,
      user: currentUser,
      policy: await getRetentionPolicy(store),
      lastSweep: await lastRetentionSweep(store),
      report,
      locale,
      currentPath: "/admin/retention"
    }));
  }

  if (pathname === "/mcp") {
    if (!mcpHttp) {
      return sendJson(response, { error: "Not found" }, 404, headOnly);
    }
    request.artifactyAuth = await requireRequestAuth({ store, request, url, config: security });
    return handleMcpHttpRequest({
      request,
      response,
      store,
      baseUrl,
      headOnly,
      method,
      host
    });
  }

  if (pathname.startsWith("/api/")) {
    request.artifactyAuth = await requireRequestAuth({ store, request, url, config: security });
  }

  if (method === "GET" && pathname === "/health") {
    return sendJson(response, { ok: true, name: "artifacty", store: store.home }, 200, headOnly);
  }

  if (method === "GET" && pathname === "/") {
    const access = accessContext(request, currentUser);
    const resolved = await resolveListFilters(store, url, access);
    const filters = {
      ...resolved,
      groupBy: url.searchParams.get("groupBy") || "",
      limit: url.searchParams.get("limit") || undefined,
      offset: url.searchParams.get("offset") || undefined
    };
    const page = await listArtifactsPage(store, {
      query: filters.query || undefined,
      tag: filters.tag || undefined,
      sourceAgent: filters.sourceAgent || undefined,
      artifactType: filters.artifactType || undefined,
      publisher: filters.publisher || undefined,
      createdAfter: filters.createdAfter || undefined,
      createdBefore: filters.createdBefore || undefined,
      reviewStatus: filters.reviewStatus || undefined,
      relatedTo: filters.relatedTo || undefined,
      relation: filters.relation || undefined,
      mode: filters.mode || undefined,
      includeArchived: filters.includeArchived,
      limit: filters.limit,
      offset: filters.offset,
      access
    });
    const savedViews = await listSavedViews(store, { access });
    return sendHtml(response, renderDashboard({
      artifacts: page.artifacts,
      baseUrl,
      filters,
      pagination: page,
      locale,
      currentPath,
      user: currentUser,
      savedViews,
      embeddingsAvailable: Boolean(createEmbeddingProvider(process.env))
    }), 200, headOnly);
  }

  if (method === "POST" && pathname === "/views") {
    assertLocalOrigin(request);
    const body = await readFormBody(request);
    const bodyLocale = localeFromBodyOrUrl(body, url);
    request.artifactyAuth = await requireBrowserWriteAuth({ store, request, url, body, config: security, currentUser });
    await enforceRateLimit({ store, host, request, bucket: "write" });
    await createSavedView(store, {
      name: body.name,
      filters: savedViewFiltersFromForm(body),
      shared: body.shared === "true" || body.shared === "on",
      access: accessContext(request, currentUser),
      audit: auditContext(request, "web")
    });
    return sendRedirect(response, localizedHref("/", bodyLocale));
  }

  const viewDeleteFormMatch = /^\/views\/([^/]+)\/delete$/.exec(pathname);
  if (viewDeleteFormMatch && method === "POST") {
    assertLocalOrigin(request);
    const body = await readFormBody(request);
    const bodyLocale = localeFromBodyOrUrl(body, url);
    request.artifactyAuth = await requireBrowserWriteAuth({ store, request, url, body, config: security, currentUser });
    await enforceRateLimit({ store, host, request, bucket: "write" });
    await deleteSavedView(store, viewDeleteFormMatch[1], {
      access: accessContext(request, currentUser),
      audit: auditContext(request, "web")
    });
    return sendRedirect(response, localizedHref("/", bodyLocale));
  }

  if (method === "GET" && pathname === "/new") {
    return sendHtml(response, renderNewArtifactPage({ baseUrl, authToken, locale, currentPath }), 200, headOnly);
  }

  if (method === "POST" && pathname === "/new") {
    assertLocalOrigin(request);
    const body = await readFormBody(request);
    const bodyLocale = localeFromBodyOrUrl(body, url);
    request.artifactyAuth = await requireBrowserWriteAuth({ store, request, url, body, config: security, currentUser });
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const artifact = await createArtifact(store, {
      title: body.title,
      content: body.content,
      format: body.format,
      artifactType: body.artifactType,
      sourceAgent: body.sourceAgent || "artifacty",
      tags: splitTags(body.tags),
      visibility: body.visibility || undefined,
      metadata: {
        createdVia: "artifacty-web"
      },
      audit: auditContext(request, "web")
    });
    return sendRedirect(response, localizedHref(`/artifacts/${encodeURIComponent(artifact.id)}`, bodyLocale));
  }

  if (method === "GET" && pathname === "/import") {
    return sendHtml(response, renderImportArtifactPage({ baseUrl, authToken, locale, currentPath }), 200, headOnly);
  }

  if (method === "POST" && pathname === "/import") {
    assertLocalOrigin(request);
    const body = await readFormBody(request);
    const bodyLocale = localeFromBodyOrUrl(body, url);
    request.artifactyAuth = await requireBrowserWriteAuth({ store, request, url, body, config: security, currentUser });
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const converted = convertAgentArtifact({
      agent: body.agent,
      title: body.title,
      content: body.content,
      fileName: body.fileName,
      tags: splitTags(body.tags),
      metadata: {
        createdVia: "artifacty-web-import"
      }
    });
    const artifact = await createArtifact(store, {
      ...converted,
      visibility: body.visibility || undefined,
      auditAction: "import",
      audit: auditContext(request, "web")
    });
    return sendRedirect(response, localizedHref(`/artifacts/${encodeURIComponent(artifact.id)}`, bodyLocale));
  }

  if (method === "GET" && pathname === "/api/artifacts") {
    await requireApiScope(store, request, "read");
    const access = accessContext(request, currentUser);
    const resolved = await resolveListFilters(store, url, access);
    const searchQuery = resolved.query || "";
    if (searchQuery) {
      await enforceRateLimit({ store, host, request, bucket: "search" });
    }
    const page = await listArtifactsPage(store, {
      query: searchQuery || undefined,
      tag: resolved.tag || undefined,
      sourceAgent: resolved.sourceAgent || undefined,
      artifactType: resolved.artifactType || undefined,
      publisher: resolved.publisher || undefined,
      createdAfter: resolved.createdAfter || undefined,
      createdBefore: resolved.createdBefore || undefined,
      reviewStatus: resolved.reviewStatus || undefined,
      relatedTo: resolved.relatedTo || undefined,
      relation: resolved.relation || undefined,
      mode: resolved.mode || undefined,
      includeArchived: resolved.includeArchived,
      limit: url.searchParams.get("limit") || undefined,
      offset: url.searchParams.get("offset") || undefined,
      access
    });
    return sendJson(response, {
      artifacts: page.artifacts,
      pagination: paginationJson(page),
      search: page.search
    }, 200, headOnly);
  }

  if (method === "GET" && pathname === "/api/audit") {
    await requireApiScope(store, request, "read");
    const events = await listAuditEvents(store, {
      artifactId: url.searchParams.get("artifactId") || undefined,
      limit: url.searchParams.get("limit") || undefined,
      access: accessContext(request, currentUser)
    });
    return sendJson(response, { events }, 200, headOnly);
  }

  if (method === "GET" && pathname === "/api/events") {
    await requireApiScope(store, request, "read");
    const filter = eventFilterFromQuery(url);
    const eventsAccess = accessContext(request, currentUser);
    const accept = String(request.headers.accept || "");
    if (accept.includes("text/event-stream")) {
      return handleEventStream({ request, response, store, filter, access: eventsAccess });
    }
    const since = Number(url.searchParams.get("since") || 0) || 0;
    const events = await listEventsSince(store, since, filter, 200, eventsAccess);
    const seq = events.length > 0 ? events[events.length - 1].seq : since;
    return sendJson(response, { events: events.map(sanitizeEventForDelivery), seq }, 200, headOnly);
  }

  if (method === "GET" && pathname === "/api/webhooks") {
    await requireApiScope(store, request, "admin");
    requireWebhookAdminAuth(request.artifactyAuth, await countUsers(store));
    const webhooks = await listWebhooks(store, { ownerUserId: undefined });
    return sendJson(response, { webhooks: webhooks.map(omitSecretHash) }, 200, headOnly);
  }

  if (method === "POST" && pathname === "/api/webhooks") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "admin");
    requireWebhookAdminAuth(request.artifactyAuth, await countUsers(store));
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const body = await readJsonBody(request);
    const webhook = await createWebhook(store, {
      url: body.url,
      eventTypes: body.eventTypes,
      filter: body.filter,
      ownerUserId: request.artifactyAuth?.user?.id || null,
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, omitSecretHash(webhook, { includeSecret: true }), 201);
  }

  const webhookMatch = /^\/api\/webhooks\/([^/]+)$/.exec(pathname);
  if (webhookMatch && method === "DELETE") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "admin");
    requireWebhookAdminAuth(request.artifactyAuth, await countUsers(store));
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const webhook = await deleteWebhook(store, webhookMatch[1], { audit: auditContext(request, "http-api") });
    return sendJson(response, omitSecretHash(webhook), 200, headOnly);
  }

  const webhookTestMatch = /^\/api\/webhooks\/([^/]+)\/test$/.exec(pathname);
  if (webhookTestMatch && method === "POST") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "admin");
    requireWebhookAdminAuth(request.artifactyAuth, await countUsers(store));
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const webhook = await getWebhook(store, webhookTestMatch[1]);
    const testEvent = {
      id: `evt_test_${Date.now()}`,
      type: "artifact.updated",
      createdAt: new Date().toISOString(),
      artifactId: null,
      version: null,
      actor: request.artifactyAuth?.actor || "test",
      sourceAgent: "artifacty-webhook-test",
      surface: "http-api",
      tags: [],
      artifactType: null
    };
    const result = await deliverWebhook({ webhook, event: testEvent });
    await recordWebhookDelivery(store, webhook.id, { ok: result.ok, status: result.status, disable: false });
    return sendJson(response, { ok: result.ok, status: result.status, attempts: result.attempts, error: result.error }, 200, headOnly);
  }

  if (method === "GET" && pathname === "/api/views") {
    await requireApiScope(store, request, "read");
    const views = await listSavedViews(store, { access: accessContext(request, currentUser) });
    return sendJson(response, { views }, 200, headOnly);
  }

  if (method === "POST" && pathname === "/api/views") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "write");
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const body = await readJsonBody(request);
    const view = await createSavedView(store, {
      name: body.name,
      filters: body.filters,
      shared: Boolean(body.shared),
      access: accessContext(request, currentUser),
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, view, 201);
  }

  const viewDeleteMatch = /^\/api\/views\/([^/]+)$/.exec(pathname);
  if (viewDeleteMatch && method === "DELETE") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "write");
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const view = await deleteSavedView(store, viewDeleteMatch[1], {
      access: accessContext(request, currentUser),
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, view, 200, headOnly);
  }

  if (method === "GET" && pathname === "/api/admin/backup") {
    await requireApiScope(store, request, "admin");
    requireAdminAuth(request.artifactyAuth);
    const apiExportScope = url.searchParams.get("scope") === "full" ? "full" : "artifacts";
    return sendJson(response, await buildStoreBackup(store, { scope: apiExportScope }), 200, headOnly, {
      "content-disposition": `attachment; filename="${backupFileName(apiExportScope)}"`
    });
  }

  if (method === "POST" && pathname === "/api/admin/backup/import") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "admin");
    requireAdminAuth(request.artifactyAuth);
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const body = await readJsonBody(request, MAX_BACKUP_BYTES);
    const importOptions = { confirm: body.confirm, forceUsers: Boolean(body.forceUsers) };
    let result;
    if (typeof body.backup === "string") {
      result = await importStoreFromString(store, body.backup, importOptions);
    } else if (body.bundle && typeof body.bundle === "object") {
      result = await importStoreBundle(store, body.bundle, importOptions);
    } else {
      result = await importStoreBundle(store, Array.isArray(body.artifacts) ? body : body.backup, importOptions);
    }
    return sendJson(response, result);
  }

  if (method === "GET" && pathname === "/api/admin/retention") {
    await requireApiScope(store, request, "admin");
    requireAdminAuth(request.artifactyAuth);
    return sendJson(response, await getRetentionPolicy(store), 200, headOnly);
  }

  if (method === "PUT" && pathname === "/api/admin/retention") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "admin");
    requireAdminAuth(request.artifactyAuth);
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const body = await readJsonBody(request);
    const saved = await setRetentionPolicy(store, body, { audit: auditContext(request, "http-api") });
    return sendJson(response, saved);
  }

  if (method === "POST" && pathname === "/api/admin/retention/run") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "admin");
    requireAdminAuth(request.artifactyAuth);
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const body = await readJsonBody(request);
    const dryRun = body.dryRun === undefined ? true : Boolean(body.dryRun);
    const report = await runRetention(store, { dryRun, allowPurge: Boolean(body.allowPurge) });
    return sendJson(response, report);
  }

  if (method === "POST" && pathname === "/api/artifacts") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "write");
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const body = await readJsonBody(request);
    const artifact = await createArtifact(store, {
      ...pickCreateArtifactInput(body),
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, decorateArtifactUrls(artifact, baseUrl), 201);
  }

  if (method === "POST" && pathname === "/api/import") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "write");
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const body = await readJsonBody(request);
    const converted = convertAgentArtifact(body);
    const artifact = await createArtifact(store, {
      ...pickCreateArtifactInput(converted),
      auditAction: "import",
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, {
      ...decorateArtifactUrls(artifact, baseUrl),
      converted
    }, 201);
  }

  const editMatch = /^\/artifacts\/([^/]+)\/edit$/.exec(pathname);
  if (editMatch && method === "GET") {
    const artifact = await getArtifact(store, editMatch[1], {
      version: url.searchParams.get("version") || undefined,
      access: accessContext(request, currentUser)
    });
    return sendHtml(response, renderArtifactFormPage({
      mode: "edit",
      baseUrl,
      artifact,
      version: artifact.version,
      content: artifact.content,
      authToken,
      locale,
      currentPath
    }), 200, headOnly);
  }

  if (editMatch && method === "POST") {
    assertLocalOrigin(request);
    const body = await readFormBody(request);
    const bodyLocale = localeFromBodyOrUrl(body, url);
    request.artifactyAuth = await requireBrowserWriteAuth({ store, request, url, body, config: security, currentUser });
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const expectedVersion = expectedVersionFromBody(body);
    try {
      const artifact = await updateArtifact(store, editMatch[1], {
        title: body.title,
        content: body.content,
        format: body.format,
        artifactType: body.artifactType,
        sourceAgent: body.sourceAgent || "artifacty",
        tags: splitTags(body.tags),
        metadata: {
          updatedVia: "artifacty-web"
        },
        skipNoop: true,
        expectedVersion,
        access: accessContext(request, currentUser),
        audit: auditContext(request, "web")
      });
      return sendRedirect(response, localizedHref(`/artifacts/${encodeURIComponent(artifact.id)}`, bodyLocale));
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const current = await getArtifact(store, editMatch[1], { access: accessContext(request, currentUser) });
        const unsavedArtifact = {
          ...current,
          title: body.title || current.title,
          sourceAgent: body.sourceAgent || current.sourceAgent,
          artifactType: body.artifactType || current.artifactType,
          tags: splitTags(body.tags)
        };
        return sendHtml(response, renderArtifactFormPage({
          mode: "edit",
          baseUrl,
          artifact: unsavedArtifact,
          version: { ...current.version, format: body.format || current.version.format },
          content: body.content,
          expectedVersion,
          conflict: { latestVersion: error.latestVersion },
          authToken,
          locale: bodyLocale,
          currentPath
        }), 409, headOnly);
      }
      throw error;
    }
  }

  const diffMatch = /^\/artifacts\/([^/]+)\/diff$/.exec(pathname);
  if (diffMatch && method === "GET") {
    const diffAccess = accessContext(request, currentUser);
    const latest = await getArtifact(store, diffMatch[1], { access: diffAccess });
    const defaultFrom = Math.max(1, latest.latestVersion - 1);
    const fromNumber = Number(url.searchParams.get("from") || defaultFrom);
    const toNumber = Number(url.searchParams.get("to") || latest.latestVersion);
    const from = await getArtifact(store, diffMatch[1], { version: fromNumber, access: diffAccess });
    const to = await getArtifact(store, diffMatch[1], { version: toNumber, access: diffAccess });
    const diffFormat = diffFormatFor(latest.artifactType, to.version.format);
    const view = resolveDiffView({ artifactType: latest.artifactType, format: to.version.format, requestedView: url.searchParams.get("view") });
    const structuredDiff = view === "structured"
      ? createStructuredDiff(from.content, to.content, { format: diffFormat })
      : null;
    return sendHtml(response, renderDiffPage({
      artifact: latest,
      fromVersion: from.version,
      toVersion: to.version,
      fromContent: from.content,
      toContent: to.content,
      diffRows: view === "lines" ? createLineDiff(from.content, to.content) : [],
      view,
      structuredDiff,
      baseUrl,
      authToken,
      locale,
      currentPath
    }), 200, headOnly);
  }

  const apiDiffMatch = /^\/api\/artifacts\/([^/]+)\/diff$/.exec(pathname);
  if (apiDiffMatch && method === "GET") {
    await requireApiScope(store, request, "read");
    const apiDiffAccess = accessContext(request, currentUser);
    const latest = await getArtifact(store, apiDiffMatch[1], { access: apiDiffAccess });
    const defaultFrom = Math.max(1, latest.latestVersion - 1);
    const fromNumber = Number(url.searchParams.get("from") || defaultFrom);
    const toNumber = Number(url.searchParams.get("to") || latest.latestVersion);
    const from = await getArtifact(store, apiDiffMatch[1], { version: fromNumber, access: apiDiffAccess });
    const to = await getArtifact(store, apiDiffMatch[1], { version: toNumber, access: apiDiffAccess });
    const diffFormat = diffFormatFor(latest.artifactType, to.version.format);
    const view = resolveDiffView({ artifactType: latest.artifactType, format: to.version.format, requestedView: url.searchParams.get("view") });
    const structuredDiff = view === "structured"
      ? createStructuredDiff(from.content, to.content, { format: diffFormat })
      : null;
    return sendJson(response, {
      id: latest.id,
      from: from.version.version,
      to: to.version.version,
      view,
      format: diffFormat,
      diffRows: view === "lines" ? createLineDiff(from.content, to.content) : undefined,
      structuredDiff
    }, 200, headOnly);
  }

  const archiveMatch = /^\/artifacts\/([^/]+)\/(archive|restore)$/.exec(pathname);
  if (archiveMatch && method === "POST") {
    assertLocalOrigin(request);
    const body = await readFormBody(request);
    const bodyLocale = localeFromBodyOrUrl(body, url);
    request.artifactyAuth = await requireBrowserWriteAuth({ store, request, url, body, config: security, currentUser });
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const artifact = archiveMatch[2] === "archive"
      ? await archiveArtifact(store, archiveMatch[1], { access: accessContext(request, currentUser), audit: auditContext(request, "web") })
      : await restoreArtifact(store, archiveMatch[1], { access: accessContext(request, currentUser), audit: auditContext(request, "web") });
    return sendRedirect(response, localizedHref(`/artifacts/${encodeURIComponent(artifact.id)}`, bodyLocale));
  }

  const visibilityFormMatch = /^\/artifacts\/([^/]+)\/visibility$/.exec(pathname);
  if (visibilityFormMatch && method === "POST") {
    assertLocalOrigin(request);
    const body = await readFormBody(request);
    const bodyLocale = localeFromBodyOrUrl(body, url);
    request.artifactyAuth = await requireBrowserWriteAuth({ store, request, url, body, config: security, currentUser });
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const artifact = await setArtifactVisibility(store, visibilityFormMatch[1], body.visibility, {
      access: accessContext(request, currentUser),
      audit: auditContext(request, "web")
    });
    return sendRedirect(response, localizedHref(`/artifacts/${encodeURIComponent(artifact.id)}`, bodyLocale));
  }

  const apiMatch = /^\/api\/artifacts\/([^/]+)$/.exec(pathname);
  if (apiMatch && method === "GET") {
    await requireApiScope(store, request, "read");
    const artifact = await getArtifact(store, apiMatch[1], {
      version: url.searchParams.get("version") || undefined,
      access: accessContext(request, currentUser)
    });
    const etag = `"${artifactEtag(artifact)}"`;
    const ifNoneMatch = request.headers["if-none-match"];
    if (ifNoneMatch && matchesEtag(ifNoneMatch, etag)) {
      response.writeHead(304, { etag });
      response.end();
      return;
    }
    return sendJson(response, decorateArtifactUrls(artifact, baseUrl), 200, headOnly, { etag });
  }

  if (apiMatch && method === "POST") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "write");
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const body = await readJsonBody(request);
    const expectedVersion = expectedVersionFromRequest(request, body);
    const artifact = await updateArtifact(store, apiMatch[1], {
      ...pickUpdateArtifactInput(body),
      expectedVersion,
      access: accessContext(request, currentUser),
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, decorateArtifactUrls(artifact, baseUrl));
  }

  const apiArchiveMatch = /^\/api\/artifacts\/([^/]+)\/(archive|restore)$/.exec(pathname);
  if (apiArchiveMatch && method === "POST") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "write");
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const artifact = apiArchiveMatch[2] === "archive"
      ? await archiveArtifact(store, apiArchiveMatch[1], { access: accessContext(request, currentUser), audit: auditContext(request, "http-api") })
      : await restoreArtifact(store, apiArchiveMatch[1], { access: accessContext(request, currentUser), audit: auditContext(request, "http-api") });
    return sendJson(response, decorateArtifactUrls(artifact, baseUrl));
  }

  const apiVisibilityMatch = /^\/api\/artifacts\/([^/]+)\/visibility$/.exec(pathname);
  if (apiVisibilityMatch && method === "POST") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "write");
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const body = await readJsonBody(request);
    const artifact = await setArtifactVisibility(store, apiVisibilityMatch[1], body.visibility, {
      access: accessContext(request, currentUser),
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, decorateArtifactUrls(artifact, baseUrl));
  }

  const apiOwnerMatch = /^\/api\/artifacts\/([^/]+)\/owner$/.exec(pathname);
  if (apiOwnerMatch && method === "POST") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "write");
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const body = await readJsonBody(request);
    const artifact = await setArtifactOwner(store, apiOwnerMatch[1], body.ownerUserId, {
      access: accessContext(request, currentUser),
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, decorateArtifactUrls(artifact, baseUrl));
  }

  const apiRelationsMatch = /^\/api\/artifacts\/([^/]+)\/relations$/.exec(pathname);
  if (apiRelationsMatch && method === "GET") {
    await requireApiScope(store, request, "read");
    const relations = await listRelations(store, apiRelationsMatch[1], {
      direction: url.searchParams.get("direction") || undefined,
      relation: url.searchParams.get("relation") || undefined,
      access: accessContext(request, currentUser)
    });
    return sendJson(response, relations, 200, headOnly);
  }

  if (apiRelationsMatch && method === "POST") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "write");
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const body = await readJsonBody(request);
    const relation = await addRelation(store, {
      fromId: apiRelationsMatch[1],
      toId: body.toId,
      relation: body.relation,
      metadata: body.metadata,
      access: accessContext(request, currentUser),
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, relation, 201);
  }

  const apiRelationDeleteMatch = /^\/api\/artifacts\/([^/]+)\/relations\/([^/]+)$/.exec(pathname);
  if (apiRelationDeleteMatch && method === "DELETE") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "write");
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const relation = await removeRelation(store, {
      relationId: apiRelationDeleteMatch[2],
      access: accessContext(request, currentUser),
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, relation, 200, headOnly);
  }

  const apiCommentsMatch = /^\/api\/artifacts\/([^/]+)\/comments$/.exec(pathname);
  if (apiCommentsMatch && method === "GET") {
    await requireApiScope(store, request, "read");
    const comments = await listComments(store, apiCommentsMatch[1], {
      version: url.searchParams.get("version") || undefined,
      status: url.searchParams.get("status") || undefined,
      includeDeleted: url.searchParams.get("includeDeleted") === "true",
      access: accessContext(request, currentUser)
    });
    return sendJson(response, { comments }, 200, headOnly);
  }

  if (apiCommentsMatch && method === "POST") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "write");
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const body = await readJsonBody(request);
    const comment = await addComment(store, apiCommentsMatch[1], {
      version: body.version,
      body: body.body,
      anchor: body.anchor,
      parentId: body.parentId,
      access: accessContext(request, currentUser),
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, comment, 201);
  }

  const apiCommentResolveMatch = /^\/api\/artifacts\/([^/]+)\/comments\/([^/]+)\/resolve$/.exec(pathname);
  if (apiCommentResolveMatch && method === "POST") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "write");
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const comment = await resolveComment(store, apiCommentResolveMatch[1], apiCommentResolveMatch[2], {
      access: accessContext(request, currentUser),
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, comment, 200, headOnly);
  }

  const apiCommentDeleteMatch = /^\/api\/artifacts\/([^/]+)\/comments\/([^/]+)$/.exec(pathname);
  if (apiCommentDeleteMatch && method === "DELETE") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "write");
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const comment = await deleteComment(store, apiCommentDeleteMatch[1], apiCommentDeleteMatch[2], {
      access: accessContext(request, currentUser),
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, comment, 200, headOnly);
  }

  const apiReviewStatusMatch = /^\/api\/artifacts\/([^/]+)\/review-status$/.exec(pathname);
  if (apiReviewStatusMatch && method === "POST") {
    assertLocalOrigin(request);
    await requireApiScope(store, request, "write");
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const body = await readJsonBody(request);
    const artifact = await setReviewStatus(store, apiReviewStatusMatch[1], body.status, {
      access: accessContext(request, currentUser),
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, decorateArtifactUrls(artifact, baseUrl));
  }

  const commentResolveFormMatch = /^\/artifacts\/([^/]+)\/comments\/([^/]+)\/resolve$/.exec(pathname);
  if (commentResolveFormMatch && method === "POST") {
    assertLocalOrigin(request);
    const body = await readFormBody(request);
    const bodyLocale = localeFromBodyOrUrl(body, url);
    request.artifactyAuth = await requireBrowserWriteAuth({ store, request, url, body, config: security, currentUser });
    await enforceRateLimit({ store, host, request, bucket: "write" });
    await resolveComment(store, commentResolveFormMatch[1], commentResolveFormMatch[2], {
      access: accessContext(request, currentUser),
      audit: auditContext(request, "web")
    });
    return sendRedirect(response, localizedHref(`/artifacts/${encodeURIComponent(commentResolveFormMatch[1])}`, bodyLocale));
  }

  const commentDeleteFormMatch = /^\/artifacts\/([^/]+)\/comments\/([^/]+)\/delete$/.exec(pathname);
  if (commentDeleteFormMatch && method === "POST") {
    assertLocalOrigin(request);
    const body = await readFormBody(request);
    const bodyLocale = localeFromBodyOrUrl(body, url);
    request.artifactyAuth = await requireBrowserWriteAuth({ store, request, url, body, config: security, currentUser });
    await enforceRateLimit({ store, host, request, bucket: "write" });
    await deleteComment(store, commentDeleteFormMatch[1], commentDeleteFormMatch[2], {
      access: accessContext(request, currentUser),
      audit: auditContext(request, "web")
    });
    return sendRedirect(response, localizedHref(`/artifacts/${encodeURIComponent(commentDeleteFormMatch[1])}`, bodyLocale));
  }

  const commentFormMatch = /^\/artifacts\/([^/]+)\/comments$/.exec(pathname);
  if (commentFormMatch && method === "POST") {
    assertLocalOrigin(request);
    const body = await readFormBody(request);
    const bodyLocale = localeFromBodyOrUrl(body, url);
    request.artifactyAuth = await requireBrowserWriteAuth({ store, request, url, body, config: security, currentUser });
    await enforceRateLimit({ store, host, request, bucket: "write" });
    const anchorLine = Number.parseInt(body.line, 10);
    await addComment(store, commentFormMatch[1], {
      version: body.version ? Number(body.version) : undefined,
      body: body.body,
      parentId: body.parentId || undefined,
      anchor: Number.isFinite(anchorLine) ? { line: anchorLine } : undefined,
      access: accessContext(request, currentUser),
      audit: auditContext(request, "web")
    });
    return sendRedirect(response, localizedHref(`/artifacts/${encodeURIComponent(commentFormMatch[1])}`, bodyLocale));
  }

  const reviewStatusFormMatch = /^\/artifacts\/([^/]+)\/review-status$/.exec(pathname);
  if (reviewStatusFormMatch && method === "POST") {
    assertLocalOrigin(request);
    const body = await readFormBody(request);
    const bodyLocale = localeFromBodyOrUrl(body, url);
    request.artifactyAuth = await requireBrowserWriteAuth({ store, request, url, body, config: security, currentUser });
    await enforceRateLimit({ store, host, request, bucket: "write" });
    await setReviewStatus(store, reviewStatusFormMatch[1], body.status, {
      access: accessContext(request, currentUser),
      audit: auditContext(request, "web")
    });
    return sendRedirect(response, localizedHref(`/artifacts/${encodeURIComponent(reviewStatusFormMatch[1])}`, bodyLocale));
  }

  const reactFrameMatch = /^\/artifacts\/([^/]+)\/react-frame$/.exec(pathname);
  if (reactFrameMatch && method === "GET") {
    if (process.env.ARTIFACTY_ENABLE_REACT_RENDERER !== "true") {
      return sendJson(response, { error: "React renderer is disabled" }, 403, headOnly);
    }
    const artifact = await getArtifact(store, reactFrameMatch[1], {
      version: url.searchParams.get("version") || undefined,
      access: accessContext(request, currentUser),
      audit: auditContext(request, "web-react-frame")
    });
    if (artifact.version.format !== "react") {
      return sendJson(response, { error: "Artifact version is not a React artifact" }, 400, headOnly);
    }
    return sendHtml(
      response,
      renderReactFramePage({ title: artifact.title, content: artifact.content }),
      200,
      headOnly,
      reactFrameContentSecurityPolicy()
    );
  }

  const exportMatch = /^\/artifacts\/([^/]+)\/export$/.exec(pathname);
  if (exportMatch && method === "GET") {
    return handleArtifactExport({ request, response, store, url, headOnly, currentUser, host, security, artifactId: exportMatch[1] });
  }

  const artifactMatch = /^\/artifacts\/([^/]+)(?:\/raw)?$/.exec(pathname);
  if (artifactMatch && method === "GET") {
    const artifact = await getArtifact(store, artifactMatch[1], {
      version: url.searchParams.get("version") || undefined,
      access: accessContext(request, currentUser),
      audit: auditContext(request, "browser")
    });

    if (pathname.endsWith("/raw")) {
      const bundleFileName = url.searchParams.get("file");
      if (bundleFileName) {
        const bundleFile = readBundleFile(artifact, artifact.content, bundleFileName);
        if (!bundleFile) {
          return sendJson(response, { error: "Bundle file not found" }, 404, headOnly);
        }
        const disposition = bundleFile.contentType === "application/pdf" ? "inline" : "attachment";
        response.writeHead(200, {
          "content-type": bundleFile.contentType,
          // Bundle file content is untrusted artifact content served under
          // the same origin as the dashboard; no-store (rather than
          // "private") plus a locked-down CSP and nosniff keep it from
          // being cached or executing as anything but an inert download.
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; frame-ancestors 'self'",
          "x-content-type-options": "nosniff",
          "content-disposition": buildContentDisposition(disposition, bundleFile.fileName)
        });
        response.end(headOnly ? undefined : bundleFile.body);
        return;
      }

      const raw = rawArtifactResponse(artifact);
      response.writeHead(200, {
        "content-type": raw.contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      });
      response.end(headOnly ? undefined : raw.body);
      return;
    }

    const comments = await listComments(store, artifactMatch[1], {
      access: accessContext(request, currentUser)
    });

    return sendHtml(response, renderArtifactPage({
      artifact,
      version: artifact.version,
      content: artifact.content,
      comments,
      baseUrl,
      authToken,
      locale,
      currentPath,
      user: currentUser
    }), 200, headOnly);
  }

  sendJson(response, { error: "Not found" }, 404);
}

export function decorateArtifactUrls(artifact, baseUrl) {
  return {
    ...artifact,
    url: `${baseUrl}/artifacts/${encodeURIComponent(artifact.id)}`,
    rawUrl: `${baseUrl}/artifacts/${encodeURIComponent(artifact.id)}/raw?version=${artifact.version.version}`
  };
}

async function handleMcpHttpRequest({ request, response, store, baseUrl, headOnly, method, host }) {
  if (method === "OPTIONS") {
    response.writeHead(204, {
      allow: "POST, OPTIONS",
      "cache-control": "no-store"
    });
    response.end();
    return;
  }

  if (method !== "POST") {
    response.writeHead(405, {
      allow: "POST, OPTIONS",
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    response.end(headOnly ? undefined : `${JSON.stringify({ error: "MCP endpoint accepts POST JSON-RPC requests" }, null, 2)}\n`);
    return;
  }

  const body = await readJsonBody(request);
  const messages = Array.isArray(body) ? body : [body];
  const handler = createMcpJsonRpcHandler({
    store,
    transport: "streamable-http",
    publicBaseUrl: baseUrl,
    serverCommand: `${baseUrl}/mcp`,
    browserCommand: baseUrl,
    auditContext: () => auditContext(request, "mcp-http"),
    auth: request.artifactyAuth,
    enforceRateLimit: async (bucket) => {
      const result = checkRateLimit({ store, host, request, bucket });
      if (!result.allowed) {
        await maybeAuditRateLimited(store, request, bucket, result.principal);
      }
      return result;
    }
  });
  const responses = [];
  for (const message of messages) {
    const jsonRpcResponse = await handler(message);
    if (jsonRpcResponse) {
      responses.push(jsonRpcResponse);
    }
  }

  if (responses.length === 0) {
    response.writeHead(202, {
      "cache-control": "no-store"
    });
    response.end();
    return;
  }

  sendJson(response, Array.isArray(body) ? responses : responses[0], 200, headOnly);
}

export async function readJsonBody(request, limitBytes = MAX_ARTIFACT_BYTES + 1024) {
  const raw = await readBody(request, limitBytes);
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error(`Invalid JSON body: ${error.message}`), {
      statusCode: 400,
      code: "INVALID_JSON"
    });
  }
}

export async function readFormBody(request, limitBytes = MAX_ARTIFACT_BYTES + 1024) {
  const raw = await readBody(request, limitBytes);
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

export async function readBody(request, limitBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > limitBytes) {
      throw Object.assign(new Error("Request body too large"), {
        statusCode: 413,
        code: "REQUEST_TOO_LARGE"
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function assertLocalOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) {
    return;
  }

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw Object.assign(new Error(`Rejected invalid origin: ${origin}`), {
      statusCode: 403,
      code: "NON_LOCAL_ORIGIN"
    });
  }

  const hostname = parsed.hostname.toLowerCase();
  const host = String(request.headers.host || "").toLowerCase();
  const allowed =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    (host && parsed.host.toLowerCase() === host && (parsed.protocol === "http:" || parsed.protocol === "https:"));
  if (!allowed) {
    throw Object.assign(new Error(`Rejected untrusted origin: ${origin}`), {
      statusCode: 403,
      code: "NON_LOCAL_ORIGIN"
    });
  }
}

export function sendJson(response, data, statusCode = 200, headOnly = false, headers = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(headOnly ? undefined : `${JSON.stringify(data, null, 2)}\n`);
}

function sendBackupDownload(response, content, headOnly = false, scope = "artifacts") {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${backupFileName(scope)}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(headOnly ? undefined : content);
}

function backupFileName(scope = "artifacts") {
  const suffix = scope === "full" ? "-full" : "";
  return `artifacty${suffix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
}

export function sendHtml(response, html, statusCode = 200, headOnly = false, contentSecurityPolicy = defaultContentSecurityPolicy()) {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": contentSecurityPolicy
  });
  response.end(headOnly ? undefined : html);
}

async function handleArtifactExport({ request, response, store, url, headOnly, currentUser, host, security, artifactId }) {
  // Unlike /artifacts/:id/raw and the viewer page, export renders a fresh
  // CSV/SARIF file server-side and can be a meaningfully sized response, so
  // it must go through the same token auth, scope, and rate-limit checks
  // /api/ routes get rather than being reachable by anyone who can hit
  // /artifacts/:id (session auth still works with no token configured).
  request.artifactyAuth = await requireBrowserWriteAuth({ store, request, url, body: {}, config: security, currentUser });
  await requireApiScope(store, request, "read");
  await enforceRateLimit({ store, host, request, bucket: "search" });

  const artifact = await getArtifact(store, artifactId, {
    version: url.searchParams.get("version") || undefined,
    access: accessContext(request, currentUser),
    audit: auditContext(request, "browser-export")
  });

  const format = url.searchParams.get("format");
  if (format !== "csv" && format !== "sarif") {
    throw Object.assign(new Error("format query parameter must be \"csv\" or \"sarif\""), {
      statusCode: 400,
      code: "invalid_export"
    });
  }
  if (artifact.version.format !== format) {
    throw Object.assign(new Error(`Artifact version format is "${artifact.version.format}", not "${format}"`), {
      statusCode: 400,
      code: "invalid_export"
    });
  }

  if (format === "csv") {
    const sortCol = url.searchParams.get("sort") || undefined;
    const dir = url.searchParams.get("dir") || undefined;
    const filterParsed = parseCsvFilterParam(url.searchParams.get("filter") || "");
    if (!filterParsed.ok) {
      throw Object.assign(new Error(filterParsed.error), { statusCode: 400, code: "invalid_export" });
    }
    const result = buildCsvExport({
      content: artifact.content,
      sortCol,
      dir,
      filters: filterParsed.filters,
      maxBytes: MAX_ARTIFACT_BYTES
    });
    if (!result.ok) {
      throw Object.assign(new Error(result.error), { statusCode: 400, code: "invalid_export" });
    }
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFileName(artifact, "csv")}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    response.end(headOnly ? undefined : result.csv);
    return;
  }

  const levelParam = url.searchParams.get("level") || "";
  const levels = levelParam
    ? levelParam.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
    : [];
  const ruleFilter = url.searchParams.get("rule") || "";
  const result = buildSarifExport({
    content: artifact.content,
    levels,
    ruleFilter,
    maxBytes: MAX_ARTIFACT_BYTES
  });
  if (!result.ok) {
    throw Object.assign(new Error(result.error), { statusCode: 400, code: "invalid_export" });
  }
  response.writeHead(200, {
    "content-type": "application/sarif+json; charset=utf-8",
    "content-disposition": `attachment; filename="${exportFileName(artifact, "sarif.json")}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(headOnly ? undefined : result.json);
}

function exportFileName(artifact, extension) {
  const slug = String(artifact.id || "artifact").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64) || "artifact";
  return `${slug}-export.${extension}`;
}

// Serves an individual binary file entry out of a bundle artifact (roadmap
// section 17: Document Assets in Bundles). Returns null when the artifact
// isn't a bundle, its content isn't valid bundle JSON, or no file entry
// matches `fileName`, so callers can respond 404.
// Builds a Content-Disposition header value safely from a publisher-supplied
// filename. The bundle name is untrusted content: it must never let CR/LF,
// quotes, or other control characters reach a raw header value (header
// injection / a thrown ERR_INVALID_CHAR from Node's header validation).
// `filename` is a strict ASCII allowlist fallback for legacy clients;
// `filename*` carries the full name (including non-ASCII) via RFC 5987
// percent-encoding for clients that support it.
function buildContentDisposition(disposition, rawName) {
  const fallback = "file";
  const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : fallback;
  const asciiName = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || fallback;
  const extended = encodeRfc5987ValueChars(name).slice(0, 400);
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${extended}`;
}

// Percent-encodes a string for use as an RFC 5987 ext-value (the value.after
// filename*=UTF-8''). encodeURIComponent already escapes everything outside
// its unreserved set except ! * ' ( ), which are not valid attr-chars, so
// those are escaped explicitly too.
function encodeRfc5987ValueChars(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function rawArtifactResponse(artifact) {
  if (artifact.version.format === "image" || artifact.version.format === "video") {
    const decoded = decodeMediaContent(artifact.content);
    if (decoded) {
      return {
        body: decoded,
        contentType: mediaContentType(artifact)
      };
    }
  }
  return {
    body: artifact.content,
    contentType: artifact.version.contentType
  };
}

function defaultContentSecurityPolicy() {
  return [
    "default-src 'self' data: blob:",
    "frame-src 'self' data: blob:",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'"
  ].join("; ");
}

function reactFrameContentSecurityPolicy() {
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; ");
}

export async function sendJavaScriptFile(response, filePath, headOnly = false, request = null) {
  const content = headOnly ? "" : await readFile(filePath, "utf8");
  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
    ...javascriptCorsHeaders(request),
    "x-content-type-options": "nosniff"
  });
  response.end(headOnly ? undefined : content);
}

function javascriptCorsHeaders(request) {
  if (request?.headers?.origin !== "null") {
    return {};
  }
  return {
    "access-control-allow-origin": "null",
    vary: "Origin"
  };
}

export function sendRedirect(response, location, headers = {}) {
  response.writeHead(303, {
    location,
    "cache-control": "no-store",
    ...headers
  });
  response.end();
}

export function sendError(response, error) {
  const statusCode = error.statusCode || 500;
  const body = {
    error: error.message,
    code: error.code || "SERVER_ERROR"
  };
  if (error.findings) {
    body.findings = error.findings;
  }
  if (error.details) {
    body.details = error.details;
  }
  const headers = {};
  if (Number.isFinite(error.retryAfter)) {
    headers["retry-after"] = String(error.retryAfter);
  }
  sendJson(response, body, statusCode, false, headers);
}

function parseEtagValue(value) {
  if (!value) {
    return null;
  }
  let trimmed = String(value).trim();
  if (trimmed.toUpperCase().startsWith("W/")) {
    trimmed = trimmed.slice(2).trim();
  }
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed || null;
}

function matchesEtag(headerValue, currentEtag) {
  const current = parseEtagValue(currentEtag);
  if (!current) {
    return false;
  }
  return String(headerValue)
    .split(",")
    .map((part) => parseEtagValue(part))
    .some((candidate) => candidate === "*" || candidate === current);
}

function expectedVersionFromBody(body) {
  const raw = body?.expectedVersion;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function expectedVersionFromIfMatch(request) {
  const header = request?.headers?.["if-match"];
  if (!header) {
    return null;
  }
  const parsed = parseEtagValue(header);
  if (!parsed) {
    return null;
  }
  const separatorIndex = parsed.lastIndexOf(":");
  if (separatorIndex === -1) {
    return null;
  }
  const versionPart = parsed.slice(separatorIndex + 1);
  const version = Number(versionPart);
  return Number.isFinite(version) ? version : null;
}

function expectedVersionFromRequest(request, body) {
  const fromBody = expectedVersionFromBody(body);
  if (fromBody !== null) {
    return fromBody;
  }
  return expectedVersionFromIfMatch(request);
}

function splitTags(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

async function lastRetentionSweep(store) {
  const events = await listAuditEvents(store, { action: "retention-sweep", limit: 1 });
  return events[0] || null;
}

function retentionPolicyFromForm(body) {
  const byType = parseArchiveAfterDaysPairs(String(body.archiveAfterDaysByType || "").split("\n"));
  return {
    archiveAfterDays: {
      default: body.archiveAfterDaysDefault === "" || body.archiveAfterDaysDefault === undefined ? null : Number(body.archiveAfterDaysDefault),
      byType
    },
    purgeArchivedAfterDays: body.purgeArchivedAfterDays === "" || body.purgeArchivedAfterDays === undefined ? null : Number(body.purgeArchivedAfterDays),
    auditRetentionDays: body.auditRetentionDays === "" || body.auditRetentionDays === undefined ? null : Number(body.auditRetentionDays),
    eventRetentionRows: body.eventRetentionRows === "" || body.eventRetentionRows === undefined ? null : Number(body.eventRetentionRows),
    keepTags: splitTags(body.keepTags)
  };
}

function eventFilterFromQuery(url) {
  const filter = {};
  for (const key of ["type", "tag", "artifactId", "sourceAgent"]) {
    const value = url.searchParams.get(key);
    if (value) {
      filter[key] = value;
    }
  }
  if (filter.type && !EVENT_TYPES.includes(filter.type)) {
    throw Object.assign(new Error(`Unsupported event type filter: ${filter.type}`), {
      statusCode: 400,
      code: "invalid_filter"
    });
  }
  return filter;
}

// Query-string keys for list filters, shared by the "/" dashboard and
// "/api/artifacts" so both surfaces reuse listArtifactsPage's filters.
// Derived from the canonical SAVED_VIEW_FILTER_KEYS (storage.js) rather than
// hand-copied, so a filter added there can't silently go missing here (or
// in savedViewFiltersFromForm below) the way relatedTo/relation once did.
// `query` is the one key whose query-string param name differs from the
// filter key ("q"); `includeArchived` is handled separately below because
// it needs boolean coercion, not string passthrough.
const LIST_FILTER_QUERY_KEYS = Object.fromEntries(
  SAVED_VIEW_FILTER_KEYS
    .filter((key) => key !== "includeArchived")
    .map((key) => [key, key === "query" ? "q" : key])
);

// Resolves list filters from the query string, expanding `?view=<name|id>`
// into its saved filters first so explicit query params can override them.
async function resolveListFilters(store, url, access) {
  const viewName = url.searchParams.get("view") || "";
  let base = {};
  if (viewName) {
    const view = await resolveSavedView(store, viewName, { access });
    if (view) {
      base = { ...view.filters };
    }
  }

  const explicit = {};
  for (const [filterKey, paramKey] of Object.entries(LIST_FILTER_QUERY_KEYS)) {
    if (url.searchParams.has(paramKey)) {
      explicit[filterKey] = url.searchParams.get(paramKey);
    }
  }
  if (url.searchParams.has("includeArchived")) {
    explicit.includeArchived = url.searchParams.get("includeArchived") === "true";
  }

  const merged = { ...base, ...explicit };
  merged.includeArchived = Boolean(merged.includeArchived);
  merged.view = viewName;
  return merged;
}

// Builds a saved-view filters object from the dashboard "Save current
// filters" form body, dropping blank fields.
function savedViewFiltersFromForm(body) {
  const filters = {};
  for (const key of SAVED_VIEW_FILTER_KEYS) {
    if (key === "includeArchived") {
      continue;
    }
    if (body[key]) {
      filters[key] = body[key];
    }
  }
  if (body.includeArchived === "true") {
    filters.includeArchived = true;
  }
  return filters;
}

// GET /api/events with Accept: text/event-stream. Streams events published
// after connection, plus a Last-Event-ID replay, with a heartbeat comment
// every SSE_HEARTBEAT_MS and a bounded number of concurrent connections
// (ARTIFACTY_SSE_MAX_CLIENTS, default 64).
async function handleEventStream({ request, response, store, filter, access }) {
  if (activeSseClients >= sseMaxClients()) {
    return sendJson(response, { error: "Too many event stream connections", code: "sse_capacity" }, 503);
  }

  const lastEventId = request.headers["last-event-id"];

  activeSseClients += 1;
  let unsubscribe = () => {};
  let heartbeat;
  let closed = false;

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    activeSseClients = Math.max(0, activeSseClients - 1);
    clearInterval(heartbeat);
    unsubscribe();
  };

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.write(": connected\n\n");

  if (lastEventId) {
    const replaySeq = Number(lastEventId) || 0;
    const missed = await listEventsSince(store, replaySeq, filter, 500, access);
    for (const event of missed) {
      writeSseEvent(response, event);
    }
  }

  unsubscribe = subscribe(filter, (event) => {
    if (!eventVisibleTo(event, access)) {
      return;
    }
    writeSseEvent(response, event);
  });

  heartbeat = setInterval(() => {
    response.write(": heartbeat\n\n");
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  request.on("close", cleanup);
  response.on("close", cleanup);
}

function writeSseEvent(response, event) {
  response.write(`id: ${event.seq ?? ""}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(sanitizeEventForDelivery(event))}\n\n`);
}

function omitSecretHash(webhook, { includeSecret = false } = {}) {
  const { secretHash, secret, ...rest } = webhook;
  return includeSecret ? { ...rest, secret } : rest;
}

// Webhook administration follows the same rule as other admin surfaces:
// admin-only once user accounts exist, otherwise the sole token owner
// (single-user mode) may manage webhooks.
function requireWebhookAdminAuth(auth, userCount) {
  if (userCount > 0) {
    requireAdminAuth(auth);
  }
}

// One in-memory fixed-window limiter per store (keyed by store.home), so
// tests using isolated temp stores don't share counters with each other or
// with a long-running production server sharing this process.
const rateLimiterRegistry = new Map();
// Throttle maps for audit-log noise control: at most one audit row per
// (bucket, principal) rate-limit window, and at most one per token/actor per
// minute for scope denials.
const rateLimitedAuditThrottle = new Map();
const scopeDeniedAuditThrottle = new Map();
const SCOPE_DENIED_AUDIT_THROTTLE_MS = 60000;
const RATE_LIMITED_AUDIT_THROTTLE_MS = 60000;

// One-time reveal slot for a freshly created webhook's raw signing secret.
// The POST handler stores it here under a random nonce and redirects with
// only the nonce (never the secret) in the URL; the GET handler consumes
// (deletes) it on first read. This keeps the raw secret out of browser
// history, Referer headers, and reverse-proxy/access logs, and stops the
// admin from being able to re-reveal it by revisiting the URL.
const pendingWebhookSecrets = new Map();
const PENDING_WEBHOOK_SECRET_TTL_MS = 5 * 60 * 1000;

function stashPendingWebhookSecret(webhookId, secret) {
  const nonce = generateToken({ bytes: 32 }).token;
  const now = Date.now();
  // Opportunistically drop expired entries so an admin who creates many
  // webhooks without ever loading the redirect doesn't grow this map
  // without bound.
  for (const [key, entry] of pendingWebhookSecrets) {
    if (now >= entry.expiresAt) {
      pendingWebhookSecrets.delete(key);
    }
  }
  pendingWebhookSecrets.set(nonce, { secret, webhookId, expiresAt: now + PENDING_WEBHOOK_SECRET_TTL_MS });
  return nonce;
}

function consumePendingWebhookSecret(nonce) {
  if (!nonce) {
    return null;
  }
  const entry = pendingWebhookSecrets.get(nonce);
  pendingWebhookSecrets.delete(nonce);
  if (!entry || Date.now() >= entry.expiresAt) {
    return null;
  }
  return entry;
}

function getRateLimiter(store) {
  let limiter = rateLimiterRegistry.get(store.home);
  if (!limiter) {
    limiter = createRateLimiter({ windowMs: 60000, limits: rateLimitFromEnv() });
    rateLimiterRegistry.set(store.home, limiter);
  }
  return limiter;
}

function rateLimitPrincipal(request) {
  const auth = request.artifactyAuth;
  return auth?.tokenId || auth?.user?.id || request.socket?.remoteAddress || "unknown";
}

// Non-throwing rate-limit check, shared by the throwing HTTP helper below
// and the MCP-over-HTTP tool call path (which needs to turn a limit into an
// isError tool result rather than a JSON-RPC/HTTP error).
function checkRateLimit({ store, host, request, bucket }) {
  if (!rateLimitEnabled({ host })) {
    return { allowed: true };
  }
  const principal = rateLimitPrincipal(request);
  return { ...getRateLimiter(store).check(principal, bucket), principal };
}

async function maybeAuditRateLimited(store, request, bucket, principal) {
  const key = `${bucket}:${principal}`;
  const now = Date.now();
  // Prune stale entries on every write so this map cannot grow without
  // bound over the process lifetime, matching scopeDeniedAuditThrottle.
  for (const [existingKey, last] of rateLimitedAuditThrottle) {
    if (now - last >= RATE_LIMITED_AUDIT_THROTTLE_MS) {
      rateLimitedAuditThrottle.delete(existingKey);
    }
  }
  const last = rateLimitedAuditThrottle.get(key) || 0;
  if (now - last < RATE_LIMITED_AUDIT_THROTTLE_MS) {
    return;
  }
  rateLimitedAuditThrottle.set(key, now);
  await insertSecurityAudit(store, {
    action: "rate-limited",
    actor: request.artifactyAuth?.actor || request.headers["x-artifacty-actor"] || "unknown",
    surface: "http-api",
    metadata: { bucket, principal }
  }).catch(() => {});
}

async function enforceRateLimit({ store, host, request, bucket }) {
  const result = checkRateLimit({ store, host, request, bucket });
  if (result.allowed) {
    return;
  }
  await maybeAuditRateLimited(store, request, bucket, result.principal);
  throw Object.assign(new Error(`Rate limit exceeded for ${bucket}`), {
    code: "rate_limited",
    statusCode: 429,
    retryAfter: result.retryAfterSeconds
  });
}

async function maybeAuditScopeDenied(store, request, scope) {
  const auth = request.artifactyAuth;
  // Keyed on the server-derived tokenId only, never `auth?.actor` (sourced
  // from the client-controlled x-artifacty-actor header, see auditContext
  // below) — otherwise a caller could mint a fresh throttle-map key on every
  // request at zero cost, defeating both the throttle and the map's bound.
  const principal = auth?.tokenId || "anonymous";
  const now = Date.now();
  // Prune stale entries on every write so this map cannot grow without
  // bound over the process lifetime.
  for (const [key, last] of scopeDeniedAuditThrottle) {
    if (now - last >= SCOPE_DENIED_AUDIT_THROTTLE_MS) {
      scopeDeniedAuditThrottle.delete(key);
    }
  }
  const last = scopeDeniedAuditThrottle.get(principal) || 0;
  if (now - last < SCOPE_DENIED_AUDIT_THROTTLE_MS) {
    return;
  }
  scopeDeniedAuditThrottle.set(principal, now);
  await insertSecurityAudit(store, {
    action: "token-scope-denied",
    actor: auth?.actor || request.headers["x-artifacty-actor"] || "unknown",
    surface: "http-api",
    metadata: { scope, tokenId: auth?.tokenId || null }
  }).catch(() => {});
}

async function requireApiScope(store, request, scope) {
  try {
    requireScope(request.artifactyAuth, scope);
  } catch (error) {
    if (error.code === "scope_denied") {
      await maybeAuditScopeDenied(store, request, scope);
    }
    throw error;
  }
}

function auditContext(request, surface) {
  const auth = request.artifactyAuth;
  return {
    surface,
    actor: auth?.actor || request.headers["x-artifacty-actor"] || "unknown",
    userId: auth?.user?.id || null,
    publisherName: auth?.user?.name || null,
    tokenId: auth?.tokenId || null
  };
}

// Builds the { userId, role, anonymous } object storage.js visibility checks
// use. A personal session or personal API token carries its own user; the
// global shared token (or the pre-auth "anonymous" fallback when no users
// exist yet) has no user identity and is treated as an anonymous team
// principal per Section 10.
// Field allowlists for the JSON request bodies of POST /api/artifacts,
// POST /api/artifacts/:id, and POST /api/import. createArtifact/
// updateArtifact read a handful of fields (notably `ownerUserId` and
// `auditAction`) from their `input` that must never be settable by an HTTP
// caller: `ownerUserId` would let a write-scoped caller create content
// "owned" by an arbitrary other user, and `auditAction` would let it forge
// an action string that events.js/webhooks would deliver as a fake
// artifact.archived/restored notification. Picking only these known-safe
// fields out of the parsed body (instead of `{ ...body }`) makes both
// impossible regardless of what the request JSON contains.
const CREATE_ARTIFACT_FIELDS = [
  "title",
  "content",
  "format",
  "contentType",
  "artifactType",
  "schemaVersion",
  "sourceAgent",
  "tags",
  "metadata",
  "allowSecrets",
  "visibility",
  "relations"
];

const UPDATE_ARTIFACT_FIELDS = [
  "title",
  "content",
  "format",
  "contentType",
  "artifactType",
  "schemaVersion",
  "sourceAgent",
  "tags",
  "metadata",
  "allowSecrets",
  "relations",
  "skipNoop"
];

function pickFields(body, fields) {
  const picked = {};
  for (const field of fields) {
    if (body && Object.prototype.hasOwnProperty.call(body, field)) {
      picked[field] = body[field];
    }
  }
  return picked;
}

function pickCreateArtifactInput(body) {
  return pickFields(body, CREATE_ARTIFACT_FIELDS);
}

function pickUpdateArtifactInput(body) {
  return pickFields(body, UPDATE_ARTIFACT_FIELDS);
}

async function requireRequestAuth({ store, request, url, body = {}, config }) {
  const token = requestToken({ request, url, body });
  if (config.apiToken && tokensEqual(token, config.apiToken)) {
    return {
      type: "global-token",
      actor: request.headers["x-artifacty-actor"] || "artifacty-token",
      role: "admin"
    };
  }

  const tokenAuth = await authenticateApiToken(store, token);
  if (tokenAuth) {
    return tokenAuth;
  }

  const authRequired = Boolean(config.apiToken) || await countUsers(store) > 0;
  if (!authRequired) {
    return {
      type: "anonymous",
      actor: request.headers["x-artifacty-actor"] || "anonymous"
    };
  }

  throw Object.assign(new Error("Artifacty authentication required"), {
    code: "AUTH_REQUIRED",
    statusCode: 401
  });
}

async function requireBrowserWriteAuth({ store, request, url, body, config, currentUser }) {
  if (currentUser) {
    return {
      type: "session",
      actor: currentUser.email,
      user: currentUser,
      role: currentUser.role
    };
  }
  return requireRequestAuth({ store, request, url, body, config });
}

function requireAdmin(user) {
  if (user?.role !== "admin") {
    throw Object.assign(new Error("Artifacty admin privileges required"), {
      code: "ADMIN_REQUIRED",
      statusCode: 403
    });
  }
}

function requireAdminAuth(auth) {
  if (auth?.role !== "admin" && auth?.user?.role !== "admin") {
    throw Object.assign(new Error("Artifacty admin privileges required"), {
      code: "ADMIN_REQUIRED",
      statusCode: 403
    });
  }
}

async function sessionUserFromRequest(store, request) {
  return getSessionUser(store, sessionTokenFromRequest(request));
}

function sessionTokenFromRequest(request) {
  const cookies = parseCookies(request.headers.cookie || "");
  return cookies.artifacty_session || "";
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      cookies[key] = decodeURIComponent(value);
    }
  }
  return cookies;
}

function sessionCookie(token) {
  return `artifacty_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`;
}

function clearSessionCookie() {
  return "artifacty_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

function isMain(metaUrl) {
  return process.argv[1] && metaUrl === new URL(`file://${process.argv[1]}`).href;
}

if (isMain(import.meta.url)) {
  runServerMain(parseServerArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

async function runServerMain(options) {
  if (options.generateToken && options.apiToken) {
    throw new Error("Use either --api-token or --generate-token, not both");
  }
  const generatedToken = options.generateToken ? generateToken(options) : null;
  const { url, store, securityWarning } = await startServer({
    ...options,
    apiToken: generatedToken?.token || options.apiToken
  });
  process.stderr.write(`Artifacty listening on ${url}\n`);
  process.stderr.write(`Store: ${store.home}\n`);
  if (securityWarning) {
    process.stderr.write(`${securityWarning}\n`);
  }
  if (generatedToken) {
    process.stderr.write(`API token: ${generatedToken.token}\n`);
    process.stderr.write(`HTTP header: ${generatedToken.header}\n`);
    process.stderr.write(`Create URL: ${url}/new?token=${encodeURIComponent(generatedToken.token)}\n`);
    process.stderr.write(`Import URL: ${url}/import?token=${encodeURIComponent(generatedToken.token)}\n`);
  }
}

function parseServerArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host") {
      options.host = args[++index];
    } else if (arg === "--port") {
      options.port = Number(args[++index]);
    } else if (arg === "--home") {
      options.home = args[++index];
    } else if (arg === "--api-token") {
      options.apiToken = args[++index];
    } else if (arg === "--share-mode") {
      options.shareMode = args[++index];
    } else if (arg === "--bytes") {
      options.bytes = Number(args[++index]);
    } else if (arg === "--generate-token") {
      options.generateToken = true;
    } else if (arg === "--allow-secrets") {
      options.allowSecrets = true;
    } else if (arg === "--mcp-http") {
      options.mcpHttp = true;
    }
  }
  return options;
}
