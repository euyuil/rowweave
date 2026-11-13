# HTTP API

RowWeave exposes one bearer-authenticated HTTP/JSON API. The desktop, [TypeScript SDK](../packages/client/README.md), and other clients share its validation, transactions, and conflict rules. See [development.md](development.md) to start the service. The current default address is `http://127.0.0.1:4317`; the desktop's bundled service uses an ephemeral loopback port and token supplied by its host.

Send `Authorization: Bearer <token>` on every operation, and `Content-Type: application/json` for request bodies, including DELETE bodies. The token has at least 32 printable ASCII characters without spaces. Default loopback settings permit the bundled file renderer (`Origin: null`) and clients without an Origin header. Independent services support explicit IP binding and exact Host/origin allowlists; see [service configuration](service.md). Browser preflights do not require a token, but actual operations always do. Keep credentials outside source and logs.

Successful JSON responses contain the resource/result directly. Errors use a non-success status and `{ "error": { "code": "VERSION_CONFLICT", "message": "..." } }`. CSV export returns text; attachment downloads return binary bytes. Writes are not idempotent unless the operation itself makes them so; clients must not automatically retry creates/imports/uploads after an uncertain response.

## Workspace change state

For lightweight change detection, `POST /workspace/state` accepts `{ tableId?, viewId? }` and returns a catalog revision plus optional selected table/view state. This authenticated read does not load records or initiate calculations. Missing requested objects are null. Relative-date filters include their current date context. See [workspace state](workspace-state.md) for the response and draft-safe client rules.

## Attachment storage

The authenticated file API stores immutable, table-scoped files up to 8 MiB inside the workspace database. Save uploaded IDs in attachment fields to associate them with records. See [file limits, retention and interface examples](attachments.md). Only never-attached uploads can be deleted individually; used files return `ATTACHMENT_RETAINED` so history remains restorable.

| Method and path | Request body | Result / SDK method |
| --- | --- | --- |
| `POST /tables/:table/attachments` | `{ filename, mediaType, data }`, canonical base64 `data` | `201 Attachment` / `uploadAttachment(id, input)` |
| `POST /tables/:table/attachments/query` | `{ before?, limit? }`, maximum 100 | `{ attachments, nextBefore? }` / `listAttachments(id, query)` |
| `GET /tables/:table/attachments/:attachment` | None | `Attachment` / `getAttachment(id, attachmentId)` |
| `GET /tables/:table/attachments/:attachment/content` | None | Original bytes / `downloadAttachment(id, attachmentId)` returns `Uint8Array` |
| `DELETE /tables/:table/attachments/:attachment` | None | `{ deleted: attachmentId }` / `deleteAttachment(id, attachmentId)` |

## Calculation refresh

`GET /calculations/status` returns `CalculationStatus`: `automatic`, `running`, optional ISO `startedAt`/`completedAt`, `lastResult` and `lastError`. SDK `calculationStatus()`, CLI `calculations status` and read-only MCP `calculations_status` share this response. Production services refresh at startup and every minute in a worker. Reads see committed snapshots during calculation; writes wait and retain their version guards. Status resets on process restart. Explicit refresh joins any running refresh, and its SDK timeout is 120 seconds. On a lost response, inspect status and saved state before retrying.

