import path from "node:path";

export const EDITOR_CLIENT_PATH = "/assets/editor.js";

export const EDITOR_VENDOR_PACKAGES = [
  "@codemirror/autocomplete",
  "@codemirror/commands",
  "@codemirror/lang-css",
  "@codemirror/lang-html",
  "@codemirror/lang-javascript",
  "@codemirror/lang-json",
  "@codemirror/lang-markdown",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/css",
  "@lezer/highlight",
  "@lezer/html",
  "@lezer/javascript",
  "@lezer/json",
  "@lezer/lr",
  "@lezer/markdown",
  "@marijn/find-cluster-break",
  "codemirror",
  "crelt",
  "style-mod",
  "w3c-keyname"
];

const EDITOR_VENDOR_SET = new Set(EDITOR_VENDOR_PACKAGES);
const EDITOR_VENDOR_ENTRY_OVERRIDES = {
  "@marijn/find-cluster-break": path.join("src", "index.js"),
  crelt: "index.js",
  "style-mod": path.join("src", "style-mod.js"),
  "w3c-keyname": "index.js"
};

export function editorImportMapJson() {
  return JSON.stringify({
    imports: Object.fromEntries(
      EDITOR_VENDOR_PACKAGES.map((packageName) => [packageName, `/vendor/npm/${packageName}`])
    )
  });
}

export function editorVendorPath(packageName, packageRoot) {
  if (!EDITOR_VENDOR_SET.has(packageName)) {
    return null;
  }
  const entry = EDITOR_VENDOR_ENTRY_OVERRIDES[packageName] || path.join("dist", "index.js");
  return path.join(packageRoot, "node_modules", packageName, entry);
}

export function editorClientFilePath(packageRoot) {
  return path.join(packageRoot, "src", "client", "editor.js");
}
