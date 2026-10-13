import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Run through npm so Windows can invoke npm-cli.js directly without a shell.
assert.ok(process.env.npm_execpath, "Run npm run verify:encryption-install");
const root = fileURLToPath(new URL("..", import.meta.url));
const stage = mkdtempSync(path.join(tmpdir(), "artifacty-install-check-"));
const npm = (cwd, ...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000
});

try {
  const [packed] = JSON.parse(npm(root, "pack", "--ignore-scripts", "--json", "--pack-destination", stage));
  const tarball = path.join(stage, packed.filename);
  for (const ignoreScripts of [false, true]) {
    const prefix = path.join(stage, ignoreScripts ? "updater" : "normal");
    // An empty working directory prevents accidental access to repository-local
    // dependencies from making a broken published package appear to work.
    npm(stage, "install", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund",
      "--package-lock=false", ...(ignoreScripts ? ["--ignore-scripts"] : []), tarball);
    const library = path.join(prefix, "node_modules", "artifacty", "src", "lib");
    const installedRequire = createRequire(path.join(library, "encrypted-database.js"));
    const driverPackage = installedRequire("better-sqlite3-multiple-ciphers/package.json");
    assert.equal(driverPackage.version, "13.0.3");
    assert.equal(driverPackage.scripts.install, 'node -e ""');
    const { openEncryptedDatabase } = await import(pathToFileURL(path.join(library, "encrypted-database.js")));
    const { encryptContent, decryptContent } = await import(pathToFileURL(path.join(library, "encrypted-content.js")));
    const key = randomBytes(32);
    const file = path.join(prefix, "probe.sqlite");
    const db = openEncryptedDatabase(file, { key });
    try {
      db.exec("CREATE VIRTUAL TABLE content USING fts5(body)");
      db.prepare("INSERT INTO content(body) VALUES (?)").run("installprobe7a92");
      assert.equal(db.prepare("SELECT body FROM content WHERE content MATCH ?").get("installprobe7a92").body, "installprobe7a92");
    } finally { db.close(); }
    assert.equal(readFileSync(file).includes(Buffer.from("installprobe7a92")), false);
    const reopened = openEncryptedDatabase(file, { key, readOnly: true });
    try { assert.equal(reopened.prepare("SELECT count(*) AS count FROM content").get().count, 1); }
    finally { reopened.close(); }
    assert.throws(() => openEncryptedDatabase(file, { key: randomBytes(32) }), { code: "ENCRYPTED_DATABASE_OPEN_FAILED" });
    const context = { key, storeId: "install", artifactId: "probe", version: 1, keyId: "test" };
    const bytes = Buffer.from([0, 255, 128, 10]);
    assert.deepEqual(decryptContent(encryptContent(bytes, context), context), bytes);
    key.fill(0);
    console.log(`Packed consumer installation passed (${ignoreScripts ? "updater --ignore-scripts" : "normal scripts"}).`);
  }
} finally {
  rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
