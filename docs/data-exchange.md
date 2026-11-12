# CSV data exchange

CSV imports append records to an existing table. Configure its schema first; imports do not create fields, change existing records, or preserve source record IDs. All interfaces use the same service validation and transactions.

## Desktop workflow

Save or discard grid edits before opening **Import CSV** or **Export CSV** in the record toolbar.

For import, choose a UTF-8 CSV file, set whether its first row contains column names, then click **Preview CSV**. Match source columns to existing fields or **Skip column**. Field choices include their table position and type to distinguish duplicate names. Mapping and samples show ten columns at a time. After changing mappings, preview again; import stays disabled until the current mapping validates every row. Correct invalid data in the source file and choose it again. **Import N records** appends the validated rows and reloads the grid. A changed schema offers **Reload schema**, retaining the chosen file while resetting mappings for a new preview.

For export, choose the current view (including its current search) or the entire table, then **Save CSV** and choose a destination. Canceling the save dialog writes nothing. File errors remain visible; only a completed write shows **CSV saved**. A completed temporary file replaces the chosen destination, so a failed write does not truncate an existing export. The host's file dialog and write capability are injected into the shared UI; the renderer has no filesystem access. The Electron host uses its [native save dialog](https://www.electronjs.org/docs/latest/api/dialog#dialogshowsavedialogwindow-options) and validates the IPC sender and payload.

A confirmed import remains successful even if the following refresh fails. If the connection drops before the import result is known, the dialog disables another import and asks you to close it and inspect the reloaded table first. This avoids automatically duplicating a write whose response was lost. Import configuration is protected by the application's unsaved-changes close prompt; the original CSV file is never changed.

## Preview and import

Send `POST /tables/:tableId/import/preview` with JSON:

```json
{
  "expectedVersion": 4,
  "hasHeader": true,
  "csv": "Task,Amount\r\nPrepare launch,12.5\r\n",
  "mapping": ["task-field-id", "amount-field-id"]
}
```

`expectedVersion` is the table's schema version. `hasHeader` explicitly determines whether the first logical CSV row is a header. Each mapping entry corresponds to one CSV column in order: a writable field ID, or `null` to skip the column. A field may appear only once. Lookups cannot be import destinations.

Omit `mapping` to match exact, case-sensitive header names to unique writable field names. Duplicate headers, ambiguous field names, unknown names, and lookup columns remain unmapped. Files without a header require explicit mapping. If nothing is mapped, preview still returns column names, samples, and a row count, but `validated` is false; import requires at least one mapped field.

Preview returns `tableId`, `schemaVersion`, `columns`, resolved `mapping`, `validated`, `total`, `invalid`, `samples`, and `issues`. Samples contain up to ten logical rows; each displayed cell is limited to 200 characters plus an ellipsis. Issues contain up to twenty row numbers, error codes, and messages. Row numbering includes the header; line breaks inside a quoted cell do not increment the logical row number. All rows are checked even when diagnostics have reached their display limit. A malformed CSV file or exceeded file limit fails the entire preview.

To apply, send the same request to `POST /tables/:tableId/import`. A successful response is `201` with `{ "imported": 1 }`. The service rechecks schema, values, required fields, and linked targets in one write transaction. A late error rolls back all inserted records, relation edges, and revision changes. A preview does not reserve target records or lock the schema. Reload and preview again after a schema conflict; repair data after validation errors. Imports are non-idempotent: the client never retries automatically. If the connection fails after submission, inspect the table before deciding whether to repeat it.

## Values and file format

Files use UTF-8, comma separators, double-quoted cells, and doubled double quotes inside quoted cells. UTF-8 BOMs are accepted. LF, CRLF, and CR row endings are accepted; export writes a BOM and CRLF. Commas and line breaks within quoted cells are preserved. Every data row must have the same number of columns as the first row.

| Field/value | CSV representation |
| --- | --- |
| Null | An unquoted empty cell. It remains null even if the field has a default. |
| Empty text | A quoted empty cell (`""`). For non-text fields, empty input is null. |
| Unmapped field | Uses its default, or null when it has no default; required constraints still apply. |
| Text and multiline | Literal text, including whitespace, Unicode, quotes, and line breaks. |
| Number | A finite decimal or exponent value. Export preserves the stored value, without currency/percent formatting or display rounding. |
| Checkbox | `true` or `false`. |
| Date | `YYYY-MM-DD`, with calendar validation. |
| Timestamp | An ISO timestamp with an explicit time zone, normalized to UTC. |
| Single select | An existing option name (or ID on import). Names take precedence if a name equals another option's ID. |
| Multiple select | A JSON array of existing option names (or IDs on import), inside a CSV cell. |
| Linked records | A JSON array of existing record IDs in the configured target table. Export preserves link order. |
| Lookup | A read-only JSON array of computed values; select results use option names. Skip this column when importing. |

An empty file is invalid; a header-only file can preview/export a schema and imports zero records. A blank data row represents one null cell. A final line ending does not create an extra record. Required text rejects blank values; optional text preserves empty strings separately from null.

CSV is a value exchange format, not a workspace backup: schemas, saved views, versions, and record identities are not included. Linked IDs only work while their targets still exist in that workspace. Use a database backup to preserve the entire workspace.

Spreadsheet applications may reinterpret dates, leading zeros, long numbers, and formula-like text when opening CSV. RowWeave exports literal text without silently prefixing or changing values. Use the spreadsheet's text import settings to preserve those columns. A spreadsheet may also remove the quoted-empty/null distinction when resaving a file. Direct RowWeave export/import preserves it; external spreadsheet interoperability is a final-candidate check.

## Export

Send `POST /tables/:tableId/export` with `{}` to export the whole table in schema/insertion order, or with `{ "viewId": "view-id", "expectedViewVersion": 2, "search": "launch" }` to export a saved view. The view supplies filters, sorting, visible fields, and column order; optional `search` overrides its saved search. `expectedViewVersion` rejects a changed view. All matching records are included, not just the current page. The response is `text/csv; charset=utf-8` with an attachment filename. Errors use the ordinary JSON error envelope and a non-success status.

Export reads records and computed values in one consistent SQLite snapshot, hydrates bounded batches, and finishes validation before returning the file. An oversized export returns `CSV_LIMIT`, never a partial CSV. The TypeScript client's `previewCsv`, `importCsv`, and `exportCsv` methods use these endpoints; `exportCsv` returns the CSV string including its UTF-8 BOM marker.

## Limits

Each operation supports at most 32 MiB of UTF-8 CSV, 100,000 data rows, 200 source columns, and 2,000,000 cells. Import counts the greater of the source column count and the table's writable field count per row, so unmapped defaults also count. Export counts visible output fields. Use a filtered view or fewer visible columns for larger exports. Field-level limits, including 10,000 characters for text, still apply. CSV request JSON is limited to 64 MiB to allow quoting overhead; other JSON endpoints retain their 8 MiB limit. The separate normal record-batch limit remains 2,000 records / 20,000 cells.

Regression tests cover typed/Unicode/empty-value round trips, header mappings, bounded diagnostics and file limits, late-failure rollback, changed schemas/targets, view ordering/projection, authenticated HTTP access, and the shared client. The offscreen desktop workflow also checks mapping pagination, UTF-8 errors, stale-schema recovery, saved files with BOMs, save cancellation/failure, failed refresh after a committed import, lost import responses, and draft guards. Native file dialogs are stubbed to isolated test paths; actual file writes are verified. These checks are not native spreadsheet verification.
