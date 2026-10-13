import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWebUpdater, runWebUpdate } from "../src/lib/web-update.js";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const currentVersion = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")).version;
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "artifacty-web-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "store");
  const userHome = path.join(directory, "user");
  await mkdir(home);
  const calls = [];
  let time = Date.now();
  const injected = { userHome, now: () => time,
    inspect: async () => ({ currentVersion }),
    update: async (options) => { calls.push(["update", options]); return { currentVersion, targetVersion: "99.0.0", updateAvailable: true, supported: true, reason: "SECRET STDERR" }; },
    run: async (command, args) => { calls.push([command, args]); return { stdout: "active\n" }; }, ...overrides };
  const updater = createWebUpdater({ home, packageRoot }, injected);
  return { updater, home, userHome, injected, calls, advance: (ms) => { time += ms; } };
}
const confirmed = (state, session = "session-a") => ({ session, confirmationId: state.check.confirmationId, targetVersion: state.check.targetVersion, confirmUpdate: "true" });

test("read-only status never checks npm or launches a process", async (t) => {
  const { updater, calls } = await fixture(t);
  assert.deepEqual(await updater.status("session-a"), { currentVersion, check: null, run: null });
  assert.deepEqual(calls, []);
});

test("confirmation binds the exact version, browser session, expiry and affirmative checkbox", async (t) => {
  const { updater, calls, advance } = await fixture(t);
  const state = await updater.check("session-a");
  assert.equal(state.check.reason, undefined, "Raw upstream reasons must not leak");
  assert.equal((await updater.status("different")).check.confirmationId, null);
  for (const change of [{ session: "different" }, { targetVersion: "99.0.1" }, { confirmUpdate: "false" }, { confirmationId: "invented" }]) {
    await assert.rejects(updater.start({ ...confirmed(state), ...change }), { code: "UPDATE_CONFIRMATION_REQUIRED" });
  }
  advance(10 * 60 * 1000 + 1);
  await assert.rejects(updater.start(confirmed(state)), { code: "UPDATE_CONFIRMATION_REQUIRED" });
  assert.equal(calls.filter(([command]) => command === "systemd-run").length, 0);
});

test("confirmed update launches a fixed independent transient service once", async (t) => {
  const { updater, calls } = await fixture(t);
  const checked = await updater.check("session-a");
  const started = await updater.start(confirmed(checked));
  assert.equal(started.run.state, "queued");
  const launch = calls.find(([command]) => command === "systemd-run")[1];
  assert.ok(launch.includes("--user"));
  assert.ok(launch.includes("--property=Type=exec"));
  assert.ok(!launch.includes("--scope"));
  assert.deepEqual(launch.slice(-3), [process.execPath, path.join(packageRoot, "src", "update-runner.js"), started.run.id]);
  assert.ok(!JSON.stringify(launch).includes("session-a"));
  await assert.rejects(updater.start(confirmed(checked)), { code: "UPDATE_BUSY" });
  await assert.rejects(updater.check("session-a"), { code: "UPDATE_BUSY" });
});

test("unsupported servers can check releases but cannot confirm installation", async (t) => {
  const { updater, calls } = await fixture(t, { inspect: async () => { throw new Error("not managed"); } });
  const checked = await updater.check("session-a");
  assert.equal(checked.check.targetVersion, "99.0.0");
  assert.equal(checked.check.supported, false);
  assert.equal(calls.filter(([command]) => command === "update").length, 1);
  await assert.rejects(updater.start(confirmed(checked)), { code: "UPDATE_CONFIRMATION_REQUIRED" });
});

test("registry errors cannot be mistaken for a successful up-to-date check", async (t) => {
  const { updater } = await fixture(t, { update: async () => { throw new Error("SECRET npm stderr"); } });
  const checked = await updater.check("session-a");
  assert.equal(checked.check.errorCode, "UPDATE_CHECK_FAILED");
  assert.equal(checked.check.targetVersion, undefined);
  assert.ok(!JSON.stringify(checked).includes("SECRET"));
});

test("an uncertain dispatch remains reserved and a missing worker becomes interrupted", async (t) => {
  const { updater, advance } = await fixture(t, { run: async (command) => {
    if (command === "systemd-run") throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    return { stdout: "inactive\n" };
  } });
  const checked = await updater.check("session-a");
  assert.equal((await updater.start(confirmed(checked))).run.state, "queued");
  await assert.rejects(updater.start(confirmed(checked)), { code: "UPDATE_BUSY" });
  advance(31000);
  const state = await updater.status("session-a");
  assert.equal(state.run.state, "interrupted");
  await assert.rejects(updater.check("session-a"), { code: "UPDATE_BUSY" });
});

test("worker persists progress and success outside a replaced artifact store, and refuses replay", async (t) => {
  const { updater, userHome, home } = await fixture(t);
  const checked = await updater.check("session-a");
  const started = await updater.start(confirmed(checked));
  await runWebUpdate(started.run.id, { userHome, update: async (options) => {
    assert.equal(options.targetVersion, "99.0.0");
    options.onProgress("Stopping service.");
    await rm(home, { recursive: true });
    await mkdir(home);
    return { updated: true, currentVersion, targetVersion: "99.0.0", backupId: "backup-1" };
  } });
  const state = await updater.status("session-a");
  assert.equal(state.run.state, "succeeded");
  assert.equal(state.run.result.backupId, "backup-1");
  await assert.rejects(runWebUpdate(started.run.id, { userHome }));
});

