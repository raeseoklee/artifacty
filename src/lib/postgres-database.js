import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

const MAX_TIMEOUT = 120000;
export function openPostgresDatabase(config = {}) {
  const schema = config.schema || 'artifacty';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || ['public', 'pg_catalog', 'information_schema'].includes(schema) || schema.startsWith('pg_')) throw new Error('Invalid PostgreSQL schema');
  const timeoutMs = config.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT) throw new Error('Invalid PostgreSQL timeout');
  if (typeof config.connectionString !== 'string' || !/^postgres(?:ql)?:\/\//i.test(config.connectionString)) throw new Error('A PostgreSQL connection URL is required');
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  let closed = false;
  const worker = new Worker(new URL('./postgres-worker.js', import.meta.url), {
    workerData: { port: port2, signal: signal.buffer, config: { ...config, schema, timeoutMs } }, transferList: [port2],
    execArgv: []
  });
  worker.unref(); port1.unref();
  // The worker catches startup/query errors. Unexpected exits still have a bounded wait.
  worker.on('error', () => {});
  function dispose() { closed = true; port1.close(); void worker.terminate(); }
  function wait() {
    const deadline = Date.now() + timeoutMs + 1000;
    while (Atomics.load(signal, 0) === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { dispose(); throw Object.assign(new Error('PostgreSQL operation timed out; connection closed'), { code: 'POSTGRES_TIMEOUT' }); }
      Atomics.wait(signal, 0, 0, remaining);
    }
    const envelope = receiveMessageOnPort(port1)?.message;
    if (!envelope) { dispose(); throw Object.assign(new Error('PostgreSQL worker stopped unexpectedly'), { code: 'POSTGRES_WORKER_FAILED' }); }
    if (envelope.error?.code === '22021') throw Object.assign(new Error('Text containing NUL characters cannot be stored in PostgreSQL'), { code: 'INVALID_TEXT', statusCode: 400 });
    if (envelope.error) throw Object.assign(new Error(envelope.error.message), { code: envelope.error.code });
    return envelope.result;
  }
  function request(command, sql, params = []) {
    if (closed) throw new Error('PostgreSQL connection is closed');
    Atomics.store(signal, 0, 0);
    port1.postMessage({ command, sql, params });
    return wait();
  }
  try { wait(); } catch (error) { dispose(); throw error; }
  return {
    kind: 'postgres', schema,
    exec(sql) { request('exec', sql); },
    prepare(sql) {
      return { get: (...params) => request('get', sql, params), all: (...params) => request('all', sql, params), run: (...params) => request('run', sql, params) };
    },
    close() { if (!closed) { try { request('close'); } finally { dispose(); } } }
  };
}
