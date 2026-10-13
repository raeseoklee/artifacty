import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, open, rm, lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";
import { updateApplication, inspectWebUpdateService } from "./self-update.js";

const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIVE = new Set(["queued", "running"]);
const needsRecovery = (run) => run?.state === "interrupted" || run?.errorCode === "UPDATE_RECOVERY_INCOMPLETE";
const fail = (message, code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const unitName = (id) => `artifacty-update-${id}.service`;
const runnerStateRoot = (userHome) => path.join(userHome, ".local", "share", "artifacty", "update-jobs");

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (process.platform !== "win32" && (info.mode & 0o077))) {
    throw fail("Update state directory must be private and owned by the service user", "UNSAFE_UPDATE_STATE");
  }
}

/** The controller does no work on construction. Read-only pages never contact npm. */
export function createWebUpdater({ home, packageRoot }, injected = {}) {
  home = path.resolve(home);
  const root = runnerStateRoot(injected.userHome || homedir());
  const stateInsideStore = root === home || root.startsWith(`${home}${path.sep}`);
  const directory = path.join(root, hash(home));
  const file = path.join(directory, "status.json");
  const now = injected.now || Date.now;
  const run = injected.run || ((command, args) => execute(command, args, { timeout: 15000, maxBuffer: 1024 * 1024 }));
  const inspect = injected.inspect || ((options) => inspectWebUpdateService(options));
  const update = injected.update || updateApplication;
  const read = async () => await readJson(file) || {};
  const currentVersion = async () => JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")).version;
  const publicState = async (state, session) => ({
    currentVersion: await currentVersion(),
    check: state.check ? { ...state.check, confirmationId: state.sessionHash === hash(session || "") ? state.check.confirmationId : null } : null,
    run: state.run || null
  });
  async function locked(action) {
    if (stateInsideStore) throw fail("Update status must be outside the artifact store", "UNSAFE_UPDATE_STATE");
    await privateDirectory(root);
    const [resolvedRoot, resolvedHome] = await Promise.all([realpath(root), realpath(home)]);
    if (resolvedRoot === resolvedHome || resolvedRoot.startsWith(`${resolvedHome}${path.sep}`)) throw fail("Update status must be outside the artifact store", "UNSAFE_UPDATE_STATE");
    await privateDirectory(directory);
    const lockPath = path.join(directory, "dispatch.lock");
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") throw fail("Another update request is in progress", "UPDATE_BUSY"); throw error; }
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date(now()).toISOString() })); return await action(); }
    finally { await lock.close(); await rm(lockPath, { force: true }); }
  }
  async function status(session) {
    if (stateInsideStore) return { currentVersion: await currentVersion(), supported: false, reason: "Update state must be outside the artifact store.", check: null, run: null };
    const state = await read();
    // An unfinished job is never inferred successful. Keep uncertain jobs locked.
    if (ACTIVE.has(state.run?.state) && now() - Date.parse(state.run.startedAt) > 30000) {
      try {
        const result = await run("systemctl", ["--user", "show", unitName(state.run.id), "--property=ActiveState", "--value"]).catch((error) => {
          // systemctl may exit nonzero for a collected unit while still
          // returning its authoritative inactive state. Bus failures do not.
          if (["inactive", "failed"].includes(error.stdout?.trim())) return { stdout: error.stdout };
          throw error;
        });
        if (["inactive", "failed"].includes(result.stdout.trim())) {
          return await locked(async () => {
            const latest = await read();
            if (latest.run?.id === state.run.id && ACTIVE.has(latest.run.state)) {
              latest.run = { ...latest.run, state: "interrupted", finishedAt: new Date(now()).toISOString(), errorCode: "UPDATE_INTERRUPTED", error: "The update worker stopped without a final result. Inspect the retained update backup and service before retrying." };
              await writeJson(file, latest);
            }
            return publicState(latest, session);
          });
        }
      } catch { /* Unavailable user manager is not evidence that a job has stopped. */ }
    }
    return publicState(state, session);
  }
  async function check(session) {
    return locked(async () => {
      const state = await read();
      if (ACTIVE.has(state.run?.state) || needsRecovery(state.run)) throw fail("Resolve the existing update before checking again", "UPDATE_BUSY");
      let eligible = false;
      try { await inspect({ home, pid: process.pid }); eligible = true; } catch { /* Read-only version checks also support unmanaged installations. */ }
      let result;
      try {
        const checked = await update({ home, packageRoot, check: true });
        result = { currentVersion: await currentVersion(), targetVersion: checked.targetVersion, supported: eligible && checked.supported, updateAvailable: checked.updateAvailable };
        if (!result.supported) result.reason = "Web updates require this server to be the non-root Linux systemd user service.";
      } catch (error) {
        result = { currentVersion: await currentVersion(), supported: eligible, updateAvailable: false, reason: "The latest release could not be checked. Try again later.", errorCode: "UPDATE_CHECK_FAILED" };
      }
      state.check = { ...result, check: undefined, confirmationId: randomUUID(), checkedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + 10 * 60 * 1000).toISOString() };
      state.sessionHash = hash(session);
      await writeJson(file, state);
      return publicState(state, session);
    });
  }
  async function start({ session, confirmationId, targetVersion, confirmUpdate }) {
    return locked(async () => {
      const state = await read();
      if (ACTIVE.has(state.run?.state) || needsRecovery(state.run)) throw fail("An update is already running or needs recovery", "UPDATE_BUSY");
      const checked = state.check;
      if (confirmUpdate !== "true" || !checked?.supported || !checked.updateAvailable || checked.confirmationId !== confirmationId || state.sessionHash !== hash(session) || checked.targetVersion !== targetVersion || Date.parse(checked.expiresAt) <= now()) {
        throw fail("Check for updates again and confirm the displayed version", "UPDATE_CONFIRMATION_REQUIRED", 400);
      }
      await inspect({ home, pid: process.pid });
      if (checked.currentVersion !== await currentVersion()) throw fail("The installed version changed; check again", "UPDATE_CONFIRMATION_REQUIRED", 400);
      const id = randomUUID();
      const requestFile = path.join(root, `${id}.json`);
      await writeJson(requestFile, { id, home, packageRoot, targetVersion, statusFile: file });
      state.check.confirmationId = null;
      state.run = { id, state: "queued", targetVersion, startedAt: new Date(now()).toISOString(), phase: "Starting an independent update worker." };
      await writeJson(file, state);
      try {
        await run("systemd-run", ["--user", `--unit=${unitName(id)}`, "--collect", "--property=Type=exec", "--", process.execPath, path.join(packageRoot, "src", "update-runner.js"), id]);
      } catch {
        // A timeout can occur after systemd accepted the unit. Preserve the job
        // and its request; polling will resolve a stopped worker as interrupted.
        // Never overwrite progress or completion written by that worker.
        return publicState(await read(), session);
      }
      return publicState(state, session);
    });
  }
  return { status, check, start };
}

