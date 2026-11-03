import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, chown, chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { databaseConfiguration } from "./database-config.js";

const POSTGRES_UPDATE_REASON = "Automatic updates do not support PostgreSQL. Verify a database backup and the artifact files together, then update manually.";
import { createUpgradeBackup, verifyUpgradeBackup, restoreUpgradeBackup } from "./upgrade-backup.js";

const execute = promisify(execFile);
const UNIT = "com.artifacty.server.service";
const LAUNCHER_MARK = "// artifacty-managed-launcher";
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (message, code = "SELF_UPDATE_FAILED") => Object.assign(new Error(message), { code });

function compareVersions(left, right) {
  const parse = (value) => { const [core, ...pre] = value.split("+")[0].split("-"); return { core: core.split(".").map(Number), pre: pre.join("-") }; };
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < 3; index++) if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  if (!a.pre || !b.pre) return a.pre === b.pre ? 0 : !a.pre ? 1 : -1;
  const ap = a.pre.split("."); const bp = b.pre.split(".");
  for (let index = 0; index < Math.max(ap.length, bp.length); index++) {
    if (ap[index] === bp[index]) continue;
    if (ap[index] === undefined) return -1;
    if (bp[index] === undefined) return 1;
    const an = /^\d+$/.test(ap[index]); const bn = /^\d+$/.test(bp[index]);
    if (an && bn) return Number(ap[index]) > Number(bp[index]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return ap[index] > bp[index] ? 1 : -1;
  }
  return 0;
}

