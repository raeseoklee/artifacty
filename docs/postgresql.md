# PostgreSQL storage

English | [한국어](ko/postgresql.md)

PostgreSQL support is an unreleased repository change. It is not included in npm version 0.17.0. Use a build containing this feature before following this guide.

SQLite remains the default. Set `ARTIFACTY_DATABASE_URL` to select PostgreSQL explicitly. Artifacty does not fall back to SQLite when the configured PostgreSQL server is unavailable or rejects a connection.

## What PostgreSQL stores

PostgreSQL holds artifact metadata, version records, users, permissions, categories, comments, settings, audit history, and embedding vectors. Artifact bodies and attachments remain immutable files under `ARTIFACTY_HOME`. A database backup alone does not contain those files.

Use one Artifacty server with one store directory. Point MCP clients at that server. PostgreSQL support does not make separate application hosts with independent artifact directories safe. The private `.postgres-store-id` file binds the directory to the database schema; preserve it when moving an existing installation.

## Configure a connection

Install dependencies with optional packages enabled. The `pg` driver is optional for SQLite installations, but required for PostgreSQL. Installations made with `--omit=optional` cannot use this backend until the driver is installed.

Create a dedicated database and a login role that can create and manage Artifacty's schema. Do not use a PostgreSQL superuser for the application. Keep the connection URL in a private environment file or your deployment's secret manager; do not commit it, put it in shared logs, or paste a production password into documentation examples.

For a disposable local database, the configuration has this form:

```sh
export ARTIFACTY_HOME="$HOME/.artifacty-postgres"
export ARTIFACTY_DATABASE_URL='postgresql://artifacty:example-password@127.0.0.1:5432/artifacty'
export ARTIFACTY_DATABASE_SCHEMA='artifacty'
export ARTIFACTY_DATABASE_TIMEOUT_MS='15000'
artifacty serve
```

`example-password` is a placeholder, not a supplied credential. Percent-encode reserved characters in a real URL password. Configure TLS for remote database connections using the PostgreSQL connection parameters supported by `pg`; do not disable certificate verification to make a connection succeed. The [node-postgres SSL guide](https://node-postgres.com/features/ssl) explains certificate configuration.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARTIFACTY_DATABASE_URL` | Unset | A `postgres://` or `postgresql://` URL identifying a database. An unset or empty value selects SQLite. |
| `ARTIFACTY_DATABASE_SCHEMA` | `artifacty` | Dedicated schema: a lowercase letter followed by lowercase letters, digits, or underscores; at most 63 characters. `public`, `information_schema`, and names beginning with `pg_` are rejected. |
| `ARTIFACTY_DATABASE_TIMEOUT_MS` | `15000` | Connection/query wait limit, an integer from 1000 to 120000 milliseconds. |

Set the same backend variables for every CLI, server, or direct stdio MCP process that accesses this store. A shell without the database URL cannot open a home already bound to PostgreSQL. Artifacty rejects that configuration instead of creating a separate SQLite store. Use a fresh directory when changing database backends. Prefer HTTP MCP for clients that should use the central server's configuration.

The server initializes a fresh schema on first use. Changing the URL does not move an existing SQLite database into PostgreSQL. Do not point a production configuration at an empty destination and assume its users or artifacts were migrated.

## Search and concurrency

PostgreSQL text search uses the backend's substring search path. It does not use SQLite FTS5 and is not advertised as PostgreSQL full-text search. Semantic ranking continues to use Artifacty's configured embedding provider and stored vectors. A database change does not select a new embedding model automatically.

Write transactions use a schema-scoped PostgreSQL advisory lock to preserve the serialized mutation behavior expected by the existing storage services. This first backend keeps the synchronous application storage interface; a remote database's latency can therefore affect request latency. It is not a promise of higher throughput or multi-host deployment.

## Migrate an existing SQLite store

Stop the source server and all direct writers. Preserve a verified backup of the source before exporting. Use a new PostgreSQL schema and an empty destination directory; these commands replace the destination's contents.

```sh
# Export the existing SQLite store, even if this shell normally selects PostgreSQL.
ARTIFACTY_DATABASE_URL='' artifacty export \
  --home "$HOME/.artifacty" \
  --file "$HOME/artifacty-migration.json" --full

# Set ARTIFACTY_DATABASE_URL privately to the destination PostgreSQL database first.
export ARTIFACTY_DATABASE_SCHEMA='artifacty_migration'
artifacty import-store --home "$HOME/.artifacty-postgres" \
  --file "$HOME/artifacty-migration.json" --confirm replace-all
artifacty integrity --home "$HOME/.artifacty-postgres"
```

The import creates the destination's version files as well as database records. Full-scope import requires `--confirm replace-all` and rejects a destination that already has users unless explicitly forced; do not add `--force-users` to a normal migration into an empty destination. Source export does not switch or delete the original store.

Confirm that integrity reports `ok: true`, then start the destination server with the same PostgreSQL variables and destination home. `/health` reports `databaseBackend: "postgres"`; it does not expose the connection URL. Compare users, categories, comments, artifact counts, and representative content before directing clients to the new server. Keep the original stopped until that check succeeds. Reverse migration uses the same full JSON format: export while PostgreSQL is selected, then import into an empty SQLite home with `ARTIFACTY_DATABASE_URL=''`.

The full JSON format does not include every local operational secret. Preserve local secret files separately, including `secrets/smtp.key` if SMTP is configured. Existing backup rules still apply: imported sessions are invalidated and some integrations require reconfiguration. Keep the migration JSON private and remove it according to your backup-retention policy after recovery has been verified.

## Back up, move, and update

Stop the server and all writers before taking a coordinated operational backup. Use your PostgreSQL tools, such as `pg_dump`, to back up the database, and back up the complete private Artifacty directory at the same stopped state. Include the artifact files, `.postgres-store-id`, and any local secret files. Store backups privately and test recovery into an isolated destination.

For a host move, restore the database and matching Artifacty directory together. Keep the old installation stopped while verifying artifact counts, version integrity, sign-in, permissions, and representative artifact content on the destination. A successful database connection does not prove that the version files are present.

The `artifacty backups` physical snapshot commands are SQLite-only. PostgreSQL installations reject them rather than producing an incomplete snapshot. Automatic CLI and administrator server updates are also unsupported for PostgreSQL; update checks report the limitation. Verify a database-and-files backup and follow a manual package update process instead.

A schema written by a newer Artifacty build must not be opened by an older build. Existing PostgreSQL schemas requiring a structural upgrade need an explicit supported migration procedure; do not bypass the guard by changing version metadata. SQLite's automatic pre-upgrade snapshot does not protect PostgreSQL.

Artifacty's logical JSON export/import is a separate format from physical snapshots and supports cross-backend migration as described above. Full backups contain account and security data and must be handled as secrets. See [upgrade snapshots and recovery](upgrade-backups.md) for the SQLite-specific workflow and [the README backup reference](../README.md) for logical backup commands.
