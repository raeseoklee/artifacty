import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStoreKey, readStoreKey, exportStoreKey, importStoreKey } from '../src/lib/store-keys.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'artifacty-keys-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home: path.join(root, 'home'), keyDirectory: path.join(root, 'keys'), storeId: randomUUID(), keyId: randomUUID() };
}

test('external raw key and private recovery round trip to another home without overwrites', (t) => {
  const o = fixture(t);
  const created = createStoreKey(o);
  assert.equal(fs.statSync(created.keyFile).size, 32);
  const original = readStoreKey(o);
  assert.equal(original.length, 32);
  assert.throws(() => createStoreKey(o));
  const recovery = path.join(o.root, 'recovery.json');
  exportStoreKey(o, recovery);
  assert.throws(() => exportStoreKey(o, recovery));
  const fresh = { ...o, home: path.join(o.root, 'another-home'), keyDirectory: path.join(o.root, 'restored-keys') };
  importStoreKey(fresh, recovery);
  assert.deepEqual(readStoreKey(fresh), original);
  assert.throws(() => importStoreKey(fresh, recovery));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(created.keyFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(created.keyFile)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(recovery).mode & 0o777, 0o600);
  }
});

test('missing and malformed keys fail without regeneration', (t) => {
  const o = fixture(t);
  assert.throws(() => readStoreKey(o));
  assert.equal(fs.existsSync(o.keyDirectory), false);
  const { keyFile } = createStoreKey(o);
  fs.writeFileSync(keyFile, Buffer.alloc(31));
  assert.throws(() => readStoreKey(o));
  assert.equal(fs.statSync(keyFile).size, 31);
  fs.unlinkSync(keyFile);
  assert.throws(() => readStoreKey(o));
  assert.equal(fs.existsSync(keyFile), false);
});

test('UUIDs, absolute external paths, aliases, symlinks and hard links are rejected', (t) => {
  const o = fixture(t);
  for (const change of [{ storeId: '../escape' }, { keyId: 'x' }, { keyDirectory: 'relative' }, { keyDirectory: o.home }, { keyDirectory: path.join(o.home, 'nested') }]) assert.throws(() => createStoreKey({ ...o, ...change }));
  fs.mkdirSync(o.home, { mode: 0o700 });
  const alias = path.join(o.root, 'home-alias');
  fs.symlinkSync(o.home, alias, 'junction');
  assert.throws(() => createStoreKey({ ...o, keyDirectory: path.join(alias, 'keys') }));
  const { keyFile } = createStoreKey(o);
  const hardlink = path.join(o.root, 'hardlink');
  fs.linkSync(keyFile, hardlink);
  assert.throws(() => readStoreKey(o));
  fs.unlinkSync(hardlink);
  fs.renameSync(keyFile, hardlink);
  if (process.platform !== 'win32') {
    fs.symlinkSync(hardlink, keyFile);
    assert.throws(() => readStoreKey(o));
    assert.throws(() => createStoreKey(o));
  }
});

test('wrong POSIX owner and permissive modes fail closed', { skip: process.platform === 'win32' }, (t) => {
  const o = fixture(t);
  const { keyFile } = createStoreKey(o);
  fs.chmodSync(keyFile, 0o644);
  assert.throws(() => readStoreKey(o));
  fs.chmodSync(keyFile, 0o600);
  fs.chmodSync(o.keyDirectory, 0o755);
  assert.throws(() => readStoreKey(o));
  fs.chmodSync(o.keyDirectory, 0o700);
  if (process.getuid() === 0) {
    fs.chownSync(keyFile, 1, 1);
    assert.throws(() => readStoreKey(o));
    fs.chownSync(keyFile, 0, 0);
  }
});

test('malformed, mismatched, noncanonical and extra-field recovery records fail', (t) => {
  const o = fixture(t);
  const recovery = path.join(o.root, 'recovery.json');
  const valid = { version: 1, storeId: o.storeId, keyId: o.keyId, base64key: Buffer.alloc(32, 7).toString('base64') };
  for (const item of ['{', JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, storeId: randomUUID() }), JSON.stringify({ ...valid, keyId: randomUUID() }), JSON.stringify({ ...valid, base64key: 'bad' }), JSON.stringify({ ...valid, base64key: valid.base64key + '\n' }), JSON.stringify({ ...valid, extra: true })]) {
    fs.writeFileSync(recovery, item, { mode: 0o600 });
    assert.throws(() => importStoreKey(o, recovery));
    assert.equal(fs.existsSync(path.join(o.keyDirectory, o.storeId, `${o.keyId}.key`)), false);
  }
});


test('canonical home aliases prevent containment while ordinary ancestor aliases work', (t) => {
  const o = fixture(t);
  const alias = path.join(o.root, 'alias');
  const actual = path.join(o.root, 'actual');
  fs.mkdirSync(actual, { mode: 0o700 });
  fs.symlinkSync(actual, alias, 'junction');
  const outside = { ...o, keyDirectory: path.join(alias, 'external-keys') };
  createStoreKey(outside);
  assert.equal(readStoreKey(outside).length, 32);
  assert.throws(() => createStoreKey({ ...o, home: alias, keyDirectory: path.join(actual, 'hidden-keys') }));
  assert.equal(fs.existsSync(path.join(actual, 'hidden-keys')), false);
  assert.throws(() => createStoreKey({ ...o, keyDirectory: alias }));
  fs.mkdirSync(o.home, { mode: 0o700 });
  assert.throws(() => exportStoreKey(outside, path.join(o.home, 'recovery.json')));
  assert.equal(fs.existsSync(path.join(o.home, 'recovery.json')), false);
});

test('POSIX creation syncs file then directory and propagates directory sync failure', { skip: process.platform === 'win32' }, (t) => {
  const o = fixture(t);
  const original = fs.fsyncSync;
  const events = [];
  t.mock.method(fs, 'fsyncSync', (fd) => {
    events.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file');
    return original(fd);
  });
  createStoreKey(o);
  const fileIndex = events.indexOf('file');
  assert.ok(fileIndex > 0, 'new directories must be synced before key creation');
  assert.equal(events[fileIndex + 1], 'directory', 'key directory entry must be durable before success');
  events.length = 0;
  exportStoreKey(o, path.join(o.root, 'durable-recovery.json'));
  assert.deepEqual(events, ['file', 'directory']);
  t.mock.method(fs, 'fsyncSync', (fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error('directory sync failed');
    return original(fd);
  });
  assert.throws(() => exportStoreKey(o, path.join(o.root, 'uncertain-recovery.json')), /directory sync failed/);
});

test('recovery export wipes serialized buffers on success and write failure', (t) => {
  const o = fixture(t);
  createStoreKey(o);
  const original = fs.writeFileSync;
  const seen = [];
  let reject = false;
  t.mock.method(fs, 'writeFileSync', (fd, bytes, ...args) => {
    seen.push(bytes);
    if (reject) throw new Error('write failed');
    return original(fd, bytes, ...args);
  });
  const destination = path.join(o.root, 'recovery.json');
  exportStoreKey(o, destination);
  assert.ok(seen[0].every((byte) => byte === 0));
  assert.equal(JSON.parse(fs.readFileSync(destination)).version, 1);
  reject = true;
  assert.throws(() => exportStoreKey(o, path.join(o.root, 'failed-recovery.json')), /write failed/);
  assert.ok(seen[1].every((byte) => byte === 0));
});
