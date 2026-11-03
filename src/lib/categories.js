import { randomUUID } from "node:crypto";
import { createStore, insertAuditRow, openDatabase, transaction, visibilityClause } from "./storage.js";
import { categoryAccessClause, currentCategoryAccess as currentAccess, MAX_CATEGORY_DEPTH } from "./category-schema.js";
export { categoryArtifactPredicate, MAX_CATEGORY_DEPTH } from "./category-schema.js";

export const MAX_CATEGORIES_PER_SCOPE = 200;
export const MAX_CATEGORY_NAME_LENGTH = 120;

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: "INVALID_CATEGORY" });
}

function notFound() {
  return Object.assign(new Error("Category not found"), { statusCode: 404, code: "CATEGORY_NOT_FOUND" });
}

function categoryName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_CATEGORY_NAME_LENGTH) {
    throw invalid(`Category name must contain 1 to ${MAX_CATEGORY_NAME_LENGTH} characters`);
  }
  return value.trim();
}

function categoryInDb(db, id, access) {
  const clause = categoryAccessClause(access);
  const row = db.prepare(`SELECT c.*, t.name AS team_name FROM categories c
    LEFT JOIN teams t ON t.id = c.team_id WHERE c.id = ? AND ${clause.sql}`).get(id, ...clause.params);
  if (!row) throw notFound();
  return row;
}

function parentIdentifier(value) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > 80) throw invalid("parentId must be a category ID or null");
  return value.trim();
}

function placement(db, category, parentId, access) {
  const scopeColumn = category.scope === "personal" ? "owner_user_id" : "team_id";
  const scopeId = category.owner_user_id || category.team_id;
  const rows = db.prepare(`SELECT id, parent_id FROM categories WHERE ${scopeColumn} = ?`).all(scopeId);
  const byId = new Map(rows.map(row => [row.id, row]));
  if (parentId) {
    const parent = categoryInDb(db, parentId, access);
    if (parent.scope !== category.scope || (parent.owner_user_id || parent.team_id) !== scopeId) {
      throw invalid("Parent categories must belong to the same personal or team scope");
    }
  }
  const seen = new Set([category.id]);
  let ancestors = 0;
  for (let id = parentId; id; id = byId.get(id)?.parent_id) {
    if (seen.has(id)) throw invalid("A category cannot be its own ancestor");
    if (!byId.has(id)) throw invalid("The parent hierarchy is unavailable");
    seen.add(id);
    ancestors++;
  }
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.parent_id)) children.set(row.parent_id, []);
    children.get(row.parent_id).push(row.id);
  }
  function height(id, path = new Set()) {
    if (path.has(id)) throw invalid("Category hierarchy contains a cycle");
    const next = new Set(path).add(id);
    return 1 + Math.max(0, ...(children.get(id) || []).map(child => height(child, next)));
  }
  if (ancestors + height(category.id) > MAX_CATEGORY_DEPTH) throw invalid(`Categories can be at most ${MAX_CATEGORY_DEPTH} levels deep`);
  return parentId;
}

function duplicateName(db, category, name, parentId, excludeId = "") {
  const selector = category.scope === "personal" ? "owner_user_id = ?" : "team_id = ?";
  const parent = parentId ? "parent_id = ?" : "parent_id IS NULL";
  return db.prepare(`SELECT 1 FROM categories WHERE ${selector} AND ${parent} AND name = ? COLLATE NOCASE AND id != ?`)
    .get(category.owner_user_id || category.team_id, ...(parentId ? [parentId] : []), name, excludeId);
}

function categoryResult(row, artifactCount = 0) {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    parentId: row.parent_id || null,
    ownerUserId: row.owner_user_id,
    teamId: row.team_id,
    teamName: row.team_name || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    artifactCount
  };
}

function visibleArtifactIds(db, categoryId, access, includeArchived = false) {
  const visible = visibilityClause("a.", access);
  return db.prepare(`SELECT a.id FROM category_artifacts ca JOIN artifacts a ON a.id = ca.artifact_id
    WHERE ca.category_id = ? AND ${visible.sql} ${includeArchived ? "" : "AND a.archived_at IS NULL"}
    ORDER BY a.updated_at DESC, a.id`).all(categoryId, ...visible.params).map((row) => row.id);
}

