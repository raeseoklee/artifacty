import { EDITOR_CLIENT_PATH, VIEWER_CLIENT_PATH, editorImportMapJson } from "./editor-assets.js";
import { createI18n, DEFAULT_LOCALE, editorMessages, localizedHref, switchLocaleHref } from "./i18n.js";
import { ARTIFACT_FORMATS, ARTIFACT_TYPES, REVIEW_STATUSES, SAVED_VIEW_FILTER_KEYS, VISIBILITY_VALUES } from "./storage.js";
import { normalizeMaxEntries as resolveMaxDiffEntries } from "./diff.js";
import { parseCsv } from "./csv.js";
import {
  isSarifDocument,
  rulesMapsForRun,
  sarifResultLevel,
  sarifResultRuleId
} from "./sarif-csv-export.js";
import { isNotebookObject } from "./converters.js";
import { GROUP_BY_VALUES, groupKeyFor } from "./listing.js";

export function renderDashboard({ artifacts, baseUrl, filters = {}, pagination, locale = DEFAULT_LOCALE, currentPath = "/", user = null, savedViews = [], embeddingsAvailable = false }) {
  const view = viewContext(locale, currentPath);
  const total = pagination?.total ?? artifacts.length;
  const start = artifacts.length ? (pagination?.offset ?? 0) + 1 : 0;
  const end = artifacts.length ? (pagination?.offset ?? 0) + artifacts.length : 0;
  const searchBackend = pagination?.search?.backend;
  const pager = renderDashboardPager({ pagination, filters, view });
  const rowsHtml = renderArtifactRows(artifacts, filters.groupBy, view);
  const sidebar = renderSavedViewsSidebar({ savedViews, filters, view });

  return pageShell({
    title: "Artifacty",
    body: `
      <header class="topbar">
        <a class="brand" href="${view.href("/")}">
          ${brandMark()}
          <span class="brand-text">
            <span class="brand-name">artifacty</span>
            <span class="brand-tag">local artifact exchange · ${escapeHtml(baseUrl)}</span>
          </span>
        </a>
        <nav>
          <a href="${view.href("/new")}">${view.text("nav.new")}</a>
          <a href="${view.href("/import")}">${view.text("nav.import")}</a>
          <a href="/api/artifacts">${view.text("nav.api")}</a>
          ${authNav(user)}
          ${languageSwitcher(view)}
        </nav>
      </header>
      <div class="dashboard-layout">
        ${sidebar}
        <main class="dashboard">
          <section class="toolbar">
            <span>${view.text("dashboard.range", { start, end, total })}</span>
            ${searchBackend ? `<span>${view.text("dashboard.searchBackend", { backend: searchBackend })}</span>` : ""}
          </section>
          <form class="filter-form" method="get" action="/">
            ${localeInput(view.locale)}
            ${filters.limit ? `<input type="hidden" name="limit" value="${escapeAttribute(filters.limit)}">` : ""}
            <input name="q" value="${escapeAttribute(filters.query || "")}" placeholder="${view.attr("filter.search")}">
            <input name="tag" value="${escapeAttribute(filters.tag || "")}" placeholder="${view.attr("filter.tag")}">
            <input name="sourceAgent" value="${escapeAttribute(filters.sourceAgent || "")}" placeholder="${view.attr("filter.source")}">
            ${filterArtifactTypeSelect(filters.artifactType, view)}
            <input name="publisher" value="${escapeAttribute(filters.publisher || "")}" placeholder="${view.attr("filter.publisher")}">
            <input type="date" name="createdAfter" value="${escapeAttribute(filters.createdAfter || "")}" title="${view.attr("filter.createdAfter")}">
            <input type="date" name="createdBefore" value="${escapeAttribute(filters.createdBefore || "")}" title="${view.attr("filter.createdBefore")}">
            ${filterReviewStatusSelect(filters.reviewStatus, view)}
            ${embeddingsAvailable ? filterModeSelect(filters.mode, view) : ""}
            ${filterGroupBySelect(filters.groupBy, view)}
            <label class="checkbox-field"><input type="checkbox" name="includeArchived" value="true"${filters.includeArchived ? " checked" : ""}> ${view.text("filter.archived")}</label>
            <button type="submit">${view.text("filter.submit")}</button>
            <a href="${view.href("/")}">${view.text("filter.clear")}</a>
          </form>
          <section class="artifact-list">
            ${rowsHtml || `<div class="empty">${view.text("dashboard.empty")}</div>`}
          </section>
          ${pager}
        </main>
      </div>
    `,
    locale: view.locale
  });
}

function renderArtifactRow(artifact, view) {
  const tags = artifact.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const status = artifact.archivedAt ? statusBadge("archived") : "";
  const visibility = visibilityBadge(artifact, view);
  const publisher = publisherDisplay(artifact, view);
  const snippet = artifact.searchSnippet
    ? `<span class="row-snippet">${escapeHtml(artifact.searchSnippet)}</span>`
    : "";
  return `
    <a class="artifact-row" href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}`)}">
      <span class="row-main">
        <strong>${escapeHtml(artifact.title)}</strong>
        <span>${escapeHtml(artifact.id)}</span>
        ${snippet}
      </span>
      <span>${escapeHtml(artifact.sourceAgent)}</span>
      <span class="publisher-cell" title="${escapeAttribute(publisherTitle(artifact, view))}">${escapeHtml(publisher)}</span>
      ${typeBadge(artifact.artifactType || "document")}
      ${formatBadge(artifact.format || "text")}
      <span>v${artifact.latestVersion}</span>
      <span class="tags">${status}${visibility}${tags}</span>
    </a>
  `;
}

// groupBy is purely presentational: it groups the already-fetched, already-
// sorted page of artifacts into labeled sections without changing the query.
function renderArtifactRows(artifacts, groupBy, view) {
  if (!GROUP_BY_VALUES.includes(groupBy)) {
    return artifacts.map((artifact) => renderArtifactRow(artifact, view)).join("");
  }

  const groups = new Map();
  for (const artifact of artifacts) {
    const key = groupKeyFor(artifact, groupBy);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(artifact);
  }

  return Array.from(groups.entries())
    .map(([key, group]) => `
      <section class="artifact-group">
        <h2 class="artifact-group-heading">${escapeHtml(groupHeadingLabel(key, groupBy, view))}</h2>
        ${group.map((artifact) => renderArtifactRow(artifact, view)).join("")}
      </section>
    `)
    .join("");
}

function groupHeadingLabel(key, groupBy, view) {
  if (groupBy === "day" && !key) {
    return view.raw("dashboard.groupUnknown");
  }
  return key || view.raw("dashboard.groupUnknown");
}

// Shared by every <select> whose options are just ARTIFACT_TYPES rendered
// as their own value and (escaped) label.
function artifactTypeOptions(selected) {
  return ARTIFACT_TYPES.map((type) => `<option value="${type}"${type === selected ? " selected" : ""}>${escapeHtml(type)}</option>`).join("");
}

function filterArtifactTypeSelect(selected, view) {
  return `<select name="artifactType">
    <option value="">${view.text("filter.artifactTypeAny")}</option>
    ${artifactTypeOptions(selected)}
  </select>`;
}

function filterReviewStatusSelect(selected, view) {
  return `<select name="reviewStatus">
    <option value="">${view.text("filter.reviewStatusAny")}</option>
    ${REVIEW_STATUSES.map((status) => `<option value="${status}"${status === selected ? " selected" : ""}>${view.text(`reviewStatus.${status}`)}</option>`).join("")}
  </select>`;
}

const SEARCH_MODE_VALUES = ["keyword", "semantic", "hybrid"];

// Only rendered when the caller confirms an embedding provider is
// configured (roadmap section 6): semantic/hybrid search silently falls
// back to keyword without one, so the toggle would otherwise mislead.
function filterModeSelect(selected, view) {
  return `<select name="mode">
    <option value="">${view.text("filter.modeDefault")}</option>
    ${SEARCH_MODE_VALUES.map((value) => `<option value="${value}"${value === selected ? " selected" : ""}>${view.text(`filter.mode.${value}`)}</option>`).join("")}
  </select>`;
}

function filterGroupBySelect(selected, view) {
  return `<select name="groupBy">
    <option value="">${view.text("filter.groupByNone")}</option>
    ${GROUP_BY_VALUES.map((value) => `<option value="${value}"${value === selected ? " selected" : ""}>${view.text(`filter.groupBy.${value}`)}</option>`).join("")}
  </select>`;
}

function renderSavedViewsSidebar({ savedViews, filters, view }) {
  const items = savedViews.length
    ? savedViews.map((savedView) => `
        <li class="saved-view-item">
          <a href="${view.href(`/?view=${encodeURIComponent(savedView.id)}`)}">${escapeHtml(savedView.name)}</a>
          ${savedView.shared ? `<span class="badge saved-view-shared">${view.text("views.shared")}</span>` : ""}
          <form method="post" action="${view.href(`/views/${encodeURIComponent(savedView.id)}/delete`)}" class="saved-view-delete">
            ${localeInput(view.locale)}
            <button type="submit">${view.text("views.delete")}</button>
          </form>
        </li>
      `).join("")
    : `<li class="empty">${view.text("views.empty")}</li>`;

  return `
    <aside class="dashboard-sidebar">
      <h2>${view.text("views.title")}</h2>
      <ul class="saved-view-list">${items}</ul>
      <form method="post" action="${view.href("/views")}" class="saved-view-form">
        ${localeInput(view.locale)}
        ${savedViewFilterHiddenInputs(filters)}
        <input name="name" placeholder="${view.attr("views.namePlaceholder")}" required>
        <label class="checkbox-field"><input type="checkbox" name="shared" value="true"> ${view.text("views.shared")}</label>
        <button type="submit">${view.text("views.save")}</button>
      </form>
    </aside>
  `;
}

// Every SAVED_VIEW_FILTER_KEYS entry as a hidden form field, so a filter
// added there (e.g. relatedTo/relation) is captured by "save current
// filters" automatically instead of needing a hand-added <input> here too.
function savedViewFilterHiddenInputs(filters) {
  return SAVED_VIEW_FILTER_KEYS.map((key) => {
    if (key === "includeArchived") {
      return `<input type="hidden" name="includeArchived" value="${filters.includeArchived ? "true" : ""}">`;
    }
    return `<input type="hidden" name="${key}" value="${escapeAttribute(filters[key] || "")}">`;
  }).join("\n        ");
}

function renderDashboardPager({ pagination, filters, view }) {
  if (!pagination || pagination.total <= pagination.limit) {
    return "";
  }

  const previous = pagination.previousOffset === null
    ? `<span class="pager-disabled">${view.text("dashboard.previous")}</span>`
    : `<a href="${view.href(dashboardPageHref(filters, pagination.previousOffset))}">${view.text("dashboard.previous")}</a>`;
  const next = pagination.nextOffset === null
    ? `<span class="pager-disabled">${view.text("dashboard.next")}</span>`
    : `<a href="${view.href(dashboardPageHref(filters, pagination.nextOffset))}">${view.text("dashboard.next")}</a>`;

  return `<nav class="pager" aria-label="Pagination">${previous}${next}</nav>`;
}

function dashboardPageHref(filters, offset) {
  const params = new URLSearchParams();
  // Every SAVED_VIEW_FILTER_KEYS entry (except includeArchived, handled
  // below) round-trips through the dashboard's pager links the same way it
  // round-trips through the saved-view form above, so relatedTo/relation
  // (or any future filter key) can't silently drop out of pagination.
  for (const key of SAVED_VIEW_FILTER_KEYS) {
    if (key === "includeArchived" || !filters[key]) {
      continue;
    }
    params.set(key === "query" ? "q" : key, filters[key]);
  }
  if (filters.groupBy) {
    params.set("groupBy", filters.groupBy);
  }
  if (filters.view) {
    params.set("view", filters.view);
  }
  if (filters.includeArchived) {
    params.set("includeArchived", "true");
  }
  if (filters.limit) {
    params.set("limit", filters.limit);
  }
  if (offset > 0) {
    params.set("offset", String(offset));
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export function renderArtifactFormPage({ mode, baseUrl, artifact, version, content, authToken = "", locale = DEFAULT_LOCALE, currentPath = "/", expectedVersion, conflict = null }) {
  const view = viewContext(locale, currentPath);
  const isEdit = mode === "edit";
  const title = isEdit ? view.raw("form.editTitle", { title: artifact.title }) : view.raw("form.newTitle");
  const action = isEdit ? `/artifacts/${encodeURIComponent(artifact.id)}/edit` : "/new";
  const format = version?.format || "markdown";
  const sourceAgent = artifact?.sourceAgent || "artifacty";
  const artifactType = artifact?.artifactType || "document";
  const tags = artifact?.tags?.join(", ") || "";
  const body = content ?? "# New artifact";
  const editVersion = expectedVersion ?? version?.version ?? artifact?.latestVersion;
  const conflictBanner = conflict
    ? `<div class="conflict-banner" role="alert">
        <p>${view.text("form.conflict", { latestVersion: conflict.latestVersion })}</p>
        <a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}/diff?from=${encodeURIComponent(editVersion)}&to=${encodeURIComponent(conflict.latestVersion)}`)}">${view.text("form.conflictDiff")}</a>
      </div>`
    : "";

  return pageShell({
    title,
    body: `
      <header class="topbar">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href(isEdit ? `/artifacts/${encodeURIComponent(artifact.id)}` : "/")}">${view.text("nav.cancel")}</a>
          ${languageSwitcher(view)}
        </nav>
      </header>
      <main class="artifact-editor">
        ${conflictBanner}
        <form class="editor-form" method="post" action="${action}">
          ${hiddenToken(authToken)}
          ${localeInput(view.locale)}
          ${isEdit && (conflict?.latestVersion ?? editVersion) != null ? `<input type="hidden" name="expectedVersion" value="${escapeAttribute(String(conflict?.latestVersion ?? editVersion))}">` : ""}
          <section class="editor-fields">
            <label class="field">
              <span>${view.text("form.title")}</span>
              <input name="title" value="${escapeAttribute(artifact?.title || "")}" autocomplete="off" required>
            </label>
            <label class="field">
              <span>${view.text("form.format")}</span>
              ${formatSelect(format)}
            </label>
            <label class="field">
              <span>${view.text("form.source")}</span>
              <input name="sourceAgent" value="${escapeAttribute(sourceAgent)}" autocomplete="off">
            </label>
            <label class="field">
              <span>${view.text("form.type")}</span>
              ${artifactTypeSelect(artifactType)}
            </label>
            <label class="field">
              <span>${view.text("form.tags")}</span>
              <input name="tags" value="${escapeAttribute(tags)}" autocomplete="off">
            </label>
            ${isEdit ? "" : `<label class="field">
              <span>${view.text("artifact.visibility.label")}</span>
              ${visibilitySelect(artifact?.visibility || "team", view)}
            </label>`}
          </section>
          <section class="field content-field">
            <label for="artifact-content">${view.text("form.content")}</label>
            <textarea id="artifact-content" name="content" data-artifacty-editor data-editor-format="${escapeAttribute(format)}" spellcheck="false" required>${escapeHtml(body)}</textarea>
          </section>
          <footer class="editor-actions">
            <a href="${view.href(isEdit ? `/artifacts/${encodeURIComponent(artifact.id)}` : "/")}">${view.text("nav.cancel")}</a>
            <button type="submit">${isEdit ? view.text("form.saveVersion") : view.text("form.create")}</button>
          </footer>
        </form>
      </main>
    `,
    head: editorHead(),
    afterBody: editorScript(view.locale),
    locale: view.locale
  });
}

export function renderNewArtifactPage({ baseUrl, authToken = "", locale = DEFAULT_LOCALE, currentPath = "/new" }) {
  return renderArtifactFormPage({ mode: "new", baseUrl, authToken, locale, currentPath });
}

