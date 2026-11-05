import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink, link, chmod, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { updateApplication, inspectWebUpdateService, secureSystemRelease } from "../src/lib/self-update.js";

async function fixture(t, configuration = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "artifacty-self-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userHome = path.join(root, "user");
  const home = path.join(userHome, "store");
  const packageRoot = path.join(root, "root-owned", "artifacty");
  await mkdir(path.join(packageRoot, "src"), { recursive: true });
  await mkdir(home, { recursive: true });
  const current = configuration.current || "0.13.1";
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "artifacty", version: current }));
  for (const name of ["server.js", "cli.js", "mcp-server.js"]) await writeFile(path.join(packageRoot, "src", name), "");
  const args = [process.execPath, path.join(packageRoot, "src", "server.js"), "--host", "127.0.0.1", "--home", home, "--api-token", "private-token", "--mcp-http"];
  const original = `[Service]\nEnvironment=ARTIFACTY_HOME=${home}\nExecStart=${args.map((arg) => JSON.stringify(arg)).join(" ")}\n`;
  const dropin = configuration.system
    ? path.join(root, "system-units", "artifacty.service.d", "zz-artifacty-self-update.conf")
    : path.join(userHome, ".config", "systemd", "user", "com.artifacty.server.service.d", "zz-artifacty-self-update.conf");
  let active = true;
  let pid = 321;
  let starts = 0;
  let stops = 0;
  const calls = [];
  const installs = [];
  const phases = [];
  const state = async () => writeFile(path.join(home, "server.json"), JSON.stringify({ pid, url: "http://127.0.0.1:8787" }));
  await state();
  const injected = {
    platform: "linux", uid: configuration.system ? 0 : 1000, userHome,
    ...(configuration.system ? { systemStateRoot: path.join(root, "system-state"), systemUnitRoot: path.join(root, "system-units"), resolveServiceUser: async () => ({ uid: 1001, gid: 1001 }), chown: async () => {}, assertServiceUserOffline: async () => { calls.push("service-account-offline"); }, secureRelease: async () => { calls.push("freeze-release"); } } : {}), env: { PATH: "/usr/bin" }, sleep: async () => {},
    assertNoOtherWriters: async () => { calls.push("writers"); },
    verifyServiceIdentity: async () => { calls.push("identity"); },
    health: async () => !configuration.preflightHealthFailure && !(configuration.healthFailure && starts === 1),
    backups: {
      create: async () => { calls.push("backup"); if (configuration.backupFailure) throw new Error("backup failed"); return { id: "snapshot-1", path: path.join(home, "upgrade-backups", "snapshot-1") }; },
      verify: async () => { calls.push("verify"); },
      restore: async () => { calls.push("restore"); if (configuration.restoreFailure) throw Object.assign(new Error("unsafe database"), { code: "UPGRADE_BACKUP_FAILED" }); }
    },
    run: async (command, parameters, extra = {}) => {
      calls.push(`${command}:${parameters.join(" ")}`);
      if (command === "npm" && parameters[0] === "install") installs.push(extra);
      if (command === "runuser") {
        const executable = parameters.findIndex((value) => value === "ARTIFACTY_BACKUP_ON_UPDATE=false") + 1;
        command = parameters[executable]; parameters = parameters.slice(executable + 1);
      }
      if (command === "npm" && parameters[0] === "view") return { stdout: JSON.stringify(configuration.target || "0.14.0") };
      if (command === "npm") {
        if (configuration.stageFailure) throw new Error("npm output private-token");
        const stage = parameters[parameters.indexOf("--prefix") + 1];
        const installed = path.join(stage, "node_modules", "artifacty");
        await mkdir(path.join(installed, "src"), { recursive: true });
        await writeFile(path.join(installed, "package.json"), JSON.stringify({ name: "artifacty", version: configuration.target || "0.14.0" }));
        return { stdout: "" };
      }
      if (command !== "systemctl") return { stdout: parameters.includes("--version") ? `${configuration.target || "0.14.0"}\n` : "" };
      if (parameters.includes("show") && parameters.includes("--value")) return { stdout: String(active ? pid : 0) };
      if (parameters.includes("show")) return { stdout: `LoadState=loaded\nActiveState=${active ? "active" : "inactive"}\nMainPID=${active ? pid : 0}\n${configuration.system ? `User=${configuration.serviceUser || "artifacty"}\nGroup=\nDynamicUser=${configuration.dynamic ? "yes" : "no"}\n` : ""}` };
      if (parameters.includes("cat")) return { stdout: original + await readFile(dropin, "utf8").catch(() => "") };
      if (parameters.includes("stop")) {
        stops++;
        if ((configuration.stopFailure && stops === 1) || (configuration.recoveryStopFailure && stops === 2)) throw new Error("systemctl stop failed");
        active = false;
      }
      if (parameters.includes("start")) { active = true; pid++; starts++; await state(); }
      return { stdout: "" };
    }
  };
  return { root, userHome, home, packageRoot, dropin, args, calls, installs, phases, injected, options: { home, packageRoot, ...(configuration.system ? { serviceScope: "system" } : {}), onProgress: (phase) => phases.push(phase) }, isActive: () => active };
}

