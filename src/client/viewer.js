import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";

const viewerTheme = EditorView.theme({
  "&": {
    minHeight: "50vh"
  },
  ".cm-content": {
    minHeight: "50vh"
  },
  ".cm-scroller": {
    overflow: "auto"
  }
});

for (const container of document.querySelectorAll("[data-artifacty-code-viewer]")) {
  enhanceCodeViewer(container);
}

for (const codeEl of document.querySelectorAll("pre > code[class*='language-']")) {
  enhanceMarkdownCodeBlock(codeEl);
}

enhanceMermaidEmbeds();

for (const section of document.querySelectorAll("[data-artifact-csv]")) {
  enhanceCsvViewer(section);
}

for (const section of document.querySelectorAll("[data-artifact-sarif]")) {
  enhanceSarifViewer(section);
}

function enhanceCodeViewer(container) {
  const source = container.querySelector("textarea")?.value || "";
  const fallback = container.querySelector(".artifact-code-fallback");
  const language = container.dataset.language || "";

  const mount = document.createElement("div");
  mount.className = "artifact-codemirror-mount";
  container.append(mount);

  new EditorView({
    doc: source,
    parent: mount,
    extensions: [
      basicSetup,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      viewerTheme,
      languageExtension(language)
    ]
  });

  fallback?.remove();
}

function languageExtension(language) {
  const normalized = String(language || "").trim().toLowerCase();
  if (["js", "javascript", "jsx"].includes(normalized)) {
    return javascript({ jsx: true });
  }
  if (["ts", "typescript", "tsx"].includes(normalized)) {
    return javascript({ typescript: true, jsx: normalized === "tsx" });
  }
  if (["html", "xml", "svg"].includes(normalized)) {
    return html();
  }
  if (normalized === "json") {
    return json();
  }
  if (["md", "markdown"].includes(normalized)) {
    return markdown();
  }
  return [];
}

// --- Markdown/notebook embedded rendering (roadmap section 14 and 15) -----
//
// The server always renders fenced code blocks as escaped
// `<pre><code class="language-x">` (see markdownToHtml/renderMarkdownCodeFence
// in src/lib/render.js), so the page is already correct without JS. This
// only upgrades that markup to read-only CodeMirror highlighting.

function enhanceMarkdownCodeBlock(codeEl) {
  const pre = codeEl.closest("pre");
  if (!pre || !pre.isConnected) {
    return;
  }
  const match = /language-([a-zA-Z0-9+#_.-]+)/.exec(codeEl.className || "");
  const language = match ? match[1] : "";
  const source = codeEl.textContent || "";

  const mount = document.createElement("div");
  mount.className = "artifact-doc-codemirror";

  new EditorView({
    doc: source,
    parent: mount,
    extensions: [
      basicSetup,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      viewerTheme,
      languageExtension(language)
    ]
  });

  pre.replaceWith(mount);
}

// ```mermaid``` fences render server-side as a placeholder
// (`[data-artifacty-mermaid]`) carrying the base64-encoded sandboxed iframe
// srcdoc that whole-document Mermaid artifacts already use. Each placeholder
// is upgraded into a real iframe lazily, only once it scrolls into view, to
// avoid paying Mermaid's render cost for diagrams the viewer never sees.
function enhanceMermaidEmbeds() {
  const placeholders = document.querySelectorAll("[data-artifacty-mermaid]");
  if (placeholders.length === 0) {
    return;
  }

  if (!("IntersectionObserver" in window)) {
    placeholders.forEach(mountMermaidEmbed);
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        mountMermaidEmbed(entry.target);
      }
    }
  });

  placeholders.forEach((placeholder) => observer.observe(placeholder));
}

function mountMermaidEmbed(placeholder) {
  const encoded = placeholder.dataset.mermaidSrcdoc;
  if (!encoded) {
    return;
  }
  let srcdoc;
  try {
    // atob() yields a Latin-1 byte string; the srcdoc was UTF-8 encoded
    // before being base64'd (render.js), so it must be decoded as UTF-8
    // here too or non-ASCII labels (e.g. Korean) come out as mojibake.
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    srcdoc = new TextDecoder().decode(bytes);
  } catch {
    return;
  }
  const iframe = document.createElement("iframe");
  iframe.className = "artifact-frame artifact-mermaid-frame";
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.srcdoc = srcdoc;
  placeholder.replaceChildren(iframe);
  delete placeholder.dataset.artifactyMermaid;
}

