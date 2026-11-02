// Translate only Artifacty's small internal SQLite-shaped SQL surface.
// This is not a general SQLite parser and must never receive user-authored SQL.
const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const lower = 'abcdefghijklmnopqrstuvwxyz';
const fold = value => `translate(${value}, '${upper}', '${lower}')`;

export function sqlSegments(sql) {
  const segments = [];
  let start = 0, index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const comment = sql.startsWith('--', index) || sql.startsWith('/*', index);
    const dollar = char === '$' && /^\$[a-zA-Z_0-9]*\$/.exec(sql.slice(index));
    if (char !== "'" && char !== '"' && !comment && !dollar) { index++; continue; }
    if (index > start) segments.push({ code: true, text: sql.slice(start, index) });
    const begin = index;
    if (comment) {
      if (sql.startsWith('--', index)) { const end = sql.indexOf('\n', index); index = end < 0 ? sql.length : end + 1; }
      else { const end = sql.indexOf('*/', index + 2); if (end < 0) throw new Error('Unterminated SQL comment'); index = end + 2; }
    } else if (dollar) {
      const end = sql.indexOf(dollar[0], index + dollar[0].length);
      if (end < 0) throw new Error('Unterminated SQL dollar quote');
      index = end + dollar[0].length;
    } else {
      let closed = false;
      index++;
      while (index < sql.length) {
        if (sql[index++] !== char) continue;
        if (sql[index] === char) { index++; continue; }
        closed = true; break;
      }
      if (!closed) throw new Error('Unterminated SQL quote');
    }
    segments.push({ code: false, text: sql.slice(begin, index) }); start = index;
  }
  if (start < sql.length) segments.push({ code: true, text: sql.slice(start) });
  return segments;
}

export function splitSqlStatements(sql) {
  const statements = []; let current = '';
  for (const segment of sqlSegments(sql)) {
    if (!segment.code) { current += segment.text; continue; }
    const pieces = segment.text.split(';');
    current += pieces.shift();
    for (const piece of pieces) { if (current.trim()) statements.push(current.trim()); current = piece; }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export function translatePostgresSql(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('SQL is required');
  let sql = input.trim().replace(/;\s*$/, '');
  const tableInfo = /^PRAGMA\s+table_info\(([a-z_][a-z_0-9]*)\)$/i.exec(sql);
  if (tableInfo) return { text: `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${tableInfo[1]}' ORDER BY ordinal_position`, parameters: 0 };
  if (/^PRAGMA\s+(journal_mode|foreign_keys|busy_timeout)\b/i.test(sql)) return { text: 'SELECT 1', parameters: 0 };
  if (/^PRAGMA\b/i.test(sql)) throw new Error('Unsupported PostgreSQL pragma');
  const replace = /^INSERT\s+OR\s+REPLACE\s+INTO\s+meta\s*\(\s*key\s*,\s*value\s*\)/i.test(sql);
  if (/^INSERT\s+OR\s+REPLACE\b/i.test(sql) && !replace) throw new Error('Unsupported PostgreSQL replacement');
  const ignore = /^INSERT\s+OR\s+IGNORE\b/i.test(sql);
  let parameters = 0;
  sql = sqlSegments(sql).map(segment => {
    if (!segment.code) return segment.text;
    let text = segment.text
      .replace(/\bINSERT\s+OR\s+(?:IGNORE|REPLACE)\b/gi, 'INSERT')
      .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'BIGSERIAL PRIMARY KEY')
      .replace(/\bBLOB\b/gi, 'BYTEA')
      .replace(/\bBEGIN\s+IMMEDIATE\b/gi, 'BEGIN')
      .replace(/\bsqlite_master\b/gi, "(SELECT tablename AS name, 'table' AS type FROM pg_tables WHERE schemaname = current_schema()) AS sqlite_master");
    // DDL uses explicit expression indexes in the PostgreSQL schema initializer.
    if (/^\s*CREATE\s+TABLE\b/i.test(input)) text = text.replace(/\s+COLLATE\s+NOCASE\b/gi, '');
    else {
      text = text.replace(/([a-z_][a-z_0-9.]*)\s*=\s*\?\s+COLLATE\s+NOCASE\b/gi, (_, column) => `${fold(column)} = ${fold('?')}`);
      text = text.replace(/([a-z_][a-z_0-9.]*)\s+COLLATE\s+NOCASE\b/gi, (_, column) => fold(column));
    }
    return text.replace(/\?/g, () => `$${++parameters}`);
  }).join('');
  if (replace) sql += ' ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value';
  if (ignore) sql += ' ON CONFLICT DO NOTHING';
  return { text: sql, parameters };
}
