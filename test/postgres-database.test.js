import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPostgresDatabase } from '../src/lib/postgres-database.js';
import { translatePostgresSql, splitSqlStatements } from '../src/lib/postgres-sql.js';

const url = process.env.ARTIFACTY_TEST_POSTGRES_URL;
test('PostgreSQL placeholders preserve quoted text, dollar quotes and comments', () => {
  const result = translatePostgresSql("SELECT ?, '?' AS literal, \"?\" AS identifier, $$?$$ AS dollar /* ? */ -- ?\n, ?");
  assert.equal(result.parameters, 2);
  assert.equal(result.text, "SELECT $1, '?' AS literal, \"?\" AS identifier, $$?$$ AS dollar /* ? */ -- ?\n, $2");
  assert.deepEqual(splitSqlStatements("SELECT ';'; SELECT $$;$$; /* ; */ SELECT 3;"), ["SELECT ';'", 'SELECT $$;$$', '/* ; */ SELECT 3']);
});
test('PostgreSQL translations are bounded to internal SQLite operations', () => {
  assert.equal(translatePostgresSql("INSERT OR REPLACE INTO meta(key,value) VALUES ('mode',?)").text, "INSERT INTO meta(key,value) VALUES ('mode',$1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  assert.equal(translatePostgresSql('INSERT OR IGNORE INTO links(id) VALUES (?)').text, 'INSERT INTO links(id) VALUES ($1) ON CONFLICT DO NOTHING');
  assert.match(translatePostgresSql('PRAGMA table_info(users)').text, /information_schema.columns/);
  assert.match(translatePostgresSql("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").text, /pg_tables/);
  assert.match(translatePostgresSql('SELECT id FROM teams WHERE name = ? COLLATE NOCASE').text, /translate\(name,/);
  assert.match(translatePostgresSql('CREATE TABLE x (seq INTEGER PRIMARY KEY AUTOINCREMENT, vector BLOB)').text, /BIGSERIAL PRIMARY KEY, vector BYTEA/);
  for (const source of ["'", '"', 'SELECT $$broken', 'SELECT /* broken']) assert.throws(() => translatePostgresSql(source), /Unterminated/);
  assert.throws(() => translatePostgresSql('PRAGMA integrity_check'), /Unsupported/);
  assert.throws(() => translatePostgresSql('INSERT OR REPLACE INTO users(id) VALUES (?)'), /Unsupported/);
});
test('PostgreSQL configuration rejects unsafe schemas and unreasonable deadlines', () => {
  for (const schema of ['public', 'pg_catalog', 'a; DROP SCHEMA public', 'information_schema', 'pg_secret']) assert.throws(() => openPostgresDatabase({connectionString:'postgresql://localhost/test',schema}), /schema/);
  assert.throws(() => openPostgresDatabase({connectionString:'postgresql://localhost/test',timeoutMs:0}), /timeout/);
  assert.throws(() => openPostgresDatabase({connectionString:'https://localhost'}), /URL/);
});

test('PostgreSQL adapter preserves rows, transactions, byte vectors and case folding', {skip: !url}, () => {
  const schema = `adapter_${randomUUID().replaceAll('-', '')}`;
  const db = openPostgresDatabase({ connectionString: url, schema });
  try {
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE links (id TEXT PRIMARY KEY, label TEXT, vector BLOB); CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)');
    assert.equal(db.kind, 'postgres');
    assert.equal(db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('one','first').changes,1);
    db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('one','second');
    assert.deepEqual(db.prepare('SELECT * FROM meta WHERE key=?').get('one'), {key:'one',value:'second'});
    db.prepare('INSERT INTO links VALUES (?,?,?)').run('id','ASCII',Buffer.from([0,255,3]));
    assert.equal(db.prepare('INSERT OR IGNORE INTO links VALUES (?,?,?)').run('id','ignored',Buffer.alloc(0)).changes,0);
    const row = db.prepare('SELECT * FROM links WHERE label = ? COLLATE NOCASE').get('ascii');
    assert.deepEqual(Buffer.from(row.vector),Buffer.from([0,255,3]));
    assert.equal(db.prepare('SELECT count(*) AS count FROM links').get().count,1);
    assert.equal(db.prepare('PRAGMA table_info(links)').all().length,3);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get('links').name,'links');
    db.exec('BEGIN IMMEDIATE'); db.prepare('DELETE FROM links WHERE id=?').run('id'); db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) AS count FROM links').get().count,1);
    db.exec('BEGIN IMMEDIATE'); db.prepare('DELETE FROM links WHERE id=?').run('id'); db.exec('COMMIT');
    assert.equal(db.prepare('SELECT count(*) AS count FROM links').get().count,0);
    db.prepare('INSERT INTO events(label) VALUES (?)').run('hello');
    assert.equal(db.prepare('SELECT seq FROM events').get().seq,1);
  } finally { db.exec(`DROP SCHEMA ${schema} CASCADE`); db.close(); }
});