// --- CSV sort, filter, and visible row count (roadmap section 7) ---------
//
// Progressive enhancement: the table is already fully rendered server-side
// with bounded rows/columns (see renderCsv in src/lib/render.js). Without
// this script the table still displays correctly; this only adds
// client-side sort/filter over the data already in the DOM.

function enhanceCsvViewer(section) {
  const table = section.querySelector("[data-csv-table]");
  const headerRow = table?.querySelector("thead tr");
  const headerCells = headerRow ? Array.from(headerRow.querySelectorAll("th[data-csv-col]")) : [];
  const tbody = table?.querySelector("tbody");
  const rows = tbody ? Array.from(tbody.querySelectorAll("tr[data-csv-row]")) : [];
  if (!table || !tbody || headerCells.length === 0 || rows.length === 0) {
    return;
  }

  const status = document.createElement("p");
  status.className = "artifact-csv-status";
  status.hidden = true;
  const note = section.querySelector(".artifact-csv-note");
  if (note) {
    note.insertAdjacentElement("afterend", status);
  } else {
    table.insertAdjacentElement("beforebegin", status);
  }

  let sortColumn = -1;
  let sortDirection = "";

  const sortButtons = headerCells.map((th, index) => {
    const label = th.textContent;
    th.textContent = "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "csv-sort-btn";
    button.append(document.createTextNode(label));
    const indicator = document.createElement("span");
    indicator.className = "csv-sort-indicator";
    button.append(indicator);
    th.append(button);
    button.addEventListener("click", () => {
      if (sortColumn === index) {
        sortDirection = sortDirection === "asc" ? "desc" : sortDirection === "desc" ? "" : "asc";
      } else {
        sortColumn = index;
        sortDirection = "asc";
      }
      updateSortIndicators();
      apply();
    });
    return { button, indicator };
  });

  function updateSortIndicators() {
    sortButtons.forEach(({ indicator }, index) => {
      indicator.textContent = index === sortColumn && sortDirection
        ? (sortDirection === "asc" ? " ▲" : " ▼")
        : "";
    });
  }

  const filterRow = document.createElement("tr");
  filterRow.className = "csv-filter-row";
  const filterInputs = headerCells.map((_headerCell, index) => {
    const cell = document.createElement("th");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "csv-filter-input";
    input.placeholder = "Filter";
    input.setAttribute("aria-label", `Filter column ${index + 1}`);
    input.addEventListener("input", apply);
    cell.append(input);
    filterRow.append(cell);
    return input;
  });
  headerRow.insertAdjacentElement("afterend", filterRow);

  function cellValue(row, index) {
    return (row.children[index]?.textContent || "").trim();
  }

  function compareValues(a, b) {
    const trimmedA = a.trim();
    const trimmedB = b.trim();
    const numericA = trimmedA !== "" && Number.isFinite(Number(trimmedA));
    const numericB = trimmedB !== "" && Number.isFinite(Number(trimmedB));
    if (numericA && numericB) {
      return Number(trimmedA) - Number(trimmedB);
    }
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }

  function apply() {
    const activeFilters = filterInputs
      .map((input, index) => ({ index, term: input.value.trim().toLowerCase() }))
      .filter((entry) => entry.term);

    let visible = rows.filter((row) =>
      activeFilters.every((entry) => cellValue(row, entry.index).toLowerCase().includes(entry.term))
    );

    if (sortColumn >= 0 && sortDirection) {
      const direction = sortDirection === "asc" ? 1 : -1;
      visible = visible.slice().sort((a, b) =>
        direction * compareValues(cellValue(a, sortColumn), cellValue(b, sortColumn))
      );
    }

    const visibleSet = new Set(visible);
    const fragment = document.createDocumentFragment();
    rows.forEach((row) => {
      row.hidden = !visibleSet.has(row);
    });
    visible.forEach((row) => fragment.append(row));
    rows.forEach((row) => {
      if (!visibleSet.has(row)) {
        fragment.append(row);
      }
    });
    tbody.append(fragment);

    status.hidden = false;
    status.textContent = `${visible.length} of ${rows.length} rows shown`;
  }

  apply();
}

// --- SARIF level filter, rule filter, and sort (roadmap section 7) -------