// These fixtures model Linux units and /proc with POSIX paths and symlinks.
// Windows still runs the cross-platform read-only and unsupported-platform checks.
const systemdTest = (name, body) => test(name, {
  skip: process.platform === "win32" ? "Linux systemd fixtures require POSIX paths and symlinks" : false
}, body);

const stopped = (calls) => calls.some((call) => call.startsWith("systemctl:") && call.includes(" stop "));

systemdTest("stages exact npm release before downtime, preserves service arguments, and verifies health", async (t) => {
  const f = await fixture(t);
  const result = await updateApplication(f.options, f.injected);
  assert.equal(result.currentVersion, "0.13.1");
  assert.equal(result.targetVersion, "0.14.0");
  assert.equal(result.updated, true);
  assert.equal(result.restarted, true);
  assert.equal(result.backupId, "snapshot-1");
  assert.match(result.nextCommand, /\/\.local\/bin\/artifacty update$/);
  assert.ok(result.pathWarning);
  assert.ok(f.calls.findIndex((call) => call.startsWith("npm:install")) < f.calls.findIndex((call) => call.includes(" stop ")));
  assert.ok(f.calls.indexOf("verify") < f.calls.findIndex((call) => call.includes("daemon-reload")));
  const dropin = await readFile(f.dropin, "utf8");
  for (const arg of f.args.slice(2)) assert.ok(dropin.includes(JSON.stringify(arg)));
  assert.match(dropin, /ExecStart=\nExecStart=/);
  assert.equal(JSON.parse(await readFile(path.join(f.packageRoot, "package.json"))).version, "0.13.1");
  assert.ok(f.phases.length >= 4);
});

test("check is read-only and compares stable, prerelease, and older versions", async (t) => {
  for (const [current, target, available] of [["0.14.0", "0.13.1", false], ["0.14.0-rc.2", "0.14.0-rc.10", true], ["0.14.0-rc.10", "0.14.0", true], ["0.14.0+build", "0.14.0", false]]) {
    const f = await fixture(t, { current, target });
    if (process.platform === "win32") f.injected.platform = "win32";
    const result = await updateApplication({ ...f.options, check: true }, f.injected);
    assert.equal(result.updateAvailable, available);
    assert.equal(stopped(f.calls), false);
    assert.equal(f.calls.some((call) => call.startsWith("npm:install")), false);
    await assert.rejects(access(path.join(f.userHome, ".local")));
  }
});

systemdTest("latest older than running service is a no-op, explicit downgrade is refused", async (t) => {
  const f = await fixture(t, { current: "0.14.0", target: "0.13.1" });
  assert.equal((await updateApplication(f.options, f.injected)).reason, "already-newer");
  await assert.rejects(updateApplication({ ...f.options, targetVersion: "0.13.1" }, f.injected), { code: "UPDATE_DOWNGRADE_REFUSED" });
  assert.equal(stopped(f.calls), false);
});

