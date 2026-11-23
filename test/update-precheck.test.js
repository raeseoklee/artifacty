import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { probePackage } from "../src/lib/self-update.js";
import { createWebUpdater } from "../src/lib/web-update.js";
import { renderAdminUpdatePage } from "../src/lib/render.js";

const tarball = "https://registry.example.test/artifacty/-/artifacty-99.0.0.tgz";
const npmView = (stdout) => async (command, args) => {
  assert.equal(command, "npm");
  assert.deepEqual(args, ["view", "artifacty@99.0.0", "dist.tarball", "--json"]);
  return { stdout };
};
const respond = (status) => async (url, options) => {
  assert.equal(url, tarball);
  assert.equal(options.headers.range, "bytes=0-0", "only the first byte is requested");
  return { status, ok: status >= 200 && status < 300, body: { cancel: async () => {} } };
};

test("the package probe reports a missing tarball and stays neutral when unsure", async () => {
  const url = JSON.stringify(tarball);
  assert.equal(await probePackage(npmView(url), "99.0.0", {}, respond(404)), false);
  assert.equal(await probePackage(npmView(url), "99.0.0", {}, respond(410)), false);
  assert.equal(await probePackage(npmView(url), "99.0.0", {}, respond(206)), true);
  assert.equal(await probePackage(npmView(url), "99.0.0", {}, respond(200)), true);
  assert.equal(await probePackage(npmView(url), "99.0.0", {}, respond(401)), null, "a private registry may need credentials");
  assert.equal(await probePackage(npmView(url), "99.0.0", {}, async () => { throw new Error("offline"); }), null);
  assert.equal(await probePackage(npmView('"file:/tmp/x.tgz"'), "99.0.0", {}, respond(404)), null);
  assert.equal(await probePackage(async () => { throw new Error("npm failed"); }, "99.0.0", {}, respond(404)), null);
});

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const currentVersion = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")).version;

test("a release npm cannot download yet cannot be started from the browser", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "artifacty-precheck-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "store");
  await mkdir(home);
  const updater = createWebUpdater({ home, packageRoot }, {
    userHome: path.join(directory, "user"),
    inspect: async () => ({ currentVersion }),
    update: async () => ({ currentVersion, targetVersion: "99.0.0", updateAvailable: true, supported: true, packageAvailable: false }),
    run: async () => ({ stdout: "active\n" })
  });
  const state = await updater.check("session-a");
  assert.equal(state.check.packageUnavailable, true);
  await assert.rejects(updater.start({ session: "session-a", confirmationId: state.check.confirmationId, targetVersion: "99.0.0", confirmUpdate: "true" }), { code: "UPDATE_CONFIRMATION_REQUIRED" });

  for (const [locale, message] of [["en", /npm cannot download it yet/], ["ko", /아직 내려받을 수 없습니다/]]) {
    const html = renderAdminUpdatePage({ baseUrl: "http://localhost", user: { role: "admin" }, locale, status: { currentVersion, check: state.check } });
    assert.match(html, message);
    assert.match(html, /v99\.0\.0/);
    assert.doesNotMatch(html, /action="\/admin\/update\/start"/);
  }
});
