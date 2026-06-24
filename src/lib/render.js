import { EDITOR_CLIENT_PATH, editorImportMapJson } from "./editor-assets.js";
import { createI18n, DEFAULT_LOCALE, editorMessages, localizedHref, switchLocaleHref } from "./i18n.js";

export function renderDashboard({ artifacts, baseUrl, filters = {}, locale = DEFAULT_LOCALE, currentPath = "/" }) {
  const view = viewContext(locale, currentPath);
  const rows = artifacts
    .map((artifact) => {
      const tags = artifact.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
      const status = artifact.archivedAt ? statusBadge("archived") : "";
      return `
        <a class="artifact-row" href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}`)}">
          <span class="row-main">
            <strong>${escapeHtml(artifact.title)}</strong>
            <span>${escapeHtml(artifact.id)}</span>
          </span>
          <span>${escapeHtml(artifact.sourceAgent)}</span>
          ${typeBadge(artifact.artifactType || "document")}
          ${formatBadge(artifact.format || "text")}
          <span>v${artifact.latestVersion}</span>
          <span class="tags">${status}${tags}</span>
        </a>
      `;
    })
    .join("");

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
          ${languageSwitcher(view)}
        </nav>
      </header>
      <main class="dashboard">
        <section class="toolbar">
          <span>${view.text("dashboard.count", { count: artifacts.length })}</span>
        </section>
        <form class="filter-form" method="get" action="/">
          ${localeInput(view.locale)}
          <input name="q" value="${escapeAttribute(filters.query || "")}" placeholder="${view.attr("filter.search")}">
          <input name="tag" value="${escapeAttribute(filters.tag || "")}" placeholder="${view.attr("filter.tag")}">
          <input name="sourceAgent" value="${escapeAttribute(filters.sourceAgent || "")}" placeholder="${view.attr("filter.source")}">
          <label class="checkbox-field"><input type="checkbox" name="includeArchived" value="true"${filters.includeArchived ? " checked" : ""}> ${view.text("filter.archived")}</label>
          <button type="submit">${view.text("filter.submit")}</button>
          <a href="${view.href("/")}">${view.text("filter.clear")}</a>
        </form>
        <section class="artifact-list">
          ${rows || `<div class="empty">${view.text("dashboard.empty")}</div>`}
        </section>
      </main>
    `,
    locale: view.locale
  });
}

export function renderArtifactFormPage({ mode, baseUrl, artifact, version, content, authToken = "", locale = DEFAULT_LOCALE, currentPath = "/" }) {
  const view = viewContext(locale, currentPath);
  const isEdit = mode === "edit";
  const title = isEdit ? view.raw("form.editTitle", { title: artifact.title }) : view.raw("form.newTitle");
  const action = isEdit ? `/artifacts/${encodeURIComponent(artifact.id)}/edit` : "/new";
  const format = version?.format || "markdown";
  const sourceAgent = artifact?.sourceAgent || "artifacty";
  const artifactType = artifact?.artifactType || "document";
  const tags = artifact?.tags?.join(", ") || "";
  const body = content ?? "# New artifact";

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
        <form class="editor-form" method="post" action="${action}">
          ${hiddenToken(authToken)}
          ${localeInput(view.locale)}
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

export function renderArtifactPage({ artifact, version, content, baseUrl, authToken = "", locale = DEFAULT_LOCALE, currentPath = "/" }) {
  const view = viewContext(locale, currentPath);
  const versionLinks = artifact.versions
    .map((item) => {
      const active = item.version === version.version ? " active" : "";
      return `<a class="version${active}" href="${view.href(`/artifacts/${encodeURIComponent(artifact.id)}?version=${item.version}`)}">v${item.version}</a>`;
    })
    .join("");

  const rendered = renderContent(version.format, content);
  const rawUrl = `/artifacts/${encodeURIComponent(artifact.id)}/raw?version=${version.version}`;
  const archiveAction = artifact.archivedAt ? "restore" : "archive";
  const archiveLabel = artifact.archivedAt ? view.text("artifact.restore") : view.text("artifact.archive");

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
          <a href="${view.href(rawUrl)}">${view.text("nav.raw")}</a>
          ${languageSwitcher(view)}
        </nav>
      </header>
      <main class="artifact-view">
        <section class="meta-strip">
          ${formatBadge(version.format)}
          ${typeBadge(artifact.artifactType || "document")}
          <span>${view.text("artifact.schema", { version: artifact.schemaVersion || 1 })}</span>
          ${artifact.archivedAt ? statusBadge(view.text("artifact.archived", { date: artifact.archivedAt })) : ""}
          <span>${view.text("artifact.bytes", { size: version.sizeBytes })}</span>
          <span>${escapeHtml(version.createdAt)}</span>
          <span>${escapeHtml(version.sha256.slice(0, 12))}</span>
        </section>
        <form class="inline-action" method="post" action="/artifacts/${encodeURIComponent(artifact.id)}/${archiveAction}">
          ${hiddenToken(authToken)}
          ${localeInput(view.locale)}
          <button type="submit">${archiveLabel}</button>
        </form>
        <section class="version-strip">${versionLinks}</section>
        ${rendered}
      </main>
    `,
    afterBody: frameResizeScript(),
    locale: view.locale
  });
}

export function renderDiffPage({ artifact, fromVersion, toVersion, fromContent, toContent, diffRows, baseUrl, locale = DEFAULT_LOCALE, currentPath = "/" }) {
  const view = viewContext(locale, currentPath);
  const title = view.raw("diff.title", { title: artifact.title });
  const versionOptions = artifact.versions
    .map((item) => `<option value="${item.version}">v${item.version}</option>`)
    .join("");

  const rows = diffRows
    .map((row) => `
      <tr class="diff-${row.type}">
        <td>${escapeHtml(row.beforeLine)}</td>
        <td>${escapeHtml(row.afterLine)}</td>
        <td><code>${escapeHtml(diffPrefix(row.type))}${escapeHtml(row.text)}</code></td>
      </tr>
    `)
    .join("");

  const preview = toVersion.format === "html"
    ? `<section class="split-preview">
        <div>${renderContent(fromVersion.format, fromContent)}</div>
        <div>${renderContent(toVersion.format, toContent)}</div>
      </section>`
    : "";

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
        <table class="diff-table">
          <thead><tr><th>${view.text("diff.from")}</th><th>${view.text("diff.to")}</th><th>${view.text("diff.line")}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${preview}
      </main>
    `,
    locale: view.locale
  });
}