systemdTest("root, unsupported platforms, unhealthy service, and unmanaged writers fail before mutation", async (t) => {
  for (const scenario of ["root", "platform", "health", "writer"]) {
    const f = await fixture(t, { preflightHealthFailure: scenario === "health" });
    if (scenario === "root") f.injected.uid = 0;
    if (scenario === "platform") f.injected.platform = "darwin";
    if (scenario === "writer") f.injected.assertNoOtherWriters = async () => { throw Object.assign(new Error("active writer"), { code: "UNMANAGED_WRITER" }); };
    await assert.rejects(updateApplication(f.options, f.injected));
    assert.equal(stopped(f.calls), false);
    assert.equal(f.calls.some((call) => call.startsWith("npm:install")), false);
  }
});

systemdTest("staging failure does not stop server or expose npm stderr secrets", async (t) => {
  const f = await fixture(t, { stageFailure: true });
  await assert.rejects(updateApplication(f.options, f.injected), (error) => error.code === "SELF_UPDATE_FAILED" && !error.message.includes("private-token"));
  assert.equal(stopped(f.calls), false);
  assert.equal(f.calls.includes("backup"), false);
});

systemdTest("backup failure restarts original service without switching packages", async (t) => {
  const f = await fixture(t, { backupFailure: true });
  await assert.rejects(updateApplication(f.options, f.injected), { code: "SELF_UPDATE_FAILED" });
  assert.equal(f.isActive(), true);
  assert.equal(f.calls.includes("restore"), false);
  await assert.rejects(access(f.dropin));
});

systemdTest("failed target health restores old code, store, and service", async (t) => {
  const f = await fixture(t, { healthFailure: true });
  await assert.rejects(updateApplication(f.options, f.injected), (error) => error.code === "SELF_UPDATE_FAILED" && error.backupId === "snapshot-1");
  assert.equal(f.isActive(), true);
  assert.ok(f.calls.includes("restore"));
  await assert.rejects(access(f.dropin));
  await assert.rejects(access(path.join(f.userHome, ".local", "bin", "artifacty")));
});

systemdTest("failed store recovery leaves service stopped and reports retained backup", async (t) => {
  const f = await fixture(t, { healthFailure: true, restoreFailure: true });
  await assert.rejects(updateApplication(f.options, f.injected), (error) => {
    assert.equal(error.code, "UPDATE_RECOVERY_INCOMPLETE");
    assert.equal(error.backupId, "snapshot-1");
    assert.match(error.backupPath, /upgrade-backups\/snapshot-1$/);
    assert.match(error.message, /UPGRADE_BACKUP_FAILED/);
    return true;
  });
  assert.equal(f.isActive(), false);
});

systemdTest("unmanaged launchers and concurrent update lock are never overwritten", async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.userHome, ".local", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "artifacty"), "my own wrapper");
  await assert.rejects(updateApplication(f.options, f.injected), { code: "UNMANAGED_FILE" });
  assert.equal(await readFile(path.join(bin, "artifacty"), "utf8"), "my own wrapper");
  await rm(path.join(bin, "artifacty"));
  const lock = path.join(f.userHome, ".local", "share", "artifacty", "update.lock");
  await writeFile(lock, "another update");
  await assert.rejects(updateApplication(f.options, f.injected), { code: "UPDATE_LOCKED" });
  assert.equal(await readFile(lock, "utf8"), "another update");
  assert.equal(stopped(f.calls), false);
});

systemdTest("writer scan resolves relative homes in each MCP or foreground CLI process cwd", async (t) => {
  for (const entry of ["mcp-server.js", "cli.js"]) {
    const f = await fixture(t);
    const proc = path.join(f.root, "proc");
    const processDir = path.join(proc, "7654321");
    await mkdir(processDir, { recursive: true });
    await symlink(f.userHome, path.join(processDir, "cwd"));
    await writeFile(path.join(processDir, "cmdline"), [process.execPath, path.join(f.packageRoot, "src", entry), ...(entry === "cli.js" ? ["serve", "--foreground"] : []), "--home", "store", ""].join("\0"));
    delete f.injected.assertNoOtherWriters;
    f.injected.processRoot = proc;
    await assert.rejects(updateApplication(f.options, f.injected), { code: "UNMANAGED_WRITER" });
    assert.equal(stopped(f.calls), false);
  }
});


