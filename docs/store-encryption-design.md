# Optional store encryption: design draft

Status: next-version design, not implemented. Baseline: v0.16.0.

## User requirement

An administrator can enable or disable encryption. The transition must migrate
existing data, not only change future writes. A failed or interrupted transition
must preserve a recoverable store. The current release remains unchanged.

## Confirmed scope

The evaluated options have different storage architectures:

| Scope | Protection | Consequence |
| --- | --- | --- |
| Whole store | Version content, attachments, metadata, comments, and search data | Requires an encrypted database implementation as well as encrypted version files; native package and operating-system compatibility need validation. |
| Content first | Version content and attachments | SQLite metadata remains plaintext. Body search indexes and persisted embeddings must not retain unencrypted content or derived data. The UI must disclose these limits. |

The user selected whole-store protection: content, attachments, metadata, comments,
and search data. Content-only protection is rejected for this version. The current
`node:sqlite` integration is not an encryption switch. Do not treat an ignored
`PRAGMA key` as proof of encryption.

## Threat model

Protect copied data files and backups against disclosure when the attacker does
not also hold the encryption key. This does not replace authorization, TLS, or
host security. An attacker controlling the running server can access plaintext
and usually its keys. Do not claim end-to-end encryption.

Artifact IDs currently include title slugs. File and directory names must also
avoid leaking titles, even when their contents are encrypted. Preserve public IDs
in the encrypted database and use opaque physical paths.

Record coverage explicitly for version blobs, bundle assets, SQLite main/WAL/
journal files, full-text indexes, embeddings, comments, audit data, temporary
files, exports, upgrade snapshots, and external embedding providers. Historical
plaintext copies, filesystem snapshots, SSD remnants, and operator-created
exports are not automatically erased by enabling encryption.

## Existing boundaries

- `src/lib/storage.js`: version writes currently write a temporary UTF-8 file
  before rename. Encrypt before creating a disk file, not after.
- The same module reads version files for normal reads, updates, integrity,
  repair, deletion, and index rebuild. All paths need a shared storage codec.
- FTS persists body content; embeddings persist derived vectors. A body-only
  file codec does not protect these copies.
- `src/lib/backup.js`: JSON export/import reads and writes version files directly.
- `src/lib/upgrade-backup.js`: snapshot integrity compares on-disk file hashes
  and sizes to database records. Physical ciphertext integrity must be distinct
  from logical plaintext content integrity.
- HTTP, CLI, MCP, retention, and background work can share a store. A lock in a
  single JavaScript process is insufficient.

## Migration contract

1. Authorize the administrator and require explicit confirmation of the target
   state. Never attach this operation to an auto-save preference.
2. Check version compatibility, key availability, free space, backup destination,
   and all active writers. Refuse the transition if exclusive access cannot be
   established. Older binaries must refuse to open a migrated store.
3. Produce and verify recovery material. Record whether the recovery copy is
   plaintext or encrypted; do not silently leave an unprotected backup while
   reporting that all data is encrypted.
4. Acquire a store-wide maintenance lock with owner identity and recovery rules.
   Coordinate all database connections and readers before switching generations.
5. Write a durable migration journal without secrets. Build a separate target
   generation; never rewrite the only valid source in place.
6. Verify authentication tags, plaintext hashes, references, database integrity,
   and derived indexes. Sync files and directory metadata before the switch.
7. Commit the active generation atomically. Keep enough state to finish or roll
   back after a crash at each boundary. Do not release the lock while the active
   database and version directory refer to different generations.
8. Report completion only after a fresh reader can open the target generation.
   Retain or remove the old generation according to an explicit recovery policy.
   Cleanup failure must be visible, not silently treated as full completion.

Disabling encryption follows the same process in reverse. Key rotation is a
separate operation and must not be simulated by disabling and re-enabling.

## Key contract

Use a dedicated artifact/store key, never the SMTP key. Generate keys through a
cryptographic random source. Keep recovery material separate from ciphertext
backups, with restrictive permissions and symlink checks. Wrong, missing, or
corrupt keys must fail closed and must never trigger key regeneration over an
existing encrypted store. Recovery on another machine is a required test.

For version-file encryption, evaluate authenticated encryption with fresh
nonces and authenticated store/artifact/version/key identifiers. Do not expose
unauthenticated plaintext before verification. Database encryption must use a
reviewed implementation, not a home-built SQLite page cipher.

## Release gates

- Plaintext and encrypted modes pass HTTP, CLI, MCP, renderer, integrity,
  backup/restore, retention, and upgrade tests.
- Forced termination before and after every migration checkpoint is recoverable.
- Concurrent and stale processes cannot write during migration or reopen the old
  generation after the switch.
- Key loss, wrong keys, tampering, version substitution, and truncated files
  produce explicit errors without plaintext fallback.