function enhanceSarifViewer(section) {
  const table = section.querySelector("[data-sarif-table]");
  const tbody = table?.querySelector("tbody");
  const rows = tbody ? Array.from(tbody.querySelectorAll("tr[data-sarif-result]")) : [];
  if (!table || !tbody || rows.length === 0) {
    return;
  }

  const controls = document.createElement("div");
  controls.className = "sarif-controls";

  const chipsWrap = document.createElement("div");
  chipsWrap.className = "sarif-level-chips";
  const activeLevels = new Set();
  ["error", "warning", "note", "none"].forEach((level) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "sarif-chip";
    chip.textContent = level;
    chip.setAttribute("aria-pressed", "false");
    chip.addEventListener("click", () => {
      if (activeLevels.has(level)) {
        activeLevels.delete(level);
        chip.classList.remove("active");
        chip.setAttribute("aria-pressed", "false");
      } else {
        activeLevels.add(level);
        chip.classList.add("active");
        chip.setAttribute("aria-pressed", "true");
      }
      apply();
    });
    chipsWrap.append(chip);
  });

  const ruleInput = document.createElement("input");
  ruleInput.type = "text";
  ruleInput.className = "sarif-rule-filter";
  ruleInput.placeholder = "Filter by rule id";
  ruleInput.setAttribute("aria-label", "Filter by rule id");
  ruleInput.addEventListener("input", apply);

  controls.append(chipsWrap, ruleInput);

  const note = section.querySelector(".artifact-sarif-note");
  if (note) {
    note.insertAdjacentElement("afterend", controls);
  } else {
    table.insertAdjacentElement("beforebegin", controls);
  }

  const status = document.createElement("p");
  status.className = "artifact-sarif-status";
  status.hidden = true;
  controls.insertAdjacentElement("afterend", status);

  const sortHeaders = Array.from(table.querySelectorAll("th[data-sarif-sort]"));
  let sortKey = "";
  let sortDirection = "";
  const levelRank = { error: 0, warning: 1, note: 2, none: 3 };

  const sortButtons = sortHeaders.map((th) => {
    const key = th.dataset.sarifSort;
    const label = th.textContent;
    th.textContent = "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "csv-sort-btn";
    button.append(document.createTextNode(label));
    const indicator = document.createElement("span");
    indicator.className = "csv-sort-indicator";
    button.append(indicator);
    th.append(button);
    button.addEventListener("click", () => {
      if (sortKey === key) {
        sortDirection = sortDirection === "asc" ? "desc" : sortDirection === "desc" ? "" : "asc";
      } else {
        sortKey = key;
        sortDirection = "asc";
      }
      updateIndicators();
      apply();
    });
    return { key, indicator };
  });

  function updateIndicators() {
    sortButtons.forEach(({ key, indicator }) => {
      indicator.textContent = key === sortKey && sortDirection
        ? (sortDirection === "asc" ? " ▲" : " ▼")
        : "";
    });
  }

  function compareRows(a, b) {
    if (sortKey === "level") {
      const rankA = levelRank[a.dataset.level] ?? 9;
      const rankB = levelRank[b.dataset.level] ?? 9;
      return rankA - rankB;
    }
    if (sortKey === "rule") {
      return (a.dataset.rule || "").localeCompare(b.dataset.rule || "", undefined, { numeric: true, sensitivity: "base" });
    }
    if (sortKey === "location") {
      return (a.dataset.location || "").localeCompare(b.dataset.location || "", undefined, { numeric: true, sensitivity: "base" });
    }
    return 0;
  }

  function apply() {
    const ruleTerm = ruleInput.value.trim().toLowerCase();
    let visible = rows.filter((row) => {
      if (activeLevels.size > 0 && !activeLevels.has(row.dataset.level)) {
        return false;
      }
      if (ruleTerm && !(row.dataset.rule || "").toLowerCase().includes(ruleTerm)) {
        return false;
      }
      return true;
    });

    if (sortKey && sortDirection) {
      const direction = sortDirection === "asc" ? 1 : -1;
      visible = visible.slice().sort((a, b) => direction * compareRows(a, b));
    }

    const visibleSet = new Set(visible);
    const fragment = document.createDocumentFragment();
    rows.forEach((row) => {
      row.hidden = !visibleSet.has(row);
    });
    visible.forEach((row) => fragment.append(row));
    rows.forEach((row) => {
      if (!visibleSet.has(row)) {
        fragment.append(row);
      }
    });
    tbody.append(fragment);

    status.hidden = false;
    status.textContent = `${visible.length} of ${rows.length} results shown`;
  }

  apply();
}
