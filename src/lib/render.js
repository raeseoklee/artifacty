import { currentDisplayTimeZone, supportedDisplayTimeZones } from "./display-settings.js";
import { renderCategoryFilter, renderCategoriesBody, renderCategoryNavigation, categoryPathLabel } from "./category-ui.js";
import { parseCollection } from "./collections.js";
import { renderExplainer } from "./render-explainer.js";
import { uiIcon } from "./ui-icons.js";
import { readFileSync } from "node:fs";
import { EDITOR_CLIENT_PATH, REACT_BUNDLE_PATH, VIEWER_CLIENT_PATH, editorImportMapJson } from "./editor-assets.js";
import { createI18n, DEFAULT_LOCALE, editorMessages, localizedHref, availableLanguages } from "./i18n.js";
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

const APP_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export function renderCategoriesPage({ categories, teams, artifact, user, locale = DEFAULT_LOCALE, currentPath = "/categories" }) {
  const view = viewContext(locale, currentPath);
  return pageShell({ title: view.raw("category.title"), locale: view.locale,
    body: workspaceHeader(user, view) + renderCategoriesBody({ categories, teams, artifact, view, user }),
    head: `<style>
      [data-category-manager] .category-teams{display:flex;align-items:center;gap:.6rem 1rem;flex-wrap:wrap;margin:.75rem 0 1rem;font-size:13px}
      [data-category-manager] .category-teams strong{font-weight:600}
      [data-category-manager] .category-artifact-summary{padding:16px 20px}
      [data-category-manager] .category-artifact-summary h2{margin:0;font-size:16px}
      [data-category-manager] .category-artifact-summary p{margin:.5rem 0 0}
      [data-category-manager] .category-create{padding:16px 20px}
      [data-category-manager] .category-create>summary{cursor:pointer;font-weight:600}
      [data-category-manager] .category-create form{margin-top:1rem;display:grid;grid-template-columns:minmax(160px,1fr) minmax(120px,180px) minmax(120px,180px);gap:1rem;align-items:end}
      [data-category-manager] .category-create form>div{grid-column:1/-1}
      [data-category-manager] .category-list>.meta-card{padding:16px 20px}
      [data-category-manager] .category-row{display:grid;grid-template-columns:minmax(160px,1fr) minmax(120px,190px) 88px 140px;gap:1rem;align-items:end}
      [data-category-manager] .category-row-membership{grid-template-columns:90px minmax(160px,1fr) minmax(120px,190px) 88px 140px}
      [data-category-manager] .category-row>.muted,[data-category-manager] .category-row>[data-category-count],[data-category-manager] .category-row>.checkbox-field{align-self:center;margin:1.4rem 0 0;overflow-wrap:anywhere}
      [data-category-manager] .category-name{min-width:0}
      [data-category-manager] .category-name input{width:100%;min-width:0}
      [data-category-manager] [data-category-membership]{width:16px;height:16px;min-width:16px;min-height:16px;padding:0;flex:0 0 16px;margin:0;vertical-align:middle}
      [data-category-manager] .checkbox-field{display:flex;gap:8px;align-items:center}
      [data-category-manager] [data-category-status]:empty{display:none}
      [data-category-team-field][hidden]{display:none}
      @media(max-width:1000px){
        [data-category-manager] .category-row,[data-category-manager] .category-row-membership{grid-template-columns:minmax(0,1fr) minmax(120px,160px);align-items:center}
        [data-category-manager] .category-name{grid-column:1/-1;grid-row:1}
        [data-category-manager] .category-row>.muted,[data-category-manager] .category-row>[data-category-count],[data-category-manager] .category-row>.checkbox-field{margin:0}
        [data-category-manager] .category-create form{grid-template-columns:1fr}
      }
      @media(max-width:480px){[data-category-manager] .category-row,[data-category-manager] .category-row-membership{grid-template-columns:minmax(0,1fr);gap:.8rem}[data-category-manager] .category-row button{justify-self:start}}
    </style>`,
    afterBody: "" });
}

export function renderDashboard({ artifacts, baseUrl, filters = {}, pagination, locale = DEFAULT_LOCALE, currentPath = "/", user = null, savedViews = [], categories = [], embeddingsAvailable = false }) {
  const view = viewContext(locale, currentPath);
  const total = pagination?.total ?? artifacts.length;
  const start = artifacts.length ? (pagination?.offset ?? 0) + 1 : 0;
  const end = artifacts.length ? (pagination?.offset ?? 0) + artifacts.length : 0;
  const pager = renderDashboardPager({ pagination: pagination || { total, limit: Number(filters.limit) || 50, offset: 0 }, filters, view });
  view.categoryUser = Boolean(user);
  const rowsHtml = renderArtifactRows(artifacts, filters.groupBy, view);
  const activeFilters = [
    ["categoryId", "category.filter"], ["tag", "filter.tag"], ["sourceAgent", "filter.source"], ["artifactType", "filter.artifactType"],
    ["publisher", "filter.publisher"], ["createdAfter", "filter.createdAfter"], ["createdBefore", "filter.createdBefore"],
    ["reviewStatus", "filter.reviewStatus"], ["mode", "filter.mode"], ["groupBy", "filter.groupBy"],
    ["relatedTo", "filter.relatedTo"], ["relation", "filter.relation"], ["includeArchived", "filter.archived"]
  ].filter(([key]) => filters[key]);
  const field = (key, label, type = "text") => `<label class="dashboard-field"><span>${view.text(label)}</span><input type="${type}" name="${key}" value="${escapeAttribute(filters[key] || "")}" class="form-control"></label>`;
  const selectField = (label, select) => `<label class="dashboard-field"><span>${view.text(label)}</span>${select}</label>`;

  return pageShell({
    title: "Artifacty",
    body: `
      ${workspaceHeader(user, view)}
      <div class="dashboard-layout">
        <main class="dashboard" id="main-content">
          <div class="dashboard-heading"><h1>${view.text("nav.artifacts")}</h1><nav><a href="${view.href("/import")}">${view.text("nav.import")}</a><a class="button-link btn btn-primary" href="${view.href("/new")}">${view.text("nav.new")}</a></nav></div>
          <form class="filter-form" data-auto-apply="filters" method="get" action="/">
            ${localeInput(view.locale)}
            ${filters.limit ? `<input type="hidden" name="limit" value="${escapeAttribute(filters.limit)}">` : ""}
            ${!embeddingsAvailable && filters.mode ? `<input type="hidden" name="mode" value="${escapeAttribute(filters.mode)}">` : ""}
            <div class="dashboard-search-row">
              <label class="dashboard-search"><span class="dashboard-sr-only">${view.text("filter.search")}</span>${uiIcon("search", { size: 16 })}<input type="search" name="q" value="${escapeAttribute(filters.query || "")}" placeholder="${view.attr("dashboard.searchPlaceholder")}" class="form-control"></label>
              ${user ? renderCategoryFilter({ categories, selected: filters.categoryId, view }) : ""}
              <button type="submit" class="btn btn-ghost dashboard-search-submit">${view.text("filter.search")}</button>
              <a class="dashboard-clear" href="${view.href("/")}">${view.text("filter.clear")}</a>
            </div>
            <details class="dashboard-advanced">
              <summary>${view.text("dashboard.advanced")}${activeFilters.length ? `<span class="dashboard-filter-count">${view.text("dashboard.activeFilters", { count: activeFilters.length })}</span>` : ""}</summary>
              <div class="dashboard-filter-grid">
                ${field("tag", "filter.tag")}${field("sourceAgent", "filter.source")}
                ${selectField("filter.artifactType", filterArtifactTypeSelect(filters.artifactType, view))}
                ${field("publisher", "filter.publisher")}
                ${field("createdAfter", "filter.createdAfter", "date")}${field("createdBefore", "filter.createdBefore", "date")}
                ${selectField("filter.reviewStatus", filterReviewStatusSelect(filters.reviewStatus, view))}
                ${embeddingsAvailable ? selectField("filter.mode", filterModeSelect(filters.mode, view)) : ""}
                ${selectField("filter.groupBy", filterGroupBySelect(filters.groupBy, view))}
                ${field("relatedTo", "filter.relatedTo")}${field("relation", "filter.relation")}
                <label class="checkbox-field"><input type="checkbox" name="includeArchived" value="true"${filters.includeArchived ? " checked" : ""} class="form-check-input"> ${view.text("filter.archived")}</label>
                <div class="dashboard-filter-actions"><button type="submit" class="btn btn-outline-secondary">${view.text("filter.submit")}</button></div>
              </div>
            </details>
            ${activeFilters.length ? `<p class="dashboard-active-filters">${activeFilters.map(([key, label]) => `<span>${view.text(label)}${key === "includeArchived" ? "" : `: ${escapeHtml(key === "categoryId" ? (categories.find((category) => category.id === filters[key]) ? categoryPathLabel(categories.find((category) => category.id === filters[key]), categories) : filters[key]) : filters[key])}`}</span>`).join("")}</p>` : ""}
          </form>
          ${renderSavedViewsSidebar({ savedViews, filters, view })}
          <section class="toolbar dashboard-results">
            <span>${view.text("dashboard.range", { start, end, total })}</span>
          </section>
          <section class="artifact-list">${rowsHtml || `<div class="empty">${view.text("dashboard.empty")}</div>`}</section>
          ${pager}
        </main>
      </div>
    `,
    locale: view.locale
  });
}

function renderArtifactRow(artifact, view, readOnly = false) {
  const tags = artifact.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const status = artifact.archivedAt ? statusBadge("archived") : "";
  const visibility = visibilityBadge(artifact, view);
  const publisher = publisherDisplay(artifact, view);
  const hasPublisher = Boolean(artifact.publisherId || artifact.publisherName);
  const agent = provenanceLabel(artifact.provenance, artifact.sourceAgent, view);
  const agentKnown = agent !== view.raw("provenance.unknown");
  const snippet = artifact.searchSnippet
    ? `<span class="row-snippet">${escapeHtml(artifact.searchSnippet)}</span>`
    : "";
  return `
    ${view.categoryUser && !readOnly ? `<div class="artifact-row-shell" data-category-artifact-id="${escapeAttribute(artifact.id)}"><input class="form-check-input category-selection" type="checkbox" data-category-selected-artifact="${escapeAttribute(artifact.id)}" aria-label="${view.attr("category.selectArtifact", { title: artifact.title })}">` : ""}
    <${readOnly ? "div" : "a"} class="artifact-row"${readOnly ? "" : ` href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}`)}"`}>
      <span class="row-main">
        <strong>${escapeHtml(artifact.title)}</strong>
        <span class="dashboard-sr-only">${escapeHtml(artifact.id)}</span>
        ${snippet}
      </span>
      <span class="row-agent">${agentKnown || !hasPublisher ? `<span>${escapeHtml(agent)}</span>` : ""}${hasPublisher ? `<span class="publisher-cell" title="${escapeAttribute(publisherTitle(artifact, view))}">${escapeHtml(publisher)}</span>` : ""}</span>
      <span class="row-formats">${typeBadge(artifact.artifactType || "document")}${formatBadge(artifact.format || "text")}<span class="row-version">v${artifact.latestVersion}</span></span>
      <span class="tags">${status}${visibility}${tags}</span>
    </${readOnly ? "div" : "a"}>${view.categoryUser && !readOnly ? "</div>" : ""}
  `;
}

// groupBy is purely presentational: it groups the already-fetched, already-
// sorted page of artifacts into labeled sections without changing the query.
function renderArtifactRows(artifacts, groupBy, view, readOnly = false) {
  if (!GROUP_BY_VALUES.includes(groupBy)) {
    return artifacts.map((artifact) => renderArtifactRow(artifact, view, readOnly)).join("");
  }

  const groups = new Map();
  for (const artifact of artifacts) {
    const key = groupKeyFor(artifact, groupBy, view.timeZone);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(artifact);
  }

  return Array.from(groups.entries())
    .map(([key, group]) => `
      <section class="artifact-group">
        <h2 class="artifact-group-heading">${escapeHtml(groupHeadingLabel(key, groupBy, view))}</h2>
        ${group.map((artifact) => renderArtifactRow(artifact, view, readOnly)).join("")}
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

// Shared by every <select class="form-select"> whose options are just ARTIFACT_TYPES rendered
// as their own value and (escaped) label.
function artifactTypeOptions(selected) {
  return ARTIFACT_TYPES.map((type) => `<option value="${type}"${type === selected ? " selected" : ""}>${escapeHtml(type)}</option>`).join("");
}

function filterArtifactTypeSelect(selected, view) {
  return `<select name="artifactType" class="form-select">
    <option value="">${view.text("filter.artifactTypeAny")}</option>
    ${artifactTypeOptions(selected)}
  </select>`;
}

function filterReviewStatusSelect(selected, view) {
  return `<select name="reviewStatus" class="form-select">
    <option value="">${view.text("filter.reviewStatusAny")}</option>
    ${REVIEW_STATUSES.map((status) => `<option value="${status}"${status === selected ? " selected" : ""}>${view.text(`reviewStatus.${status}`)}</option>`).join("")}
  </select>`;
}

const SEARCH_MODE_VALUES = ["keyword", "semantic", "hybrid"];

// Only rendered when the caller confirms an embedding provider is
// configured (roadmap section 6): semantic/hybrid search silently falls
// back to keyword without one, so the toggle would otherwise mislead.
function filterModeSelect(selected, view) {
  return `<select name="mode" class="form-select">
    <option value="">${view.text("filter.modeDefault")}</option>
    ${SEARCH_MODE_VALUES.map((value) => `<option value="${value}"${value === selected ? " selected" : ""}>${view.text(`filter.mode.${value}`)}</option>`).join("")}
  </select>`;
}

function filterGroupBySelect(selected, view) {
  return `<select name="groupBy" class="form-select">
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
            <button type="submit" class="btn btn-outline-secondary">${view.text("views.delete")}</button>
          </form>
        </li>
      `).join("")
    : `<li class="empty">${view.text("views.empty")}</li>`;

  return `
    <details class="dashboard-saved-views">
      <summary>${view.text("views.title")} <span class="dashboard-filter-count">${savedViews.length}</span></summary>
      <div class="dashboard-saved-content">
      <ul class="saved-view-list">${items}</ul>
      <form method="post" action="${view.href("/views")}" class="saved-view-form">
        ${localeInput(view.locale)}
        ${savedViewFilterHiddenInputs(filters)}
        <label class="dashboard-field"><span>${view.text("views.namePlaceholder")}</span><input name="name" placeholder="${view.attr("views.namePlaceholder")}" required class="form-control"></label>
        <label class="checkbox-field"><input type="checkbox" name="shared" value="true" class="form-check-input"> ${view.text("views.shared")}</label>
        <button type="submit" class="btn btn-outline-secondary">${view.text("views.save")}</button>
      </form>
      </div>
    </details>
  `;
}

// Every SAVED_VIEW_FILTER_KEYS entry as a hidden form field, so a filter
// added there (e.g. relatedTo/relation) is captured by "save current
// filters" automatically instead of needing a hand-added <input class="form-control"> here too.
function savedViewFilterHiddenInputs(filters) {
  return SAVED_VIEW_FILTER_KEYS.map((key) => {
    if (key === "includeArchived") {
      return `<input type="hidden" name="includeArchived" value="${filters.includeArchived ? "true" : ""}">`;
    }
    return `<input type="hidden" name="${key}" value="${escapeAttribute(filters[key] || "")}">`;
  }).join("\n        ");
}

function renderDashboardPager({ pagination, filters, view }) {
  const limit = Math.max(1, Math.min(200, Number(pagination.limit) || 50));
  const offset = Math.max(0, Number(pagination.offset) || 0);
  const total = Math.max(0, Number(pagination.total) || 0);
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(pages, Math.floor(offset / limit) + 1);
  const current = new URL(view.currentPath || "/", "http://artifacty.local");
  const params = new URLSearchParams(current.search);
  const resolved = new URL(dashboardPageHref(filters, 0), "http://artifacty.local");
  for (const [name, value] of resolved.searchParams) if (!params.has(name)) params.append(name, value);
  params.delete("limit");
  params.delete("offset");
  params.set("lang", view.locale);
  const pageHref = (nextOffset) => {
    const query = new URLSearchParams(params);
    query.set("limit", String(limit));
    query.set("offset", String(nextOffset));
    return escapeAttribute(`${current.pathname}?${query}${current.hash}`);
  };
  const previousOffset = pagination.previousOffset === undefined ? Math.max(0, offset - limit) : pagination.previousOffset;
  const nextOffset = pagination.nextOffset === undefined ? offset + limit : pagination.nextOffset;
  const previous = offset === 0 || previousOffset === null
    ? `<span class="pager-disabled" aria-disabled="true">${view.text("dashboard.previous")}</span>`
    : `<a rel="prev" href="${pageHref(previousOffset)}">${view.text("dashboard.previous")}</a>`;
  const next = offset + limit >= total || nextOffset === null
    ? `<span class="pager-disabled" aria-disabled="true">${view.text("dashboard.next")}</span>`
    : `<a rel="next" href="${pageHref(nextOffset)}">${view.text("dashboard.next")}</a>`;
  const sizes = [...new Set([10, 25, 50, 100, limit])].sort((a, b) => a - b);
  return `<section class="dashboard-pagination">
    <nav class="pager" aria-label="${view.attr("dashboard.pagination")}">${previous}<span class="pager-position">${view.text("dashboard.pagePosition", { page, pages })}</span>${next}</nav>
    <form class="page-size-form" data-auto-apply="all" method="get" action="${escapeAttribute(`${current.pathname}${current.hash}`)}">
      ${[...params].map(([name, value]) => `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}">`).join("")}
      <input type="hidden" name="offset" value="0">
      <label><span>${view.text("dashboard.pageSize")}</span><select name="limit" class="form-select">${sizes.map((size) => `<option value="${size}"${size === limit ? " selected" : ""}>${size}</option>`).join("")}</select></label>
      <button type="submit" class="btn btn-outline-secondary">${view.text("language.apply")}</button>
    </form>
  </section>`;
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

export function renderCollectionFormPage({ user, baseUrl, artifact, content, candidates = [], authToken = "", locale = DEFAULT_LOCALE, currentPath = "/collections/new", expectedVersion, conflict = null, unavailableCount = 0 }) {
  const view = viewContext(locale, currentPath);
  const collection = parseCollection(content || JSON.stringify({ description: "", sections: [] }));
  const edit = Boolean(artifact);
  const labels = Object.fromEntries(["sectionTitle", "up", "down", "removeSection", "artifact", "version", "display", "card", "inline", "remove", "addArtifact", "chooseArtifact", "artifactId"].map(key => [key, view.raw(`collection.${key}`)]));
  return pageShell({ title: view.raw(edit ? "collection.edit" : "collection.new"), locale: view.locale,
    body: `${workspaceHeader(user, view)}<header class="topbar"><div><h1>${view.text(edit ? "collection.edit" : "collection.new")}</h1><p>${escapeHtml(baseUrl)}</p></div></header>
      <main id="main-content" class="artifact-editor">${conflict ? `<p class="conflict-banner" role="alert">${view.text("form.conflict", { latestVersion: conflict.latestVersion })}</p>` : ""}
      <form class="editor-form" method="post" action="${edit ? `/artifacts/${encodeURIComponent(artifact.id)}/edit` : "/new"}" data-collection-editor data-collection-labels="${escapeAttribute(JSON.stringify(labels))}">
        ${hiddenToken(authToken)}${localeInput(view.locale)}<input type="hidden" name="format" value="collection"><input type="hidden" name="artifactType" value="collection"><input type="hidden" name="sourceAgent" value="artifacty">
        ${edit ? `<input type="hidden" name="expectedVersion" value="${Number(expectedVersion ?? artifact.latestVersion)}">` : ""}
        <textarea name="content" hidden>${escapeHtml(JSON.stringify(collection))}</textarea>
        <script type="application/json" data-collection-candidates>${JSON.stringify(candidates.map(({ id, title }) => ({ id, title }))).replace(/</g, "\\u003c")}</script>
        <section class="editor-fields"><label class="field"><span>${view.text("form.title")}</span><input class="form-control" name="title" value="${escapeAttribute(artifact?.title || "")}" required></label>
        <label class="field"><span>${view.text("form.tags")}</span><input class="form-control" name="tags" value="${escapeAttribute(artifact?.tags?.join(", ") || "")}"></label>
        ${edit ? "" : `<label class="field"><span>${view.text("artifact.visibility.label")}</span>${visibilitySelect("team", view)}</label>`}</section>
        <label class="field"><span>${view.text("collection.description")}</span><textarea class="form-control" data-collection-description rows="4">${escapeHtml(collection.description)}</textarea></label>
        <p class="muted">${view.text("collection.help")}</p><p class="muted">${view.text("collection.versionHelp")}</p>
        ${unavailableCount ? `<div class="conflict-banner" role="alert"><p>${view.text("collection.recoveryHelp")}</p><label class="checkbox-field"><input type="checkbox" name="dropUnavailableReferences" value="true" required class="form-check-input">${view.text("collection.confirmDrop")}</label></div>` : ""}
        <div data-collection-sections></div><button type="button" class="btn btn-outline-secondary" data-add-section>${view.text("collection.addSection")}</button>
        <noscript>${view.text("collection.requiresJavaScript")}</noscript>
        <footer class="editor-actions"><a href="${view.href(edit ? `/artifacts/${encodeURIComponent(artifact.id)}` : "/")}">${view.text("nav.cancel")}</a><button class="btn btn-primary" type="submit">${view.text(edit ? "form.saveVersion" : "form.create")}</button></footer>
      </form></main>`, afterBody: '<script type="module" src="/assets/collections.js"></script>' });
}

function renderCollection(collection, view, { shared = false } = {}) {
  if (!collection) return `<p>${view.text("collection.unavailable")}</p>`;
  const sections = collection.sections.map(section => {
    const items = section.items.map(item => {
      const child = item.artifact;
      const childUrl = view.href(`/artifacts/${encodeURIComponent(child.id)}?version=${child.version.version}`);
      // Nested collections are links, not recursively rendered trees. Share-token
      // readers see only separately authorized children and no token is forwarded.
      const inline = item.display === "inline" && child.version.format !== "collection";
      const body = inline ? renderContent(child.version.format, child.content, child.version.metadata || {}, {
        view, artifactType: child.artifactType,
        rawUrl: view.href(`/artifacts/${encodeURIComponent(child.id)}/raw?version=${child.version.version}`),
        bundleFileUrl: name => view.href(`/artifacts/${encodeURIComponent(child.id)}/raw?version=${child.version.version}&file=${encodeURIComponent(name)}`)
      }) : "";
      return `<article class="collection-item"><header><h3><a href="${childUrl}">${escapeHtml(child.title)}</a></h3><p class="muted">${escapeHtml(child.version.format)} · v${Number(child.version.version)} · ${view.text(item.version === "latest" ? "collection.latest" : "collection.pinned")} · ${escapeHtml(provenanceLabel(child.version.provenance || child.provenance, child.sourceAgent, view))}</p></header>${body}</article>`;
    }).join("");
    return `<section id="collection-${escapeAttribute(section.id)}" class="collection-section"><h2>${escapeHtml(section.title)}</h2>${items || `<p class="muted">${view.text("collection.empty")}</p>`}</section>`;
  }).join("");
  return `<div class="collection-page"><details class="collection-toc" open data-collection-toc><summary>${view.text("collection.contents")}</summary><nav aria-label="${view.text("collection.contents")}">${collection.sections.map(section => `<a href="#collection-${escapeAttribute(section.id)}">${escapeHtml(section.title)}</a>`).join("")}</nav></details><div class="collection-body"><div class="artifact-markdown">${markdownToHtml(collection.description)}</div>${collection.unavailableCount ? `<p class="muted">${view.text("collection.unavailable")}</p>` : ""}${sections}</div></div>`;
}

function provenanceLabel(provenance, fallback, view) {
  const names = { "claude-code": "Claude Code", "codex": "Codex", "cursor": "Cursor", "copilot": "GitHub Copilot", "gemini-cli": "Gemini CLI", "artifacty": "Artifacty" };
  const tool = provenance?.tool;
  return [tool ? names[tool] || tool : (provenance ? provenance.rawSourceAgent : fallback) || view.raw("provenance.unknown"), provenance?.model].filter(Boolean).join(" · ");
}
function renderProvenance(artifact, version, view) {
  const author = version.provenance || artifact.provenance;
  return `<details class="artifact-details provenance-details"><summary>${view.text("provenance.title")}: ${escapeHtml(provenanceLabel(author, artifact.sourceAgent, view))}</summary><dl>
    <dt>${view.text("provenance.creator")}</dt><dd>${escapeHtml(provenanceLabel(artifact.createdBy, "", view))}</dd>
    ${["tool", "provider", "model", "userId", "source", "rawSourceAgent"].map(key => `<dt>${view.text(`provenance.${key}`)}</dt><dd>${escapeHtml(author?.[key] || view.raw("provenance.unknown"))}</dd>`).join("")}</dl></details>`;
}

export function renderExplainerDraftPage({ artifact, draft, user, baseUrl, authToken = "", locale = DEFAULT_LOCALE, currentPath = "/", error = "", mode = "new", expectedVersion, conflict = null, draftTitle, baseVersion }) {
  const view = viewContext(locale, currentPath);
  const edit = mode === "edit";
  const content = typeof draft === "string" ? draft : JSON.stringify(draft, null, 2);
  const labels = Object.fromEntries(["flowView", "flowText", "flowChart", "flowDirection", "flowHorizontal", "flowVertical", "flowStart", "goal", "summary", "limitations", "blockTitle", "mode", "steps", "compare", "diagram", "scenarios", "label", "explanation", "basis", "source", "interpretation", "assumption", "reference", "value", "parameter", "unit", "addBlock", "addItem", "remove", "up", "down", "connections", "from", "to", "addConnection", "item", "block", "invalidDraft", "invalidCounts", "missingCitation", "scenarioOrder", "invalidConnections", "invalidLimitations"].map(key => [key, view.raw(`explainer.${key}`)]));
  const sourceVersion = baseVersion ?? artifact.version?.version ?? artifact.latestVersion;
  const heading = edit ? "explainer.edit" : "explainer.create";
  return pageShell({ title: view.raw(heading), locale: view.locale,
    body: `${workspaceHeader(user, view)}<header class="topbar"><div><h1>${view.text(heading)}</h1><p>${escapeHtml(artifact.title)} · v${Number(sourceVersion)}</p></div></header>
    <main id="main-content" class="artifact-editor explainer-editor"><p class="explainer-editor-intro">${view.text(edit ? "explainer.editHelp" : "explainer.draftHelp")}</p>
    ${conflict ? `<p class="conflict-banner" role="alert">${view.text("form.conflict", { latestVersion: conflict.latestVersion })}</p>` : ""}
    ${error ? `<p role="alert" class="conflict-banner">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/${edit ? "edit" : "explain"}" class="editor-form" data-explainer-editor data-explainer-labels="${escapeAttribute(JSON.stringify(labels))}">
      ${hiddenToken(authToken)}${localeInput(view.locale)}${edit ? `<input type="hidden" name="format" value="explainer"><input type="hidden" name="baseVersion" value="${Number(sourceVersion)}"><input type="hidden" name="artifactType" value="${escapeAttribute(artifact.artifactType || "document")}"><input type="hidden" name="tags" value="${escapeAttribute((artifact.tags || []).join(", "))}"><input type="hidden" name="expectedVersion" value="${Number(expectedVersion ?? artifact.latestVersion)}">` : `<input type="hidden" name="sourceVersion" value="${Number(sourceVersion)}">`}
      <label class="field"><span>${view.text("form.title")}</span><input class="form-control" name="title" required maxlength="500" value="${escapeAttribute(draftTitle ?? (edit ? artifact.title : `${artifact.title} — ${view.raw("explainer.title")}`))}"></label>
      <label class="field" data-explainer-json><span>${view.text("explainer.structuredContent")}</span><textarea class="form-control" name="content" rows="20" required>${escapeHtml(content)}</textarea></label>
      <div data-explainer-editor-fields></div>${edit ? "" : `<p class="muted">${view.text("explainer.privateHelp")}</p>`}
      <footer class="editor-actions"><a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}?version=${sourceVersion}`)}">${view.text("nav.cancel")}</a><button type="submit" class="btn btn-primary">${view.text(edit ? "form.saveVersion" : "explainer.createDraft")}</button></footer>
    </form></main>` });
}

export function renderArtifactFormPage({ user, mode, baseUrl, artifact, version, content, authToken = "", locale = DEFAULT_LOCALE, currentPath = "/", expectedVersion, conflict = null }) {
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
      ${workspaceHeader(user, view)}
      <header class="topbar">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href(isEdit ? `/artifacts/${encodeURIComponent(artifact.id)}` : "/")}">${view.text("nav.cancel")}</a>

        </nav>
      </header>
      <main id="main-content" class="artifact-editor">
        ${conflictBanner}
        <form class="editor-form" method="post" action="${action}">
          ${hiddenToken(authToken)}
          ${localeInput(view.locale)}
          ${isEdit && (conflict?.latestVersion ?? editVersion) != null ? `<input type="hidden" name="expectedVersion" value="${escapeAttribute(String(conflict?.latestVersion ?? editVersion))}">` : ""}
          <section class="editor-fields">
            <label class="field">
              <span>${view.text("form.title")}</span>
              <input name="title" value="${escapeAttribute(artifact?.title || "")}" autocomplete="off" required class="form-control">
            </label>
            <label class="field">
              <span>${view.text("form.format")}</span>
              ${formatSelect(format)}
            </label>
            <label class="field">
              <span>${view.text("form.source")}</span>
              <input name="sourceAgent" value="${escapeAttribute(sourceAgent)}" autocomplete="off" class="form-control">
            </label>
            <label class="field">
              <span>${view.text("form.type")}</span>
              ${artifactTypeSelect(artifactType)}
            </label>
            <label class="field">
              <span>${view.text("form.tags")}</span>
              <input name="tags" value="${escapeAttribute(tags)}" autocomplete="off" class="form-control">
            </label>
            ${isEdit ? "" : `<label class="field">
              <span>${view.text("artifact.visibility.label")}</span>
              ${visibilitySelect(artifact?.visibility || "team", view)}
            </label>`}
          </section>
          <p class="muted">${view.text("artifact.visibility.help")}</p>
          <section class="field content-field">
            <label for="artifact-content">${view.text("form.content")}</label>
            <textarea id="artifact-content" name="content" data-artifacty-editor data-editor-format="${escapeAttribute(format)}" spellcheck="false" required class="form-control">${escapeHtml(body)}</textarea>
          </section>
          <footer class="editor-actions">
            <a href="${view.href(isEdit ? `/artifacts/${encodeURIComponent(artifact.id)}` : "/")}">${view.text("nav.cancel")}</a>
            <button type="submit" class="btn btn-primary">${isEdit ? view.text("form.saveVersion") : view.text("form.create")}</button>
          </footer>
        </form>
      </main>
    `,
    head: editorHead(),
    afterBody: editorScript(view.locale),
    locale: view.locale
  });
}