export function renderContent(format, content) {
  if (format === "html") {
    return `<iframe class="artifact-frame" sandbox="allow-scripts allow-forms allow-popups" srcdoc="${escapeAttribute(htmlFrameContent(content))}"></iframe>`;
  }

  if (format === "markdown") {
    return `<article class="artifact-doc">${markdownToHtml(content)}</article>`;
  }

  if (format === "json") {
    return `<pre class="artifact-code"><code>${escapeHtml(formatJson(content))}</code></pre>`;
  }

  return `<pre class="artifact-code"><code>${escapeHtml(content)}</code></pre>`;
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
      display: grid;
      grid-template-columns: minmax(180px, 1fr) 160px 160px auto auto auto;
      gap: 10px;
      margin-bottom: 12px;
      align-items: end;
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
    .editor-form {
      display: grid;
      gap: 16px;
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
      grid-template-columns: minmax(220px, 1fr) 120px 120px 90px 64px minmax(120px, 220px);
      gap: 16px;
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
    .artifact-row > span:not(.row-main):not(.tags):not(.badge) {
      font-family: var(--mono);
      font-size: 12.5px;
      color: var(--muted);
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
    .badge.t-unknown { --bh: #94a3b8; }
    .badge.f-html { --bh: #e0795b; }
    .badge.f-markdown { --bh: #3b82f6; }
    .badge.f-text { --bh: #5b6b7f; }
    .badge.f-json { --bh: #16a34a; }
    .badge.s-archived { --bh: #94a3b8; }
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
    .diff-table code {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
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
    .artifact-code {
      padding: 22px;
      overflow: auto;
      color: var(--code-text);
      background: var(--code);
      min-height: 50vh;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
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
    ${["markdown", "html", "text", "json"].map((format) => {
      const label = format[0].toUpperCase() + format.slice(1);
      return `<option value="${format}"${format === selected ? " selected" : ""}>${label}</option>`;
    }).join("")}
  </select>`;
}

function artifactTypeSelect(selected) {
  const types = ["document", "html-page", "handoff", "code-review", "test-report", "dashboard", "design-option", "diff-walkthrough", "bundle", "asset", "unknown"];
  return `<select name="artifactType">
    ${types.map((type) => `<option value="${type}"${type === selected ? " selected" : ""}>${escapeHtml(type)}</option>`).join("")}
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

function statusBadge(label) {
  return `<span class="badge s-archived">${label}</span>`;
}

function htmlFrameContent(content) {
  const reporter = `<script>(function(){function report(){var doc=document.documentElement;var body=document.body;var height=Math.max(doc.scrollHeight,doc.offsetHeight,body?body.scrollHeight:0,body?body.offsetHeight:0);parent.postMessage({__artifactyHeight:height},"*");}window.addEventListener("load",report);window.addEventListener("resize",report);if(window.ResizeObserver){try{new ResizeObserver(report).observe(document.documentElement);}catch(error){}}var ticks=0;var timer=setInterval(function(){report();if(++ticks>8){clearInterval(timer);}},250);report();})();</script>`;
  if (content.includes("</body>")) {
    return content.replace("</body>", `${reporter}</body>`);
  }
  return `${content}${reporter}`;
}

function frameResizeScript() {
  return `<script>(function(){var frame=document.querySelector(".artifact-frame");if(!frame){return;}window.addEventListener("message",function(event){if(event.source!==frame.contentWindow){return;}var data=event.data;if(!data||typeof data.__artifactyHeight!=="number"){return;}var height=Math.min(Math.max(Math.ceil(data.__artifactyHeight),200),200000);frame.style.height=height+"px";});})();</script>`;
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

function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let inCode = false;
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

  for (const line of lines) {
    if (line.startsWith("```")) {
      flushParagraph();
      closeList();
      if (inCode) {
        html.push("</code></pre>");
        inCode = false;
      } else {
        html.push("<pre><code>");
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      html.push(`${escapeHtml(line)}\n`);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      closeList();
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
    html.push("</code></pre>");
  }
  return html.join("\n");
}

function inlineMarkdown(value) {
  return escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function formatJson(content) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
