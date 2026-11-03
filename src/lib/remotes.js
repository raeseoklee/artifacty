import { mkdir, lstat, readFile, writeFile, rename, rm, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FILE = "remoteprofiles.json";
const fail = (message, code = "INVALID_REMOTE_CONFIG") => Object.assign(new Error(message), { code });
const directory = options => path.resolve(options.configDir || process.env.ARTIFACTY_CONFIG_HOME || path.join(homedir(), ".config", "artifacty"));
const empty = () => ({ version: 1, active: null, remotes: [] });
const validName = name => { if (typeof name !== "string" || (!NAME.test(name) || name.toLowerCase() === "active")) throw fail("Remote name must start with a letter and contain at most 64 letters, numbers, underscores or hyphens"); return name; };

export function normalizeRemoteUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw fail("Remote URL must be an HTTP or HTTPS server address"); }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) throw fail("Remote URL must not contain credentials, query parameters or a fragment");
  return parsed.href.replace(/\/+$/, "");
}
export function remoteMcpUrl(value) {
  const url = normalizeRemoteUrl(value);
  return /\/mcp$/.test(new URL(url).pathname) ? url : `${url}/mcp`;
}
function token(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 16384 || /[\r\n\0]/.test(value)) throw fail("Remote token must be one bounded line of text");
  return value;
}
async function privatePath(file, isDirectory) {
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === "ENOENT") return false; throw fail("Cannot inspect remote configuration"); }
  if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile()) || (process.getuid && info.uid !== process.getuid()) || (process.platform !== "win32" && (info.mode & 0o077))) throw fail("Remote configuration must be private, owned by the current user, and must not be a symbolic link", "UNSAFE_REMOTE_CONFIG");
  return true;
}
function validate(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.remotes) || value.remotes.length > 100 || (value.active !== null && !NAME.test(value.active))) throw fail("Remote configuration is invalid");
  const names = new Set();
  for (const remote of value.remotes) {
    if (!remote || !NAME.test(remote.name) || remote.name.toLowerCase() === "active" || names.has(remote.name) || typeof remote.url !== "string" || normalizeRemoteUrl(remote.url) !== remote.url) throw fail("Remote configuration is invalid");
    names.add(remote.name); token(remote.apiToken);
  }
  if (value.active !== null && !names.has(value.active)) throw fail("The active remote profile is missing");
  return value;
}
async function read(options) {
  const root = directory(options);
  if (!await privatePath(root, true)) return empty();
  const file = path.join(root, FILE);
  if (!await privatePath(file, false)) return empty();
  try {
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw fail("Remote configuration is too large");
    return validate(JSON.parse(text));
  } catch (error) { if (error.code === "INVALID_REMOTE_CONFIG") throw error; throw fail("Remote configuration cannot be read or parsed"); }
}
async function edit(options, action) {
  const root = directory(options);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await privatePath(root, true);
  const lock = path.join(root, ".remoteprofiles.lock");
  let handle;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { handle = await open(lock, "wx", 0o600); break; }
    catch (error) { if (error.code !== "EEXIST") throw fail("Cannot lock remote configuration"); await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  if (!handle) throw fail("Remote configuration is locked; retry after the current command finishes", "REMOTE_CONFIG_BUSY");
  const temporary = path.join(root, `.${FILE}.${randomUUID()}.tmp`);
  try {
    const config = await read(options);
    const result = action(config);
    validate(config);
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path.join(root, FILE));
    return result;
  } finally { await rm(temporary, { force: true }); await handle.close(); await rm(lock, { force: true }); }
}
const summary = (profile, active) => ({ name: profile.name, url: profile.url, hasToken: Boolean(profile.apiToken), active: active === profile.name });