function assertReadableArtifact(db, id, access) {
  const visible = visibilityClause("a.", access);
  if (!db.prepare(`SELECT a.id FROM artifacts a WHERE a.id = ? AND ${visible.sql}`).get(id, ...visible.params)) {
    throw Object.assign(new Error("Artifact not found"), { code: "ARTIFACT_NOT_FOUND", statusCode: 404 });
  }
}

function auditMutation(db, action, category, access, audit, artifactId = "") {
  insertAuditRow(db, {
    action,
    artifactId,
    audit: { ...audit, userId: access.userId },
    metadata: { categoryId: category.id, scope: category.scope, teamId: category.team_id || null, parentId: category.parent_id || null }
  });
}

export async function listCategoryTeams(store = createStore(), { access } = {}) {
  const db = openDatabase(store);
  try {
    access = currentAccess(db, access);
    return db.prepare(`SELECT t.id, t.name FROM teams t
      WHERE ? = 'admin' OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = ?)
      ORDER BY t.name COLLATE NOCASE, t.id`).all(access.role, access.userId).map((row) => ({ ...row }));
  } finally { db.close(); }
}

export async function listCategories(store = createStore(), { access, artifactId, includeArchived = false } = {}) {
  const db = openDatabase(store);
  try {
    access = currentAccess(db, access);
    if (artifactId !== undefined) assertReadableArtifact(db, artifactId, access);
    const clause = categoryAccessClause(access);
    return db.prepare(`SELECT c.*, t.name AS team_name FROM categories c LEFT JOIN teams t ON t.id = c.team_id
      WHERE ${clause.sql} ORDER BY c.scope, c.name COLLATE NOCASE, c.id`).all(...clause.params).map((row) => {
      const ids = visibleArtifactIds(db, row.id, access, includeArchived);
      const result = categoryResult(row, ids.length);
      if (artifactId !== undefined) {
        result.containsArtifact = Boolean(db.prepare("SELECT 1 FROM category_artifacts WHERE category_id = ? AND artifact_id = ?").get(row.id, artifactId));
      }
      return result;
    });
  } finally { db.close(); }
}

export async function createCategory(store = createStore(), input = {}, { access, audit } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Category input must be an object");
  let { name, scope = "personal", teamId, parentId = null } = input;
  name = categoryName(name);
  parentId = parentIdentifier(parentId);
  if (!["personal", "team"].includes(scope)) throw invalid("Category scope must be personal or team");
  if (scope === "personal" && teamId) throw invalid("Personal categories cannot have a team");
  if (scope === "team" && (typeof teamId !== "string" || !teamId)) throw invalid("Team categories require teamId");
  const db = openDatabase(store);
  try {
    return transaction(db, () => {
      access = currentAccess(db, access);
      if (scope === "team" && !db.prepare(`SELECT id FROM teams WHERE id = ? AND
        (? = 'admin' OR EXISTS (SELECT 1 FROM team_members WHERE team_id = teams.id AND user_id = ?))`)
        .get(teamId, access.role, access.userId)) throw notFound();
      const ownerUserId = scope === "personal" ? access.userId : null;
      const scopedTeamId = scope === "team" ? teamId : null;
      const selector = scope === "personal" ? "owner_user_id = ?" : "team_id = ?";
      const scopeId = ownerUserId || scopedTeamId;
      const id = randomUUID();
      const candidate = { id, scope, owner_user_id: ownerUserId, team_id: scopedTeamId };
      placement(db, candidate, parentId, access);
      if (duplicateName(db, candidate, name, parentId)) {
        throw Object.assign(new Error("Category name already exists under this parent"), { code: "CATEGORY_EXISTS", statusCode: 409 });
      }
      if (db.prepare(`SELECT COUNT(*) AS count FROM categories WHERE ${selector}`).get(scopeId).count >= MAX_CATEGORIES_PER_SCOPE) {
        throw invalid(`A personal or team scope can have at most ${MAX_CATEGORIES_PER_SCOPE} categories`);
      }
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO categories (id, name, scope, owner_user_id, team_id, parent_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, name, scope, ownerUserId, scopedTeamId, parentId, access.userId, now, now);
      const row = categoryInDb(db, id, access);
      auditMutation(db, "category-create", row, access, audit);
      return categoryResult(row);
    });
  } finally { db.close(); }
}

