# Backup, restore, and upgrades

A RowWeave workspace includes its tables, field definitions, records, versions, saved views, relation edges, and lookup definitions in one SQLite database. Use the workspace-file command to make a consistent snapshot, including committed data still in the write-ahead log (WAL). CSV is data exchange, not a complete workspace backup.

## Create a backup

Build the source once with `npm ci` and `npm run build`, then run:

```sh
npm run workspace:file -- backup /path/to/workspace.sqlite /path/to/backups/workspace-2026-11-12.sqlite
```

Replace paths with absolute paths on your machine and quote paths containing spaces. The source must exist, the destination must not exist, and the destination's parent directory must already exist. The service or desktop may remain open. This command runs in a separate Node process; it does not put database work in the desktop's main or renderer process.

The command uses [Node's SQLite online backup API](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html#sqlitebackupsourceDb-path-options) with a read-only source connection. It checks the snapshot's SQLite integrity and foreign keys, converts the snapshot to a self-contained journal mode, then copies it to the new destination without replacing an existing file. Temporary work is confined to a newly created directory beside the destination. The source schema is not upgraded during backup.

On success, exit code 0 and a JSON result identify the completed file, database format version, and byte size. For automation without npm's script banners, invoke `node /path/to/rowweave/dist/apps/server/src/workspace-file.js backup SOURCE DESTINATION` directly. Failure exits 1 with a JSON error on stderr and no success output. `--help` describes usage without opening a database.

Treat only a successful completed result as a backup. The final filesystem copy is not crash-atomic: a forced process termination or power failure during publication can leave an incomplete destination. If a command was interrupted, keep that file separate and repeat to another new path. Restore performs integrity checking before publishing a usable copy. An existing destination is never replaced, even when the command fails. A missing source is never initialized as an empty workspace.

Frequent writes from another connection can restart SQLite's snapshot copy. If a heavily written workspace prevents completion, briefly stop writes and retry the read-only backup operation. Do not copy the main `.sqlite` file directly while its service is running; committed data can remain in `-wal`. The completed snapshot does not need the source's `-wal` or `-shm` files.

Choose your own retention schedule and storage location; RowWeave does not delete old backups. Backups contain the workspace's data in ordinary SQLite form. Desktop connection settings and access tokens are not stored in the workspace database.

## Restore to a new workspace

```sh
npm run workspace:file -- restore /path/to/backups/workspace-2026-11-12.sqlite /path/to/restored/workspace.sqlite
```

The destination must be a new path in an existing directory. Restore checks a copy of the snapshot and applies the current migrations to that copy before publishing it. It preserves stable identities, record/schema versions, values, and existing views. Older formats receive the metadata added by their migrations, such as an initial grid view. The original snapshot remains unchanged; a failed migration or unsupported newer format does not publish a destination.

After a successful restore:

1. Stop the currently running service or close the desktop. Keep its old workspace for rollback.
2. For a standalone service, set `ROWWEAVE_DB` to the new restored file and start the service with its normal connection configuration. Do not open that file from another service at the same time.
3. For the desktop's bundled local service, restore to `prototype.sqlite` inside a new directory, then set `ROWWEAVE_DATA_DIR` to that directory before launching RowWeave. This selects an isolated desktop profile and workspace. The historical filename is required by the bundled service; it does not imply demo content.
4. Open the workspace, verify table/record counts, inspect saved views and linked records, and make a small save/restart check. Keep the original backup and old workspace until you accept the restored data.

For example, on PowerShell, after restoring into a new local-workspace directory:

```powershell
$env:ROWWEAVE_DATA_DIR = 'C:\RowWeave\RestoredWorkspace'
& 'C:\Program Files\RowWeave\rowweave.exe'
```

Use your actual paths. Do not rename or overwrite a live database, and do not mix journal sidecars from the old workspace with the restored file. Restoring to a fresh directory avoids that ambiguity. Remote clients need no local database copy; they reconnect to the independently operated service after its workspace switch.

## Upgrade and rollback

Create a completed backup before upgrading RowWeave. Starting the new service opens and migrates a supported older database transactionally. The current format is 26; versions 1–25 are upgraded while retaining the data, and a newer unsupported format is rejected. Format 20 introduced URL field semantics; format 21 added persistent per-field automatic-number counters, format 22 added automatic timestamp fields using existing values and history, and format 23 added attachment metadata and file bytes, and format 24 added retention for files saved in records and their history, and format 25 gates typed date calculations, and format 26 adds array formulas and recalculation after reciprocal edits. These migrations do not rewrite existing records or identities. Field descriptions remain in the stored field definitions. Durable record history, trash, saved-operation receipts, automatic values, sequence counters and uploaded file bytes are included in the same snapshot; no external attachment directory is needed. Stop the old service before starting the new version against the same database.

To roll back an application upgrade, stop the new version and run the old version against a separate copy of the pre-upgrade backup. Do not ask an older application to open a database already upgraded by a newer one. The restore command migrates to its own application version; use the matching older tool for an older application. Changes made after the backup are not part of rollback.

## Verification

Regression tests back up an open workspace with committed WAL data, restore schema/records/views/relations/lookups, and verify that later writes to either workspace remain independent. They restore a version-one snapshot, preserve original backup bytes, and reject existing destinations, missing/corrupt inputs, referential corruption, unsupported versions, and failed migrations without publishing a completed result. A real subprocess test exercises the command, paths with spaces, JSON output, and error exit codes. All tests use temporary workspaces.
