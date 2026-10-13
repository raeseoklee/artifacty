import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run through npm so Windows can invoke npm-cli.js directly without a shell.
assert.ok(process.env.npm_execpath, "Run npm run verify:encryption-install");
const root = fileURLToPath(new URL("..", import.meta.url));
const stage = mkdtempSync(path.join(tmpdir(), "artifacty-install-check-"));
const npm = (cwd, ...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000
});

try {
  console.log("Packing the consumer archive.");
  const [packed] = JSON.parse(npm(root, "pack", "--ignore-scripts", "--json", "--pack-destination", stage));
  const tarball = path.join(stage, packed.filename);
  for (const ignoreScripts of [false, true]) {
    const prefix = path.join(stage, ignoreScripts ? "updater" : "normal");
    // An empty working directory prevents accidental access to repository-local
    // dependencies from making a broken published package appear to work.
    console.log(`Installing ${ignoreScripts ? "with scripts disabled" : "with normal scripts"}.`);
    npm(stage, "install", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund",
      "--package-lock=false", ...(ignoreScripts ? ["--ignore-scripts"] : []), tarball);
    // Release the native DLL by exiting the probe process before cleanup.
    execFileSync(process.execPath, [fileURLToPath(new URL("./probe-encryption-install.mjs", import.meta.url)), prefix], {
      cwd: stage, stdio: "inherit", timeout: 60_000
    });
    console.log(`Packed consumer installation passed (${ignoreScripts ? "updater --ignore-scripts" : "normal scripts"}).`);
  }
} finally {
  console.log("Removing temporary installation directories.");
  rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
