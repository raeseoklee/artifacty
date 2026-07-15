#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import {
  archiveArtifact,
  authenticateApiToken,
  changeUserPassword,
  countUsers,
  createApiToken,
  createArtifact,
  createSession,
  createStore,
  createUser,
  deleteArtifactVersion,
  getArtifact,
  getSessionUser,
  importUsersFromCsv,
  listApiTokens,
  listArtifactsPage,
  listAuditEvents,
  listUsers,
  MAX_ARTIFACT_BYTES,
  revokeApiToken,
  revokeSession,
  restoreArtifact,
  replaceArtifactVersion,
  setUserActive,
  updateArtifact,
  verifyUserPassword
} from "./lib/storage.js";
import { convertAgentArtifact } from "./lib/converters.js";
import { createLineDiff } from "./lib/diff.js";
import { EDITOR_CLIENT_PATH, VIEWER_CLIENT_PATH, editorClientFilePath, editorVendorPath, viewerClientFilePath } from "./lib/editor-assets.js";
import { localeFromBodyOrUrl, localeFromUrl, localizedHref } from "./lib/i18n.js";
import { exposureWarning, requestToken, securityConfig, tokensEqual, validateServerExposure } from "./lib/security.js";
import { writeServerState } from "./lib/server-state.js";
import { generateToken } from "./lib/token.js";
import { createMcpJsonRpcHandler } from "./mcp-server.js";
import {
  renderArtifactFormPage,
  renderArtifactPage,
  renderAccountPage,
  renderAdminArtifactVersionsPage,
  renderAdminUsersPage,
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
  return {
    server,
    store,
    url,
    requestedPort,
    port: actualPort,
    portFallback: usedPortFallback,
    securityWarning: exposureWarning({ host, config: security }),
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
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
    return sendHtml(response, renderAccountPage({
      baseUrl,
      user: currentUser,
      tokens,
      locale,
      currentPath
    }), 200, headOnly);
  }

  if (method === "POST" && pathname === "/account/tokens") {
    if (!currentUser) {
      return sendRedirect(response, "/login");
    }
    const body = await readFormBody(request);
    const created = await createApiToken(store, currentUser.id, {
      name: body.name
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
      method
    });
  }

  if (pathname.startsWith("/api/")) {
    request.artifactyAuth = await requireRequestAuth({ store, request, url, config: security });
  }

  if (method === "GET" && pathname === "/health") {
    return sendJson(response, { ok: true, name: "artifacty", store: store.home }, 200, headOnly);
  }

  if (method === "GET" && pathname === "/") {
    const filters = {
      query: url.searchParams.get("q") || "",
      tag: url.searchParams.get("tag") || "",
      sourceAgent: url.searchParams.get("sourceAgent") || "",
      includeArchived: url.searchParams.get("includeArchived") === "true",
      limit: url.searchParams.get("limit") || undefined,
      offset: url.searchParams.get("offset") || undefined
    };
    const page = await listArtifactsPage(store, {
      query: filters.query || undefined,
      tag: filters.tag || undefined,
      sourceAgent: filters.sourceAgent || undefined,
      includeArchived: filters.includeArchived,
      limit: filters.limit,
      offset: filters.offset
    });
    return sendHtml(response, renderDashboard({ artifacts: page.artifacts, baseUrl, filters, pagination: page, locale, currentPath, user: currentUser }), 200, headOnly);
  }

  if (method === "GET" && pathname === "/new") {
    return sendHtml(response, renderNewArtifactPage({ baseUrl, authToken, locale, currentPath }), 200, headOnly);
  }

  if (method === "POST" && pathname === "/new") {
    assertLocalOrigin(request);
    const body = await readFormBody(request);
    const bodyLocale = localeFromBodyOrUrl(body, url);
    request.artifactyAuth = await requireBrowserWriteAuth({ store, request, url, body, config: security, currentUser });
    const artifact = await createArtifact(store, {
      title: body.title,
      content: body.content,
      format: body.format,
      artifactType: body.artifactType,
      sourceAgent: body.sourceAgent || "artifacty",
      tags: splitTags(body.tags),
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
      auditAction: "import",
      audit: auditContext(request, "web")
    });
    return sendRedirect(response, localizedHref(`/artifacts/${encodeURIComponent(artifact.id)}`, bodyLocale));
  }

  if (method === "GET" && pathname === "/api/artifacts") {
    const page = await listArtifactsPage(store, {
      query: url.searchParams.get("q") || undefined,
      tag: url.searchParams.get("tag") || undefined,
      sourceAgent: url.searchParams.get("sourceAgent") || undefined,
      includeArchived: url.searchParams.get("includeArchived") === "true",
      limit: url.searchParams.get("limit") || undefined,
      offset: url.searchParams.get("offset") || undefined
    });
    return sendJson(response, {
      artifacts: page.artifacts,
      pagination: paginationJson(page),
      search: page.search
    }, 200, headOnly);
  }

  if (method === "GET" && pathname === "/api/audit") {
    const events = await listAuditEvents(store, {
      artifactId: url.searchParams.get("artifactId") || undefined,
      limit: url.searchParams.get("limit") || undefined
    });
    return sendJson(response, { events }, 200, headOnly);
  }

  if (method === "POST" && pathname === "/api/artifacts") {
    assertLocalOrigin(request);
    const body = await readJsonBody(request);
    const artifact = await createArtifact(store, {
      ...body,
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, decorateArtifactUrls(artifact, baseUrl), 201);
  }

  if (method === "POST" && pathname === "/api/import") {
    assertLocalOrigin(request);
    const body = await readJsonBody(request);
    const converted = convertAgentArtifact(body);
    const artifact = await createArtifact(store, {
      ...converted,
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
      version: url.searchParams.get("version") || undefined
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
      audit: auditContext(request, "web")
    });
    return sendRedirect(response, localizedHref(`/artifacts/${encodeURIComponent(artifact.id)}`, bodyLocale));
  }

  const diffMatch = /^\/artifacts\/([^/]+)\/diff$/.exec(pathname);
  if (diffMatch && method === "GET") {
    const latest = await getArtifact(store, diffMatch[1]);
    const defaultFrom = Math.max(1, latest.latestVersion - 1);
    const fromNumber = Number(url.searchParams.get("from") || defaultFrom);
    const toNumber = Number(url.searchParams.get("to") || latest.latestVersion);
    const from = await getArtifact(store, diffMatch[1], { version: fromNumber });
    const to = await getArtifact(store, diffMatch[1], { version: toNumber });
    return sendHtml(response, renderDiffPage({
      artifact: latest,
      fromVersion: from.version,
      toVersion: to.version,
      fromContent: from.content,
      toContent: to.content,
      diffRows: createLineDiff(from.content, to.content),
      baseUrl,
      authToken,
      locale,
      currentPath
    }), 200, headOnly);
  }

  const archiveMatch = /^\/artifacts\/([^/]+)\/(archive|restore)$/.exec(pathname);
  if (archiveMatch && method === "POST") {
    assertLocalOrigin(request);
    const body = await readFormBody(request);
    const bodyLocale = localeFromBodyOrUrl(body, url);
    request.artifactyAuth = await requireBrowserWriteAuth({ store, request, url, body, config: security, currentUser });
    const artifact = archiveMatch[2] === "archive"
      ? await archiveArtifact(store, archiveMatch[1], { audit: auditContext(request, "web") })
      : await restoreArtifact(store, archiveMatch[1], { audit: auditContext(request, "web") });
    return sendRedirect(response, localizedHref(`/artifacts/${encodeURIComponent(artifact.id)}`, bodyLocale));
  }

  const apiMatch = /^\/api\/artifacts\/([^/]+)$/.exec(pathname);
  if (apiMatch && method === "GET") {
    const artifact = await getArtifact(store, apiMatch[1], {
      version: url.searchParams.get("version") || undefined
    });
    return sendJson(response, decorateArtifactUrls(artifact, baseUrl), 200, headOnly);
  }

  if (apiMatch && method === "POST") {
    assertLocalOrigin(request);
    const body = await readJsonBody(request);
    const artifact = await updateArtifact(store, apiMatch[1], {
      ...body,
      audit: auditContext(request, "http-api")
    });
    return sendJson(response, decorateArtifactUrls(artifact, baseUrl));
  }

  const apiArchiveMatch = /^\/api\/artifacts\/([^/]+)\/(archive|restore)$/.exec(pathname);
  if (apiArchiveMatch && method === "POST") {
    assertLocalOrigin(request);
    const artifact = apiArchiveMatch[2] === "archive"
      ? await archiveArtifact(store, apiArchiveMatch[1], { audit: auditContext(request, "http-api") })
      : await restoreArtifact(store, apiArchiveMatch[1], { audit: auditContext(request, "http-api") });
    return sendJson(response, decorateArtifactUrls(artifact, baseUrl));
  }

  const reactFrameMatch = /^\/artifacts\/([^/]+)\/react-frame$/.exec(pathname);
  if (reactFrameMatch && method === "GET") {
    if (process.env.ARTIFACTY_ENABLE_REACT_RENDERER !== "true") {
      return sendJson(response, { error: "React renderer is disabled" }, 403, headOnly);
    }
    const artifact = await getArtifact(store, reactFrameMatch[1], {
      version: url.searchParams.get("version") || undefined,
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

  const artifactMatch = /^\/artifacts\/([^/]+)(?:\/raw)?$/.exec(pathname);
  if (artifactMatch && method === "GET") {
    const artifact = await getArtifact(store, artifactMatch[1], {
      version: url.searchParams.get("version") || undefined,
      audit: auditContext(request, "browser")
    });

    if (pathname.endsWith("/raw")) {
      const raw = rawArtifactResponse(artifact);
      response.writeHead(200, {
        "content-type": raw.contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      });
      response.end(headOnly ? undefined : raw.body);
      return;
    }

    return sendHtml(response, renderArtifactPage({
      artifact,
      version: artifact.version,
      content: artifact.content,
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

async function handleMcpHttpRequest({ request, response, store, baseUrl, headOnly, method }) {
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
    auditContext: () => auditContext(request, "mcp-http")
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

export async function readJsonBody(request) {
  const raw = await readBody(request, MAX_ARTIFACT_BYTES + 1024);
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

export async function readFormBody(request) {
  const raw = await readBody(request, MAX_ARTIFACT_BYTES + 1024);
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

export function sendJson(response, data, statusCode = 200, headOnly = false) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(headOnly ? undefined : `${JSON.stringify(data, null, 2)}\n`);
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

function mediaContentType(artifact) {
  const metadataType = String(artifact.version.metadata?.mimeType || "").toLowerCase();
  if (metadataType.startsWith("image/") || metadataType.startsWith("video/")) {
    return metadataType;
  }
  const versionType = String(artifact.version.contentType || "").toLowerCase().split(";")[0];
  if (versionType.startsWith("image/") || versionType.startsWith("video/")) {
    return versionType;
  }
  return artifact.version.format === "video" ? "video/mp4" : "image/png";
}

function decodeMediaContent(content) {
  const value = String(content || "").trim();
  const dataUrl = /^data:[^;,]+;base64,([A-Za-z0-9+/=_-\s]+)$/i.exec(value);
  const base64 = (dataUrl ? dataUrl[1] : value).replace(/\s+/g, "").replaceAll("-", "+").replaceAll("_", "/");
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return null;
  }
  return Buffer.from(base64, "base64");
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
  sendJson(response, body, statusCode);
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
