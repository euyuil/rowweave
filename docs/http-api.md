# HTTP API

RowWeave exposes one bearer-authenticated HTTP/JSON API. The desktop, [TypeScript SDK](../packages/client/README.md), and other clients share its validation, transactions, and conflict rules. See [development.md](development.md) to start the service. The current default address is `http://127.0.0.1:4317`; the desktop's bundled service uses an ephemeral loopback port and token supplied by its host.

Send `Authorization: Bearer <token>` on every operation, and `Content-Type: application/json` for request bodies, including DELETE bodies. The token has at least 32 printable ASCII characters without spaces. Default loopback settings permit the bundled file renderer (`Origin: null`) and clients without an Origin header. Independent services support explicit IP binding and exact Host/origin allowlists; see [service configuration](service.md). Browser preflights do not require a token, but actual operations always do. Keep credentials outside source and logs.

Successful JSON responses contain the resource/result directly. Errors use a non-success status and `{ "error": { "code": "VERSION_CONFLICT", "message": "..." } }`. CSV export is the one successful non-JSON response. Writes are not idempotent unless the operation itself makes them so; clients must not automatically retry creates/imports after an uncertain response.

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
| `POST /tables/:table/fields/:field/conversion/preview` | `{ expectedVersion, field: definition }` | `ConversionPreview` / `previewConversion(id, fieldId, input)` |
| `POST /tables/:table/fields/:field/conversion/apply` | Same conversion request | `Table` / `applyConversion(id, fieldId, input)` |

A new table contains an optional text field named `Name` and an `All records` view. `fieldOrder`, when supplied, contains every field ID exactly once. Choose another primary field before deleting it. Relation and lookup fields cannot be primary. Deleting a table deletes its records/views/fields; external relations and lookups must be removed first.

Tables support up to 200 fields. Field definitions use `{ name, type, required?, defaultValue? }` and these type-specific properties:

| Type | JSON cell value | Configuration |
| --- | --- | --- |
| `text`, `multiline` | String | Up to 10,000 characters; required text must not be blank. |
| `number` | Finite number | `numberFormat`: `decimal`, `currency`, or `percent`; optional `precision` 0–10, nullable on update to restore automatic precision; three-letter `currency` for currency presentation. Display formatting never rounds the stored value. |
| `checkbox` | Boolean | `false` is a value, distinct from null. |
| `date` | `YYYY-MM-DD` | Must be a valid calendar date. |
| `datetime` | ISO timestamp with explicit zone | Normalized to UTC, retaining milliseconds. |
| `singleSelect` | Option ID string | Up to 200 `options: [{ id?, name, color? }]`; names and IDs must each be unique; colors use `#RRGGBB`. |
| `multiSelect` | Array of unique option IDs | Same options configuration; required values need at least one option. |
| `relation` | Array of unique record IDs | `relation: { tableId, multiple }`; one target if false, up to 200 if true. Targets must exist in that table. |
| `lookup` | Read-only array of computed scalars | `lookup: { relationFieldId, fieldId }`; use a local relation and an ordinary target field. No defaults, required constraint, direct writes, or chained lookups. |

Optional writable fields allow null. New-record defaults apply only to omitted fields; explicit null does not use a default. Existing records do not receive a newly added default. Add a required field to a non-empty table as optional, fill it, then enable its constraint. Tightening constraints validates existing values atomically. A field's ID and option IDs survive rename and reorder. Returned lookup fields include the current resolved `lookupResult` metadata; that property is not writable configuration.

Changing a field's type requires explicit conversion. Preview returns `tableId`, `fieldId`, proposed `field`, `schemaVersion`, `total`, `changed`, `invalid`, up to ten samples, and up to twenty issues. Apply validates current data again in one transaction. Invalid data, stale schema versions, or incompatible saved-view/lookup dependencies prevent all changes. Relation/lookup fields cannot be converted to or from another type. Use the returned resolved field definition when applying conversions that create select options.

## Records

Records have `{ id, version, values }`, with values keyed by field ID. Relation responses also include `links: { [fieldId]: [{ id, label }] }` using current primary display values. Lookup values are computed from current targets, in link order; no links produces `[]`. A lookup of a multiple-select field flattens selected IDs, preserving duplicates across different linked records. Changing a target invalidates dependent query revisions without rewriting each source record's version.

