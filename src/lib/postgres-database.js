import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

const MAX_TIMEOUT = 120000;
const DEFAULT_POOL_SIZE = 4;
const MAX_POOL_SIZE = 32;
const DEFAULT_IDLE_MS = 30000;
// A connection that sat idle this long may have been dropped by the server or
// a NAT device, so verify it before handing it out again.
const VALIDATE_AFTER_MS = 1000;

// Idle connections per connection configuration. Handles are exclusive: a
// connection leaves this list when it is handed out and returns only through
// the owning handle's close().
const pools = new Map();
let poolGeneration = 0;

function resolveSettings(config) {
  const schema = config.schema || 'artifacty';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || ['public', 'pg_catalog', 'information_schema'].includes(schema) || schema.startsWith('pg_')) throw new Error('Invalid PostgreSQL schema');
  const timeoutMs = config.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT) throw new Error('Invalid PostgreSQL timeout');
  if (typeof config.connectionString !== 'string' || !/^postgres(?:ql)?:\/\//i.test(config.connectionString)) throw new Error('A PostgreSQL connection URL is required');
  const rawSize = config.poolSize ?? process.env.ARTIFACTY_POSTGRES_POOL_SIZE;
  let poolSize = DEFAULT_POOL_SIZE;
  if (rawSize !== undefined && rawSize !== '') {
    poolSize = typeof rawSize === 'number' ? rawSize : /^\d{1,3}$/.test(String(rawSize).trim()) ? Number(rawSize) : NaN;
    if (!Number.isSafeInteger(poolSize) || poolSize < 0 || poolSize > MAX_POOL_SIZE) throw new Error('Invalid PostgreSQL pool size');
  }
  const idleMs = config.poolIdleMs ?? DEFAULT_IDLE_MS;
  if (!Number.isSafeInteger(idleMs) || idleMs < 10 || idleMs > 3600000) throw new Error('Invalid PostgreSQL pool idle timeout');
  return { schema, timeoutMs, poolSize, idleMs, connectionString: config.connectionString, key: JSON.stringify([config.connectionString, schema, timeoutMs]), config: { ...config, schema, timeoutMs } };
}

// Starts a worker and its PostgreSQL connection and waits for startup to finish.
function connect(settings) {
  const { timeoutMs } = settings;
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const connection = { closed: false, tx: false, dirty: false, idleTimer: null, idleSince: 0, generation: poolGeneration, request, dispose };
  const worker = new Worker(new URL('./postgres-worker.js', import.meta.url), {
    workerData: { port: port2, signal: signal.buffer, config: settings.config }, transferList: [port2],
    execArgv: []
  });
  worker.unref(); port1.unref();
  // The worker catches startup/query errors. Unexpected exits still have a bounded wait.
  worker.on('error', () => {});
  function dispose() {
    connection.closed = true;
    clearTimeout(connection.idleTimer);
    port1.close(); void worker.terminate();
  }
  function wait() {
    const deadline = Date.now() + timeoutMs + 1000;
    while (Atomics.load(signal, 0) === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { dispose(); throw Object.assign(new Error('PostgreSQL operation timed out; connection closed'), { code: 'POSTGRES_TIMEOUT' }); }
      Atomics.wait(signal, 0, 0, remaining);
    }
    const envelope = receiveMessageOnPort(port1)?.message;
    if (!envelope) { dispose(); throw Object.assign(new Error('PostgreSQL worker stopped unexpectedly'), { code: 'POSTGRES_WORKER_FAILED' }); }
    // The worker reports whether it is inside a transaction. An error leaves
    // the session state unverified until the next release has checked it.
    connection.tx = envelope.tx === true;
    if (envelope.error) connection.dirty = true;
    if (envelope.error?.code === '22021') throw Object.assign(new Error('Text containing NUL characters cannot be stored in PostgreSQL'), { code: 'INVALID_TEXT', statusCode: 400 });
    if (envelope.error) throw Object.assign(new Error(envelope.error.message), { code: envelope.error.code });
    return envelope.result;
  }
  function request(command, sql, params = []) {
    if (connection.closed) throw new Error('PostgreSQL connection is closed');
    Atomics.store(signal, 0, 0);
    port1.postMessage({ command, sql, params });
    return wait();
  }
  try { wait(); } catch (error) { dispose(); throw error; }
  return connection;
}

// Ends the PostgreSQL session politely and always disposes the worker.
function terminate(connection) {
  if (connection.closed) return;
  try { connection.request('close'); } catch { /* The worker is disposed below. */ } finally { connection.dispose(); }
}

// Rolls back an open transaction, drops session advisory locks, and proves the
// connection still answers. Throws when the connection cannot be trusted.
function recycle(connection) {
  connection.request('reset');
  connection.tx = false;
  connection.dirty = false;
}

function checkout(settings) {
  const pool = pools.get(settings.key);
  while (pool?.length) {
    const connection = pool.pop();
    clearTimeout(connection.idleTimer);
    if (pool.length === 0) pools.delete(settings.key);
    if (connection.closed) continue;
    if (Date.now() - connection.idleSince > VALIDATE_AFTER_MS) {
      try { recycle(connection); } catch { connection.dispose(); continue; }
    }
    return connection;
  }
  return connect(settings);
}

function release(connection, settings) {
  // A timeout or worker failure already disposed this connection.
  if (connection.closed) return;
  // Pooling disabled, or the pool was drained while this handle was in use.
  if (settings.poolSize === 0 || connection.generation !== poolGeneration) { terminate(connection); return; }
  if (connection.tx || connection.dirty) {
    // Never return a connection that is in a transaction or in an unknown state
    // unless a rollback and health check succeed.
    try { recycle(connection); } catch { terminate(connection); return; }
  }
  let pool = pools.get(settings.key);
  if (!pool) { pool = []; pools.set(settings.key, pool); }
  connection.idleSince = Date.now();
  connection.idleTimer = setTimeout(() => {
    const list = pools.get(settings.key);
    const index = list ? list.indexOf(connection) : -1;
    if (index >= 0) { list.splice(index, 1); if (list.length === 0) pools.delete(settings.key); }
    terminate(connection);
  }, settings.idleMs);
  connection.idleTimer.unref();
  pool.push(connection);
  while (pool.length > settings.poolSize) terminate(pool.shift());
}

export function openPostgresDatabase(config = {}) {
  const settings = resolveSettings(config);
  const connection = checkout(settings);
  let released = false;
  function live() {
    // A handle must not reach a connection another caller may now own.
    if (released) throw new Error('PostgreSQL connection is closed');
    return connection;
  }
  return {
    kind: 'postgres', schema: settings.schema,
    exec(sql) { live().request('exec', sql); },
    prepare(sql) {
      return { get: (...params) => live().request('get', sql, params), all: (...params) => live().request('all', sql, params), run: (...params) => live().request('run', sql, params) };
    },
    close() {
      if (released) return;
      released = true;
      release(connection, settings);
    }
  };
}

// Closes every idle pooled connection. Connections still checked out are
// closed instead of pooled when their handle closes. Safe to call repeatedly.
export function closePostgresPool() {
  poolGeneration += 1;
  let closed = 0;
  for (const pool of pools.values()) {
    for (const connection of pool) { clearTimeout(connection.idleTimer); terminate(connection); closed += 1; }
  }
  pools.clear();
  return closed;
}

// Test hook: the number of idle connections held for every configuration.
export function postgresPoolStats() {
  let idle = 0;
  for (const pool of pools.values()) idle += pool.length;
  return { configurations: pools.size, idle };
}