export async function updateCategory(store = createStore(), id, input = {}, { access, audit } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Category update must be an object");
  const { name, scope, teamId } = input;
  if (scope !== undefined || teamId !== undefined) throw invalid("Category scope cannot be changed; create another category instead");
  const hasName = name !== undefined;
  const hasParent = Object.hasOwn(input, "parentId");
  if (!hasName && !hasParent) throw invalid("Provide a category name or parentId");
  const nextName = hasName ? categoryName(name) : undefined;
  const requestedParent = hasParent ? parentIdentifier(input.parentId) : undefined;
  const db = openDatabase(store);
  try {
    return transaction(db, () => {
      access = currentAccess(db, access);
      const row = categoryInDb(db, id, access);
      const parentId = hasParent ? requestedParent : row.parent_id || null;
      const name = nextName ?? row.name;
      placement(db, row, parentId, access);
      if (duplicateName(db, row, name, parentId, id)) {
        throw Object.assign(new Error("Category name already exists under this parent"), { code: "CATEGORY_EXISTS", statusCode: 409 });
      }
      db.prepare("UPDATE categories SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?").run(name, parentId, new Date().toISOString(), id);
      const updated = categoryInDb(db, id, access);
      auditMutation(db, parentId !== (row.parent_id || null) ? "category-move" : "category-rename", updated, access, audit);
      return categoryResult(updated, visibleArtifactIds(db, id, access).length);
    });
  } finally { db.close(); }
}

export async function deleteCategory(store = createStore(), id, { access, audit } = {}) {
  const db = openDatabase(store);
  try {
    return transaction(db, () => {
      access = currentAccess(db, access);
      const row = categoryInDb(db, id, access);
      if (db.prepare("SELECT 1 FROM categories WHERE parent_id = ?").get(id)) {
        throw Object.assign(new Error("Move or delete child categories before deleting their parent"), { code: "CATEGORY_HAS_CHILDREN", statusCode: 409 });
      }
      db.prepare("DELETE FROM categories WHERE id = ?").run(id);
      auditMutation(db, "category-delete", row, access, audit);
      return { id, deleted: true };
    });
  } finally { db.close(); }
}

export async function setCategoryArtifact(store = createStore(), id, artifactId, present, { access, audit } = {}) {
  if (typeof present !== "boolean") throw invalid("Category membership must be true or false");
  if (typeof artifactId !== "string" || !artifactId) throw invalid("artifactId is required");
  const db = openDatabase(store);
  try {
    return transaction(db, () => {
      access = currentAccess(db, access);
      const row = categoryInDb(db, id, access);
      assertReadableArtifact(db, artifactId, access);
      const change = present
        ? db.prepare("INSERT OR IGNORE INTO category_artifacts (category_id, artifact_id, added_by, created_at) VALUES (?, ?, ?, ?)")
          .run(id, artifactId, access.userId, new Date().toISOString())
        : db.prepare("DELETE FROM category_artifacts WHERE category_id = ? AND artifact_id = ?").run(id, artifactId);
      if (change.changes) {
        db.prepare("UPDATE categories SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
        auditMutation(db, present ? "category-artifact-add" : "category-artifact-remove", row, access, audit, artifactId);
      }
      return { categoryId: id, artifactId, present, changed: Boolean(change.changes) };
    });
  } finally { db.close(); }
}

export async function listCategoryArtifactIds(store = createStore(), id, { access, includeArchived = false } = {}) {
  const db = openDatabase(store);
  try {
    access = currentAccess(db, access);
    categoryInDb(db, id, access);
    return visibleArtifactIds(db, id, access, includeArchived);
  } finally { db.close(); }
}