async function readOptional(file) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function quoteUnit(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

// Accept the simple ExecStart form produced by Artifacty's service installer.
// Reject specifiers, environment expansion, and ambiguous quoting before stopping it.
function unitArguments(text) {
  const commands = [];
  for (const line of text.replace(/\\\n\s*/g, " ").split("\n")) {
    if (!line.startsWith("ExecStart=")) continue;
    const command = line.slice(10).trim();
    if (!command) commands.length = 0;
    else commands.push(command);
  }
  if (commands.length !== 1 || /[$%\r\n]/.test(commands[0])) throw failure("Unsupported service ExecStart. No changes were made.", "UNSUPPORTED_SERVICE");
  const args = [];
  const expression = /\s*(?:"((?:[^"\\]|\\["\\])*)"|'([^']*)'|([^\s"'\\]+))/gy;
  let offset = 0;
  while (offset < commands[0].length) {
    expression.lastIndex = offset;
    const match = expression.exec(commands[0]);
    if (!match) throw failure("Unsupported service argument quoting", "UNSUPPORTED_SERVICE");
    args.push(match[1] !== undefined ? match[1].replace(/\\(["\\])/g, "$1") : match[2] ?? match[3]);
    offset = expression.lastIndex;
  }
  if (args.length < 2 || !path.isAbsolute(args[0]) || !path.isAbsolute(args[1]) || !args[1].endsWith("/src/server.js")) {
    throw failure("The user service does not run an identifiable Artifacty server", "UNSUPPORTED_SERVICE");
  }
  return args;
}

async function packageAt(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (manifest.name !== "artifacty" || !VERSION.test(manifest.version)) throw failure("Invalid Artifacty package metadata");
  return manifest;
}

function serviceConfiguration(options, env) {
  const scope = options.serviceScope || env.ARTIFACTY_SERVICE_SCOPE || "user";
  if (!["user", "system"].includes(scope)) throw failure("--service-scope must be user or system", "INVALID_SERVICE_SCOPE");
  const name = options.serviceName || env.ARTIFACTY_SERVICE_NAME || (scope === "system" ? "artifacty.service" : UNIT);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.service$/.test(name) || name.includes("..")) throw failure("Use a plain systemd service name ending in .service", "INVALID_SERVICE_NAME");
  if (scope === "user" && name !== UNIT) throw failure("Custom service names require system scope", "INVALID_SERVICE_NAME");
  return { scope, name, prefix: scope === "system" ? [] : ["--user"] };
}

async function discoverService(run, home, configuration = serviceConfiguration({}, {})) {
  const { scope, name, prefix } = configuration;
  const result = await run("systemctl", [...prefix, "show", name, "--no-pager", `--property=LoadState,ActiveState,MainPID${scope === "system" ? ",User,Group,DynamicUser" : ""}`]);
  const properties = Object.fromEntries(result.stdout.trim().split("\n").map((line) => {
    const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
  }));
  if (properties.LoadState !== "loaded" || !["active", "inactive", "failed"].includes(properties.ActiveState)) {
    throw failure(`Install a stable Artifacty systemd ${scope} service before automatic updates`, "UNSUPPORTED_SERVICE");
  }
  if (scope === "system" && (!properties.User || ["root", "0"].includes(properties.User) || !/^[A-Za-z_][A-Za-z0-9_-]*\$?$/.test(properties.User) || properties.DynamicUser === "yes")) {
    throw failure("System updates require a fixed non-root service User", "UNSAFE_SERVICE_USER");
  }
  const text = (await run("systemctl", [...prefix, "cat", name, "--no-pager"])).stdout;
  const args = unitArguments(text);
  if (args.filter((arg) => arg === "--home").length !== 1) throw failure("The service must have exactly one --home argument", "SERVICE_HOME_MISMATCH");
  const homeIndex = args.indexOf("--home");
  if (homeIndex < 0 || !args[homeIndex + 1] || path.resolve(args[homeIndex + 1]) !== home) {
    throw failure("The service must explicitly use the selected --home directory", "SERVICE_HOME_MISMATCH");
  }
  const packageRoot = path.dirname(path.dirname(args[1]));
  const manifest = await packageAt(packageRoot);
  const pid = Number(properties.MainPID);
  if (properties.ActiveState === "active" && (!Number.isInteger(pid) || pid <= 0)) throw failure("Cannot identify the running service process");
  return { args, text, packageRoot, user: properties.User, group: properties.Group, version: manifest.version, pid, active: properties.ActiveState === "active" };
}

async function assertNoOtherWriters({ home, allowedPid, ownPid = process.pid, ownerUid = process.getuid?.(), processRoot = "/proc" }) {
  const canonicalHome = await realpath(home);
  for (const entry of await readdir(processRoot)) {
    if (!/^\d+$/.test(entry) || Number(entry) === ownPid || Number(entry) === allowedPid) continue;
    const directory = path.join(processRoot, entry);
    let args;
    try {
      const owner = await lstat(directory);
      if (process.getuid && owner.uid !== ownerUid) continue;
      args = (await readFile(`${directory}/cmdline`, "utf8")).split("\0").filter(Boolean);
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(error.code)) continue;
      throw failure("Cannot inspect another user process; stop other clients before updating", "UNMANAGED_WRITER");
    }
    for (const argument of args.slice(1)) {
      if (!/(?:server\.js|cli\.js|artifacty(?:-mcp)?)$/.test(argument)) continue;
      let source;
      let cwd;
      try { cwd = await realpath(`${directory}/cwd`); source = await realpath(path.resolve(cwd, argument)); }
      catch { continue; }
      if (!/\/src\/(?:mcp-server|server|cli)\.js$/.test(source)) continue;
      try { await packageAt(path.dirname(path.dirname(source))); } catch { continue; }
      const indices = args.flatMap((arg, index) => arg === "--home" ? [index] : []);
      if (indices.length > 1) throw failure("Stop Artifacty clients with ambiguous --home arguments", "UNMANAGED_WRITER");
      let processHome = indices.length ? args[indices[0] + 1] : null;
      if (!processHome) {
        let environment;
        try { environment = (await readFile(`${directory}/environ`, "utf8")).split("\0"); }
        catch { throw failure("Cannot inspect another Artifacty process; stop it before updating", "UNMANAGED_WRITER"); }
        processHome = environment.find((item) => item.startsWith("ARTIFACTY_HOME="))?.slice(15);
        const userHome = environment.find((item) => item.startsWith("HOME="))?.slice(5);
        processHome ||= userHome && path.join(userHome, ".artifacty");
      }
      let resolved;
      try { resolved = processHome && await realpath(path.resolve(cwd, processHome)); } catch { /* Unknown homes fail closed. */ }
      if (!resolved || resolved === canonicalHome) throw failure(`Stop the unmanaged Artifacty process (pid ${entry}) before updating`, "UNMANAGED_WRITER");
    }
  }
}

async function assertServiceUserOffline(uid, processRoot = "/proc") {
  for (const entry of await readdir(processRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if ((await lstat(path.join(processRoot, entry))).uid === uid) throw failure("Stop all remaining processes owned by the dedicated service account before updating", "SERVICE_USER_BUSY");
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  }
}

async function writableDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure(`Expected a real directory: ${directory}`);
  await access(directory, constants.W_OK);
}

// Freeze each directory before visiting its children, so the unprivileged installer
// cannot swap a parent while the privileged updater adjusts ownership beneath it.
export async function secureSystemRelease(root, { changeOwner = chown } = {}) {
  const canonicalRoot = await realpath(root);
  async function visit(file) {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      const target = await realpath(file);
      if (!target.startsWith(`${canonicalRoot}${path.sep}`)) throw failure("Staged package symlink escapes its release", "UNSAFE_UPDATE_PACKAGE");
      return;
    }
    if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw failure("Unsupported staged package file", "UNSAFE_UPDATE_PACKAGE");
    await changeOwner(file, 0, 0);
    await chmod(file, info.isDirectory() || (info.mode & 0o111) ? 0o755 : 0o644);
    if (info.isDirectory()) for (const entry of await readdir(file)) await visit(path.join(file, entry));
  }
  await visit(root);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function originalFile(file, managedMark) {
  const info = await lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw failure(`Refusing to replace an unmanaged file: ${file}`, "UNMANAGED_FILE");
  const content = await readFile(file, "utf8");
  if (managedMark && !content.includes(managedMark)) throw failure(`Refusing to replace an unmanaged file: ${file}`, "UNMANAGED_FILE");
  await access(file, constants.W_OK);
  return { content, mode: info.mode & 0o777 };
}

async function replaceFile(file, content, mode = 0o600) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

function launcher(node, entry) {
  return `#!/usr/bin/env node\n${LAUNCHER_MARK}\nconst { spawnSync } = require("node:child_process");\nconst result = spawnSync(${JSON.stringify(node)}, [${JSON.stringify(entry)}, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });\nif (result.error) { console.error(result.error.message); process.exitCode = 1; } else { process.exitCode = result.status ?? 1; }\n`;
}

function validHealthUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" && Boolean(url.port);
  } catch { return false; }
}