`POST /calculations/refresh` with `{}` atomically recalculates clock-dependent formulas and downstream dependencies across the workspace. SDK `refreshCalculations()`, CLI `calculations refresh` and MCP `calculations_refresh` share this operation. It returns `{ evaluatedAt, changedRecords, changedTableIds }`; `evaluatedAt` is the captured UTC minute. Changed record versions and data revisions advance, while user edit times and history remain unchanged. Existing stale writes/undo receipts remain subject to version checks. See [clock semantics and limits](formulas.md#current-time-and-explicit-refresh).

## Tables and schema

In the paths below, `:table` and `:field` are stable IDs. Names are trimmed, non-empty strings up to 200 characters. Tables have `id`, `name`, schema `version`, data `revision`, `primaryFieldId`, ordered `fields`, and `total`. Table/schema changes return the complete updated Table.

| Method and path | Request body | Result / SDK method |
| --- | --- | --- |
| `GET /tables` | None | `Table[]` / `listTables()` |
| `POST /tables` | `{ name }` | `201 Table` / `createTable(input)` |
| `GET /tables/:table` | None | `Table` / `getTable(id)` |
| `PATCH /tables/:table` | `{ expectedVersion, name?, primaryFieldId?, fieldOrder? }` | `Table` / `updateTable(id, input)` |
| `DELETE /tables/:table` | `{ expectedVersion }` | `{ deleted: tableId }` / `deleteTable(id, version)` |
| `POST /tables/:table/fields` | Field definition plus `expectedVersion` | `201 Table` / `createField(id, input)` |
| `PATCH /tables/:table/fields/:field` | Changed field properties plus `expectedVersion` | `Table` / `updateField(id, fieldId, input)` |
| `DELETE /tables/:table/fields/:field` | `{ expectedVersion }` | `Table` / `deleteField(id, fieldId, version)` |
| `POST /tables/:table/formulas/preview` | `{ expectedVersion, formula: { expression, resultType }, fieldId?, recordId? }` | `FormulaPreview` / `previewFormula(id, input)`; read-only [draft calculation](formulas.md#preview-before-saving) |
| `POST /tables/:table/fields/:field/conversion/preview` | `{ expectedVersion, field: definition }` | `ConversionPreview` / `previewConversion(id, fieldId, input)` |
| `POST /tables/:table/fields/:field/conversion/apply` | Same conversion request | `Table` / `applyConversion(id, fieldId, input)` |

A new table contains an optional text field named `Name` and an `All records` view. `fieldOrder`, when supplied, contains every field ID exactly once. Choose another primary display field before deleting it. Relation, lookup and attachment fields cannot be primary display fields. Deleting a table deletes its records/views/fields/files; external relations and lookups must be removed first.

`primaryFieldId` selects the **primary display field**, not a database primary key. Its values label linked records and may repeat or be empty unless the field is required. Each record's immutable `id` UUID is its primary key; each column has a separate field UUID. Renaming a field, editing display values, or selecting another display field preserves record IDs and links.

Tables support up to 200 fields. Field definitions use `{ name, type, description?, required?, defaultValue? }` and these type-specific properties:

| Type | JSON cell value | Configuration |
| --- | --- | --- |
| `text`, `multiline` | String | Up to 10,000 characters; required text must not be blank. |
| `url` | String or null | Absolute HTTP or HTTPS URL without credentials, whitespace, control characters or backslashes. Both entered and URL-encoded forms must fit 2,048 characters. Valid Unicode text is preserved as entered; empty text is invalid. |
| `attachment` | Array of unique uploaded file IDs or null | Up to 20 files, each owned by this table. Required fields need a file; no defaults, conversion or primary-display use. Record responses include `attachments: { fieldId: Attachment[] }` with immutable metadata, including owning `tableId`. Files are retained for history once saved in a record. |
| `autoNumber` | Read-only integer | Service-assigned per-field sequence starting at 1. Existing records are numbered in position order when the field is added. Ordinary writes, including explicit null, return `READ_ONLY_FIELD`; defaults and required constraints are unavailable. |
| `createdTime`, `updatedTime` | Read-only UTC ISO timestamp or null | Original creation / latest record save or reciprocal-link edit. One service transaction supplies one time. Schema changes and calculation-only refreshes do not reset edit time. Known history is backfilled; unknown legacy times remain null. See [automatic record times](development.md#automatic-record-times). |
| `number` | Finite number | `numberFormat`: `decimal`, `currency`, or `percent`; optional `precision` 0–10, nullable on update to restore automatic precision; three-letter `currency` for currency presentation. Display formatting never rounds the stored value. |
| `checkbox` | Boolean | `false` is a value, distinct from null. |
| `date` | `YYYY-MM-DD` | Must be a valid calendar date. |
| `datetime` | ISO timestamp with explicit zone | Normalized to UTC, retaining milliseconds. |
| `singleSelect` | Option ID string | Up to 200 `options: [{ id?, name, color? }]`; names and IDs must each be unique; colors use `#RRGGBB`. |
| `multiSelect` | Array of unique option IDs | Same options configuration; required values need at least one option. |
| `relation` | Array of unique record IDs | `relation: { tableId, multiple }`; one target if false, up to 200 if true. Targets must exist in that table. |
| `formula` | Read-only number, text, boolean, date or timestamp (or null) | `formula: { expression, resultType }`; result types are number/text/checkbox/date/datetime, and references use field UUIDs. See [formulas](formulas.md) for syntax, errors and transactional recalculation. |
| `lookup` | Read-only array, or number/null for numeric summaries | `lookup: { relationFieldId, fieldId, operation? }`; omitted/`values` returns the original array. Numeric targets support `count`, `sum`, `average`, `min`, `max`. See [linked summaries](linked-summaries.md). No defaults, required constraint, direct writes, or chained lookups. |

Optional writable fields allow null. New-record defaults apply only to omitted fields; explicit null does not use a default. Existing records do not receive a newly added default. Add a required field to a non-empty table as optional, fill it, then enable its constraint. Tightening constraints validates existing values atomically. A field's ID and option IDs survive rename and reorder. Returned lookup fields include the current resolved `lookupResult` metadata; that property is not writable configuration.

`description` is optional plain text up to 2,000 UTF-16 code units. Leading/trailing whitespace is trimmed; line breaks inside the text are retained. Omit it to preserve existing guidance on updates or conversion; send empty/whitespace-only text to clear it. Description changes use the table's `expectedVersion`, preserve field/record identities and do not rewrite record values or history. Descriptions are part of stored schema and backups; desktop configuration, column actions, typed record forms and cell editors show them as text, never HTML. SDK, CLI and MCP field operations use the same property.

A new relation may additionally specify `reverseField: { name, multiple, expectedVersion }`. The nested version belongs to the target table. Both fields are created atomically and return service-assigned `relation.inverseFieldId` metadata. Edits from either side synchronize values and versions; final cardinality and required constraints apply to both sides. Deleting a record clears its reciprocal links unless other dependencies prevent deletion. Deleting one field preserves the opposite field as ordinary one-way links. See [two-way relationship semantics](development.md#linked-records) for batch, CSV and schema boundaries.

Changing a field's type requires explicit conversion. Preview returns `tableId`, `fieldId`, proposed `field`, `schemaVersion`, `total`, `changed`, `invalid`, up to ten samples, and up to twenty issues. Apply validates current data again in one transaction. Invalid data, stale schema versions, or incompatible saved-view/lookup dependencies prevent all changes. Relation/lookup/formula fields cannot be converted to or from another type. Use the returned resolved field definition when applying conversions that create select options.

## Records

Records have `{ id, version, values }`, with values keyed by field ID. Relation responses also include `links: { [fieldId]: [{ id, label }] }` using current primary display values. Lookup values are computed from current targets, in link order; no links produces `[]`. A lookup of a multiple-select field flattens selected IDs, preserving duplicates across different linked records. Changing a target invalidates dependent query revisions without rewriting each source record's version.

| Method and path | Request body | Result / SDK method |
| --- | --- | --- |
| `GET /tables/:table/records/:record` | None | `RowRecord` / `getRecord(tableId, recordId)` |
| `POST /tables/:table/records/:record/history` | `{ limit?, before? }` | `RecordHistoryPage` / `recordHistory(tableId, recordId, query)` |
| `GET /tables/:table/records/:record/history/:change` | None | `RecordChangeDetail` / `recordChange(tableId, recordId, changeId)` |
| `POST /tables/:table/records/:record/restore` | `{ changeId, snapshot: 'before' \| 'after', expectedVersion }` | `RowRecord` / `restoreRecord(tableId, recordId, input)` |
| `POST /tables/:table/trash/query` | `{ limit?, before? }` | `RecordTrashPage` / `recordTrash(tableId, query)` |
| `POST /tables/:table/trash/restore` | Array of `{ id, deletionId, values? }` | `BatchResult` / `restoreDeletedRecords(tableId, records)` |
| `POST /tables/:table/batches/query` | `{ limit?, before? }` | `RecordBatchPage` / `recordBatches(tableId, query)` |
| `POST /tables/:table/batches/:batch` | `{ limit?, before? }` | `RecordBatchChanges` / `recordBatchChanges(tableId, batchId, query)` |
| `POST /tables/:table/batches/:batch/undo` | `{}` | `RecordBatchUndoResult` / `undoRecordBatch(tableId, batchId)` |
| `GET /tables/:table/records?offset=0&limit=100` | None | `{ offset, records }` in insertion order; prefer the query endpoint for revision-aware pagination. |
| `POST /tables/:table/records` | `[{ values: { fieldId: value } }]` | `201 { records, batchId }` / `createRecords(id, inputs)` |
| `PATCH /tables/:table/records` | `[{ id, expectedVersion, values: { fieldId: value } }]` | `{ records, batchId }` with new versions / `updateRecords(id, updates)` |
| `DELETE /tables/:table/records` | `[{ id, expectedVersion }]` | `{ deleted: recordIds }` / `deleteRecords(id, inputs)` |
| `POST /tables/:table/query` | RecordQuery below | QueryPage / `queryRecords(id, query, signal?)` |
| `POST /tables/:table/summary` | SummaryRequest below | RecordSummary / `summarizeRecords(id, input, signal?)` |
| `POST /tables/:table/groups/query` | GroupQuery below | GroupLayout / `queryGroups(id, input, signal?)` |

Batch operations are atomic and require unique record IDs. Partial updates change only supplied fields. Creation omits computed lookup fields; explicitly supplying a lookup, including null, is rejected. Ordinary batches support up to 2,000 records and 20,000 changed/created cells. A conflict or invalid value on any record prevents every write in that batch.

Records referenced by another record or a linked-field default cannot be deleted until those references are removed. A closed set of self-linked records can be deleted together. There are no dangling links or implicit cascade deletions of other tables' records.

[Record history](record-history.md) persists committed snapshots, including deleted records, until their table is deleted. History pages contain metadata only (default 20, maximum 100); continue with `before: nextBefore`. Fetch a single change to inspect stored values and formula errors. Snapshot restoration requires an existing record and its current version. It keeps the UUID and later-added fields, validates current constraints, recalculates formulas and journals the restoration. `INVALID_HISTORY`, `HISTORY_NOT_FOUND` and ordinary schema/value/link/version errors explain rejected requests.

Trash uses the same cursor limits and lists only currently deleted records with their latest deletion IDs. Deleted-record restoration is atomic, preserves UUIDs, advances versions, appends rows and applies current constraints. Optional writable `values` explicitly repair historical values; later fields use current defaults/null. Restore linked sets together where needed. An old deletion ID or already restored record returns `VERSION_CONFLICT`. See [trash semantics](record-history.md#deleted-records) before restoring or retrying an uncertain result.

Transaction receipts use the same page limits and show original and remaining change counts. Batch inspection includes metadata from every affected table, with `tableId` on each change. `recordWrite` distinguishes record operations from schema side effects. Receipts start at format 18; old record history is preserved without inventing complete transaction counts. See [transaction inspection](record-history.md#inspect-a-complete-transaction).

Saved batch undo validates every original final version, restores the complete record operation atomically across tables and returns a new batch ID. Its receipt's `undoOf` points to the original transaction. Undo the new batch for a deliberate redo. Current schema, relation and deletion constraints apply; incomplete/schema/oversized batches are rejected, and uncertain writes are never automatically retried. See [limits and concurrency rules](record-history.md#undo-a-saved-batch).

## Queries

Date and timestamp fields support [relative calendar filters](relative-date-filters.md), including saved time zones and dynamic week/month/day ranges. Query and summary responses containing these filters also return `dateContext`. Reuse it as `expectedDateContext` on continuation pages and paired summary/board-lane requests. `DATA_CHANGED` requires restarting pagination when the calendar range changes, even if the data revision is unchanged.

### Summaries

Use `POST /tables/:table/summary` to summarize the entire matching set, independently of loaded record pages:

```json
{
  "groupBy": "status-field-id",
  "measures": [{ "fieldId": "amount-field-id", "operation": "sum" }],
  "offset": 0,
  "limit": 50
}
```

The response contains `totals: { count, values }`, `groups: [{ key, label, count, values }]`, `groupCount`, `offset`, `revision` and `schemaVersion`. Measure values follow request order. Omit `groupBy` for totals only, or `measures` for record counts. Up to 12 numeric measures support `sum`, `average`, `min` and `max`. Null numbers are excluded; no numeric values returns null, including an empty sum. A numeric overflow returns `SUMMARY_OVERFLOW` instead of a fabricated result. Groups support text, multiline, numbers, booleans, dates, timestamps and single select. Select keys are stable option IDs; labels reflect current names. Null and empty text form separate groups. Groups sort by scalar value or current single-select label, with null last and stable keys breaking ties.

Pass `filter`/`search` to summarize a query, or `viewId` with `expectedViewVersion` to retain the saved view's filter. An explicit filter cannot accompany a saved view; `search` can override the saved search. Group pages use `offset` and `limit` (default 100, maximum 500); totals and `groupCount` cover all matching records on every page. Carry `revision` as `expectedRevision` for continuation; changed data rejects the page with `DATA_CHANGED`. A changed saved view returns `VIEW_CONFLICT`. All totals, counts and returned groups are read in one SQLite transaction.

### Group layout windows

`POST /tables/:table/groups/query` returns the groups intersecting a bounded window. The default `window: "displayRows"` includes headings and expanded records, including a group whose heading precedes the requested offset. Each heading occupies one display row; expanded records occupy one row each. `window: "expandedRecords"` counts only expanded records, skipping every heading and collapsed record. `offset` defaults to zero and `limit` to 100 (maximum 500 units of the selected window). Summary pagination separately counts groups.

Provide a scalar `groupBy` and optional `filter`/`search`, or a saved grouped-grid `viewId` with `expectedViewVersion`. A saved view uses its own grouping and filter; an explicit different group or filter is rejected. Temporary search may override the saved search. Boards retain their lane API.

The result contains `groups: [{ key, label, count, recordOffset, rowStart, expandedOffset, collapsed, values? }]`, `window`, `totalRecords`, `totalGroups`, `totalRows`, `offset`, `revision`, `schemaVersion`, and optional `dateContext` and saved `viewId`/`viewVersion`. Counts cover the complete matching dataset in either window mode. Only intersecting segments are returned, at most `limit`. Past-end windows return no segments but retain complete totals. Expanded-record windows omit empty and collapsed groups.

Optional `measures: [{ fieldId, operation }]` requests up to 12 numeric `sum`, `average`, `min` or `max` results. Each segment's `values` follows the requested order and covers every matching record in that group, even when the window intersects only one row or its heading is collapsed. Numeric formulas, automatic numbers and scalar linked summaries are supported. Nulls and failed formula values do not contribute to numeric aggregates; `count` still includes their records. Empty groups and groups without numeric values return null for each measure, including sum. A non-finite aggregate in a returned segment rejects the response with `SUMMARY_OVERFLOW`. When reading a saved view, omitted measures use its `groupMeasures`; otherwise omission means no measures. An explicit empty array omits `values`, and any explicit array overrides only that read. Null or non-array measures are invalid. Read requests do not change saved views or data.

Use a segment's `recordOffset` with a record query using the same `groupBy`, filter and search, or the same saved view. Carry `expectedRevision`, `expectedDateContext` and `expectedViewVersion` between these reads. Collapse changes display positions only. For a visible record row `r` inside an expanded segment, its record offset is `recordOffset + r - rowStart - 1`; headings never have record UUIDs.

`expandedOffset` is the number of expanded records before a group. For expanded-record position `p` inside that group, its record-query offset is `recordOffset + p - expandedOffset` and its display position is `rowStart + 1 + p - expandedOffset`. Clip the group's records to the requested interval; its complete `count` can exceed the window limit. The complete expanded count is `totalRows - totalGroups`. These positions let clients read a bounded selection across arbitrarily many collapsed headings without fetching intervening groups. An all-collapsed view has zero expanded records and returns an empty expanded window.

Optional `collapse: { defaultCollapsed: boolean, exceptions: ScalarValue[] }` flips the default for each exception key. Omission expands every group. Keys use the field's checked scalar type, are normalized like cell values, and must be unique after normalization; at most 100,000 keys are accepted within the ordinary request-body limit. All-collapsed windows need no list of all groups. These request settings do not persist.

Text (including URLs), numbers, booleans, dates, timestamps, scalar formulas, automatic fields and scalar lookup summaries are supported. Arrays, raw links and attachments are not scalar grouping keys. Groups use raw ascending scalar order, with null last; text ordering is case-sensitive. Single-select groups use configured option order. Null always has a heading; checkbox values and configured options retain empty headings. Empty text and null are distinct. These group types also work in saved grids and the desktop; see [grouped records](grouped-records.md).

### Record pages

```json
{
  "offset": 0,
  "limit": 100,
  "fields": ["name-field-id", "amount-field-id"],
  "filter": {
    "conjunction": "and",
    "conditions": [
      { "fieldId": "amount-field-id", "operator": "gte", "value": 10 },
      { "conjunction": "or", "conditions": [
        { "fieldId": "name-field-id", "operator": "contains", "value": "launch" },
        { "fieldId": "name-field-id", "operator": "isEmpty" }
      ] }
    ]
  },
  "sort": [{ "fieldId": "amount-field-id", "direction": "desc" }],
  "search": "project"
}
```

QueryPage is `{ offset, records, total, revision, schemaVersion }`. Offset defaults to 0, limit to 100; limits range from 1 to 500. Optional `recordIds` restricts the result to up to 2,000 unique IDs. `fields` projects returned values without changing which fields participate in search/filtering. Omitted fields returns all values; an empty field array returns identities/versions only.

Optional scalar `groupBy` uses the same group order as layout windows, then applies the requested sorts within each group (excluding the grouping field), and finally insertion position. It returns real records only. This temporary query does not change a saved view.

Filters combine `and`/`or` groups with at most 100 conditions and four nested levels below the root. An empty AND matches all records; an empty OR matches none. Predicates use:

- `eq`, `neq`: scalar equality/inequality, including null. For multiple-select/relation fields, use these only with null; use `hasAny` to match IDs.
- `contains`: literal, case-insensitive substring matching for text, multiline and URL fields.
- `gt`, `gte`, `lt`, `lte`: typed number/date/timestamp comparisons.
- `relativeDate`: date/timestamp period with `relative: { period, timeZone, days? }` instead of `value`; see the [periods and time-zone contract](relative-date-filters.md).
- `hasAny`: one or more existing option IDs or linked-record IDs (an empty list matches none).
- `isEmpty`, `isNotEmpty`: null, empty text, and empty arrays count as empty; zero and false do not.

Lookup comparisons match any member; `neq` matches when no member equals the operand. A lookup counts as empty when it contains no non-null, non-empty member. A multiple-select lookup supports `hasAny` and empty checks, not `eq`/`neq`. Lookup filtering uses the target's ordinary type. Search examines display text across the schema, including select/linked labels and computed values. SQLite's default case folding is ASCII-oriented; Unicode content is retained and literal matching works, but full Unicode case folding is not promised.

Sort rules are ordered and use distinct fields with `asc`/`desc`. Nulls sort last in either direction, numbers numerically, select/linked fields by display labels, and lookups by the first computed value. Ties use insertion order. To continue pages, repeat the same query with the previous `revision` as `expectedRevision`. `DATA_CHANGED` means restart paging; never combine pages from different revisions.

## Saved views

| Method and path | Request body | Result / SDK method |
| --- | --- | --- |
| `GET /tables/:table/views` | None | `GridView[]` / `listViews(id)` |
| `POST /tables/:table/views` | `{ name, query?, columns?, rowHeight?, frozenColumns?, type?, groupBy?, groupMeasures? }` | `201 GridView` / `createView(id, input)` |
| `GET /tables/:table/views/:view` | None | `GridView` / `getView(id, viewId)` |
| `PATCH /tables/:table/views/:view` | `{ expectedVersion, name?, query?, columns?, rowHeight?, frozenColumns?, type?, groupBy?, groupMeasures? }` | `GridView` / `updateView(id, viewId, input)` |
| `DELETE /tables/:table/views/:view` | `{ expectedVersion }` | `{ deleted: viewId }` / `deleteView(id, viewId, version)` |
| `POST /tables/:table/views/:view/query` | `{ offset?, limit?, fields?, expectedRevision?, expectedDateContext?, expectedViewVersion?, search?, lane? }` | QueryPage plus `viewId`, `viewVersion` / `queryView(id, viewId, input, signal?)` |

A saved view has `id`, `tableId`, `name`, `version`, `query`, `columns`, `rowHeight`, `frozenColumns`, and `type`. A grid may also specify a scalar `groupBy` field UUID; `groupBy: null` removes grouping. Its query contains only `filter`, `sort`, and `search`. Columns contain every field once, in display order, as `{ fieldId, width, hidden }`; widths are integer pixels from 50 to 1,000. At least one column and one view remain visible/available. Omitted columns show every field in schema order.

Create/update accepts `rowHeight` (36, 48 or 64 pixels) and `frozenColumns` (an integer from zero through the visible column count). New views default to 36 and zero. Frozen columns follow the leading visible positions. An explicitly invalid count returns `INVALID_VIEW`; when column visibility/schema changes without an explicit count, the previous count is reduced to the new visible count if needed. Display changes use the same `expectedVersion` check as other view edits. SDK, CLI and MCP view operations expose these properties without a separate layout endpoint.

Grouped grids may save `groupMeasures: [{ fieldId, operation }]`, using up to 12 numeric `sum`, `average`, `min` or `max` measures. Omission on update retains them; `[]` clears them. Nonempty measures require a grouped grid. Removing grouping or switching to a board clears previously saved measures when no explicit measures are supplied. Field renames preserve their UUIDs; deleting or converting a referenced numeric field incompatibly returns `VIEW_DEPENDENCY` until its measures are removed. Saved group queries use these measures by default; explicit request measures override only that read. The desktop uses the saved configuration for its headings. These settings participate in view versions, external refresh, restart and workspace backups.

View updates replace supplied query/columns configurations; `{ query: {} }` clears conditions. View queries default to visible columns and the saved search; request `search` temporarily overrides it. Pass `expectedViewVersion` and `expectedRevision` when paging. Schema changes reconcile view columns/deleted predicates atomically; incompatible remaining filters prevent conversion/option removal until the view is changed.

`type` is `grid` (the default) or `board`. A board also requires `groupBy`, the ID of a single-select field in this table. Board queries accept `lane` as a current option ID or `null` for unset values, combined with the saved filter/search. Omit it to query the full view. Invalid options and lane queries on grids return `INVALID_QUERY`. The SDK's existing `GridView` type represents both layouts. Deleting/converting the grouping field returns `VIEW_DEPENDENCY`; reconfigure/delete the view first. Updating to `{ type: 'grid', expectedVersion }` removes grouping. Move records with ordinary versioned record updates; no separate mutation or retry path is used.

## CSV

| Method and path | Request body | Result / SDK method |
| --- | --- | --- |
| `POST /tables/:table/import/preview` | `{ expectedVersion, csv, hasHeader, mapping? }` | `CsvPreview` / `previewCsv(id, input, signal?)` |
| `POST /tables/:table/import` | Same import request | `201 { imported: count }` / `importCsv(id, input)` |
| `POST /tables/:table/export` | `{ viewId?, expectedViewVersion?, search? }` | UTF-8 `text/csv` with BOM / `exportCsv(id, input?, signal?)` |

See [data-exchange.md](data-exchange.md) for mapping, null/empty/default semantics, typed representations, and limits. Import appends new records atomically; export reads all matching records in one snapshot and returns an attachment only after the complete file validates. CSV supports 32 MiB, 100,000 rows, and 2,000,000 cells per operation. Import JSON allows up to 64 MiB for quoting overhead; other JSON bodies are limited to 8 MiB.

## Errors and recovery

| Status / examples | Recovery |
| --- | --- |
| `400`: `INVALID_SCHEMA`, `INVALID_VALUE`, `INVALID_QUERY`, `INVALID_BATCH`, `INVALID_CSV`, `READ_ONLY_FIELD`, `INVALID_LINK` | Correct the request against the current schema. No partial batch/import writes are exposed. |
| `401 UNAUTHORIZED` | Correct the configured bearer token; do not print it in diagnostics. |
| `403 INVALID_HOST`, `INVALID_ORIGIN`, `INVALID_PREFLIGHT` | Use the configured service address, permitted origin, and supported request method/headers. |
| `404`: `TABLE_NOT_FOUND`, `FIELD_NOT_FOUND`, `RECORD_NOT_FOUND`, `VIEW_NOT_FOUND`, `NOT_FOUND` | Refresh IDs or correct the endpoint. |
| `409`: `SCHEMA_CONFLICT`, `VERSION_CONFLICT`, `VIEW_CONFLICT`, `DATA_CHANGED` | Reload the relevant schema/record/view/query; compare changes before intentionally resubmitting. |
| `409`: `RELATION_DEPENDENCY`, `LOOKUP_DEPENDENCY`, `VIEW_DEPENDENCY` | Remove or reconfigure the named dependency first. |
| `413 PAYLOAD_TOO_LARGE`, `CSV_LIMIT` | Reduce the batch/file or export a smaller filtered view. |
| `415 INVALID_CONTENT_TYPE` | Send JSON with the correct Content-Type. |
| `500 INTERNAL_ERROR`, network failure, or timeout | Inspect service state before retrying a non-idempotent write; the client may have lost a successful response. |

The SDK exports request/response types from [contracts](../packages/contracts/src/index.ts), exposes service errors as `ApiFailure`, applies a 15-second request timeout, and never retries writes automatically.