test('PostgreSQL connection failures do not expose credentials or hosts', () => {
  const secret = 'do-not-echo-this-password';
  assert.throws(() => openPostgresDatabase({connectionString:`postgresql://user:${secret}@127.0.0.1:1/private_database`,timeoutMs:100}), error => {
    assert.doesNotMatch(error.message, /do-not-echo|private_database|postgresql:\/\//); return true;
  });
});


test('PostgreSQL statement failure preserves the enclosing transaction without exposing values', {skip: !url}, () => {
  const schema = `adapter_${randomUUID().replaceAll('-', '')}`;
  const db = openPostgresDatabase({connectionString:url,schema});
  try {
    db.exec('CREATE TABLE entries (id TEXT PRIMARY KEY, body TEXT)');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO entries VALUES (?,?)').run('one','secret original');
    assert.throws(() => db.prepare('INSERT INTO entries VALUES (?,?)').run('one','secret duplicate'), error => {
      assert.equal(error.code,'23505'); assert.doesNotMatch(error.message,/secret|entries|duplicate/); return true;
    });
    db.prepare('INSERT INTO entries VALUES (?,?)').run('two','survives');
    db.exec('COMMIT');
    assert.equal(db.prepare('SELECT count(*) AS count FROM entries').get().count,2);
  } finally { db.exec(`DROP SCHEMA ${schema} CASCADE`); db.close(); }
});

test('independent PostgreSQL processes serialize read-modify-write transactions and schema creation', {skip: !url,timeout:30000}, async () => {
  const schema = `adapter_${randomUUID().replaceAll('-', '')}`;
  const moduleUrl = new URL('../src/lib/postgres-database.js',import.meta.url).href;
  // Simultaneous first opens exercise schema catalog creation as well as transactions.
  const script = `import {openPostgresDatabase} from ${JSON.stringify(moduleUrl)};
const db=openPostgresDatabase({connectionString:process.env.ARTIFACTY_TEST_POSTGRES_URL,schema:process.env.ARTIFACTY_TEST_POSTGRES_SCHEMA});
try{db.exec('BEGIN IMMEDIATE');db.exec('CREATE TABLE IF NOT EXISTS counter (id TEXT PRIMARY KEY, value INTEGER NOT NULL)');db.prepare('INSERT OR IGNORE INTO counter VALUES (?,?)').run('one',0);const value=db.prepare('SELECT value FROM counter WHERE id=?').get('one').value;db.prepare('SELECT pg_sleep(?)').get(0.04);db.prepare('UPDATE counter SET value=? WHERE id=?').run(value+1,'one');db.exec('COMMIT')}finally{db.close()}`;
  const run=promisify(execFile);
  await Promise.all(Array.from({length:6},()=>run(process.execPath,['--input-type=module','-e',script],{env:{...process.env,ARTIFACTY_TEST_POSTGRES_URL:url,ARTIFACTY_TEST_POSTGRES_SCHEMA:schema},timeout:20000})));
  const db=openPostgresDatabase({connectionString:url,schema});
  try {assert.equal(db.prepare('SELECT value FROM counter WHERE id=?').get('one').value,6);}
  finally {db.exec(`DROP SCHEMA ${schema} CASCADE`);db.close();}
});