test("rollback failure retains safe recovery information without exposing process errors", async (t) => {
  const { updater, userHome } = await fixture(t);
  const started = await updater.start(confirmed(await updater.check("session-a")));
  await runWebUpdate(started.run.id, { userHome, update: async () => {
    throw Object.assign(new Error("SECRET npm stderr"), { code: "UPDATE_RECOVERY_INCOMPLETE", backupId: "backup-2", backupPath: "/recovery/backup-2" });
  } });
  const state = await updater.status("session-a");
  assert.equal(state.run.state, "failed");
  assert.equal(state.run.errorCode, "UPDATE_RECOVERY_INCOMPLETE");
  assert.equal(state.run.result.backupId, "backup-2");
  assert.ok(!JSON.stringify(state).includes("SECRET"));
});

test("job identifiers and persisted package paths cannot select arbitrary worker code", async (t) => {
  const { updater, userHome } = await fixture(t);
  await assert.rejects(runWebUpdate("../../evil", { userHome }), { code: "INVALID_UPDATE_JOB" });
  const started = await updater.start(confirmed(await updater.check("session-a")));
  const requestFile = path.join(userHome, ".local/share/artifacty/update-jobs", `${started.run.id}.json`);
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  await writeFile(requestFile, JSON.stringify({ ...request, packageRoot: tmpdir() }));
  await assert.rejects(runWebUpdate(started.run.id, { userHome }), { code: "INVALID_UPDATE_JOB" });
});

test("lost launch acknowledgment cannot overwrite a worker's completed result", async (t) => {
  let userHome;
  const setup = await fixture(t, { run: async (command, args) => {
    if (command === "systemd-run") {
      await runWebUpdate(args.at(-1), { userHome, update: async () => ({ updated: true, targetVersion: "99.0.0" }) });
      throw Object.assign(new Error("acknowledgment lost"), { code: "ETIMEDOUT" });
    }
    return { stdout: "inactive\n" };
  } });
  userHome = setup.userHome;
  const state = await setup.updater.start(confirmed(await setup.updater.check("session-a")));
  assert.equal(state.run.state, "succeeded");
  assert.equal(state.run.result.updated, true);
});

test("changed service identity is rejected before launch even after a valid check", async (t) => {
  let inspections = 0;
  const { updater, calls } = await fixture(t, { inspect: async () => {
    if (++inspections > 1) throw Object.assign(new Error("different PID"), { code: "SERVICE_IDENTITY_MISMATCH" });
  } });
  const checked = await updater.check("session-a");
  await assert.rejects(updater.start(confirmed(checked)), { code: "SERVICE_IDENTITY_MISMATCH" });
  assert.ok(!calls.some(([command]) => command === "systemd-run"));
});

test("web eligibility verifies the exact managed server PID before trusting its package", async (t) => {
  const { inspectWebUpdateService } = await import("../src/lib/self-update.js");
  const { home } = await fixture(t);
  let verified = false;
  const injected = { platform: "linux", uid: 1000,
    run: async (_command, args) => ({ stdout: args.includes("cat")
      ? `ExecStart="${process.execPath}" "${path.join(packageRoot, "src/server.js")}" --home "${home}"\n`
      : "LoadState=loaded\nActiveState=active\nMainPID=12345\n" }),
    verifyServiceIdentity: async (pid) => { assert.equal(pid, 12345); verified = true; }
  };
  // unitArguments intentionally supports POSIX systemd paths only.
  if (process.platform === "win32") return;
  await assert.rejects(inspectWebUpdateService({ home, pid: 54321 }, injected), { code: "SERVICE_IDENTITY_MISMATCH" });
  assert.equal(verified, false);
  assert.equal((await inspectWebUpdateService({ home, pid: 12345 }, injected)).currentVersion, currentVersion);
  assert.equal(verified, true);
  await assert.rejects(inspectWebUpdateService({ home, pid: 12345 }, { ...injected, uid: 0 }), { code: "UNSUPPORTED_SERVICE" });
});

test("a broad store home does not break construction or read-only status", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "artifacty-broad-home-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const updater = createWebUpdater({ home: directory, packageRoot }, { userHome: directory });
  const state = await updater.status("session-a");
  assert.equal(state.currentVersion, currentVersion);
  assert.equal(state.supported, false);
  assert.equal(state.run, null);
  await assert.rejects(updater.check("session-a"), { code: "UNSAFE_UPDATE_STATE" });
  await assert.rejects(lstat(path.join(directory, ".local")), { code: "ENOENT" });
});


test("POSIX update state and worker requests must remain private", { skip: process.platform === "win32" }, async (t) => {
  const { updater, userHome } = await fixture(t);
  const checked = await updater.check("session-a");
  const root = path.join(userHome, ".local", "share", "artifacty", "update-jobs");
  await chmod(root, 0o755);
  await assert.rejects(updater.start(confirmed(checked)), { code: "UNSAFE_UPDATE_STATE" });
  await chmod(root, 0o700);
  const started = await updater.start(confirmed(checked));
  const requestFile = path.join(root, `${started.run.id}.json`);
  await chmod(requestFile, 0o644);
  let invoked = false;
  await assert.rejects(runWebUpdate(started.run.id, { userHome, update: async () => { invoked = true; } }), { code: "UNSAFE_UPDATE_STATE" });
  assert.equal(invoked, false);
});