export function renderAdminArtifactVersionsPage({ artifact, selectedVersion, content, baseUrl, user, error = "", locale = DEFAULT_LOCALE, currentPath = "/" }) {
  const view = viewContext(locale, currentPath);
  const artifactPath = `/artifacts/${encodeURIComponent(artifact.id)}`;
  const versionRows = artifact.versions.map((version) => {
    const active = version.version === selectedVersion.version ? " active" : "";
    const deleteDisabled = artifact.versions.length <= 1 ? " disabled" : "";
    return `
      <tr>
        <td><a class="version${active}" href="${view.href(`/admin/artifacts/${encodeURIComponent(artifact.id)}/versions?version=${version.version}`)}">v${version.version}</a></td>
        <td>${formatBadge(version.format)}</td>
        <td>${escapeHtml(version.createdAt)}</td>
        <td><code>${escapeHtml(version.sha256.slice(0, 12))}</code></td>
        <td>${escapeHtml(String(version.sizeBytes))}</td>
        <td>
          <form class="inline-action" method="post" action="/admin/artifacts/${encodeURIComponent(artifact.id)}/versions/${version.version}/delete">
            ${localeInput(view.locale)}
            <input name="reason" placeholder="Reason">
            <button type="submit"${deleteDisabled}>Delete</button>
          </form>
        </td>
      </tr>
    `;
  }).join("");

  return pageShell({
    title: `Manage versions · ${artifact.title}`,
    body: `
      <header class="topbar">
        <div>
          <h1>Manage versions</h1>
          <p>${escapeHtml(artifact.title)} · ${escapeHtml(artifact.id)} · ${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href(artifactPath)}">Artifact</a>
          <a href="${view.href(`${artifactPath}/diff`)}">${view.text("nav.diff")}</a>
          ${authNav(user)}
          ${languageSwitcher(view)}
        </nav>
      </header>
      <main class="artifact-editor">
        ${error ? `<p class="auth-error">${escapeHtml(error)}</p>` : ""}
        <section class="meta-card">
          <h2>Versions</h2>
          <table class="data-table">
            <thead><tr><th>Version</th><th>Format</th><th>Created</th><th>SHA</th><th>Bytes</th><th>Action</th></tr></thead>
            <tbody>${versionRows}</tbody>
          </table>
        </section>
        <form class="editor-form" method="post" action="/admin/artifacts/${encodeURIComponent(artifact.id)}/versions/${selectedVersion.version}/repair">
          ${localeInput(view.locale)}
          <section class="editor-fields">
            <label class="field">
              <span>${view.text("form.format")}</span>
              ${formatSelect(selectedVersion.format)}
            </label>
            <label class="field">
              <span>Reason</span>
              <input name="reason" value="" autocomplete="off">
            </label>
          </section>
          <section class="field content-field">
            <label for="artifact-content">v${selectedVersion.version} content</label>
            <textarea id="artifact-content" name="content" data-artifacty-editor data-editor-format="${escapeAttribute(selectedVersion.format)}" spellcheck="false" required>${escapeHtml(content)}</textarea>
          </section>
          <footer class="editor-actions">
            <a href="${view.href(`${artifactPath}?version=${selectedVersion.version}`)}">View version</a>
            <button type="submit">Repair version</button>
          </footer>
        </form>
      </main>
    `,
    head: editorHead(),
    afterBody: editorScript(view.locale),
    locale: view.locale
  });
}

export function renderImportArtifactPage({ baseUrl, authToken = "", locale = DEFAULT_LOCALE, currentPath = "/import" }) {
  const view = viewContext(locale, currentPath);
  const title = view.raw("form.importTitle");
  return pageShell({
    title,
    body: `
      <header class="topbar">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href("/")}">${view.text("nav.index")}</a>
          ${languageSwitcher(view)}
        </nav>
      </header>
      <main class="artifact-editor">
        <form class="editor-form" method="post" action="/import">
          ${hiddenToken(authToken)}
          ${localeInput(view.locale)}
          <section class="editor-fields">
            <label class="field">
              <span>${view.text("form.agent")}</span>
              <select name="agent">
                <option value="auto">${view.text("form.auto")}</option>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="gemini">Gemini</option>
                <option value="copilot">GitHub Copilot</option>
                <option value="cursor">Cursor</option>
                <option value="generic">Generic</option>
              </select>
            </label>
            <label class="field">
              <span>${view.text("form.title")}</span>
              <input name="title" autocomplete="off">
            </label>
            <label class="field">
              <span>${view.text("form.fileName")}</span>
              <input name="fileName" autocomplete="off">
            </label>
            <label class="field">
              <span>${view.text("form.tags")}</span>
              <input name="tags" autocomplete="off">
            </label>
          </section>
          <section class="field content-field">
            <label for="import-content">${view.text("form.importContent")}</label>
            <textarea id="import-content" name="content" data-artifacty-editor data-editor-format="auto" spellcheck="false" required></textarea>
          </section>
          <footer class="editor-actions">
            <a href="${view.href("/")}">${view.text("nav.cancel")}</a>
            <button type="submit">${view.text("form.importSubmit")}</button>
          </footer>
        </form>
      </main>
    `,
    head: editorHead(),
    afterBody: editorScript(view.locale),
    locale: view.locale
  });
}

export function renderLoginPage({ baseUrl, setup = false, error = "", locale = DEFAULT_LOCALE, currentPath = "/login" }) {
  const view = viewContext(locale, currentPath);
  const title = setup ? "Create admin account" : "Sign in";
  return pageShell({
    title,
    body: `
      <header class="topbar">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href("/")}">${view.text("nav.index")}</a>
          ${languageSwitcher(view)}
        </nav>
      </header>
      <main class="artifact-editor auth-panel">
        ${error ? `<p class="auth-error">${escapeHtml(error)}</p>` : ""}
        ${setup ? `<p class="muted">No users exist yet. The first account becomes an administrator.</p>` : ""}
        <form class="editor-form auth-form" method="post" action="/login">
          <section class="editor-fields">
            <label class="field">
              <span>Email</span>
              <input type="email" name="email" autocomplete="username" required>
            </label>
            ${setup ? `<label class="field">
              <span>Name</span>
              <input name="name" autocomplete="name">
            </label>` : ""}
            <label class="field">
              <span>Password</span>
              <input type="password" name="password" autocomplete="${setup ? "new-password" : "current-password"}" minlength="8" required>
            </label>
          </section>
          <footer class="editor-actions">
            <button type="submit">${setup ? "Create admin" : "Sign in"}</button>
          </footer>
        </form>
      </main>
    `,
    locale: view.locale
  });
}

