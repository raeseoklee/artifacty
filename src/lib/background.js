import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createStore } from "./storage.js";
import { readServerState, serverStatePath } from "./server-state.js";
import { exposureWarning, securityConfig } from "./security.js";
import { generateToken } from "./token.js";

const DEFAULT_READY_TIMEOUT_MS = 30000;
const DEFAULT_HOST = "127.0.0.1";

export async function startBackgroundServer(options = {}) {
  if (options.generateToken && options.apiToken) {
    throw new Error("Use either --api-token or --generate-token, not both");
  }

  const generatedToken = options.generateToken ? generateToken(options) : null;
  const serverOptions = {
    ...options,
    apiToken: generatedToken?.token || options.apiToken,
    generateToken: false
  };
  const store = createStore({ home: options.home });
  const paths = backgroundPaths(store);
  const current = await backgroundStatus({ home: store.home });
  if (current.running) {
    throw new Error(`Artifacty server is already running on ${current.url || "unknown URL"} (pid ${current.pid})`);
  }

  mkdirSync(paths.logDir, { recursive: true });
  mkdirSync(store.home, { recursive: true });

  const child = spawnDetachedServer(serverOptions, store, paths);

  writeFileSync(paths.pidFile, `${child.pid}\n`, "utf8");

  try {
    const ready = await waitForReady({
      store,
      pid: child.pid,
      timeoutMs: Number(options.timeout || DEFAULT_READY_TIMEOUT_MS)
    });
    child.unref();
    return {
      action: "start",
      running: true,
      pid: child.pid,
      url: ready.url,
      home: store.home,
      auth: authResponse(generatedToken, ready.url),
      securityWarning: exposureWarning({
        host: serverOptions.host || process.env.ARTIFACTY_HOST || DEFAULT_HOST,
        config: securityConfig(serverOptions)
      }) || undefined,
      logs: {
        stdout: paths.stdoutLog,
        stderr: paths.stderrLog
      },
      statePath: serverStatePath(store)
    };
  } catch (error) {
    try {
      await terminatePid(child.pid);
    } catch {
      // Process may already have exited during startup.
    }
    rmSync(paths.pidFile, { force: true });
    const logTail = await tailFile(paths.stderrLog);
    const message = logTail ? `${error.message}\n${logTail}` : error.message;
    throw new Error(message);
  }
}

function authResponse(generatedToken, url) {
  if (!generatedToken) {
    return null;
  }
  return {
    token: generatedToken.token,
    bytes: generatedToken.bytes,
    header: generatedToken.header,
    authorization: generatedToken.authorization,
    createUrl: `${url}/new?token=${encodeURIComponent(generatedToken.token)}`,
    importUrl: `${url}/import?token=${encodeURIComponent(generatedToken.token)}`
  };
}

export async function stopBackgroundServer(options = {}) {
  const store = createStore({ home: options.home });
  const paths = backgroundPaths(store);
  const status = await backgroundStatus({ home: store.home });

  if (!status.pid || !status.pidFileExists) {
    return {
      action: "stop",
      stopped: false,
      running: status.running,
      reason: status.pid ? "server was not started by artifacty serve/start" : "server is not running",
      pid: status.pid || null,
      home: store.home
    };
  }

  if (!status.processRunning) {
    rmSync(paths.pidFile, { force: true });
    return {
      action: "stop",
      stopped: false,
      running: false,
      reason: "removed stale pid file",
      pid: status.pid,
      home: store.home
    };
  }

  if (!options.force && !status.stateMatchesPid && !status.healthy) {
    return {
      action: "stop",
      stopped: false,
      running: status.running,
      reason: "pid file does not match a healthy Artifacty server; retry with --force to stop the recorded pid",
      pid: status.pid,
      home: store.home
    };
  }

  await terminatePid(status.pid);
  let stopped = await waitForStop(status.pid, Number(options.timeout || DEFAULT_READY_TIMEOUT_MS));
  if (!stopped && options.force) {
    await terminatePid(status.pid, { force: true });
    stopped = await waitForStop(status.pid, 1000);
  }
  if (!stopped) {
    return {
      action: "stop",
      stopped: false,
      running: true,
      reason: "server did not stop before timeout; retry with --force",
      pid: status.pid,
      home: store.home
    };
  }
  rmSync(paths.pidFile, { force: true });

  return {
    action: "stop",
    stopped: true,
    running: false,
    pid: status.pid,
    home: store.home
  };
}

