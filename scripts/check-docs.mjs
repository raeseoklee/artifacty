#!/usr/bin/env node
// Check repository documentation links and images shipped with the npm README.
import { readdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const errors = [];
async function markdownFiles(directory, recursive = false) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isFile() && name.endsWith(".md")) result.push(name);
    else if (recursive && entry.isDirectory()) result.push(...await markdownFiles(name, true));
  }
  return result;
}
function prose(text) {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "");
}
function anchors(text) {
  const ids = new Set([...text.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
  const used = new Set();
  for (const match of prose(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1].toLowerCase().replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/\s/g, "-");
    let id = base;
    let suffix = 0;
    while (used.has(id)) id = `${base}-${++suffix}`;
    used.add(id);
    ids.add(id);
  }
  return ids;
}
const files = [...await markdownFiles(root), ...await markdownFiles(path.join(root, "docs"), true)];
let checked = 0;
const readmeImages = new Set();
for (const file of files) {
  const text = prose(await readFile(file, "utf8"));
  for (const match of text.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[2];
    if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(target)) continue;
    const [relative, fragment] = target.split("#");
    const resolved = relative ? path.resolve(path.dirname(file), decodeURIComponent(relative)) : file;
    const label = `${path.relative(root, file)}: ${target}`;
    try {
      const info = await stat(resolved);
      if (fragment && info.isFile() && resolved.endsWith(".md")) {
        if (!anchors(await readFile(resolved, "utf8")).has(decodeURIComponent(fragment))) errors.push(`${label} (missing anchor)`);
      }
      if (match[1] && /^README(?:\.ko)?\.md$/.test(path.relative(root, file))) readmeImages.add(path.relative(root, resolved).split(path.sep).join("/"));
      checked++;
    } catch {
      errors.push(`${label} (missing target)`);
    }
  }
}
const pack = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
if (pack.status !== 0) errors.push(`npm pack dry run failed: ${pack.stderr}`);
else {
  const shipped = new Set(JSON.parse(pack.stdout)[0].files.map(file => file.path));
  for (const image of readmeImages) if (!shipped.has(image)) errors.push(`${image} (README image missing from npm package)`);
  for (const file of files.filter(file => file.startsWith(path.join(root, "docs") + path.sep))) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (!shipped.has(relative)) errors.push(`${relative} (documentation missing from npm package)`);
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} Markdown files, ${checked} local links, and npm documentation/image inclusion.`);
}
