# Upgrade Snapshots and Recovery

Artifacty creates a local snapshot before it migrates an existing store to a newer schema. This snapshot is mandatory. If snapshot creation or verification fails, Artifacty stops before migration.

Use upgrade snapshots to recover the original store state. Use `artifacty backup` and `artifacty export` for portable JSON backups and store transfers. These are separate backup systems. `artifacty restore <id>` restores an archived artifact; it does not restore a store snapshot.

## When Artifacty Creates a Snapshot

- **Schema migration:** Artifacty always snapshots an existing store before migration. This includes a legacy `index.json` store. A new empty store needs no snapshot.
- **Application update:** Set `ARTIFACTY_BACKUP_ON_UPDATE=true` to also snapshot an existing store when the application version changes. This setting is off by default.
- **Unknown application version:** With the update setting enabled, the first open of an existing store without an application-version marker creates a baseline snapshot. Its source application version is unknown. Later opens with the same version do not repeat it.
- **Restore:** Before replacing a store, Artifacty creates and verifies a recovery snapshot of its current state.

Stop every HTTP server and MCP process that uses the store before an upgrade or restore. This includes services, foreground servers, and local stdio MCP clients. Artifacty checks managed server PID markers, but these markers cannot identify every process with an open store.

Snapshots are stored at `ARTIFACTY_HOME/upgrade-backups/<id>/`. The default home is `~/.artifacty`.

## Snapshot Contents

Each snapshot contains a manifest with file sizes and SHA-256 hashes. It also contains:

- A consistent raw SQLite database, including all tables and security state.
- Every version file referenced by the database or an authoritative legacy index.
- The legacy `index.json`, if it exists.

Verification checks the file hashes, SQLite integrity, and version-file references. Snapshots do not include unrelated files, process markers, logs, or the complete installation directory. Keep snapshots private: they contain credentials and security records.

`ARTIFACTY_UPGRADE_BACKUP_KEEP` controls automatic snapshot retention. The default is `3`; valid values are integers from `1` through `1000`. Artifacty prunes older automatic schema/update snapshots after a successful upgrade. It does not prune manual or recovery snapshots with this setting.

## Inspect Snapshots

List snapshots without opening or migrating the store:

```bash
artifacty backups list --home /path/to/store
```

Copy an `id` from the output. Verify that snapshot:

```bash
artifacty backups verify <id> --home /path/to/store
```

A successful response includes `valid: true`. Listing checks manifests; it does not replace full verification. From a repository checkout, use `node src/cli.js` in place of `artifacty`.

## Restore a Snapshot

A restore replaces the current database, version files, and legacy index. Changes made after the snapshot are no longer current. Artifacty keeps the pre-restore state in a separate recovery snapshot.

**Security state also rolls back.** Old passwords, permissions, network rules, sessions, API tokens, and share-link records can become current again. A session, token, or link revoked after the snapshot can become valid again if it has not expired. Review the restored security state before allowing users to reconnect.

1. Stop all server, service, and MCP processes that use this store.
2. Select a snapshot from `backups list`.
3. Verify it with `backups verify`.
4. Restore it with explicit confirmation:

```bash
artifacty backups restore <id> --confirm restore-store --home /path/to/store
```

5. Save the returned `recoveryBackupId`.
6. Review the restored security settings before reconnecting clients.

Restore does not migrate the selected snapshot. Opening it with the current application can trigger another protected migration. A build that does not support the restored schema rejects the store.

## Recover When the Current Store Is Corrupt

If Artifacty cannot verify the current store for its recovery snapshot, it returns `RECOVERY_BACKUP_FAILED`. It does not overwrite the damaged store.

1. Keep the damaged home and its snapshots unchanged.
2. Create a new empty home directory.
3. Copy the selected snapshot directory into the new home's `upgrade-backups/` directory. Preserve its original snapshot ID and directory contents.
4. Run `backups verify <id> --home /path/to/new-home`.
5. Run `backups restore <id> --confirm restore-store --home /path/to/new-home`.
6. Review the restored data and security settings before using the new home.

Do not copy the damaged database over the new home. The selected snapshot supplies the database and referenced version files.

## Recover an Interrupted Restore

If a `.restore-<uuid>` directory remains, Artifacty stops with `RESTORE_INCOMPLETE`.

1. Preserve that directory and the entire affected home.
2. Read `.restore-<uuid>/restore.json`.
3. Find its `recoveryBackupId`. This identifies the snapshot of the state before the interrupted restore.
4. Copy that recovery snapshot into a new empty home's `upgrade-backups/` directory.
5. Verify and restore it there with the commands above.

Do not remove the interrupted restore directory to bypass the check. It contains recovery evidence and can contain the previous database and files.