export function renderNewArtifactPage({ user, baseUrl, authToken = "", locale = DEFAULT_LOCALE, currentPath = "/new" }) {
  return renderArtifactFormPage({ mode: "new", baseUrl, authToken, locale, currentPath, user });
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
        <td>${renderDateTime(version.createdAt, view)}</td>
        <td><code>${escapeHtml(version.sha256.slice(0, 12))}</code></td>
        <td>${escapeHtml(String(version.sizeBytes))}</td>
        <td>
          <form class="inline-action" method="post" action="/admin/artifacts/${encodeURIComponent(artifact.id)}/versions/${version.version}/delete">
            ${localeInput(view.locale)}
            <input name="reason" placeholder="${view.text("ui.reason")}" aria-label="${view.text("ui.reason")}" class="form-control">
            <button type="submit"${deleteDisabled} class="btn btn-outline-danger">${view.text("ui.delete")}</button>
          </form>
        </td>
      </tr>
    `;
  }).join("");

  return pageShell({
    title: `${view.raw("versions.manage")} · ${artifact.title}`,
    body: `
      ${workspaceHeader(user, view)}
      <header class="topbar">
        <div>
          <h1>${view.text("versions.manage")}</h1>
          <p>${escapeHtml(artifact.title)} · ${escapeHtml(artifact.id)} · ${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href(artifactPath)}">${view.text("nav.artifact")}</a>
          <a href="${view.href(`${artifactPath}/diff`)}">${view.text("nav.diff")}</a>


        </nav>
      </header>
      <main id="main-content" class="artifact-editor">
        ${error ? `<p class="auth-error">${escapeHtml(error)}</p>` : ""}
        <section class="meta-card">
          <h2>${view.text("nav.versions")}</h2>
          <table class="data-table">
            <thead><tr><th>${view.text("ui.version")}</th><th>${view.text("form.format")}</th><th>${view.text("ui.created")}</th><th>SHA</th><th>${view.text("ui.bytes")}</th><th>${view.text("ui.action")}</th></tr></thead>
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
            ${selectedVersion.format === "collection" ? `<label class="checkbox-field"><input type="checkbox" name="dropUnavailableReferences" value="true" class="form-check-input">${view.text("collection.confirmDropRepair")}</label>` : ""}
            <label class="field">
              <span>${view.text("ui.reason")}</span>
              <input name="reason" value="" autocomplete="off" class="form-control">
            </label>
          </section>
          <section class="field content-field">
            <label for="artifact-content">${view.text("versions.content", { version: selectedVersion.version })}</label>
            <textarea id="artifact-content" name="content" data-artifacty-editor data-editor-format="${escapeAttribute(selectedVersion.format)}" spellcheck="false" required class="form-control">${escapeHtml(content)}</textarea>
          </section>
          <footer class="editor-actions">
            <a href="${view.href(`${artifactPath}?version=${selectedVersion.version}`)}">${view.text("versions.view")}</a>
            <button type="submit" class="btn btn-outline-secondary">${view.text("versions.repair")}</button>
          </footer>
        </form>
      </main>
    `,
    head: editorHead(),
    afterBody: editorScript(view.locale),
    locale: view.locale
  });
}

export function renderImportArtifactPage({ user, baseUrl, authToken = "", locale = DEFAULT_LOCALE, currentPath = "/import" }) {
  const view = viewContext(locale, currentPath);
  const title = view.raw("form.importTitle");
  return pageShell({
    title,
    body: `
      ${workspaceHeader(user, view)}
      <header class="topbar">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(baseUrl)}</p>
        </div>

      </header>
      <main id="main-content" class="artifact-editor">
        <form class="editor-form" method="post" action="/import">
          ${hiddenToken(authToken)}
          ${localeInput(view.locale)}
          <section class="editor-fields">
            <label class="field">
              <span>${view.text("form.agent")}</span>
              <select name="agent" class="form-select">
                <option value="auto">${view.text("form.auto")}</option>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="gemini">Gemini</option>
                <option value="copilot">GitHub Copilot</option>
                <option value="cursor">Cursor</option>
                <option value="generic">${view.text("import.generic")}</option>
              </select>
            </label>
            <label class="field">
              <span>${view.text("form.title")}</span>
              <input name="title" autocomplete="off" class="form-control">
            </label>
            <label class="field">
              <span>${view.text("form.fileName")}</span>
              <input name="fileName" autocomplete="off" class="form-control">
            </label>
            <label class="field">
              <span>${view.text("form.tags")}</span>
              <input name="tags" autocomplete="off" class="form-control">
            </label>
          </section>
          <section class="field content-field">
            <label for="import-content">${view.text("form.importContent")}</label>
            <textarea id="import-content" name="content" data-artifacty-editor data-editor-format="auto" spellcheck="false" required class="form-control"></textarea>
          </section>
          <footer class="editor-actions">
            <a href="${view.href("/")}">${view.text("nav.cancel")}</a>
            <button type="submit" class="btn btn-outline-secondary">${view.text("form.importSubmit")}</button>
          </footer>
        </form>
      </main>
    `,
    head: editorHead(),
    afterBody: editorScript(view.locale),
    locale: view.locale
  });
}

export function renderLoginPage({ baseUrl, setup = false, error = "", next = "", locale = DEFAULT_LOCALE, currentPath = "/login" }) {
  const view = viewContext(locale, currentPath);
  const title = setup ? view.raw("login.setup") : view.raw("nav.signIn");
  return pageShell({
    title,
    body: `
      ${workspaceHeader(null, view)}
      <header class="topbar">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(baseUrl)}</p>
        </div>

      </header>
      <main id="main-content" class="artifact-editor auth-panel">
        ${error ? `<p class="auth-error">${escapeHtml(error)}</p>` : ""}
        ${setup ? `<p class="muted">${view.text("login.setupHelp")}</p>` : ""}
        ${next && !setup ? `<p class="auth-notice" role="status">${view.text("login.continueHelp")}</p>` : ""}
        <form class="editor-form auth-form" method="post" action="/login">
          ${next ? `<input type="hidden" name="next" value="${escapeAttribute(next)}">` : ""}
          ${localeInput(view.locale)}
          <section class="editor-fields">
            <label class="field">
              <span>${view.text("ui.email")}</span>
              <input type="email" name="email" autocomplete="username" required class="form-control">
            </label>
            ${setup ? `<label class="field">
              <span>${view.text("ui.name")}</span>
              <input name="name" autocomplete="name" class="form-control">
            </label>` : ""}
            <label class="field">
              <span>${view.text("ui.password")}</span>
              <input type="password" name="password" autocomplete="${setup ? "new-password" : "current-password"}" minlength="8" required class="form-control">
            </label>
          </section>
          <footer class="editor-actions">
            <button type="submit" class="btn btn-primary">${setup ? view.text("login.create") : view.text("nav.signIn")}</button>
          </footer>
        </form>
      </main>
    `,
    locale: view.locale
  });
}

// The form shows for every signed-in visitor, whether or not the artifact
// exists, so this page stays identical for missing and private artifacts.
export function renderArtifactUnavailablePage({ user = null, locale = DEFAULT_LOCALE, currentPath = "/", requestAccessPath = "" }) {
  const view = viewContext(locale, currentPath);
  const title = view.raw("artifact.unavailableTitle");
  const requestForm = user && requestAccessPath ? `
        <form method="post" action="${escapeAttribute(requestAccessPath)}" class="access-request-form">
          ${localeInput(view.locale)}
          <p>${view.text("access.request.help")}</p>
          <button type="submit" class="btn btn-outline-secondary">${view.text("access.request.submit")}</button>
        </form>` : "";
  return pageShell({
    title,
    body: `
      ${workspaceHeader(user, view)}
      <header class="topbar">
        <div>
          <h1>${escapeHtml(title)}</h1>
        </div>
      </header>
      <main id="main-content" class="artifact-editor auth-panel">
        <p>${view.text("artifact.unavailableHelp")}</p>${requestForm}
        <p><a class="btn btn-primary" href="${view.href("/")}">${view.text("nav.artifacts")}</a></p>
      </main>
    `,
    locale: view.locale
  });
}

export function renderAccessRequestSentPage({ user = null, locale = DEFAULT_LOCALE, currentPath = "/" }) {
  const view = viewContext(locale, currentPath);
  const title = view.raw("access.request.sentTitle");
  return pageShell({
    title,
    body: `
      ${workspaceHeader(user, view)}
      <header class="topbar">
        <div>
          <h1>${escapeHtml(title)}</h1>
        </div>
      </header>
      <main id="main-content" class="artifact-editor auth-panel">
        <p role="status">${view.text("access.request.sent")}</p>
        <p><a class="btn btn-primary" href="${view.href("/")}">${view.text("nav.artifacts")}</a></p>
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
      <td>${renderDateTime(artifact.updatedAt, view)}</td>
      <td>${artifact.archivedAt ? statusBadge(view.text("artifact.archived", { date: artifact.archivedAt })) : ""}</td>
    </tr>
  `).join("");
  const rows = tokens.map((token) => `
    <tr>
      <td>${escapeHtml(token.name)}</td>
      <td>${escapeHtml((token.scopes || ["read", "write"]).join(", "))}</td>
      <td>${renderDateTime(token.createdAt, view)}</td>
      <td>${token.lastUsedAt ? renderDateTime(token.lastUsedAt, view) : view.text("ui.never")}</td>
      <td>${token.revokedAt ? renderDateTime(token.revokedAt, view) : view.text("ui.active")}</td>
      <td>
        ${token.revokedAt ? "" : `<form method="post" action="/account/tokens/${encodeURIComponent(token.id)}/revoke">
          <button type="submit" class="btn btn-outline-danger">${view.text("ui.revoke")}</button>
        </form>`}
      </td>
    </tr>
  `).join("");

  return pageShell({
    title: view.raw("nav.account"),
    body: `
      ${workspaceHeader(user, view)}
      <header class="topbar">
        <div>
          <h1>${view.text("nav.account")}</h1>
          <p>${escapeHtml(user.email)} · ${view.text(`ui.role.${user.role}`)} · ${escapeHtml(baseUrl)}</p>
        </div>

      </header>
      <main id="main-content" class="settings-page artifact-view">
        ${createdToken ? `<section class="token-once">
          <h2>${view.text("account.newToken")}</h2>
          <p>${view.text("account.copyToken")}</p>
          <pre class="artifact-code"><code>${escapeHtml(createdToken)}</code></pre>
        </section>` : ""}
        <section class="meta-card">
          <h2>${view.text("account.profile")}</h2>
          <p><strong>${escapeHtml(user.name)}</strong></p>
          <p>${escapeHtml(user.email)}</p>
          <p>${view.text("ui.role")}: ${view.text(`ui.role.${user.role}`)}</p>
        </section>
        <section class="meta-card">
          <h2>${view.text("tokens.createTitle")}</h2>
          <form class="inline-action token-create-form" method="post" action="/account/tokens">
            <input name="name" placeholder="${view.text("account.tokenName")}" aria-label="${view.text("account.tokenName")}" autocomplete="off" required class="form-control">
            <fieldset class="token-scopes">
              <legend>${view.text("tokens.scopes")}</legend>
              <label><input type="checkbox" name="scopeRead" checked class="form-check-input"> ${view.text("tokens.scope.read")}</label>
              <label><input type="checkbox" name="scopeWrite" checked class="form-check-input"> ${view.text("tokens.scope.write")}</label>
              ${user.role === "admin" ? `<label><input type="checkbox" name="scopeAdmin" class="form-check-input"> ${view.text("tokens.scope.admin")}</label>` : ""}
            </fieldset>
            <button type="submit" class="btn btn-primary">${view.text("account.createToken")}</button>
          </form>
        </section>
        <section class="meta-card">
          <h2>${view.text("account.tokens")}</h2>
          <table class="data-table">
            <thead><tr><th>${view.text("ui.name")}</th><th>${view.text("tokens.scopes")}</th><th>${view.text("ui.created")}</th><th>${view.text("ui.lastUsed")}</th><th>${view.text("ui.status")}</th><th></th></tr></thead>
            <tbody>${rows || `<tr><td colspan="6">${view.text("account.noTokens")}</td></tr>`}</tbody>
          </table>
        </section>
        <section class="meta-card">
          <h2>${view.text("account.privateArtifacts")}</h2>
          <table class="data-table">
            <thead><tr><th>${view.text("ui.title")}</th><th>ID</th><th>${view.text("ui.updated")}</th><th>${view.text("ui.status")}</th></tr></thead>
            <tbody>${privateArtifactRows || `<tr><td colspan="4">${view.text("ui.none")}</td></tr>`}</tbody>
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
    title: view.raw("password.title"),
    body: `
      ${workspaceHeader(user, view)}
      <header class="topbar">
        <div>
          <h1>${view.text("password.title")}</h1>
          <p>${escapeHtml(user.email)} · ${escapeHtml(baseUrl)}</p>
        </div>

      </header>
      <main id="main-content" class="settings-page artifact-editor auth-panel">
        ${required ? `<p class="auth-warning">${view.text("password.required")}</p>` : ""}
        ${error ? `<p class="auth-error">${escapeHtml(error)}</p>` : ""}
        ${success ? `<p class="auth-success">${escapeHtml(success)}</p>` : ""}
        <form class="editor-form auth-form" method="post" action="/account/password">
          <section class="editor-fields">
            <label class="field">
              <span>${view.text("password.current")}</span>
              <input type="password" name="currentPassword" autocomplete="current-password" required class="form-control">
            </label>
            <label class="field">
              <span>${view.text("password.new")}</span>
              <input type="password" name="newPassword" autocomplete="new-password" minlength="8" required class="form-control">
            </label>
            <label class="field">
              <span>${view.text("password.confirm")}</span>
              <input type="password" name="confirmPassword" autocomplete="new-password" minlength="8" required class="form-control">
            </label>
          </section>
          <footer class="editor-actions">
            <button type="submit" class="btn btn-primary">${view.text("password.submit")}</button>
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

export function renderAdminBackupPage({ user, baseUrl, integrity, importResult = null, importError = "", locale = DEFAULT_LOCALE, currentPath = "/admin/backup" }) {
  const view = viewContext(locale, currentPath);
  return pageShell({
    title: view.raw("nav.backup"),
    body: `
      ${workspaceHeader(user, view)}
      <header class="topbar">
        <div>
          <h1>${view.text("nav.backup")}</h1>
          <p>${escapeHtml(baseUrl)}</p>
        </div>

      </header>
      <main id="main-content" class="settings-page artifact-view">
        ${importResult ? `<p class="auth-success">${view.text("backup.complete", { count: importResult.artifactCount })}${importResult.scope === "full" ? renderFullImportSummary(importResult.tableCounts) : ""}.</p>` : ""}
        ${importError ? `<p class="auth-error">${escapeHtml(importError)}</p>` : ""}
        <section class="meta-card">
          <h2>${view.text("backup.status")}</h2>
          <table class="data-table">
            <tbody>
              <tr><th>${view.text("backup.home")}</th><td>${escapeHtml(integrity.store)}</td></tr>
              <tr><th>${view.text("nav.artifacts")}</th><td>${escapeHtml(integrity.artifactCount)}</td></tr>
              <tr><th>${view.text("nav.versions")}</th><td>${escapeHtml(integrity.versionCount)}</td></tr>
              <tr><th>${view.text("backup.bytes")}</th><td>${escapeHtml(integrity.totalBytes)}</td></tr>
              <tr><th>${view.text("backup.integrity")}</th><td>${integrity.ok ? view.text("backup.ok") : view.text("backup.attention")}</td></tr>
            </tbody>
          </table>
          ${integrity.ok ? "" : `<p class="auth-warning">${view.text("backup.integrityHelp")}</p>`}
        </section>
        <section class="meta-card">
          <h2>${view.text("backup.download")}</h2>
          <p class="muted">${view.text("backup.exportHelp")}</p>
          <form class="editor-form" method="get" action="/admin/backup/export">
            <label class="field">
              <span>${view.text("backup.scopeLabel")}</span>
              <select name="scope" class="form-select">
                <option value="artifacts">${view.text("backup.scopeArtifacts")}</option>
                <option value="full">${view.text("backup.scopeFull")}</option>
              </select>
            </label>
            <footer class="editor-actions"><button type="submit" class="btn btn-outline-secondary">${view.text("backup.downloadButton")}</button></footer>
          </form>
        </section>
        <section class="meta-card">
          <h2>${view.text("backup.restore")}</h2>
          <p class="auth-warning">${view.text("backup.restoreHelp")}</p>
          <form class="editor-form" method="post" action="/admin/backup/import">
            <label class="field content-field">
              <span>${view.text("backup.json")}</span>
              <textarea class="compact-textarea form-control" name="backup" spellcheck="false" placeholder="{&quot;schemaVersion&quot;:1,&quot;artifacts&quot;:[...]}" required></textarea>
            </label>
            <label class="checkbox-field"><input type="checkbox" name="confirm" value="replace-all" class="form-check-input"> ${view.text("backup.confirmLabel")}</label>
            <label class="checkbox-field"><input type="checkbox" name="forceUsers" value="1" class="form-check-input"> ${view.text("backup.forceUsersLabel")}</label>
            <footer class="editor-actions"><button type="submit" class="btn btn-outline-secondary">${view.text("backup.restore")}</button></footer>
          </form>
        </section>
      </main>
    `,
    locale: view.locale
  });
}

export function renderAdminEmailPage({ settings = {}, user, baseUrl, locale = DEFAULT_LOCALE, currentPath = "/admin/email", error = "", success = "" }) {
  const view = viewContext(locale, currentPath);
  return pageShell({ title: view.raw("smtp.title"), locale: view.locale,
    body: `${workspaceHeader(user, view)}
      <header class="topbar"><div><h1>${view.text("smtp.title")}</h1><p>${escapeHtml(baseUrl)}</p></div></header>
      <main id="main-content" class="settings-page artifact-view">
        ${error ? `<p class="auth-error" role="alert">${view.text("smtp.saveFailed")}</p>` : ""}
        ${success ? `<p class="auth-success" role="status">${view.text("smtp.saved")}</p>` : ""}
        <section class="meta-card"><h2>${view.text("smtp.settings")}</h2>
          <p>${view.text("smtp.help")}</p><p class="muted">${view.text("smtp.security")}</p>
          <form class="editor-form smtp-settings-form" method="post" action="/admin/email">${localeInput(view.locale)}
            <label><input type="checkbox" name="enabled" value="true"${settings.enabled ? " checked" : ""} class="form-check-input"> ${view.text("smtp.enabled")}</label>
            <div class="smtp-field-grid">
              <label class="field"><span>${view.text("smtp.host")}</span><input name="host" value="${escapeAttribute(settings.host || "")}" autocomplete="off" class="form-control"></label>
              <label class="field"><span>${view.text("smtp.port")}</span><input name="port" type="number" min="1" max="65535" value="${escapeAttribute(settings.port || 465)}" class="form-control"></label>
              <label class="field"><span>${view.text("smtp.tlsMode")}</span><select name="tlsMode" required class="form-select">
                <option value="tls"${settings.tlsMode !== "starttls" ? " selected" : ""}>${view.text("smtp.tls")}</option>
                <option value="starttls"${settings.tlsMode === "starttls" ? " selected" : ""}>${view.text("smtp.starttls")}</option>
              </select></label>
              <label class="field"><span>${view.text("smtp.from")}</span><input name="from" type="email" value="${escapeAttribute(settings.from || "")}" autocomplete="off" class="form-control"></label>
              <label class="field"><span>${view.text("smtp.username")}</span><input name="username" value="${escapeAttribute(settings.username || "")}" autocomplete="off" class="form-control"></label>
              <label class="field"><span>${view.text("smtp.password")}</span><input name="password" type="password" value="" autocomplete="new-password" placeholder="${view.attr(settings.hasPassword ? "smtp.keepPassword" : "smtp.enterPassword")}" class="form-control"></label>
            </div>
            <p class="muted">${view.text("smtp.authHelp")}</p>
            <p class="muted">${view.text("smtp.restoreNote")}</p>
            <footer class="editor-actions"><button type="submit" class="btn btn-primary">${view.text("smtp.save")}</button></footer>
          </form>
        </section>
      </main>` });
}

export function renderAdminDisplayPage({ settings = { timeZone: "UTC" }, user, baseUrl, locale = DEFAULT_LOCALE, currentPath = "/admin/display", error = "" }) {
  const view = viewContext(locale, currentPath);
  const zones = [...new Set([settings.timeZone, ...supportedDisplayTimeZones()])];
  return pageShell({ title: view.raw("display.title"), locale: view.locale,
    body: `${workspaceHeader(user, view)}<header class="topbar"><div><h1>${view.text("display.title")}</h1><p>${escapeHtml(baseUrl)}</p></div></header>
      <main id="main-content" class="settings-page artifact-view">
        ${error ? `<p role="alert" class="auth-error">${escapeHtml(error)}</p>` : ""}
        <section class="meta-card"><h2>${view.text("display.timeZone")}</h2><p>${view.text("display.help")}</p>
          <form class="display-settings-form" data-display-settings data-saving="${view.text("display.saving")}" data-saved="${view.text("display.saved")}" data-failed="${view.text("display.failed")}" method="post" action="/admin/display">${localeInput(view.locale)}
            <label><span>${view.text("display.timeZone")}</span><select name="timeZone" class="form-select">${zones.map(zone => `<option value="${escapeAttribute(zone)}"${zone === settings.timeZone ? " selected" : ""}>${escapeHtml(zone)}</option>`).join("")}</select></label>
            <button type="submit" class="btn btn-primary">${view.text("display.save")}</button><span data-display-feedback role="status" aria-live="polite"></span>
          </form><p class="muted">${view.text("display.utcHelp")}</p>
        </section>
      </main>` });
}

export function renderAdminLanguagesPage({ settings, user, baseUrl, locale = DEFAULT_LOCALE, currentPath = "/admin/languages", error = "", success = "" }) {
  const view = viewContext(locale, currentPath);
  const installed = availableLanguages();
  return pageShell({ title: view.raw("languageAdmin.title"), locale: view.locale,
    body: `${workspaceHeader(user, view)}
      <header class="topbar"><div><h1>${view.text("languageAdmin.title")}</h1><p>${escapeHtml(baseUrl)}</p></div></header>
      <main id="main-content" class="settings-page artifact-view">
        ${error ? `<p class="auth-error" role="alert">${escapeHtml(error)}</p>` : ""}
        ${success ? `<p class="auth-success" role="status">${escapeHtml(success)}</p>` : ""}
        <section class="meta-card"><h2>${view.text("languageAdmin.settings")}</h2>
          <form class="editor-form" method="post" action="/admin/languages">${localeInput(view.locale)}
            <fieldset><legend>${view.text("languageAdmin.enabled")}</legend>
              ${installed.map((language) => `<label class="check-field"><input type="checkbox" name="enabledLocales" value="${escapeAttribute(language.locale)}"${settings.enabledLocales.includes(language.locale) ? " checked" : ""} class="form-check-input"> ${escapeHtml(language.nativeName)} (${escapeHtml(language.locale)})</label>`).join("")}
            </fieldset>
            <label class="field"><span>${view.text("languageAdmin.default")}</span><select name="defaultLocale" class="form-select">
              ${installed.map((language) => `<option value="${escapeAttribute(language.locale)}"${settings.defaultLocale === language.locale ? " selected" : ""}>${escapeHtml(language.nativeName)}</option>`).join("")}
            </select></label>
            <p class="muted">${view.text("languageAdmin.defaultHelp")}</p>
            <button type="submit" class="btn btn-primary">${view.text("languageAdmin.save")}</button>
          </form>
        </section>
        <section class="meta-card"><h2>${view.text("languageAdmin.import")}</h2>
          <p><a href="${view.href("/admin/languages/template")}">${view.text("languageAdmin.template")}</a></p>
          <p>${view.text("languageAdmin.templateHelp")}</p>
          <p>${view.text("languageAdmin.importHelp", { count: "{count}" })}</p>
          <p class="muted">${view.text("languageAdmin.disabledHelp")}</p>
          <form class="editor-form" method="post" action="/admin/languages/import">${localeInput(view.locale)}
            <label class="field"><span>${view.text("languageAdmin.pack")}</span><textarea class="compact-textarea form-control" name="pack" maxlength="524288" spellcheck="false" required placeholder="${escapeAttribute('{"locale":"fr","nativeName":"Français","messages":{"language.label":"Langue","language.apply":"Appliquer"}}')}"></textarea></label>
            <button type="submit" class="btn btn-outline-secondary">${view.text("languageAdmin.import")}</button>
          </form>
        </section>
      </main>` });
}

export function renderAdminUpdatePage({ baseUrl, user, status = {}, locale = DEFAULT_LOCALE, currentPath = "/admin/update" }) {
  const view = viewContext(locale, currentPath);
  const check = status.check;
  const run = status.run?.state === "succeeded" && status.currentVersion === status.run.targetVersion ? null : status.run;
  const active = ["queued", "running"].includes(run?.state);
  const hasUpdate = check?.updateAvailable && check.targetVersion && status.currentVersion !== check.targetVersion;
  const canStart = check?.supported && !check.errorCode && check.targetVersion && check.updateAvailable && check.confirmationId && Date.parse(check.expiresAt) > Date.now() && !active && run?.state !== "interrupted" && status.currentVersion !== check.targetVersion;
  const states = Object.fromEntries(["queued", "running", "succeeded", "failed", "interrupted"].map((state) => [state, view.raw(`update.${state}`)]));
  const updateSteps = ["preparing", "staging", "backup", "switching", "health"];
  const step = run?.state === "succeeded" ? "completed" : run?.step;
  const stepIndex = active ? updateSteps.indexOf(step) : -1;
  const progressValue = run?.state === "succeeded" ? 5 : stepIndex >= 0 ? stepIndex : null;
  const progressLabel = run?.state === "succeeded" ? view.raw("update.step.completed") : stepIndex >= 0
    ? view.raw("update.stepCount", { current: stepIndex + 1, total: 5, phase: view.raw(`update.step.${step}`) })
    : view.raw(step === "recovery" ? "update.step.recovery" : `update.${run?.state || "queued"}`);
  const messages = { ...states, steps: Object.fromEntries([...updateSteps, "completed", "recovery"].map((name) => [name, view.raw(`update.step.${name}`)])), stepCount: view.raw("update.stepCount"), reconnect: view.raw("update.reconnect"), signIn: view.raw("update.signIn") };
  return pageShell({
    title: view.text("update.title"), locale: view.locale,
    body: `${workspaceHeader(user, view)}
      <header class="topbar"><div><h1>${view.text("update.title")}</h1><p>${escapeHtml(baseUrl)}</p></div></header>
      <main id="main-content" class="settings-page artifact-view">
        <section class="meta-card"><h2>${view.text("update.installed")}</h2><p>Artifacty <strong data-update-version>${escapeHtml(status.currentVersion || APP_VERSION)}</strong></p>
          <p>${view.text("update.help")}</p>
          <form method="post" action="/admin/update/check">${localeInput(view.locale)}<button type="submit"${active ? " disabled" : ""} class="btn btn-outline-secondary">${view.text("update.check")}</button></form>
        </section>
        ${check ? `<section class="meta-card">${hasUpdate ? `<h2>${view.text("update.latest")}</h2><p>${escapeHtml(status.currentVersion || APP_VERSION)} → <strong>${escapeHtml(check.targetVersion)}</strong></p>` : ""}
          ${hasUpdate ? `<p><a href="https://github.com/raeseoklee/artifacty/releases/tag/v${escapeAttribute(encodeURIComponent(check.targetVersion))}" target="_blank" rel="noopener noreferrer">${view.text("update.releaseNotes")}</a></p>` : ""}
          ${check.errorCode ? `<p role="alert">${view.text("update.checkFailed")}</p>` : !check.supported ? `<p>${view.text("update.unsupported")}</p><p>${view.text(check.reasonCode === "SYSTEM_UPDATE_REQUIRES_ADMIN" ? "update.systemManual" : "update.manual")}</p>` : !hasUpdate && !check.errorCode && check.targetVersion ? `<p>${view.text("update.current")}</p>` : ""}
          ${check.supported && check.updateAvailable && !canStart && !active && !check.errorCode && status.currentVersion !== check.targetVersion ? `<p>${view.text("update.checkAgain")}</p>` : ""}
          ${canStart ? `<p>${view.text("update.available", { version: check.targetVersion })}</p><p>${view.text("update.backup")}</p>
            <form class="editor-form" method="post" action="/admin/update/start">${localeInput(view.locale)}
              <input type="hidden" name="confirmationId" value="${escapeAttribute(check.confirmationId)}">
              <input type="hidden" name="targetVersion" value="${escapeAttribute(check.targetVersion)}">
              <label><input type="checkbox" name="confirmUpdate" value="true" required class="form-check-input"> ${view.text("update.confirm")}</label>
              ${check.expiresAt ? `<p class="muted">${view.text("update.expires")}: ${renderDateTime(check.expiresAt, view)}</p>` : ""}
              <button type="submit" class="btn btn-primary">${view.text("update.start")}</button>
            </form>` : ""}
        </section>` : ""}
        ${run ? `<section class="meta-card" data-update-status data-active="${active}" data-messages="${escapeAttribute(JSON.stringify(messages))}"><h2>${view.text("update.progress")}</h2>
          <p>${view.text("update.latest")}: ${escapeHtml(run.targetVersion || "—")}</p>
          <p role="status" aria-live="polite" data-update-state>${escapeHtml(states[run.state] || states.running)}</p>
          <p data-update-step aria-live="polite">${escapeHtml(progressLabel)}</p>
          <div class="progress" role="progressbar" data-update-progress aria-label="${view.text("update.progressLabel")}" aria-valuemin="0" aria-valuemax="5"${progressValue === null ? "" : ` aria-valuenow="${progressValue}"`} aria-valuetext="${escapeAttribute(progressLabel)}">
            <div data-update-bar class="progress-bar${progressValue === null && active ? " progress-bar-striped progress-bar-animated" : ""}${["failed", "interrupted"].includes(run.state) ? " bg-danger" : ""}" style="width: ${progressValue === null ? 100 : progressValue * 20}%"></div>
          </div>
          <p class="muted">${view.text("update.progressHelp")}</p>
          <p data-update-error>${escapeHtml(run.error || "")}</p>
          <a href="${view.href("/admin/update")}">${view.text("update.refresh")}</a> <a data-update-login hidden href="${view.href("/login")}">${view.text("nav.signIn")}</a>
        </section>` : ""}
      </main>`,
    afterBody: active ? '<script type="module" src="/assets/update.js"></script>' : ""
  });
}

export function renderAccessModePreviewPage({ user, baseUrl, mode, artifacts = [], anonymousArtifactCount = 0, locale = DEFAULT_LOCALE, currentPath = "/admin/access/preview" }) {
  const view = viewContext(locale, currentPath);
  const isPublic = mode === "public";
  return pageShell({ title: view.raw("access.previewTitle"), locale: view.locale,
    body: `<header class="topbar"><div><h1>${view.text("access.previewTitle")}</h1><p>${escapeHtml(baseUrl)}</p></div>
      <nav><a href="${view.href(`/admin/access?mode=${isPublic ? "public" : "private"}`)}">${view.text("access.backToSettings")}</a></nav></header>
      <main id="main-content" class="dashboard">
        <section class="meta-card" role="status"><h2>${view.text(isPublic ? "access.public" : "access.private")}</h2>
          <p>${view.text("access.previewAnonymous")}</p><p>${view.text("access.previewUnsaved")}</p>
        </section>
        ${isPublic ? `<div class="dashboard-heading"><h1>${view.text("nav.artifacts")}</h1></div>
          <p class="muted">${view.text("access.previewListCount", { shown: artifacts.length, total: anonymousArtifactCount })}</p>
          <section class="artifact-list">${renderArtifactRows(artifacts, "", view, true) || `<div class="empty">${view.text("dashboard.empty")}</div>`}</section>`
          : `<section class="meta-card"><h2>${view.text("access.previewSignIn")}</h2><p>${view.text("access.previewPrivate")}</p></section>`}
      </main>` });
}

export function renderAdminAccessPage({ baseUrl, user, mode, teams = [], users = [], networkPolicy = { allowedCidrs: [] }, currentIp = "", preview = null, pendingNetworkPolicy = null, shareLinkPolicy = {}, locale = DEFAULT_LOCALE, currentPath = "/admin/access" }) {
  const view = viewContext(locale, currentPath);
  return pageShell({
    title: view.text("access.title"),
    locale: view.locale,
    body: `${workspaceHeader(user, view)}
      <header class="topbar"><div><h1>${view.text("access.title")}</h1><p>${escapeHtml(baseUrl)}</p></div>
      </header>
      <main id="main-content" class="settings-page artifact-view">
        <section class="meta-card"><h2>${view.text("access.mode")}</h2>
          <form class="editor-form" method="post" action="/admin/access/preview">${localeInput(view.locale)}
            <label><input type="radio" name="mode" value="public"${(preview?.mode || mode) === "public" ? " checked" : ""} class="form-check-input"> ${view.text("access.public")}</label>
            <p class="muted">${view.text("access.publicHelp")}</p>
            <label><input type="radio" name="mode" value="private"${(preview?.mode || mode) === "private" ? " checked" : ""} class="form-check-input"> ${view.text("access.private")}</label>
            <p class="muted">${view.text("access.privateHelp")}</p>
            <button type="submit" class="btn btn-outline-secondary">${view.text("access.preview")}</button>
          </form>
        </section>
        ${preview ? `<section class="meta-card"><h2>${view.text("access.preview")}</h2><p>${view.text("access.previewCount", { count: preview.anonymousArtifactCount, mode: preview.mode })}</p>
          <form method="post" action="/admin/access">${localeInput(view.locale)}<input type="hidden" name="mode" value="${escapeAttribute(preview.mode)}"><button type="submit" class="btn btn-primary">${view.text("access.save")}</button></form></section>` : ""}
        <section class="meta-card"><h2>${view.text("sharing.links")}</h2><form class="editor-form" method="post" action="/admin/access/share-links">${localeInput(view.locale)}
          <label><input type="checkbox" name="enabledInPrivate" value="true"${shareLinkPolicy.enabledInPrivate ? " checked" : ""} class="form-check-input"> ${view.text("sharing.enablePrivate")}</label><footer class="editor-actions"><button type="submit" class="btn btn-primary">${view.text("access.save")}</button></footer></form></section>
        ${pendingNetworkPolicy ? `<section class="meta-card"><h2>${view.text("access.pendingNetwork")}</h2><p>${view.text("access.pendingHelp", { expiresAt: pendingNetworkPolicy.expiresAt })}</p>
          ${["confirm", "rollback"].map((action) => `<form method="post" action="/admin/access/network/${action}">${localeInput(view.locale)}<input type="hidden" name="id" value="${escapeAttribute(pendingNetworkPolicy.id)}"><button type="submit" class="btn btn-outline-secondary">${view.text(`access.${action}`)}</button></form>`).join("")}</section>` : ""}
        <section class="meta-card"><h2>${view.text("access.network")}</h2>
          <p class="muted">${view.text("access.networkHelp")}</p>
          <p>${view.text("access.currentIp")}: <code>${escapeHtml(currentIp)}</code></p>
          <form class="editor-form" method="post" action="/admin/access/network">${localeInput(view.locale)}
            <label class="field"><span>${view.text("access.allowedCidrs")}</span><textarea name="allowedCidrs" rows="5" class="form-control">${escapeHtml((networkPolicy.allowedCidrs || []).join("\n"))}</textarea></label>
            <label><input type="checkbox" name="allowSharedLinks" value="true"${networkPolicy.allowSharedLinks ? " checked" : ""} class="form-check-input" aria-describedby="shared-network-help"> ${view.text("access.allowSharedLinks")}</label>
            <p id="shared-network-help" class="muted">${view.text("access.sharedNetworkHelp")}</p>
            <button type="submit" class="btn btn-primary">${view.text("access.saveNetwork")}</button>
          </form>
        </section>
        <section class="meta-card"><h2>${view.text("access.teams")}</h2>
          <form class="editor-form auth-form" method="post" action="/admin/teams">${localeInput(view.locale)}
            <label class="field"><span>${view.text("access.teamName")}</span><input name="name" required class="form-control"></label>
            <button type="submit" class="btn btn-primary">${view.text("access.createTeam")}</button>
          </form>
          ${teams.length ? teams.map((team) => `<section><h3>${escapeHtml(team.name)}</h3>
            <form class="editor-form" method="post" action="/admin/teams/${encodeURIComponent(team.id)}/members">${localeInput(view.locale)}
              <fieldset><legend>${view.text("access.members")}</legend>${accessCheckboxes(users, "userIds", team.memberIds || [], view)}</fieldset>
              <button type="submit" class="btn btn-primary">${view.text("access.saveMembers")}</button>
            </form></section>`).join("") : `<p class="muted">${view.text("access.noTeams")}</p>`}
        </section>
        <section class="meta-card"><h2>${view.text("access.samples")}</h2><p>${view.text("access.samplesHelp")}</p>
          ${["install", "remove"].map((action) => `<form method="post" action="/admin/samples/${action}">${localeInput(view.locale)}<button type="submit" class="btn btn-outline-secondary">${view.text(`access.samples.${action}`)}</button></form>`).join("")}</section>
      </main>`
  });
}

export function renderArtifactSharingPage({ baseUrl, user, artifact, sharing = { userIds: [], teamIds: [] }, users = [], teams = [], accessReport = null, collectionPreview = null, shareLinks = [], createdShareLink = null, networkPolicy = { allowedCidrs: [] }, locale = DEFAULT_LOCALE, currentPath = "/" }) {
  const view = viewContext(locale, currentPath);
  return pageShell({
    title: view.text("sharing.title"),
    locale: view.locale,
    body: `${workspaceHeader(user, view)}
      <header class="topbar"><div><h1>${view.text("sharing.title")}: ${escapeHtml(artifact.title)}</h1><p>${escapeHtml(baseUrl)}</p></div>
      <nav><a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}`)}">${view.text("nav.artifact")}</a></nav></header>
      <main id="main-content" class="settings-page artifact-view"><section class="meta-card">
        <p>${view.text("sharing.help")}</p>
        <form class="editor-form" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/sharing">${localeInput(view.locale)}
          <fieldset><legend>${view.text("sharing.users")}</legend>${accessCheckboxes(users, "userIds", sharing.userIds || [], view, sharing.userPermissions || {})}</fieldset>
          <fieldset><legend>${view.text("sharing.teams")}</legend>${accessCheckboxes(teams, "teamIds", sharing.teamIds || [], view, sharing.teamPermissions || {})}</fieldset>
          <button type="submit" class="btn btn-outline-secondary">${view.text("sharing.save")}</button>
        </form>
      </section>
      ${accessReport && (user?.role === "admin" || user?.id === artifact.ownerUserId) ? `<section class="meta-card"><h2>${view.text("sharing.effective")}</h2><p>${view.text("sharing.networkCondition")}: ${escapeHtml(networkPolicy.allowedCidrs?.length ? networkPolicy.allowedCidrs.join(", ") : view.text("sharing.unrestricted"))}</p><p>${view.text("sharing.anonymous")}: ${view.text(accessReport.anonymousRead ? "sharing.allowed" : "sharing.denied")}</p>
        <table><thead><tr><th>${view.text("sharing.users")}</th><th>${view.text("sharing.permission")}</th><th>${view.text("sharing.reason")}</th></tr></thead><tbody>${accessReport.users.map((item) => `<tr><td>${escapeHtml(item.name || item.email || item.id)}</td><td>${view.text(`sharing.permission.${item.permission}`)}</td><td>${escapeHtml(item.reasons.join(", "))}</td></tr>`).join("")}</tbody></table></section>` : ""}
      ${collectionPreview ? `<section class="meta-card"><h2>${view.text("collection.audience")}</h2><p>${view.text("collection.audienceHelp")}</p>
        <form class="editor-form" method="get" action="/artifacts/${encodeURIComponent(artifact.id)}/sharing">${localeInput(view.locale)}
          <label class="field"><span>${view.text("collection.recipient")}</span><select class="form-select" name="previewUser"><option value="">${view.text("sharing.anonymous")}</option>${(accessReport?.users || []).filter(item => item.active).map(item => `<option value="${escapeAttribute(item.id)}"${collectionPreview.userId === item.id ? " selected" : ""}>${escapeHtml(item.name || item.email || item.id)}</option>`).join("")}</select></label>
          <button class="btn btn-outline-secondary" type="submit">${view.text("collection.preview")}</button></form>
        <p>${view.text("collection.readableCount", { visible: collectionPreview.visible, total: collectionPreview.total })}</p>
        <p class="muted">${view.text(collectionPreview.parentReadable ? "collection.parentReadable" : "collection.parentRestricted")}</p></section>` : ""}
      <section class="meta-card"><h2>${view.text("sharing.links")}</h2><p>${view.text("sharing.linksHelp")}</p>
        ${createdShareLink?.token ? `<p>${view.text("sharing.copyNow")}</p><a href="${escapeAttribute(`${baseUrl.replace(/\/$/, "")}/s/${encodeURIComponent(createdShareLink.token)}`)}">${escapeHtml(`${baseUrl.replace(/\/$/, "")}/s/${encodeURIComponent(createdShareLink.token)}`)}</a>` : ""}
        <form class="editor-form" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/share-links">${localeInput(view.locale)}
          <label class="field"><span>${view.text("sharing.version")}</span><select name="version" class="form-select"><option value="latest">${view.text("sharing.latest")}</option>${(artifact.versions || []).map((item) => `<option value="${Number(item.version)}">v${Number(item.version)}</option>`).join("")}</select></label>
          <label class="field"><span>${view.text("sharing.days")}</span><input type="number" name="days" min="1" max="365" value="7" required class="form-control"></label><button type="submit" class="btn btn-outline-secondary">${view.text("sharing.createLink")}</button></form>
        ${shareLinks.map((link) => `<section><p>${escapeHtml(link.id)} · ${link.version == null ? view.text("sharing.latest") : `v${Number(link.version)}`} · ${view.text("sharing.expires")}: ${renderDateTime(link.expiresAt, view)}</p>
          ${link.revokedAt ? `<p>${view.text("sharing.revoked")}</p>` : `<form method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/share-links/${encodeURIComponent(link.id)}/revoke">${localeInput(view.locale)}<button type="submit" class="btn btn-outline-danger">${view.text("sharing.revoke")}</button></form>`}</section>`).join("")}
      </section></main>`
  });
}

