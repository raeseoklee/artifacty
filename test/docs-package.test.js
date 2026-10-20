import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const checker = await readFile(new URL("../scripts/check-docs.mjs", import.meta.url), "utf8");

async function fixture(t, excluded = []) {
  const root = await mkdtemp(path.join(tmpdir(), "artifacty-doc-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "docs", "assets"), { recursive: true });
  await writeFile(path.join(root, "scripts", "check-docs.mjs"), checker);
  await writeFile(path.join(root, "README.md"), "# Fixture\n\n[Guide](docs/guide.md#workflow)\n");
  await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n\n## Workflow\n\n![Feature](assets/feature.png)\n");
  await writeFile(path.join(root, "docs", "assets", "feature.png"), "image fixture");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "artifacty-doc-check-fixture",
    version: "1.0.0",
    files: ["README.md", "docs/guide.md", "docs/assets/feature.png", "scripts/check-docs.mjs"].filter(file => !excluded.includes(file))
  }));
  return root;
}

function check(root) {
  return execFileAsync(process.execPath, [path.join(root, "scripts", "check-docs.mjs")], { cwd: root });
}

test("documentation checker accepts packaged manual images and working section links", async (t) => {
  const root = await fixture(t);
  const { stdout } = await check(root);
  assert.match(stdout, /Checked 2 Markdown files, 2 local links/);
});

test("documentation checker rejects a manual-only screenshot omitted from npm", async (t) => {
  const root = await fixture(t, ["docs/assets/feature.png"]);
  await assert.rejects(check(root), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /docs\/assets\/feature.png \(documentation image missing from npm package\)/);
    return true;
  });
});

test("documentation checker rejects a missing packaged command", async (t) => {
  const root = await fixture(t, ["scripts/check-docs.mjs"]);
  await assert.rejects(check(root), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /docs:check command missing from npm package/);
    return true;
  });
});
