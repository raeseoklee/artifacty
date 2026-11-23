import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const STORE_ID_FILE = ".store-id";
const STORE_ID = /^[a-f0-9-]{36}$/;

// /health identifies its store with this random ID instead of the store's
// absolute path, which any allowed client could read. The updater reads the
// same file to confirm that a URL serves the store it is updating.
export function readStoreIdentity(home) {
  try {
    const value = readFileSync(path.join(path.resolve(home), STORE_ID_FILE), "utf8").trim();
    return STORE_ID.test(value) ? value : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function storeIdentity(home) {
  const existing = readStoreIdentity(home);
  if (existing) return existing;
  const value = randomUUID();
  try {
    writeFileSync(path.join(path.resolve(home), STORE_ID_FILE), `${value}\n`, { flag: "wx", mode: 0o600 });
    return value;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const raced = readStoreIdentity(home);
    if (!raced) throw new Error("Invalid store identity file");
    return raced;
  }
}

export const DEFAULT_PUBLIC_URL = "http://127.0.0.1:8787";
const SERVER_STATE_FILE = "server.json";

export async function writeServerState(store, state) {
  const next = {
    schemaVersion: 1,
    url: normalizePublicBaseUrl(state.url),
    host: state.host,
    port: state.port,
    requestedPort: state.requestedPort,
    portFallback: Boolean(state.portFallback),
    pid: process.pid,
    updatedAt: new Date().toISOString()
  };
  await mkdir(store.home, { recursive: true });
  await writeFile(serverStatePath(store), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export async function readServerState(store) {
  try {
    const parsed = JSON.parse(await readFile(serverStatePath(store), "utf8"));
    if (typeof parsed.url !== "string" || !/^https?:\/\//.test(parsed.url)) {
      return null;
    }
    return {
      ...parsed,
      url: normalizePublicBaseUrl(parsed.url)
    };
  } catch {
    return null;
  }
}

export async function resolvePublicBaseUrl(store, options = {}) {
  const configured = options.url || process.env.ARTIFACTY_URL;
  if (configured) {
    return normalizePublicBaseUrl(configured);
  }
  const state = await readServerState(store);
  return state?.url || DEFAULT_PUBLIC_URL;
}

export function serverStatePath(store) {
  return path.join(store.home, SERVER_STATE_FILE);
}

export function normalizePublicBaseUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || DEFAULT_PUBLIC_URL).trim()); } catch { throw new Error("Invalid public base URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid public base URL");
  return parsed.href.replace(/\/+$/, "");
}

const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "via"];
const plainAddress = (value) => String(value || "").replace(/^::ffff:/i, "").toLowerCase();

// True when the HTTP connection comes from this machine without passing
// through a proxy: a loopback peer, or a peer that is this server's own
// address (a local client that dialed the LAN IP). Updaters before 0.21.0
// call /health on the same host and accept the new release only when it
// reports its store path, so /health returns that path to these requests and
// keeps it from remote and proxied ones.
export function isSameHostRequest(request) {
  if (FORWARDING_HEADERS.some((name) => request?.headers?.[name] !== undefined)) return false;
  const remote = plainAddress(request?.socket?.remoteAddress);
  if (!remote) return false;
  if (remote === "::1" || /^127\./.test(remote)) return true;
  return remote === plainAddress(request?.socket?.localAddress);
}
