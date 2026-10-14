import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { createStore, insertAuditRow, openDatabase, transaction } from "./storage.js";

function policyError(message, code = "INVALID_NETWORK_POLICY", statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function parseAddress(address) {
  if (typeof address !== "string" || address.includes("%")) return null;
  const family = isIP(address);
  if (!family) return null;
  if (family === 4) {
    return { bits: 32, value: address.split(".").reduce((value, byte) => (value << 8n) | BigInt(byte), 0n) };
  }
  let text = address.toLowerCase();
  if (text.includes(".")) {
    const separator = text.lastIndexOf(":");
    const ipv4 = parseAddress(text.slice(separator + 1));
    text = `${text.slice(0, separator)}:${(ipv4.value >> 16n).toString(16)}:${(ipv4.value & 65535n).toString(16)}`;
  }
  const halves = text.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return { bits: 128, value: words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n) };
}

function formatAddress(value, bits) {
  if (bits === 32) return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join(".");
  const words = Array.from({ length: 8 }, (_, index) => ((value >> BigInt((7 - index) * 16)) & 65535n).toString(16));
  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < words.length;) {
    if (words[index] !== "0") { index++; continue; }
    const start = index;
    while (index < words.length && words[index] === "0") index++;
    if (index - start > bestLength) { bestStart = start; bestLength = index - start; }
  }
  if (bestStart < 0) return words.join(":");
  return `${words.slice(0, bestStart).join(":")}::${words.slice(bestStart + bestLength).join(":")}`;
}

function parseNetwork(entry) {
  const parts = entry.split("/");
  const address = parseAddress(parts[0]);
  if (!address || parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) {
    throw policyError(`Invalid IP address or CIDR: ${entry}`);
  }
  let { value, bits } = address;
  let prefix = parts.length === 2 ? Number(parts[1]) : bits;
  if (prefix > bits) throw policyError(`Invalid CIDR prefix: ${entry}`);
  // Socket peers commonly use IPv4-mapped IPv6 addresses. Treat their
  // IPv4-sized networks identically to ordinary IPv4 entries.
  if (bits === 128 && value >> 32n === 65535n && prefix >= 96) {
    bits = 32;
    prefix -= 96;
    value &= 0xffffffffn;
  }
  const shift = BigInt(bits - prefix);
  value = (value >> shift) << shift;
  return { value, bits, prefix, text: `${formatAddress(value, bits)}${parts.length === 2 ? `/${prefix}` : ""}` };
}

export function normalizeAllowedNetworks(input = []) {
  if (typeof input !== "string" && !Array.isArray(input)) throw policyError("Allowed networks must be a list or text.");
  const entries = typeof input === "string" ? input.split(/[,\r\n]+/) : input;
  return [...new Set(entries.map((entry) => {
    if (typeof entry !== "string") throw policyError("Each allowed network must be text.");
    return entry.trim();
  }).filter(Boolean).map((entry) => parseNetwork(entry).text))];
}

export function isAddressAllowed(address, allowedCidrs = []) {
  const networks = normalizeAllowedNetworks(allowedCidrs);
  if (!networks.length) return true;
  const parsed = parseAddress(address);
  if (!parsed) return false;
  const candidates = [parsed];
  if (parsed.bits === 128 && parsed.value >> 32n === 65535n) candidates.push({ bits: 32, value: parsed.value & 0xffffffffn });
  return networks.some((entry) => {
    const network = parseNetwork(entry);
    const shift = BigInt(network.bits - network.prefix);
    return candidates.some((candidate) => candidate.bits === network.bits && (candidate.value >> shift) === (network.value >> shift));
  });
}

function readPolicy(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'network_policy'").get();
  if (!row) return { allowedCidrs: [], allowSharedLinks: false };
  const policy = JSON.parse(row.value);
  if (!policy || !Object.hasOwn(policy, "allowedCidrs")) throw policyError("Stored network policy is invalid.");
  return validatePolicy(policy);
}

function readPending(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'network_policy_pending'").get();
  return row ? JSON.parse(row.value) : null;
}

function publicPending(pending) {
  return pending ? { id: pending.id, expiresAt: pending.expiresAt, allowedCidrs: pending.allowedCidrs, allowSharedLinks: pending.allowSharedLinks === true } : null;
}

function writePolicy(db, policy, action, audit, metadata = {}) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('network_policy', ?)").run(JSON.stringify(policy));
  insertAuditRow(db, { action, artifactId: "", audit, metadata: { ...metadata, policy } });
}

function recoverExpired(db, now = Date.now()) {
  const pending = readPending(db);
  if (!pending || Date.parse(pending.expiresAt) > Number(now)) return false;
  writePolicy(db, pending.previousPolicy, "network-policy-auto-rollback", { actor: "system:network-policy", surface: "network-policy" }, { pendingId: pending.id });
  db.prepare("DELETE FROM meta WHERE key = 'network_policy_pending'").run();
  return true;
}

function requireAdmin(db, access) {
  const user = access?.userId && db.prepare("SELECT role, active FROM users WHERE id = ?").get(access.userId);
  if (access?.role !== "admin" || !user || user.role !== "admin" || !user.active) {
    throw policyError("An active administrator account is required.", "FORBIDDEN", 403);
  }
}

