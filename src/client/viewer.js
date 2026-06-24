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
