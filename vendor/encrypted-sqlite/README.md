# Encrypted SQLite packaging workaround

This directory contains the upstream `better-sqlite3-multiple-ciphers@13.0.3`
package with exactly one semantic metadata change: `package.json` gains
`"scripts": { "install": "node -e \"\"" }` alongside its existing scripts.
This prevents npm 10 from inferring `node-gyp rebuild` during a clean install
when its lockfile metadata loses the upstream `gypfile: false` declaration.
See [npm/cli#9837](https://github.com/npm/cli/issues/9837).

No JavaScript implementation, crypto source, SQLite source, license, or native
binary is modified. All eight platform prebuilds remain in the archive, so
installation with `--ignore-scripts` also retains them. The no-op never builds
or downloads anything. Runtime compatibility is still tested separately.

Reproduce from the repository root with Node 22 or newer:

```sh
node scripts/vendor-encrypted-sqlite.mjs
```

The script downloads the exact registry URL and verifies the SHA512 pinned from
the original registry lockfile before processing anything. An optional argument
can supply an already downloaded upstream tarball for offline reproduction:

```sh
node scripts/vendor-encrypted-sqlite.mjs /path/to/original-upstream.tgz
```

A changed upstream checksum fails before output files are written. The script
checks that every unpacked path remains present, every other tar entry remains
byte-identical, and the parsed package metadata differs only by the new install
script. It reproduces the archive twice and compares bytes before writing.
`provenance.json` includes both archive integrities and per-file SHA256 hashes.
`LICENSE.upstream` is copied verbatim from the original package.

The archive uses gzip level nine and a zero gzip timestamp. Repeated generation
in the same Node/zlib environment must produce identical archive bytes. Different
zlib versions may produce different compressed bytes; the uncompressed tar
SHA256 and all per-file SHA256 hashes in `provenance.json` pin the content
independently. The manifest records the generator Node/zlib versions and gzip
settings. Original tar metadata is preserved except package.json size/checksum;
no current timestamps are added. Files are inspected in memory, never extracted
to disk. No tar executable or additional dependency is required.

This workaround is temporary. Replace it with a verified upstream packaging fix
when one exists, retaining the supported Node/npm clean-install matrix. Do not
modify upstream cryptographic code or binaries as part of this workaround.

## Read-only verification

```sh
node scripts/vendor-encrypted-sqlite.mjs --check
node scripts/vendor-encrypted-sqlite.mjs --check /path/to/original-upstream.tgz
```

Check mode never writes files. It verifies the pinned upstream archive, compares
checked-in and expected decompressed tar bytes, validates the provenance's source
and patched hashes, file map and generator metadata, and compares the original
license verbatim. Compressed bytes may differ across zlib versions; the recorded
patched integrity is checked against the actual checked-in bytes, not the local
recompression. Extra arguments and unknown options are rejected.