/** Invoked only by the fixed systemd transient service, never the web server. */
export async function runWebUpdate(id, injected = {}) {
  if (!UUID.test(id || "")) throw fail("Invalid update job", "INVALID_UPDATE_JOB", 400);
  const root = runnerStateRoot(injected.userHome || homedir());
  await privateDirectory(root);
  const requestFile = path.join(root, `${id}.json`);
  const info = await lstat(requestFile);
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077)) || (process.getuid && info.uid !== process.getuid())) throw fail("Unsafe update request", "UNSAFE_UPDATE_STATE");
  const request = await readJson(requestFile);
  const expectedFile = path.join(root, hash(path.resolve(request.home)), "status.json");
  if (request.id !== id || request.statusFile !== expectedFile || !path.isAbsolute(request.packageRoot)) throw fail("Invalid update request", "INVALID_UPDATE_JOB");
  const sourceRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  if (await realpath(request.packageRoot) !== await realpath(injected.packageRoot || sourceRoot) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(request.targetVersion)) throw fail("Update package identity does not match the worker", "INVALID_UPDATE_JOB");
  await privateDirectory(path.dirname(expectedFile));
  // A durable claim makes replays fail closed, including after a worker crash.
  const claim = await open(path.join(root, `${id}.claimed`), "wx", 0o600);
  await claim.close();
  const state = await readJson(expectedFile);
  if (state?.run?.id !== id || state.run.state !== "queued") throw fail("Update job was already consumed", "INVALID_UPDATE_JOB");
  const save = async (changes) => { state.run = { ...state.run, ...changes }; await writeJson(expectedFile, state); };
  await save({ state: "running", phase: "Preparing update." });
  let progressQueue = Promise.resolve();
  try {
    const result = await (injected.update || updateApplication)({ home: request.home, packageRoot: request.packageRoot, targetVersion: request.targetVersion,
      onProgress: (phase) => { progressQueue = progressQueue.then(() => save({ phase })); }
    });
    await progressQueue;
    await save({ state: "succeeded", phase: "Update completed.", finishedAt: new Date().toISOString(), result });
  } catch (error) {
    await progressQueue.catch(() => {});
    await save({ state: "failed", finishedAt: new Date().toISOString(), errorCode: /^[A-Z_]+$/.test(error.code || "") ? error.code : "SELF_UPDATE_FAILED", error: "Update failed. Inspect the service and retained recovery backup before retrying.", result: { backupId: error.backupId, backupPath: error.backupPath } });
  } finally { await rm(requestFile, { force: true }); }
}
