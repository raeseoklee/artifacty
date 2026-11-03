import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EDITOR_VENDOR_PACKAGES, editorImportMapJson, editorVendorPath } from "../src/lib/editor-assets.js";

test("browser vendor entries resolve their bare imports through the import map", async () => {
  const imports = JSON.parse(editorImportMapJson()).imports;
  for (const name of EDITOR_VENDOR_PACKAGES) {
    const file = editorVendorPath(name, process.cwd());
    // Older CodeMirror versions include StringStream in the language package.
    if (!file && name === "@codemirror/streamparser") continue;
    assert.ok(file, name);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/^(?:import|export)\s+[^;\n]*?\bfrom\s*["']([^"']+)["']/gm)) {
      const specifier = match[1];
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      assert.ok(imports[specifier], name + " imports unmapped " + specifier);
    }
  }
});
