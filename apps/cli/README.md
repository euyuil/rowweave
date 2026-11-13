# RowWeave CLI

The `rowweave` command manages schemas, records, saved views, and CSV exchange through the same authenticated HTTP service as the desktop and SDK. It requires Node.js 24.22.1 or later in the 24.x line and has no runtime package dependencies.

## Build and install

From the repository root:

```sh
npm ci
npm run package:cli
```

This creates `release/cli/rowweave-cli-0.1.0.tgz`. Install that archive in another project with `npm install ./rowweave-cli-0.1.0.tgz`, then use `npm exec --offline -- rowweave --help`. To install the command on your own PATH, use `npm install --global ./rowweave-cli-0.1.0.tgz`. No registry publication is required or performed.

For source development, run `npm run build`, then `node dist/apps/cli/src/main.js --help` from the repository root. Use the installed command or direct Node invocation for machine-readable output; npm script banners are not part of the CLI protocol.

## Connection and input

Set `ROWWEAVE_TOKEN` in the calling process's environment. Set `ROWWEAVE_URL`, or pass `--url`, for a service other than `http://127.0.0.1:4317`. Supply a token from your configured service; do not put credentials in command arguments or URLs. The command requires no connection for `--help`.

Every mutation takes the same JSON request as the [HTTP API](https://github.com/euyuil/rowweave/blob/main/docs/http-api.md). Use `--input request.json`, `--input -` for stdin, or `--json` for a small literal. `--input` and `--json` are exclusive. Files/stdin must be UTF-8; JSON is limited to 8 MiB. Passing JSON through files or stdin avoids differences between shell quoting rules.

Examples below assume `rowweave` is on PATH and the connection environment is configured. Replace the displayed IDs with IDs returned by previous commands.

```sh
rowweave tables list
rowweave tables create --input create-table.json
rowweave tables get TABLE_ID
rowweave fields create TABLE_ID --input create-field.json
rowweave records create TABLE_ID --input records.json
rowweave records query TABLE_ID --input query.json
rowweave records update TABLE_ID --input updates.json
rowweave records history TABLE_ID RECORD_ID
rowweave records change TABLE_ID RECORD_ID --input change.json
rowweave records restore TABLE_ID RECORD_ID --input restore.json
rowweave records trash TABLE_ID
rowweave records restore-deleted TABLE_ID --input deleted-records.json
```

Example request files:

| File | JSON |
| --- | --- |
| `create-table.json` | `{ "name": "Projects" }` |
| `create-field.json` | `{ "expectedVersion": 1, "name": "Budget", "type": "number", "defaultValue": 0 }` |
| `records.json` | `[{ "values": { "NAME_FIELD_ID": "Launch", "BUDGET_FIELD_ID": 1200 } }]` |
| `query.json` | `{ "limit": 100, "sort": [{ "fieldId": "BUDGET_FIELD_ID", "direction": "desc" }] }` |
| `updates.json` | `[{ "id": "RECORD_ID", "expectedVersion": 1, "values": { "BUDGET_FIELD_ID": 1500 } }]` |
| `change.json` | `{ "changeId": 42 }` |
| `restore.json` | `{ "changeId": 42, "snapshot": "before", "expectedVersion": 2 }` |

History queries accept `{ limit?, before? }`; use returned `nextBefore` for continuation. Fetch and inspect a change before restoring it into an existing record with its current version. Current schema constraints apply, and the restore is itself journaled. See [record history](../../docs/record-history.md) for snapshot, schema and retention semantics.

## Commands

| Command | ID arguments | JSON body |
| --- | --- | --- |
| `tables list` | None | None |
| `tables get` | Table ID | None |
| `tables create` | None | `{ name }` |
| `tables update` | Table ID | `{ expectedVersion, name?, primaryFieldId?, fieldOrder? }` |
| `tables delete` | Table ID | `{ expectedVersion }` |
| `fields create` | Table ID | Field definition plus `expectedVersion` |
| `fields update` | Table ID, field ID | Changed configuration plus `expectedVersion` |
| `fields delete` | Table ID, field ID | `{ expectedVersion }` |
| `fields preview-conversion`, `fields apply-conversion` | Table ID, field ID | `{ expectedVersion, field: definition }` |
| `records get` | Table ID, record ID | None |
| `records history` | Table ID, record ID | `{ limit?, before? }`; defaults to `{}` |
| `records change` | Table ID, record ID | `{ changeId }` |
| `records restore` | Table ID, record ID | `{ changeId, snapshot: 'before' \| 'after', expectedVersion }` |
| `records trash` | Table ID | `{ limit?, before? }`; defaults to `{}` |
| `records batches` | Table ID | `{ limit?, before? }`; bounded transaction receipts |
| `records batch-changes` | Table ID, batch ID | `{ limit?, before? }`; metadata for all affected tables |
| `records undo-batch` | Table ID, batch ID | None; inspect the complete batch first; returns the new undo batch ID |
| `records restore-deleted` | Table ID | Array of `{ id, deletionId, values? }`; latest deletion IDs required, optional writable values repair current-schema conflicts |
| `records query` | Table ID | RecordQuery; defaults to `{}` |
| `records summarize` | Table ID | SummaryRequest; defaults to `{}` for the whole-table count |
| `records create` | Table ID | `[{ values }]` |
| `records update` | Table ID | `[{ id, expectedVersion, values }]` |
| `records delete` | Table ID | `[{ id, expectedVersion }]` |
| `views list` | Table ID | None |
| `views get` | Table ID, view ID | None |
| `views create` | Table ID | `{ name, query?, columns? }` |
| `views update` | Table ID, view ID | `{ expectedVersion, name?, query?, columns? }` |
| `views delete` | Table ID, view ID | `{ expectedVersion }` |
| `views query` | Table ID, view ID | ViewPageRequest; defaults to `{}` |
| `csv preview`, `csv import` | Table ID | `{ expectedVersion, hasHeader, mapping? }` plus `--file` |
| `csv export` | Table ID | `{ viewId?, expectedViewVersion?, search? }`; defaults to `{}` |

Use schema, record, and view versions from the corresponding read responses. Repeating a query requires the same filter/sort/projection plus the previous `revision` as `expectedRevision`. `views query` also accepts `expectedViewVersion`. The CLI forwards schema and record values to the service rather than implementing a second set of business rules.

## CSV files and pipes

```sh
rowweave csv preview TABLE_ID --file tasks.csv --input import-options.json
rowweave csv import TABLE_ID --file tasks.csv --input import-options.json
rowweave csv export TABLE_ID --output exported.csv
rowweave csv export TABLE_ID --input view-export.json --output visible-records.csv
```

`import-options.json` contains, for example, `{ "expectedVersion": 4, "hasHeader": true }`. Add `mapping` when header names cannot map uniquely. Inspect preview diagnostics before choosing to import. Import appends new records atomically; it does not update existing records or import a schema.

Use `--file -` for CSV from stdin; JSON options must then come from a file or `--json`. Without `--output`, CSV export writes the exact UTF-8 CSV, including its BOM, to stdout. Prefer `--output` when a shell's redirection might re-encode text. With `--output`, the command writes a completed temporary file before replacing the destination and returns `{ "path": "absolute destination", "bytes": 123 }` as JSON. The destination directory must already exist; an existing file at that explicit destination is replaced. HTTP export errors leave it untouched.

CSV supports 32 MiB, 100,000 rows, and 2,000,000 cells per operation; see [CSV value semantics](https://github.com/euyuil/rowweave/blob/main/docs/data-exchange.md) for defaults, nulls, empty text, linked IDs, and spreadsheet behavior.

## Output and errors

`attachments upload TABLE_ID --file PATH` stores a real file of up to 8 MiB; optional JSON supplies `filename` and `mediaType`. Use `attachments list TABLE_ID`, `attachments get TABLE_ID ATTACHMENT_ID`, `attachments download TABLE_ID ATTACHMENT_ID --output PATH`, and `attachments delete TABLE_ID ATTACHMENT_ID` to manage files. Downloads require an explicit path and never execute content. See [attachment limits and lifecycle](https://github.com/euyuil/rowweave/blob/main/docs/attachments.md). Uploading a file does not itself edit a record.

Normal success writes exactly one JSON value followed by a newline to stdout and exits 0. Empty collections are `[]`; no status banners precede results. `--help` emits text, and CSV export without `--output` emits CSV.

Failure writes one JSON error to stderr and leaves stdout empty. For example:

```json
{"error":{"code":"VERSION_CONFLICT","message":"The record changed. Reload before saving again.","status":409}}
```

Exit 2 means arguments/configuration/local input are invalid. Exit 1 covers service, connection, or filesystem failures. Service error codes and statuses are preserved. `OPERATION_FAILED` identifies other runtime failures. Requests time out after 15 seconds; writes are never retried. If a connection fails during a create/import, inspect current service data before repeating it because a response may have been lost after commit. For conflicts, reload the relevant resource and compare the intended change before resubmission.

Tests run real CLI subprocesses against an isolated service, verify atomic failures and input/error behavior, and install the packed archive offline outside the repository to exercise its actual command entry point.