systemdTest("stop failure before snapshot does not switch code or restore a live store", async (t) => {
  const f = await fixture(t, { stopFailure: true });
  await assert.rejects(updateApplication(f.options, f.injected), { code: "SELF_UPDATE_FAILED" });
  assert.equal(f.calls.includes("backup"), false);
  assert.equal(f.calls.includes("restore"), false);
  await assert.rejects(access(f.dropin));
  assert.equal(f.isActive(), true);
});

systemdTest("failed rollback stop never restores store while the updated server is live", async (t) => {
  const f = await fixture(t, { healthFailure: true, recoveryStopFailure: true });
  await assert.rejects(updateApplication(f.options, f.injected), (error) => error.code === "UPDATE_RECOVERY_INCOMPLETE" && error.backupId === "snapshot-1");
  assert.equal(f.calls.includes("restore"), false);
  assert.equal(f.isActive(), true);
  assert.match(await readFile(f.dropin, "utf8"), /0\.14\.0/);
});


test("Windows application updates reject mutation while read-only checks remain available", async (t) => {
  const f = await fixture(t);
  f.injected.platform = "win32";
  const result = await updateApplication({ ...f.options, check: true }, f.injected);
  assert.equal(result.supported, false);
  assert.equal(result.updateAvailable, true);
  assert.match(result.reason, /Linux systemd user service/);
  await assert.rejects(updateApplication(f.options, f.injected), { code: "UNSUPPORTED_SERVICE" });
  assert.equal(stopped(f.calls), false);
  assert.equal(f.calls.some((call) => call.startsWith("npm:install")), false);
  await assert.rejects(access(path.join(f.userHome, ".local")));
});


systemdTest("system service update uses the system manager and drops privileges for package execution", async (t) => {
  const f = await fixture(t, { system: true });
  const result = await updateApplication(f.options, f.injected);
  assert.equal(result.updated, true);
  assert.equal(result.service, "artifacty.service");
  assert.equal(result.serviceScope, "system");
  assert.equal(result.requiresAdmin, true);
  assert.ok(f.calls.includes("freeze-release"));
  // The service account must never control the release an administrator runs as root.
  const install = f.calls.findIndex((call) => call.startsWith("npm:install"));
  const firstStagedRun = f.calls.findIndex((call) => call.startsWith("runuser:") && call.includes("--check"));
  assert.ok(install >= 0 && install < f.calls.indexOf("freeze-release"));
  assert.ok(f.calls.indexOf("freeze-release") < firstStagedRun);
  assert.ok(f.calls.indexOf("service-account-offline") > f.calls.findIndex((call) => call.startsWith("systemctl:stop")));
  assert.equal(f.installs.length, 1);
  assert.ok(f.installs[0].cwd.startsWith(path.join(f.root, "system-state")));
  assert.ok(f.installs[0].env.npm_config_cache.startsWith(path.join(f.root, "system-state")));
  assert.match(result.nextCommand, /^sudo .*--service-scope system/);
  assert.ok(f.calls.some((call) => call.startsWith("systemctl:stop artifacty.service")));
  assert.ok(f.calls.some((call) => call.startsWith("runuser:--user artifacty -- env -i ") && call.includes("--version")));
  assert.equal(f.calls.some((call) => call.startsWith("runuser:") && call.includes("npm install")), false);
  assert.equal(f.calls.some((call) => call.includes("systemctl:--user")), false);
  assert.match(await readFile(f.dropin, "utf8"), /ExecStart=\nExecStart=/);
});