- Canary content is absent from protected files, temporary files, indexes,
  backups, and logs. Test both successful and interrupted migrations.
- Binary/base64 artifacts and bundles round-trip byte-for-byte.
- Node 22/24 and Linux/macOS/Windows installation and recovery are verified.
- UI states show preflight, maintenance, progress, failure/recovery, and completed
  state. Screenshot review is required before deploying the administrator UI.

## References

- [Node SQLite API](https://nodejs.org/api/sqlite.html)
- [SQLCipher design](https://www.zetetic.net/sqlcipher/design/)

The next-version branch pins the optional database dependency below. The
production storage path does not use it yet.

## Candidate and first feasibility result

Candidate: `better-sqlite3-multiple-ciphers@13.0.3`, using SQLite3 Multiple
Ciphers with its ChaCha20-Poly1305 page cipher. This is not the official Zetetic
SQLCipher distribution. Keep the dependency optional so plaintext stores can
still use `node:sqlite`; encrypted stores must fail explicitly if the driver is
unavailable, never fall back to an unencrypted database.

Every encrypted handle must set `temp_store=MEMORY` because SQLite3 Multiple
Ciphers does not encrypt TEMP tables. Map the existing `readOnly` option to the
candidate's `readonly`. Use Buffer-based keys rather than constructing SQL with
key text. Normalize error messages without logging SQL or key material.

A macOS ARM64 / Node 26 feasibility probe on a disposable store passed:

- Insert metadata and comments, then query body data through FTS5.
- Check DB and live WAL files for a unique plaintext canary.
- Create a `VACUUM INTO` snapshot, confirm it remains encrypted, and reopen it
  with the correct key.
- Reject a wrong key.
- Convert a disposable copy back to plaintext and read it with `node:sqlite`.

This is feasibility evidence, not a production security certification or a
migration implementation. Node 22/24 and Linux/Windows execution still need
separate verification, as do kill-point recovery and legacy-process exclusion.

Primary sources:

- [Candidate API and release](https://github.com/m4heshd/better-sqlite3-multiple-ciphers)
- [ChaCha20 cipher](https://utelle.github.io/SQLite3MultipleCiphers/docs/ciphers/cipher_chacha20/)
- [Engine limitations, including temporary tables](https://utelle.github.io/SQLite3MultipleCiphers/)

## Implementation sequence

Foundation checkpoint: the isolated database adapter and authenticated file
codec pass 12 tests with the native driver loaded. The full local suite passes
588 tests. These modules are not connected to production storage. The dedicated
CI matrix must load the native driver explicitly so a missing optional package
cannot produce a misleading pass through skipped tests.

Cross-platform checkpoint (commit `acacaff`): Linux and macOS with Node 22/24,
and Windows with Node 24 pass all foundation tests. Windows with Node 22 fails
installation: npm 10.9.9 runs an implicit `node-gyp rebuild` for the optional
driver, despite its published `gypfile: false`, then removes the failed package.
This remains a release blocker, not a skipped compatibility test. The behavior
matches [npm CLI issue 9837](https://github.com/npm/cli/issues/9837). Do not hide
the failure by upgrading only the CI installer. A durable package-level fix or
an explicitly supported installation strategy must also work for consumers.

Packaging fix under verification: vendor the exact 13.0.3 tarball with only an
explicit no-op install script added. This prevents implicit rebuild inference
without downgrading SQLite or changing cryptographic code. Original integrity,
per-file comparisons, and reproduction instructions are retained in
`vendor/encrypted-sqlite/`. Bundle the driver in the Artifacty package because
consumer installs cannot reliably resolve a nested local tarball dependency.
Verify both normal installation and the updater's `--ignore-scripts` path from
an actual packed Artifacty archive, with the platform's default npm version.

The earlier Windows Node 24 fixture cleanup failure was fixed by closing SQLite
handles before removing temporary directories; that platform now passes.

The database adapter accepts trusted application SQL only. Integration must
control ATTACH, cipher pragmas, and snapshot destinations, and enforce private
file permissions and symlink checks before opening database paths.

1. Verify an isolated encrypted-DB adapter, including real files, wrong-key and
   tamper failures, snapshots, and FTS. Keep it disconnected from production
   store opening until the remaining layers are ready.
2. Introduce one version-file codec and opaque physical paths. Route normal
   reads, integrity, repair, export/import, and snapshots through that boundary.
3. Add durable key metadata, process admission/maintenance locking, and explicit
   compatibility refusal for older storage generations.
4. Implement offline generation migration in both directions with crash-point
   tests. Validate the complete store before exposing the admin operation.
5. Implement administrator preflight, confirmation, progress and recovery UI;
   document key recovery and plaintext export separately. Review screenshots.
6. Run the full cross-platform matrix and recovery tests before releasing.