export async function backgroundStatus(options = {}) {
  const store = createStore({ home: options.home });
  const paths = backgroundPaths(store);
  const state = await readServerState(store);
  const pidFromFile = readPidFile(paths.pidFile);
  const pid = pidFromFile || state?.pid || null;
  const processRunning = pid ? isPidRunning(pid) : false;
  const health = state?.url ? await fetchHealth(state.url) : { ok: false };
  const stateMatchesPid = Boolean(pid && state?.pid === pid);

  return {
    action: "status",
    running: Boolean(processRunning && health.ok),
    processRunning,
    healthy: Boolean(health.ok),
    platform: process.platform,
    pid,
    statePid: state?.pid || null,
    stateMatchesPid,
    pidFileExists: existsSync(paths.pidFile),
    managed: Boolean(pidFromFile),
    url: state?.url || null,
    home: store.home,
    logs: {
      stdout: paths.stdoutLog,
      stderr: paths.stderrLog
    },
    statePath: serverStatePath(store)
  };
}

export function backgroundPaths(store) {
  const logDir = path.join(store.home, "logs");
  return {
    logDir,
    pidFile: path.join(store.home, "server.pid"),
    stdoutLog: path.join(logDir, "server.out.log"),
    stderrLog: path.join(logDir, "server.err.log")
  };
}

export function stopCommandForPlatform(pid, options = {}, platform = process.platform) {
  if (platform !== "win32") {
    return null;
  }
  const args = ["/PID", String(pid), "/T"];
  if (options.force) {
    args.push("/F");
  }
  return { command: "taskkill", args };
}

function spawnDetachedServer(options, store, paths) {
  let stdoutFd;
  let stderrFd;
  try {
    stdoutFd = openSync(paths.stdoutLog, "a");
    stderrFd = openSync(paths.stderrLog, "a");
    return spawn(process.execPath, buildServerArgs(options, store), {
      detached: true,
      env: buildServerEnv(options),
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true
    });
  } finally {
    closeFd(stdoutFd);
    closeFd(stderrFd);
  }
}

export function buildServerArgs(options, store) {
  const args = [options.serverPath];
  addValueArg(args, "--host", options.host);
  addValueArg(args, "--port", options.port);
  addValueArg(args, "--home", store.home);
  addValueArg(args, "--share-mode", options.shareMode);
  addValueArg(args, "--bytes", options.bytes);
  if (options.generateToken) {
    args.push("--generate-token");
  }
  if (options.allowSecrets) {
    args.push("--allow-secrets");
  }
  if (options.mcpHttp) {
    args.push("--mcp-http");
  }
  return args;
}

function buildServerEnv(options) {
  return {
    ...process.env,
    ...(options.apiToken ? { ARTIFACTY_API_TOKEN: options.apiToken } : {})
  };
}

async function terminatePid(pid, options = {}) {
  const command = stopCommandForPlatform(pid, options);
  if (command) {
    await execFileQuiet(command.command, command.args).catch(async (error) => {
      if (!isPidRunning(pid)) {
        return;
      }
      if (!options.force) {
        const forced = stopCommandForPlatform(pid, { force: true });
        await execFileQuiet(forced.command, forced.args).catch((forcedError) => {
          if (!isPidRunning(pid)) {
            return;
          }
          throw new Error(`Failed to stop Windows process ${pid}: ${forcedError.stderr || forcedError.message}`);
        });
        return;
      }
      throw new Error(`Failed to stop Windows process ${pid}: ${error.stderr || error.message}`);
    });
    return;
  }

  const signal = options.force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

function execFileQuiet(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function addValueArg(args, name, value) {
  if (value !== undefined && value !== null && value !== "") {
    args.push(name, String(value));
  }
}

async function waitForReady({ store, pid, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) {
      throw new Error("Artifacty server exited before it became ready");
    }
    const state = await readServerState(store);
    if (state?.pid === pid && state.url) {
      const health = await fetchHealth(state.url);
      if (health.ok) {
        return state;
      }
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Artifacty server to become ready after ${timeoutMs}ms`);
}

async function waitForStop(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) {
      return true;
    }
    await delay(100);
  }
  return !isPidRunning(pid);
}

function readPidFile(pidFile) {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function fetchHealth(url) {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(500)
    });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false };
  }
}

async function tailFile(file, maxBytes = 2000) {
  try {
    const content = await readFile(file, "utf8");
    return content.slice(-maxBytes).trim();
  } catch {
    return "";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeFd(fd) {
  if (typeof fd !== "number") {
    return;
  }
  try {
    closeSync(fd);
  } catch {
    // The child inherited the descriptor; parent cleanup is best effort.
  }
}