export function renderAccountPage({ baseUrl, user, tokens = [], createdToken = "", privateArtifacts = [], locale = DEFAULT_LOCALE, currentPath = "/account" }) {
  const view = viewContext(locale, currentPath);
  const privateArtifactRows = privateArtifacts.map((artifact) => `
    <tr>
      <td><a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}`)}">${escapeHtml(artifact.title)}</a></td>
      <td>${escapeHtml(artifact.id)}</td>
      <td>${escapeHtml(artifact.updatedAt)}</td>
      <td>${artifact.archivedAt ? statusBadge(view.text("artifact.archived", { date: artifact.archivedAt })) : ""}</td>
    </tr>
  `).join("");
  const rows = tokens.map((token) => `
    <tr>
      <td>${escapeHtml(token.name)}</td>
      <td>${escapeHtml((token.scopes || ["read", "write"]).join(", "))}</td>
      <td>${escapeHtml(token.createdAt)}</td>
      <td>${token.lastUsedAt ? escapeHtml(token.lastUsedAt) : "Never"}</td>
      <td>${token.revokedAt ? escapeHtml(token.revokedAt) : "Active"}</td>
      <td>
        ${token.revokedAt ? "" : `<form method="post" action="/account/tokens/${encodeURIComponent(token.id)}/revoke">
          <button type="submit">Revoke</button>
        </form>`}
      </td>
    </tr>
  `).join("");

  return pageShell({
    title: "Account",
    body: `
      <header class="topbar">
        <div>
          <h1>Account</h1>
          <p>${escapeHtml(user.email)} · ${escapeHtml(user.role)} · ${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href("/")}">${view.text("nav.index")}</a>
          ${user.role === "admin" ? `<a href="/admin/users">Users</a><a href="/admin/backup">Backup</a>` : ""}
          <a href="/account/password">Password</a>
          <form class="nav-form" method="post" action="/logout"><button type="submit">Sign out</button></form>
          ${languageSwitcher(view)}
        </nav>
      </header>
      <main class="artifact-view">
        ${createdToken ? `<section class="token-once">
          <h2>New API token</h2>
          <p>Copy this token now. Artifacty stores only its hash and cannot show it again.</p>
          <pre class="artifact-code"><code>${escapeHtml(createdToken)}</code></pre>
        </section>` : ""}
        <section class="meta-card">
          <h2>Profile</h2>
          <p><strong>${escapeHtml(user.name)}</strong></p>
          <p>${escapeHtml(user.email)}</p>
          <p>Role: ${escapeHtml(user.role)}</p>
        </section>
        <section class="meta-card">
          <h2>${view.text("tokens.createTitle")}</h2>
          <form class="inline-action token-create-form" method="post" action="/account/tokens">
            <input name="name" placeholder="Token name" autocomplete="off" required>
            <fieldset class="token-scopes">
              <legend>${view.text("tokens.scopes")}</legend>
              <label><input type="checkbox" name="scopeRead" checked> ${view.text("tokens.scope.read")}</label>
              <label><input type="checkbox" name="scopeWrite" checked> ${view.text("tokens.scope.write")}</label>
              ${user.role === "admin" ? `<label><input type="checkbox" name="scopeAdmin"> ${view.text("tokens.scope.admin")}</label>` : ""}
            </fieldset>
            <button type="submit">Create token</button>
          </form>
        </section>
        <section class="meta-card">
          <h2>API tokens</h2>
          <table class="data-table">
            <thead><tr><th>Name</th><th>${view.text("tokens.scopes")}</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows || `<tr><td colspan="6">No API tokens.</td></tr>`}</tbody>
          </table>
        </section>
        <section class="meta-card">
          <h2>${view.text("account.privateArtifacts")}</h2>
          <table class="data-table">
            <thead><tr><th>Title</th><th>ID</th><th>Updated</th><th>Status</th></tr></thead>
            <tbody>${privateArtifactRows || `<tr><td colspan="4">None.</td></tr>`}</tbody>
          </table>
        </section>
      </main>
    `,
    locale: view.locale
  });
}

export function renderPasswordPage({ baseUrl, user, required = false, error = "", success = "", locale = DEFAULT_LOCALE, currentPath = "/account/password" }) {
  const view = viewContext(locale, currentPath);
  return pageShell({
    title: "Change Password",
    body: `
      <header class="topbar">
        <div>
          <h1>Change Password</h1>
          <p>${escapeHtml(user.email)} · ${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href("/")}">${view.text("nav.index")}</a>
          ${required ? "" : `<a href="/account">Account</a>`}
          <form class="nav-form" method="post" action="/logout"><button type="submit">Sign out</button></form>
          ${languageSwitcher(view)}
        </nav>
      </header>
      <main class="artifact-editor auth-panel">
        ${required ? `<p class="auth-warning">Password change is required before continuing.</p>` : ""}
        ${error ? `<p class="auth-error">${escapeHtml(error)}</p>` : ""}
        ${success ? `<p class="auth-success">${escapeHtml(success)}</p>` : ""}
        <form class="editor-form auth-form" method="post" action="/account/password">
          <section class="editor-fields">
            <label class="field">
              <span>Current password</span>
              <input type="password" name="currentPassword" autocomplete="current-password" required>
            </label>
            <label class="field">
              <span>New password</span>
              <input type="password" name="newPassword" autocomplete="new-password" minlength="8" required>
            </label>
            <label class="field">
              <span>Confirm password</span>
              <input type="password" name="confirmPassword" autocomplete="new-password" minlength="8" required>
            </label>
          </section>
          <footer class="editor-actions">
            <button type="submit">Change password</button>
          </footer>
        </form>
      </main>
    `,
    locale: view.locale
  });
}

function renderFullImportSummary(tableCounts) {
  if (!tableCounts || typeof tableCounts !== "object") {
    return "";
  }
  const parts = Object.entries(tableCounts)
    .map(([table, count]) => `${escapeHtml(table)}: ${escapeHtml(count)}`)
    .join(", ");
  return parts ? ` (${parts})` : "";
}

export function renderAdminBackupPage({ baseUrl, integrity, importResult = null, importError = "", locale = DEFAULT_LOCALE, currentPath = "/admin/backup" }) {
  const view = viewContext(locale, currentPath);
  return pageShell({
    title: "Backup",
    body: `
      <header class="topbar">
        <div>
          <h1>Backup</h1>
          <p>${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href("/")}">${view.text("nav.index")}</a>
          <a href="/admin/users">Users</a>
          <a href="/admin/retention">${view.text("retention.navLabel")}</a>
          <a href="/account">Account</a>
          ${languageSwitcher(view)}
        </nav>
      </header>
      <main class="artifact-view">
        ${importResult ? `<p class="auth-success">Restore complete. ${escapeHtml(importResult.artifactCount)} artifacts imported${importResult.scope === "full" ? renderFullImportSummary(importResult.tableCounts) : ""}.</p>` : ""}
        ${importError ? `<p class="auth-error">${escapeHtml(importError)}</p>` : ""}
        <section class="meta-card">
          <h2>Store status</h2>
          <table class="data-table">
            <tbody>
              <tr><th>Home</th><td>${escapeHtml(integrity.store)}</td></tr>
              <tr><th>Artifacts</th><td>${escapeHtml(integrity.artifactCount)}</td></tr>
              <tr><th>Versions</th><td>${escapeHtml(integrity.versionCount)}</td></tr>
              <tr><th>Content bytes</th><td>${escapeHtml(integrity.totalBytes)}</td></tr>
              <tr><th>Integrity</th><td>${integrity.ok ? "OK" : "Needs attention"}</td></tr>
            </tbody>
          </table>
          ${integrity.ok ? "" : `<p class="auth-warning">Run <code>artifacty integrity</code> before migration. Current backup will only include readable referenced version files.</p>`}
        </section>
        <section class="meta-card">
          <h2>Download backup</h2>
          <p class="muted">Exports artifact metadata and version contents as one JSON bundle. The full scope also includes users, API tokens, audit history, relations, and webhooks (secrets are never included and must be re-issued after restore).</p>
          <form class="editor-form" method="get" action="/admin/backup/export">
            <label class="field">
              <span>${view.text("backup.scopeLabel")}</span>
              <select name="scope">
                <option value="artifacts">${view.text("backup.scopeArtifacts")}</option>
                <option value="full">${view.text("backup.scopeFull")}</option>
              </select>
            </label>
            <footer class="editor-actions"><button type="submit">${view.text("backup.downloadButton")}</button></footer>
          </form>
        </section>
        <section class="meta-card">
          <h2>Restore backup</h2>
          <p class="auth-warning">Restore replaces the target server's artifact records and version files with the backup contents. An artifacts-only bundle leaves users, sessions, API tokens, and audit logs unchanged. A full-scope bundle also replaces users, API tokens, audit history, relations, and webhooks (disabled on import; they must be re-issued) — check both boxes below to proceed, and force-users only if this server already has accounts.</p>
          <form class="editor-form" method="post" action="/admin/backup/import">
            <label class="field content-field">
              <span>Backup JSON</span>
              <textarea class="compact-textarea" name="backup" spellcheck="false" placeholder="{&quot;schemaVersion&quot;:1,&quot;artifacts&quot;:[...]}" required></textarea>
            </label>
            <label class="checkbox-field"><input type="checkbox" name="confirm" value="replace-all"> ${view.text("backup.confirmLabel")}</label>
            <label class="checkbox-field"><input type="checkbox" name="forceUsers" value="1"> ${view.text("backup.forceUsersLabel")}</label>
            <footer class="editor-actions"><button type="submit">Restore backup</button></footer>
          </form>
        </section>
      </main>
    `,
    locale: view.locale
  });
}

export function renderAdminUsersPage({ baseUrl, user, users = [], importResult = null, importError = "", locale = DEFAULT_LOCALE, currentPath = "/admin/users" }) {
  const view = viewContext(locale, currentPath);
  const rows = users.map((item) => `
    <tr>
      <td>${escapeHtml(item.email)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.role)}</td>
      <td>${item.active ? "Active" : "Disabled"}${item.passwordResetRequired ? " · Reset required" : ""}</td>
      <td>${escapeHtml(item.createdAt)}</td>
      <td>
        ${item.id === user.id ? "" : `<form method="post" action="/admin/users/${encodeURIComponent(item.id)}/${item.active ? "disable" : "enable"}">
          <button type="submit">${item.active ? "Disable" : "Enable"}</button>
        </form>`}
      </td>
    </tr>
  `).join("");
  const createdRows = (importResult?.created || []).map((item) => `
    <tr>
      <td>${escapeHtml(item.user.email)}</td>
      <td>${escapeHtml(item.user.role)}</td>
      <td>${item.user.passwordResetRequired ? "Yes" : "No"}</td>
      <td>${item.passwordGenerated ? `<code>${escapeHtml(item.temporaryPassword)}</code>` : "Provided in CSV"}</td>
    </tr>
  `).join("");
  const skippedRows = (importResult?.skipped || []).map((item) => `
    <tr><td>${escapeHtml(item.row)}</td><td>${escapeHtml(item.email)}</td><td>${escapeHtml(item.reason)}</td></tr>
  `).join("");
  const failedRows = (importResult?.failed || []).map((item) => `
    <tr><td>${escapeHtml(item.row)}</td><td>${escapeHtml(item.email)}</td><td>${escapeHtml(item.error)}</td></tr>
  `).join("");
  const importSummary = importResult ? `
    <section class="meta-card">
      <h2>Import results</h2>
      <p class="muted">${importResult.created.length} created, ${importResult.skipped.length} skipped, ${importResult.failed.length} failed.</p>
      ${createdRows ? `<table class="data-table">
        <thead><tr><th>Email</th><th>Role</th><th>Reset required</th><th>Temporary password</th></tr></thead>
        <tbody>${createdRows}</tbody>
      </table>` : ""}
      ${skippedRows ? `<h3>Skipped</h3><table class="data-table">
        <thead><tr><th>Row</th><th>Email</th><th>Reason</th></tr></thead>
        <tbody>${skippedRows}</tbody>
      </table>` : ""}
      ${failedRows ? `<h3>Failed</h3><table class="data-table">
        <thead><tr><th>Row</th><th>Email</th><th>Error</th></tr></thead>
        <tbody>${failedRows}</tbody>
      </table>` : ""}
    </section>
  ` : "";

  return pageShell({
    title: "Users",
    body: `
      <header class="topbar">
        <div>
          <h1>Users</h1>
          <p>${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href("/")}">${view.text("nav.index")}</a>
          <a href="/admin/backup">Backup</a>
          <a href="/admin/retention">${view.text("retention.navLabel")}</a>
          <a href="/account">Account</a>
          ${languageSwitcher(view)}
        </nav>
      </header>
      <main class="artifact-view">
        <section class="meta-card">
          <h2>Create user</h2>
          <form class="editor-form auth-form" method="post" action="/admin/users">
            <section class="editor-fields">
              <label class="field"><span>Email</span><input type="email" name="email" required></label>
              <label class="field"><span>Name</span><input name="name"></label>
              <label class="field"><span>Role</span><select name="role"><option value="user">user</option><option value="admin">admin</option></select></label>
              <label class="field"><span>Password</span><input type="password" name="password" minlength="8" required></label>
              <label class="check-field"><input type="checkbox" name="passwordResetRequired"> Require password change</label>
            </section>
            <footer class="editor-actions"><button type="submit">Create user</button></footer>
          </form>
        </section>
        <section class="meta-card">
          <h2>Import users from CSV</h2>
          <p class="muted">Use headers: email, name, role, password, password_reset_required. Missing passwords are generated and must be changed at first sign-in.</p>
          ${importError ? `<p class="auth-error">${escapeHtml(importError)}</p>` : ""}
          <form class="editor-form" method="post" action="/admin/users/import">
            <label class="field content-field">
              <span>CSV</span>
              <textarea class="compact-textarea" name="csv" spellcheck="false" placeholder="email,name,role&#10;user@example.com,User,user" required></textarea>
            </label>
            <footer class="editor-actions"><button type="submit">Import users</button></footer>
          </form>
        </section>
        ${importSummary}
        <section class="meta-card">
          <h2>Existing users</h2>
          <table class="data-table">
            <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Created</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </section>
      </main>
    `,
    locale: view.locale
  });
}

export function renderAdminWebhooksPage({ baseUrl, webhooks = [], createdSecret = null, createdWebhookId = null, locale = DEFAULT_LOCALE, currentPath = "/admin/webhooks" }) {
  const view = viewContext(locale, currentPath);
  const rows = webhooks.map((webhook) => `
    <tr>
      <td><code>${escapeHtml(webhook.url)}</code></td>
      <td>${(webhook.eventTypes || []).length ? webhook.eventTypes.map((type) => escapeHtml(type)).join(", ") : view.text("webhooks.allEvents")}</td>
      <td>${webhook.disabledAt ? view.text("webhooks.disabled") : view.text("webhooks.active")}</td>
      <td>${webhook.lastStatus ?? "-"}</td>
      <td>${webhook.failureCount}</td>
      <td>
        <form method="post" action="/admin/webhooks/${encodeURIComponent(webhook.id)}/delete" onsubmit="return confirm('${escapeAttribute(view.text("webhooks.confirmDelete"))}')">
          <button type="submit">${view.text("webhooks.delete")}</button>
        </form>
      </td>
    </tr>
  `).join("");

  const secretBanner = createdSecret ? `
    <section class="meta-card">
      <h2>${view.text("webhooks.secretTitle")}</h2>
      <p class="auth-warning">${view.text("webhooks.secretWarning")}</p>
      <p><code>${escapeHtml(createdSecret)}</code></p>
      ${createdWebhookId ? `<p class="muted">${view.text("webhooks.webhookId")}: <code>${escapeHtml(createdWebhookId)}</code></p>` : ""}
    </section>
  ` : "";

  return pageShell({
    title: view.text("webhooks.title"),
    body: `
      <header class="topbar">
        <div>
          <h1>${view.text("webhooks.title")}</h1>
          <p>${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href("/")}">${view.text("nav.index")}</a>
          <a href="/admin/backup">Backup</a>
          <a href="/admin/users">Users</a>
          <a href="/admin/retention">${view.text("retention.navLabel")}</a>
          <a href="/account">Account</a>
          ${languageSwitcher(view)}
        </nav>
      </header>
      <main class="artifact-view">
        ${secretBanner}
        <section class="meta-card">
          <h2>${view.text("webhooks.createTitle")}</h2>
          <form class="editor-form" method="post" action="/admin/webhooks">
            <section class="editor-fields">
              <label class="field"><span>${view.text("webhooks.url")}</span><input type="url" name="url" placeholder="https://example.com/hooks/artifacty" required></label>
              <label class="field"><span>${view.text("webhooks.eventTypes")}</span><input name="eventTypes" placeholder="${view.text("webhooks.eventTypesPlaceholder")}"></label>
            </section>
            <footer class="editor-actions"><button type="submit">${view.text("webhooks.create")}</button></footer>
          </form>
        </section>
        <section class="meta-card">
          <h2>${view.text("webhooks.existingTitle")}</h2>
          <table class="data-table">
            <thead><tr><th>${view.text("webhooks.url")}</th><th>${view.text("webhooks.eventTypes")}</th><th>${view.text("webhooks.status")}</th><th>${view.text("webhooks.lastStatus")}</th><th>${view.text("webhooks.failures")}</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </section>
      </main>
    `,
    locale: view.locale
  });
}

export function renderAdminRetentionPage({ baseUrl, policy, lastSweep = null, report = null, locale = DEFAULT_LOCALE, currentPath = "/admin/retention" }) {
  const view = viewContext(locale, currentPath);
  const byTypeText = Object.entries(policy.archiveAfterDays.byType || {})
    .map(([type, days]) => `${type}=${days}`)
    .join("\n");

  const lastSweepSection = lastSweep ? `
    <section class="meta-card">
      <h2>${view.text("retention.lastSweepTitle")}</h2>
      <table class="data-table">
        <tbody>
          <tr><th>${view.text("retention.sweepAt")}</th><td>${escapeHtml(lastSweep.createdAt)}</td></tr>
          <tr><th>${view.text("retention.archived")}</th><td>${escapeHtml(lastSweep.metadata?.archived ?? 0)}</td></tr>
          <tr><th>${view.text("retention.purged")}</th><td>${escapeHtml(lastSweep.metadata?.purged ?? 0)}</td></tr>
          <tr><th>${view.text("retention.purgeSkipped")}</th><td>${lastSweep.metadata?.purgeSkipped ? view.text("retention.yes") : view.text("retention.no")}</td></tr>
          <tr><th>${view.text("retention.auditRowsDeleted")}</th><td>${escapeHtml(lastSweep.metadata?.auditRowsDeleted ?? 0)}</td></tr>
          <tr><th>${view.text("retention.eventRowsDeleted")}</th><td>${escapeHtml(lastSweep.metadata?.eventRowsDeleted ?? 0)}</td></tr>
        </tbody>
      </table>
    </section>
  ` : "";

  const archiveRows = (report?.archive || []).map((item) => `
    <tr><td><code>${escapeHtml(item.id)}</code></td><td>${escapeHtml(item.artifactType)}</td><td>${escapeHtml(item.ageDays)}</td><td>${escapeHtml(item.thresholdDays)}</td></tr>
  `).join("");
  const purgeRows = (report?.purge || []).map((item) => `
    <tr><td><code>${escapeHtml(item.id)}</code></td><td>${escapeHtml(item.ageDays)}</td><td>${escapeHtml(item.thresholdDays)}</td></tr>
  `).join("");

  const reportSection = report ? `
    <section class="meta-card">
      <h2>${report.dryRun ? view.text("retention.dryRunReportTitle") : view.text("retention.appliedReportTitle")}</h2>
      <p class="muted">${view.text("retention.auditRowsToDelete")}: ${escapeHtml(report.auditRowsToDelete)} · ${view.text("retention.eventRowsToDelete")}: ${escapeHtml(report.eventRowsToDelete)}</p>
      ${report.purgeSkipped ? `<p class="auth-warning">${view.text("retention.purgeGatedWarning")}</p>` : ""}
      <h3>${view.text("retention.toArchive")} (${report.archive.length})</h3>
      ${archiveRows ? `<table class="data-table">
        <thead><tr><th>${view.text("retention.artifactId")}</th><th>${view.text("retention.artifactType")}</th><th>${view.text("retention.ageDays")}</th><th>${view.text("retention.thresholdDays")}</th></tr></thead>
        <tbody>${archiveRows}</tbody>
      </table>` : `<p class="muted">${view.text("retention.none")}</p>`}
      <h3>${view.text("retention.toPurge")} (${report.purge.length})</h3>
      ${purgeRows ? `<table class="data-table">
        <thead><tr><th>${view.text("retention.artifactId")}</th><th>${view.text("retention.ageDays")}</th><th>${view.text("retention.thresholdDays")}</th></tr></thead>
        <tbody>${purgeRows}</tbody>
      </table>` : `<p class="muted">${view.text("retention.none")}</p>`}
    </section>
  ` : "";

  return pageShell({
    title: view.text("retention.title"),
    body: `
      <header class="topbar">
        <div>
          <h1>${view.text("retention.title")}</h1>
          <p>${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href("/")}">${view.text("nav.index")}</a>
          <a href="/admin/backup">Backup</a>
          <a href="/admin/users">Users</a>
          <a href="/account">Account</a>
          ${languageSwitcher(view)}
        </nav>
      </header>
      <main class="artifact-view">
        <section class="meta-card">
          <h2>${view.text("retention.policyTitle")}</h2>
          <form class="editor-form" method="post" action="/admin/retention">
            <section class="editor-fields">
              <label class="field"><span>${view.text("retention.archiveAfterDaysDefault")}</span><input type="number" min="1" name="archiveAfterDaysDefault" value="${policy.archiveAfterDays.default ?? ""}"></label>
              <label class="field content-field"><span>${view.text("retention.archiveAfterDaysByType")}</span><textarea class="compact-textarea" name="archiveAfterDaysByType" placeholder="test-report=30">${escapeHtml(byTypeText)}</textarea></label>
              <label class="field"><span>${view.text("retention.purgeArchivedAfterDays")}</span><input type="number" min="1" name="purgeArchivedAfterDays" value="${policy.purgeArchivedAfterDays ?? ""}"></label>
              <label class="field"><span>${view.text("retention.auditRetentionDays")}</span><input type="number" min="1" name="auditRetentionDays" value="${policy.auditRetentionDays ?? ""}"></label>
              <label class="field"><span>${view.text("retention.eventRetentionRows")}</span><input type="number" min="1" name="eventRetentionRows" value="${policy.eventRetentionRows ?? ""}"></label>
              <label class="field"><span>${view.text("retention.keepTags")}</span><input name="keepTags" value="${escapeAttribute((policy.keepTags || []).join(", "))}" placeholder="pinned, release"></label>
            </section>
            <footer class="editor-actions"><button type="submit">${view.text("retention.saveButton")}</button></footer>
          </form>
        </section>
        ${lastSweepSection}
        <section class="meta-card">
          <h2>${view.text("retention.runTitle")}</h2>
          <p class="auth-warning">${view.text("retention.purgeGateNote")}</p>
          <form class="editor-form" method="post" action="/admin/retention/run">
            <label class="checkbox-field"><input type="checkbox" name="dryRun" value="1" checked> ${view.text("retention.dryRunLabel")}</label>
            <label class="checkbox-field"><input type="checkbox" name="allowPurge" value="1"> ${view.text("retention.allowPurgeLabel")}</label>
            <footer class="editor-actions"><button type="submit">${view.text("retention.runButton")}</button></footer>
          </form>
        </section>
        ${reportSection}
      </main>
    `,
    locale: view.locale
  });
}

export function renderArtifactPage({ artifact, version, content, comments = [], baseUrl, authToken = "", locale = DEFAULT_LOCALE, currentPath = "/", user = null }) {
  const view = viewContext(locale, currentPath);
  const versionLinks = artifact.versions
    .map((item) => {
      const active = item.version === version.version ? " active" : "";
      return `<a class="version${active}" href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}?version=${item.version}`)}">v${item.version}</a>`;
    })
    .join("");

  const rendered = renderContent(version.format, content, version.metadata || {}, {
    reactFrameUrl: reactRendererEnabled()
      ? view.href(`/artifacts/${encodeURIComponent(artifact.id)}/react-frame?version=${version.version}`)
      : "",
    rawUrl: view.href(`/artifacts/${encodeURIComponent(artifact.id)}/raw?version=${version.version}`),
    artifactType: artifact.artifactType,
    // Include the viewed version explicitly so an older bundle version's
    // files are fetched from that version's own content rather than
    // whatever is currently latest (the raw route resolves ?version the
    // same way the page itself did above).
    bundleFileUrl: (fileName) => view.href(`/artifacts/${encodeURIComponent(artifact.id)}/raw?version=${version.version}&file=${encodeURIComponent(fileName)}`),
    view
  });
  const viewClass = artifactViewClass({ artifact, version });
  // Comments render through markdownToHtml for every artifact format and can
  // emit a data-artifacty-mermaid placeholder regardless of the version's
  // own format, so a json/html/svg/react/image/video/text artifact with a
  // mermaid fence in a comment still needs the viewer script to mount it
  // (otherwise the reader sees a blank box).
  const needsViewerScript = version.format === "code" || version.format === "markdown" || version.format === "notebook" ||
    version.format === "sarif" || version.format === "csv" || comments.length > 0;
  const rawUrl = `/artifacts/${encodeURIComponent(artifact.id)}/raw?version=${version.version}`;
  const archiveAction = artifact.archivedAt ? "restore" : "archive";
  const archiveLabel = artifact.archivedAt ? view.text("artifact.restore") : view.text("artifact.archive");
  const publisher = publisherDisplay(artifact, view);
  const canManageVisibility = !user || user.role === "admin" || (artifact.ownerUserId && user.id === artifact.ownerUserId);
  const visibilityForm = canManageVisibility
    ? `<form class="inline-action" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/visibility">
        ${hiddenToken(authToken)}
        ${localeInput(view.locale)}
        <label>
          <span>${view.text("artifact.visibility.label")}</span>
          ${visibilitySelect(artifact.visibility || "team", view)}
        </label>
        <button type="submit">${view.text("artifact.visibility.change")}</button>
      </form>`
    : "";

  return pageShell({
    title: artifact.title,
    body: `
      <header class="topbar">
        <div>
          <h1>${escapeHtml(artifact.title)}</h1>
          <p>${escapeHtml(artifact.id)} · ${escapeHtml(artifact.sourceAgent)} · ${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href("/")}">${view.text("nav.index")}</a>
          <a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}/edit`)}">${view.text("nav.edit")}</a>
          <a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}/diff`)}">${view.text("nav.diff")}</a>
          ${user?.role === "admin" ? `<a href="${view.href(`/admin/artifacts/${encodeURIComponent(artifact.id)}/versions`)}">Versions</a>` : ""}
          <a href="${view.href(rawUrl)}">${view.text("nav.raw")}</a>
          ${authNav(user)}
          ${languageSwitcher(view)}
        </nav>
      </header>
      <main class="${viewClass}">
        <section class="meta-strip">
          ${formatBadge(version.format)}
          ${typeBadge(artifact.artifactType || "document")}
          <span>${view.text("artifact.schema", { version: artifact.schemaVersion || 1 })}</span>
          ${artifact.archivedAt ? statusBadge(view.text("artifact.archived", { date: artifact.archivedAt })) : ""}
          ${visibilityBadge(artifact, view)}
          <span title="${escapeAttribute(publisherTitle(artifact, view))}">${view.text("artifact.publisher", { publisher })}</span>
          <span>${view.text("artifact.bytes", { size: version.sizeBytes })}</span>
          <span>${escapeHtml(version.createdAt)}</span>
          <span>${escapeHtml(version.sha256.slice(0, 12))}</span>
        </section>
        <form class="inline-action" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/${archiveAction}">
          ${hiddenToken(authToken)}
          ${localeInput(view.locale)}
          <button type="submit">${archiveLabel}</button>
        </form>
        ${visibilityForm}
        <section class="version-strip">${versionLinks}</section>
        ${rendered}
        ${renderRelationsSection(artifact, view)}
        ${renderCommentsSection(artifact, comments, view, { version: version.version, authToken, canModerate: canManageVisibility })}
      </main>
    `,
    head: needsViewerScript ? editorHead() : "",
    afterBody: `${frameResizeScript()}${needsViewerScript ? viewerScript() : ""}`,
    locale: view.locale
  });
}

