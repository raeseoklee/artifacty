// External key custody. POSIX ownership/mode checks do not enforce Windows ACLs;
// Windows operators must restrict the directory and recovery-file ACLs themselves.
// Node has no portable openat: parent identity is rechecked around each operation,
// but this is not a boundary against another process running as the same OS user.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = () => { throw Object.assign(new Error('Store key custody validation failed.'), { code: 'STORE_KEY_INVALID' }); };
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
function absolute(value) { if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) fail(); return path.resolve(value); }
function canonical(value) {
  let current = value;
  const missing = [];
  while (!fs.existsSync(current)) { missing.unshift(path.basename(current)); const parent = path.dirname(current); if (parent === current) fail(); current = parent; }
  return path.join(fs.realpathSync(current), ...missing);
}
function check(stat, directory = false) {
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) fail();
  if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600))) fail();
}
// Directory fsync is unavailable through portable Node APIs on Windows. POSIX
// callers receive an error if persistence cannot be confirmed; never suppress it.
function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function walk(directory, create = false) {
  const root = path.parse(directory).root;
  let current = root;
  for (const piece of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece);
    if (create && !fs.existsSync(current)) {
      fs.mkdirSync(current, { mode: 0o700 });
      syncDirectory(fs.realpathSync(current));
      syncDirectory(fs.realpathSync(path.dirname(current)));
    }
    let stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      if (current === directory) fail();
      stat = fs.statSync(current);
    }
    if (!stat.isDirectory()) fail();
    // Shared writable ancestors permit directory substitution; sticky temp roots
    // are safe for entries owned by this user against other unprivileged users.
    if (process.platform !== 'win32' && (stat.mode & 0o022) && !(stat.mode & 0o1000)) fail();
  }
  const stat = fs.lstatSync(directory);
  check(stat, true);
  return stat;
}
function identity(before, after) { if (before.dev !== after.dev || before.ino !== after.ino) fail(); }
function location(options, create = false) {
  if (!options || !uuid.test(options.storeId) || !uuid.test(options.keyId)) fail();
  const home = absolute(options.home);
  const directory = absolute(options.keyDirectory);
  if (inside(home, directory) || inside(canonical(home), canonical(directory))) fail();
  if (create === 'validate') return;
  walk(directory, create);
  const storeDirectory = path.join(fs.realpathSync(directory), options.storeId);
  walk(storeDirectory, create);
  return path.join(storeDirectory, `${options.keyId}.key`);
}
function readPrivate(file, maximum) {
  file = absolute(file);
  const parent = path.dirname(file);
  const before = walk(parent);
  const prior = fs.lstatSync(file);
  check(prior);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd); check(stat); identity(prior, stat);
    if (stat.size > maximum) fail();
    const bytes = Buffer.alloc(maximum + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length !== stat.size || length > maximum) { bytes.fill(0); fail(); }
    identity(before, walk(parent)); identity(stat, fs.lstatSync(file)); check(fs.fstatSync(fd));
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function writePrivate(file, bytes) {
  file = absolute(file);
  const parent = path.dirname(file);
  const before = walk(parent);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    const stat = fs.fstatSync(fd); check(stat);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    identity(before, walk(parent)); identity(stat, fs.lstatSync(file)); check(fs.fstatSync(fd));
    syncDirectory(fs.realpathSync(parent));
    identity(before, walk(parent));
  } finally { fs.closeSync(fd); }
}
function receipt(options, keyFile) { return { storeId: options.storeId, keyId: options.keyId, keyFile }; }
export function createStoreKey(options) {
  const keyFile = location(options, true);
  const key = randomBytes(32);
  try { writePrivate(keyFile, key); return receipt(options, keyFile); } finally { key.fill(0); }
}
export function readStoreKey(options) {
  const key = readPrivate(location(options), 32);
  if (key.length !== 32) { key.fill(0); fail(); }
  return key;
}
export function exportStoreKey(options, destination) {
  destination = absolute(destination);
  if (inside(canonical(absolute(options.home)), canonical(destination))) fail();
  const key = readStoreKey(options);
  let serialized;
  try {
    // Buffer contents can be wiped; immutable JS JSON/base64 strings cannot.
    serialized = Buffer.from(`${JSON.stringify({ version: 1, storeId: options.storeId, keyId: options.keyId, base64key: key.toString('base64') })}\n`);
    writePrivate(destination, serialized);
    return { storeId: options.storeId, keyId: options.keyId, destination };
  } finally { serialized?.fill(0); key.fill(0); }
}
export function importStoreKey(options, recoveryFile) {
  // Validate all destination constraints before reading any recovery material.
  location(options, 'validate');
  const bytes = readPrivate(recoveryFile, 1024);
  let record;
  try { record = JSON.parse(bytes.toString('utf8')); } catch { fail(); } finally { bytes.fill(0); }
  if (!record || Array.isArray(record) || Object.keys(record).sort().join(',') !== 'base64key,keyId,storeId,version' || record.version !== 1 || record.storeId !== options.storeId || record.keyId !== options.keyId || typeof record.base64key !== 'string') fail();
  const key = Buffer.from(record.base64key, 'base64');
  try {
    if (key.length !== 32 || key.toString('base64') !== record.base64key) fail();
    const keyFile = location(options, true);
    writePrivate(keyFile, key); return receipt(options, keyFile);
  } finally { key.fill(0); }
}