async function verifyServiceIdentity(pid, args) {
  const executable = await realpath(`/proc/${pid}/exe`);
  const expected = await realpath(args[0]);
  const command = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
  if (executable !== expected || JSON.stringify(command.slice(1)) !== JSON.stringify(args.slice(1))) {
    throw failure("The service PID does not match its configured Node process", "SERVICE_IDENTITY_MISMATCH");
  }
}

async function waitHealthy(run, home, health, sleep, identity, args, configuration = serviceConfiguration({}, {})) {
  for (let attempt = 0; attempt < 30; attempt++) {
    let state;
    try { state = JSON.parse(await readOptional(path.join(home, "server.json")) || "null"); } catch { /* Server state may be mid-write. */ }
    const result = await run("systemctl", [...configuration.prefix, "show", configuration.name, "--property=MainPID", "--value"]);
    const pid = Number(result.stdout.trim());
    if (pid > 0 && state?.pid === pid && validHealthUrl(state.url)) {
      await identity(pid, args);
      if (await health(state.url)) return pid;
    }
    await sleep(1000);
  }
  throw failure("The updated service did not pass its PID and HTTP health checks", "UPDATE_HEALTH_FAILED");
}

/** Verify that a web administrator is operating the managed service itself. */
export async function inspectWebUpdateService({ home, pid = process.pid, ...databaseOptions }, injected = {}) {
  if (databaseOptions.databaseBackend === "postgres" || databaseConfiguration(databaseOptions, injected.env || process.env).kind === "postgres" || existsSync(path.join(path.resolve(home), ".postgres-store-id"))) throw failure(POSTGRES_UPDATE_REASON, "POSTGRES_UPDATE_UNSUPPORTED");
  const configuration = serviceConfiguration(databaseOptions, injected.env || process.env);
  if (configuration.scope === "system") throw failure("System service updates require an administrator to run the CLI with sudo; browser updates cannot elevate privileges.", "SYSTEM_UPDATE_REQUIRES_ADMIN");
  if ((injected.platform || process.platform) !== "linux" || (injected.uid ?? process.geteuid?.()) === 0) {
    throw failure("Web updates require a non-root Linux systemd user service", "UNSUPPORTED_SERVICE");
  }
  const run = injected.run || ((command, args) => execute(command, args, { timeout: 10000, maxBuffer: 1024 * 1024 }));
  let service;
  try { service = await discoverService(run, path.resolve(home), configuration); }
  catch {
    try {
      const systemService = await discoverService(run, path.resolve(home), serviceConfiguration({ serviceScope: "system" }, {}));
      if (systemService.active && systemService.pid === pid) throw failure("This server uses a system service. An administrator must update it with the CLI using sudo and --service-scope system.", "SYSTEM_UPDATE_REQUIRES_ADMIN");
    } catch (error) { if (error.code === "SYSTEM_UPDATE_REQUIRES_ADMIN") throw error; }
    throw failure("Cannot inspect the Artifacty user service. Check the service scope and service-manager access.", "UNSUPPORTED_SERVICE");
  }
  if (!service.active || service.pid !== pid) throw failure("This server is not the managed Artifacty service", "SERVICE_IDENTITY_MISMATCH");
  await (injected.verifyServiceIdentity || verifyServiceIdentity)(pid, service.args);
  return { currentVersion: service.version };
}