// --- Comments and review status (roadmap section 5) -----------------------

function renderCommentsSection(artifact, comments, view, { version, authToken, canModerate }) {
  const grouped = new Map();
  for (const comment of comments) {
    if (!grouped.has(comment.version)) {
      grouped.set(comment.version, []);
    }
    grouped.get(comment.version).push(comment);
  }
  const versions = [...grouped.keys()].sort((a, b) => b - a);

  // One shared mermaid diagram state for the whole comments section: the
  // ARTIFACTY_MAX_INLINE_DIAGRAMS cap is meant to bound diagrams per page,
  // not per comment. Passing a fresh state to markdownToHtml for each
  // comment (the old behavior) let the cap reset every time, so N comments
  // with diagrams could still embed N * cap base64 srcdoc payloads.
  const diagramState = createMermaidDiagramState();
  const groups = versions
    .map((groupVersion) => renderCommentVersionGroup(artifact, grouped.get(groupVersion), groupVersion, view, { activeVersion: version, authToken, canModerate, diagramState }))
    .join("");

  return `
    <section class="comments">
      <h2>${view.text("comments.title")}</h2>
      <div class="comment-review-status">
        ${reviewStatusBadge(artifact, view)}
        ${canModerate ? renderReviewStatusForm(artifact, view, authToken) : ""}
      </div>
      ${comments.length === 0 ? `<p class="comments-empty">${view.text("comments.empty")}</p>` : groups}
      ${versions.includes(version) ? "" : renderCommentForm(artifact, view, { version, authToken })}
    </section>
  `;
}

function renderCommentVersionGroup(artifact, versionComments, groupVersion, view, { activeVersion, authToken, canModerate, diagramState }) {
  const roots = versionComments.filter((comment) => !comment.parentId);
  const repliesByParent = new Map();
  for (const comment of versionComments) {
    if (comment.parentId) {
      if (!repliesByParent.has(comment.parentId)) {
        repliesByParent.set(comment.parentId, []);
      }
      repliesByParent.get(comment.parentId).push(comment);
    }
  }
  const isActiveVersion = groupVersion === activeVersion;
  const items = roots
    .map((root) => renderCommentThread(artifact, root, repliesByParent.get(root.id) || [], view, { authToken, canModerate, allowReply: isActiveVersion, diagramState }))
    .join("");

  return `
    <div class="comment-version-group">
      <h3>${view.text("comments.version", { version: groupVersion })}</h3>
      <ul class="comment-list">${items}</ul>
      ${isActiveVersion ? renderCommentForm(artifact, view, { version: groupVersion, authToken }) : ""}
    </div>
  `;
}

function renderCommentThread(artifact, root, replies, view, { authToken, canModerate, allowReply, diagramState }) {
  const replyItems = replies
    .map((reply) => renderCommentEntry(artifact, reply, view, { authToken, canModerate, isReply: true, diagramState }))
    .join("");
  const replyForm = allowReply
    ? renderCommentForm(artifact, view, { version: root.version, authToken, parentId: root.id, compact: true })
    : "";

  return `
    <li class="comment-thread">
      ${renderCommentEntry(artifact, root, view, { authToken, canModerate, isReply: false, diagramState })}
      ${replyItems ? `<ul class="comment-replies">${replyItems}</ul>` : ""}
      ${replyForm}
    </li>
  `;
}

function renderCommentEntry(artifact, comment, view, { authToken, canModerate, isReply, diagramState }) {
  const anchorLabel = commentAnchorLabel(comment.anchor, view);
  const resolved = comment.status === "resolved";
  const resolveForm = !resolved
    ? `<form class="inline-action" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/comments/${encodeURIComponent(comment.id)}/resolve">
        ${hiddenToken(authToken)}
        ${localeInput(view.locale)}
        <button type="submit">${view.text("comments.resolve")}</button>
      </form>`
    : "";
  const deleteForm = canModerate
    ? `<form class="inline-action" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/comments/${encodeURIComponent(comment.id)}/delete">
        ${hiddenToken(authToken)}
        ${localeInput(view.locale)}
        <button type="submit">${view.text("comments.delete")}</button>
      </form>`
    : "";

  return `
    <li class="comment-item${isReply ? " comment-reply" : ""}${resolved ? " comment-resolved" : ""}">
      <div class="comment-header">
        <span class="comment-author">${escapeHtml(comment.authorLabel)}</span>
        <span class="comment-meta">${escapeHtml(comment.createdAt)}</span>
        ${anchorLabel ? `<span class="comment-anchor">${anchorLabel}</span>` : ""}
        ${resolved ? `<span class="badge s-archived">${view.text("comments.resolved")}</span>` : ""}
      </div>
      <div class="comment-body">${markdownToHtml(comment.body, diagramState)}</div>
      <div class="comment-actions">${resolveForm}${deleteForm}</div>
    </li>
  `;
}

// Line/row/path anchors are rendering hints, not validated against content.
// Rendering them as plain text here (rather than a CodeMirror gutter
// marker) is the deliberately simpler fallback the roadmap allows.
function commentAnchorLabel(anchor, view) {
  if (!anchor || typeof anchor !== "object") {
    return "";
  }
  if (anchor.line !== undefined && anchor.line !== null) {
    return view.text("comments.anchorLine", { line: anchor.line });
  }
  if (anchor.row !== undefined && anchor.row !== null) {
    return view.text("comments.anchorRow", { row: anchor.row });
  }
  if (anchor.path) {
    return view.text("comments.anchorPath", { path: anchor.path });
  }
  return "";
}

function renderCommentForm(artifact, view, { version, authToken, parentId, compact } = {}) {
  return `
    <form class="comment-form${compact ? " comment-reply-form" : ""}" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/comments">
      ${hiddenToken(authToken)}
      ${localeInput(view.locale)}
      <input type="hidden" name="version" value="${escapeAttribute(String(version))}">
      ${parentId ? `<input type="hidden" name="parentId" value="${escapeAttribute(parentId)}">` : ""}
      <label>
        <span>${view.text(compact ? "comments.replyLabel" : "comments.bodyLabel")}</span>
        <textarea name="body" required maxlength="16384"></textarea>
      </label>
      ${compact ? "" : `<label class="comment-line-label">
        <span>${view.text("comments.lineLabel")}</span>
        <input type="number" name="line" min="1">
      </label>`}
      <button type="submit">${view.text(compact ? "comments.reply" : "comments.submit")}</button>
    </form>
  `;
}

function renderReviewStatusForm(artifact, view, authToken) {
  const current = artifact.reviewStatus || "none";
  return `
    <form class="inline-action" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/review-status">
      ${hiddenToken(authToken)}
      ${localeInput(view.locale)}
      <label>
        <span>${view.text("comments.reviewStatus.label")}</span>
        <select name="status">
          ${REVIEW_STATUSES.map((status) => `<option value="${status}"${status === current ? " selected" : ""}>${view.text(`comments.reviewStatus.${status}`)}</option>`).join("")}
        </select>
      </label>
      <button type="submit">${view.text("comments.reviewStatus.change")}</button>
    </form>
  `;
}

// Only rendered for a non-default review status so the common case doesn't
// add visual noise to every artifact page.
function reviewStatusBadge(artifact, view) {
  const status = artifact.reviewStatus || "none";
  if (status === "none") {
    return "";
  }
  const slug = status.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `<span class="badge rs-${escapeAttribute(slug)}">${view.text(`comments.reviewStatus.${status}`)}</span>`;
}

function renderRelationsSection(artifact, view) {
  const relations = artifact.relations || { outgoing: [], incoming: [] };
  const hasRelations = relations.outgoing.length > 0 || relations.incoming.length > 0;

  return `
    <section class="relations">
      <h2>${view.text("relations.title")}</h2>
      ${hasRelations ? "" : `<p class="relations-empty">${view.text("relations.empty")}</p>`}
      ${renderRelationGroup(relations.outgoing, view.text("relations.outgoing"), view)}
      ${renderRelationGroup(relations.incoming, view.text("relations.incoming"), view)}
    </section>
  `;
}

function renderRelationGroup(entries, label, view) {
  if (!entries.length) {
    return "";
  }
  const items = entries.map((entry) => renderRelationEntry(entry, view)).join("");
  return `
    <div class="relation-group">
      <h3>${escapeHtml(label)}</h3>
      <ul class="relation-list">${items}</ul>
    </div>
  `;
}

function renderRelationEntry(entry, view) {
  const relationLabel = escapeHtml(entry.relation);
  const createdAt = escapeHtml(view.text("relations.createdAt", { date: entry.createdAt }));
  if (entry.restricted) {
    return `
      <li class="relation-item relation-missing">
        <span class="badge">${relationLabel}</span>
        <span class="relation-missing-label">(${view.text("relations.restricted")})</span>
      </li>
    `;
  }
  if (entry.missing || !entry.artifact) {
    return `
      <li class="relation-item relation-missing">
        <span class="badge">${relationLabel}</span>
        <span>${escapeHtml(entry.artifactId)}</span>
        <span class="relation-missing-label">(${view.text("relations.missing")})</span>
      </li>
    `;
  }
  return `
    <li class="relation-item">
      <span class="badge">${relationLabel}</span>
      <a href="${view.href(`/artifacts/${encodeURIComponent(entry.artifactId)}`)}">${escapeHtml(entry.artifact.title)}</a>
      <span class="relation-meta">${createdAt}</span>
    </li>
  `;
}

function artifactViewClass({ artifact, version }) {
  const wideFormats = new Set(["html", "svg", "mermaid", "react", "sarif", "csv", "image", "video", "notebook"]);
  const wideTypes = new Set(["dashboard", "design-option", "diff-walkthrough"]);
  const classes = ["artifact-view"];
  if (wideFormats.has(version.format) || wideTypes.has(artifact.artifactType)) {
    classes.push("artifact-view-wide");
  }
  return classes.join(" ");
}

export function renderDiffPage({ artifact, fromVersion, toVersion, fromContent, toContent, diffRows, view: diffView = "lines", structuredDiff, baseUrl, locale = DEFAULT_LOCALE, currentPath = "/" }) {
  const view = viewContext(locale, currentPath);
  const title = view.raw("diff.title", { title: artifact.title });
  const versionOptions = artifact.versions
    .map((item) => `<option value="${item.version}">v${item.version}</option>`)
    .join("");

  const maxDiffRows = resolveMaxDiffEntries();
  const diffRowsTruncated = diffRows.length > maxDiffRows;
  const visibleDiffRows = diffRowsTruncated ? diffRows.slice(0, maxDiffRows) : diffRows;
  const rows = visibleDiffRows
    .map((row) => `
      <tr class="diff-${row.type}">
        <td>${escapeHtml(row.beforeLine)}</td>
        <td>${escapeHtml(row.afterLine)}</td>
        <td><code>${escapeHtml(diffPrefix(row.type))}${escapeHtml(row.text)}</code></td>
      </tr>
    `)
    .join("");
  const lineDiffTruncatedNote = diffRowsTruncated
    ? `<p class="diff-truncated-note">${escapeHtml(view.raw("diff.truncated", { count: visibleDiffRows.length }))}</p>`
    : "";

  const preview = toVersion.format === "html"
    ? `<section class="split-preview">
        <div>${renderContent(fromVersion.format, fromContent)}</div>
        <div>${renderContent(toVersion.format, toContent)}</div>
      </section>`
    : "";

  const resolvedView = diffView === "structured" && structuredDiff ? "structured" : "lines";
  const otherView = resolvedView === "structured" ? "lines" : "structured";
  const toggleHref = view.href(`/artifacts/${encodeURIComponent(artifact.id)}/diff?from=${encodeURIComponent(fromVersion.version)}&to=${encodeURIComponent(toVersion.version)}&view=${otherView}`);
  const viewToggle = `<p class="diff-view-toggle">
    ${view.text("diff.viewLabel")}: ${resolvedView === "structured" ? view.text("diff.structured") : view.text("diff.lines")}
    &middot; <a href="${toggleHref}">${view.text(resolvedView === "structured" ? "diff.viewLines" : "diff.viewStructured")}</a>
  </p>`;

  const diffBody = resolvedView === "structured"
    ? renderStructuredDiffSection(view, structuredDiff)
    : `${lineDiffTruncatedNote}<table class="diff-table">
        <thead><tr><th>${view.text("diff.from")}</th><th>${view.text("diff.to")}</th><th>${view.text("diff.line")}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

  return pageShell({
    title,
    body: `
      <header class="topbar">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(artifact.id)} · ${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}`)}">${view.text("nav.artifact")}</a>
          ${languageSwitcher(view)}
        </nav>
      </header>
      <main class="artifact-view">
        <form class="diff-form" method="get" action="/artifacts/${encodeURIComponent(artifact.id)}/diff">
          ${localeInput(view.locale)}
          <input type="hidden" name="view" value="${escapeAttribute(resolvedView)}">
          <label class="field">
            <span>${view.text("diff.from")}</span>
            <select name="from">${versionOptions}</select>
          </label>
          <label class="field">
            <span>${view.text("diff.to")}</span>
            <select name="to">${versionOptions}</select>
          </label>
          <button type="submit">${view.text("diff.compare")}</button>
        </form>
        <script>
          document.querySelector('select[name="from"]').value = ${JSON.stringify(String(fromVersion.version))};
          document.querySelector('select[name="to"]').value = ${JSON.stringify(String(toVersion.version))};
        </script>
        ${viewToggle}
        ${diffBody}
        ${preview}
      </main>
    `,
    locale: view.locale
  });
}

function renderStructuredDiffSection(view, structuredDiff) {
  if (!structuredDiff) {
    return `<p class="diff-truncated-note">${view.text("diff.noChanges")}</p>`;
  }

  const summary = structuredDiff.summary || {};
  const summaryText = `+${summary.added || 0} -${summary.removed || 0} ~${summary.changed || 0}`;
  const truncatedNote = structuredDiff.truncated
    ? `<p class="diff-truncated-note">${escapeHtml(view.raw("diff.truncated", { count: structuredDiff.entries.length }))}</p>`
    : "";

  if (structuredDiff.entries.length === 0) {
    return `<p class="diff-summary">${escapeHtml(summaryText)}</p><p class="diff-truncated-note">${view.text("diff.noChanges")}</p>`;
  }

  if (structuredDiff.kind === "lines") {
    return `<div class="structured-diff structured-diff-lines">
      <p class="diff-summary">${escapeHtml(summaryText)}</p>
      ${truncatedNote}
      <table class="diff-table">
        <thead><tr><th>${view.text("diff.from")}</th><th>${view.text("diff.to")}</th><th>${view.text("diff.line")}</th></tr></thead>
        <tbody>${structuredDiff.entries.map((entry) => renderLineEntryRows(entry)).join("")}</tbody>
      </table>
    </div>`;
  }

  if (structuredDiff.kind === "json") {
    return `<div class="structured-diff structured-diff-json">
      <p class="diff-summary">${escapeHtml(summaryText)}</p>
      ${truncatedNote}
      <table class="structured-diff-table">
        <thead><tr><th>${view.text("diff.op")}</th><th>${view.text("diff.path")}</th><th>${view.text("diff.before")}</th><th>${view.text("diff.after")}</th></tr></thead>
        <tbody>${structuredDiff.entries.map((entry) => renderJsonEntryRow(view, entry)).join("")}</tbody>
      </table>
    </div>`;
  }

  if (structuredDiff.kind === "csv") {
    return `<div class="structured-diff structured-diff-csv">
      <p class="diff-summary">${escapeHtml(summaryText)}</p>
      ${truncatedNote}
      <table class="structured-diff-table">
        <thead><tr><th>${view.text("diff.op")}</th><th>${view.text("diff.row")}</th><th>${view.text("diff.column")}</th><th>${view.text("diff.before")}</th><th>${view.text("diff.after")}</th></tr></thead>
        <tbody>${structuredDiff.entries.map((entry) => renderCsvEntryRow(view, entry)).join("")}</tbody>
      </table>
    </div>`;
  }

  if (structuredDiff.kind === "bundle") {
    return `<div class="structured-diff structured-diff-bundle">
      <p class="diff-summary">${escapeHtml(summaryText)}</p>
      ${truncatedNote}
      <table class="structured-diff-table">
        <thead><tr><th>${view.text("diff.file")}</th><th>${view.text("diff.op")}</th><th>${view.text("diff.path")}</th><th>${view.text("diff.before")}</th><th>${view.text("diff.after")}</th></tr></thead>
        <tbody>${structuredDiff.entries.map((entry) => renderBundleEntryRow(view, entry)).join("")}</tbody>
      </table>
    </div>`;
  }

  return "";
}

