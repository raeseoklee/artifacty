import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { updateApplication } from "../src/lib/self-update.js";

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
  const dropin = path.join(userHome, ".config", "systemd", "user", "com.artifacty.server.service.d", "zz-artifacty-self-update.conf");
  let active = true;
  let pid = 321;
  let starts = 0;
  let stops = 0;
  const calls = [];
  const phases = [];
  const state = async () => writeFile(path.join(home, "server.json"), JSON.stringify({ pid, url: "http://127.0.0.1:8787" }));
  await state();
  const injected = {
    platform: "linux", uid: 1000, userHome, env: { PATH: "/usr/bin" }, sleep: async () => {},
    assertNoOtherWriters: async () => { calls.push("writers"); },
    verifyServiceIdentity: async () => { calls.push("identity"); },
    health: async () => !configuration.preflightHealthFailure && !(configuration.healthFailure && starts === 1),
    backups: {
      create: async () => { calls.push("backup"); if (configuration.backupFailure) throw new Error("backup failed"); return { id: "snapshot-1", path: path.join(home, "upgrade-backups", "snapshot-1") }; },
      verify: async () => { calls.push("verify"); },
      restore: async () => { calls.push("restore"); if (configuration.restoreFailure) throw Object.assign(new Error("unsafe database"), { code: "UPGRADE_BACKUP_FAILED" }); }
    },
    run: async (command, parameters) => {
      calls.push(`${command}:${parameters.join(" ")}`);
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
      if (parameters.includes("show")) return { stdout: `LoadState=loaded\nActiveState=${active ? "active" : "inactive"}\nMainPID=${active ? pid : 0}\n` };
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
  return { root, userHome, home, packageRoot, dropin, args, calls, phases, injected, options: { home, packageRoot, onProgress: (phase) => phases.push(phase) }, isActive: () => active };
}

const stopped = (calls) => calls.some((call) => call.startsWith("systemctl:") && call.includes(" stop "));

test("stages exact npm release before downtime, preserves service arguments, and verifies health", async (t) => {
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
    const result = await updateApplication({ ...f.options, check: true }, f.injected);
    assert.equal(result.updateAvailable, available);
    assert.equal(stopped(f.calls), false);
    assert.equal(f.calls.some((call) => call.startsWith("npm:install")), false);
    await assert.rejects(access(path.join(f.userHome, ".local")));
  }
});

test("latest older than running service is a no-op, explicit downgrade is refused", async (t) => {
  const f = await fixture(t, { current: "0.14.0", target: "0.13.1" });
  assert.equal((await updateApplication(f.options, f.injected)).reason, "already-newer");
  await assert.rejects(updateApplication({ ...f.options, targetVersion: "0.13.1" }, f.injected), { code: "UPDATE_DOWNGRADE_REFUSED" });
  assert.equal(stopped(f.calls), false);
});

test("root, unsupported platforms, unhealthy service, and unmanaged writers fail before mutation", async (t) => {
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

test("staging failure does not stop server or expose npm stderr secrets", async (t) => {
  const f = await fixture(t, { stageFailure: true });
  await assert.rejects(updateApplication(f.options, f.injected), (error) => error.code === "SELF_UPDATE_FAILED" && !error.message.includes("private-token"));
  assert.equal(stopped(f.calls), false);
  assert.equal(f.calls.includes("backup"), false);
});

test("backup failure restarts original service without switching packages", async (t) => {
  const f = await fixture(t, { backupFailure: true });
  await assert.rejects(updateApplication(f.options, f.injected), { code: "SELF_UPDATE_FAILED" });
  assert.equal(f.isActive(), true);
  assert.equal(f.calls.includes("restore"), false);
  await assert.rejects(access(f.dropin));
});

test("failed target health restores old code, store, and service", async (t) => {
  const f = await fixture(t, { healthFailure: true });
  await assert.rejects(updateApplication(f.options, f.injected), (error) => error.code === "SELF_UPDATE_FAILED" && error.backupId === "snapshot-1");
  assert.equal(f.isActive(), true);
  assert.ok(f.calls.includes("restore"));
  await assert.rejects(access(f.dropin));
  await assert.rejects(access(path.join(f.userHome, ".local", "bin", "artifacty")));
});

test("failed store recovery leaves service stopped and reports retained backup", async (t) => {
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

test("unmanaged launchers and concurrent update lock are never overwritten", async (t) => {
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

test("writer scan resolves relative homes in each MCP or foreground CLI process cwd", async (t) => {
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


test("stop failure before snapshot does not switch code or restore a live store", async (t) => {
  const f = await fixture(t, { stopFailure: true });
  await assert.rejects(updateApplication(f.options, f.injected), { code: "SELF_UPDATE_FAILED" });
  assert.equal(f.calls.includes("backup"), false);
  assert.equal(f.calls.includes("restore"), false);
  await assert.rejects(access(f.dropin));
  assert.equal(f.isActive(), true);
});

test("failed rollback stop never restores store while the updated server is live", async (t) => {
  const f = await fixture(t, { healthFailure: true, recoveryStopFailure: true });
  await assert.rejects(updateApplication(f.options, f.injected), (error) => error.code === "UPDATE_RECOVERY_INCOMPLETE" && error.backupId === "snapshot-1");
  assert.equal(f.calls.includes("restore"), false);
  assert.equal(f.isActive(), true);
  assert.match(await readFile(f.dropin, "utf8"), /0\.14\.0/);
});