systemdTest("system updates recover the old unit and snapshot after failed health", async (t) => {
  const f = await fixture(t, { system: true, healthFailure: true });
  await assert.rejects(updateApplication(f.options, f.injected), { code: "SELF_UPDATE_FAILED" });
  assert.equal(f.isActive(), true);
  assert.ok(f.calls.includes("restore"));
  await assert.rejects(access(f.dropin));
});

systemdTest("system updates refuse non-administrators, root service accounts and dynamic users", async (t) => {
  for (const configuration of [{ uid: 1000 }, { serviceUser: "root" }, { dynamic: true }]) {
    const f = await fixture(t, { system: true, ...configuration });
    if (configuration.uid) f.injected.uid = configuration.uid;
    await assert.rejects(updateApplication(f.options, f.injected), (error) => ["SYSTEM_UPDATE_REQUIRES_ADMIN", "UNSUPPORTED_SERVICE"].includes(error.code));
    assert.equal(stopped(f.calls), false);
    assert.equal(f.calls.some((call) => call.includes("npm install")), false);
  }
});

systemdTest("service scope and unit validation fail before discovery or registry access", async (t) => {
  const f = await fixture(t);
  for (const options of [{ serviceScope: "unknown" }, { serviceScope: "system", serviceName: "../bad.service" }, { serviceScope: "system", serviceName: "--danger.service" }, { serviceName: "other.service" }]) {
    await assert.rejects(updateApplication({ ...f.options, ...options }, f.injected));
  }
  assert.deepEqual(f.calls, []);
});

systemdTest("missing user bus is sanitized and system scope is available through environment", async (t) => {
  const f = await fixture(t);
  const original = f.injected.run;
  f.injected.run = async (command, args) => {
    if (command === "systemctl") throw new Error("Command failed: systemctl private-address private-token");
    return original(command, args);
  };
  const result = await updateApplication({ ...f.options, check: true }, f.injected);
  assert.equal(result.supported, false);
  assert.doesNotMatch(result.reason, /private-|Command failed/);
  const system = await fixture(t, { system: true });
  delete system.options.serviceScope;
  system.injected.env.ARTIFACTY_SERVICE_SCOPE = "system";
  const check = await updateApplication({ ...system.options, check: true }, system.injected);
  assert.equal(check.supported, true);
  assert.equal(check.serviceScope, "system");
  assert.equal(system.calls.some((call) => call.includes(" stop ")), false);
  await assert.rejects(inspectWebUpdateService({ home: system.home }, system.injected), { code: "SYSTEM_UPDATE_REQUIRES_ADMIN" });
});

systemdTest("system backup operations run in a separate unprivileged process", async (t) => {
  const f = await fixture(t, { system: true });
  const original = f.injected.run;
  delete f.injected.backups;
  const backupCalls = [];
  f.injected.run = async (command, args, extra) => {
    if (command === "runuser" && args.includes("--input-type=module")) {
      backupCalls.push(args);
      const [action] = JSON.parse(args.at(-1));
      return { stdout: JSON.stringify(action === "create" ? { id: "snapshot-1", path: "private-backup" } : { ok: true }) };
    }
    return original(command, args, extra);
  };
  const result = await updateApplication(f.options, f.injected);
  assert.equal(result.updated, true);
  assert.equal(backupCalls.length, 2);
  for (const args of backupCalls) assert.deepEqual(args.slice(0, 5), ["--user", "artifacty", "--", "env", "-i"]);
});


systemdTest("a root install ignores a store-controlled HOME and creates a root-owned stage", async (t) => {
  const f = await fixture(t, { system: true });
  f.injected.env = { PATH: "/usr/bin", HOME: f.home };
  const owners = [];
  f.injected.chown = async (...args) => { owners.push(args); };
  await updateApplication(f.options, f.injected);
  assert.equal(f.installs[0].env.HOME.startsWith(f.home), false);
  assert.equal(owners.some(([, uid]) => uid === 1001), false);
});

