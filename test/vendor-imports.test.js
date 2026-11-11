import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EDITOR_VENDOR_PACKAGES, editorImportMapJson, editorVendorPath } from "../src/lib/editor-assets.js";

// npm skips the optional Babel 8 renderer below Node ^22.18.0 || >=24.11.0, so
// only require it where npm installs it. Elsewhere it must be absent, not broken.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const babelSupported = !((nodeMajor === 22 && nodeMinor < 18) || (nodeMajor === 24 && nodeMinor < 11) || nodeMajor === 23);

test("browser vendor entries resolve their bare imports through the import map", async () => {
  const imports = JSON.parse(editorImportMapJson()).imports;
  for (const name of EDITOR_VENDOR_PACKAGES) {
    const file = editorVendorPath(name, process.cwd());
    // Older CodeMirror versions include StringStream in the language package.
    if (!file && name === "@codemirror/streamparser") continue;
    if (!file && name === "@babel/standalone" && !babelSupported) continue;
    assert.ok(file, name);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/^(?:import|export)\s+[^;\n]*?\bfrom\s*["']([^"']+)["']/gm)) {
      const specifier = match[1];
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      assert.ok(imports[specifier], name + " imports unmapped " + specifier);
    }
  }
});