function renderLineEntryRows(entry) {
  if (entry.op === "changed") {
    const beforeHtml = renderWordSpans(entry.words, "removed");
    const afterHtml = renderWordSpans(entry.words, "added");
    return `<tr class="diff-removed">
        <td>${escapeHtml(entry.beforeLine ?? "")}</td>
        <td></td>
        <td><code>${escapeHtml(diffPrefix("removed"))}${beforeHtml}</code></td>
      </tr>
      <tr class="diff-added">
        <td></td>
        <td>${escapeHtml(entry.afterLine ?? "")}</td>
        <td><code>${escapeHtml(diffPrefix("added"))}${afterHtml}</code></td>
      </tr>`;
  }
  return `<tr class="diff-${entry.op}">
    <td>${escapeHtml(entry.beforeLine ?? "")}</td>
    <td>${escapeHtml(entry.afterLine ?? "")}</td>
    <td><code>${escapeHtml(diffPrefix(entry.op))}${escapeHtml(entry.text)}</code></td>
  </tr>`;
}

function renderWordSpans(words, keepOp) {
  if (!Array.isArray(words)) {
    return "";
  }
  const dropOp = keepOp === "removed" ? "added" : "removed";
  return words
    .filter((word) => word.op !== dropOp)
    .map((word) => {
      if (word.op === keepOp) {
        return `<span class="diff-word-${keepOp}">${escapeHtml(word.text)}</span>`;
      }
      return escapeHtml(word.text);
    })
    .join("");
}

function renderJsonEntryRow(view, entry) {
  return `<tr class="diff-${entry.op}">
    <td>${opLabel(view, entry.op)}</td>
    <td><code>${escapeHtml(entry.path)}</code></td>
    <td><code>${escapeHtml(formatDiffValue(entry.before))}</code></td>
    <td><code>${escapeHtml(formatDiffValue(entry.after))}</code></td>
  </tr>`;
}

function renderCsvEntryRow(view, entry) {
  const rowLabel = entry.row === "header" ? view.text("diff.header") : String(entry.row);
  const beforeValue = entry.cells !== undefined ? JSON.stringify(entry.cells) : formatDiffValue(entry.before);
  const afterValue = entry.cells !== undefined ? JSON.stringify(entry.cells) : formatDiffValue(entry.after);
  return `<tr class="diff-${entry.op}">
    <td>${opLabel(view, entry.op)}</td>
    <td><code>${escapeHtml(rowLabel)}</code></td>
    <td>${entry.column !== undefined ? escapeHtml(entry.column) : ""}</td>
    <td><code>${escapeHtml(beforeValue)}</code></td>
    <td><code>${escapeHtml(afterValue)}</code></td>
  </tr>`;
}

function renderBundleEntryRow(view, entry) {
  const label = entry.path !== undefined
    ? entry.path
    : entry.row !== undefined
      ? String(entry.row)
      : (entry.beforeLine ?? entry.afterLine ?? "");
  const beforeValue = entry.cells !== undefined
    ? JSON.stringify(entry.cells)
    : formatDiffValue(entry.before ?? entry.text);
  const afterValue = entry.cells !== undefined ? JSON.stringify(entry.cells) : formatDiffValue(entry.after);
  const rowClass = entry.op === "changed" ? "changed" : entry.op;
  return `<tr class="diff-${rowClass}">
    <td><code>${escapeHtml(entry.file || "")}</code></td>
    <td>${opLabel(view, entry.op)}</td>
    <td><code>${escapeHtml(label)}</code></td>
    <td><code>${escapeHtml(beforeValue)}</code></td>
    <td><code>${escapeHtml(afterValue)}</code></td>
  </tr>`;
}

function formatDiffValue(value) {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function opLabel(view, op) {
  return view.text(`diff.op.${op}`);
}

// Bundle document assets (roadmap section 17). Renders binary file entries
// (encoding: "base64") from a bundle artifact's `files` array: PDFs get a
// sandboxed iframe pointed at the raw file route (no allow-same-origin, no
// scripts), other document types show metadata and a download link. Returns
// "" when there is nothing to show so callers can fall back cleanly.
function renderBundleFiles(content, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.files)) {
    return "";
  }
  const documentFiles = parsed.files.filter((file) => file && typeof file === "object" && file.encoding === "base64");
  if (documentFiles.length === 0) {
    return "";
  }

  const view = options.view;
  const label = (key, params) => (view ? view.text(key, params) : escapeHtml(String(key)));
  const bundleFileUrl = typeof options.bundleFileUrl === "function" ? options.bundleFileUrl : (fileName) => `?file=${encodeURIComponent(fileName)}`;

  const items = documentFiles.map((file) => {
    const fileName = String(file.path || file.name || "file");
    const contentType = String(file.contentType || "application/octet-stream");
    const fileUrl = bundleFileUrl(fileName);
    const sizeLabel = Number.isFinite(file.sizeBytes) ? label("artifact.bytes", { size: file.sizeBytes }) : "";

    if (contentType === "application/pdf") {
      return `<div class="bundle-file bundle-file-pdf">
        <div class="bundle-file-meta">
          <span class="bundle-file-name">${escapeHtml(fileName)}</span>
          <span class="bundle-file-type">${escapeHtml(contentType)}</span>
          <span class="bundle-file-size">${sizeLabel}</span>
        </div>
        <iframe class="artifact-frame bundle-file-frame" sandbox src="${escapeAttribute(fileUrl)}"></iframe>
      </div>`;
    }

    return `<div class="bundle-file bundle-file-download">
      <div class="bundle-file-meta">
        <span class="bundle-file-name">${escapeHtml(fileName)}</span>
        <span class="bundle-file-type">${escapeHtml(contentType)}</span>
        <span class="bundle-file-size">${sizeLabel}</span>
      </div>
      <a class="bundle-file-link" href="${escapeAttribute(fileUrl)}">${label("bundle.download")}</a>
    </div>`;
  }).join("");

  return `<section class="bundle-files">
    <h3>${label("bundle.files")}</h3>
    ${items}
  </section>`;
}

export function renderContent(format, content, metadata = {}, options = {}) {
  if (format === "html") {
    return `<iframe class="artifact-frame" sandbox="allow-scripts allow-forms allow-popups" srcdoc="${escapeAttribute(htmlFrameContent(content))}"></iframe>`;
  }

  if (format === "svg") {
    return `<iframe class="artifact-frame artifact-svg-frame" sandbox srcdoc="${escapeAttribute(svgFrameContent(content))}"></iframe>`;
  }

  if (format === "mermaid") {
    return `<iframe class="artifact-frame artifact-mermaid-frame" sandbox="allow-scripts" srcdoc="${escapeAttribute(mermaidFrameContent(content))}"></iframe>`;
  }

  if (format === "markdown") {
    return `<article class="artifact-doc">${markdownToHtml(content)}</article>`;
  }

  if (format === "json") {
    if (options.artifactType === "bundle") {
      const bundleFiles = renderBundleFiles(content, options);
      if (bundleFiles) {
        return `${bundleFiles}<pre class="artifact-code"><code>${escapeHtml(formatJson(content))}</code></pre>`;
      }
    }
    return `<pre class="artifact-code"><code>${escapeHtml(formatJson(content))}</code></pre>`;
  }

  if (format === "notebook") {
    return renderNotebook(content);
  }

  if (format === "sarif") {
    return renderSarif(content);
  }

  if (format === "csv") {
    return renderCsv(content);
  }

  if (format === "image") {
    return renderMediaArtifact("image", content, metadata, options);
  }

  if (format === "video") {
    return renderMediaArtifact("video", content, metadata, options);
  }

  if (format === "code") {
    const language = metadata.language || metadata.artifactyImport?.language || "";
    return `<section class="artifact-code-viewer" data-artifacty-code-viewer data-language="${escapeAttribute(language)}">
      <textarea hidden>${escapeHtml(content)}</textarea>
      <pre class="artifact-code artifact-code-fallback"><code>${escapeHtml(content)}</code></pre>
    </section>`;
  }

  if (format === "react") {
    if (options.reactFrameUrl) {
      return `<iframe class="artifact-frame artifact-react-frame" sandbox="allow-scripts" src="${escapeAttribute(options.reactFrameUrl)}"></iframe>`;
    }
    return `<section class="artifact-react-disabled">
      <p>React rendering is disabled. Set <code>ARTIFACTY_ENABLE_REACT_RENDERER=true</code> to run this component in a sandboxed frame.</p>
      <pre class="artifact-code"><code>${escapeHtml(content)}</code></pre>
    </section>`;
  }

  return `<pre class="artifact-code"><code>${escapeHtml(content)}</code></pre>`;
}

