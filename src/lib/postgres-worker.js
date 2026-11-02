import { workerData } from 'node:worker_threads';
import { serialize } from 'node:v8';
import { splitSqlStatements, translatePostgresSql } from './postgres-sql.js';
const { port, config } = workerData;
const signal = new Int32Array(workerData.signal);
let client;
let inTransaction = false;
function reply(result, error) {
  port.postMessage(error ? { error } : { result });
  Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
}
function safeError(error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && /package 'pg'/.test(error.message || '')) return { code: 'POSTGRES_DRIVER_MISSING', message: 'PostgreSQL driver is not installed; reinstall Artifacty with optional dependencies enabled' };
  const messages = { '23505': 'PostgreSQL unique constraint failed', '23503': 'PostgreSQL foreign key constraint failed', '23514': 'PostgreSQL check constraint failed', '23502': 'PostgreSQL required value missing', '42P01': 'PostgreSQL table is not initialized', '42703': 'PostgreSQL column is not initialized', '57014': 'PostgreSQL statement timed out', '40P01': 'PostgreSQL transaction deadlock', '40001': 'PostgreSQL transaction must be retried', '28P01': 'PostgreSQL authentication failed', '3D000': 'PostgreSQL database does not exist', '42501': 'PostgreSQL permission denied', 'ECONNREFUSED': 'PostgreSQL connection refused', 'ENOTFOUND': 'PostgreSQL host was not found' };
  return { code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'POSTGRES_ERROR', message: messages[error?.code] || 'PostgreSQL operation failed' };
}
try {
  const { default: pg } = await import('pg');
  const types = pg.types;
  types.setTypeParser(20, value => { const number = Number(value); if (!Number.isSafeInteger(number)) throw Object.assign(new Error('Unsafe database integer'), { code: 'POSTGRES_INTEGER_RANGE' }); return number; });
  client = new pg.Client({ connectionString: config.connectionString, connectionTimeoutMillis: config.timeoutMs, statement_timeout: config.timeoutMs, query_timeout: config.timeoutMs, application_name: 'artifacty' });
  client.on('error', () => {});
  await client.connect();
  // PostgreSQL CREATE SCHEMA IF NOT EXISTS can still race its catalog inserts.
  // Use the same database/schema key as write transactions before inspecting DDL.
  await client.query("SELECT pg_advisory_lock(hashtextextended(current_database() || ':' || $1, 0))", [config.schema]);
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`);
    await client.query(`SET search_path TO "${config.schema}", pg_catalog`);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended(current_database() || ':' || $1, 0))", [config.schema]);
  }
  reply(true);
  port.on('message', async ({ command, sql, params = [] }) => {
    try {
      if (command === 'close') { await client.end(); reply(true); port.close(); return; }
      let result;
      const statements = command === 'exec' ? splitSqlStatements(sql) : [sql];
      for (const statement of statements) {
        const translated = translatePostgresSql(statement);
        if (translated.parameters !== params.length) throw new Error('Invalid SQL parameter count');
        const values = params.map(value => value instanceof Uint8Array ? Buffer.from(value) : value);
        const begin = /^\s*BEGIN\b/i.test(statement);
        const end = /^\s*(?:COMMIT|ROLLBACK)\s*$/i.test(statement);
        // SQLite constraint errors roll back the statement, not its transaction.
        // Preserve that behavior for callers that intentionally catch a failure.
        const savepoint = inTransaction && !begin && !end && !/^\s*(?:SAVEPOINT|RELEASE|ROLLBACK\s+TO)\b/i.test(statement);
        if (savepoint) await client.query('SAVEPOINT artifacty_statement');
        try {
          result = await client.query(translated.text, values);
          if (begin) inTransaction = true;
          if (/^\s*BEGIN\s+IMMEDIATE\b/i.test(statement)) await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema(), 0))");
          if (end) inTransaction = false;
          if (savepoint) await client.query('RELEASE SAVEPOINT artifacty_statement');
        } catch (error) {
          if (savepoint) {
            try { await client.query('ROLLBACK TO SAVEPOINT artifacty_statement'); await client.query('RELEASE SAVEPOINT artifacty_statement'); }
            catch { /* The outer transaction remains responsible for recovery. */ }
          }
          throw error;
        }
      }
      const value = command === 'get' ? result?.rows[0] : command === 'all' ? result?.rows || [] : { changes: result?.rowCount || 0, lastInsertRowid: 0 };
      if (serialize(value).length > 128 * 1024 * 1024) throw Object.assign(new Error('Database response too large'), { code: 'POSTGRES_RESULT_TOO_LARGE' });
      reply(value);
    } catch (error) { reply(null, safeError(error)); }
  });
} catch (error) { reply(null, safeError(error)); try { await client?.end(); } catch {} port.close(); }
