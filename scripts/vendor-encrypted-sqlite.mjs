// Reproduce a packaging-only workaround; never rebuild or alter native binaries.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const sourceUrl = 'https://registry.npmjs.org/better-sqlite3-multiple-ciphers/-/better-sqlite3-multiple-ciphers-13.0.3.tgz';
// Copied from the project's original registry lock entry, before local vendoring.
const sourceIntegrity = 'sha512-UYabM82r1J84TLWc/SszoHs6XopWpl/2HCg3Nui1JUaFXg/VLswzkPowYiRhK/4CftI8dgtikwyZQecMldrGxQ==';
const directory = new URL('../vendor/encrypted-sqlite/', import.meta.url);
const output = new URL('better-sqlite3-multiple-ciphers-13.0.3.tgz', directory);
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const integrity = (bytes) => `sha512-${digest(bytes, 'sha512', 'base64')}`;

function entries(tar) {
  const result = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert.ok(tar.subarray(offset).every((byte) => byte === 0), 'Unexpected data after tar terminator');
      return result;
    }
    const string = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
    const name = string(0, 100);
    const prefix = string(345, 155);
    assert.equal(prefix, '', 'Unexpected tar prefix; inspect upstream format');
    assert.ok(name.startsWith('package/') && !name.split('/').includes('..'), 'Unsafe tar path');
    assert.ok(!result.some((entry) => entry.name === name), 'Duplicate tar entry');
    assert.ok(header[156] === 0 || header[156] === 48, 'Only regular files are expected');
    const size = Number.parseInt(string(124, 12).trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'Invalid tar size');
    const checksum = Number.parseInt(string(148, 8).trim(), 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.equal(actual, checksum, 'Invalid tar checksum');
    const end = offset + 512 + Math.ceil(size / 512) * 512;
    result.push({ name, header, content: tar.subarray(offset + 512, offset + 512 + size), raw: tar.subarray(offset, end) });
    offset = end;
  }
  throw new Error('Missing tar terminator');
}

function patch(source) {
  const before = entries(gunzipSync(source));
  const packageEntry = before.find((entry) => entry.name === 'package/package.json');
  assert.ok(packageEntry, 'Missing package.json');
  const original = JSON.parse(packageEntry.content);
  assert.equal(original.name, 'better-sqlite3-multiple-ciphers');
  assert.equal(original.version, '13.0.3');
  assert.equal(original.scripts.install, undefined);
  const modified = structuredClone(original);
  modified.scripts.install = 'node -e ""';
  const content = Buffer.from(`${JSON.stringify(modified, null, 2)}\n`);
  const header = Buffer.from(packageEntry.header);
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const tar = Buffer.concat([...before.map((entry) => entry === packageEntry
    ? Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)])
    : entry.raw), Buffer.alloc(1024)]);
  // Reproducible within the recorded Node/zlib environment. The uncompressed
  // tar digest pins content across compression-library versions.
  const archive = gzipSync(tar, { level: 9 });
  assert.equal(archive.readUInt32LE(4), 0, 'Gzip timestamp must be zero');
  const after = entries(gunzipSync(archive));
  assert.deepEqual(after.map((entry) => entry.name), before.map((entry) => entry.name));
  const reverted = JSON.parse(after.find((entry) => entry.name === 'package/package.json').content);
  delete reverted.scripts.install;
  assert.deepEqual(reverted, original, 'Unexpected package metadata modification');
  const files = before.map((entry, index) => {
    const patched = after[index];
    if (entry !== packageEntry) assert.ok(entry.raw.equals(patched.raw), `Changed upstream file: ${entry.name}`);
    return { path: entry.name, upstreamSha256: digest(entry.content), patchedSha256: digest(patched.content) };
  });
  return { archive, tarSha256: digest(tar), files, license: before.find((entry) => entry.name === 'package/LICENSE')?.content };
}

const args = process.argv.slice(2);
const checkOnly = args[0] === '--check';
if (checkOnly) args.shift();
assert.ok(args.length <= 1 && !args.some((arg) => arg.startsWith('-')), 'Usage: node scripts/vendor-encrypted-sqlite.mjs [--check] [original.tgz]');
const localSource = args[0];
let source;
if (localSource) source = await readFile(localSource);
else {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Upstream download failed: HTTP ${response.status}`);
  source = Buffer.from(await response.arrayBuffer());
}
assert.equal(integrity(source), sourceIntegrity, 'Pinned upstream integrity mismatch');
const result = patch(source);
assert.ok(result.archive.equals(patch(source).archive), 'Repack is not reproducible');
assert.ok(result.license, 'Missing upstream license');
const manifest = {
  package: 'better-sqlite3-multiple-ciphers', version: '13.0.3', sourceUrl, sourceIntegrity,
  patchedIntegrity: integrity(result.archive), patchedSha256: digest(result.archive), sizeBytes: result.archive.length,
  uncompressedTarSha256: result.tarSha256,
  generator: { node: process.versions.node, zlib: process.versions.zlib, gzipLevel: 9, gzipMtime: 0 },
  patch: { file: 'package/package.json', operation: 'Add scripts.install', value: 'node -e ""' },
  verification: 'Every unpacked path is unchanged; every non-package.json tar entry and file SHA256 is identical. package.json differs semantically only by scripts.install.',
  files: result.files,
};
if (checkOnly) {
  const current = await readFile(output);
  const recorded = JSON.parse(await readFile(new URL('provenance.json', directory), 'utf8'));
  assert.ok(gunzipSync(current).equals(gunzipSync(result.archive)), 'Vendored tar content differs from expected patch');
  assert.equal(current.readUInt32LE(4), 0, 'Vendored gzip timestamp must be zero');
  for (const key of ['package', 'version', 'sourceUrl', 'sourceIntegrity', 'uncompressedTarSha256', 'patch', 'verification', 'files']) {
    assert.deepEqual(recorded[key], manifest[key], `Provenance mismatch: ${key}`);
  }
  assert.equal(recorded.patchedIntegrity, integrity(current), 'Vendored integrity mismatch');
  assert.equal(recorded.patchedSha256, digest(current), 'Vendored SHA256 mismatch');
  assert.equal(recorded.sizeBytes, current.length, 'Vendored size mismatch');
  assert.equal(recorded.generator?.gzipLevel, 9, 'Unexpected recorded gzip level');
  assert.equal(recorded.generator?.gzipMtime, 0, 'Unexpected recorded gzip timestamp');
  for (const key of ['node', 'zlib']) assert.ok(typeof recorded.generator?.[key] === 'string' && recorded.generator[key].length > 0, `Missing generator ${key}`);
  assert.ok((await readFile(new URL('LICENSE.upstream', directory))).equals(result.license), 'Upstream license mismatch');
  console.log('Verified vendored archive, provenance, all file hashes, and upstream license (no writes).');
} else {
  await mkdir(directory, { recursive: true });
  await writeFile(output, result.archive);
  await writeFile(new URL('provenance.json', directory), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(new URL('LICENSE.upstream', directory), result.license);
  console.log(JSON.stringify({ path: fileURLToPath(output), sizeBytes: manifest.sizeBytes, integrity: manifest.patchedIntegrity, sha256: manifest.patchedSha256, unchangedFiles: result.files.length - 1 }, null, 2));
}
