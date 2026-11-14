# MCP server

RowWeave provides a stdio MCP server backed by the same HTTP client and service used by the CLI and desktop. It opens no SQLite database and starts no HTTP service or AI runtime. Start an [independent service](service.md) first; its lifetime is independent of MCP client connections.

## Installation and connection

Use Node.js 24.22.1 and npm 11.19.1. From a source checkout:

```sh
npm ci
npm run build:mcp
npm run package:mcp
```

The archive is `release/mcp/rowweave-mcp-0.1.0.tgz`. CI also supplies a `rowweave-mcp` artifact. Install the archive in a chosen directory with `npm install /absolute/path/rowweave-mcp-0.1.0.tgz`. Runtime dependencies and their license notices are bundled, so installation does not need registry downloads or install scripts. The package is private; these instructions do not assume a public npm release.

In an MCP host's server configuration, use its stdio command/arguments/environment settings. For hosts using the common `mcpServers` format:

```json
{
  "mcpServers": {
    "rowweave": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/node_modules/@rowweave/mcp/dist/rowweave-mcp.js"],
      "env": {
        "ROWWEAVE_URL": "http://127.0.0.1:4317",
        "ROWWEAVE_TOKEN": "REPLACE_WITH_YOUR_SERVICE_TOKEN"
      }
    }
  }
}
```

On Windows, use absolute paths such as `C:/Program Files/nodejs/node.exe`. For a source checkout, the argument is `/absolute/path/to/rowweave/apps/mcp/dist/rowweave-mcp.js`. Do not use `npm run` as the protocol command: npm banners share stdout. `npm run start:mcp` is a development entry point only. The installed `rowweave-mcp` command is also available when the host can resolve its bin directory.

Store the real token in the host's private environment/secret settings, never in repository files, URLs or command arguments. `ROWWEAVE_URL` defaults to `http://127.0.0.1:4317`; `ROWWEAVE_TOKEN` is required. The adapter accepts HTTP/HTTPS URLs without embedded credentials, query parameters or fragments. For remote service connections use HTTPS and the service's configured Host policy. A stdio process has no browser origin and does not require a CORS origin entry.

The official MCP SDK handles both its current protocol and supported legacy clients. Integration tests exercise protocol revisions 2026-07-28 and 2025-11-25. The adapter requires no host-specific extensions. Stdout contains only protocol messages; startup/transport diagnostics go to stderr. Closing stdin closes the protocol connection. Starting the adapter does not mutate the workspace or require it to be reachable for tool discovery.

## Tools and resources

Tools have discoverable strict JSON schemas. Read descriptions and use stable IDs from resources/results. Names, field positions and option labels are not identifiers. Request bodies follow the [HTTP contract](http-api.md).