function accessCheckboxes(items, name, selectedIds, view, permissions = null) {
  if (!items.length) return `<p class="muted">${view.text(name === "userIds" ? "access.noUsers" : "access.noTeams")}</p>`;
  return items.filter((item) => item.active !== false).map((item) => {
    const label = `${escapeHtml(item.name || item.email || item.id)}${item.email && item.name ? ` (${escapeHtml(item.email)})` : ""}`;
    const checkbox = `<label class="share-principal-name"><input type="checkbox" name="${name}" value="${escapeAttribute(item.id)}"${selectedIds.includes(item.id) ? " checked" : ""} class="form-check-input"> ${label}</label>`;
    if (!permissions) return checkbox;
    // One row per person or team: the name on the leading side, its permission
    // on the trailing side. The select keeps a spoken label for screen readers.
    return `<div class="share-principal">${checkbox}<label class="share-principal-permission"><span class="visually-hidden">${view.text("sharing.permission")}: ${label}</span><select name="${name === "userIds" ? "userPermission" : "teamPermission"}:${escapeAttribute(item.id)}" class="form-select">${["read", "comment", "edit"].map((permission) => `<option value="${permission}"${(permissions[item.id] || "read") === permission ? " selected" : ""}>${view.text(`sharing.permission.${permission}`)}</option>`).join("")}</select></label></div>`;
  }).join("");
}

