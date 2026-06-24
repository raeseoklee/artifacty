import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createStore } from "./storage.js";
import { readServerState, serverStatePath } from "./server-state.js";

const DEFAULT_READY_TIMEOUT_MS = 5000;

export async function startBackgroundServer(options = {}) {
  if (options.generateToken && options.apiToken) {
    throw new Error("Use either --api-token or --generate-token, not both");
  }

  const store = createStore({ home: options.home });
  const paths = backgroundPaths(store);
  const current = await backgroundStatus({ home: store.home });
  if (current.running) {
    throw new Error(`Artifacty server is already running on ${current.url || "unknown URL"} (pid ${current.pid})`);
  }

  mkdirSync(paths.logDir, { recursive: true });
  mkdirSync(store.home, { recursive: true });

  const stdoutFd = openSync(paths.stdoutLog, "a");
  const stderrFd = openSync(paths.stderrLog, "a");
  const child = spawn(process.execPath, buildServerArgs(options, store), {
    detached: true,
    env: buildServerEnv(options),
    stdio: ["ignore", stdoutFd, stderrFd]
  });

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
      logs: {
        stdout: paths.stdoutLog,
        stderr: paths.stderrLog
      },
      statePath: serverStatePath(store)
    };
  } catch (error) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Process may already have exited during startup.
    }
    rmSync(paths.pidFile, { force: true });
    const logTail = await tailFile(paths.stderrLog);
    const message = logTail ? `${error.message}\n${logTail}` : error.message;
    throw new Error(message);
  }
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
      reason: status.pid ? "server was not started by artifacty start" : "server is not running",
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

  process.kill(status.pid, "SIGTERM");
  let stopped = await waitForStop(status.pid, Number(options.timeout || DEFAULT_READY_TIMEOUT_MS));
  if (!stopped && options.force) {
    process.kill(status.pid, "SIGKILL");
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

  return {
    action: "status",
    running: Boolean(processRunning && health.ok),
    processRunning,
    healthy: Boolean(health.ok),
    pid,
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

function buildServerArgs(options, store) {
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
  return args;
}

function buildServerEnv(options) {
  return {
    ...process.env,
    ...(options.apiToken ? { ARTIFACTY_API_TOKEN: options.apiToken } : {})
  };
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
  } catch {
    return false;
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
