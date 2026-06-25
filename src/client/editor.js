import { EditorView, basicSetup } from "codemirror";
import { Compartment } from "@codemirror/state";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";

const messages = {
  formatJson: "Format JSON",
  validJson: "Valid JSON",
  invalidJson: "Invalid JSON: {message}",
  htmlPreview: "HTML preview",
  markdownPreview: "Markdown preview",
  plainText: "Plain text",
  mode: "{format} editor",
  ...(globalThis.ARTIFACTY_I18N || {})
};

const SUPPORTED_FORMATS = ["markdown", "html", "json", "text", "code", "svg", "mermaid", "react", "sarif", "csv", "image", "video"];

const editorTheme = EditorView.theme({
  "&": {
    minHeight: "52vh",
    border: "1px solid var(--line)",
    borderRadius: "8px",
    background: "var(--panel)"
  },
  ".cm-scroller": {
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    fontSize: "13px",
    lineHeight: "1.55"
  },
  ".cm-content": {
    minHeight: "52vh"
  },
  ".cm-gutters": {
    borderTopLeftRadius: "8px",
    borderBottomLeftRadius: "8px"
  }
});

for (const textarea of document.querySelectorAll("textarea[data-artifacty-editor]")) {
  enhanceTextarea(textarea);
}

function enhanceTextarea(textarea) {
  const form = textarea.closest("form");
  const formatSelector = form?.querySelector("select[name='format']");
  const fileNameInput = form?.querySelector("input[name='fileName']");
  const language = new Compartment();
  const shell = document.createElement("div");
  shell.className = "codemirror-shell";
  shell.setAttribute("data-enhanced", "true");

  const toolbar = document.createElement("div");
  toolbar.className = "editor-toolbar";

  const status = document.createElement("span");
  status.className = "editor-status";

  const formatJsonButton = document.createElement("button");
  formatJsonButton.type = "button";
  formatJsonButton.className = "secondary-button";
  formatJsonButton.textContent = messages.formatJson;

  toolbar.append(formatJsonButton, status);
  textarea.after(toolbar, shell);
  textarea.classList.add("textarea-enhanced");

  const preview = document.createElement("section");
  preview.className = "editor-preview";
  preview.setAttribute("aria-live", "polite");
  shell.after(preview);

  const currentFormat = () => detectFormat({
    explicit: formatSelector?.value || textarea.dataset.editorFormat,
    fileName: fileNameInput?.value || "",
    content: view.state.doc.toString()
  });

  const view = new EditorView({
    doc: textarea.value,
    parent: shell,
    extensions: [
      basicSetup,
      EditorView.lineWrapping,
      editorTheme,
      language.of(languageExtension(detectFormat({
        explicit: formatSelector?.value || textarea.dataset.editorFormat,
        fileName: fileNameInput?.value || "",
        content: textarea.value
      }))),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          textarea.value = update.state.doc.toString();
          updatePreview();
        }
      })
    ]
  });

  const reconfigure = () => {
    const format = currentFormat();
    view.dispatch({ effects: language.reconfigure(languageExtension(format)) });
    updateToolbar(format);
    updatePreview();
  };

  formatSelector?.addEventListener("change", reconfigure);
  fileNameInput?.addEventListener("input", reconfigure);
  form?.addEventListener("submit", () => {
    textarea.value = view.state.doc.toString();
  });

  formatJsonButton.addEventListener("click", () => {
    const content = view.state.doc.toString();
    try {
      const formatted = JSON.stringify(JSON.parse(content), null, 2);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: formatted }
      });
      status.textContent = messages.validJson;
    } catch (error) {
      status.textContent = invalidJsonMessage(error);
    }
  });

  updateToolbar(currentFormat());
  updatePreview();

  function updateToolbar(format) {
    formatJsonButton.hidden = format !== "json" && format !== "sarif";
    status.textContent = formatLabel(format);
  }

  function updatePreview() {
    const format = currentFormat();
    const content = view.state.doc.toString();
    preview.replaceChildren();
    preview.dataset.format = format;

    if (format === "html") {
      const frame = document.createElement("iframe");
      frame.className = "editor-preview-frame";
      frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
      frame.srcdoc = content;
      preview.append(frame);
      status.textContent = messages.htmlPreview;
      return;
    }

    if (format === "svg") {
      const frame = document.createElement("iframe");
      frame.className = "editor-preview-frame";
      frame.setAttribute("sandbox", "");
      frame.srcdoc = content;
      preview.append(frame);
      status.textContent = formatLabel(format);
      return;
    }

    if (format === "json" || format === "sarif") {
      const pre = document.createElement("pre");
      try {
        pre.textContent = JSON.stringify(JSON.parse(content), null, 2);
        status.textContent = messages.validJson;
      } catch (error) {
        pre.textContent = content;
        status.textContent = invalidJsonMessage(error);
      }
      preview.append(pre);
      return;
    }

    if (format === "markdown") {
      const article = document.createElement("article");
      article.className = "artifact-doc";
      article.innerHTML = markdownPreview(content);
      preview.append(article);
      status.textContent = messages.markdownPreview;
      return;
    }

    const pre = document.createElement("pre");
    pre.textContent = content;
    preview.append(pre);
    status.textContent = messages.plainText;
  }
}

