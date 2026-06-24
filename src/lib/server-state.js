import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

function normalizePublicBaseUrl(value) {
  return String(value || DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
}
