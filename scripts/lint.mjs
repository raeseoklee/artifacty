#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const targets = [
  { dir: "src", pattern: /\.js$/ },
  { dir: path.join("src", "lib"), pattern: /\.js$/ },
  { dir: path.join("src", "client"), pattern: /\.js$/ },
  { dir: "test", pattern: /\.test\.js$/ }
];

const files = [];

for (const target of targets) {
  const entries = await readdir(target.dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && target.pattern.test(entry.name)) {
      files.push(path.join(target.dir, entry.name));
    }
  }
}

files.sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