export async function addRemote(name, url, options = {}) {
  validName(name); const normalized = normalizeRemoteUrl(url); const suppliedToken = token(options.apiToken);
  return edit(options, config => {
    const existing = config.remotes.find(profile => profile.name === name);
    if (existing && new URL(existing.url).protocol === "https:" && new URL(normalized).protocol === "http:" && options.allowInsecureDowngrade !== true) throw fail("Changing an HTTPS remote to HTTP requires explicit insecure-downgrade approval", "REMOTE_TLS_DOWNGRADE");
    if (!existing && config.remotes.length >= 100) throw fail("At most 100 remote profiles are supported");
    const profile = { name, url: normalized };
    // Credentials are never inherited from an environment variable or another URL.
    const apiToken = suppliedToken ?? (existing?.url === normalized && !Object.hasOwn(options, "apiToken") ? existing.apiToken : undefined);
    if (apiToken) profile.apiToken = apiToken;
    if (existing) config.remotes[config.remotes.indexOf(existing)] = profile; else config.remotes.push(profile);
    return summary(profile, config.active);
  });
}
export async function useRemote(name, options = {}) {
  validName(name);
  return edit(options, config => {
    const profile = config.remotes.find(entry => entry.name === name);
    if (!profile) throw fail("Remote profile does not exist", "REMOTE_NOT_FOUND");
    config.active = name;
    return summary(profile, config.active);
  });
}
export async function listRemotes(options = {}) {
  const config = await read(options);
  return config.remotes.map(profile => summary(profile, config.active));
}
export async function resolveRemote(options = {}) {
  const config = await read(options);
  const name = options.name ?? config.active;
  if (!name) throw fail("No active remote profile; select one with artifacty remote use", "REMOTE_NOT_SELECTED");
  validName(name);
  const profile = config.remotes.find(entry => entry.name === name);
  if (!profile) throw fail("Remote profile does not exist", "REMOTE_NOT_FOUND");
  return { name, url: profile.url, mcpUrl: remoteMcpUrl(profile.url), apiToken: profile.apiToken || "" };
}

async function responseText(response) {
  if (!response.body?.getReader) return response.text();
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) throw fail("Remote MCP response is too large"); chunks.push(value); }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); }
}
export async function checkRemoteEndpoint(url, options = {}) {
  const normalized = normalizeRemoteUrl(url); const endpoint = remoteMcpUrl(normalized);
  const timeoutMs = Number(options.timeoutMs ?? 10000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw fail("Remote check timeout must be between 100 and 120000 milliseconds");
  const apiToken = token(options.apiToken); const fetcher = options.fetch || fetch;
  let session;
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const post = async (message, notification = false) => {
    const response = await fetcher(endpoint, { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json", accept: "application/json", ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}), ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(message) });
    if (!response.ok) throw fail("Remote MCP check failed");
    session ||= response.headers?.get("mcp-session-id") || undefined;
    const body = await responseText(response);
    if (notification && !body.trim()) return null;
    const reply = JSON.parse(body);
    if (!reply || reply.jsonrpc !== "2.0" || reply.id !== message.id || reply.error || !reply.result) throw fail("Remote MCP returned an invalid reply");
    return reply.result;
  };
  try {
    const initialized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "artifacty-remote-check", version: "1" } } });
    if (typeof initialized.protocolVersion !== "string" || !initialized.capabilities || !initialized.serverInfo) throw fail("Remote MCP initialization was invalid");
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, true);
    const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    if (!Array.isArray(tools.tools) || tools.tools.some(tool => !tool || typeof tool.name !== "string")) throw fail("Remote MCP tools reply was invalid");
    return { ok: true, url: normalized, toolsCount: tools.tools.length };
  } catch { throw fail("Remote MCP check failed; verify the server address, authentication and connectivity", "REMOTE_CHECK_FAILED"); }
  finally { clearTimeout(timeout); }
}
export async function checkRemote(name, options = {}) {
  const profile = await resolveRemote({ ...options, ...(name ? { name } : {}) });
  return { ...await checkRemoteEndpoint(profile.url, { ...options, apiToken: profile.apiToken }), name: profile.name };
}
