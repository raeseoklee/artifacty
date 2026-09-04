import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const srcDir = path.join(repoRoot, "src");

// Any `ARTIFACTY_*` identifier read from process.env (directly, or via a
// config object that defaults to process.env, as embeddings.js does) is an
// operator-facing environment variable and must be documented in README.md
// and in `node src/cli.js help`'s Environment section. Object keys that
// happen to start with ARTIFACTY_ but are not environment variables (e.g.
// the ARTIFACTY_EVENT_* keys passed as subprocess env for `artifacty watch
// --exec`, or the window.ARTIFACTY_I18N client global) are excluded below.
const NOT_ENV_VARS = new Set([
  "ARTIFACTY_EVENT_TYPE",
  "ARTIFACTY_EVENT_ARTIFACT_ID",
  "ARTIFACTY_EVENT_VERSION",
  "ARTIFACTY_I18N",
  "ARTIFACTY_EMBEDDINGS_" // prefix constant, not a variable name
]);

async function collectJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

async function envVarsReadInSrc() {
  const files = await collectJsFiles(srcDir);
  const found = new Set();
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const matches = content.matchAll(/\bARTIFACTY_[A-Z0-9_]+\b/g);
    for (const [name] of matches) {
      if (!NOT_ENV_VARS.has(name)) {
        found.add(name);
      }
    }
  }
  return found;
}

test("every ARTIFACTY_* environment variable read in src/ is documented in README.md", async () => {
  const envVars = await envVarsReadInSrc();
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

  const missing = [...envVars].filter((name) => !readme.includes(name)).sort();
  assert.deepEqual(missing, [], `README.md is missing documentation for: ${missing.join(", ")}`);
});

test("every ARTIFACTY_* environment variable read in src/ is documented in the CLI help env section", async () => {
  const envVars = await envVarsReadInSrc();
  const cliSource = await readFile(path.join(srcDir, "cli.js"), "utf8");
  const envSectionMatch = cliSource.match(/Environment:\r?\n([\s\S]*?)`\);/);
  assert.ok(envSectionMatch, "cli.js help output must contain an Environment: section");
  const envSection = envSectionMatch[1];

  const missing = [...envVars].filter((name) => !envSection.includes(name)).sort();
  assert.deepEqual(missing, [], `cli.js help Environment section is missing: ${missing.join(", ")}`);
});