/** Update a managed Linux user or explicitly selected system service. */
export async function updateApplication(options = {}, injected = {}) {
  const env = injected.env || process.env;

  const configuration = serviceConfiguration(options, env);
  const system = configuration.scope === "system";
  const platform = injected.platform || process.platform;
  const userHome = injected.userHome || homedir();
  const home = path.resolve(options.home || env.ARTIFACTY_HOME || path.join(userHome, ".artifacty"));
  const postgres = options.databaseBackend === "postgres" || databaseConfiguration(options, env).kind === "postgres" || existsSync(path.join(home, ".postgres-store-id"));
  if (postgres && !options.check) throw failure(POSTGRES_UPDATE_REASON, "POSTGRES_UPDATE_UNSUPPORTED");
  const run = injected.run || ((command, args, extra = {}) => execute(command, args, { env, timeout: 180000, maxBuffer: 2 * 1024 * 1024, ...extra }));
  const sleep = injected.sleep || pause;
  const identity = injected.verifyServiceIdentity || verifyServiceIdentity;
  const writers = injected.assertNoOtherWriters || ((context) => assertNoOtherWriters({ ...context, processRoot: injected.processRoot }));
  const progress = (message, step) => { try { options.onProgress?.(message, step); } catch { /* Reporting cannot interrupt recovery. */ } };
  const health = injected.health || (async (url) => {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000), redirect: "error" });
      const body = await response.json();
      return response.ok && body.ok === true && body.name === "artifacty" && path.resolve(body.store) === home;
    } catch { return false; }
  });
  const backups = injected.backups || { create: createUpgradeBackup, verify: verifyUpgradeBackup, restore: restoreUpgradeBackup };
  const requested = options.targetVersion || "latest";
  if (requested !== "latest" && !VERSION.test(requested)) throw failure("--target-version must be latest or an exact version", "INVALID_UPDATE_VERSION");
  let service;
  let unsupported;
  if (postgres) unsupported = POSTGRES_UPDATE_REASON;
  else if (platform === "linux") {
    try { service = await discoverService(run, home, configuration); } catch (error) { unsupported = error.code && error.code !== "SELF_UPDATE_FAILED" ? error.message : "Cannot inspect the configured systemd service. Check the service scope, name, and service-manager access."; }
  } else unsupported = "Automatic updates currently require a Linux systemd user service";
  const current = service?.version || (await packageAt(options.packageRoot || path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))))).version;
  const targetVersion = JSON.parse((await run("npm", ["view", `artifacty@${requested}`, "version", "--json"])).stdout);
  if (typeof targetVersion !== "string" || !VERSION.test(targetVersion)) throw failure("npm did not resolve one exact Artifacty version");
  const summary = { currentVersion: current, targetVersion, supported: Boolean(service), service: service ? configuration.name : null, serviceScope: configuration.scope, ...(system ? { requiresAdmin: true } : {}) };
  if (options.check) return { ...summary, check: true, updateAvailable: compareVersions(current, targetVersion) < 0, ...(unsupported ? { reason: unsupported } : {}) };
  if (!service) throw failure(unsupported, "UNSUPPORTED_SERVICE");
  const uid = injected.uid ?? process.geteuid?.();
  if (system ? uid !== 0 : uid === 0) throw failure(system ? "System service updates require administrator privileges. Run the CLI with sudo and --service-scope system." : "Run updates as the service user, without sudo", system ? "SYSTEM_UPDATE_REQUIRES_ADMIN" : "ROOT_UPDATE_REFUSED");
  let serviceIdentity;
  if (system) {
    const lookup = injected.resolveServiceUser || (async (name, group) => {
      const userId = Number((await run("id", ["-u", name])).stdout.trim());
      const groupId = group ? Number((await run("getent", ["group", group])).stdout.trim().split(":")[2]) : Number((await run("id", ["-g", name])).stdout.trim());
      return { uid: userId, gid: groupId };
    });
    serviceIdentity = await lookup(service.user, service.group);
    if (!Number.isSafeInteger(serviceIdentity.uid) || serviceIdentity.uid <= 0 || !Number.isSafeInteger(serviceIdentity.gid) || serviceIdentity.gid <= 0) throw failure("Cannot resolve a non-root service identity", "UNSAFE_SERVICE_USER");
  }
  // runuser initializes supplementary groups; uid/gid alone would retain root's groups.
  const asService = (command, args) => system
    ? run("runuser", ["--user", service.user, ...(service.group ? ["--group", service.group] : []), "--", "env", "-i", `PATH=${env.PATH || "/usr/bin:/bin"}`, `HOME=${home}`, `ARTIFACTY_HOME=${home}`, "ARTIFACTY_BACKUP_ON_UPDATE=false", command, ...args])
    : run(command, args);
  const serviceBackup = async (action, id, settings) => {
    const moduleUrl = new URL("./upgrade-backup.js", import.meta.url).href;
    const script = `const m=await import(process.argv[1]); const [action,home,id,settings]=JSON.parse(process.argv[2]); const value=action==="create"?m.createUpgradeBackup({home},settings):action==="verify"?m.verifyUpgradeBackup({home},id):m.restoreUpgradeBackup({home},id,settings); console.log(JSON.stringify(value));`;
    return JSON.parse((await asService(service.args[0], ["--input-type=module", "-e", script, moduleUrl, JSON.stringify([action, home, id, settings])])).stdout);
  };
  const effectiveBackups = system && !injected.backups ? { create: (_store, settings) => serviceBackup("create", null, settings), verify: (_store, id) => serviceBackup("verify", id), restore: (_store, id, settings) => serviceBackup("restore", id, settings) } : backups;
  const scanWriters = (allowedPid) => writers({ home, allowedPid, ...(system ? { ownerUid: serviceIdentity.uid } : {}) });
  if (/[\r\n$%]/.test(home + userHome)) throw failure("Store and user paths containing $, %, or newlines are unsupported", "UNSUPPORTED_PATH");
  if (compareVersions(current, targetVersion) > 0) {
    if (requested !== "latest") throw failure("Automatic package downgrades are not supported", "UPDATE_DOWNGRADE_REFUSED");
    return { ...summary, updated: false, reason: "already-newer" };
  }
  if (current === targetVersion) return { ...summary, updated: false, reason: "already-current" };
  if (service.active) {
    await identity(service.pid, service.args);
    let state;
    try { state = JSON.parse(await readOptional(path.join(home, "server.json")) || "null"); } catch { /* Fail before stopping an uncheckable service. */ }
    if (state?.pid !== service.pid || !validHealthUrl(state.url) || !await health(state.url)) {
      throw failure("The current service cannot pass its HTTP health check. Check its bind address and IP policy before updating.", "UPDATE_PREFLIGHT_HEALTH");
    }
  }
  await scanWriters(service.pid);

  const stateRoot = system ? path.join(injected.systemStateRoot || "/var/lib/artifacty-updater", configuration.name) : path.join(userHome, ".local", "share", "artifacty");
  const releases = path.join(stateRoot, "releases");
  const bin = path.join(userHome, ".local", "bin");
  const dropinDirectory = system ? path.join(injected.systemUnitRoot || "/etc/systemd/system", `${configuration.name}.d`) : path.join(userHome, ".config", "systemd", "user", `${UNIT}.d`);
  for (const directory of [stateRoot, releases, ...(system ? [] : [bin]), dropinDirectory]) await writableDirectory(directory);
  if (system) {
    if (!injected.systemStateRoot && !injected.systemUnitRoot) {
      for (const destination of [stateRoot, dropinDirectory]) {
        let directory = await realpath(destination);
        while (true) {
          const info = await lstat(directory);
          if (info.uid !== 0 || (info.mode & 0o022)) throw failure("System updater paths must have root-owned, non-writable parents", "UNSAFE_UPDATE_STATE");
          const parent = path.dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
      }
    }
    for (const directory of [path.dirname(stateRoot), stateRoot, releases, dropinDirectory]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || (!injected.systemStateRoot && info.uid !== 0) || (info.mode & 0o022)) throw failure("System updater directories must be root-owned and not group/world writable", "UNSAFE_UPDATE_STATE");
      await chmod(directory, 0o755);
    }
  }
  const dropin = path.join(dropinDirectory, "zz-artifacty-self-update.conf");
  const destinations = system ? [dropin] : [dropin, path.join(bin, "artifacty"), path.join(bin, "artifacty-mcp")];
  const originals = await Promise.all(destinations.map((file, index) => originalFile(file, index ? LAUNCHER_MARK : "# artifacty-managed-update")));
  const lockPath = path.join(stateRoot, "update.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw failure(`Another update or an interrupted update holds ${lockPath}`, "UPDATE_LOCKED"); throw error; }
  const stage = path.join(releases, `${targetVersion}-${randomUUID()}`);
  let snapshot;
  let stopped = false;
  let switched = false;
  let succeeded = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, targetVersion }));
    progress(`Staging Artifacty ${targetVersion} before stopping the service.`, "staging");
    if (system) {
      await mkdir(stage, { mode: 0o700 });
      await (injected.chown || chown)(stage, serviceIdentity.uid, serviceIdentity.gid);
    }
    await asService("npm", ["install", "--prefix", stage, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false", "--save-exact", `artifacty@${targetVersion}`]);
    const stagedRoot = path.join(stage, "node_modules", "artifacty");
    if ((await packageAt(stagedRoot)).version !== targetVersion) throw failure("Staged package version does not match the resolved version");
    for (const entry of ["cli.js", "server.js", "mcp-server.js"]) await asService(service.args[0], ["--check", path.join(stagedRoot, "src", entry)]);
    const version = (await asService(service.args[0], [path.join(stagedRoot, "src", "cli.js"), "--version"])).stdout.trim();
    if (version !== targetVersion) throw failure("Staged CLI version check failed");
    const refreshed = await discoverService(run, home, configuration);
    if (refreshed.text !== service.text || refreshed.pid !== service.pid) throw failure("Service configuration changed while staging; retry the update");
    await scanWriters(service.pid);
    progress("Stopping the configured service and verifying a recovery snapshot.", "backup");
    stopped = true;
    await run("systemctl", [...configuration.prefix, "stop", configuration.name]);
    await scanWriters(0);
    if (system) {
      // Stopping every process of the dedicated account closes writable file
      // descriptors before ownership changes; chmod alone cannot revoke them.
      await (injected.assertServiceUserOffline || assertServiceUserOffline)(serviceIdentity.uid, injected.processRoot);
      await (injected.secureRelease || secureSystemRelease)(stage);
    }
    snapshot = await effectiveBackups.create({ home }, { reason: "manual", targetAppVersion: targetVersion });
    await effectiveBackups.verify({ home }, snapshot.id);
    const args = [service.args[0], path.join(stagedRoot, "src", "server.js"), ...service.args.slice(2)];
    progress("Switching the configured service to the staged release.", "switching");
    switched = true;
    await replaceFile(dropin, `# artifacty-managed-update\n[Service]\nExecStart=\nExecStart=${args.map(quoteUnit).join(" ")}\n`);
    if (!system) await replaceFile(destinations[1], launcher(service.args[0], path.join(stagedRoot, "src", "cli.js")), 0o755);
    if (!system) await replaceFile(destinations[2], launcher(service.args[0], path.join(stagedRoot, "src", "mcp-server.js")), 0o755);
    await run("systemctl", [...configuration.prefix, "daemon-reload"]);
    const configured = await discoverService(run, home, configuration);
    if (configured.args[1] !== args[1] || JSON.stringify(configured.args.slice(2)) !== JSON.stringify(args.slice(2))) throw failure("A service override prevented the staged package from becoming active");
    if (service.active) {
      await run("systemctl", [...configuration.prefix, "start", configuration.name]);
      progress("Waiting for service health and process identity.", "health");
      await waitHealthy(run, home, health, sleep, identity, args, configuration);
    }
    succeeded = true;
    if (system) return { ...summary, updated: true, backupId: snapshot.id, backupPath: snapshot.path, packageRoot: stagedRoot, restarted: service.active, nextCommand: `sudo ${shellQuote(service.args[0])} ${shellQuote(path.join(stagedRoot, "src", "cli.js"))} update --service-scope system --service-name ${configuration.name} --home ${shellQuote(home)}` };
    let firstExecutable;
    for (const directory of (env.PATH || "").split(path.delimiter)) {
      const candidate = path.resolve(directory, "artifacty");
      try { await access(candidate, constants.X_OK); firstExecutable = await realpath(candidate); break; } catch { /* Try the next PATH entry. */ }
    }
    const pathWarning = firstExecutable !== await realpath(destinations[1]) ? `Use ${destinations[1]} until ${bin} precedes other Artifacty installations in PATH.` : undefined;
    const commandPath = /^[\w/.-]+$/.test(destinations[1]) ? destinations[1] : `'${destinations[1].replaceAll("'", "'\\''")}'`;
    return { ...summary, updated: true, backupId: snapshot.id, backupPath: snapshot.path, packageRoot: stagedRoot, restarted: service.active, launcher: destinations[1], nextCommand: `${commandPath} update`, ...(pathWarning ? { pathWarning } : {}) };
  } catch (cause) {
    progress("Update failed. Restoring the previous service and store where safe.", "recovery");
    const recoveryErrors = [];
    if (switched) {
      try { await run("systemctl", [...configuration.prefix, "stop", configuration.name]); } catch { recoveryErrors.push("could not stop the updated service"); }
      if (!recoveryErrors.length) {
        try {
          for (let index = 0; index < destinations.length; index++) {
            const original = originals[index];
            if (original) await replaceFile(destinations[index], original.content, original.mode);
            else await rm(destinations[index], { force: true });
          }
          await run("systemctl", [...configuration.prefix, "daemon-reload"]);
          await scanWriters(0);
          await effectiveBackups.restore({ home }, snapshot.id, { confirm: "restore-store" });
        } catch (error) { recoveryErrors.push(`could not restore the previous configuration and store (${/^[A-Z_]+$/.test(error.code || "") ? error.code : "restore failed"})`); }
      }
    }
    if (stopped && service.active && !recoveryErrors.length) {
      try { await run("systemctl", [...configuration.prefix, "start", configuration.name]); await waitHealthy(run, home, health, sleep, identity, service.args, configuration); }
      catch { recoveryErrors.push("the previous service did not restart cleanly"); }
    }
    const error = failure(`Update failed: ${cause.code || "operation failed"}. ${recoveryErrors.length ? `Recovery incomplete: ${recoveryErrors.join("; ")}.` : stopped ? "The previous service configuration was restored." : "The running service was not changed."}${snapshot ? ` Backup: ${snapshot.id}.` : ""}`, recoveryErrors.length ? "UPDATE_RECOVERY_INCOMPLETE" : "SELF_UPDATE_FAILED");
    error.backupId = snapshot?.id;
    error.backupPath = snapshot?.path;
    error.cause = cause;
    throw error;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
    if (!succeeded && !switched) await rm(stage, { recursive: true, force: true });
  }
}