systemdTest("remaining service-account processes block the switch and the old service is restarted", async (t) => {
  const f = await fixture(t, { system: true });
  f.injected.assertServiceUserOffline = async () => { throw Object.assign(new Error("busy"), { code: "SERVICE_USER_BUSY" }); };
  await assert.rejects(updateApplication(f.options, f.injected), { code: "SELF_UPDATE_FAILED" });
  assert.equal(f.calls.includes("backup"), false);
  assert.equal(f.isActive(), true);
});


systemdTest("update progress includes stable phase identifiers", async (t) => {
  const f = await fixture(t, { system: true });
  const steps = [];
  await updateApplication({ ...f.options, onProgress: (_message, step) => steps.push(step) }, f.injected);
  assert.deepEqual(steps, ["staging", "backup", "switching", "health"]);
});


systemdTest("release freeze traverses real files, removes write access, and permits internal npm symlinks", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "artifacty-release-freeze-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nested = path.join(root, "node_modules", "artifacty", "src");
  const bin = path.join(root, "node_modules", ".bin");
  await mkdir(nested, { recursive: true });
  await mkdir(bin);
  const cli = path.join(nested, "cli.js");
  const data = path.join(nested, "data.json");
  await writeFile(cli, "#!/usr/bin/env node\n", { mode: 0o777 });
  await writeFile(data, "{}", { mode: 0o666 });
  await chmod(cli, 0o777);
  await chmod(data, 0o666);
  await chmod(nested, 0o777);
  const alias = path.join(bin, "artifacty");
  await symlink("../artifacty/src/cli.js", alias);
  const changes = [];
  await secureSystemRelease(root, { changeOwner: async (file, uid, gid) => {
    // Each parent is already frozen before traversal reaches its children.
    if (file !== root) assert.equal((await lstat(path.dirname(file))).mode & 0o777, 0o755);
    changes.push({ file, uid, gid });
  } });
  assert.equal((await lstat(cli)).mode & 0o777, 0o755);
  assert.equal((await lstat(data)).mode & 0o777, 0o644);
  assert.equal((await lstat(nested)).mode & 0o777, 0o755);
  assert.ok((await lstat(alias)).isSymbolicLink());
  assert.deepEqual(changes[0], { file: root, uid: 0, gid: 0 });
  assert.ok(changes.some(({ file }) => file === cli));
  assert.equal(changes.some(({ file }) => file === alias), false);
  assert.ok(changes.every(({ uid, gid }) => uid === 0 && gid === 0));
});

systemdTest("release freeze rejects escaping symlinks without changing the external file", async (t) => {
  const container = await mkdtemp(path.join(tmpdir(), "artifacty-release-escape-"));
  t.after(() => rm(container, { recursive: true, force: true }));
  const root = path.join(container, "release");
  await mkdir(root);
  const external = path.join(container, "external.js");
  await writeFile(external, "private", { mode: 0o600 });
  await symlink(external, path.join(root, "escape.js"));
  const changes = [];
  await assert.rejects(secureSystemRelease(root, { changeOwner: async (file) => changes.push(file) }), { code: "UNSAFE_UPDATE_PACKAGE" });
  assert.deepEqual(changes, [root]);
  assert.equal((await lstat(external)).mode & 0o777, 0o600);
  assert.equal(await readFile(external, "utf8"), "private");
});

systemdTest("release freeze rejects hardlinks before changing linked file permissions", async (t) => {
  const container = await mkdtemp(path.join(tmpdir(), "artifacty-release-hardlink-"));
  t.after(() => rm(container, { recursive: true, force: true }));
  const root = path.join(container, "release");
  await mkdir(root);
  const external = path.join(container, "external.js");
  await writeFile(external, "private", { mode: 0o600 });
  await link(external, path.join(root, "linked.js"));
  const changes = [];
  await assert.rejects(secureSystemRelease(root, { changeOwner: async (file) => changes.push(file) }), { code: "UNSAFE_UPDATE_PACKAGE" });
  assert.deepEqual(changes, [root]);
  assert.equal((await lstat(external)).mode & 0o777, 0o600);
});