export function renderInboxPage({ baseUrl, user, notifications = [], unreadCount = 0, locale = DEFAULT_LOCALE, currentPath = "/inbox" }) {
  const view = viewContext(locale, currentPath);
  return pageShell({ title: view.text("inbox.title"), locale: view.locale,
    body: `${workspaceHeader(user, view)}
      <header class="topbar"><div><h1>${view.text("inbox.title")}</h1><p>${escapeHtml(baseUrl)}</p></div></header>
      <main id="main-content" class="artifact-view inbox-view">
        <div class="inbox-toolbar"><p class="muted">${view.text("inbox.unread", { count: unreadCount })}</p>
          <form method="post" action="/inbox/read-all">${localeInput(view.locale)}<button type="submit" class="btn btn-outline-secondary">${view.text("inbox.readAll")}</button></form></div>
        ${notifications.length ? `<ul class="inbox-list">${notifications.map((item) => `<li class="inbox-item${item.readAt ? "" : " is-unread"}"><div class="inbox-item-main"><h2><a href="${view.href(`/artifacts/${encodeURIComponent(item.artifactId)}`)}">${escapeHtml(item.title)}</a></h2><p class="inbox-item-meta">${["shared-with-me", "comment", "new-version", "review-requested", "access-requested"].includes(item.type) ? view.text(`inbox.type.${item.type}`) : escapeHtml(item.type)} · ${renderDateTime(item.createdAt, view)}</p>
          ${item.type === "access-requested" ? `<p>${view.text("inbox.accessRequested", { name: item.requester?.name || item.requester?.email || "", email: item.requester?.email || "" })}</p><p><a href="${view.href(`/artifacts/${encodeURIComponent(item.artifactId)}/sharing`)}">${view.text("inbox.openSharing")}</a></p>` : ""}</div>
          <div class="inbox-item-action">${item.readAt ? `<p class="muted">${view.text("inbox.read")}</p>` : `<form method="post" action="/inbox/${encodeURIComponent(item.id)}/read">${localeInput(view.locale)}<button type="submit" class="btn btn-ghost">${view.text("inbox.markRead")}</button></form>`}</div></li>`).join("")}</ul>` : `<p class="empty inbox-empty">${view.text("inbox.empty")}</p>`}
      </main>` });
}

export function renderSharedArtifactPage({ artifact, version, content, locale = DEFAULT_LOCALE, sharePath, collection = null }) {
  const view = viewContext(locale, sharePath);
  const rendered = version.format === "collection" ? renderCollection(collection, view, { shared: true }) : version.format === "html"
    ? `<p>${view.text("sharing.staticPreview")}</p><iframe class="artifact-frame" sandbox="" referrerpolicy="no-referrer" src="${escapeAttribute(`${sharePath}/raw`)}"></iframe>`
    : ["react", "notebook", "svg", "mermaid"].includes(version.format)
    ? `<p>${view.text("sharing.safeSource")}</p><pre class="artifact-code"><code>${escapeHtml(content)}</code></pre>`
    : renderContent(version.format, content, version.metadata || {}, {
      view, artifactType: artifact.artifactType,
      rawUrl: `${sharePath}/raw`,
      bundleFileUrl: (fileName) => `${sharePath}/raw?file=${encodeURIComponent(fileName)}`
    });
  const needsViewer = ["code", "markdown", "notebook", "sarif", "csv", "collection"].includes(version.format);
  return pageShell({ title: artifact.title, locale: view.locale,
    body: `<header class="topbar"><div><h1>${escapeHtml(artifact.title)}</h1><p>${view.text("sharing.readOnly")} · v${Number(version.version)}</p></div></header><main id="main-content" class="artifact-view">${rendered}</main>`,
    head: needsViewer ? editorHead() : "",
    afterBody: `${frameResizeScript()}${needsViewer ? viewerScript(view.locale) : ""}` });
}

export function renderAdminUsersPage({ baseUrl, user, users = [], importResult = null, importError = "", roleError = "", resetResult = null, resetError = "", locale = DEFAULT_LOCALE, currentPath = "/admin/users" }) {
  const view = viewContext(locale, currentPath);
  const rows = users.map((item) => `
    <tr>
      <td>${escapeHtml(item.email)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td><form class="user-role-form" method="post" action="/admin/users/${encodeURIComponent(item.id)}/role">${localeInput(view.locale)}
        <select name="role" aria-label="${view.text("users.roleFor", { email: item.email })}" class="form-select">
          ${["user", "admin"].map((role) => `<option value="${role}"${item.role === role ? " selected" : ""}>${view.text(`ui.role.${role}`)}</option>`).join("")}
        </select><button type="submit" aria-label="${view.text("users.saveRoleFor", { email: item.email })}" class="btn btn-outline-secondary">${view.text("users.saveRole")}</button>
      </form></td>
      <td>${item.active ? view.text("ui.active") : view.text("ui.disabled")}${item.passwordResetRequired ? ` · ${view.text("users.resetRequired")}` : ""}</td>
      <td>${renderDateTime(item.createdAt, view)}</td>
      <td><div class="user-account-actions">
        <form method="post" action="/admin/users/${encodeURIComponent(item.id)}/reset-password">${localeInput(view.locale)}
          <button type="submit" aria-label="${view.text("users.resetFor", { email: item.email })}" class="btn btn-ghost">${view.text("users.resetPassword")}</button>
        </form>
        ${item.id === user.id ? "" : `<form method="post" action="/admin/users/${encodeURIComponent(item.id)}/${item.active ? "disable" : "enable"}">${localeInput(view.locale)}
          <button type="submit" class="btn btn-outline-danger">${item.active ? view.text("ui.disable") : view.text("ui.enable")}</button>
        </form>`}
      </div></td>
    </tr>
  `).join("");
  const createdRows = (importResult?.created || []).map((item) => `
    <tr>
      <td>${escapeHtml(item.user.email)}</td>
      <td>${view.text(`ui.role.${item.user.role}`)}</td>
      <td>${item.user.passwordResetRequired ? view.text("ui.yes") : view.text("ui.no")}</td>
      <td>${item.passwordGenerated ? `<code>${escapeHtml(item.temporaryPassword)}</code>` : view.text("users.provided")}</td>
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
      <h2>${view.text("users.importResults")}</h2>
      <p class="muted">${view.text("users.summary", { created: importResult.created.length, skipped: importResult.skipped.length, failed: importResult.failed.length })}</p>
      ${createdRows ? `<table class="data-table">
        <thead><tr><th>${view.text("ui.email")}</th><th>${view.text("ui.role")}</th><th>${view.text("users.resetRequired")}</th><th>${view.text("users.temporaryPassword")}</th></tr></thead>
        <tbody>${createdRows}</tbody>
      </table>` : ""}
      ${skippedRows ? `<h3>${view.text("users.skipped")}</h3><table class="data-table">
        <thead><tr><th>${view.text("ui.row")}</th><th>${view.text("ui.email")}</th><th>${view.text("ui.reason")}</th></tr></thead>
        <tbody>${skippedRows}</tbody>
      </table>` : ""}
      ${failedRows ? `<h3>${view.text("users.failed")}</h3><table class="data-table">
        <thead><tr><th>${view.text("ui.row")}</th><th>${view.text("ui.email")}</th><th>${view.text("ui.error")}</th></tr></thead>
        <tbody>${failedRows}</tbody>
      </table>` : ""}
    </section>
  ` : "";

  return pageShell({
    title: view.raw("nav.users"),
    body: `
      ${workspaceHeader(user, view)}
      <header class="topbar">
        <div>
          <h1>${view.text("nav.users")}</h1>
          <p>${escapeHtml(baseUrl)}</p>
        </div>

      </header>
      <main id="main-content" class="settings-page artifact-view">
        ${resetError ? `<p class="auth-error" role="alert">${escapeHtml(resetError)}</p>` : ""}
        ${resetResult ? `<section class="token-once" role="status"><h2>${view.text("users.resetReady")}</h2>
          <p>${view.text("users.resetAccount", { email: resetResult.user.email })}</p>
          <pre class="artifact-code"><code>${escapeHtml(resetResult.temporaryPassword)}</code></pre>
          <p>${view.text("users.resetHelp")}</p>
          <p>${view.text(`smtp.mailStatus.${["sent", "failed", "not-configured"].includes(resetResult.mailStatus) ? resetResult.mailStatus : "not-configured"}`)}</p>
        </section>` : ""}
        <section class="meta-card">
          <h2>${view.text("users.create")}</h2>
          <form class="editor-form auth-form" method="post" action="/admin/users">
            <section class="editor-fields">
              <label class="field"><span>${view.text("ui.email")}</span><input type="email" name="email" required class="form-control"></label>
              <label class="field"><span>${view.text("ui.name")}</span><input name="name" class="form-control"></label>
              <label class="field"><span>${view.text("ui.role")}</span><select name="role" class="form-select"><option value="user">${view.text("ui.role.user")}</option><option value="admin">${view.text("ui.role.admin")}</option></select></label>
              <label class="field"><span>${view.text("ui.password")}</span><input type="password" name="password" minlength="8" required class="form-control"></label>
              <label class="check-field"><input type="checkbox" name="passwordResetRequired" class="form-check-input"> ${view.text("users.requirePassword")}</label>
            </section>
            <footer class="editor-actions"><button type="submit" class="btn btn-primary">${view.text("users.create")}</button></footer>
          </form>
        </section>
        <section class="meta-card">
          <h2>${view.text("users.importTitle")}</h2>
          <p class="muted">${view.text("users.csvHelp")}</p>
          ${importError ? `<p class="auth-error">${escapeHtml(importError)}</p>` : ""}
          <form class="editor-form" method="post" action="/admin/users/import">
            <label class="field content-field">
              <span>CSV</span>
              <textarea class="compact-textarea form-control" name="csv" spellcheck="false" placeholder="email,name,role&#10;user@example.com,User,user" required></textarea>
            </label>
            <footer class="editor-actions"><button type="submit" class="btn btn-outline-secondary">${view.text("users.import")}</button></footer>
          </form>
        </section>
        ${importSummary}
        <section class="meta-card">
          <h2>${view.text("users.existing")}</h2>
          ${roleError ? `<p class="auth-error" role="alert">${escapeHtml(roleError)}</p>` : ""}
          <p class="muted">${view.text("users.lastAdmin")}</p>
          <div class="artifact-table-scroll"><table class="data-table">
            <thead><tr><th>${view.text("ui.email")}</th><th>${view.text("ui.name")}</th><th>${view.text("ui.role")}</th><th>${view.text("ui.status")}</th><th>${view.text("ui.created")}</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        </section>
      </main>
    `,
    locale: view.locale
  });
}

export function renderAdminWebhooksPage({ user, baseUrl, webhooks = [], createdSecret = null, createdWebhookId = null, locale = DEFAULT_LOCALE, currentPath = "/admin/webhooks" }) {
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
          <button type="submit" class="btn btn-outline-danger">${view.text("webhooks.delete")}</button>
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
      ${workspaceHeader(user, view)}
      <header class="topbar">
        <div>
          <h1>${view.text("webhooks.title")}</h1>
          <p>${escapeHtml(baseUrl)}</p>
        </div>

      </header>
      <main id="main-content" class="settings-page artifact-view">
        ${secretBanner}
        <section class="meta-card">
          <h2>${view.text("webhooks.createTitle")}</h2>
          <form class="editor-form" method="post" action="/admin/webhooks">
            <section class="editor-fields">
              <label class="field"><span>${view.text("webhooks.url")}</span><input type="url" name="url" placeholder="https://example.com/hooks/artifacty" required class="form-control"></label>
              <label class="field"><span>${view.text("webhooks.eventTypes")}</span><input name="eventTypes" placeholder="${view.text("webhooks.eventTypesPlaceholder")}" class="form-control"></label>
            </section>
            <footer class="editor-actions"><button type="submit" class="btn btn-outline-secondary">${view.text("webhooks.create")}</button></footer>
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

export function renderAdminRetentionPage({ user, baseUrl, policy, lastSweep = null, report = null, locale = DEFAULT_LOCALE, currentPath = "/admin/retention" }) {
  const view = viewContext(locale, currentPath);
  const byTypeText = Object.entries(policy.archiveAfterDays.byType || {})
    .map(([type, days]) => `${type}=${days}`)
    .join("\n");

  const lastSweepSection = lastSweep ? `
    <section class="meta-card">
      <h2>${view.text("retention.lastSweepTitle")}</h2>
      <table class="data-table">
        <tbody>
          <tr><th>${view.text("retention.sweepAt")}</th><td>${renderDateTime(lastSweep.createdAt, view)}</td></tr>
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
      ${workspaceHeader(user, view)}
      <header class="topbar">
        <div>
          <h1>${view.text("retention.title")}</h1>
          <p>${escapeHtml(baseUrl)}</p>
        </div>

      </header>
      <main id="main-content" class="settings-page artifact-view">
        <section class="meta-card">
          <h2>${view.text("retention.policyTitle")}</h2>
          <form class="editor-form retention-policy-form" method="post" action="/admin/retention">${localeInput(view.locale)}
            <fieldset class="retention-section"><legend>${view.text("retention.artifactsSection")}</legend>
              <div class="retention-field-grid">
                <label class="field"><span>${view.text("retention.archiveAfterDaysDefault")}</span><input type="number" min="1" name="archiveAfterDaysDefault" value="${policy.archiveAfterDays.default ?? ""}" class="form-control"></label>
                <label class="field"><span>${view.text("retention.purgeArchivedAfterDays")}</span><input type="number" min="1" name="purgeArchivedAfterDays" value="${policy.purgeArchivedAfterDays ?? ""}" class="form-control"></label>
              </div>
              <label class="field"><span>${view.text("retention.keepTags")}</span><input name="keepTags" value="${escapeAttribute((policy.keepTags || []).join(", "))}" placeholder="pinned, release" class="form-control"></label>
            </fieldset>
            <fieldset class="retention-section"><legend>${view.text("retention.typeRulesSection")}</legend>
              <label class="field"><span>${view.text("retention.archiveAfterDaysByType")}</span><textarea class="compact-textarea form-control" name="archiveAfterDaysByType" placeholder="test-report=30">${escapeHtml(byTypeText)}</textarea></label>
            </fieldset>
            <fieldset class="retention-section"><legend>${view.text("retention.historySection")}</legend>
              <div class="retention-field-grid">
                <label class="field"><span>${view.text("retention.auditRetentionDays")}</span><input type="number" min="1" name="auditRetentionDays" value="${policy.auditRetentionDays ?? ""}" class="form-control"></label>
                <label class="field"><span>${view.text("retention.eventRetentionRows")}</span><input type="number" min="1" name="eventRetentionRows" value="${policy.eventRetentionRows ?? ""}" class="form-control"></label>
              </div>
            </fieldset>
            <footer class="editor-actions"><button type="submit" class="btn btn-primary">${view.text("retention.saveButton")}</button></footer>
          </form>
        </section>
        ${lastSweepSection}
        <section class="meta-card">
          <h2>${view.text("retention.runTitle")}</h2>
          <p class="auth-warning">${view.text("retention.purgeGateNote")}</p>
          <form class="editor-form" method="post" action="/admin/retention/run">
            <label class="checkbox-field"><input type="checkbox" name="dryRun" value="1" checked class="form-check-input"> ${view.text("retention.dryRunLabel")}</label>
            <label class="checkbox-field"><input type="checkbox" name="allowPurge" value="1" class="form-check-input"> ${view.text("retention.allowPurgeLabel")}</label>
            <footer class="editor-actions"><button type="submit" class="btn btn-outline-secondary">${view.text("retention.runButton")}</button></footer>
          </form>
        </section>
        ${reportSection}
      </main>
    `,
    locale: view.locale
  });
}

export function renderArtifactPage({ artifact, version, content, comments = [], baseUrl, authToken = "", locale = DEFAULT_LOCALE, currentPath = "/", user = null, permission = null, collection = null }) {
  const view = viewContext(locale, currentPath);
  const canEdit = permission == null || ["edit", "owner", "admin"].includes(permission);
  const canComment = canEdit || permission === "comment";
  const canArchive = permission == null || ["owner", "admin"].includes(permission);
  const versionLinks = artifact.versions
    .map((item) => {
      const active = item.version === version.version ? " active" : "";
      return `<a class="version${active}" href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}?version=${item.version}`)}">v${item.version}</a>`;
    })
    .join("");

  const rendered = version.format === "collection" ? renderCollection(collection, view) : renderContent(version.format, content, version.metadata || {}, {
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
    version.format === "sarif" || version.format === "csv" || version.format === "collection" || comments.length > 0;
  const rawUrl = `/artifacts/${encodeURIComponent(artifact.id)}/raw?version=${version.version}`;
  const archiveAction = artifact.archivedAt ? "restore" : "archive";
  const archiveLabel = artifact.archivedAt ? view.text("artifact.restore") : view.text("artifact.archive");
  const publisher = publisherDisplay(artifact, view);
  const canManageVisibility = !user || user.role === "admin" || (artifact.ownerUserId && user.id === artifact.ownerUserId);
  const visibilityForm = canManageVisibility
    ? `<form class="visibility-form" data-visibility data-saving="${view.text("artifact.visibility.saving")}" data-saved="${view.text("artifact.visibility.saved")}" data-failed="${view.text("artifact.visibility.failed")}" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/visibility">
        ${hiddenToken(authToken)}
        ${localeInput(view.locale)}
        <label>
          <span>${view.text("artifact.visibility.label")}</span>
          ${visibilitySelect(artifact.visibility || "team", view)}
        </label>
        <button type="submit" class="btn btn-outline-secondary">${view.text("artifact.visibility.change")}</button><span data-visibility-feedback role="status" aria-live="polite"></span>
      </form><p class="muted">${view.text("artifact.visibility.help")}</p>`
    : "";

  const archiveForm = canArchive ? `<form class="inline-action" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/${archiveAction}">
          ${hiddenToken(authToken)}
          ${localeInput(view.locale)}
          <button type="submit" class="btn btn-outline-secondary">${archiveLabel}</button>
        </form>` : "";
  const manageInline = !["collection", "explainer"].includes(version.format);

  return pageShell({
    title: artifact.title,
    body: `
      ${workspaceHeader(user, view)}
      <header class="topbar">
        <div>
          <h1>${escapeHtml(artifact.title)}</h1>
          <p>${escapeHtml(artifact.id)} · ${escapeHtml(artifact.sourceAgent)} · ${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <details class="toolbar-more" data-menu>
            <summary aria-label="${view.text("nav.more")}" title="${view.text("nav.more")}">${uiIcon("dots")}</summary>
            <div class="toolbar-menu">
              ${user ? `<a href="${view.href(`/categories?artifactId=${encodeURIComponent(artifact.id)}`)}">${view.text("category.title")}</a>` : ""}
              ${(user || canEdit) && version.format !== "explainer" ? `<a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}/explain?version=${version.version}`)}">${view.text("explainer.create")}</a>` : ""}
              <a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}/diff`)}">${view.text("nav.diff")}</a>
              ${user?.role === "admin" ? `<a href="${view.href(`/admin/artifacts/${encodeURIComponent(artifact.id)}/versions`)}">${view.text("nav.versions")}</a>` : ""}
              <a href="${view.href(rawUrl)}">${view.text("nav.raw")}</a>
            </div>
          </details>
          ${user && canManageVisibility ? `<a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}/sharing`)}">${view.text("sharing.title")}</a>` : ""}
          ${canEdit ? `<a class="is-primary" href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}/edit?version=${version.version}`)}">${view.text("nav.edit")}</a>` : ""}


        </nav>
      </header>
      <main id="main-content" class="${viewClass}">
        <section class="meta-strip artifact-overview">
          <span>${escapeHtml(version.format)} · v${version.version}</span>
          ${artifact.archivedAt ? statusBadge(view.text("artifact.archived", { date: artifact.archivedAt })) : ""}
          ${visibilityBadge(artifact, view)}
          <details class="artifact-details"><summary>${view.text("artifact.details")}</summary><div class="meta-strip">
            ${typeBadge(artifact.artifactType || "document")}
            <span>${view.text("artifact.schema", { version: artifact.schemaVersion || 1 })}</span>
            <span title="${escapeAttribute(publisherTitle(artifact, view))}">${view.text("artifact.publisher", { publisher })}</span>
            <span>${view.text("artifact.bytes", { size: version.sizeBytes })}</span>
            <span>${renderDateTime(version.createdAt, view)}</span>
            <span>${escapeHtml(version.sha256.slice(0, 12))}</span>
          </div></details>
          ${manageInline && (canArchive || canManageVisibility) ? `<details class="artifact-manage"><summary>${view.text("artifact.manage")}</summary><div class="artifact-manage-panel">${archiveForm}${visibilityForm}</div></details>` : ""}
        </section>
        ${["collection", "explainer"].includes(version.format) && (canArchive || canManageVisibility) ? `<details class="collection-management"><summary>${view.text("collection.settings")}</summary><div>` : ""}
        ${manageInline ? "" : archiveForm}
        ${manageInline ? "" : visibilityForm}
        ${version.format === "collection" && (canArchive || canManageVisibility) ? "</div></details>" : ""}
        ${renderProvenance(artifact, version, view)}
        <section class="version-strip">${versionLinks}</section>
        ${version.format === "explainer" && (canArchive || canManageVisibility) ? "</div></details>" : ""}
        ${rendered}
        ${renderRelationsSection(artifact, view)}
        ${renderCommentsSection(artifact, comments, view, { version: version.version, authToken, canModerate: canManageVisibility, canComment, sourceContent: ["text", "code", "markdown"].includes(version.format) ? content : null })}
      </main>
    `,
    head: needsViewerScript ? editorHead() : "",
    afterBody: `${frameResizeScript()}<script type="module" src="/assets/comment-lines.js"></script>${needsViewerScript ? viewerScript(view.locale) : ""}`,
    locale: view.locale
  });
}

// --- Comments and review status (roadmap section 5) -----------------------

function renderCommentsSection(artifact, comments, view, { version, authToken, canModerate, canComment = true, sourceContent }) {
  const allSourceLines = sourceContent == null ? [] : String(sourceContent).split(/\r\n|\n|\r/);
  const sourceLines = allSourceLines.slice(0, 5000);
  const lineCount = sourceLines.length;
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
    .map((groupVersion) => renderCommentVersionGroup(artifact, grouped.get(groupVersion), groupVersion, view, { activeVersion: version, authToken, canModerate, canComment, diagramState, lineCount }))
    .join("");

  return `
    <section class="comments">
      <h2>${view.text("comments.title")}</h2>
      <div class="comment-review-status">
        ${canModerate ? "" : reviewStatusBadge(artifact, view)}
        ${canModerate ? renderReviewStatusForm(artifact, view, authToken) : ""}
      </div>
      ${lineCount ? `<details class="comment-source" data-comment-source data-source-version="${version}"><summary>${view.text("comments.sourceLines")}</summary><p class="muted">${view.text("comments.sourceHelp")}</p>${allSourceLines.length > lineCount ? `<p>${view.text("comments.sourceLimit")} <a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}/raw?version=${version}`)}">${view.text("nav.raw")}</a></p>` : ""}<ol>${sourceLines.map((line, index) => `<li id="source-line-${index + 1}" data-source-line="${index + 1}"><button type="button" data-select-source-line="${index + 1}" aria-pressed="false" aria-label="${view.attr("comments.selectLine", { line: index + 1 })}">${index + 1}</button><code>${escapeHtml(line) || " "}</code></li>`).join("")}</ol></details>` : ""}
      ${comments.length === 0 ? `<p class="comments-empty">${view.text("comments.empty")}</p>` : groups}
      ${!canComment || versions.includes(version) ? "" : renderCommentForm(artifact, view, { version, authToken, lineCount })}
    </section>
  `;
}