| Method and path | Request body | Result / SDK method |
| --- | --- | --- |
| `GET /tables/:table/records/:record` | None | `RowRecord` / `getRecord(tableId, recordId)` |
| `GET /tables/:table/records?offset=0&limit=100` | None | `{ offset, records }` in insertion order; prefer the query endpoint for revision-aware pagination. |
| `POST /tables/:table/records` | `[{ values: { fieldId: value } }]` | `201 { records }` / `createRecords(id, inputs)` |
| `PATCH /tables/:table/records` | `[{ id, expectedVersion, values: { fieldId: value } }]` | `{ records }` with new versions / `updateRecords(id, updates)` |
| `DELETE /tables/:table/records` | `[{ id, expectedVersion }]` | `{ deleted: recordIds }` / `deleteRecords(id, inputs)` |
| `POST /tables/:table/query` | RecordQuery below | QueryPage / `queryRecords(id, query, signal?)` |

Batch operations are atomic and require unique record IDs. Partial updates change only supplied fields. Creation omits computed lookup fields; explicitly supplying a lookup, including null, is rejected. Ordinary batches support up to 2,000 records and 20,000 changed/created cells. A conflict or invalid value on any record prevents every write in that batch.

Records referenced by another record or a linked-field default cannot be deleted until those references are removed. A closed set of self-linked records can be deleted together. There are no dangling links or implicit cascade deletions of other tables' records.

## Queries

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

Filters combine `and`/`or` groups with at most 100 conditions and four nested levels below the root. An empty AND matches all records; an empty OR matches none. Predicates use:

- `eq`, `neq`: scalar equality/inequality, including null. For multiple-select/relation fields, use these only with null; use `hasAny` to match IDs.
- `contains`: literal, case-insensitive substring matching for text/multiline fields.
- `gt`, `gte`, `lt`, `lte`: typed number/date/timestamp comparisons.
- `hasAny`: one or more existing option IDs or linked-record IDs (an empty list matches none).
- `isEmpty`, `isNotEmpty`: null, empty text, and empty arrays count as empty; zero and false do not.

Lookup comparisons match any member; `neq` matches when no member equals the operand. A lookup counts as empty when it contains no non-null, non-empty member. A multiple-select lookup supports `hasAny` and empty checks, not `eq`/`neq`. Lookup filtering uses the target's ordinary type. Search examines display text across the schema, including select/linked labels and computed values. SQLite's default case folding is ASCII-oriented; Unicode content is retained and literal matching works, but full Unicode case folding is not promised.

Sort rules are ordered and use distinct fields with `asc`/`desc`. Nulls sort last in either direction, numbers numerically, select/linked fields by display labels, and lookups by the first computed value. Ties use insertion order. To continue pages, repeat the same query with the previous `revision` as `expectedRevision`. `DATA_CHANGED` means restart paging; never combine pages from different revisions.

## Saved views

| Method and path | Request body | Result / SDK method |
| --- | --- | --- |
| `GET /tables/:table/views` | None | `GridView[]` / `listViews(id)` |
| `POST /tables/:table/views` | `{ name, query?, columns? }` | `201 GridView` / `createView(id, input)` |
| `GET /tables/:table/views/:view` | None | `GridView` / `getView(id, viewId)` |
| `PATCH /tables/:table/views/:view` | `{ expectedVersion, name?, query?, columns? }` | `GridView` / `updateView(id, viewId, input)` |
| `DELETE /tables/:table/views/:view` | `{ expectedVersion }` | `{ deleted: viewId }` / `deleteView(id, viewId, version)` |
| `POST /tables/:table/views/:view/query` | `{ offset?, limit?, fields?, expectedRevision?, expectedViewVersion?, search? }` | QueryPage plus `viewId`, `viewVersion` / `queryView(id, viewId, input, signal?)` |

A GridView has `id`, `tableId`, `name`, `version`, `query`, and `columns`. Its query contains only `filter`, `sort`, and `search`. Columns contain every field once, in display order, as `{ fieldId, width, hidden }`; widths are integer pixels from 50 to 1,000. At least one column and one view remain visible/available. Omitted columns show every field in schema order.

View updates replace supplied query/columns configurations; `{ query: {} }` clears conditions. View queries default to visible columns and the saved search; request `search` temporarily overrides it. Pass `expectedViewVersion` and `expectedRevision` when paging. Schema changes reconcile view columns/deleted predicates atomically; incompatible remaining filters prevent conversion/option removal until the view is changed.

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
