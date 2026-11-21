import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPostgresDatabase, closePostgresPool, postgresPoolStats } from '../src/lib/postgres-database.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
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

// Connection reuse. Each test uses its own schema name, so its pool key is private.
const newSchema = () => `pool_${randomUUID().replaceAll('-', '')}`;
const pidOf = db => db.prepare('SELECT pg_backend_pid() AS pid').get().pid;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, limit = 5000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) { if (await check()) return true; await sleep(25); }
  return false;
}
const backendExists = (probe, pid) => probe.prepare('SELECT count(*) AS count FROM pg_stat_activity WHERE pid = ?').get(pid).count === 1;
function dropSchema(schema) {
  const cleanup = openPostgresDatabase({ connectionString: url, schema, poolSize: 0 });
  try { cleanup.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { cleanup.close(); }
}

test('PostgreSQL pool settings reject unsafe sizes before connecting', () => {
  const base = { connectionString: 'postgresql://localhost/test' };
  for (const poolSize of [-1, 33, 1.5, 'many']) assert.throws(() => openPostgresDatabase({ ...base, poolSize }), /pool size/);
  assert.throws(() => openPostgresDatabase({ ...base, poolIdleMs: 1 }), /idle timeout/);
  const previous = process.env.ARTIFACTY_POSTGRES_POOL_SIZE;
  process.env.ARTIFACTY_POSTGRES_POOL_SIZE = '-3';
  try { assert.throws(() => openPostgresDatabase(base), /pool size/); }
  finally { if (previous === undefined) delete process.env.ARTIFACTY_POSTGRES_POOL_SIZE; else process.env.ARTIFACTY_POSTGRES_POOL_SIZE = previous; }
});

test('PostgreSQL sequential opens reuse one backend connection', { skip: !url }, () => {
  const schema = newSchema();
  const first = openPostgresDatabase({ connectionString: url, schema });
  const pid = pidOf(first);
  first.close();
  try {
    for (let index = 0; index < 3; index += 1) {
      const next = openPostgresDatabase({ connectionString: url, schema });
      try { assert.equal(pidOf(next), pid); assert.equal(next.prepare('SELECT current_schema() AS schema').get().schema, schema); }
      finally { next.close(); }
    }
  } finally { closePostgresPool(); dropSchema(schema); }
});

test('PostgreSQL concurrent opens receive distinct connections and both return to the pool', { skip: !url }, () => {
  const schema = newSchema();
  closePostgresPool();
  const a = openPostgresDatabase({ connectionString: url, schema });
  const b = openPostgresDatabase({ connectionString: url, schema });
  try {
    const pidA = pidOf(a); const pidB = pidOf(b);
    assert.notEqual(pidA, pidB);
    a.close(); b.close();
    assert.equal(postgresPoolStats().idle, 2);
    // Two concurrent opens after release get the two pooled connections, one each.
    const c = openPostgresDatabase({ connectionString: url, schema });
    const d = openPostgresDatabase({ connectionString: url, schema });
    try { assert.deepEqual([pidOf(c), pidOf(d)].sort(), [pidA, pidB].sort()); }
    finally { c.close(); d.close(); }
  } finally { closePostgresPool(); dropSchema(schema); }
});

test('PostgreSQL handle cannot reach a connection after it was released', { skip: !url }, () => {
  const schema = newSchema();
  const db = openPostgresDatabase({ connectionString: url, schema });
  const query = db.prepare('SELECT 1 AS one');
  db.close();
  db.close();
  try {
    assert.throws(() => query.get(), /closed/);
    assert.throws(() => db.exec('SELECT 1'), /closed/);
  } finally { closePostgresPool(); dropSchema(schema); }
});

test('PostgreSQL connection closed inside a transaction is rolled back before reuse', { skip: !url }, () => {
  const schema = newSchema();
  closePostgresPool();
  const setup = openPostgresDatabase({ connectionString: url, schema });
  setup.exec('CREATE TABLE entries (id TEXT PRIMARY KEY)');
  const probe = openPostgresDatabase({ connectionString: url, schema, poolSize: 0 });
  try {
    const abandoned = pidOf(setup);
    setup.close();
    const leaking = openPostgresDatabase({ connectionString: url, schema });
    assert.equal(pidOf(leaking), abandoned);
    leaking.exec('BEGIN IMMEDIATE');
    leaking.prepare('INSERT INTO entries VALUES (?)').run('uncommitted');
    leaking.close();
    assert.equal(probe.prepare('SELECT state FROM pg_stat_activity WHERE pid = ?').get(abandoned).state, 'idle');
    probe.close();
    const reused = openPostgresDatabase({ connectionString: url, schema });
    try {
      assert.equal(pidOf(reused), abandoned);
      assert.equal(reused.prepare('SELECT count(*) AS count FROM entries').get().count, 0);
      reused.exec('BEGIN IMMEDIATE'); reused.exec('COMMIT');
    } finally { reused.close(); }
  } finally { closePostgresPool(); dropSchema(schema); }
});

test('PostgreSQL connection that hit a statement error is verified and still reusable', { skip: !url }, () => {
  const schema = newSchema();
  const db = openPostgresDatabase({ connectionString: url, schema });
  db.exec('CREATE TABLE entries (id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO entries VALUES (?)').run('one');
  assert.throws(() => db.prepare('INSERT INTO entries VALUES (?)').run('one'), { code: '23505' });
  const pid = pidOf(db);
  db.close();
  const next = openPostgresDatabase({ connectionString: url, schema });
  try {
    assert.equal(pidOf(next), pid);
    assert.equal(next.prepare('SELECT count(*) AS count FROM entries').get().count, 1);
  } finally { next.close(); closePostgresPool(); dropSchema(schema); }
});

test('PostgreSQL pool size 0 disables reuse and terminates connections on close', { skip: !url }, async () => {
  const schema = newSchema();
  closePostgresPool();
  const probe = openPostgresDatabase({ connectionString: url, schema: newSchema(), poolSize: 0 });
  try {
    const first = openPostgresDatabase({ connectionString: url, schema, poolSize: 0 });
    const firstPid = pidOf(first); first.close();
    const second = openPostgresDatabase({ connectionString: url, schema, poolSize: 0 });
    const secondPid = pidOf(second); second.close();
    assert.notEqual(firstPid, secondPid);
    assert.equal(postgresPoolStats().idle, 0);
    assert.equal(await waitFor(() => !backendExists(probe, firstPid) && !backendExists(probe, secondPid)), true);
  } finally { probe.close(); dropSchema(schema); }
});

test('PostgreSQL pool environment variable 0 disables reuse', { skip: !url }, () => {
  const schema = newSchema();
  closePostgresPool();
  const previous = process.env.ARTIFACTY_POSTGRES_POOL_SIZE;
  process.env.ARTIFACTY_POSTGRES_POOL_SIZE = '0';
  try {
    const first = openPostgresDatabase({ connectionString: url, schema });
    const firstPid = pidOf(first); first.close();
    const second = openPostgresDatabase({ connectionString: url, schema });
    try { assert.notEqual(pidOf(second), firstPid); } finally { second.close(); }
    assert.equal(postgresPoolStats().idle, 0);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTY_POSTGRES_POOL_SIZE; else process.env.ARTIFACTY_POSTGRES_POOL_SIZE = previous;
    dropSchema(schema);
  }
});

test('PostgreSQL pool caps idle connections and closes the surplus', { skip: !url }, async () => {
  const schema = newSchema();
  closePostgresPool();
  const handles = [1, 2, 3].map(() => openPostgresDatabase({ connectionString: url, schema, poolSize: 1 }));
  const pids = handles.map(pidOf);
  assert.equal(new Set(pids).size, 3);
  const probe = openPostgresDatabase({ connectionString: url, schema: newSchema(), poolSize: 0 });
  try {
    for (const handle of handles) handle.close();
    assert.equal(postgresPoolStats().idle, 1);
    assert.equal(await waitFor(() => pids.filter(pid => backendExists(probe, pid)).length === 1), true);
  } finally { probe.close(); closePostgresPool(); dropSchema(schema); }
});

test('PostgreSQL idle connections are evicted after the idle timeout', { skip: !url }, async () => {
  const schema = newSchema();
  closePostgresPool();
  const probe = openPostgresDatabase({ connectionString: url, schema: newSchema(), poolSize: 0 });
  try {
    const db = openPostgresDatabase({ connectionString: url, schema, poolIdleMs: 100 });
    const pid = pidOf(db);
    db.close();
    assert.equal(postgresPoolStats().idle, 1);
    assert.equal(await waitFor(() => postgresPoolStats().idle === 0), true);
    assert.equal(await waitFor(() => !backendExists(probe, pid)), true);
  } finally { probe.close(); closePostgresPool(); dropSchema(schema); }
});

test('PostgreSQL closePostgresPool drains idle connections and closes handles still in use later', { skip: !url }, async () => {
  const schema = newSchema();
  closePostgresPool();
  const idle = openPostgresDatabase({ connectionString: url, schema });
  const busy = openPostgresDatabase({ connectionString: url, schema });
  const probe = openPostgresDatabase({ connectionString: url, schema: newSchema(), poolSize: 0 });
  try {
    const idlePid = pidOf(idle); const busyPid = pidOf(busy);
    idle.close();
    assert.equal(closePostgresPool(), 1);
    assert.equal(postgresPoolStats().idle, 0);
    assert.equal(await waitFor(() => !backendExists(probe, idlePid)), true);
    busy.close();
    assert.equal(postgresPoolStats().idle, 0);
    assert.equal(await waitFor(() => !backendExists(probe, busyPid)), true);
    assert.equal(closePostgresPool(), 0);
  } finally { probe.close(); dropSchema(schema); }
});

test('PostgreSQL idle connection dropped by the server is replaced instead of reused', { skip: !url, timeout: 30000 }, async () => {
  const schema = newSchema();
  closePostgresPool();
  const db = openPostgresDatabase({ connectionString: url, schema });
  const pid = pidOf(db);
  db.close();
  const killer = openPostgresDatabase({ connectionString: url, schema: newSchema(), poolSize: 0 });
  try {
    assert.equal(killer.prepare('SELECT pg_terminate_backend(?) AS ok').get(pid).ok, true);
    await sleep(1300);
    const next = openPostgresDatabase({ connectionString: url, schema });
    try { assert.notEqual(pidOf(next), pid); } finally { next.close(); }
  } finally { killer.close(); closePostgresPool(); dropSchema(schema); }
});

test('PostgreSQL connection lost while in use is never returned to the pool', { skip: !url }, () => {
  const schema = newSchema();
  closePostgresPool();
  const db = openPostgresDatabase({ connectionString: url, schema });
  const killer = openPostgresDatabase({ connectionString: url, schema: newSchema(), poolSize: 0 });
  try {
    db.exec('BEGIN IMMEDIATE');
    killer.prepare('SELECT pg_terminate_backend(?)').get(pidOf(db));
    assert.throws(() => db.prepare('SELECT 1').get());
    assert.doesNotThrow(() => db.close());
    assert.equal(postgresPoolStats().idle, 0);
    const fresh = openPostgresDatabase({ connectionString: url, schema });
    try { assert.equal(fresh.prepare('SELECT 1 AS one').get().one, 1); } finally { fresh.close(); }
  } finally { killer.close(); closePostgresPool(); dropSchema(schema); }
});

test('a process with pooled PostgreSQL connections exits promptly', { skip: !url, timeout: 30000 }, async () => {
  const schema = newSchema();
  const moduleUrl = new URL('../src/lib/postgres-database.js', import.meta.url).href;
  const script = `import {openPostgresDatabase,postgresPoolStats} from ${JSON.stringify(moduleUrl)};
const settings={connectionString:process.env.ARTIFACTY_TEST_POSTGRES_URL,schema:process.env.ARTIFACTY_TEST_POSTGRES_SCHEMA};
const a=openPostgresDatabase(settings);const b=openPostgresDatabase(settings);
a.prepare('SELECT 1').get();b.prepare('SELECT 1').get();a.close();b.close();
console.log('idle='+postgresPoolStats().idle+' at='+Date.now());`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ARTIFACTY_TEST_POSTGRES_URL: url, ARTIFACTY_TEST_POSTGRES_SCHEMA: schema }, timeout: 20000 });
    const finished = Date.now();
    const printedAt = Number(/at=(\d+)/.exec(stdout)[1]);
    assert.match(stdout, /idle=2/);
    // Pooled workers and the 30 second idle timers must not hold the process open.
    assert.ok(finished - printedAt < 1500, `exit took ${finished - printedAt} ms after the last output`);
  } finally { dropSchema(schema); }
});

test('closing the HTTP server drains idle PostgreSQL connections', { skip: !url, timeout: 60000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'artifacty-pg-pool-'));
  const schema = newSchema();
  closePostgresPool();
  let app;
  try {
    app = await startServer({ home, port: 0, databaseUrl: url, databaseSchema: schema });
    assert.equal((await fetch(app.url + '/health')).status, 200);
    assert.equal(postgresPoolStats().idle >= 1, true);
    const started = Date.now();
    await app.close(); app = undefined;
    assert.ok(Date.now() - started < 3000);
    assert.equal(postgresPoolStats().idle, 0);
  } finally {
    await app?.close();
    closePostgresPool();
    dropSchema(schema);
    await rm(home, { recursive: true, force: true });
  }
});
