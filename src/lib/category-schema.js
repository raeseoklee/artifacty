export const MAX_CATEGORY_DEPTH = 5;

// Kept independent of storage.js so its schema initializer can call this
// without importing the category service back into itself.
export function initializeCategorySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL ${db.kind === "postgres" ? "" : "COLLATE NOCASE"},
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'team')),
      owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES categories(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL AND team_id IS NULL)
        OR (scope = 'team' AND owner_user_id IS NULL AND team_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS category_artifacts (
      category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (category_id, artifact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_category_artifacts_artifact ON category_artifacts(artifact_id);
  `);
  // Existing flat categories become root categories. The enclosing store
  // migration protects SQLite with its mandatory pre-migration snapshot.
  const columns = db.prepare("PRAGMA table_info(categories)").all();
  if (!columns.some(column => column.name === "parent_id")) {
    db.exec("ALTER TABLE categories ADD COLUMN parent_id TEXT REFERENCES categories(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED");
  }
  const name = db.kind === "postgres" ? "translate(name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')" : "name";
  db.exec(`
    DROP INDEX IF EXISTS idx_categories_personal_name;
    DROP INDEX IF EXISTS idx_categories_team_name;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_personal_sibling_name
      ON categories(owner_user_id, COALESCE(parent_id, ''), ${name}) WHERE scope = 'personal';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_team_sibling_name
      ON categories(team_id, COALESCE(parent_id, ''), ${name}) WHERE scope = 'team';
    CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
  `);
}

export function currentCategoryAccess(db, access) {
  const user = access?.userId && db.prepare("SELECT id, role FROM users WHERE id = ? AND active = 1").get(access.userId);
  if (!user) throw Object.assign(new Error("A signed-in personal account is required for categories"), {
    name: "ForbiddenError", code: "forbidden", statusCode: 403
  });
  return { userId: user.id, role: user.role, anonymous: false };
}

export function categoryAccessClause(access, alias = "c") {
  return {
    sql: `((${alias}.scope = 'personal' AND ${alias}.owner_user_id = ?)
      OR (${alias}.scope = 'team' AND (? = 'admin' OR EXISTS (
        SELECT 1 FROM team_members cm WHERE cm.team_id = ${alias}.team_id AND cm.user_id = ?))))`,
    params: [access.userId, access.role, access.userId]
  };
}

// The category does not grant artifact access. Callers must also apply
// their normal visibility predicate before counting or paging results.
export function categoryArtifactPredicate(db, categoryId, access, prefix = "") {
  if (!["", "a.", "artifacts."].includes(prefix)) throw new Error("Invalid artifact SQL prefix");
  access = currentCategoryAccess(db, access);
  const readable = categoryAccessClause(access);
  if (typeof categoryId !== "string" || !db.prepare(`SELECT c.id FROM categories c WHERE c.id = ? AND ${readable.sql}`)
    .get(categoryId, ...readable.params)) {
    throw Object.assign(new Error("Category not found"), { code: "CATEGORY_NOT_FOUND", statusCode: 404 });
  }
  return {
    sql: `EXISTS (SELECT 1 FROM category_artifacts ca WHERE ca.category_id = ? AND ca.artifact_id = ${prefix}id)`,
    params: [categoryId],
    access
  };
}

// Full backup import must reject invalid trees inside its restore transaction.
export function validateCategoryHierarchy(db) {
  const rows = db.prepare("SELECT id, scope, owner_user_id, team_id, parent_id FROM categories").all();
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const row of rows) {
    const seen = new Set();
    let depth = 0;
    for (let current = row; current; current = current.parent_id ? byId.get(current.parent_id) : null) {
      if (seen.has(current.id) || ++depth > MAX_CATEGORY_DEPTH) throw hierarchyError();
      seen.add(current.id);
      if (current.parent_id) {
        const parent = byId.get(current.parent_id);
        if (!parent || parent.scope !== row.scope || parent.owner_user_id !== row.owner_user_id || parent.team_id !== row.team_id) throw hierarchyError();
      }
    }
  }
}

function hierarchyError() {
  return Object.assign(new Error("Category hierarchy must stay within one scope, contain no cycles, and have at most five levels"), { code: "INVALID_CATEGORY_HIERARCHY", statusCode: 400 });
}