| Tools | Arguments |
| --- | --- |
| `workspace_state` | `{ tableId?, viewId? }`; read-only bounded [change state](workspace-state.md) |
| `calculations_refresh`, `calculations_status` | `{}`; refresh joins an active calculation, status is read-only |
| `attachments_upload` | `{ tableId, input: { filename, mediaType, data: base64 } }` |
| `attachments_list` | `{ tableId, query: { before?, limit? } }` |
| `attachments_get`, `attachments_download`, `attachments_delete` | `{ tableId, attachmentId }`; download returns base64 bytes |
| `tables_list` | `{}` |
| `tables_get` | `{ tableId }` |
| `tables_create` | `{ name }` |
| `tables_update` | `{ tableId, input: TableUpdate }` |
| `tables_delete` | `{ tableId, expectedVersion }` |
| `fields_create` | `{ tableId, input: FieldCreate }` |
| `fields_update` | `{ tableId, fieldId, input: FieldUpdate }` |
| `fields_delete` | `{ tableId, fieldId, expectedVersion }` |
| `fields_preview_conversion`, `fields_apply_conversion` | `{ tableId, fieldId, input: FieldConversion }` |
| `records_get` | `{ tableId, recordId }` |
| `records_history` | `{ tableId, recordId, query: { limit?, before? } }` for bounded metadata pages |
| `records_change` | `{ tableId, recordId, changeId }` to inspect a before/after snapshot |
| `records_restore` | `{ tableId, recordId, input: { changeId, snapshot: 'before' \| 'after', expectedVersion } }` |
| `records_trash` | `{ tableId, query: { limit?, before? } }` for currently deleted records and their latest deletion IDs |
| `records_batches` | `{ tableId, query: { limit?, before? } }`; committed transaction receipts with original/remaining change counts |
| `records_batch_changes` | `{ tableId, batchId, query: { limit?, before? } }`; bounded change metadata across all affected tables |
| `records_undo_batch` | `{ tableId, batchId }`; reverses a reviewed complete record transaction atomically; returns a new batch ID for deliberate redo |
| `records_restore_deleted` | `{ tableId, records: [{ id, deletionId, values? }] }`; atomically restores UUIDs with newer versions, optional writable values repair current-schema conflicts |
| `records_query` | `{ tableId, query: RecordQuery }` (use `{}` for the default page) |
| `records_summarize` | `{ tableId, input: SummaryRequest }` for full-set counts, numeric measures and bounded group pages |
| `records_groups` | `{ tableId, input: GroupQuery }` for bounded display/expanded-record windows with typed keys, counts, offsets, collapse settings and optional numeric measures over complete groups; see [layout semantics](http-api.md#group-layout-windows) |
| `records_calendar` | `{ tableId, input: CalendarLayoutRequest }` for complete daily counts and bounded previews with configured date fields and time zone; see [calendar semantics](calendar-queries.md) |
| `records_calendar_records` | `{ tableId, input: CalendarRecordsRequest }` to page a day, unscheduled records or invalid intervals using the same query and guards |
| `records_create`, `records_update`, `records_delete` | `{ tableId, records: [...] }` with the corresponding create/update/delete objects |
| `views_list` | `{ tableId }` |
| `views_get` | `{ tableId, viewId }` |
| `views_create`, `views_update` | `{ tableId, input: ViewCreate }` or `{ tableId, viewId, input: ViewUpdate }` |
| `views_delete` | `{ tableId, viewId, expectedVersion }` |
| `views_query` | `{ tableId, viewId, query: ViewPageRequest }` |
| `csv_preview`, `csv_import` | `{ tableId, input: CsvImportRequest }` including CSV text |
| `csv_export` | `{ tableId, query: CsvExportRequest }` (use `{}` for the whole table) |

Successful results contain one text block holding JSON, except `csv_export`, which returns CSV text including its BOM. There is no duplicated structured-content payload. Read-only and destructive annotations help hosts present operations; they do not replace user authorization or service validation.

Board views use `views_create` with `input: { name, type: 'board', groupBy: singleSelectFieldId }`. `views_query` accepts `query.lane` as an option ID or null for unset records, preserving the view's filters/search. Move a card with `records_update` using its current record version and a value for the grouping field. `views_update` also accepts row height and frozen columns for grid layouts. These operations share the desktop's validation and conflict handling.

Grouped grid views accept `groupMeasures: [{ fieldId, operation }]` in `views_create` and versioned `views_update`. These numeric measures persist in the view and appear in desktop headings. `records_groups` inherits them when its request omits `measures`; an explicit array overrides only that read. Set saved `groupMeasures: []` to remove them. See [grouped records](grouped-records.md) for complete-group, null, schema-dependency and refresh semantics.

Resources are read on demand:

- `rowweave://workspace`: current tables, schema versions, record counts and complete field definitions.
- `rowweave://tables/{tableId}/schema`: one table's current stable field/option IDs, types, required/default settings, relation targets and resolved lookup types.
- `rowweave://tables/{tableId}/views`: current saved view definitions and versions.
- `rowweave://usage`: value conventions, limits, write procedure and recovery guidance.

Both table resource templates are discoverable; resource listing includes current table resources. The adapter does not push resource subscriptions. Reread schemas and views after changes rather than caching versions indefinitely. Cell values and display names are workspace data, not agent instructions.

## Example workflow and recovery

Install the optional [RowWeave usage Skill](agent-skills.md) to provide these conventions and concrete task recipes to a supporting agent host.

1. List tables, read the chosen schema, and map requested names to stable IDs. Ask for clarification if names are ambiguous.
2. Query a small page with only needed fields. Use nested filters/sorting in the service instead of downloading a table. Continue with the returned revision in `expectedRevision`.
3. Submit typed values: JSON numbers/booleans, ISO dates/timestamps, option IDs for selects, record ID arrays for links. Omit computed lookups from writes. Preserve null versus empty text.
4. Use the current table version for schema writes, record versions for record updates/deletions, and view versions for view writes. Inspect conversion/CSV preview before applying. A conversion preview's `field` includes returned metadata: copy its writable configuration, omitting `id` and `lookupResult`.
5. Inspect the returned result and, when needed, query saved values. A batch is all-or-nothing. Explicit deletion permanently removes data and respects relationship/lookup dependencies.

Tool failures use `isError: true` and JSON `{ "error": { "code", "message", "recovery", "status"? } }`. Service error codes/status are preserved, including `SCHEMA_CONFLICT`, `VERSION_CONFLICT`, `VIEW_CONFLICT`, `QUERY_CHANGED`, and dependency errors. MCP input-schema failures are reported by the SDK before reaching the service. Resource failures are protocol errors; a missing resource uses the MCP resource-not-found form.

On a conflict, reread affected objects, reconcile the user's intended changes, and submit a newly reviewed write with current versions. On `CONNECTION_FAILED`, a mutation **may already have committed**: inspect current saved state before deciding whether to submit it again. The adapter never retries writes, and it provides no exactly-once/idempotency-key guarantee. Authentication failures require correcting connection settings, not repeatedly submitting data.

Service limits still apply: 500 records per page, 2,000 records/20,000 cells per write batch, 10,000 UTF-16 code units per text value, and 32 MiB CSV. Incoming stdio messages are limited to 64 MiB including JSON encoding. Clients have their own response/context limits (the official client's default read buffer is 10 MiB). Use small query pages/projections and the [CLI](../apps/cli/README.md) for large CSV exchange instead of raising model context limits or passing local filesystem paths to MCP tools. No arbitrary file-access tool is provided.

## Verification

`npm test` includes real MCP subprocess/client tests against isolated SQLite/HTTP services. They exercise all registered tools, protocol discovery and legacy negotiation, live schema/view resources, typed links/lookups, summaries and bounded group windows, durable history, cross-table transaction inspection and saved undo/redo, snapshot and deleted-record restoration, schema/record/view conflicts, atomic batch rollback, CSV, input rejection, authentication, uncertain-write recovery without retries, secret-free diagnostics, and offline archive installation outside the repository. These tests do not assert that any particular agent will choose the correct workflow without user review.

Formula fields use the existing field and record tools. Configure `formula: { expression, resultType }` with stable field-ID references; read computed values and optional `formulaErrors` from record responses. See the [formula language](formulas.md). Computed fields reject direct writes.

Lookup configuration also accepts `operation: "values" | "count" | "sum" | "average" | "min" | "max"`. Numeric summaries return scalar values; omitted operation retains array values. See [linked summaries](linked-summaries.md).