function renderCommentVersionGroup(artifact, versionComments, groupVersion, view, { activeVersion, authToken, canModerate, canComment, diagramState, lineCount }) {
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
    .map((root) => renderCommentThread(artifact, root, repliesByParent.get(root.id) || [], view, { authToken, canModerate, allowReply: isActiveVersion && canComment, canComment, diagramState, lineCount }))
    .join("");

  return `
    <div class="comment-version-group">
      <h3>${view.text("comments.version", { version: groupVersion })}</h3>
      <ul class="comment-list">${items}</ul>
      ${isActiveVersion && canComment ? renderCommentForm(artifact, view, { version: groupVersion, authToken, lineCount }) : ""}
    </div>
  `;
}

function renderCommentThread(artifact, root, replies, view, { authToken, canModerate, allowReply, canComment, diagramState, lineCount }) {
  const replyItems = replies
    .map((reply) => renderCommentEntry(artifact, reply, view, { authToken, canModerate, canComment, isReply: true, diagramState, lineCount }))
    .join("");
  const replyForm = allowReply
    ? `<details class="comment-reply-toggle"><summary>${view.text("comments.reply")}</summary>${renderCommentForm(artifact, view, { version: root.version, authToken, parentId: root.id, compact: true, lineCount })}</details>`
    : "";

  return `
    <li class="comment-thread">
      ${renderCommentEntry(artifact, root, view, { authToken, canModerate, canComment, isReply: false, diagramState, lineCount })}
      ${replyItems ? `<ul class="comment-replies">${replyItems}</ul>` : ""}
      ${replyForm}
    </li>
  `;
}

function renderCommentEntry(artifact, comment, view, { authToken, canModerate, canComment, isReply, diagramState, lineCount }) {
  const anchorLabel = commentAnchorLabel(comment.anchor, view);
  const resolved = comment.status === "resolved";
  const resolveForm = !resolved && canComment
    ? `<form class="inline-action" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/comments/${encodeURIComponent(comment.id)}/resolve">
        ${hiddenToken(authToken)}
        ${localeInput(view.locale)}
        <button type="submit" class="btn btn-outline-secondary">${view.text("comments.resolve")}</button>
      </form>`
    : "";
  const deleteForm = canModerate
    ? `<form class="inline-action" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/comments/${encodeURIComponent(comment.id)}/delete">
        ${hiddenToken(authToken)}
        ${localeInput(view.locale)}
        <button type="submit" class="btn btn-outline-secondary">${view.text("comments.delete")}</button>
      </form>`
    : "";

  return `
    <${isReply ? "li" : "div"} class="comment-item${isReply ? " comment-reply" : ""}${resolved ? " comment-resolved" : ""}">
      <div class="comment-header">
        <span class="comment-author">${escapeHtml(comment.authorLabel)}</span>
        <span class="comment-meta">${renderDateTime(comment.createdAt, view)}</span>
        ${anchorLabel ? `<span class="comment-anchor">${comment.anchor?.line && lineCount ? `<a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}?version=${encodeURIComponent(comment.version)}#source-line-${encodeURIComponent(comment.anchor.line)}`)}" data-comment-line-link="${escapeAttribute(comment.anchor.line)}" data-comment-line-version="${escapeAttribute(comment.version)}">${anchorLabel}</a>` : anchorLabel}</span>` : ""}
        ${resolved ? `<span class="badge s-archived">${view.text("comments.resolved")}</span>` : ""}
      </div>
      <div class="comment-body">${markdownToHtml(comment.body, diagramState)}</div>
      <div class="comment-actions">${resolveForm}${deleteForm}</div>
    </${isReply ? "li" : "div"}>
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

function renderCommentForm(artifact, view, { version, authToken, parentId, compact, lineCount = 0 } = {}) {
  return `
    <form class="comment-form${compact ? " comment-reply-form" : ""}" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/comments">
      ${hiddenToken(authToken)}
      ${localeInput(view.locale)}
      <input type="hidden" name="version" value="${escapeAttribute(String(version))}">
      ${parentId ? `<input type="hidden" name="parentId" value="${escapeAttribute(parentId)}">` : ""}
      <label>
        <span>${view.text(compact ? "comments.replyLabel" : "comments.bodyLabel")}</span>
        <textarea name="body" required maxlength="16384" class="form-control"></textarea>
      </label>
      ${compact || !lineCount ? "" : `<label class="comment-line-label">
        <span>${view.text("comments.lineLabel")}</span>
        <input type="number" name="line" min="1" max="${lineCount}" data-comment-line-input class="form-control">
      </label>`}
      <div class="comment-form-actions"><button type="submit" class="btn btn-primary">${view.text(compact ? "comments.reply" : "comments.submit")}</button></div>
    </form>
  `;
}

function renderReviewStatusForm(artifact, view, authToken) {
  const current = artifact.reviewStatus || "none";
  return `
    <form class="review-status-form" data-review-status data-saving="${view.text("comments.reviewSaving")}" data-saved="${view.text("comments.reviewSaved")}" data-failed="${view.text("comments.reviewFailed")}" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/review-status">
      ${hiddenToken(authToken)}
      ${localeInput(view.locale)}
      <label>
        <span>${view.text("comments.reviewStatus.label")}</span>
        <select name="status" class="form-select">
          ${REVIEW_STATUSES.map((status) => `<option value="${status}"${status === current ? " selected" : ""}>${view.text(`comments.reviewStatus.${status}`)}</option>`).join("")}
        </select>
      </label>
      <button type="submit" class="btn btn-outline-secondary">${view.text("comments.reviewStatus.change")}</button><span data-review-feedback role="status" aria-live="polite"></span>
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
  const pinnedSourceVersion = Number.isSafeInteger(entry.sourceVersion) && entry.sourceVersion > 0 ? entry.sourceVersion : undefined;
  const relationLabel = escapeHtml(entry.relation);
  const createdAt = `${view.text("relations.createdAt", { date: "" })} ${renderDateTime(entry.createdAt, view)}`;
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
      <a href="${view.href(`/artifacts/${encodeURIComponent(entry.artifactId)}${entry.relation === "derived-from" && pinnedSourceVersion ? `?version=${pinnedSourceVersion}` : ""}`)}">${escapeHtml(entry.artifact.title)}</a>
      <span class="relation-meta">${createdAt}</span>
    </li>
  `;
}

function artifactViewClass({ artifact, version }) {
  const wideFormats = new Set(["html", "svg", "mermaid", "react", "sarif", "csv", "image", "video", "notebook", "collection"]);
  const wideTypes = new Set(["dashboard", "design-option", "diff-walkthrough"]);
  const classes = ["artifact-view"];
  if (wideFormats.has(version.format) || wideTypes.has(artifact.artifactType)) {
    classes.push("artifact-view-wide");
  }
  return classes.join(" ");
}

