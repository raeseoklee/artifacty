import path from "node:path";

export const EDITOR_CLIENT_PATH = "/assets/editor.js";
export const VIEWER_CLIENT_PATH = "/assets/viewer.js";

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
  "@babel/standalone",
  "codemirror",
  "crelt",
  "mermaid",
  "react",
  "react-dom",
  "style-mod",
  "w3c-keyname"
];

const EDITOR_VENDOR_SET = new Set(EDITOR_VENDOR_PACKAGES);
const EDITOR_VENDOR_ENTRY_OVERRIDES = {
  "@babel/standalone": "babel.min.js",
  "@marijn/find-cluster-break": path.join("src", "index.js"),
  crelt: "index.js",
  mermaid: path.join("dist", "mermaid.esm.min.mjs"),
  react: path.join("umd", "react.production.min.js"),
  "react-dom": path.join("umd", "react-dom.production.min.js"),
  "style-mod": path.join("src", "style-mod.js"),
  "w3c-keyname": "index.js"
};

const EDITOR_VENDOR_IMPORT_OVERRIDES = {
  mermaid: "/vendor/npm/mermaid/dist/mermaid.esm.min.mjs"
};

export function editorImportMapJson() {
  return JSON.stringify({
    imports: Object.fromEntries(
      EDITOR_VENDOR_PACKAGES.map((packageName) => [
        packageName,
        EDITOR_VENDOR_IMPORT_OVERRIDES[packageName] || `/vendor/npm/${packageName}`
      ])
    )
  });
}

export function editorVendorPath(specifier, packageRoot) {
  const { packageName, subpath } = splitPackageSpecifier(specifier);
  if (!EDITOR_VENDOR_SET.has(packageName)) {
    return null;
  }
  if (subpath) {
    const packageDir = path.join(packageRoot, "node_modules", packageName);
    const candidate = path.normalize(path.join(packageDir, subpath));
    if (!candidate.startsWith(packageDir + path.sep)) {
      return null;
    }
    return candidate;
  }
  const entry = EDITOR_VENDOR_ENTRY_OVERRIDES[packageName] || path.join("dist", "index.js");
  return path.join(packageRoot, "node_modules", packageName, entry);
}

function splitPackageSpecifier(specifier) {
  const parts = String(specifier || "").split("/").filter(Boolean);
  if (parts[0]?.startsWith("@")) {
    return {
      packageName: parts.slice(0, 2).join("/"),
      subpath: parts.slice(2).join("/")
    };
  }
  return {
    packageName: parts[0] || "",
    subpath: parts.slice(1).join("/")
  };
}

export function editorClientFilePath(packageRoot) {
  return path.join(packageRoot, "src", "client", "editor.js");
}

export function viewerClientFilePath(packageRoot) {
  return path.join(packageRoot, "src", "client", "viewer.js");
}