function languageExtension(format) {
  if (format === "html" || format === "svg") {
    return html();
  }
  if (format === "json" || format === "sarif") {
    return json();
  }
  if (format === "markdown") {
    return markdown();
  }
  return [];
}

function detectFormat({ explicit, fileName, content }) {
  if (SUPPORTED_FORMATS.includes(explicit)) {
    return explicit;
  }

  const lowerName = String(fileName || "").toLowerCase();
  if (lowerName.endsWith(".html") || lowerName.endsWith(".htm")) {
    return "html";
  }
  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) {
    return "markdown";
  }
  if (lowerName.endsWith(".sarif") || lowerName.endsWith(".sarif.json")) {
    return "sarif";
  }
  if (lowerName.endsWith(".csv")) {
    return "csv";
  }
  if (/\.(png|jpe?g|gif|webp)$/.test(lowerName)) {
    return "image";
  }
  if (/\.(mp4|webm)$/.test(lowerName)) {
    return "video";
  }
  if (lowerName.endsWith(".json")) {
    return "json";
  }
  if (lowerName.endsWith(".svg")) {
    return "svg";
  }
  if (lowerName.endsWith(".mmd") || lowerName.endsWith(".mermaid")) {
    return "mermaid";
  }
  if (lowerName.endsWith(".jsx") || lowerName.endsWith(".tsx")) {
    return "react";
  }
  if (/\.(js|ts|py|rb|go|rs|java|c|cc|cpp|cs|php|swift|kt|sh|bash|zsh)$/.test(lowerName)) {
    return "code";
  }

  const trimmed = String(content || "").trimStart();
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?<svg[\s>]/i.test(trimmed)) {
    return "svg";
  }
  if (/^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|erDiagram|gantt|pie|mindmap|journey)\b/m.test(trimmed)) {
    return "mermaid";
  }
  if (/\b(import\s+React|from\s+['"]react['"]|export\s+default\s+function|export\s+default\s+\()/m.test(trimmed) || /<[A-Z][A-Za-z0-9]*[\s/>]/.test(trimmed)) {
    return "react";
  }
  if (trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || trimmed.startsWith("<")) {
    return "html";
  }
  if (looksLikeSarif(trimmed)) {
    return "sarif";
  }
  if (looksLikeCsv(trimmed)) {
    return "csv";
  }
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(trimmed)) {
    return "image";
  }
  if (/^data:video\/(?:mp4|webm);base64,/i.test(trimmed)) {
    return "video";
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "json";
  }
  if (/^#{1,6}\s/m.test(trimmed)) {
    return "markdown";
  }
  return "text";
}

function formatLabel(format) {
  const label = `${format[0].toUpperCase()}${format.slice(1)}`;
  return messages.mode.replaceAll("{format}", label);
}

function looksLikeSarif(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith("{")) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.runs) &&
      (typeof parsed.version === "string" || String(parsed.$schema || "").toLowerCase().includes("sarif"));
  } catch {
    return false;
  }
}

function looksLikeCsv(value) {
  const lines = String(value || "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 5);
  if (lines.length < 2 || lines[0].trimStart().startsWith("|")) {
    return false;
  }
  const counts = lines.map(csvFieldCount);
  return counts[0] > 1 && counts.every((count) => count === counts[0]);
}

function csvFieldCount(line) {
  let count = 1;
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (inQuotes && line[index + 1] === "\"") {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      count += 1;
    }
  }
  return count;
}

function invalidJsonMessage(error) {
  return messages.invalidJson.replaceAll("{message}", error.message);
}

function markdownPreview(content) {
  return String(content || "")
    .split(/\r?\n/)
    .map((line) => {
      if (/^###\s+/.test(line)) {
        return `<h3>${escapeHtml(line.replace(/^###\s+/, ""))}</h3>`;
      }
      if (/^##\s+/.test(line)) {
        return `<h2>${escapeHtml(line.replace(/^##\s+/, ""))}</h2>`;
      }
      if (/^#\s+/.test(line)) {
        return `<h1>${escapeHtml(line.replace(/^#\s+/, ""))}</h1>`;
      }
      if (/^[-*]\s+/.test(line)) {
        return `<p>• ${escapeHtml(line.replace(/^[-*]\s+/, ""))}</p>`;
      }
      if (!line.trim()) {
        return "<br>";
      }
      return `<p>${escapeHtml(line)}</p>`;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