export function renderDiffPage({ user, artifact, fromVersion, toVersion, fromContent, toContent, diffRows, view: diffView = "lines", structuredDiff, baseUrl, locale = DEFAULT_LOCALE, currentPath = "/" }) {
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
        <div>${renderContent(fromVersion.format, fromContent, {}, { view })}</div>
        <div>${renderContent(toVersion.format, toContent, {}, { view })}</div>
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
      ${workspaceHeader(user, view)}
      <header class="topbar">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(artifact.id)} · ${escapeHtml(baseUrl)}</p>
        </div>
        <nav>
          <a href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}`)}">${view.text("nav.artifact")}</a>

        </nav>
      </header>
      <main id="main-content" class="artifact-view">
        <form class="diff-form" method="get" action="/artifacts/${encodeURIComponent(artifact.id)}/diff">
          ${localeInput(view.locale)}
          <input type="hidden" name="view" value="${escapeAttribute(resolvedView)}">
          <label class="field">
            <span>${view.text("diff.from")}</span>
            <select name="from" class="form-select">${versionOptions}</select>
          </label>
          <label class="field">
            <span>${view.text("diff.to")}</span>
            <select name="to" class="form-select">${versionOptions}</select>
          </label>
          <button type="submit" class="btn btn-outline-secondary">${view.text("diff.compare")}</button>
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
  const view = options.view || viewContext(options.locale || DEFAULT_LOCALE, "/");
  if (format === "explainer") return renderExplainer(content, view);
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
    return renderNotebook(content, view);
  }

  if (format === "sarif") {
    return renderSarif(content, view);
  }

  if (format === "csv") {
    return renderCsv(content, view);
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
      <textarea hidden class="form-control">${escapeHtml(content)}</textarea>
      <pre class="artifact-code artifact-code-fallback"><code>${escapeHtml(content)}</code></pre>
    </section>`;
  }

  if (format === "react") {
    if (options.reactFrameUrl) {
      return `<iframe class="artifact-frame artifact-react-frame" sandbox="allow-scripts" src="${escapeAttribute(options.reactFrameUrl)}"></iframe>`;
    }
    return `<section class="artifact-react-disabled">
      <p>${view.text("react.disabled")}</p>
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
  <script src="${REACT_BUNDLE_PATH}"></script>
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
        // The .tsx filename is what selects TSX parsing. Babel 8 removed the
        // preset-typescript allExtensions/isTSX options that used to force it,
        // and rejects them outright, so deriving the mode from the extension
        // keeps this transform working on both Babel 7 and Babel 8.
        filename: "artifact.tsx",
        presets: [
          ["typescript", {}],
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
      ReactDOM.createRoot(rootElement).render(React.createElement(Component, {}));
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
  if (!afterBody.includes("/assets/categories.js")) afterBody += '<script type="module" src="/assets/categories.js"></script>';
  if (!afterBody.includes("/assets/explainers.js")) afterBody += '<script type="module" src="/assets/explainers.js"></script>';
  if (!afterBody.includes("/assets/collections.js")) afterBody += '<script type="module" src="/assets/collections.js"></script>';
  const darkThemeVariables = `        --bg: #1c1c1e;
        --bg-sidebar: #242426;
        --group: #2c2c2e;
        --group-edge: #333336;
        --group-hover: #353538;
        --fill: #3a3a3c;
        --chip: #323235;
        --search: #2c2c2e;
        --control: #3a3a3c;
        --control-hover: #424245;
        --control-press: #4a4a4d;
        --thumb: #636366;
        --field: #262628;
        --hover: rgba(255, 255, 255, 0.06);
        --press: rgba(255, 255, 255, 0.1);
        --separator: #38383a;
        --border: #4a4a4d;
        --label: #f5f5f7;
        --label-2: #a1a1a6;
        --label-3: #7c7c80;
        --accent: #78bfe8;
        --accent-2: #a6d6f3;
        --accent-ink: #062236;
        --accent-soft: #1d3446;
        --accent-fill: #1a6fa6;
        --accent-fill-hover: #1b74ad;
        --accent-fill-press: #155d8c;
        --accent-fill-ink: #ffffff;
        --selection: #1f3a4f;
        --ring: #78bfe8;
        --focus-ring: rgba(120, 191, 232, 0.45);
        --danger-fg: #ff8a8f;
        --danger-bg: #3a1d20;
        --danger-border: #5c2a2f;
        --danger-fill: #c62f3b;
        --success-fg: #7ed699;
        --success-bg: #16301f;
        --success-border: #24502f;
        --warning-fg: #f3c969;
        --warning-bg: #352a12;
        --warning-border: #5a4618;
        --mark-top: #cbe8f8;
        --mark-left: #78bfe8;
        --mark-right: #3d8fc4;
        --code: #161618;
        --surface: #2c2c2e;
        --code-text: #e5e5ea;
        --frame-bg: #ffffff;
        --code-viewer-edge: #3a3a3c;
        --code-viewer-filter: invert(0.88) hue-rotate(180deg);
        --shadow-control: 0 0.5px 1px rgba(0, 0, 0, 0.3);
        --shadow-thumb: 0 1px 2px rgba(0, 0, 0, 0.4);
        --shadow-pop: 0 0 0 0.5px rgba(0, 0, 0, 0.5), 0 10px 28px rgba(0, 0, 0, 0.45);
`;
  return `<!doctype html>
<html lang="${escapeAttribute(locale)}">
<head>
  <meta charset="utf-8">
  <script src="/assets/theme.js"></script><script type="module" src="/assets/auto-apply.js"></script>
  <script src="/assets/sidebar.js"></script>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>${escapeHtml(title)}</title>
  ${head}
  <style>
    /* Tokens. Colors follow Apple system grays with the brand cyan as the tint.
       Contrast (WCAG): --label-2 is 5.99:1 on --bg and 5.08:1 on --chip in light,
       6.61:1 and 4.97:1 in dark; the accent is 5.78:1 on white and 8.44:1 on #1c1c1e. */
    :root {
      color-scheme: light;
      --bg: #f5f5f7;
      --bg-sidebar: #ebebee;
      --group: #ffffff;
      --group-edge: #e3e3e7;
      --group-hover: #f2f2f4;
      --fill: #e3e3e8;
      --chip: #efeff2;
      --search: #e8e8ed;
      --control: #ffffff;
      --control-hover: #f9f9fb;
      --control-press: #e8e8ed;
      --thumb: #ffffff;
      --field: #ffffff;
      --hover: rgba(0, 0, 0, 0.05);
      --press: rgba(0, 0, 0, 0.09);
      --separator: #e3e3e7;
      --border: #d2d2d7;
      --label: #1d1d1f;
      --label-2: #636366;
      --label-3: #8e8e93;
      --accent: #0f6aa6;
      --accent-2: #0b5585;
      --accent-ink: #ffffff;
      --accent-soft: #e3eef6;
      --accent-fill: #0f6aa6;
      --accent-fill-hover: #0c5d93;
      --accent-fill-press: #0a4f7d;
      --accent-fill-ink: #ffffff;
      --selection: #dde9f3;
      --ring: #0f6aa6;
      --focus-ring: rgba(15, 106, 166, 0.35);
      --danger-fg: #b42332;
      --danger-bg: #fdf0f0;
      --danger-border: #f3c7c9;
      --danger-fill: #b42332;
      --success-fg: #1d7a3a;
      --success-bg: #edf7ef;
      --success-border: #bfe3c8;
      --warning-fg: #8a5a00;
      --warning-bg: #fdf6e7;
      --warning-border: #f0dca8;
      --mark-top: #7cc4ee;
      --mark-left: #0f6aa6;
      --mark-right: #0a4570;
      --code: #f5f5f7;
      --surface: #ffffff;
      --code-text: #1d1d1f;
      --code-viewer-bg: #f8f8fa;
      --code-viewer-text: #1d1d1f;
      --code-viewer-gutter: #efeff2;
      --code-viewer-gutter-text: #636366;
      --code-viewer-edge: #e3e3e7;
      --code-viewer-filter: none;
      --frame-bg: #ffffff;
      --shadow-control: 0 0.5px 1px rgba(0, 0, 0, 0.08);
      --shadow-thumb: 0 0.5px 2px rgba(0, 0, 0, 0.16), 0 0 0 0.5px rgba(0, 0, 0, 0.05);
      --shadow-pop: 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 8px 24px rgba(0, 0, 0, 0.12);
      /* Legacy names, kept for client scripts and page-specific styles. */
      --panel: var(--group);
      --panel-2: var(--chip);
      --text: var(--label);
      --muted: var(--label-2);
      --faint: var(--label-2);
      --line: var(--separator);
      --line-2: var(--border);
      --grid: transparent;
      /* Type: the macOS text-style ramp, with a 14 px headline for list titles on the web. */
      --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", system-ui, "Apple SD Gothic Neo", "Segoe UI", "Malgun Gothic", "Noto Sans KR", "Helvetica Neue", sans-serif;
      --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      --fs-large-title: 26px;
      --lh-large-title: 32px;
      --fs-title-1: 22px;
      --fs-title-2: 17px;
      --fs-title-3: 15px;
      --fs-headline: 14px;
      --fs-body: 13px;
      --fs-callout: 12px;
      --fs-caption: 11px;
      --fs-reading: 15px;
      /* Space: a 4 px grid. Radii: concentric, smallest inside. */
      --sp-1: 4px;
      --sp-2: 8px;
      --sp-3: 12px;
      --sp-4: 16px;
      --sp-5: 20px;
      --sp-6: 24px;
      --sp-8: 32px;
      --sp-10: 40px;
      --sp-12: 48px;
      --r-chip: 5px;
      --r-control: 6px;
      --r-group: 10px;
      --r-sheet: 12px;
      --control-h: 30px;
      --sidebar-w: 228px;
      --content-max: 1200px;
      --reading-max: 1040px;
      --gutter: 32px;
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
${darkThemeVariables}
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        color-scheme: dark;
${darkThemeVariables}
      }
    }
    @media (prefers-contrast: more) {
      :root {
        --separator: var(--border);
        --group-edge: var(--border);
        --label-2: #48484a;
      }
      :root[data-theme="dark"] {
        --label-2: #c7c7cc;
      }
    }
    @media (prefers-contrast: more) and (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --label-2: #c7c7cc;
      }
    }
    * { box-sizing: border-box; }
    html { background-color: var(--bg); }
    fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
    body {
      margin: 0;
      display: flow-root;
      min-height: 100vh;
      background-color: var(--bg);
      color: var(--label);
      font-family: var(--sans);
      font-size: var(--fs-body);
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      font-synthesis-weight: none;
      text-rendering: optimizeLegibility;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { color: var(--accent-2); text-decoration: underline; }
    h1, h2, h3, h4 { color: var(--label); }
    :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
    ::selection { background: var(--selection); }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }
    }
    /* ---- Shell: source-list sidebar, compact bar under 1100 px, page header ---- */
    .workspace-skip { position: absolute; left: var(--sp-4); top: -100px; z-index: 100; padding: var(--sp-2) var(--sp-4); border-radius: var(--r-control); background: var(--bg); box-shadow: var(--shadow-pop); }
    .workspace-skip:focus { top: var(--sp-2); }
    .workspace-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-4);
      padding: var(--sp-2) var(--sp-4);
      background: var(--bg-sidebar);
      border-bottom: 1px solid var(--separator);
    }
    .workspace-header svg { flex-shrink: 0; }
    .workspace-brand-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); min-height: 36px; }
    .workspace-brand-row svg { display: block; }
    .workspace-brand { display: inline-flex; align-items: center; gap: var(--sp-2); color: var(--label); font-size: var(--fs-title-3); font-weight: 600; line-height: 20px; }
    .workspace-brand:hover { color: var(--label); text-decoration: none; }
    .workspace-brand svg { width: 22px; height: 22px; }
    .brand-mark { display: inline-flex; }
    .workspace-desktop { display: none; }
    .workspace-mobile > summary {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: var(--control-h);
      padding: 0 var(--sp-3);
      border: 1px solid var(--border);
      border-radius: var(--r-control);
      background: var(--control);
      box-shadow: var(--shadow-control);
      color: var(--label);
      font-size: var(--fs-body);
      font-weight: 500;
      cursor: pointer;
      list-style: none;
    }
    .workspace-mobile > summary::-webkit-details-marker { display: none; }
    .workspace-mobile > summary:hover { background: var(--control-hover); }
    .workspace-mobile > summary:active { background: var(--control-press); }
    .workspace-mobile > summary .ui-icon { width: 16px; height: 16px; color: var(--label-2); }
    .workspace-mobile[open] { flex-basis: 100%; }
    .workspace-header:has(.workspace-mobile[open]) { flex-wrap: wrap; }
    .workspace-mobile[open] > summary { position: absolute; top: var(--sp-2); right: var(--sp-4); }
    .workspace-mobile nav { padding: var(--sp-2) 0 var(--sp-3); }
    .workspace-primary, .workspace-actions { display: grid; gap: 1px; }
    .workspace-primary { margin-bottom: var(--sp-4); }
    .workspace-header nav a,
    .workspace-dropdown summary,
    .workspace-dropdown .nav-form button {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      width: 100%;
      min-height: 28px;
      padding: var(--sp-1) var(--sp-2);
      border: 0;
      border-radius: var(--r-control);
      background: transparent;
      box-shadow: none;
      color: var(--label);
      font-size: var(--fs-body);
      font-weight: 400;
      line-height: 18px;
      text-align: left;
      justify-content: flex-start;
      transition: background-color 0.1s ease-out;
    }
    .workspace-header nav .ui-icon { width: 16px; height: 16px; color: var(--accent); }
    .workspace-header nav a:hover,
    .workspace-dropdown summary:hover,
    .workspace-dropdown .nav-form button:hover { background: var(--hover); color: var(--label); text-decoration: none; }
    .workspace-header nav a:active,
    .workspace-dropdown summary:active,
    .workspace-dropdown .nav-form button:active { background: var(--press); }
    .workspace-header [aria-current="page"],
    .workspace-header .is-current { background: var(--selection); color: var(--label); font-weight: 500; }
    .workspace-header [aria-current="page"]:hover { background: var(--selection); }
    .workspace-dropdown summary { cursor: pointer; list-style: none; }
    .workspace-dropdown summary::-webkit-details-marker { display: none; }
    .workspace-chevron { margin-left: auto; display: inline-flex; color: var(--label-2); }
    .workspace-header nav .workspace-chevron .ui-icon { width: 14px; height: 14px; color: var(--label-2); }
    .workspace-dropdown[open] > summary .workspace-chevron { transform: rotate(180deg); }
    .workspace-dropdown-content { display: grid; gap: 1px; margin: 1px 0 var(--sp-2) var(--sp-4); }
    .workspace-dropdown-content .nav-form { display: block; margin: 0; }
    .workspace-identity { padding: var(--sp-1) var(--sp-2); color: var(--label-2); font-size: var(--fs-callout); overflow-wrap: anywhere; }
    .workspace-version { display: flex; align-items: center; gap: 6px; padding: 6px var(--sp-2); color: var(--label-2); font-size: var(--fs-caption); }
    .workspace-header nav .workspace-help { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; min-height: 22px; padding: 0; color: var(--label-2); flex: 0 0 auto; }
    .workspace-help span { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border: 1.25px solid currentColor; border-radius: 50%; font-size: 10px; font-weight: 600; line-height: 1; }
    .workspace-header .language-switcher { display: grid; gap: var(--sp-1); min-width: 0; margin: var(--sp-5) 0 0; padding: 0 var(--sp-2); }
    .language-switcher label { display: grid; gap: var(--sp-1); min-width: 0; }
    .language-switcher label > span,
    .theme-controls legend { color: var(--label-2); font-size: var(--fs-caption); font-weight: 600; }
    .language-switcher select { width: 100%; min-width: 0; max-width: 100%; min-height: 26px; padding-top: 3px; padding-bottom: 3px; font-size: var(--fs-callout); }
    .language-switcher button { justify-self: start; }
    .theme-controls { min-width: 0; margin: var(--sp-3) var(--sp-2) 0; padding: 0; border: 0; }
    .theme-controls legend { margin-bottom: var(--sp-1); padding: 0; }
    .theme-choices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2px; padding: 2px; border-radius: 7px; background: var(--fill); }
    .theme-choices .btn { min-width: 0; min-height: 24px; padding: 2px; border: 0; border-radius: 5px; background: transparent; box-shadow: none; color: var(--label-2); }
    .theme-choices .btn:hover { background: var(--hover); color: var(--label); }
    .theme-choices .btn[aria-pressed="true"] { background: var(--thumb); color: var(--label); box-shadow: var(--shadow-thumb); }
    .theme-choices .ui-icon { width: 15px; height: 15px; }
    .workspace-header .sidebar-toggle { display: none; }
    .sidebar-toggle > span:not([hidden]) { display: flex; align-items: center; }
    .nav-form { display: inline-flex; margin: 0; }
    @media (min-width: 1100px) {
      body:has(> .workspace-header) {
        padding-left: var(--sidebar-w);
        background-image: linear-gradient(to right, var(--bg-sidebar) calc(var(--sidebar-w) - 1px), var(--separator) calc(var(--sidebar-w) - 1px), var(--separator) var(--sidebar-w), transparent var(--sidebar-w));
      }
      .workspace-header {
        position: fixed;
        inset: 0 auto 0 0;
        z-index: 20;
        display: block;
        width: var(--sidebar-w);
        padding: var(--sp-3) var(--sp-3) var(--sp-6);
        border-bottom: 0;
        border-right: 1px solid var(--separator);
        overflow-y: auto;
      }
      .workspace-brand-row { margin: 0 0 var(--sp-4); padding-left: var(--sp-2); }
      .workspace-desktop { display: block; }
      .workspace-mobile { display: none; }
      .sidebar-toggle:not([hidden]) { display: inline-flex; position: static; width: 28px; height: 28px; min-height: 28px; padding: 0; flex-shrink: 0; color: var(--label-2); }
      .sidebar-toggle .ui-icon { width: 18px; height: 18px; }
      :root[data-sidebar="collapsed"] { --sidebar-w: 60px; }
      :root[data-sidebar="collapsed"] .workspace-header { padding: var(--sp-3) 10px; }
      :root[data-sidebar="collapsed"] .workspace-brand { display: none; }
      :root[data-sidebar="collapsed"] .workspace-brand-row { justify-content: center; padding-left: 0; }
      :root[data-sidebar="collapsed"] .workspace-nav-label, :root[data-sidebar="collapsed"] .workspace-brand-name, :root[data-sidebar="collapsed"] .workspace-chevron, :root[data-sidebar="collapsed"] .workspace-version, :root[data-sidebar="collapsed"] .workspace-identity, :root[data-sidebar="collapsed"] .language-switcher, :root[data-sidebar="collapsed"] .theme-controls { display: none; }
      :root[data-sidebar="collapsed"] .workspace-dropdown-content { margin-left: 0; }
      :root[data-sidebar="collapsed"] .workspace-header nav a, :root[data-sidebar="collapsed"] .workspace-dropdown summary, :root[data-sidebar="collapsed"] .nav-form button { justify-content: center; padding: 6px; }
      :root[data-sidebar="collapsed"] .workspace-header nav a:is(:hover, :focus-visible) .workspace-nav-label, :root[data-sidebar="collapsed"] .workspace-dropdown > summary:is(:hover, :focus-visible) .workspace-nav-label, :root[data-sidebar="collapsed"] .nav-form button:is(:hover, :focus-visible) .workspace-nav-label { display: block; position: fixed; left: 66px; z-index: 50; max-width: 240px; padding: var(--sp-1) var(--sp-2); border-radius: var(--r-control); background: var(--bg); color: var(--label); font-size: var(--fs-callout); font-weight: 400; box-shadow: var(--shadow-pop); pointer-events: none; }
    }
    @media (max-width: 640px) {
      .workspace-header { padding: var(--sp-2) var(--sp-4); }
      .workspace-header nav a, .workspace-dropdown summary, .workspace-dropdown .nav-form button { min-height: 44px; }
    }

    /* Page header: a large title with the view's toolbar on the trailing side. */
    .dashboard-layout,
    .dashboard,
    .artifact-view,
    .artifact-editor,
    .topbar {
      width: min(var(--content-max), calc(100% - 2 * var(--gutter)));
      margin-left: auto;
      margin-right: auto;
    }
    .dashboard-layout { margin-top: var(--sp-8); margin-bottom: var(--sp-12); }
    .dashboard-layout .dashboard { width: 100%; min-width: 0; margin: 0; }
    .artifact-view, .artifact-editor { margin-top: var(--sp-5); margin-bottom: 72px; }
    .artifact-view-wide { width: min(1760px, calc(100% - 2 * var(--gutter))); }
    .topbar {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: var(--sp-4) var(--sp-6);
      flex-wrap: wrap;
      margin-top: var(--sp-8);
      margin-bottom: var(--sp-2);
      padding: 0;
      border: 0;
    }
    .topbar > div { min-width: 0; }
    .topbar h1,
    .dashboard-heading h1 {
      margin: 0;
      color: var(--label);
      font-size: var(--fs-large-title);
      font-weight: 700;
      line-height: var(--lh-large-title);
      overflow-wrap: anywhere;
    }
    .topbar p { margin: var(--sp-1) 0 0; color: var(--label-2); font-size: var(--fs-callout); overflow-wrap: anywhere; }
    .topbar nav,
    .dashboard-heading nav { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--sp-1); }
    .topbar nav > a,
    .dashboard-heading nav > a:not(.btn) {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: var(--sp-1) 10px;
      border-radius: var(--r-control);
      color: var(--label);
      font-size: var(--fs-body);
      font-weight: 500;
      transition: background-color 0.1s ease-out;
    }
    .topbar nav > a:hover,
    .dashboard-heading nav > a:not(.btn):hover { background: var(--hover); color: var(--label); text-decoration: none; }
    .topbar nav > a:active,
    .dashboard-heading nav > a:not(.btn):active { background: var(--press); }
    .topbar nav > a.is-primary { margin-left: var(--sp-2); background: var(--accent-fill); color: var(--accent-fill-ink); }
    .topbar nav > a.is-primary:hover { background: var(--accent-fill-hover); color: var(--accent-fill-ink); }
    .topbar nav > a.is-primary:active { background: var(--accent-fill-press); }
    .visually-hidden { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    .share-principal { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: 6px 0; border-bottom: 1px solid var(--separator); }
    .share-principal:last-child { border-bottom: 0; }
    .share-principal-name { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; overflow-wrap: anywhere; }
    .share-principal-permission { flex: none; width: 160px; }
    /* Secondary artifact actions live in one pull-down menu, as in a macOS toolbar. */
    .toolbar-more { position: relative; }
    .toolbar-more > summary {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 32px; min-height: 28px; padding: var(--sp-1) 6px;
      border-radius: var(--r-control); color: var(--label); cursor: default; list-style: none;
      transition: background-color 0.1s ease-out;
    }
    .toolbar-more > summary::-webkit-details-marker { display: none; }
    .toolbar-more > summary:hover { background: var(--hover); }
    .toolbar-more > summary:active, .toolbar-more[open] > summary { background: var(--press); }
    .toolbar-menu {
      position: absolute; top: calc(100% + 4px); right: 0; z-index: 30;
      display: grid; min-width: 200px; padding: 5px;
      background: var(--surface); border-radius: 10px; box-shadow: var(--shadow-pop);
    }
    .toolbar-menu a {
      padding: 5px 10px; border-radius: 6px;
      color: var(--label); font-size: var(--fs-body); white-space: nowrap;
    }
    .toolbar-menu a:hover, .toolbar-menu a:focus-visible { background: var(--accent-fill); color: var(--accent-fill-ink); text-decoration: none; outline: none; }
    .dashboard-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); margin-bottom: var(--sp-5); }
    .dashboard-heading .btn-primary { margin-left: var(--sp-2); }
    .button-link:hover { text-decoration: none; }

    /* ---- Generic controls (Bootstrap's .btn and .form-* refine these) ---- */
    button:not(.btn) {
      min-height: var(--control-h);
      padding: var(--sp-1) var(--sp-3);
      border: 1px solid var(--border);
      border-radius: var(--r-control);
      background: var(--control);
      box-shadow: var(--shadow-control);
      color: var(--label);
      font: inherit;
      font-weight: 500;
      cursor: pointer;
    }
    button:not(.btn):hover { background: var(--control-hover); }
    button:not(.btn):active { background: var(--control-press); }
    input:not([type="checkbox"]):not([type="radio"]), select { min-height: var(--control-h); padding: 5px 10px; }
    input::placeholder, textarea::placeholder { color: var(--label-2); }
    .checkbox-field,
    .check-field {
      display: inline-flex;
      align-items: center;
      gap: var(--sp-2);
      min-height: var(--control-h);
      color: var(--label);
      font-size: var(--fs-body);
      white-space: nowrap;
    }
    .checkbox-field input,
    .check-field input { flex-shrink: 0; width: 14px; height: 14px; min-height: 0; margin: 0; padding: 0; }
    .inline-action { margin: 0 0 var(--sp-3); }
    .muted { color: var(--label-2); }
    .dashboard-sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    .filter-form > a,
    .diff-form > a {
      display: inline-flex;
      align-items: center;
      min-height: var(--control-h);
      padding: 0 var(--sp-3);
      border: 1px solid var(--border);
      border-radius: var(--r-control);
      background: var(--control);
      box-shadow: var(--shadow-control);
      color: var(--label);
      font-size: var(--fs-body);
      font-weight: 500;
    }
    .filter-form > a:hover, .diff-form > a:hover { background: var(--control-hover); color: var(--label); text-decoration: none; }
    .toolbar, .filter-form, .diff-form, .meta-strip, .version-strip { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); color: var(--label-2); font-size: var(--fs-body); }
    details > summary { cursor: pointer; }

    /* Disclosure rows: a small chevron instead of the default triangle. */
    .dashboard-advanced > summary,
    .dashboard-saved-views > summary,
    .artifact-details > summary,
    .artifact-manage > summary,
    .collection-management > summary {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
      padding: 0 var(--sp-2) 0 6px;
      border-radius: var(--r-control);
      color: var(--label);
      font-size: var(--fs-body);
      font-weight: 500;
      list-style: none;
      transition: background-color 0.1s ease-out;
    }
    :is(.dashboard-advanced, .dashboard-saved-views, .artifact-details, .artifact-manage, .collection-management) > summary::-webkit-details-marker { display: none; }
    :is(.dashboard-advanced, .dashboard-saved-views, .artifact-details, .artifact-manage, .collection-management) > summary::before {
      content: "";
      width: 6px;
      height: 6px;
      margin: 0 3px 0 2px;
      border-right: 1.5px solid var(--label-2);
      border-bottom: 1.5px solid var(--label-2);
      transform: rotate(-45deg);
      transition: transform 0.1s ease-out;
    }
    :is(.dashboard-advanced, .dashboard-saved-views, .artifact-details, .artifact-manage, .collection-management)[open] > summary::before { transform: translateY(-2px) rotate(45deg); }
    :is(.dashboard-advanced, .dashboard-saved-views, .artifact-details, .artifact-manage, .collection-management) > summary:hover { background: var(--hover); }

    /* ---- Artifact list ---- */
    .dashboard .filter-form { display: block; width: 100%; margin-bottom: 0; }
    .dashboard-search-row { display: flex; align-items: center; gap: var(--sp-2); }
    .dashboard-search { position: relative; flex: 1; min-width: 0; }
    .dashboard-search .ui-icon { position: absolute; top: 50%; left: 10px; width: 15px; height: 15px; color: var(--label-2); transform: translateY(-50%); pointer-events: none; }
    .dashboard-search .form-control[type="search"] {
      width: 100%;
      min-width: 0;
      min-height: 32px;
      padding-left: 32px;
      border-color: transparent;
      border-radius: 8px;
      background-color: var(--search);
      font-size: var(--fs-body);
    }
    .dashboard-search .form-control[type="search"]:hover { border-color: var(--separator); }
    .dashboard-search .form-control[type="search"]:focus { border-color: var(--accent); background-color: var(--field); }
    .category-filter { min-width: 150px; max-width: 230px; }
    .category-filter > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
    .dashboard-search-row .btn { min-height: 32px; }
    .dashboard-search-submit { color: var(--label-2); font-weight: 500; }
    .dashboard-clear { color: var(--label-2); }
    .dashboard-clear:hover { color: var(--label); }
    .dashboard-clear { padding: var(--sp-1) var(--sp-2); border-radius: var(--r-control); font-size: var(--fs-body); font-weight: 500; white-space: nowrap; }
    .dashboard-clear:hover { background: var(--hover); text-decoration: none; }
    .dashboard-advanced, .dashboard-saved-views { margin: var(--sp-2) 0 0 -6px; }
    .dashboard-filter-count { margin-left: 2px; padding: 0 6px; border-radius: 9px; background: var(--chip); color: var(--label-2); font-size: var(--fs-caption); font-weight: 600; line-height: 18px; font-variant-numeric: tabular-nums; }
    .dashboard-filter-grid,
    .dashboard-saved-content {
      display: grid;
      gap: var(--sp-3) var(--sp-4);
      margin: var(--sp-2) 0 var(--sp-2) 6px;
      padding: var(--sp-4);
      border: 1px solid var(--group-edge);
      border-radius: var(--r-group);
      background: var(--group);
    }
    .dashboard-filter-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .dashboard-saved-content { grid-template-columns: 1fr 1fr; gap: var(--sp-6); }
    .dashboard-field { display: grid; gap: var(--sp-1); min-width: 0; color: var(--label-2); font-size: var(--fs-callout); font-weight: 500; }
    .dashboard-field input, .dashboard-field select { width: 100%; min-width: 0; font-weight: 400; }
    .dashboard-filter-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; }
    .dashboard-active-filters { display: flex; flex-wrap: wrap; gap: 6px; margin: var(--sp-3) 0 0; color: var(--label-2); font-size: var(--fs-callout); overflow-wrap: anywhere; }
    .dashboard-active-filters > span { padding: 1px var(--sp-2); border-radius: 10px; background: var(--accent-soft); color: var(--label); }
    .saved-view-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
    .saved-view-item { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; font-size: var(--fs-body); }
    .saved-view-item a { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .saved-view-delete { margin: 0; }
    .saved-view-delete .btn { min-height: 24px; padding: 0 var(--sp-2); font-size: var(--fs-callout); }
    .saved-view-form { display: grid; align-content: start; gap: var(--sp-2); }
    .saved-view-form .btn { justify-self: start; }
    .dashboard-saved-content .empty { padding: 0; color: var(--label-2); }
    .dashboard-results { display: flex; justify-content: space-between; margin: var(--sp-5) 0 var(--sp-2); color: var(--label-2); font-size: var(--fs-callout); font-variant-numeric: tabular-nums; }

    /* Grouped inset list: one rounded container, hairlines inset from the leading edge. */
    .artifact-list {
      --row-inset: var(--sp-4);
      overflow: hidden;
      border: 1px solid var(--group-edge);
      border-radius: var(--r-group);
      background: var(--group);
    }
    .artifact-group + .artifact-group { border-top: 1px solid var(--separator); }
    .artifact-group-heading { margin: 0; padding: var(--sp-3) var(--sp-4) var(--sp-1); color: var(--label-2); font-size: var(--fs-callout); font-weight: 600; }
    .artifact-row {
      position: relative;
      display: grid;
      grid-template-columns: minmax(200px, 1fr) minmax(110px, 160px) minmax(140px, 190px) minmax(90px, 170px);
      align-items: center;
      gap: var(--sp-4);
      min-height: 56px;
      padding: 10px var(--sp-4);
      color: var(--label);
      transition: background-color 0.1s ease-out;
    }
    .artifact-row:hover { background: var(--group-hover); color: var(--label); text-decoration: none; }
    .artifact-row:active { background: var(--press); }
    .artifact-row:focus-visible { outline-offset: -2px; border-radius: var(--r-group); }
    .artifact-list :is(.artifact-row, .artifact-row-shell) + :is(.artifact-row, .artifact-row-shell)::before {
      content: "";
      position: absolute;
      top: 0;
      left: var(--row-inset);
      right: 0;
      height: 1px;
      background: var(--separator);
    }
    .row-main { display: grid; gap: 2px; min-width: 0; }
    .row-main strong { overflow-wrap: anywhere; color: var(--label); font-size: var(--fs-headline); font-weight: 600; line-height: 19px; }
    .row-main .row-snippet { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: var(--label-2); font-size: var(--fs-callout); line-height: 16px; overflow-wrap: anywhere; }
    .row-agent { display: grid; gap: 1px; min-width: 0; color: var(--label); font-size: var(--fs-body); line-height: 17px; }
    .row-agent .publisher-cell { overflow: hidden; color: var(--label-2); font-size: var(--fs-callout); text-overflow: ellipsis; white-space: nowrap; }
    .row-agent .publisher-cell:first-child { color: var(--label); font-size: var(--fs-body); }
    .row-formats { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; color: var(--label-2); font-size: var(--fs-callout); }
    .row-formats .badge-type { padding: 0; background: none; color: var(--label-2); font-size: var(--fs-callout); font-weight: 400; }
    .row-version { color: var(--label-2); font-family: var(--mono); font-size: var(--fs-caption); font-variant-numeric: tabular-nums; }
    .tags { display: flex; flex-wrap: wrap; gap: var(--sp-1); min-width: 0; }
    .empty { padding: var(--sp-12) var(--sp-6); color: var(--label-2); font-size: var(--fs-body); text-align: center; }

    /* Badges: one compact shape; formats carry a colored dot so they scan by hue and by name. */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-height: 20px;
      padding: 0 7px;
      border: 0;
      border-radius: var(--r-chip);
      background: var(--chip);
      color: var(--label-2);
      font-family: var(--sans);
      font-size: var(--fs-caption);
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;
    }
    .badge-format::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--bh, var(--label-3)); }
    .badge.v-private { background: var(--danger-bg); color: var(--danger-fg); }
    .badge.v-public { background: var(--accent-soft); color: var(--accent); }
    .badge.rs-approved { background: var(--success-bg); color: var(--success-fg); }
    .badge.rs-changes-requested { background: var(--warning-bg); color: var(--warning-fg); }
    .badge.rs-in-review { background: var(--accent-soft); color: var(--accent); }
    .tag {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      padding: 0 7px;
      border: 1px solid var(--separator);
      border-radius: 10px;
      color: var(--label-2);
      font-size: var(--fs-caption);
      line-height: 1;
      white-space: nowrap;
    }
    .badge.f-html { --bh: #e0795b; }
    .badge.f-markdown { --bh: #3b82f6; }
    .badge.f-text { --bh: #8e8e93; }
    .badge.f-json { --bh: #16a34a; }
    .badge.f-code { --bh: #64748b; }
    .badge.f-svg { --bh: #0ea5e9; }
    .badge.f-mermaid { --bh: #14b8a6; }
    .badge.f-react { --bh: #7c3aed; }
    .badge.f-sarif { --bh: #dc2626; }
    .badge.f-csv { --bh: #0891b2; }
    .badge.f-image { --bh: #f59e0b; }
    .badge.f-video { --bh: #db2777; }
    .badge.f-notebook { --bh: #f97316; }
    .badge.f-collection { --bh: #0f6aa6; }
    .badge.f-explainer { --bh: #a855f7; }

    /* Pagination stays with the list it pages. */
    .dashboard-pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-4); margin-top: var(--sp-4); }
    .pager { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); font-size: var(--fs-body); }
    .pager a,
    .pager-disabled {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 28px;
      padding: 0 var(--sp-3);
      border: 1px solid var(--border);
      border-radius: var(--r-control);
      background: var(--control);
      box-shadow: var(--shadow-control);
      color: var(--label);
      font-weight: 500;
    }
    .pager a:hover { background: var(--control-hover); color: var(--label); text-decoration: none; }
    .pager a:active { background: var(--control-press); }
    .pager-disabled { color: var(--label-2); box-shadow: none; opacity: 0.6; }
    .pager-position { color: var(--label-2); font-size: var(--fs-callout); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .page-size-form, .page-size-form label { display: flex; align-items: center; gap: var(--sp-2); margin: 0; color: var(--label-2); font-size: var(--fs-callout); }
    .page-size-form select { width: auto; min-width: 72px; min-height: 28px; padding-top: 3px; padding-bottom: 3px; }

    /* ---- Artifact detail ---- */
    .artifact-view:not(.artifact-view-wide) { width: min(var(--reading-max), calc(100% - 2 * var(--gutter))); }
    .artifact-view:not(.artifact-view-wide) ~ .topbar, body:has(.artifact-view:not(.artifact-view-wide)) .topbar { width: min(var(--reading-max), calc(100% - 2 * var(--gutter))); }
    .artifact-editor { max-width: 1000px; }
    .meta-strip { gap: 6px; padding: 0; }
    .artifact-overview { align-items: flex-start; margin-bottom: var(--sp-2); }
    .meta-strip > span:not(.badge) {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 0 var(--sp-2);
      border-radius: var(--r-chip);
      background: var(--chip);
      color: var(--label-2);
      font-family: var(--mono);
      font-size: var(--fs-caption);
      font-variant-numeric: tabular-nums;
    }
    .artifact-details, .artifact-manage { min-width: 0; }
    .artifact-details > summary, .artifact-manage > summary { min-height: 22px; color: var(--label-2); font-size: var(--fs-callout); }
    .artifact-details[open], .artifact-manage[open] { flex-basis: 100%; }
    .artifact-details > .meta-strip { max-width: 100%; margin: var(--sp-2) 0 0; padding: 0 0 0 var(--sp-5); overflow-wrap: anywhere; }
    .artifact-manage-panel,
    .collection-management > div {
      display: grid;
      gap: var(--sp-3);
      margin: var(--sp-2) 0 0 var(--sp-5);
      padding: var(--sp-4);
      border: 1px solid var(--group-edge);
      border-radius: var(--r-group);
      background: var(--group);
    }
    .artifact-manage-panel .inline-action, .artifact-manage-panel .visibility-form { margin: 0; }
    .artifact-manage-panel > p { margin: 0; color: var(--label-2); font-size: var(--fs-callout); }
    .provenance-details { margin: 0 0 var(--sp-3); }
    .provenance-details > summary { min-height: 22px; color: var(--label-2); font-size: var(--fs-callout); }
    .provenance-details dl { margin: var(--sp-2) 0 0 var(--sp-5); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--group-edge); border-radius: var(--r-group); background: var(--group); font-size: var(--fs-callout); }
    .provenance-details dt { color: var(--label-2); }

    /* Versions as a segmented control: the current version is the raised segment. */
    .version-strip {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 2px;
      max-width: 100%;
      margin: 0 0 var(--sp-4);
      padding: 2px;
      border: 0;
      border-radius: 7px;
      background: var(--fill);
    }
    .version {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 36px;
      min-height: 24px;
      padding: 0 var(--sp-2);
      border-radius: var(--r-chip);
      color: var(--label-2);
      font-family: var(--mono);
      font-size: var(--fs-callout);
      font-variant-numeric: tabular-nums;
      transition: background-color 0.1s ease-out;
    }
    .version:hover { background: var(--hover); color: var(--label); text-decoration: none; }
    .version.active { background: var(--thumb); color: var(--label); font-weight: 600; box-shadow: var(--shadow-thumb); }

    /* Content surfaces: sandboxed frames and rendered documents sit on one white sheet. */
    .artifact-frame { display: block; width: 100%; min-height: 320px; border: 1px solid var(--group-edge); border-radius: var(--r-sheet); background: var(--frame-bg); }
    .split-preview { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); margin-top: var(--sp-3); }
    .split-preview .artifact-frame { min-height: 45vh; }
    .artifact-doc,
    .artifact-code { margin: 0; border: 1px solid var(--group-edge); border-radius: var(--r-sheet); }
    .artifact-doc {
      padding: var(--sp-10) max(var(--sp-10), calc((100% - 720px) / 2));
      background: var(--surface);
      color: var(--label);
      font-size: var(--fs-reading);
      line-height: 1.65;
      overflow-wrap: anywhere;
    }
    .artifact-doc > :first-child { margin-top: 0; }
    .artifact-doc > :last-child { margin-bottom: 0; }
    .artifact-doc h1, .artifact-doc h2, .artifact-doc h3, .artifact-doc h4 { line-height: 1.3; }
    .artifact-doc h1 { margin: 0 0 var(--sp-4); font-size: var(--fs-large-title); font-weight: 700; line-height: var(--lh-large-title); }
    .artifact-doc h2 { margin: var(--sp-8) 0 var(--sp-3); font-size: 20px; font-weight: 600; }
    .artifact-doc h3 { margin: var(--sp-6) 0 var(--sp-2); font-size: var(--fs-title-2); font-weight: 600; }
    .artifact-doc h4 { margin: var(--sp-5) 0 var(--sp-2); font-size: var(--fs-title-3); font-weight: 600; }
    .artifact-doc p, .artifact-doc ul, .artifact-doc ol { margin: 0 0 var(--sp-3); }
    .artifact-doc li + li { margin-top: 2px; }
    .artifact-doc blockquote { margin: var(--sp-4) 0; padding: 2px 0 2px var(--sp-4); border-left: 3px solid var(--fill); color: var(--label-2); }
    .artifact-doc hr { margin: var(--sp-8) 0; border: 0; border-top: 1px solid var(--separator); }
    .artifact-doc :not(pre) > code { padding: 1px 5px; border-radius: 4px; background: var(--chip); font-size: 0.86em; }
    .artifact-doc pre { margin: var(--sp-4) 0; padding: var(--sp-4); overflow: auto; border-radius: var(--r-group); background: var(--code); color: var(--code-text); line-height: 1.55; }
    .artifact-doc pre code { padding: 0; background: none; font-size: 0.86em; }
    .artifact-doc-codemirror { margin: var(--sp-4) 0; overflow: hidden; border: 1px solid var(--code-viewer-edge); border-radius: var(--r-group); }
    .artifact-doc-codemirror .cm-editor,
    .artifact-code-viewer .cm-editor { min-height: 0; background: var(--code-viewer-bg); color: var(--code-viewer-text); filter: var(--code-viewer-filter); }
    .artifact-doc-codemirror .cm-editor .cm-content,
    .artifact-code-viewer .cm-editor .cm-content { min-height: 0; }
    .artifact-doc-codemirror .cm-editor .cm-gutters,
    .artifact-code-viewer .cm-editor .cm-gutters { border-color: var(--code-viewer-edge); background: var(--code-viewer-gutter); color: var(--code-viewer-gutter-text); }
    .artifact-doc-codemirror .cm-editor .cm-activeLine,
    .artifact-doc-codemirror .cm-editor .cm-activeLineGutter,
    .artifact-code-viewer .cm-editor .cm-activeLine,
    .artifact-code-viewer .cm-editor .cm-activeLineGutter { background: transparent; }
    .artifact-doc-codemirror .cm-scroller,
    .artifact-code-viewer .cm-scroller { font-family: var(--mono); font-size: 12.5px; line-height: 1.55; }
    .artifact-code-viewer { overflow: hidden; border: 1px solid var(--code-viewer-edge); border-radius: var(--r-sheet); background: var(--code-viewer-bg); }
    .artifact-code { min-height: 240px; padding: var(--sp-5); overflow: auto; background: var(--code); color: var(--code-text); white-space: pre-wrap; overflow-wrap: anywhere; }
    code, pre { font-family: var(--mono); font-size: 12.5px; }
    .task-list-item { margin-left: -20px; list-style: none; }
    .task-list-item label { display: block; }
    .task-list-item input[type="checkbox"] { width: 14px; height: 14px; min-height: 0; margin: 0 var(--sp-2) 0 0; padding: 0; vertical-align: -2px; accent-color: var(--accent-fill); }
    .artifact-mermaid-embed { margin: var(--sp-4) 0; }
    .artifact-mermaid-embed .artifact-frame { width: 100%; height: 240px; border-radius: var(--r-group); }
    .artifact-mermaid-capped { margin: var(--sp-4) 0; }
    .artifact-mermaid-notice,
    .artifact-notebook-notice,
    .artifact-notebook-output-placeholder,
    .artifact-notebook-output-truncated,
    .artifact-csv-note,
    .artifact-sarif-note,
    .artifact-react-disabled > p {
      margin: 0 0 var(--sp-2);
      padding: 10px var(--sp-3);
      border: 1px solid var(--group-edge);
      border-radius: var(--r-control);
      background: var(--group);
      color: var(--label-2);
      font-size: var(--fs-callout);
    }
    .artifact-notebook-cell { margin: 0 0 var(--sp-6); }
    .artifact-notebook-cell:last-child { margin-bottom: 0; }
    .artifact-notebook-cell-code { padding: var(--sp-3) var(--sp-4); border: 1px solid var(--group-edge); border-radius: var(--r-group); background: var(--surface); }
    .artifact-notebook-execcount { margin-bottom: 6px; color: var(--label-2); font-family: var(--mono); font-size: var(--fs-caption); }
    .artifact-notebook-output { margin-top: var(--sp-3); }
    .artifact-notebook-output.artifact-code { min-height: unset; }
    .artifact-notebook-error code { color: var(--danger-fg); }
    .artifact-table-scroll { width: 100%; margin: var(--sp-5) 0; overflow-x: auto; border: 1px solid var(--group-edge); border-radius: var(--r-group); background: var(--surface); }
    .artifact-table { width: 100%; min-width: max-content; border-collapse: collapse; font-size: var(--fs-body); line-height: 1.45; }
    .artifact-table th, .artifact-table td { padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--separator); text-align: left; vertical-align: top; white-space: normal; }
    .artifact-table tbody tr:last-child td { border-bottom: 0; }
    .artifact-table th { background: var(--group); color: var(--label-2); font-size: var(--fs-callout); font-weight: 600; }
    .artifact-table tbody tr:hover td { background: var(--group-hover); }
    .artifact-table .align-center { text-align: center; }
    .artifact-table .align-right { text-align: right; font-variant-numeric: tabular-nums; }
    .artifact-csv, .artifact-sarif { display: grid; gap: var(--sp-3); }
    .artifact-summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--sp-2); }
    .summary-card { display: grid; gap: 2px; min-height: 64px; padding: var(--sp-3); border: 1px solid var(--group-edge); border-radius: var(--r-group); background: var(--surface); }
    .summary-card span { color: var(--label-2); font-size: var(--fs-caption); font-weight: 600; }
    .summary-card strong { font-size: var(--fs-title-1); font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
    .sarif-level { display: inline-flex; min-width: 64px; justify-content: center; padding: 2px var(--sp-2); border-radius: var(--r-chip); background: color-mix(in srgb, var(--bh, var(--label-2)) 14%, transparent); color: color-mix(in srgb, var(--bh, var(--label-2)) 65%, var(--label)); font-size: var(--fs-caption); font-weight: 600; }
    .sarif-level.error { --bh: #dc2626; }
    .sarif-level.warning { --bh: #d97706; }
    .sarif-level.note { --bh: #2563eb; }
    .sarif-level.none { --bh: #8e8e93; }
    .csv-sort-btn { display: inline-flex; align-items: center; gap: var(--sp-1); min-height: 0; padding: 0; border: 0; background: none; box-shadow: none; color: inherit; font: inherit; font-weight: inherit; cursor: pointer; }
    .csv-sort-btn:hover, .csv-sort-btn:focus-visible { background: none; text-decoration: underline; }
    .csv-sort-indicator { color: var(--accent); font-size: 10px; }
    .csv-filter-row th { padding: var(--sp-1) var(--sp-2); background: var(--group); }
    .csv-filter-input, .sarif-rule-filter { width: 100%; min-height: 26px; padding: 2px var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-control); background: var(--field); color: var(--label); font: inherit; font-size: var(--fs-callout); }
    .sarif-controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); }
    .sarif-level-chips { display: inline-flex; gap: 2px; padding: 2px; border-radius: 7px; background: var(--fill); }
    .sarif-chip { min-height: 24px; padding: 0 10px; border: 0; border-radius: var(--r-chip); background: transparent; box-shadow: none; color: var(--label-2); font-size: var(--fs-callout); cursor: pointer; }
    .sarif-chip.active { background: var(--thumb); color: var(--label); font-weight: 600; box-shadow: var(--shadow-thumb); }
    .sarif-rule-filter { max-width: 220px; }
    .artifact-csv-status, .artifact-sarif-status { margin: 0; color: var(--label-2); font-size: var(--fs-callout); }
    .artifact-raw-details { overflow: hidden; border: 1px solid var(--group-edge); border-radius: var(--r-group); background: var(--group); }
    .artifact-raw-details summary { padding: 10px var(--sp-4); color: var(--label-2); font-size: var(--fs-callout); font-weight: 500; }
    .artifact-raw-details .artifact-code { border: 0; border-top: 1px solid var(--separator); border-radius: 0; }
    .artifact-media { display: grid; gap: var(--sp-3); margin: 0; padding: var(--sp-4); border: 1px solid var(--group-edge); border-radius: var(--r-sheet); background: var(--surface); }
    .artifact-media img, .artifact-media video { display: block; width: 100%; max-height: 76vh; object-fit: contain; border-radius: var(--r-group); background: var(--group-hover); }
    .artifact-media figcaption, .artifact-media-note { color: var(--label-2); font-size: var(--fs-callout); overflow-wrap: anywhere; }
    .artifact-react-disabled { display: grid; gap: var(--sp-3); }
    .bundle-files { display: grid; gap: var(--sp-2); margin-top: var(--sp-6); }
    .bundle-files h3 { margin: 0 0 var(--sp-1); font-size: var(--fs-title-3); font-weight: 600; }
    .bundle-file { display: grid; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--group-edge); border-radius: var(--r-group); background: var(--group); }
    .bundle-file-download { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
    .bundle-file-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--sp-3); min-width: 0; color: var(--label-2); font-size: var(--fs-callout); }
    .bundle-file-name { color: var(--label); font-size: var(--fs-body); font-weight: 600; overflow-wrap: anywhere; }

    /* Diff */
    .diff-table, .structured-diff-table { width: 100%; overflow: hidden; border-collapse: separate; border-spacing: 0; border: 1px solid var(--group-edge); border-radius: var(--r-group); background: var(--surface); font-size: var(--fs-callout); }
    .diff-table th, .diff-table td, .structured-diff-table th, .structured-diff-table td { padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--separator); vertical-align: top; }
    .diff-table th, .structured-diff-table th { background: var(--group); color: var(--label-2); font-weight: 600; text-align: left; }
    .diff-table td:first-child, .diff-table td:nth-child(2) { width: 56px; color: var(--label-2); font-family: var(--mono); text-align: right; user-select: none; }
    .diff-added { background: color-mix(in srgb, #2ea043 16%, transparent); }
    .diff-removed { background: color-mix(in srgb, #f85149 15%, transparent); }
    .diff-changed { background: color-mix(in srgb, #d29922 16%, transparent); }
    .diff-table code { white-space: pre-wrap; overflow-wrap: anywhere; }
    .diff-view-toggle { margin: var(--sp-1) 0 var(--sp-3); color: var(--label-2); font-size: var(--fs-body); }
    .diff-summary, .diff-truncated-note { margin: 0 0 6px; color: var(--label-2); font-size: var(--fs-callout); }
    .diff-summary { font-family: var(--mono); }
    .diff-word-removed { background: color-mix(in srgb, #f85149 35%, transparent); text-decoration: line-through; }
    .diff-word-added { background: color-mix(in srgb, #2ea043 35%, transparent); }

    /* Related artifacts and comments: grouped lists under section titles. */
    .relations, .comments { margin-top: var(--sp-10); }
    .relations > h2, .comments > h2 { margin: 0 0 var(--sp-3); font-size: var(--fs-title-2); font-weight: 600; }
    .relation-group h3, .comment-version-group > h3 { margin: var(--sp-4) 0 var(--sp-2); color: var(--label-2); font-size: var(--fs-callout); font-weight: 600; }
    .relation-list, .comment-list, .comment-replies { margin: 0; padding: 0; list-style: none; }
    .relation-list, .comment-list { overflow: hidden; border: 1px solid var(--group-edge); border-radius: var(--r-group); background: var(--group); }
    .relation-item { position: relative; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--sp-2); padding: 10px var(--sp-4); font-size: var(--fs-body); }
    .relation-item + .relation-item::before,
    .comment-thread + .comment-thread::before { content: ""; position: absolute; top: 0; left: var(--sp-4); right: 0; height: 1px; background: var(--separator); }
    .relation-meta, .relation-missing-label { color: var(--label-2); font-size: var(--fs-callout); }
    .relations-empty, .comments-empty { margin: 0; color: var(--label-2); font-size: var(--fs-body); }
    .comment-thread { position: relative; padding: var(--sp-3) var(--sp-4); }
    .comment-item { list-style: none; }
    .comment-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--sp-2); }
    .comment-author { color: var(--label); font-size: var(--fs-body); font-weight: 600; }
    .comment-meta { color: var(--label-2); font-size: var(--fs-callout); }
    .comment-anchor { font-size: var(--fs-callout); }
    .comment-anchor a { padding: 1px 6px; border-radius: var(--r-chip); background: var(--accent-soft); }
    .comment-body { margin-top: var(--sp-1); font-size: var(--fs-body); line-height: 1.5; overflow-wrap: anywhere; }
    .comment-body > :first-child { margin-top: 0; }
    .comment-body > :last-child { margin-bottom: 0; }
    .comment-resolved .comment-body { color: var(--label-2); }
    .comment-actions { display: flex; flex-wrap: wrap; gap: 2px; margin: 6px 0 0 -8px; }
    .comment-actions:empty { display: none; }
    .comment-actions .inline-action { margin: 0; }
    .comment-actions .btn,
    .comment-reply-toggle > summary {
      --bs-btn-bg: transparent;
      --bs-btn-border-color: transparent;
      --bs-btn-hover-bg: var(--hover);
      --bs-btn-hover-border-color: transparent;
      --bs-btn-color: var(--label-2);
      --bs-btn-hover-color: var(--label);
      min-height: 24px;
      padding: 0 var(--sp-2);
      box-shadow: none;
      font-size: var(--fs-callout);
    }
    .comment-replies { margin: var(--sp-3) 0 0 var(--sp-1); padding-left: var(--sp-4); border-left: 2px solid var(--separator); }
    .comment-replies .comment-item + .comment-item { margin-top: var(--sp-3); }
    .comment-reply-toggle { margin: 2px 0 0 -8px; }
    .comment-reply-toggle > summary { display: inline-flex; align-items: center; border-radius: var(--r-control); color: var(--accent); font-weight: 500; list-style: none; }
    .comment-reply-toggle > summary::-webkit-details-marker { display: none; }
    .comment-reply-toggle > summary:hover { background: var(--hover); }
    .comment-reply-toggle[open] > summary { color: var(--label-2); }
    .comment-reply-toggle .comment-form { margin: var(--sp-2) 0 0 var(--sp-2); }
    .comments > .comment-form, .comment-version-group > .comment-form { padding: var(--sp-4); border: 1px solid var(--group-edge); border-radius: var(--r-group); background: var(--group); }
    .comment-form > label > span, .comment-review-status label > span, .visibility-form label > span { color: var(--label-2); font-size: var(--fs-callout); font-weight: 500; }
    .comments textarea { min-height: 88px; white-space: pre-wrap; }

    @media (max-width: 760px) {
      .artifact-doc { padding: var(--sp-6) var(--sp-5); }
      .split-preview { grid-template-columns: 1fr; }
      .artifact-details > .meta-strip, .artifact-manage-panel, .collection-management > div, .provenance-details dl { margin-left: 0; }
    }
    /* ---- Forms, settings, and status messages ---- */
    .diff-form { width: fit-content; }
    .editor-form { display: grid; gap: var(--sp-4); }
    /* Field groups sit on one white sheet, like a settings pane. */
    .editor-fields {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 170px 170px minmax(150px, 220px);
      align-items: end;
      gap: var(--sp-4) var(--sp-3);
      padding: var(--sp-5);
      border: 1px solid var(--group-edge);
      border-radius: var(--r-group);
      background: var(--group);
    }
    .field { display: grid; gap: 6px; min-width: 0; color: var(--label); font-size: var(--fs-body); }
    .field > span,
    .field > label { color: var(--label-2); font-size: var(--fs-callout); font-weight: 500; }
    .editor-form > .muted { margin: calc(-1 * var(--sp-2)) 0 0; font-size: var(--fs-callout); }
    textarea {
      width: 100%;
      min-height: 120px;
      padding: var(--sp-3);
      border: 1px solid var(--border);
      border-radius: var(--r-control);
      background: var(--field);
      color: var(--label);
      font-family: var(--mono);
      font-size: 12.5px;
      line-height: 1.55;
      white-space: pre;
      overflow: auto;
      resize: vertical;
    }
    textarea[data-artifacty-editor] { min-height: 52vh; }
    .compact-textarea { min-height: 160px; }
    .textarea-enhanced, .textarea-enhanced.form-control { display: none !important; }
    .content-field { gap: var(--sp-2); }
    .codemirror-shell { min-height: 52vh; }
    .codemirror-shell .cm-editor, .editor-preview .cm-editor { filter: var(--code-viewer-filter); }
    .editor-toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); min-height: var(--control-h); color: var(--label-2); font-size: var(--fs-callout); }
    .editor-status { overflow-wrap: anywhere; }
    .secondary-button { border-color: var(--border); background: var(--control); color: var(--label); }
    .secondary-button:hover { background: var(--control-hover); }
    .editor-preview { min-height: 160px; overflow: auto; border: 1px solid var(--group-edge); border-radius: var(--r-group); background: var(--surface); }
    .editor-preview:empty { display: none; }
    .editor-preview > .artifact-doc { border: 0; border-radius: 0; }
    .editor-preview pre { margin: 0; padding: var(--sp-4); white-space: pre-wrap; overflow-wrap: anywhere; }
    .editor-preview-frame { display: block; width: 100%; min-height: 38vh; border: 0; background: var(--frame-bg); }
    .editor-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-2); }
    .editor-actions > a { display: inline-flex; align-items: center; min-height: var(--control-h); padding: 0 var(--sp-3); border-radius: var(--r-control); color: var(--label); font-weight: 500; }
    .editor-actions > a:hover { background: var(--hover); text-decoration: none; }

    /* Sign-in and other single-task pages: one centered sheet. */
    .auth-panel { max-width: 440px; }
    body:has(.auth-panel) .topbar { width: min(440px, calc(100% - 2 * var(--gutter))); margin-top: 12vh; }
    .auth-panel { display: grid; gap: var(--sp-3); }
    .auth-form .editor-fields { grid-template-columns: minmax(0, 1fr); gap: var(--sp-3); }
    .auth-form .editor-actions .btn { min-width: 96px; }
    .auth-panel > p { margin: 0; }
    .access-request-form { display: grid; gap: var(--sp-3); justify-items: start; padding: var(--sp-5); border: 1px solid var(--group-edge); border-radius: var(--r-group); background: var(--group); }
    .access-request-form p { margin: 0; }

    /* Status messages: tinted by meaning, never by color alone (each carries text). */
    .auth-error, .auth-success, .auth-warning, .auth-notice, .token-once, .conflict-banner {
      margin: 0;
      padding: 10px var(--sp-4);
      border: 1px solid var(--group-edge);
      border-radius: var(--r-group);
      background: var(--group);
      font-size: var(--fs-body);
    }
    .auth-error { border-color: var(--danger-border); background: var(--danger-bg); color: var(--danger-fg); }
    .auth-success { border-color: var(--success-border); background: var(--success-bg); color: var(--success-fg); }
    .auth-warning, .conflict-banner { border-color: var(--warning-border); background: var(--warning-bg); color: var(--warning-fg); }
    .auth-notice { border-color: transparent; background: var(--accent-soft); color: var(--label); }
    .conflict-banner { display: grid; gap: 6px; margin-bottom: var(--sp-4); }
    .conflict-banner p { margin: 0; }
    .conflict-banner a { width: fit-content; color: inherit; text-decoration: underline; }
    .token-once h2 { margin: 0 0 var(--sp-2); font-size: var(--fs-title-3); font-weight: 600; }

    /* Settings panes: grouped sheets with a headline, like System Settings. */
    .meta-card {
      display: grid;
      gap: var(--sp-3);
      margin-bottom: var(--sp-4);
      padding: var(--sp-5);
      border: 1px solid var(--group-edge);
      border-radius: var(--r-group);
      background: var(--group);
    }
    .meta-card h2 { margin: 0; font-size: var(--fs-title-3); font-weight: 600; line-height: 20px; }
    .meta-card h3 { margin: var(--sp-2) 0 0; font-size: var(--fs-body); font-weight: 600; }
    .meta-card p { margin: 0; }
    .meta-card { overflow-x: auto; }
    .meta-card table { width: 100%; }
    .data-table { width: 100%; border-collapse: collapse; font-size: var(--fs-body); }
    .data-table th, .data-table td { padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--separator); text-align: left; vertical-align: middle; }
    .data-table tr:last-child td { border-bottom: 0; }
    .data-table th { color: var(--label-2); font-size: var(--fs-callout); font-weight: 600; }
    .data-table form { margin: 0; }
    .settings-page { max-width: 1100px; }
    .settings-page .meta-card { gap: var(--sp-4); }
    .settings-page form > button { justify-self: start; width: fit-content; }
    .settings-page form:not(.editor-form) { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); }
    .settings-page .field { min-width: 0; }
    .settings-page textarea[name="allowedCidrs"] { min-height: 120px; height: 140px; }
    .settings-page .editor-form { gap: var(--sp-3); }
    .settings-page .editor-fields, .meta-card .editor-fields { padding: 0; border: 0; background: none; }
    .settings-page .user-role-form { display: flex; flex-wrap: nowrap; align-items: center; gap: var(--sp-2); }
    .user-account-actions { display: grid; justify-items: start; gap: var(--sp-2); }
    .user-role-form select { width: auto; min-width: 105px; }
    .user-role-form select, .user-role-form button { margin: 0; }
    .meta-card:has(> form[action="/admin/retention/run"]) { min-width: 0; overflow-wrap: anywhere; }
    form[action="/admin/retention/run"], form[action="/admin/retention/run"] > * { min-width: 0; }
    form[action="/admin/retention/run"] .checkbox-field { display: block; white-space: normal; overflow-wrap: anywhere; line-height: 1.6; }
    form[action="/admin/retention/run"] .checkbox-field input { margin-right: 6px; vertical-align: middle; }
    .retention-policy-form .retention-section { display: grid; gap: var(--sp-4); min-width: 0; margin: 0; padding: var(--sp-4); border: 1px solid var(--separator); border-radius: var(--r-group); }
    .retention-policy-form legend { padding: 0 6px; font-size: var(--fs-body); font-weight: 600; }
    .smtp-field-grid, .retention-field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: var(--sp-4); }
    .smtp-settings-form input, .smtp-settings-form select { min-width: 0; }
    .smtp-settings-form .field, .retention-policy-form .field { align-content: start; }
    .retention-policy-form input, .retention-policy-form textarea { width: 100%; min-width: 0; }
    .retention-policy-form textarea { min-height: 112px; height: 112px; }
    .token-create-form, .token-scopes { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-4); }
    .token-scopes legend { float: left; margin-right: var(--sp-2); color: var(--label-2); font-size: var(--fs-callout); font-weight: 500; }
    .token-scopes label { display: inline-flex; align-items: center; gap: 6px; }

    /* Inbox entries are grouped rows. */
    .inbox-view { display: grid; gap: var(--sp-3); }
    .inbox-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-3); }
    .inbox-toolbar p, .inbox-toolbar form { margin: 0; }
    .inbox-list { margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--group-edge); border-radius: var(--r-group); background: var(--group); list-style: none; }
    .inbox-item { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--sp-4); padding: var(--sp-3) var(--sp-4) var(--sp-3) var(--sp-8); }
    .inbox-item + .inbox-item::before { content: ""; position: absolute; top: 0; left: var(--sp-8); right: 0; height: 1px; background: var(--separator); }
    .inbox-item.is-unread::after { content: ""; position: absolute; top: 19px; left: 13px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
    .inbox-item h2 { margin: 0; font-size: var(--fs-headline); font-weight: 600; line-height: 19px; }
    .inbox-item:not(.is-unread) h2 { font-weight: 500; }
    .inbox-item h2 a { color: var(--label); }
    .inbox-item p { margin: 2px 0 0; font-size: var(--fs-callout); }
    .inbox-item-meta { color: var(--label-2); }
    .inbox-item-action p, .inbox-item-action form { margin: 0; }
    .inbox-empty { border: 1px solid var(--group-edge); border-radius: var(--r-group); background: var(--group); }

    @media (max-width: 900px) {
      .editor-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 640px) {
      .editor-fields, .smtp-field-grid, .retention-field-grid { grid-template-columns: minmax(0, 1fr); }
      .editor-fields { padding: var(--sp-4); }
      body:has(.auth-panel) .topbar { margin-top: var(--sp-8); }
    }
    @media (max-width: 1099px) {
      .dashboard-filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 899px) {
      .artifact-row { grid-template-columns: minmax(0, 1fr) auto; gap: 6px var(--sp-3); padding: var(--sp-3) var(--sp-4); }
      .artifact-row .row-main, .artifact-row .tags { grid-column: 1 / -1; }
      .row-agent { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; }
      .row-formats { justify-content: flex-end; }
    }
    @media (max-width: 760px) {
      :root { --gutter: var(--sp-4); }
      .dashboard-layout, .topbar { margin-top: var(--sp-5); }
      .topbar { align-items: flex-start; flex-direction: column; gap: var(--sp-3); }
      .topbar nav { justify-content: flex-start; margin-left: calc(-1 * 10px); }
      .toolbar-menu { right: auto; left: 0; }
      .topbar h1, .dashboard-heading h1 { font-size: var(--fs-title-1); line-height: 28px; }
      input:not([type="checkbox"]):not([type="radio"]), select, button { min-height: 44px; }
    }
    @media (max-width: 640px) {
      .dashboard-filter-grid, .dashboard-saved-content { grid-template-columns: 1fr; }
      .dashboard-search-row { flex-wrap: wrap; }
      .dashboard-search { flex-basis: calc(100% - 72px); }
      .dashboard-search-submit { display: none; }
      .dashboard-search .form-control[type="search"], .dashboard-search-row .btn { min-height: 44px; }
      .category-filter { order: 4; flex-basis: 100%; max-width: none; }
      .dashboard-advanced > summary, .dashboard-saved-views > summary { min-height: 44px; }
      .row-agent .publisher-cell { white-space: normal; overflow-wrap: anywhere; }
      .page-size-form select { min-height: 44px; }
    }
  </style>
  <link rel="stylesheet" href="/assets/ui-controls.css">
</head>
<body>
  ${body}
  ${afterBody}
</body>
</html>`;
}

function formatSelect(selected) {
  return `<select name="format" class="form-select">
    ${ARTIFACT_FORMATS.map((format) => {
      const label = format[0].toUpperCase() + format.slice(1);
      return `<option value="${format}"${format === selected ? " selected" : ""}>${label}</option>`;
    }).join("")}
  </select>`;
}

function artifactTypeSelect(selected) {
  return `<select name="artifactType" class="form-select">
    ${artifactTypeOptions(selected)}
  </select>`;
}

function visibilitySelect(selected, view) {
  return `<select name="visibility" class="form-select">
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

function renderDateTime(value, view) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return escapeHtml(value);
  const label = new Intl.DateTimeFormat(view.locale, { dateStyle: "medium", timeStyle: "short", timeZone: view.timeZone || currentDisplayTimeZone() }).format(date);
  return `<time datetime="${escapeAttribute(value)}" title="${escapeAttribute(value)}">${escapeHtml(label)} ${escapeHtml(view.timeZone || currentDisplayTimeZone())}</time>`;
}

function viewContext(locale, currentPath) {
  const i18n = createI18n(locale);
  return {
    locale: i18n.locale,
    timeZone: currentDisplayTimeZone(),
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

// The Artifacty mark: three hexagonal cells, agents meeting around one shared
// artifact (the light top cell). Shaded like an isometric solid: light top,
// mid left, dark right. The tab icon carries its own dark-scheme colors.
const MARK_CELLS = {
  top: "M12 3l4.33 2.5v5L12 13l-4.33-2.5v-5z",
  left: "M7.67 10.5 12 13v5l-4.33 2.5L3.34 18v-5z",
  right: "M16.33 10.5 20.66 13v5l-4.33 2.5L12 18v-5z"
};

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><style>.t{fill:#7cc4ee}.l{fill:#0f6aa6}.r{fill:#0a4570}@media (prefers-color-scheme:dark){.t{fill:#cbe8f8}.l{fill:#78bfe8}.r{fill:#3d8fc4}}</style><path class="l" d="${MARK_CELLS.left}"/><path class="r" d="${MARK_CELLS.right}"/><path class="t" d="${MARK_CELLS.top}"/></svg>`;

function brandMark() {
  return `<span class="brand-mark" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24">
    <path d="${MARK_CELLS.left}" fill="var(--mark-left)"/>
    <path d="${MARK_CELLS.right}" fill="var(--mark-right)"/>
    <path d="${MARK_CELLS.top}" fill="var(--mark-top)"/>
  </svg></span>`;
}

function typeBadge(value) {
  const type = String(value || "document");
  const slug = type.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `<span class="badge badge-type t-${escapeAttribute(slug)}">${escapeHtml(type)}</span>`;
}

function formatBadge(value) {
  const format = String(value || "text");
  const slug = format.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `<span class="badge badge-format f-${escapeAttribute(slug)}">${escapeHtml(format)}</span>`;
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

// Highlight explicit public/private visibility while keeping default team rows compact.
function visibilityBadge(artifact, view) {
  const visibility = artifact.visibility || "team";
  if (!["private", "public"].includes(visibility)) return "";
  return `<span class="badge v-${visibility}">${view.text(`artifact.visibility.${visibility}`)}</span>`;
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
    .diagram-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
    .diagram-controls[hidden] { display: none; }
    .diagram-controls button { min-width: 36px; min-height: 36px; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #111827; cursor: pointer; }
    .diagram-controls button:focus-visible, #artifacty-mermaid-viewport:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
    .diagram-controls button:disabled { opacity: .45; cursor: default; }
    .diagram-controls output { min-width: 4ch; text-align: center; font-variant-numeric: tabular-nums; }
    #artifacty-mermaid-viewport { overflow: auto; max-height: 560px; min-height: 240px; border: 1px solid #e2e8f0; border-radius: 8px; }
    #artifacty-mermaid { width: max-content; min-width: 100%; }
    #artifacty-mermaid svg { display: block; max-width: none !important; margin: 0 auto; }
    .error { white-space: pre-wrap; color: #991b1b; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px; }
  </style>
</head>
<body>
  <div class="diagram-controls" aria-label="Diagram zoom" hidden>
    <button type="button" id="diagram-zoom-out" aria-label="Zoom out">−</button>
    <output id="diagram-zoom-level" aria-live="polite">100%</output>
    <button type="button" id="diagram-zoom-in" aria-label="Zoom in">+</button>
    <button type="button" id="diagram-fit">Fit</button>
    <button type="button" id="diagram-actual">100%</button>
  </div>
  <div id="artifacty-mermaid-viewport" tabindex="0" role="region" aria-label="Diagram"><div id="artifacty-mermaid"></div></div>
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
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", layout: "dagre", theme: "default", look: "classic" });
      const result = await mermaid.render("artifacty-mermaid-svg", source);
      target.innerHTML = result.svg;
      const svg = target.querySelector("svg");
      const viewport = document.getElementById("artifacty-mermaid-viewport");
      const bounds = svg.viewBox.baseVal;
      const width = bounds.width || svg.getBoundingClientRect().width;
      const height = bounds.height || svg.getBoundingClientRect().height;
      if (width > 0 && height > 0) {
        const zoomOut = document.getElementById("diagram-zoom-out");
        const zoomIn = document.getElementById("diagram-zoom-in");
        const level = document.getElementById("diagram-zoom-level");
        let scale = 1;
        let fitting = true;
        function zoom(nextScale) {
          const previous = scale;
          const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / previous;
          const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / previous;
          scale = Math.max(0.01, Math.min(4, nextScale));
          svg.style.width = width * scale + "px";
          svg.style.height = height * scale + "px";
          level.textContent = Math.round(scale * 100) + "%";
          zoomOut.disabled = scale <= 0.01;
          zoomIn.disabled = scale >= 4;
          viewport.scrollLeft = Math.max(0, centerX * scale - viewport.clientWidth / 2);
          viewport.scrollTop = Math.max(0, centerY * scale - viewport.clientHeight / 2);
          report();
        }
        function fit() {
          fitting = true;
          zoom(Math.min(1, (viewport.clientWidth - 2) / width, 540 / height));
          viewport.scrollLeft = 0;
          viewport.scrollTop = 0;
        }
        zoomOut.addEventListener("click", () => { fitting = false; zoom(scale / 1.25); });
        zoomIn.addEventListener("click", () => { fitting = false; zoom(scale * 1.25); });
        document.getElementById("diagram-fit").addEventListener("click", fit);
        document.getElementById("diagram-actual").addEventListener("click", () => { fitting = false; zoom(1); });
        document.querySelector(".diagram-controls").hidden = false;
        window.addEventListener("resize", () => { if (fitting) fit(); });
        fit();
      }
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

function viewerScript(locale = DEFAULT_LOCALE) {
  const view = viewContext(locale, "/");
  const messages = Object.fromEntries(["filter", "filterColumn", "ruleFilter", "rowsShown", "resultsShown"].map((key) => [key, view.raw(`viewer.${key}`, { column: "{column}", visible: "{visible}", total: "{total}" })]));
  const config = JSON.stringify(messages).replaceAll("<", "\\u003c");
  return `<script type="application/json" id="artifacty-viewer-i18n">${config}</script><script type="module" src="${VIEWER_CLIENT_PATH}"></script>`;
}

function reactRendererEnabled() {
  return process.env.ARTIFACTY_ENABLE_REACT_RENDERER === "true";
}

function themeControls(view) {
  return `<fieldset class="theme-controls" data-theme-controls hidden><legend>${view.text("theme.label")}</legend>
    <div class="theme-choices">${["system", "light", "dark"].map((theme) => `<button type="button" data-theme-choice="${theme}" aria-pressed="${theme === "system"}" aria-label="${view.attr(`theme.${theme}`)}" title="${view.attr(`theme.${theme}`)}" class="btn btn-ghost">${uiIcon({ system: "device-desktop", light: "sun", dark: "moon" }[theme])}<span class="dashboard-sr-only">${view.text(`theme.${theme}`)}</span></button>`).join("")}</div>
  </fieldset>`;
}

function languageSwitcher(view) {
  const current = new URL(view.currentPath || "/", "http://artifacty.local");
  const preserved = [...current.searchParams.entries()].filter(([name]) => name !== "lang")
    .map(([name, value]) => `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}">`).join("");
  const options = availableLanguages().filter((language) => language.enabled).map((language) =>
    `<option value="${escapeAttribute(language.locale)}"${language.locale === view.locale ? " selected" : ""}>${escapeHtml(language.nativeName)}</option>`
  ).join("");
  return `<form class="language-switcher" data-auto-apply="all" method="get" action="${escapeAttribute(`${current.pathname}${current.hash}`)}">
    ${preserved}<label><span>${view.text("language.label")}</span><select name="lang" class="form-select">${options}</select></label>
    <button type="submit" class="btn btn-outline-secondary">${view.text("language.apply")}</button>
  </form>`;
}

function workspaceHeader(user, view) {
  const pathname = new URL(view.currentPath, "http://artifacty.local").pathname;
  const icons = { "/": "files", "/inbox": "inbox", "/new": "plus", "/import": "upload", "/admin/access": "settings", "/admin/users": "users", "/admin/backup": "database-export", "/admin/retention": "archive", "/admin/webhooks": "webhook", "/admin/update": "refresh", "/admin/languages": "language", "/admin/email": "mail", "/admin/display": "settings", "/account": "user-circle", "/account/password": "key", "/login": "login", "/docs/api": "code" };
  const link = (href, key, active = pathname === href, className = "") => `<a href="${view.href(href)}" title="${view.attr(key)}" aria-label="${view.attr(key)}"${active ? ' aria-current="page"' : ""}${className ? ` class="${className}"` : ""}>${uiIcon(icons[href] || "files")}<span class="workspace-nav-label">${view.text(key)}</span></a>`;
  const artifactActive = pathname === "/" || pathname.startsWith("/artifacts/");
  const adminLinks = user?.role === "admin" ? `<details class="workspace-dropdown"${pathname.startsWith("/admin/") ? " open" : ""}><summary${pathname.startsWith("/admin/") ? ' class="is-current"' : ""} title="${view.attr("nav.administration")}" aria-label="${view.attr("nav.administration")}">${uiIcon("settings")}<span class="workspace-nav-label">${view.text("nav.administration")}</span><span class="workspace-chevron">${uiIcon("chevron-down", { size: 14 })}</span></summary><div class="workspace-dropdown-content">
    ${link("/admin/access", "access.title")}${link("/admin/users", "nav.users")}${link("/admin/backup", "nav.backup")}${link("/admin/retention", "retention.navLabel")}${link("/admin/webhooks", "nav.webhooks")}${link("/admin/update", "update.title")}${link("/admin/display", "display.title")}${link("/admin/languages", "languageAdmin.title")}${link("/admin/email", "smtp.title")}<span class="workspace-version">Artifacty v${escapeHtml(APP_VERSION)}<a class="workspace-help" href="https://github.com/raeseoklee/artifacty" target="_blank" rel="noopener noreferrer" aria-label="${view.attr("nav.repositoryHelp")}" title="${view.attr("nav.repositoryHelp")}"><span aria-hidden="true">?</span></a></span>
  </div></details>` : "";
  const account = user ? `<details class="workspace-dropdown"${pathname.startsWith("/account") ? " open" : ""}><summary${pathname.startsWith("/account") ? ' class="is-current"' : ""} title="${view.attr("nav.account")}" aria-label="${view.attr("nav.account")}">${uiIcon("user-circle")}<span class="workspace-nav-label">${view.text("nav.account")}</span><span class="workspace-chevron">${uiIcon("chevron-down", { size: 14 })}</span></summary><div class="workspace-dropdown-content">
    <span class="workspace-identity">${escapeHtml(user.name || user.email || "")}</span>${link("/account", "nav.accountTokens")}${link("/account/password", "nav.password")}
    <form method="post" action="/logout" class="nav-form">${localeInput(view.locale)}<button type="submit" title="${view.attr("nav.signOut")}" aria-label="${view.attr("nav.signOut")}" class="btn btn-ghost">${uiIcon("logout")}<span class="workspace-nav-label">${view.text("nav.signOut")}</span></button></form>
  </div></details>` : user === null ? link("/login", "nav.signIn") : "";
  const links = `<div class="workspace-primary">${link("/", "nav.artifacts", artifactActive)}${user ? renderCategoryNavigation({ user, view }) + link("/inbox", "inbox.title") : ""}</div><div class="workspace-actions">${link("/new", "nav.new", pathname === "/new", "workspace-create")}${link("/collections/new", "collection.new")}${link("/import", "nav.import")}${adminLinks}${account}${link("/docs/api", "nav.apiDocs")}${languageSwitcher(view)}${themeControls(view)}</div>`;
  return `<a class="workspace-skip" href="#main-content">${view.text("nav.skip")}</a><header class="workspace-header"><div class="workspace-brand-row"><a class="workspace-brand" aria-label="Artifacty" href="${view.href("/")}">${brandMark()}<span class="workspace-brand-name">artifacty</span></a><button type="button" class="sidebar-toggle btn btn-ghost" data-sidebar-toggle hidden aria-expanded="true" aria-label="${view.attr("nav.collapseSidebar")}" title="${view.attr("nav.collapseSidebar")}" data-collapse-label="${view.attr("nav.collapseSidebar")}" data-expand-label="${view.attr("nav.expandSidebar")}"><span data-sidebar-collapse-icon>${uiIcon("layout-sidebar-left-collapse")}</span><span data-sidebar-expand-icon hidden>${uiIcon("layout-sidebar-left-expand")}</span></button></div>
    <nav class="workspace-desktop" aria-label="${view.attr("dashboard.navigation")}">${links}</nav>
    <details class="workspace-mobile"><summary>${uiIcon("menu-2", { size: 16 })}<span>${view.text("dashboard.more")}</span></summary><nav aria-label="${view.attr("dashboard.navigation")}">${links}</nav></details>
  </header>`;
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
      html.push(`<li class="task-list-item"><label><input type="checkbox" disabled${checked ? " checked" : ""} class="form-check-input"> ${inlineMarkdown(taskItem[2])}</label></li>`);
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
  const view = options.view || viewContext(options.locale || DEFAULT_LOCALE, "/");
  const mimeType = mediaMimeType(metadata, format);
  const source = options.rawUrl || mediaDataUrl(content, mimeType);
  if (!source) {
    return `<section class="artifact-media-note">
      ${view.text("media.unavailable")}
    </section>
    <pre class="artifact-code"><code>${escapeHtml(content)}</code></pre>`;
  }

  const label = [
    mimeType || format,
    metadata.encoding ? view.raw("media.encoding", { encoding: metadata.encoding }) : "",
    metadata.originalEncoding ? view.raw("media.source", { encoding: metadata.originalEncoding }) : ""
  ].filter(Boolean).join(" · ");

  if (format === "video") {
    return `<figure class="artifact-media artifact-video">
      <video controls preload="metadata" src="${escapeAttribute(source)}"></video>
      <figcaption>${escapeHtml(label || "video artifact")}</figcaption>
    </figure>`;
  }

  return `<figure class="artifact-media artifact-image">
    <img src="${escapeAttribute(source)}" alt="${view.text("media.image")}">
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

function renderCsv(content, view) {
  const parsed = parseCsv(content);
  if (!parsed.ok) {
    return `<section class="artifact-csv">
      <p class="artifact-csv-note">${view.text("csv.error", { error: parsed.error })}</p>
      <pre class="artifact-code"><code>${escapeHtml(content)}</code></pre>
    </section>`;
  }

  if (parsed.rows.length === 0) {
    return `<section class="artifact-csv"><p class="artifact-csv-note">${view.text("csv.empty")}</p></section>`;
  }

  const columnCount = Math.max(...parsed.rows.map((row) => row.length));
  const visibleColumns = Math.min(columnCount, CSV_RENDER_COLUMN_LIMIT);
  const header = parsed.rows[0];
  const bodyRows = parsed.rows.slice(1, CSV_RENDER_ROW_LIMIT + 1);
  const rowTruncated = parsed.rows.length - 1 > CSV_RENDER_ROW_LIMIT;
  const columnTruncated = columnCount > CSV_RENDER_COLUMN_LIMIT;
  const headerHtml = Array.from({ length: visibleColumns }, (_, index) =>
    `<th data-csv-col="${index}">${escapeHtml(header[index] || view.raw("csv.column", { column: index + 1 }))}</th>`
  ).join("");
  const bodyHtml = bodyRows.map((row) =>
    `<tr data-csv-row>${Array.from({ length: visibleColumns }, (_, index) =>
      `<td>${escapeHtml(row[index] || "")}</td>`
    ).join("")}</tr>`
  ).join("\n");
  const notes = [
    view.raw("csv.rows", { count: parsed.rows.length - 1 }),
    view.raw("csv.columns", { count: columnCount }),
    rowTruncated ? view.raw("csv.firstRows", { count: CSV_RENDER_ROW_LIMIT }) : "",
    columnTruncated ? view.raw("csv.firstColumns", { count: CSV_RENDER_COLUMN_LIMIT }) : ""
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

function renderSarif(content, view) {
  let sarif;
  try {
    sarif = JSON.parse(content);
  } catch {
    return `<section class="artifact-sarif">
      <p class="artifact-sarif-note">${view.text("sarif.invalid")}</p>
      <pre class="artifact-code"><code>${escapeHtml(content)}</code></pre>
    </section>`;
  }

  if (!isSarifDocument(sarif)) {
    return `<section class="artifact-sarif">
      <p class="artifact-sarif-note">${view.text("sarif.shape")}</p>
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
    ? view.raw("sarif.first", { count: SARIF_RENDER_RESULT_LIMIT, total: results.length })
    : view.raw("sarif.results", { count: results.length });

  return `<section class="artifact-sarif" data-artifact-sarif>
    <div class="artifact-summary-grid">
      ${summaryCard(view.raw("sarif.runs"), sarif.runs.length)}
      ${summaryCard(view.raw("sarif.resultsTitle"), results.length)}
      ${summaryCard(view.raw("sarif.errors"), counts.error || 0)}
      ${summaryCard(view.raw("sarif.warnings"), counts.warning || 0)}
      ${summaryCard(view.raw("sarif.notes"), counts.note || 0)}
    </div>
    <p class="artifact-sarif-note">${escapeHtml(note)}</p>
    <div class="artifact-table-scroll">
      <table class="artifact-table" data-sarif-table>
        <thead><tr><th data-sarif-sort="level">${view.text("sarif.level")}</th><th data-sarif-sort="rule">${view.text("sarif.rule")}</th><th>${view.text("sarif.message")}</th><th data-sarif-sort="location">${view.text("sarif.location")}</th><th>${view.text("sarif.tool")}</th></tr></thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </div>
    <details class="artifact-raw-details">
      <summary>${view.text("sarif.raw")}</summary>
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

function renderNotebook(content, view) {
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
    .map((cell) => renderNotebookCell(cell, language, diagramState, view))
    .join("");
  const notice = cells.length > NOTEBOOK_MAX_RENDERED_CELLS
    ? `<p class="artifact-notebook-notice">${view.text("notebook.cells", { count: NOTEBOOK_MAX_RENDERED_CELLS, total: cells.length })}</p>`
    : "";

  return `<article class="artifact-doc artifact-notebook">${notice}${rendered}</article>`;
}

function renderNotebookCell(cell, language, diagramState, view) {
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
      ? `<p class="artifact-notebook-notice">${view.text("notebook.outputs", { count: NOTEBOOK_MAX_OUTPUTS_PER_CELL, total: cellOutputs.length })}</p>`
      : "";
    const outputs = visibleOutputs.map((output) => renderNotebookOutput(output, diagramState, view)).join("") + outputsNotice;
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

function renderNotebookOutput(output, diagramState, view) {
  const outputType = output?.output_type;

  if (outputType === "stream") {
    return renderNotebookTextOutput(notebookText(output.text), "", view);
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
    return renderNotebookTextOutput(traceback, "artifact-notebook-error", view);
  }

  if (outputType === "execute_result" || outputType === "display_data") {
    return renderNotebookMimeBundle(output.data, diagramState, view);
  }

  return "";
}

function renderNotebookTextOutput(text, extraClass = "", view) {
  const truncated = notebookTruncateIfOversized(text, view);
  if (truncated) {
    return truncated;
  }
  const classAttribute = extraClass ? ` ${extraClass}` : "";
  return `<pre class="artifact-notebook-output artifact-code${classAttribute}"><code>${escapeHtml(text)}</code></pre>`;
}

function renderNotebookMimeBundle(data, diagramState, view) {
  const bundle = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const keys = Object.keys(bundle);
  if (keys.length === 0) {
    return "";
  }

  const mime = NOTEBOOK_OUTPUT_MIME_PRIORITY.find((candidate) => keys.includes(candidate));
  if (!mime) {
    return `<p class="artifact-notebook-output-placeholder">${view.text("notebook.unsupported", { type: keys[0] })}</p>`;
  }

  const value = notebookText(bundle[mime]);
  const truncated = notebookTruncateIfOversized(value, view);
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
      return `<p class="artifact-notebook-output-placeholder">${view.text("notebook.unsupported", { type: mime })}</p>`;
    }
    return `<figure class="artifact-media artifact-image artifact-notebook-output"><img src="${escapeAttribute(dataUrl)}" alt="${view.text("notebook.image")}"></figure>`;
  }
  if (mime === "image/svg+xml") {
    return `<iframe class="artifact-frame artifact-svg-frame artifact-notebook-output" sandbox srcdoc="${escapeAttribute(svgFrameContent(value))}"></iframe>`;
  }
  if (mime === "text/html") {
    return `<iframe class="artifact-frame artifact-notebook-output" sandbox="allow-scripts allow-forms allow-popups" srcdoc="${escapeAttribute(htmlFrameContent(value))}"></iframe>`;
  }
  return "";
}

function notebookTruncateIfOversized(value, view) {
  const size = Buffer.byteLength(String(value ?? ""), "utf8");
  if (size <= NOTEBOOK_MAX_OUTPUT_BYTES) {
    return null;
  }
  return `<p class="artifact-notebook-output-truncated">${view.text("notebook.truncated", { size })}</p>`;
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