export function renderReactFramePage({ title, content }) {
  const source = jsonForScript(content);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    html, body { margin: 0; min-height: 100%; background: #fff; color: #111827; }
    body { padding: 16px; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #root { min-height: 120px; }
    .error { white-space: pre-wrap; color: #991b1b; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="application/json" id="artifacty-react-source">${source}</script>
  <script src="/vendor/npm/react/umd/react.production.min.js"></script>
  <script src="/vendor/npm/react-dom/umd/react-dom.production.min.js"></script>
  <script src="/vendor/npm/@babel/standalone/babel.min.js"></script>
  <script>
    const rootElement = document.getElementById("root");
    function report() {
      const doc = document.documentElement;
      const body = document.body;
      const height = Math.max(doc.scrollHeight, doc.offsetHeight, body ? body.scrollHeight : 0, body ? body.offsetHeight : 0);
      parent.postMessage({ __artifactyHeight: height }, "*");
    }
    function showError(error) {
      rootElement.innerHTML = "";
      const pre = document.createElement("pre");
      pre.className = "error";
      pre.textContent = error && error.stack ? error.stack : String(error);
      rootElement.append(pre);
      report();
    }
    try {
      const source = JSON.parse(document.getElementById("artifacty-react-source").textContent);
      const transformed = Babel.transform(source, {
        filename: "artifact.jsx",
        presets: [
          ["typescript", { allExtensions: true, isTSX: true }],
          ["react", { runtime: "classic" }]
        ],
        plugins: ["transform-modules-commonjs"]
      }).code;
      const module = { exports: {} };
      const exports = module.exports;
      const require = function(name) {
        if (name === "react") return React;
        if (name === "react-dom") return ReactDOM;
        throw new Error("Unsupported import in React artifact: " + name);
      };
      new Function("React", "ReactDOM", "module", "exports", "require", transformed)(React, ReactDOM, module, exports, require);
      const Component = module.exports.default || exports.default || module.exports;
      if (typeof Component !== "function") {
        throw new Error("React artifact must export a component as default.");
      }
      if (ReactDOM.createRoot) {
        ReactDOM.createRoot(rootElement).render(React.createElement(Component, {}));
      } else {
        ReactDOM.render(React.createElement(Component, {}), rootElement);
      }
      window.addEventListener("resize", report);
      if (window.ResizeObserver) {
        try { new ResizeObserver(report).observe(document.documentElement); } catch (error) {}
      }
      setTimeout(report, 0);
      setTimeout(report, 250);
    } catch (error) {
      showError(error);
    }
  </script>
</body>
</html>`;
}

export function pageShell({ title, body, head = "", afterBody = "", locale = DEFAULT_LOCALE }) {
  return `<!doctype html>
<html lang="${escapeAttribute(locale)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${head}
  <style>
    :root {
      color-scheme: light dark;
      --bg: #eef1f5;
      --grid: rgba(31, 58, 99, 0.05);
      --panel: #ffffff;
      --panel-2: #f3f6f9;
      --text: #151b24;
      --muted: #586273;
      --faint: #828c9b;
      --line: #e0e5ec;
      --line-2: #cfd6df;
      --accent: #0e7490;
      --accent-2: #0b5e75;
      --accent-ink: #ffffff;
      --accent-soft: rgba(14, 116, 144, 0.10);
      --ring: rgba(14, 116, 144, 0.32);
      --code: #0e1320;
      --code-text: #e6edf3;
      --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif;
      --mono: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b0f14;
        --grid: rgba(120, 160, 200, 0.06);
        --panel: #12171f;
        --panel-2: #171d27;
        --text: #e6edf3;
        --muted: #9aa6b3;
        --faint: #6b7686;
        --line: #222a35;
        --line-2: #2d3744;
        --accent: #22b8cf;
        --accent-2: #3ccbdd;
        --accent-ink: #04161c;
        --accent-soft: rgba(34, 184, 207, 0.14);
        --ring: rgba(34, 184, 207, 0.40);
        --code: #080c12;
        --code-text: #e6edf3;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background-color: var(--bg);
      background-image:
        linear-gradient(var(--grid) 1px, transparent 1px),
        linear-gradient(90deg, var(--grid) 1px, transparent 1px);
      background-size: 28px 28px;
      background-position: center top;
      color: var(--text);
      font-family: var(--sans);
      line-height: 1.55;
      letter-spacing: 0;
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { color: var(--accent-2); text-decoration: underline; }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      padding: 15px 28px;
      border-bottom: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel) 86%, transparent);
      backdrop-filter: saturate(150%) blur(10px);
    }
    .topbar h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.25;
      letter-spacing: -0.01em;
    }
    .topbar p {
      margin: 5px 0 0;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      color: var(--text);
    }
    .brand:hover { text-decoration: none; }
    .brand-mark { display: inline-flex; color: var(--accent); }
    .brand-text { display: grid; gap: 2px; }
    .brand-name {
      font-family: var(--mono);
      font-size: 19px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .brand-tag {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .topbar nav {
      display: flex;
      align-items: center;
      gap: 3px;
      flex-wrap: wrap;
      font-family: var(--mono);
      font-size: 13px;
    }
    .topbar nav > a {
      padding: 5px 10px;
      border-radius: 7px;
      color: var(--muted);
    }
    .topbar nav > a:hover {
      background: var(--panel-2);
      color: var(--text);
      text-decoration: none;
    }
    .language-switcher {
      display: inline-flex;
      gap: 2px;
      margin-left: 5px;
      padding-left: 9px;
      border-left: 1px solid var(--line);
    }
    .language-switcher a,
    .language-switcher .active {
      padding: 5px 8px;
      border-radius: 7px;
    }
    .language-switcher .active {
      color: var(--text);
      font-weight: 700;
      text-decoration: none;
      cursor: default;
    }
    .dashboard,
    .artifact-view,
    .artifact-editor {
      width: min(1180px, calc(100vw - 32px));
      margin: 28px auto 72px;
    }
    .artifact-view-wide {
      width: min(1760px, calc(100vw - 24px));
    }
    .toolbar {
      font-family: var(--mono);
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--faint);
    }
    .toolbar,
    .filter-form,
    .diff-form,
    .meta-strip,
    .version-strip {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 12px;
      color: var(--muted);
      font-size: 13px;
    }
    .filter-form,
    .diff-form {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 12px;
      align-items: center;
    }
    .filter-form input,
    .filter-form select {
      min-width: 120px;
    }
    .dashboard-layout {
      display: flex;
      align-items: flex-start;
      gap: 24px;
      width: min(1180px, calc(100vw - 32px));
      margin: 28px auto 72px;
    }
    .dashboard-layout .dashboard {
      flex: 1;
      min-width: 0;
      width: auto;
      margin: 0;
    }
    .dashboard-sidebar {
      width: 240px;
      flex: none;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
      padding: 14px;
    }
    .dashboard-sidebar h2 {
      margin: 0 0 10px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--faint);
    }
    .saved-view-list {
      list-style: none;
      margin: 0 0 14px;
      padding: 0;
      display: grid;
      gap: 6px;
    }
    .saved-view-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
    }
    .saved-view-item a {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .saved-view-delete {
      margin: 0;
    }
    .saved-view-delete button {
      min-height: 0;
      padding: 2px 8px;
      font-size: 12px;
    }
    .saved-view-form {
      display: grid;
      gap: 8px;
    }
    .artifact-group-heading {
      margin: 0;
      padding: 10px 14px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--faint);
      background: var(--panel-2);
      border-bottom: 1px solid var(--line);
    }
    .checkbox-field {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 38px;
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }
    .checkbox-field input {
      width: auto;
      min-height: auto;
    }
    .inline-action {
      margin-bottom: 12px;
    }
    .nav-form {
      display: inline-flex;
      margin: 0;
    }
    .nav-form button {
      min-height: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      font-weight: inherit;
    }
    .nav-form button:hover {
      background: transparent;
      border: 0;
      color: var(--text);
      text-decoration: underline;
    }
    .diff-form {
      grid-template-columns: 160px 160px auto;
      width: fit-content;
    }
    .filter-form > a,
    .diff-form > a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 38px;
      padding: 0 14px;
      border: 1px solid var(--line-2);
      border-radius: 8px;
      background: var(--panel);
      color: var(--muted);
      font-size: 13px;
    }
    .filter-form > a:hover,
    .diff-form > a:hover {
      background: var(--panel-2);
      color: var(--text);
      text-decoration: none;
    }
    .artifact-list {
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
      background: var(--panel);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .pager {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 14px;
      font-family: var(--mono);
      font-size: 12.5px;
    }
    .pager a,
    .pager-disabled {
      display: inline-flex;
      min-height: 34px;
      align-items: center;
      justify-content: center;
      padding: 5px 12px;
      border: 1px solid var(--line-2);
      border-radius: 8px;
      background: var(--panel);
      color: var(--muted);
    }
    .pager a:hover {
      border-color: var(--accent);
      color: var(--text);
      text-decoration: none;
    }
    .pager-disabled {
      opacity: 0.55;
    }
    .editor-form {
      display: grid;
      gap: 16px;
    }
    .auth-panel {
      max-width: 720px;
      margin: 0 auto;
    }
    .auth-form .editor-fields {
      grid-template-columns: minmax(220px, 1fr);
    }
    .auth-error,
    .auth-success,
    .auth-warning,
    .token-once {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px 14px;
      background: var(--panel);
    }
    .auth-error {
      color: #991b1b;
      background: #fef2f2;
      border-color: #fecaca;
    }
    .auth-success {
      color: #166534;
      background: #f0fdf4;
      border-color: #bbf7d0;
    }
    .auth-warning {
      color: #92400e;
      background: #fffbeb;
      border-color: #fde68a;
    }
    .conflict-banner {
      display: grid;
      gap: 6px;
      color: #92400e;
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 16px;
    }
    .conflict-banner a {
      color: inherit;
      text-decoration: underline;
      width: fit-content;
    }
    .muted {
      color: var(--muted);
    }
    .meta-card {
      display: grid;
      gap: 10px;
      margin-bottom: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      background: var(--panel);
    }
    .meta-card h2,
    .token-once h2 {
      margin: 0;
      font-size: 18px;
    }
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .data-table th,
    .data-table td {
      padding: 9px 10px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: middle;
    }
    .data-table th {
      color: var(--faint);
      font-family: var(--mono);
      font-size: 11.5px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .data-table form {
      margin: 0;
    }
    .editor-fields {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 180px 180px minmax(160px, 240px);
      gap: 12px;
      align-items: end;
    }
    .field {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    .field > span {
      font-family: var(--mono);
      font-size: 11.5px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--faint);
    }
    .check-field {
      display: flex;
      gap: 8px;
      align-items: center;
      min-height: 38px;
      color: var(--muted);
      font-size: 13px;
    }
    .check-field input {
      width: auto;
      min-height: 0;
      padding: 0;
    }
    input,
    select,
    textarea {
      width: 100%;
      border: 1px solid var(--line-2);
      border-radius: 8px;
      background: var(--panel);
      color: var(--text);
      font: inherit;
      letter-spacing: 0;
    }
    input::placeholder,
    textarea::placeholder { color: var(--faint); }
    input,
    select {
      min-height: 38px;
      padding: 7px 10px;
    }
    textarea {
      min-height: 52vh;
      padding: 14px;
      resize: vertical;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 13px;
      line-height: 1.55;
      white-space: pre;
      overflow: auto;
    }
    .compact-textarea {
      min-height: 160px;
    }
    .textarea-enhanced {
      display: none;
    }
    .content-field {
      gap: 10px;
    }
    .codemirror-shell {
      min-height: 52vh;
    }
    .editor-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 38px;
      margin-top: 2px;
      color: var(--muted);
      font-size: 13px;
    }
    .editor-status {
      overflow-wrap: anywhere;
    }
    .secondary-button {
      border-color: var(--line-2);
      background: var(--panel);
      color: var(--text);
    }
    .secondary-button:hover {
      background: var(--panel-2);
      border-color: var(--accent);
    }
    .editor-preview {
      min-height: 160px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      overflow: auto;
    }
    .editor-preview:empty {
      display: none;
    }
    .editor-preview pre {
      margin: 0;
      padding: 16px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .editor-preview-frame {
      display: block;
      width: 100%;
      min-height: 38vh;
      border: 0;
      background: var(--panel);
    }
    input:focus,
    select:focus,
    textarea:focus {
      outline: 3px solid var(--ring);
      outline-offset: 0;
      border-color: var(--accent);
    }
    .editor-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
    }
    button {
      min-height: 38px;
      border: 1px solid var(--accent);
      border-radius: 8px;
      padding: 7px 15px;
      background: var(--accent);
      color: var(--accent-ink);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    button:hover { background: var(--accent-2); border-color: var(--accent-2); }
    .button-link {
      display: inline-flex;
      min-height: 38px;
      align-items: center;
      justify-content: center;
      padding: 7px 15px;
      border: 1px solid var(--accent);
      border-radius: 8px;
      background: var(--accent);
      color: var(--accent-ink);
      font-weight: 600;
    }
    .button-link:hover {
      border-color: var(--accent-2);
      background: var(--accent-2);
      color: var(--accent-ink);
      text-decoration: none;
    }
    .inline-action button {
      min-height: 32px;
      padding: 5px 12px;
      font-family: var(--mono);
      font-size: 12px;
      font-weight: 500;
      border-color: var(--line-2);
      background: var(--panel);
      color: var(--muted);
    }
    .inline-action button:hover {
      background: var(--panel-2);
      border-color: var(--accent);
      color: var(--text);
    }
    .artifact-row {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 110px minmax(140px, 200px) 110px 84px 56px minmax(100px, 180px);
      gap: 12px;
      align-items: center;
      min-height: 64px;
      padding: 14px 18px;
      color: var(--text);
      border-bottom: 1px solid var(--line);
      box-shadow: inset 3px 0 0 transparent;
      transition: background 0.12s ease, box-shadow 0.12s ease;
    }
    .artifact-row:last-child { border-bottom: 0; }
    .artifact-row:hover {
      background: var(--panel-2);
      box-shadow: inset 3px 0 0 var(--accent);
      text-decoration: none;
    }
    .row-main {
      display: grid;
      gap: 3px;
      min-width: 0;
    }
    .row-main strong {
      font-size: 14.5px;
      letter-spacing: -0.005em;
    }
    .row-main strong,
    .row-main span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-main span {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--faint);
    }
    .row-main .row-snippet {
      color: var(--muted);
      white-space: normal;
      overflow: visible;
      text-overflow: clip;
      overflow-wrap: anywhere;
    }
    .artifact-row > span:not(.row-main):not(.tags):not(.badge) {
      font-family: var(--mono);
      font-size: 12.5px;
      color: var(--muted);
    }
    .artifact-row .publisher-cell {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text);
    }
    .empty {
      color: var(--muted);
      font-size: 13px;
    }
    .tags {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .tag {
      padding: 2px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--panel-2);
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11.5px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--bh, var(--muted)) 38%, var(--line));
      background: color-mix(in srgb, var(--bh, var(--muted)) 13%, transparent);
      color: color-mix(in srgb, var(--bh, var(--muted)) 62%, var(--text));
      font-family: var(--mono);
      font-size: 11.5px;
      line-height: 1.45;
      white-space: nowrap;
    }
    .badge.t-document { --bh: #5b6b7f; }
    .badge.t-html-page { --bh: #e0795b; }
    .badge.t-handoff { --bh: #a855f7; }
    .badge.t-code-review { --bh: #2dab76; }
    .badge.t-test-report { --bh: #d99a2b; }
    .badge.t-dashboard { --bh: #3b82f6; }
    .badge.t-design-option { --bh: #ec4899; }
    .badge.t-diff-walkthrough { --bh: #14b8a6; }
    .badge.t-bundle { --bh: #8a8d98; }
    .badge.t-asset { --bh: #f59e0b; }
    .badge.t-diagram { --bh: #0ea5e9; }
    .badge.t-component { --bh: #7c3aed; }
    .badge.t-snippet { --bh: #64748b; }
    .badge.t-analysis-report { --bh: #dc2626; }
    .badge.t-table { --bh: #0891b2; }
    .badge.t-unknown { --bh: #94a3b8; }
    .badge.f-html { --bh: #e0795b; }
    .badge.f-markdown { --bh: #3b82f6; }
    .badge.f-text { --bh: #5b6b7f; }
    .badge.f-json { --bh: #16a34a; }
    .badge.f-code { --bh: #64748b; }
    .badge.f-svg { --bh: #0ea5e9; }
    .badge.f-mermaid { --bh: #14b8a6; }
    .badge.f-react { --bh: #7c3aed; }
    .badge.f-sarif { --bh: #dc2626; }
    .badge.f-csv { --bh: #0891b2; }
    .badge.f-image { --bh: #f59e0b; }
    .badge.f-video { --bh: #db2777; }
    .badge.s-archived { --bh: #94a3b8; }
    .badge.v-private { --bh: #b91c1c; }
    .empty {
      padding: 28px;
    }
    .meta-strip {
      padding: 0;
      gap: 8px;
    }
    .meta-strip > span:not(.badge) {
      padding: 4px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--panel);
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
    }
    .version-strip {
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel);
    }
    .version {
      display: inline-flex;
      min-width: 36px;
      min-height: 28px;
      align-items: center;
      justify-content: center;
      padding: 3px 9px;
      border: 1px solid var(--line-2);
      border-radius: 7px;
      background: var(--panel-2);
      color: var(--muted);
      font-family: var(--mono);
      font-size: 12.5px;
    }
    .version:hover {
      border-color: var(--accent);
      color: var(--text);
      text-decoration: none;
    }
    .version.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 600;
    }
    .artifact-frame {
      display: block;
      width: 100%;
      min-height: 320px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .split-preview {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 12px;
    }
    .split-preview .artifact-frame {
      min-height: 45vh;
    }
    .diff-table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: var(--panel);
      font-size: 13px;
    }
    .diff-table th,
    .diff-table td {
      padding: 5px 8px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    .diff-table th {
      color: var(--muted);
      text-align: left;
      font-family: var(--mono);
      background: var(--panel-2);
    }
    .diff-table td:first-child,
    .diff-table td:nth-child(2) {
      width: 62px;
      color: var(--muted);
      text-align: right;
      user-select: none;
    }
    .diff-added { background: color-mix(in srgb, #2ea043 16%, transparent); }
    .diff-removed { background: color-mix(in srgb, #f85149 15%, transparent); }
    .diff-changed { background: color-mix(in srgb, #d29922 16%, transparent); }
    .diff-table code {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .diff-view-toggle {
      font-size: 13px;
      color: var(--muted);
      margin: 4px 0 12px;
    }
    .diff-summary {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
      margin: 0 0 6px;
    }
    .diff-truncated-note {
      font-size: 12px;
      color: var(--muted);
      margin: 0 0 6px;
    }
    .structured-diff-table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: var(--panel);
      font-size: 13px;
    }
    .structured-diff-table th,
    .structured-diff-table td {
      padding: 5px 8px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    .structured-diff-table th {
      color: var(--muted);
      text-align: left;
      font-family: var(--mono);
      background: var(--panel-2);
    }
    .diff-word-removed {
      background: color-mix(in srgb, #f85149 35%, transparent);
      text-decoration: line-through;
    }
    .diff-word-added {
      background: color-mix(in srgb, #2ea043 35%, transparent);
    }
    .artifact-doc,
    .artifact-code {
      margin: 0;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
    }
    .artifact-doc {
      padding: 32px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .artifact-doc h1,
    .artifact-doc h2,
    .artifact-doc h3 {
      line-height: 1.25;
      letter-spacing: -0.01em;
    }
    .artifact-doc :not(pre) > code {
      padding: 1px 6px;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: var(--panel-2);
      font-size: 0.88em;
    }
    .artifact-doc pre {
      margin: 16px 0;
      padding: 16px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--code);
      color: var(--code-text);
    }
    .artifact-doc pre code {
      padding: 0;
      border: 0;
      background: none;
      font-size: 0.92em;
    }
    .artifact-doc-codemirror {
      margin: 16px 0;
      border: 1px solid var(--line);
      border-radius: 10px;
      overflow: hidden;
    }
    .artifact-doc-codemirror .cm-editor {
      background: var(--code);
      color: var(--code-text);
    }
    .artifact-doc-codemirror .cm-scroller {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 13px;
      line-height: 1.55;
    }
    .task-list-item {
      list-style: none;
      margin-left: -20px;
    }
    .task-list-item label {
      display: inline-flex;
      align-items: baseline;
      gap: 8px;
    }
    .artifact-mermaid-embed {
      margin: 16px 0;
    }
    .artifact-mermaid-embed .artifact-frame {
      width: 100%;
      height: 240px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
    }
    .artifact-mermaid-capped {
      margin: 16px 0;
    }
    .artifact-mermaid-notice,
    .artifact-notebook-notice,
    .artifact-notebook-output-placeholder,
    .artifact-notebook-output-truncated {
      margin: 0 0 8px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--muted);
      font-size: 13px;
    }
    .artifact-notebook-cell {
      margin: 0 0 24px;
    }
    .artifact-notebook-cell:last-child {
      margin-bottom: 0;
    }
    .artifact-notebook-cell-code {
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
    }
    .artifact-notebook-execcount {
      margin-bottom: 6px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 12px;
    }
    .artifact-notebook-output {
      margin-top: 12px;
    }
    .artifact-notebook-output.artifact-code {
      min-height: unset;
    }
    .artifact-notebook-error code {
      color: #dc2626;
    }
    .artifact-table-scroll {
      width: 100%;
      margin: 20px 0;
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--bg);
    }
    .artifact-table {
      width: 100%;
      min-width: max-content;
      border-collapse: collapse;
      font-size: 14px;
      line-height: 1.45;
    }
    .artifact-table th,
    .artifact-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      border-right: 1px solid var(--line);
      vertical-align: top;
      text-align: left;
      white-space: normal;
    }
    .artifact-table th:last-child,
    .artifact-table td:last-child {
      border-right: 0;
    }
    .artifact-table tbody tr:last-child td {
      border-bottom: 0;
    }
    .artifact-table th {
      background: var(--panel-2);
      color: var(--text);
      font-weight: 650;
    }
    .artifact-table .align-center { text-align: center; }
    .artifact-table .align-right { text-align: right; }
    .artifact-csv,
    .artifact-sarif {
      display: grid;
      gap: 14px;
    }
    .artifact-csv-note,
    .artifact-sarif-note {
      margin: 0;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--muted);
      font-size: 13px;
    }
    .artifact-summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 10px;
    }
    .summary-card {
      display: grid;
      gap: 3px;
      min-height: 72px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    .summary-card span {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11.5px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .summary-card strong {
      font-size: 20px;
      line-height: 1.2;
    }
    .sarif-level {
      display: inline-flex;
      min-width: 68px;
      justify-content: center;
      padding: 2px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--bh, var(--muted)) 14%, transparent);
      color: color-mix(in srgb, var(--bh, var(--muted)) 70%, var(--text));
      font-family: var(--mono);
      font-size: 12px;
    }
    .sarif-level.error { --bh: #dc2626; }
    .sarif-level.warning { --bh: #d97706; }
    .sarif-level.note { --bh: #2563eb; }
    .sarif-level.none { --bh: #64748b; }
    .csv-sort-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: none;
      background: none;
      color: inherit;
      font: inherit;
      font-weight: inherit;
      cursor: pointer;
      padding: 0;
    }
    .csv-sort-btn:hover,
    .csv-sort-btn:focus-visible {
      text-decoration: underline;
    }
    .csv-sort-indicator {
      font-size: 10px;
      color: var(--accent);
    }
    .csv-filter-row th {
      padding: 4px 8px;
      background: var(--panel-2);
    }
    .csv-filter-input,
    .sarif-rule-filter {
      width: 100%;
      box-sizing: border-box;
      padding: 4px 6px;
      border: 1px solid var(--line-2);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      font: inherit;
      font-size: 12px;
    }
    .sarif-controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
    }
    .sarif-level-chips {
      display: flex;
      gap: 6px;
    }
    .sarif-chip {
      border: 1px solid var(--line-2);
      background: var(--panel);
      color: var(--muted);
      border-radius: 999px;
      padding: 3px 10px;
      font-family: var(--mono);
      font-size: 12px;
      cursor: pointer;
    }
    .sarif-chip.active {
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      border-color: var(--accent);
      color: var(--accent-2);
    }
    .sarif-rule-filter {
      max-width: 220px;
    }
    .artifact-csv-status,
    .artifact-sarif-status {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
    }
    .artifact-raw-details {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
      overflow: hidden;
    }
    .artifact-raw-details summary {
      padding: 10px 14px;
      cursor: pointer;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 12.5px;
    }
    .artifact-raw-details .artifact-code {
      border: 0;
      border-top: 1px solid var(--line);
      border-radius: 0;
    }
    .artifact-media {
      display: grid;
      gap: 12px;
      margin: 0;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .artifact-media img,
    .artifact-media video {
      display: block;
      width: 100%;
      max-height: 76vh;
      object-fit: contain;
      border-radius: 8px;
      background: var(--panel-2);
    }
    .artifact-media figcaption,
    .artifact-media-note {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 12.5px;
      overflow-wrap: anywhere;
    }
    .artifact-code {
      padding: 22px;
      overflow: auto;
      color: var(--code-text);
      background: var(--code);
      min-height: 50vh;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .artifact-code-viewer {
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
      background: var(--code);
    }
    .artifact-code-viewer .cm-editor {
      min-height: 50vh;
      background: var(--code);
      color: var(--code-text);
    }
    .artifact-code-viewer .cm-scroller {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 13px;
      line-height: 1.55;
    }
    .artifact-code-viewer .cm-gutters {
      background: color-mix(in srgb, var(--code) 84%, white);
      color: var(--muted);
      border-color: rgba(255, 255, 255, 0.08);
    }
    .artifact-react-disabled {
      display: grid;
      gap: 12px;
    }
    .artifact-react-disabled > p {
      margin: 0;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      color: var(--muted);
    }
    code,
    pre {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 13px;
    }
    @media (max-width: 760px) {
      .topbar {
        align-items: flex-start;
        flex-direction: column;
        padding: 20px;
      }
      .artifact-row {
        grid-template-columns: 1fr;
        gap: 6px;
      }
      .editor-fields {
        grid-template-columns: 1fr;
      }
      .filter-form,
      .diff-form,
      .split-preview {
        grid-template-columns: 1fr;
        width: 100%;
      }
      .row-main strong,
      .row-main span {
        white-space: normal;
      }
      .artifact-doc {
        padding: 18px;
      }
    }
  </style>
</head>
<body>
  ${body}
  ${afterBody}
</body>
</html>`;
}

function formatSelect(selected) {
  return `<select name="format">
    ${ARTIFACT_FORMATS.map((format) => {
      const label = format[0].toUpperCase() + format.slice(1);
      return `<option value="${format}"${format === selected ? " selected" : ""}>${label}</option>`;
    }).join("")}
  </select>`;
}

function artifactTypeSelect(selected) {
  return `<select name="artifactType">
    ${artifactTypeOptions(selected)}
  </select>`;
}

function visibilitySelect(selected, view) {
  return `<select name="visibility">
    ${VISIBILITY_VALUES.map((value) => `<option value="${value}"${value === selected ? " selected" : ""}>${view.text(`artifact.visibility.${value}`)}</option>`).join("")}
  </select>`;
}

function diffPrefix(type) {
  if (type === "added") {
    return "+ ";
  }
  if (type === "removed") {
    return "- ";
  }
  return "  ";
}

function hiddenToken(authToken) {
  return authToken ? `<input type="hidden" name="_token" value="${escapeAttribute(authToken)}">` : "";
}

function editorHead() {
  return `<script type="importmap">${editorImportMapJson()}</script>`;
}

function editorScript(locale) {
  const config = JSON.stringify(editorMessages(locale)).replaceAll("<", "\\u003c");
  return `<script>window.ARTIFACTY_I18N=${config};</script><script type="module" src="${EDITOR_CLIENT_PATH}"></script>`;
}

function viewContext(locale, currentPath) {
  const i18n = createI18n(locale);
  return {
    locale: i18n.locale,
    currentPath,
    href(href) {
      return localizedHref(href, i18n.locale);
    },
    raw(key, params = {}) {
      return i18n.t(key, params);
    },
    text(key, params = {}) {
      return escapeHtml(i18n.t(key, params));
    },
    attr(key, params = {}) {
      return escapeAttribute(i18n.t(key, params));
    }
  };
}

function localeInput(locale) {
  return `<input type="hidden" name="lang" value="${escapeAttribute(locale)}">`;
}

function brandMark() {
  return `<span class="brand-mark" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none">
    <path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M8 16.5 12 7.5l4 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M9.7 13.3h4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  </svg></span>`;
}

function typeBadge(value) {
  const type = String(value || "document");
  const slug = type.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `<span class="badge t-${escapeAttribute(slug)}">${escapeHtml(type)}</span>`;
}

function formatBadge(value) {
  const format = String(value || "text");
  const slug = format.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `<span class="badge f-${escapeAttribute(slug)}">${escapeHtml(format)}</span>`;
}

function publisherDisplay(artifact, view) {
  return artifact.publisherId || artifact.publisherName || view.text("artifact.publisherUnknown");
}

function publisherTitle(artifact, view) {
  const id = artifact.publisherId || "";
  const name = artifact.publisherName || "";
  if (id && name && id !== name) {
    return `${name} <${id}>`;
  }
  return id || name || view.text("artifact.publisherUnknown");
}

function statusBadge(label) {
  return `<span class="badge s-archived">${label}</span>`;
}

// Only rendered for 'private' artifacts (the non-default visibility) so the
// common case doesn't add visual noise to every row.
function visibilityBadge(artifact, view) {
  if ((artifact.visibility || "team") !== "private") {
    return "";
  }
  return `<span class="badge v-private">${view.text("artifact.visibility.private")}</span>`;
}

function htmlFrameContent(content) {
  const reporter = `<script>(function(){function report(){var doc=document.documentElement;var body=document.body;var height=Math.max(doc.scrollHeight,doc.offsetHeight,body?body.scrollHeight:0,body?body.offsetHeight:0);parent.postMessage({__artifactyHeight:height},"*");}window.addEventListener("load",report);window.addEventListener("resize",report);if(window.ResizeObserver){try{new ResizeObserver(report).observe(document.documentElement);}catch(error){}}var ticks=0;var timer=setInterval(function(){report();if(++ticks>8){clearInterval(timer);}},250);report();})();</script>`;
  if (content.includes("</body>")) {
    return content.replace("</body>", `${reporter}</body>`);
  }
  return `${content}${reporter}`;
}

function svgFrameContent(content) {
  const sanitized = sanitizeSvg(content);
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;min-height:100%;background:#fff;}body{display:grid;place-items:center;padding:16px;box-sizing:border-box;}svg{max-width:100%;height:auto;}</style></head><body>${sanitized}</body></html>`;
}

function mermaidFrameContent(content) {
  const source = jsonForScript(content);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; min-height: 100%; background: #fff; color: #111827; }
    body { padding: 16px; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #artifacty-mermaid { display: grid; place-items: center; min-height: 240px; }
    #artifacty-mermaid svg { max-width: 100%; height: auto; }
    .error { white-space: pre-wrap; color: #991b1b; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px; }
  </style>
</head>
<body>
  <div id="artifacty-mermaid"></div>
  <script type="application/json" id="artifacty-mermaid-source">${source}</script>
  <script type="module">
    import mermaid from "/vendor/npm/mermaid/dist/mermaid.esm.min.mjs";
    const source = JSON.parse(document.getElementById("artifacty-mermaid-source").textContent);
    const target = document.getElementById("artifacty-mermaid");
    function report() {
      const doc = document.documentElement;
      const body = document.body;
      const height = Math.max(doc.scrollHeight, doc.offsetHeight, body ? body.scrollHeight : 0, body ? body.offsetHeight : 0);
      parent.postMessage({ __artifactyHeight: height }, "*");
    }
    try {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      const result = await mermaid.render("artifacty-mermaid-svg", source);
      target.innerHTML = result.svg;
    } catch (error) {
      target.innerHTML = "";
      const pre = document.createElement("pre");
      pre.className = "error";
      pre.textContent = error && error.message ? error.message : String(error);
      target.append(pre);
    }
    window.addEventListener("resize", report);
    if (window.ResizeObserver) {
      try { new ResizeObserver(report).observe(document.documentElement); } catch (error) {}
    }
    report();
    setTimeout(report, 250);
  </script>
</body>
</html>`;
}

function sanitizeSvg(content) {
  return String(content || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/\s(?:href|xlink:href)\s*=\s*"javascript:[^"]*"/gi, "")
    .replace(/\s(?:href|xlink:href)\s*=\s*'javascript:[^']*'/gi, "")
    .replace(/\s(?:href|xlink:href)\s*=\s*javascript:[^\s>]+/gi, "");
}

function jsonForScript(value) {
  return JSON.stringify(String(value || ""))
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\\u2028", "\\\\u2028")
    .replaceAll("\\u2029", "\\\\u2029");
}

// Handles resize messages from any number of same-page sandboxed frames
// (the single whole-document HTML/SVG/Mermaid/React frame, plus any number
// of lazily created per-fence Mermaid frames embedded in Markdown and
// notebook cells), matching each message to its source frame by
// contentWindow rather than assuming a single frame exists up front.
function frameResizeScript() {
  return `<script>(function(){window.addEventListener("message",function(event){var data=event.data;if(!data||typeof data.__artifactyHeight!=="number"){return;}var frames=document.querySelectorAll(".artifact-frame");for(var i=0;i<frames.length;i+=1){if(frames[i].contentWindow===event.source){var height=Math.min(Math.max(Math.ceil(data.__artifactyHeight),200),200000);frames[i].style.height=height+"px";break;}}});})();</script>`;
}

function viewerScript() {
  return `<script type="module" src="${VIEWER_CLIENT_PATH}"></script>`;
}

function reactRendererEnabled() {
  return process.env.ARTIFACTY_ENABLE_REACT_RENDERER === "true";
}

function languageSwitcher(view) {
  const english = view.locale === "en"
    ? `<span class="active">${view.text("language.english")}</span>`
    : `<a href="${switchLocaleHref(view.currentPath, "en")}">${view.text("language.english")}</a>`;
  const korean = view.locale === "ko"
    ? `<span class="active">${view.text("language.korean")}</span>`
    : `<a href="${switchLocaleHref(view.currentPath, "ko")}">${view.text("language.korean")}</a>`;
  return `<span class="language-switcher">${english}${korean}</span>`;
}

function authNav(user) {
  if (!user) {
    return `<a href="/login">Sign in</a>`;
  }
  return `${user.role === "admin" ? `<a href="/admin/users">Users</a><a href="/admin/backup">Backup</a>` : ""}<a href="/account">Account</a>`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("\n", "&#10;");
}

// Section 14: fenced code blocks keep server-rendered escaped
// `<pre><code class="language-x">` output (viewer.js applies read-only
// CodeMirror highlighting client-side on top of that markup, so the no-JS
// output stays correct on its own). ```mermaid``` fences render through the
// same sandboxed iframe mechanism as whole-document Mermaid artifacts, one
// lazily-created iframe per diagram, capped per document by
// mermaidDiagramState()/ARTIFACTY_MAX_INLINE_DIAGRAMS. Task list items
// render as disabled checkboxes; tables already render inside a horizontally
// scrolling container via renderMarkdownTable.
function markdownToHtml(markdown, diagramState = createMermaidDiagramState()) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const html = [];
  let inCode = false;
  let codeLang = "";
  let codeBuffer = [];
  let inList = false;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };
  const closeCodeFence = () => {
    html.push(renderMarkdownCodeFence(codeBuffer.join("\n"), codeLang, diagramState));
    inCode = false;
    codeLang = "";
    codeBuffer = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("```")) {
      flushParagraph();
      closeList();
      if (inCode) {
        closeCodeFence();
      } else {
        inCode = true;
        const langToken = line.slice(3).trim();
        codeLang = /^[a-zA-Z0-9+#_.-]+$/.test(langToken) ? langToken.toLowerCase() : "";
        codeBuffer = [];
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      flushParagraph();
      closeList();
      const { html: tableHtml, nextIndex } = renderMarkdownTable(lines, index);
      html.push(tableHtml);
      index = nextIndex;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const taskItem = /^[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (taskItem) {
      flushParagraph();
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      const checked = taskItem[1].toLowerCase() === "x";
      html.push(`<li class="task-list-item"><label><input type="checkbox" disabled${checked ? " checked" : ""}> ${inlineMarkdown(taskItem[2])}</label></li>`);
      continue;
    }

    const listItem = /^[-*]\s+(.+)$/.exec(line);
    if (listItem) {
      flushParagraph();
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(listItem[1])}</li>`);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  closeList();
  if (inCode) {
    closeCodeFence();
  }
  return html.join("\n");
}

function renderMarkdownCodeFence(source, lang, diagramState) {
  if (lang === "mermaid") {
    return renderMermaidEmbed(source, diagramState);
  }
  const classAttribute = lang ? ` class="language-${escapeAttribute(lang)}"` : "";
  return `<pre><code${classAttribute}>${escapeHtml(source)}</code></pre>`;
}

// ARTIFACTY_MAX_INLINE_DIAGRAMS caps the number of Mermaid fences per
// Markdown/notebook document that get a live sandboxed iframe; any fence
// beyond the cap stays as escaped source with a notice instead, enforced
// server-side before the page is ever sent to a browser.
const DEFAULT_MAX_INLINE_DIAGRAMS = 20;

function mermaidDiagramCap() {
  const parsed = Number.parseInt(process.env.ARTIFACTY_MAX_INLINE_DIAGRAMS, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_INLINE_DIAGRAMS;
}

function createMermaidDiagramState() {
  return { count: 0, cap: mermaidDiagramCap() };
}

// Renders a placeholder that viewer.js lazily upgrades into a sandboxed
// Mermaid iframe (one per diagram) using IntersectionObserver, keeping the
// no-JS/no-op fallback as the escaped Mermaid source in a <noscript> block.
function renderMermaidEmbed(source, diagramState) {
  diagramState.count += 1;
  if (diagramState.count > diagramState.cap) {
    return `<section class="artifact-mermaid-capped">
      <p class="artifact-mermaid-notice">Inline diagram limit reached (${diagramState.cap}). Showing Mermaid source instead.</p>
      <pre><code class="language-mermaid">${escapeHtml(source)}</code></pre>
    </section>`;
  }
  const srcdocBase64 = Buffer.from(mermaidFrameContent(source), "utf8").toString("base64");
  return `<div class="artifact-mermaid-embed" data-artifacty-mermaid data-mermaid-srcdoc="${srcdocBase64}">
    <noscript><pre><code class="language-mermaid">${escapeHtml(source)}</code></pre></noscript>
  </div>`;
}

function inlineMarkdown(value) {
  return escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function isMarkdownTableStart(lines, index) {
  return isMarkdownTableRow(lines[index]) && isMarkdownTableSeparator(lines[index + 1]);
}

function renderMarkdownTable(lines, startIndex) {
  const headers = splitMarkdownTableRow(lines[startIndex]);
  const alignments = splitMarkdownTableRow(lines[startIndex + 1]).map(tableAlignment);
  const rows = [];
  let index = startIndex + 2;

  for (; index < lines.length; index += 1) {
    if (!isMarkdownTableRow(lines[index])) {
      break;
    }
    rows.push(splitMarkdownTableRow(lines[index]));
  }

  const headerHtml = headers.map((cell, cellIndex) =>
    `<th${alignmentAttribute(alignments[cellIndex])}>${inlineMarkdown(cell)}</th>`
  ).join("");
  const bodyHtml = rows.map((row) => `<tr>${headers.map((_, cellIndex) => {
    const alignment = alignments[cellIndex];
    return `<td${alignmentAttribute(alignment)}>${inlineMarkdown(row[cellIndex] || "")}</td>`;
  }).join("")}</tr>`).join("\n");

  return {
    html: `<div class="artifact-table-scroll"><table class="artifact-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
    nextIndex: index - 1
  };
}

function isMarkdownTableRow(line = "") {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isMarkdownTableSeparator(line = "") {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitMarkdownTableRow(line = "") {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function tableAlignment(cell = "") {
  const trimmed = cell.trim();
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) {
    return "center";
  }
  if (trimmed.endsWith(":")) {
    return "right";
  }
  return "left";
}

function alignmentAttribute(alignment) {
  return alignment ? ` class="align-${alignment}"` : "";
}

const CSV_RENDER_ROW_LIMIT = 1000;
const CSV_RENDER_COLUMN_LIMIT = 80;
const SARIF_RENDER_RESULT_LIMIT = 500;

function renderMediaArtifact(format, content, metadata = {}, options = {}) {
  const mimeType = mediaMimeType(metadata, format);
  const source = options.rawUrl || mediaDataUrl(content, mimeType);
  if (!source) {
    return `<section class="artifact-media-note">
      Media preview is unavailable because this artifact does not contain valid base64 media content.
    </section>
    <pre class="artifact-code"><code>${escapeHtml(content)}</code></pre>`;
  }

  const label = [
    mimeType || format,
    metadata.encoding ? `encoding: ${metadata.encoding}` : "",
    metadata.originalEncoding ? `source: ${metadata.originalEncoding}` : ""
  ].filter(Boolean).join(" · ");

  if (format === "video") {
    return `<figure class="artifact-media artifact-video">
      <video controls preload="metadata" src="${escapeAttribute(source)}"></video>
      <figcaption>${escapeHtml(label || "video artifact")}</figcaption>
    </figure>`;
  }

  return `<figure class="artifact-media artifact-image">
    <img src="${escapeAttribute(source)}" alt="Image artifact">
    <figcaption>${escapeHtml(label || "image artifact")}</figcaption>
  </figure>`;
}

function mediaMimeType(metadata = {}, format) {
  const explicit = String(metadata.mimeType || "").toLowerCase();
  if (explicit.startsWith("image/") || explicit.startsWith("video/")) {
    return explicit;
  }
  return format === "video" ? "video/mp4" : "image/png";
}

function mediaDataUrl(content, mimeType) {
  const value = String(content || "").trim();
  if (/^data:[^;,]+;base64,/i.test(value)) {
    return value;
  }
  const base64 = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return "";
  }
  return `data:${mimeType};base64,${base64}`;
}

function renderCsv(content) {
  const parsed = parseCsv(content);
  if (!parsed.ok) {
    return `<section class="artifact-csv">
      <p class="artifact-csv-note">CSV parsing failed: ${escapeHtml(parsed.error)}. Showing escaped source.</p>
      <pre class="artifact-code"><code>${escapeHtml(content)}</code></pre>
    </section>`;
  }

  if (parsed.rows.length === 0) {
    return `<section class="artifact-csv"><p class="artifact-csv-note">Empty CSV artifact.</p></section>`;
  }

  const columnCount = Math.max(...parsed.rows.map((row) => row.length));
  const visibleColumns = Math.min(columnCount, CSV_RENDER_COLUMN_LIMIT);
  const header = parsed.rows[0];
  const bodyRows = parsed.rows.slice(1, CSV_RENDER_ROW_LIMIT + 1);
  const rowTruncated = parsed.rows.length - 1 > CSV_RENDER_ROW_LIMIT;
  const columnTruncated = columnCount > CSV_RENDER_COLUMN_LIMIT;
  const headerHtml = Array.from({ length: visibleColumns }, (_, index) =>
    `<th data-csv-col="${index}">${escapeHtml(header[index] || `Column ${index + 1}`)}</th>`
  ).join("");
  const bodyHtml = bodyRows.map((row) =>
    `<tr data-csv-row>${Array.from({ length: visibleColumns }, (_, index) =>
      `<td>${escapeHtml(row[index] || "")}</td>`
    ).join("")}</tr>`
  ).join("\n");
  const notes = [
    `${parsed.rows.length - 1} data rows`,
    `${columnCount} columns`,
    rowTruncated ? `showing first ${CSV_RENDER_ROW_LIMIT} rows` : "",
    columnTruncated ? `showing first ${CSV_RENDER_COLUMN_LIMIT} columns` : ""
  ].filter(Boolean).join(" · ");

  return `<section class="artifact-csv" data-artifact-csv>
    <p class="artifact-csv-note">${escapeHtml(notes)}</p>
    <div class="artifact-table-scroll">
      <table class="artifact-table" data-csv-table>
        <thead><tr>${headerHtml}</tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>
  </section>`;
}

function renderSarif(content) {
  let sarif;
  try {
    sarif = JSON.parse(content);
  } catch {
    return `<section class="artifact-sarif">
      <p class="artifact-sarif-note">Invalid SARIF JSON. Showing escaped source.</p>
      <pre class="artifact-code"><code>${escapeHtml(content)}</code></pre>
    </section>`;
  }

  if (!isSarifDocument(sarif)) {
    return `<section class="artifact-sarif">
      <p class="artifact-sarif-note">This JSON does not match the expected SARIF top-level shape. Showing formatted JSON.</p>
      <pre class="artifact-code"><code>${escapeHtml(formatJson(content))}</code></pre>
    </section>`;
  }

  const results = collectSarifResults(sarif);
  const counts = countBy(results, (result) => result.level);
  const visibleResults = results.slice(0, SARIF_RENDER_RESULT_LIMIT);
  const rowHtml = visibleResults.map((result) => `<tr data-sarif-result data-level="${escapeAttribute(result.level)}" data-rule="${escapeAttribute(result.ruleId)}" data-location="${escapeAttribute(result.location)}">
    <td><span class="sarif-level ${escapeAttribute(result.level)}">${escapeHtml(result.level)}</span></td>
    <td>${escapeHtml(result.ruleId)}</td>
    <td>${escapeHtml(result.message)}</td>
    <td>${escapeHtml(result.location)}</td>
    <td>${escapeHtml(result.tool)}</td>
  </tr>`).join("\n");
  const note = results.length > SARIF_RENDER_RESULT_LIMIT
    ? `Showing first ${SARIF_RENDER_RESULT_LIMIT} of ${results.length} results.`
    : `${results.length} results.`;

  return `<section class="artifact-sarif" data-artifact-sarif>
    <div class="artifact-summary-grid">
      ${summaryCard("Runs", sarif.runs.length)}
      ${summaryCard("Results", results.length)}
      ${summaryCard("Errors", counts.error || 0)}
      ${summaryCard("Warnings", counts.warning || 0)}
      ${summaryCard("Notes", counts.note || 0)}
    </div>
    <p class="artifact-sarif-note">${escapeHtml(note)}</p>
    <div class="artifact-table-scroll">
      <table class="artifact-table" data-sarif-table>
        <thead><tr><th data-sarif-sort="level">Level</th><th data-sarif-sort="rule">Rule</th><th>Message</th><th data-sarif-sort="location">Location</th><th>Tool</th></tr></thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </div>
    <details class="artifact-raw-details">
      <summary>Raw SARIF JSON</summary>
      <pre class="artifact-code"><code>${escapeHtml(formatJson(content))}</code></pre>
    </details>
  </section>`;
}

function collectSarifResults(sarif) {
  return sarif.runs.flatMap((run) => {
    const tool = run?.tool?.driver?.name || run?.tool?.driver?.fullName || "unknown";
    const { rulesById, rulesByIndex } = rulesMapsForRun(run);
    return (run?.results || []).map((result) => {
      const rule = rulesById.get(result.ruleId) || rulesByIndex.get(result.ruleIndex);
      return {
        level: sarifResultLevel(result, rulesById, rulesByIndex),
        ruleId: sarifResultRuleId(result, rulesById, rulesByIndex),
        message: sarifMessage(result.message) || sarifMessage(rule?.shortDescription) || sarifMessage(rule?.fullDescription) || "",
        location: sarifLocation(result),
        tool
      };
    });
  });
}

function sarifMessage(message) {
  if (!message || typeof message !== "object") {
    return "";
  }
  return String(message.text || message.markdown || "").trim();
}

function sarifLocation(result) {
  const physical = result?.locations?.[0]?.physicalLocation;
  const uri = physical?.artifactLocation?.uri || physical?.artifactLocation?.uriBaseId || "";
  const region = physical?.region || {};
  const line = Number.isInteger(region.startLine) ? region.startLine : "";
  const column = Number.isInteger(region.startColumn) ? region.startColumn : "";
  return [
    uri || "unknown",
    line ? `:${line}` : "",
    column ? `:${column}` : ""
  ].join("");
}

function countBy(values, keyFn) {
  return values.reduce((counts, value) => {
    const key = keyFn(value);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function summaryCard(label, value) {
  return `<div class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function formatJson(content) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

// --- Notebook format (roadmap section 15) ----------------------------------
//
// The stored content is always the original notebook JSON; this only
// normalizes it for rendering. Parse failures fail closed to formatted JSON
// so a malformed .ipynb never breaks the page.

const NOTEBOOK_MAX_RENDERED_CELLS = 500;
const NOTEBOOK_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const NOTEBOOK_MAX_OUTPUTS_PER_CELL = 200;
const NOTEBOOK_OUTPUT_MIME_PRIORITY = [
  "text/html",
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "text/markdown",
  "text/plain"
];

function renderNotebook(content) {
  let notebook;
  try {
    notebook = JSON.parse(content);
  } catch {
    return `<pre class="artifact-code"><code>${escapeHtml(formatJson(content))}</code></pre>`;
  }
  if (!isNotebookObject(notebook)) {
    return `<pre class="artifact-code"><code>${escapeHtml(formatJson(content))}</code></pre>`;
  }

  const language = notebook.metadata?.language_info?.name || notebook.metadata?.kernelspec?.language || "";
  const diagramState = createMermaidDiagramState();
  const cells = notebook.cells;
  const rendered = cells.slice(0, NOTEBOOK_MAX_RENDERED_CELLS)
    .map((cell) => renderNotebookCell(cell, language, diagramState))
    .join("");
  const notice = cells.length > NOTEBOOK_MAX_RENDERED_CELLS
    ? `<p class="artifact-notebook-notice">Showing the first ${NOTEBOOK_MAX_RENDERED_CELLS} of ${cells.length} cells.</p>`
    : "";

  return `<article class="artifact-doc artifact-notebook">${notice}${rendered}</article>`;
}

function renderNotebookCell(cell, language, diagramState) {
  const cellType = cell?.cell_type;
  const source = notebookText(cell?.source);

  if (cellType === "markdown") {
    return `<section class="artifact-notebook-cell artifact-notebook-cell-markdown">${markdownToHtml(source, diagramState)}</section>`;
  }

  if (cellType === "code") {
    const executionLabel = typeof cell?.execution_count === "number" ? `[${cell.execution_count}]` : "[ ]";
    // Validate the language token the same way markdown fences are
    // validated before it feeds a class attribute (escapeAttribute doesn't
    // escape spaces, so an unvalidated name could inject extra class
    // tokens, e.g. "artifact-frame", which frameResizeScript selects).
    const safeLanguage = /^[a-zA-Z0-9+#_.-]+$/.test(language) ? language.toLowerCase() : "";
    const classAttribute = safeLanguage ? ` class="language-${escapeAttribute(safeLanguage)}"` : "";
    const cellOutputs = Array.isArray(cell?.outputs) ? cell.outputs : [];
    const visibleOutputs = cellOutputs.slice(0, NOTEBOOK_MAX_OUTPUTS_PER_CELL);
    const outputsNotice = cellOutputs.length > NOTEBOOK_MAX_OUTPUTS_PER_CELL
      ? `<p class="artifact-notebook-notice">Showing the first ${NOTEBOOK_MAX_OUTPUTS_PER_CELL} of ${cellOutputs.length} outputs.</p>`
      : "";
    const outputs = visibleOutputs.map((output) => renderNotebookOutput(output, diagramState)).join("") + outputsNotice;
    return `<section class="artifact-notebook-cell artifact-notebook-cell-code">
      <div class="artifact-notebook-execcount">${escapeHtml(executionLabel)}</div>
      <pre><code${classAttribute}>${escapeHtml(source)}</code></pre>
      ${outputs}
    </section>`;
  }

  // "raw" cells and any other/unknown cell_type render as escaped source.
  return `<section class="artifact-notebook-cell artifact-notebook-cell-raw"><pre class="artifact-code"><code>${escapeHtml(source)}</code></pre></section>`;
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1B\[[0-9;]*[a-zA-Z]/g;

function stripAnsiEscapes(value) {
  return String(value ?? "").replace(ANSI_ESCAPE_PATTERN, "");
}

function renderNotebookOutput(output, diagramState) {
  const outputType = output?.output_type;

  if (outputType === "stream") {
    return renderNotebookTextOutput(notebookText(output.text));
  }

  if (outputType === "error") {
    // Unlike cell.source, traceback array elements carry no trailing
    // newline in nbformat, so joining with "" runs every line together.
    // ANSI color escapes are also common in tracebacks and there is no
    // terminal here to interpret them, so strip them rather than leak the
    // raw escape codes into the page.
    const rawTraceback = Array.isArray(output.traceback)
      ? output.traceback.map((line) => (typeof line === "string" ? line : String(line ?? ""))).join("\n")
      : notebookText(output.traceback);
    const traceback = stripAnsiEscapes(rawTraceback) ||
      `${notebookText(output.ename)}: ${notebookText(output.evalue)}`;
    return renderNotebookTextOutput(traceback, "artifact-notebook-error");
  }

  if (outputType === "execute_result" || outputType === "display_data") {
    return renderNotebookMimeBundle(output.data, diagramState);
  }

  return "";
}

function renderNotebookTextOutput(text, extraClass = "") {
  const truncated = notebookTruncateIfOversized(text);
  if (truncated) {
    return truncated;
  }
  const classAttribute = extraClass ? ` ${extraClass}` : "";
  return `<pre class="artifact-notebook-output artifact-code${classAttribute}"><code>${escapeHtml(text)}</code></pre>`;
}

function renderNotebookMimeBundle(data, diagramState) {
  const bundle = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const keys = Object.keys(bundle);
  if (keys.length === 0) {
    return "";
  }

  const mime = NOTEBOOK_OUTPUT_MIME_PRIORITY.find((candidate) => keys.includes(candidate));
  if (!mime) {
    return `<p class="artifact-notebook-output-placeholder">Unsupported output type: ${escapeHtml(keys[0])}</p>`;
  }

  const value = notebookText(bundle[mime]);
  const truncated = notebookTruncateIfOversized(value);
  if (truncated) {
    return truncated;
  }

  if (mime === "text/plain") {
    return `<pre class="artifact-notebook-output artifact-code"><code>${escapeHtml(value)}</code></pre>`;
  }
  if (mime === "text/markdown") {
    return `<div class="artifact-notebook-output artifact-doc">${markdownToHtml(value, diagramState)}</div>`;
  }
  if (mime === "image/png" || mime === "image/jpeg") {
    const dataUrl = mediaDataUrl(value, mime);
    if (!dataUrl) {
      return `<p class="artifact-notebook-output-placeholder">Unsupported output type: ${escapeHtml(mime)}</p>`;
    }
    return `<figure class="artifact-media artifact-image artifact-notebook-output"><img src="${escapeAttribute(dataUrl)}" alt="Notebook output image"></figure>`;
  }
  if (mime === "image/svg+xml") {
    return `<iframe class="artifact-frame artifact-svg-frame artifact-notebook-output" sandbox srcdoc="${escapeAttribute(svgFrameContent(value))}"></iframe>`;
  }
  if (mime === "text/html") {
    return `<iframe class="artifact-frame artifact-notebook-output" sandbox="allow-scripts allow-forms allow-popups" srcdoc="${escapeAttribute(htmlFrameContent(value))}"></iframe>`;
  }
  return "";
}

function notebookTruncateIfOversized(value) {
  const size = Buffer.byteLength(String(value ?? ""), "utf8");
  if (size <= NOTEBOOK_MAX_OUTPUT_BYTES) {
    return null;
  }
  return `<p class="artifact-notebook-output-truncated">Output truncated: ${escapeHtml(String(size))} bytes exceeds the 2 MB limit.</p>`;
}

function notebookText(value) {
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === "string" ? part : String(part ?? ""))).join("");
  }
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}