function validatePolicy(policy, remoteAddress) {
  if (!policy || !Object.hasOwn(policy, "allowedCidrs")) throw policyError("Allowed networks are required.");
  if (policy.allowSharedLinks !== undefined && typeof policy.allowSharedLinks !== "boolean") throw policyError("Shared-link access must be a boolean.");
  const normalized = { allowedCidrs: normalizeAllowedNetworks(policy.allowedCidrs), allowSharedLinks: policy.allowSharedLinks === true };
  if (remoteAddress !== undefined && !isAddressAllowed(remoteAddress, normalized.allowedCidrs)) {
    throw policyError("Allowed networks must include your current IP address.", "NETWORK_POLICY_LOCKOUT");
  }
  return normalized;
}

function requireNoPending(db) {
  if (readPending(db)) throw policyError("Confirm or roll back the pending network change first.", "NETWORK_POLICY_PENDING", 409);
}

export function recoverExpiredNetworkPolicy(store = createStore(), { now = Date.now() } = {}) {
  const db = openDatabase(store);
  try { return transaction(db, () => recoverExpired(db, now)); }
  finally { db.close(); }
}

export function getNetworkPolicy(store = createStore()) {
  const db = openDatabase(store);
  try {
    return transaction(db, () => {
      recoverExpired(db);
      return readPolicy(db);
    });
  } finally { db.close(); }
}

export function getPendingNetworkPolicy(store = createStore()) {
  const db = openDatabase(store);
  try {
    return transaction(db, () => {
      recoverExpired(db);
      return publicPending(readPending(db));
    });
  } finally { db.close(); }
}

export function setNetworkPolicy(store = createStore(), policy = {}, { access, audit = {}, remoteAddress } = {}) {
  recoverExpiredNetworkPolicy(store);
  const db = openDatabase(store);
  try {
    return transaction(db, () => {
      requireAdmin(db, access);
      requireNoPending(db);
      const normalized = validatePolicy(policy, remoteAddress);
      writePolicy(db, normalized, "network-policy-update", { ...audit, actor: audit.actor || access.userId });
      return normalized;
    });
  } finally { db.close(); }
}

export function stageNetworkPolicy(store = createStore(), policy = {}, { access, audit = {}, remoteAddress, timeoutMs = 120000 } = {}) {
  recoverExpiredNetworkPolicy(store);
  const db = openDatabase(store);
  try {
    return transaction(db, () => {
      requireAdmin(db, access);
      requireNoPending(db);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 10000 || timeoutMs > 600000) {
        throw policyError("Network confirmation timeout must be between 10 seconds and 10 minutes.");
      }
      if (!parseAddress(remoteAddress)) throw policyError("Your current IP address is required.");
      const normalized = validatePolicy(policy, remoteAddress);
      const pending = {
        id: randomUUID(), expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
        allowedCidrs: normalized.allowedCidrs, allowSharedLinks: normalized.allowSharedLinks, previousPolicy: readPolicy(db)
      };
      db.prepare("INSERT INTO meta (key, value) VALUES ('network_policy_pending', ?)").run(JSON.stringify(pending));
      writePolicy(db, normalized, "network-policy-stage", { ...audit, actor: audit.actor || access.userId }, { pendingId: pending.id, expiresAt: pending.expiresAt });
      return publicPending(pending);
    });
  } finally { db.close(); }
}

function finishPending(store, id, { access, audit = {}, remoteAddress } = {}, confirm) {
  // Commit expiry recovery independently so a subsequent stale-ID error cannot
  // roll it back and leave a user locked out after the deadline.
  recoverExpiredNetworkPolicy(store);
  const db = openDatabase(store);
  try {
    return transaction(db, () => {
      requireAdmin(db, access);
      const pending = readPending(db);
      if (!pending || pending.id !== id) throw policyError("Pending network change not found or expired.", "NETWORK_POLICY_NOT_PENDING", 409);
      if (confirm && (!parseAddress(remoteAddress) || !isAddressAllowed(remoteAddress, pending.allowedCidrs))) {
        throw policyError("Confirmation requires access from an allowed IP address.", "IP_NOT_ALLOWED", 403);
      }
      const policy = validatePolicy(confirm ? { allowedCidrs: pending.allowedCidrs, allowSharedLinks: pending.allowSharedLinks } : pending.previousPolicy);
      writePolicy(db, policy, confirm ? "network-policy-confirm" : "network-policy-rollback", { ...audit, actor: audit.actor || access.userId }, { pendingId: pending.id });
      db.prepare("DELETE FROM meta WHERE key = 'network_policy_pending'").run();
      return policy;
    });
  } finally { db.close(); }
}

export function confirmNetworkPolicy(store = createStore(), id, options = {}) {
  return finishPending(store, id, options, true);
}

export function rollbackNetworkPolicy(store = createStore(), id, options = {}) {
  return finishPending(store, id, options, false);
}

export function assertNetworkAccess(store, remoteAddress) {
  if (!isAddressAllowed(remoteAddress, getNetworkPolicy(store).allowedCidrs)) {
    throw policyError("Access from this IP address is not allowed.", "IP_NOT_ALLOWED", 403);
  }
}
