import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createStore, getArtifact, insertAuditRow, openDatabase, transaction } from "./storage.js";

function error(message, statusCode = 403) {
  return Object.assign(new Error(message), { statusCode });
}

function database(store) {
  const db = openDatabase(store);
  db.exec(`CREATE TABLE IF NOT EXISTS artifact_share_links (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    version INTEGER,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    issuer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_user_id TEXT
  )`);
  return db;
}

function policy(db) {
  return { enabledInPrivate: db.prepare("SELECT value FROM meta WHERE key = 'share_link_policy'").get()?.value === "true" };
}

function privateMode(db) {
  return db.prepare("SELECT value FROM meta WHERE key = 'access_mode'").get()?.value === "private";
}

function principal(db, access) {
  const user = access?.userId && db.prepare("SELECT id, role FROM users WHERE id = ? AND active = 1").get(access.userId);
  if (!user) throw error("An active personal account is required");
  return user;
}

function managedArtifact(db, artifactId, access) {
  const user = principal(db, access);
  const artifact = db.prepare("SELECT id, owner_user_id, archived_at FROM artifacts WHERE id = ?").get(artifactId);
  if (!artifact) throw error("Artifact not found", 404);
  if (user.role !== "admin" && artifact.owner_user_id !== user.id) throw error("Only the owner or an administrator may manage share links");
  return { artifact, user };
}

function metadata(row) {
  return { id: row.id, version: row.version, expiresAt: row.expires_at, createdAt: row.created_at, revokedAt: row.revoked_at };
}

export function getShareLinkPolicy(store = createStore()) {
  const db = database(store);
  try { return policy(db); } finally { db.close(); }
}

export function setShareLinkPolicy(store = createStore(), { enabledInPrivate } = {}, { access, audit } = {}) {
  const db = database(store);
  try {
    if (principal(db, access).role !== "admin") throw error("Administrator access required");
    if (typeof enabledInPrivate !== "boolean") throw error("enabledInPrivate must be boolean", 400);
    transaction(db, () => {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('share_link_policy', ?)").run(String(enabledInPrivate));
      insertAuditRow(db, { action: "share-link-policy-change", artifactId: "", audit, metadata: { enabledInPrivate } });
    });
    return { enabledInPrivate };
  } finally { db.close(); }
}

export function createShareLink(store = createStore(), artifactId, { version = null, expiresAt } = {}, { access, audit } = {}) {
  const db = database(store);
  try {
    const { artifact, user } = managedArtifact(db, artifactId, access);
    if (privateMode(db) && !policy(db).enabledInPrivate) throw error("Share links are disabled in private mode");
    if (artifact.archived_at) throw error("Archived artifacts cannot be shared", 400);
    if (version !== null && (!Number.isSafeInteger(version) || version < 1 || !db.prepare("SELECT 1 FROM artifact_versions WHERE artifact_id = ? AND version = ?").get(artifactId, version))) {
      throw error("Invalid artifact version", 400);
    }
    const expiry = expiresAt === undefined ? Date.now() + 7 * 86400000 : typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw error("Expiration must be a future date", 400);
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    expiresAt = new Date(expiry).toISOString();
    transaction(db, () => {
      db.prepare(`INSERT INTO artifact_share_links (id, artifact_id, token_hash, version, expires_at, created_at, issuer_user_id, owner_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, artifactId, createHash("sha256").update(token).digest("hex"), version, expiresAt, createdAt, user.id, artifact.owner_user_id);
      insertAuditRow(db, { action: "share-link-create", artifactId, audit, metadata: { linkId: id, version, expiresAt } });
    });
    return { id, token, version, expiresAt, createdAt, revokedAt: null };
  } finally { db.close(); }
}

export function listShareLinks(store = createStore(), artifactId, { access } = {}) {
  const db = database(store);
  try {
    managedArtifact(db, artifactId, access);
    return db.prepare("SELECT * FROM artifact_share_links WHERE artifact_id = ? ORDER BY created_at DESC, id").all(artifactId).map(metadata);
  } finally { db.close(); }
}

export function revokeShareLink(store = createStore(), artifactId, linkId, { access, audit } = {}) {
  const db = database(store);
  try {
    managedArtifact(db, artifactId, access);
    transaction(db, () => {
      const result = db.prepare("UPDATE artifact_share_links SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND artifact_id = ?").run(new Date().toISOString(), linkId, artifactId);
      if (!result.changes) throw error("Share link not found", 404);
      insertAuditRow(db, { action: "share-link-revoke", artifactId, audit, metadata: { linkId } });
    });
    return { id: linkId, revoked: true };
  } finally { db.close(); }
}

function resolveRow(db, token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw error("Share link not found", 404);
  const row = db.prepare(`SELECT l.*, a.owner_user_id AS current_owner, a.archived_at, u.active, u.role
    FROM artifact_share_links l JOIN artifacts a ON a.id = l.artifact_id JOIN users u ON u.id = l.issuer_user_id
    WHERE l.token_hash = ?`).get(createHash("sha256").update(token).digest("hex"));
  if (!row || row.revoked_at || row.archived_at || !row.active || row.owner_user_id !== row.current_owner ||
    (row.role !== "admin" && row.issuer_user_id !== row.current_owner) ||
    !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now() ||
    (privateMode(db) && !policy(db).enabledInPrivate)) throw error("Share link not found", 404);
  return row;
}

export async function resolveShareLink(store = createStore(), token) {
  const db = database(store);
  try {
    const row = resolveRow(db, token);
    let artifact;
    try { artifact = await getArtifact(store, row.artifact_id, { version: row.version, audit: { surface: "share-link", actor: "share-link" } }); }
    catch { throw error("Share link not found", 404); }
    // Recheck after the asynchronous file read to honor revocation during I/O.
    resolveRow(db, token);
    return { artifact, version: artifact.version, content: artifact.content };
  } finally { db.close(); }
}
