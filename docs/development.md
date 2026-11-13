# Development

Use Node.js 24.22.1 and npm 11.19.1. The repository uses strict TypeScript and ESM. Run commands from the repository root.

```sh
npm ci
npm run check
npm run build
npm test
```

On Windows, use `npm.cmd` if PowerShell execution policy prevents `npm` from running.

Build the stdio MCP adapter with `npm run build:mcp` and its independently installable archive with `npm run package:mcp`. Run the built entry directly from an MCP host as described in the [MCP guide](mcp.md); `npm run start:mcp` is available for development. Protocol and offline installation tests run in `npm test`.

Build the thin Harness Web adapter with `npm run build:harness`, package it with `npm run package:harness`, and run its isolated browser integration check with `npm run test:harness`. The test uses the pinned official module loader, layout, slots, and renderer against a temporary RowWeave service; it does not start an AI session. The host packages, Zustand, and Immer are development-only dependencies for that fixture and type checking. See [Harness setup](harness.md) for installation, allowed origins, browser downloads, and credential lifetime.

After `npm run package:win`, run `npm run test:interfaces` for the shared-service acceptance scenario. It extracts the portable ZIP outside the repository, checks its checksum, and connects the packaged desktop, Harness UI, SDK bundle, CLI subprocess and MCP protocol client to one temporary service. The clients discover schema, create fields/records/views, exchange versioned edits, and reject stale schema/record writes. `npm run test:harness` runs the same scenario with the source desktop. Windows CI runs both variants; neither uses the user's database or native input methods.

## Standalone service

Set `ROWWEAVE_TOKEN` to a random secret of at least 32 printable ASCII characters without spaces, then run `npm run start:server`. `ROWWEAVE_DB` selects the database (default: `.data/prototype.sqlite`), and `ROWWEAVE_PORT` selects the port (default: 4317). The default binding is 127.0.0.1. For independent/remote operation, configure `ROWWEAVE_HOST`, `ROWWEAVE_ALLOWED_HOSTS`, and `ROWWEAVE_ALLOWED_ORIGINS` as described in the [service operations guide](service.md). Do not commit credentials or put them in URLs.

Requests use `Authorization: Bearer <token>`:

- `GET /tables`: discover tables and their stable IDs.
- `GET /tables/:tableId`: field definitions and record count.
- `GET /tables/:tableId/records?offset=0&limit=100`: records in a stable order, with at most 500 per page.
- `PATCH /tables/:tableId/records`: a JSON array of `{ id, expectedVersion, values }` updates, where `values` maps stable field IDs to typed values. The entire batch commits or rolls back together. Successful records return their incremented versions. A stale version returns HTTP 409; reload before explicitly resolving the conflict.

Write limits are 2,000 distinct records, 20,000 changed cells, 10,000 UTF-16 code units per text value, and an 8 MiB JSON request body. Duplicate IDs and unknown fields are rejected. Empty strings and nulls remain distinct in storage.

A new database starts empty. Create a table from the desktop sidebar or `POST /tables`; deterministic datasets are only created explicitly by tests and `npm run dataset`. Opening an existing database never reseeds deleted tables. Node's built-in SQLite driver runs only in the service.

Use `npm run workspace:file -- backup SOURCE NEW_DESTINATION` for a consistent online workspace snapshot, and `npm run workspace:file -- restore BACKUP NEW_DESTINATION` to validate and migrate a copy. Neither operation replaces an existing destination. See [backup, restore, and upgrades](backup.md) before switching a working service or desktop to the restored file.

### Dynamic tables and schema

**Filters** supports [relative calendar periods](relative-date-filters.md) for date and timestamp fields, with saved time zones and cross-page date-context checks. Desktop packaging bundles the pinned Temporal date resolver and its license notices; source service execution uses the lockfile-installed dependency.

**Summarize** in the view toolbar computes counts and numeric totals for all saved records matching the current view and search. Choose a scalar grouping field and a numeric sum/average/min/max; group pages stay bounded and carry revision checks. The same operation is `POST /tables/:tableId/summary`, SDK `summarizeRecords`, CLI `rowweave records summarize TABLE_ID --json '{"groupBy":"FIELD_ID"}'`, and MCP `records_summarize`. See [HTTP summaries](http-api.md#summaries) for the complete contract.

The read-only [group-layout API](http-api.md#group-layout-windows) provides bounded display windows and record offsets for complete scalar groups, including large numbers of distinct values. SDK `queryGroups`, CLI `records groups` and MCP `records_groups` use the same service contract. Broader editable desktop grouping remains in the active delivery scope.

The service supports multiple tables with stable table, field, and record IDs. The desktop supports creating, switching, renaming, and deleting tables, with unsaved-edit navigation guards and explicit deletion confirmation. **Manage fields** adds/configures fields, selects the primary display field, changes field order, and confirms deletion. Forms expose the supported types, descriptions, number formatting, options, required values, and defaults. Field descriptions provide plain-text guidance in column actions, record forms and cell editors; they support up to 2,000 characters and can be cleared with empty text. Save or discard grid drafts before changing schema; changes use the displayed schema version and reject stale writes.

- `GET /tables`: list table definitions and counts.
- `POST /tables`: create an empty table with `{ "name": "Projects" }` and an initial **Name** field.
- `GET /tables/:tableId`: read a table, including its schema `version` and `primaryFieldId`.
- `PATCH /tables/:tableId`: pass `expectedVersion` and any of `name`, `primaryFieldId`, or `fieldOrder` (every field ID exactly once).
- `DELETE /tables/:tableId`: pass `{ "expectedVersion": 1 }` in the JSON body. The table, its fields, and its records are removed atomically.
- `POST /tables/:tableId/fields`: pass `expectedVersion`, `name`, `type`, and the type's configuration described below.
- `PATCH /tables/:tableId/fields/:fieldId`: pass `expectedVersion` and changed field settings. Type changes require the separate conversion workflow; they are not silently coerced by this endpoint.
- `DELETE /tables/:tableId/fields/:fieldId`: pass `expectedVersion`. Choose another primary display field before deleting the primary display field. Existing cell values are removed and affected record versions increment atomically.
- The existing paginated record reads and atomic updates work at `/tables/:tableId/records` for any table.

Schema writes return the updated table and increment its schema version. A stale version returns HTTP 409 with `SCHEMA_CONFLICT`; reload schema before retrying. Names contain 1–200 characters and tables support up to 200 fields. A newly added text field has no stored values until edited; an absent field value means null. Renaming and reordering do not rewrite record identities or values. Set `precision: null` in a number-field update to restore automatic decimal formatting without changing stored values.

SQLite stores relational table/field/view metadata and JSON record values, with a table/position index. Format 3 added persistent data revisions, 4 saved views, 5 relations, 6 lookup dependencies, 7 saved-query indexes, 8 persisted display settings, 9 board layouts, 10 persisted formula errors, and 11 scalar lookup summaries. Opening older databases migrates transactionally, preserving field IDs, record IDs, positions, values, and record/schema versions. Format 8 preserves existing view versions and adds the original 36-pixel row height and zero frozen columns; format 9 keeps existing views as grids, retaining their display settings and versions. A failed migration rolls back; unsupported newer formats fail without replacing their schema. Back up a working database before upgrading; do not copy a live database without its pending WAL state.

### Typed values and record lifecycle

| Field type | JSON value and configuration |
| --- | --- |
| `text`, `multiline` | String up to 10,000 UTF-16 code units, or null. Empty strings remain distinct from null. |
| `url` | Absolute HTTP/HTTPS URL or null, up to 2,048 characters including its encoded form. Credentials, whitespace, control characters and backslashes are rejected. Unicode text remains unchanged in storage, CSV and clipboard; opening uses the encoded URL. |
| `attachment` | Up to 20 unique uploaded file IDs, or null. No default; required fields need at least one file. Record responses include ordered file metadata. See [attachments](attachments.md). |
| `autoNumber` | Read-only positive integer assigned by the service. Each field has its own sequence starting at 1. See [automatic numbering](#automatic-numbering) for recovery and import behavior. |
| `createdTime`, `updatedTime` | Read-only UTC ISO timestamp or null. See [automatic record times](#automatic-record-times) for edit, history and restoration semantics. |
| `number` | Finite JSON number. Optional `numberFormat`: `decimal`, `currency`, or `percent`; `precision`: 0–10; currency formatting requires a three-letter uppercase `currency` code. Formatting never rounds stored values. Percent values use fractions: `0.5` displays as 50%. |
| `checkbox` | Boolean; false is a valid required value. |
| `date` | Valid `YYYY-MM-DD` calendar date. |
| `datetime` | ISO timestamp with seconds and an explicit zone (`Z` or an offset), normalized to UTC. |
| `singleSelect` | An existing option ID or null. |
| `multiSelect` | Array of unique existing option IDs, or null. |
| `relation` | Ordered array of unique record IDs from one target table, or null. Configure `relation: { tableId, multiple }`; allow one or up to 200 linked records. |
| `lookup` | Read-only array of scalar values from linked records. Configure `lookup: { relationFieldId, fieldId }`; returned `lookupResult` describes the current target field. |

Select fields have up to 200 `options`, each with `name`, optional `color` (`#RRGGBB`), and optional `id` on creation. The service generates missing IDs. Retain returned IDs when renaming options. IDs and names must be unique within the field. Removing an option still used by a record is rejected atomically.

URL fields support defaults, required values, text search, equality/substring/empty filters, sorting, CSV, lookups and text formula inputs. Forms and typed grid editors offer **Open link** only for valid values; this explicit action opens the system browser (a separate browser tab in Harness). Saving, querying, importing and previewing never fetch or open the address. Opening a draft link does not save the draft. Desktop IPC validates the address independently, and the application window continues to deny arbitrary navigation and child windows. Automated tests stub the actual browser opener, exercise both hosts and reject unsafe IPC requests; final-candidate acceptance checks the native browser handoff.

Writable fields accept `required` and `defaultValue`. Defaults apply only when a new record omits that field; explicit null does not apply the default. Passing `defaultValue: null` clears a configured default. Required text must not be blank, required multi-select must contain an option, and required fields reject null. To add a required field to a populated table, add it as optional, populate it, then enable `required`; enabling it checks all existing values transactionally.

- `POST /tables/:tableId/records`: array of `{ values }` objects; returns `{ records, batchId }` with generated IDs and version 1. Creation is atomic and uses the same 2,000-record/20,000-cell limits (including defaulted cells). Updates and trash restoration also return their own transaction receipt ID for saved-operation inspection and undo.
- `GET /tables/:tableId/records/:recordId`: fetch one record by stable ID.
- `DELETE /tables/:tableId/records`: array of `{ id, expectedVersion }` objects; returns `{ deleted: [id, ...] }`. A missing/stale record rolls back the whole batch.

The desktop's **New record**, **Open record**, and **Duplicate** actions use a right-hand panel with typed fields, defaults, select option labels, multiline text and UTC date-time inputs. Its title uses the saved primary display value and its formatting; the optional Record identity disclosure retains the UUID. The field area scrolls independently while the title and save/cancel actions remain available. Optional values can be cleared to null; an empty text value remains a string. Details load the complete record, including fields outside the visible grid. Save or Ctrl+S explicitly applies changes. Cancel discards the form; closing with the panel's close button or Escape asks whether to keep editing or discard changed values. A failed validation or version conflict retains the form. Save or discard grid drafts before managing records. Select cells or row checkboxes, then **Delete records** to preview and confirm a versioned batch deletion (up to 2,000 records); cancellation leaves data unchanged.

The grid uses typed editors and parses typed edits/paste. Select clipboard values use option names; multi-select uses a JSON array of names. Number input uses decimal notation, checkboxes use `true`/`false`, and blank non-text input means null. Invalid cells reject the complete pasted rectangle and preserve existing drafts. Service writes always validate again.

Configured select colors appear as labels in grid cells, record forms, lookup values and board cards/headings. Light and dark fills choose a contrasting foreground; unconfigured options use a neutral fill. Colors supplement the option names, which remain available to keyboard users and in copied text. Rendering does not change stable option IDs, saved colors, editing, filtering or clipboard formats. Multiple values keep their saved order, including repeated looked-up values.

### Automatic numbering

Add an **Automatic number** field to identify records with an immutable, readable sequence. The record UUID remains the primary key; you may choose an automatic field as the primary display field. Each field starts at 1, assigns existing records in their stored position order, and then advances for new records. Reordering, renaming, filtering, editing and deleting records do not reset or reuse numbers. Duplicating a record allocates a new number. Field addition preserves UUIDs and advances affected record versions/history as it fills values.

Sequences are allocated in the same SQLite transaction as the records. Concurrent clients receive distinct numbers; a rolled-back batch consumes none. The maximum is JavaScript's safe integer limit, 9,007,199,254,740,991; `SEQUENCE_EXHAUSTED` rejects the entire operation if it would exceed that value. No automatic write retries occur. Format 21 persists counters in workspace backups, and each restored workspace continues independently from its saved counter.

Ordinary HTTP/SDK/CLI/MCP writes cannot supply an automatic value, including null. The grid allows copying but not editing/pasting/clearing automatic cells; record forms display read-only values. Required/default settings and type conversion are unavailable for this field. CSV preview does not consume numbers; import skips matching automatic headers unless explicitly mapped, in which case it rejects the read-only mapping. Successful imported rows receive fresh numbers, and export includes the saved numeric values. Numeric filters, sorting, summaries, formulas and lookups use the same values.

Restoring a saved snapshot of an existing record preserves its current automatic number. Trash restoration, undo of deletion and redo of creation recover the same record UUID and original number from durable history. If an automatic field was added after that record was deleted, restoration assigns a new number for that field. Deleting a field removes its counter; recreating a new field creates a new identity and sequence. Recovery never rolls a counter backwards.

### Automatic record times

**Created time** (`createdTime`) records the original creation of a record. **Last edited time** (`updatedTime`) records a successful versioned record save, restoration, saved undo/redo or reciprocal-link edit. All affected records use the same service transaction time, independent of client clocks and time zones. A failed write or stale-version conflict rolls back timestamps with the other values. A formula or lookup refresh does not count as a record edit, and schema operations (including conversion) do not reset edit time. A desktop save with no changed values sends no write and leaves the time unchanged.

Adding these fields fills existing records from durable history: the original creation entry and latest known saved-record change. Records predating available history keep unknown values as null. Adding a field never fabricates a past time using the installation or upgrade time. Backfilled values preserve record UUIDs and advance affected versions. Timestamp fields cannot accept user values, defaults or required settings, and cannot be converted to another type. You may rename them or use one as the primary display field.

Creating or duplicating records, including CSV imports, assigns fresh times. Restoring a deleted record or redoing creation preserves its original creation time, even if the timestamp field was added after deletion; the restoration receives the current edit time. Restoring an existing record's saved values keeps its creation time and records a new edit time. Unknown original creation remains unknown. Backups and restart preserve timestamps and the history used to recover them.

The grid and forms display UTC values read-only. Date comparisons, relative-date filters, sorting, lookups and formulas consume their timestamp strings. CSV export includes these values; import skips matching automatic headers, rejects explicit read-only mappings and assigns service times to new records. SDK/CLI/MCP use the same schema and write rules. Format 22 gates these field semantics while retaining the existing database structure.

### Attachment storage

Attachment fields hold up to 20 uploaded file IDs. Record forms and typed grid editors upload, select, remove and download files through the shared service and host interfaces; lookup files are read-only and paged. The service validates ownership and retains files transactionally so history, trash and saved undo remain recoverable. SDK/CLI/MCP share the same operations. Bytes are stored inside SQLite and included in workspace backups. See [attachments](attachments.md) for limits, lifecycle and commands.

### Linked records

Create a **Linked records** field, choose its target table, and choose whether it allows multiple records. Defaults and required values work with linked IDs. Record forms, grid editors, and filters use a searchable picker with 50-record pages; selected records stay available outside the current search/page. Click a selected name to view the target's full record details. The primary display field must be a non-linked field, preventing circular labels.

Record responses keep IDs in `values` and include `links: { fieldId: [{ id, label }] }` for display. The service resolves labels within the same read snapshot, without a request per cell. Changing target records or schema advances the source tables' data revisions, so continuation pages cannot combine old labels with new data. Search and sorting use the target's primary labels; `hasAny` filters use record IDs. Clipboard relation values use JSON arrays of IDs to avoid ambiguous duplicate names. Query `recordIds` accepts up to 2,000 distinct IDs and can be combined with filters/projection to resolve a picker selection in one request.

SQLite format 5 adds indexed relation edges and field-to-target dependencies. JSON IDs and their edge index change in the same transaction. Foreign keys protect targets; input validation also checks table ownership, uniqueness, cardinality, and defaults. Invalid links or a late version conflict roll back the complete batch. Linked fields cannot be converted to/from ordinary fields; create the field and assign IDs explicitly. Unlink existing values before retargeting a field to another table.

To create a two-way relationship, include `reverseField: { name, multiple, expectedVersion }` in a new relation-field request. Its version is the target table's current schema version; the outer `expectedVersion` belongs to the source table. Both fields are created atomically, including two different fields for a self-linked table. Responses include service-assigned `relation.inverseFieldId` values. The same request works through HTTP, SDK, CLI `fields create` and MCP `fields_create`. In the desktop, enable **Create a reverse field in the linked table** while adding a linked-record field, then choose the reverse name and record limit.

Saving links from either side updates both records' values and edge indexes in one transaction. Affected opposite records receive new versions and their tables invalidate query continuations. Batch writes check final cardinality, allowing an atomic one-to-one swap; inconsistent explicit assignments to both sides are rejected. Required values and the 200-link limit apply to both fields. Defaults and CSV imports use the same write rules; CSV preview validates input rows, while final reverse-field capacity is checked when applying the complete import. No failed write is automatically replayed.

Deleting a record removes its reciprocal links unless a required value, ordinary incoming link or field default prevents deletion. Deleting one field keeps the opposite field and its values as ordinary one-way links, with an updated schema version. Lookup dependencies still prevent removing fields they need. A paired field cannot change its target table; create a new pair for a different relationship. Existing one-way fields are not automatically paired. SQLite format 12 preserves older workspaces and prevents applications without reciprocal-write support from opening them.

Deleting referenced records returns `RELATION_DEPENDENCY` until external links and linked-field defaults are removed. A single batch may delete a self-linked set when nothing outside that set refers to it. Deleting a source record/field removes its outgoing edges. Deleting a target table requires removing fields in other tables that point to it, even if those fields are empty. Deletion failures retain all data and edges.

### Formula fields

The [formula guide](formulas.md) defines the language, UI workflow and API contract. The core parses bounded expressions and orders dependencies; SQLite materializes results/errors transactionally on every supported write path. Schema changes recalculate records without loading them into the renderer. Database format 10 adds an empty error map to existing records without changing their versions or saved views.

Date formulas construct, extract and add/diff calendar values using the bundled Temporal implementation. Typed date and timestamp results share ordinary date filters, lookups, CSV and recovery; timestamps use UTC. Format 25 gates these calculation semantics without rewriting existing records. The field editor documents supported functions and units, and record details label timestamp results as UTC. [Date calculation rules](formulas.md#date-calculations) include month-end clamping, signed complete intervals and explicit errors.

Numeric lookup summaries and array lookups are also formula inputs. The storage dependency plan orders formulas and lookups across tables, rejects cycles, and uses indexed relation edges to recalculate affected records in batches inside the write transaction. Formulas reading raw relation IDs run after reciprocal writes too. Local-only formulas retain their ordinary calculation path. Lookup inputs remain derived; only formula results and errors are persisted. A changed dependent result advances its record version once per record mutation and invalidates affected query revisions. Format 13 introduced connected calculation; format 26 adds array evaluation and raw relation dependencies. Migrations preserve existing data and versions. [Array semantics](formulas.md#array-calculations) define types, nulls and work limits.

### Linked numeric summaries

Lookup fields can return count/sum/average/min/max through the existing relationship. See [linked summaries](linked-summaries.md) for configuration, null/error semantics and API usage. The SQLite lookup expression is shared by hydration, filters, sorting, search and grouped summary queries. Format 11 preserves existing array lookups and blocks incompatible older applications.

### Grouped grids

See [grouped table records](grouped-records.md) for saved grouping, editing and interface semantics. Grid grouping currently accepts single-select and checkbox fields. SQLite orders each view by group and then its record sort, including CSV exports; the client combines revision-checked group counts with the existing paged model. Visual headings never become record identities. Format 14 preserves earlier workspaces and protects grouped view configuration from incompatible older applications.

### Read-only lookups

Add a **Lookup** field, choose an existing linked-record field, and select an ordinary field in its target table. The service computes values from saved links in link order, preserving numbers, booleans, timestamps, text, select IDs, and nulls. Multiple-select values are flattened without deduplication; no links produce an empty array. A lookup cannot target another lookup or a linked-record field, become a primary display field, set defaults, or require values. This is a one-hop lookup; it can also read a saved scalar formula result.

The grid and record details display target formatting and option labels. Save changed links to refresh their lookup values. Copy produces a JSON array, using option labels for select values; other values retain their JSON types. Paste/clear operations that include a lookup fail atomically instead of partially overwriting a selection. Record creation and duplication omit lookup values; explicit writes, including null, return `READ_ONLY_FIELD`.

Lookup filters use the target's typed operands. Comparisons match any looked-up member; `neq` means no member equals the operand. Multiple-select lookups support `hasAny` and empty checks. Empty means no non-null, non-empty member; zero and false remain meaningful. Search uses all displayed members. Sorting uses the first looked-up value, with numeric ordering for numbers and nulls last; equal values retain insertion order.

Format 6 adds lookup dependencies while preserving format-5 links, data, and views. Deleting a lookup's linked field or target field, or converting its target type, returns `LOOKUP_DEPENDENCY`; remove the lookup first. Target configuration changes refresh derived metadata and advance dependent schema versions. Saved lookup filters are revalidated in the same transaction, so removing an option they reference fails without partially changing schema. Target data updates invalidate query revisions without rewriting source record versions. Refresh retains ordinary drafts while replacing computed values with the latest service result.

### Field conversion

Use `POST /tables/:tableId/fields/:fieldId/conversion/preview` with `{ expectedVersion, field }`, where `field` is the complete target field configuration (name, type, and any options/default/format settings). The field ID stays unchanged. Preview returns the resolved target `field` (including generated option IDs), total/changed/invalid record counts, at most 10 before/after samples, and at most 20 failing record IDs/messages. Preview makes no changes.

In the desktop, choose another type in **Manage fields → Configure**, then **Preview conversion**. Inspect the affected records, correct any invalid data, and **Apply conversion**. Editing the target configuration invalidates the old preview. Failed application preserves the field configuration form and rolls back the entire conversion, including when another client introduced an invalid value after preview.

Submit `{ expectedVersion: preview.schemaVersion, field: preview.field }` to `.../conversion/apply` to retain previewed option IDs, recheck current records, and apply the conversion in one transaction. The table schema version increments; only records whose stored value changes receive a new record version. Any invalid value returns `CONVERSION_FAILED` and rolls back the entire operation, including earlier records. A schema change since preview returns `SCHEMA_CONFLICT`. Preview is informational: successful preview does not skip validation during apply.

Text converts using the same rules as typed paste: decimal numbers, true/false, ISO dates/timestamps, option names/IDs, and JSON arrays for multi-select. Empty text becomes null for non-text targets; preview shows this change. Scalars become their textual representation; select values become their labels, and multi-select becomes a JSON array of labels. Multiple selected options cannot be collapsed into one. Same-type conversion validates all values against the target configuration. Target defaults are explicit and apply only to future records; existing nulls are never filled implicitly.

### Server queries

`POST /tables/:tableId/query` accepts this shape (all properties are optional):

```json
{
  "offset": 0,
  "limit": 100,
  "filter": {
    "conjunction": "and",
    "conditions": [{ "fieldId": "field_1", "operator": "contains", "value": "project" }]
  },
  "sort": [{ "fieldId": "field_1", "direction": "asc" }],
  "search": "project",
  "fields": ["field_1"]
}
```

The response contains `offset`, `records`, the filtered `total`, `schemaVersion`, and `revision`. Pass the first page's revision as `expectedRevision` on subsequent pages. A record or schema write increments that revision; a stale continuation receives HTTP 409 `DATA_CHANGED` rather than silently mixing pages. Counts and records come from one SQLite snapshot. The simpler `GET .../records` endpoint remains available without this continuation guarantee.

Filters support nested `and`/`or` groups (four nested levels and 100 conditions), typed `eq`/`neq`, text `contains`, numeric/date/timestamp `gt`/`gte`/`lt`/`lte`, `isEmpty`/`isNotEmpty`, and multi-select `hasAny` with option IDs. Empty means null, an empty string, or an empty multi-select list; false and zero are values. `neq` includes null when comparing with a non-null value. Filter values and search strings are bound parameters, so SQL characters and `%` remain literal.

Sort by multiple distinct fields, ascending or descending. Numbers sort numerically, select fields by display labels, and nulls last; original insertion position breaks ties. Search examines formatted scalar/option values across all fields, including Unicode text. Text matching and sorting use SQLite's ASCII case folding; other Unicode characters match as written. Output `fields` selects values by stable ID, while record IDs and versions are always returned. An empty field list returns record identities only. Pages remain bounded to 500 records; queries execute in the service without loading the entire dataset into the client.

### Saved views

The desktop view tabs switch between saved views without losing record drafts. Use Left/Right or Home/End to focus a tab, then Enter/Space to activate it. Long view lists scroll horizontally; the selected tab stays in sight. Clicking the active tab keeps its temporary search. **New view** copies the current configuration; **View settings** renames a view and saves search text, filters, sorting, column visibility, order, and width. Build nested AND/OR groups with typed operands and reorder multiple sort rules by priority. Empty AND groups match every record; empty OR groups match none. The search box temporarily overrides that view's search, waits until typing pauses, and defers requests during IME composition. The selected view is remembered per table on this device. Deleting a view leaves its records intact; every table retains at least one view.

Use **Filters** or **Sort** to open a focused panel beside its toolbar button. Save applies only those rules, preserving the other query settings, temporary search and grid drafts. Badges identify configured filters (including an empty OR group) and the number of sort rules. Cancel or Escape discards the panel's edits; a version conflict retains them for deliberate resolution. **View settings** still edits the complete view, including its saved search.

Open a column's dropdown, right-click its header, or press **Shift+F10** on a selected cell to configure that field, sort by it, move it left/right, or hide it in the current view. A column sort becomes the first rule while retaining other rules and filters. Moving/hiding columns changes only the view; use **View settings** to show hidden fields again. Save or discard grid drafts before column actions. Version conflicts retain the menu with a reload message and never retry the write automatically.

Column-level **Configure field** opens beside that column with bounded scrolling and persistent cancel/save or conversion actions. It uses the same typed configuration and preview/apply workflow as **Manage fields**. Cancel leaves the schema unchanged; invalid conversions block application and stale schema versions retain the draft. Closing or saving returns keyboard focus to the grid. **Manage fields** retains its full-width configuration dialog for workspace-wide schema work.

Desktop pagination uses the saved view ID and version as well as the data revision. A concurrent view/schema change stops stale loading and retains drafts. **Refresh view** fetches current metadata while keeping drafts (and resets undo history); **Discard edits** asks before removing drafts. Configuration dialogs retain inputs when their own versioned save conflicts. Record details and duplication include fields hidden from the grid.

Ordinary ungrouped grids also [detect and apply external changes automatically](workspace-state.md#automatic-grid-refresh) while editing is idle. Active editors, dialogs, drafts, local undo/redo, composition and clipboard reads postpone application. Selection follows stable identities where possible and otherwise clears explicitly. Grouped grids and boards currently detect changes and offer **Refresh view**.

The [workspace sidebar](workspace-state.md#automatic-table-list-refresh) automatically discovers externally created, renamed and deleted tables. It retains the selected table and local work; an external deletion never forces navigation or discards drafts.

**Display** saves row density, frozen columns, visibility and column arrangement for the current view. Compact, Comfortable and Spacious use row heights of 36, 48 and 64 pixels. Frozen columns are the leading visible columns in the current order; their count decreases if hiding or deleting fields leaves fewer visible columns. Other views keep their own settings. New view copies the current display settings along with its query.

Every table starts with an **All records** view. A view contains a stable `id`, `tableId`, `name`, independent `version`, saved `query` (`filter`, `sort`, `search`), ordered `columns` (`fieldId`, `width`, `hidden`), `rowHeight` and `frozenColumns`. New API views default to `rowHeight: 36` and `frozenColumns: 0`. At least one column and one view remain visible/available. Column widths range from 50 to 1,000 pixels.

- `GET /tables/:tableId/views`: list saved views.
- `POST /tables/:tableId/views`: create with `{ name, query?, columns?, rowHeight?, frozenColumns? }`. Omitting columns shows all fields in schema order; a supplied column list includes every field once.
- `GET /tables/:tableId/views/:viewId`: read one view.
- `PATCH /tables/:tableId/views/:viewId`: pass its `expectedVersion` and changed `name`, `query`, `columns`, `rowHeight`, or `frozenColumns`. Query/columns replace the corresponding configuration; use `query: {}` to clear saved conditions. A stale version returns `VIEW_CONFLICT`.
- `DELETE /tables/:tableId/views/:viewId`: pass `expectedVersion`; the last view cannot be deleted.
- `POST /tables/:tableId/views/:viewId/query`: apply the saved query. The request accepts `offset`, `limit`, `expectedRevision`, `expectedViewVersion`, optional output `fields`, and an optional temporary `search` override. By default only visible columns' values are returned. The response adds `viewId` and `viewVersion`; pass both revision/version checks when continuing pages.

Choose **Board** in New view or View settings and select a single-select grouping field. Each option has a column, including options with no matching records, plus a **No value** column. Cards use the primary display field as their title and up to three other visible fields in view order. Open a card for all fields, including hidden ones. New record within a column presets that option; No value explicitly overrides a field default. Moving a card by drag or **Move to** saves immediately with its record version. A failed move requires a refresh before another move, without replaying an uncertain write.

Board definitions use `type: 'board'` and `groupBy: fieldId`; API-created views default to `type: 'grid'`. `queryView` accepts `lane: optionId` or `lane: null` to add a grouping constraint to the saved filters/search. Omit lane for the entire view. Option IDs survive label changes. Delete or reconfigure a board before removing/converting its grouping field. Changing it to `type: 'grid'` removes grouping while retaining query, columns and grid display settings.

Board counts use the full matching summary snapshot. The renderer loads 25 cards per page only for columns near the horizontal viewport, keeps bounded page windows, and checks schema/data/view/date revisions. Each page retains the saved sort order. Idle boards automatically prepare changed counts and nearby pages together, retaining page positions, scrolling and card focus; active forms, selectors and drag gestures postpone replacement. A late or failed read keeps the current snapshot. Explicit refresh and successful local changes reload while retaining horizontal position. Grid drafts survive switching to a board; save or discard them before managing cards. See [refresh semantics](workspace-state.md#automatic-board-refresh). This is automated behavior coverage, not a new large-dataset performance measurement.

Adding a field appends a visible column to existing views. Deleting a field removes its column, filters, and sort rules; if that hides every remaining column, the primary display field becomes visible. Affected views receive new versions. Field conversion or option removal that would make a remaining view's query invalid returns `VIEW_DEPENDENCY` with the view name; adjust that view before applying the schema change. These updates and schema writes share a transaction. Existing workspaces receive their initial view during migration without rewriting records.

Saved views with scalar filters or sorts receive SQLite partial expression indexes matching their predicate and ordering. Equal query definitions share an index; changing/deleting views or schema rebuilds or removes affected indexes in the same transaction. Option-label sorting updates when labels change. Ordinary writes maintain indexes automatically. Index creation scans existing records and refreshes planner statistics, so saving a new query or upgrading a large workspace may take several seconds. Desktop startup waits for the local service to finish migrations instead of terminating it at a fixed deadline; a process failure still reports an error. Indexes consume disk space and add write work; the default unfiltered insertion-order view uses the existing index.

Queries remain parameterized. SQLite cannot index subqueries, so array-membership predicates, relation/lookup queries, multiple-select sorts, and whole-table searches involving those types retain their existing scan path. Search over scalar-only tables can be indexed when saved in a view; temporary search overrides are not separately indexed. These operations remain supported, but the measured scalar-query timings do not establish a performance guarantee for them. See [product performance](product-performance.md) for tested workloads and limits.

Tests create and remove isolated temporary databases. No test opens a working database.

## Shared client

The `rowweave` CLI uses this same client for schema, record, view, query, conversion, and CSV operations. Run `npm run build`, then `node dist/apps/cli/src/main.js --help`; `npm run package:cli` creates an independently installable archive under `release/cli/`. See the [CLI guide](../apps/cli/README.md) for JSON/stdin inputs, output/exit codes, and connection settings. Linux CI uploads the `rowweave-cli` artifact. Desktop and CLI file exports share a small Node-only completed-file replacement helper in `packages/node-host`; shared UI/client code does not import filesystem APIs.

The HTTP client is also available as the standalone `@rowweave/sdk` ESM package. Run `npm run build:sdk` to build its runtime and declarations, or `npm run package:sdk` to create `release/sdk/rowweave-sdk-0.1.0.tgz`. `npm test` packs and installs it offline into an isolated application, type-checks public imports, and exercises a real temporary service. See the [SDK guide](../packages/client/README.md) and [HTTP API reference](http-api.md). Linux CI uploads the installable `rowweave-typescript-sdk` artifact. The package remains private and is not published to a registry.

CSV service endpoints and client methods provide preview, mapped atomic import, and table/view export. Desktop **Import CSV** and **Export CSV** use these same operations. See [data-exchange.md](data-exchange.md) for the workflow, request format, value semantics, limits, and regression evidence.

`packages/client` exposes `createWorkspaceClient(connection)` for table, field, conversion, record, query, and saved-view operations. Its `table(id)` adapter supplies the host-independent `TableModel` used by the workspace UI. Requests support cancellation and never retry writes automatically.

The model uses query pages with data revisions. Its default page size is 100 records, its LRU cache holds at most 12 pages, and it permits at most four page requests in flight. Drafts are keyed by record ID and retained separately within the service's batch limits, so scrolling, sorting, filtering, or hiding a field cannot silently discard or redirect them. `setQuery` changes filters/sorting/projection, `rowCount` reflects the result count, and `fields` follows the selected field order. Paste follows this visible order. `pendingRecords` exposes retained drafts, including records hidden by the current query.

`readViewport` retains the current visible records separately from the page LRU, within the same batch limit. Collapsed groups can place records from more than 12 different pages on screen; loading another page or copying a selection must not remove those visible values. A completed window replaces the previous window, while late older requests cannot replace a newer one. Retained records contain saved values so draft undo/redo still overlays the current edit state. Query invalidation, saving and disposal release the window. Regression coverage uses 1,414 records in 28 alternating collapsed and expanded groups: 14 visible records span 14 pages while the ordinary cache remains at 12 pages.

Large paste and clear operations read the selected rows in batches of up to 500, separately from the 100-row display cache. This reduces repeated metadata/count requests without enlarging normal scrolling pages or evicting the visible page. Batch and display reads share the four-request limit; all batch pages use the current data revision and schema/view checks. A late failure stages no partial edit. Query changes and disposal cancel pending batch reads, and a late response cannot change the new view.

Saving is explicit. A failed request retains the pending values; version conflicts require deliberate resolution. Discard-and-reload replaces local drafts with the latest stored values. The UI must confirm before invoking that operation when edits are pending. Responses from an older cache generation cannot overwrite a completed save.

`refresh` retains drafts while reloading current schema/data; `discardAndReload` explicitly clears them. A changed data revision stops stale page loading until refresh/save. A successful save invalidates the query cache because edits may change filtering or order. If the subsequent refresh fails, the model reports that the changes were saved and does not resend them. Dispose a model when its panel closes to abort outstanding reads and remove listeners.

Draft undo/redo stores complete editing actions, including rectangular paste, up to 100 actions and 60,000 changed cells of history. Undo history ends on save, discard, query changes, or refresh; retained drafts remain editable. The grid exposes Undo/Redo buttons and Ctrl+Z/Ctrl+Y (or Ctrl+Shift+Z), scoped to its panel. Text editing retains its native undo behavior while a cell editor is open.

## Delivery scope

The [completion plan](completion-plan.md) defines the current product scope and measurable acceptance criteria; [acceptance.md](acceptance.md) maps the workflows to verification and provides the owner's final walkthrough. Merge each focused PR after its checks pass, then start the next dependent change from updated `main`. The desktop target is Windows; service tests also run on Linux.

## Desktop

Run `npm start` to build the production renderer, install the pinned Electron binary if needed, and open the app. Electron's binary download requires network access on the first run. Use `npm run test:desktop` for workspace lifecycle, connection, and grid smoke tests; they use temporary workspaces. The grid smoke test uses the native clipboard, so avoid changing the clipboard during that test. After a build, `node apps/desktop/tests/workspace.mjs` and `node apps/desktop/tests/connections.mjs` run the offscreen workspace/connection tests without native clipboard access. `ROWWEAVE_HEADLESS=1` uses offscreen rendering without showing a window or background throttling; it is not used for performance measurements or native IME verification.

In local mode, the Electron host starts the HTTP/SQLite service in a separate utility process identified as `rowweave-data-service`. Its narrow preload bridge supplies the connection and host dialogs to the shared React UI; the renderer has no Node.js integration. SQLite never runs in the main or renderer process. The default database is `prototype.sqlite` under `%APPDATA%\RowWeave` on Windows. This profile directory follows the Windows naming exception and remains unchanged when the executable is named `rowweave.exe`. `ROWWEAVE_DATA_DIR` selects an isolated workspace and browser profile.

The desktop's **Connection** dialog switches between that local workspace and an independently operated service after edits are saved/discarded. Remote credentials are encrypted with asynchronous safeStorage and persisted in the profile; failed validation or persistence leaves the old connection active. Switching to remote mode stops the bundled service; the desktop never starts or stops the independently operated service. Renderer HTTP(S) requests are restricted to the active service origin through the Electron session. See [desktop connections](connections.md) for setup and recovery. Shared UI receives only a label and settings callback; it does not import Electron connection APIs.

Double-click a cell or press Enter to edit. Enter commits a draft, Escape cancels it, arrow keys move the selection, and Shift+arrows extend it. Copy and paste use plain-text TSV, preserving Unicode, quoted multiline cells, and trailing empty values. Save explicitly with Ctrl+S or **Save changes**. Closing with drafts requires confirmation. On conflict, drafts stay visible for copying before a deliberate discard/reload.

Grid editors use date/time inputs and select controls with stable option IDs; checkboxes toggle directly with a click or Space. Timestamps are entered in UTC. Invalid values remain in the editor with an error until corrected or canceled with Escape. Tab/Shift+Tab commit and navigate, Shift+Enter inserts a line break, and Ctrl+S commits valid input before saving. Opening and closing an unchanged empty text cell preserves its stored null value.

Delete clears the selected rectangle, rows, or columns as one undoable draft action. It loads the full selection even when some rows are outside the page cache, validates the whole operation, and never partially clears required fields. Text becomes an empty string; other types become null. Clear, paste, and save share the 2,000-record/20,000-cell limits. The offscreen suite checks keyboard behavior, typed persistence, synthetic composition, validation retention, and atomic clearing. Final native Pinyin and Excel clipboard evidence is recorded in [product-performance.md](product-performance.md#final-native-interaction-checks).

The grid's default TSV parser confuses Unicode code points with UTF-16 offsets; the UI intercepts spreadsheet paste with a bounded parser and tests this behavior. Grid copy uses quoted TSV without the library's HTML representation, which collapsed multiline text in native Excel. Tests check literal markup, Unicode, multiline values, empty cells and native clipboard formats. Transitive minimatch and glob dependencies are overridden to patched versions for the grid and packaging tools; dependency upgrades must preserve the audit check, clipboard tests, and packaged-app smoke test.

The automated smoke test covers editing, cancellation, unsaved-close protection (including text still in the editor), keyboard selection, the Windows clipboard, 1,000 × 10 paste/save, a synthetic composition guard, conflict feedback, restart persistence, and service failure. Synthetic composition events do not establish native Chinese IME compatibility.

The original fixed-schema prototype's Chinese input was separately exercised on Windows on 2026-11-12 with the installed Pinyin input method: its candidate window appeared, Space selected a Chinese candidate, Escape canceled composition without closing the editor, and Enter confirmed composition without prematurely submitting the cell. Ctrl+S saved the mixed Chinese/Latin value, and a separate read-only SQLite connection verified persistence. Later initial-product native checks are recorded in [product-performance.md](product-performance.md). The [current candidate report](connected-workflow-validation.md) identifies its remaining native checks; historical results do not establish behavior of the newer binary.

## Windows package

```sh
npm run package:win
npm run test:packaged
```

Build on Windows x64. Each build creates a timestamped directory under `release/`, containing the application folder, a portable ZIP, and its SHA-256 checksum. `release/latest.json` identifies the latest executable and archive, the source revision, and whether the build used uncommitted changes. Extract the entire ZIP, then open `rowweave.exe`; Node.js is not required on the target machine. The package is unsigned and portable; it does not install shortcuts or provide automatic updates.

Packaging stages only compiled runtime files and third-party notices, with no test databases or development dependencies. A verified Electron ZIP in `.artifacts/` can be reused; otherwise the packager downloads the pinned runtime. The packaged smoke test verifies the archive checksum, extracts it to a temporary directory outside the repository, and runs the same edit/save/restart checks from that location with an isolated workspace.

Windows CI packages and tests the app, then publishes the `rowweave-windows` artifact for 14 days. Download it from the successful [workflow run](https://github.com/euyuil/rowweave/actions), extract the inner application ZIP, and launch the executable. Performance benchmarks are local measurements, not CI timing thresholds.

## Reproducible pressure datasets

For current-time calculations, build first and run `node scripts/benchmark-clock.mjs` for explicit refresh, or `node scripts/benchmark-background-calculations.mjs` for concurrent HTTP reads during automatic startup refresh. Each creates an isolated 100,000-record workspace and verifies saved results/versions. Run these measurements separately from tests and each other. See [clock calculation measurements](clock-calculation-performance.md) for workload, hardware, raw samples and remaining desktop acceptance.

Build once before generating data. These commands require new destination files and refuse to overwrite existing workspaces:

```sh
npm run build
npm run dataset -- .artifacts/data-10k/prototype.sqlite 10000 20
npm run dataset -- .artifacts/data-100k/prototype.sqlite 100000 100
npm run dataset -- .artifacts/typed-10k/prototype.sqlite 10000 20 --typed
npm run dataset -- .artifacts/typed-100k/prototype.sqlite 100000 100 --typed
```

Set `ROWWEAVE_DATA_DIR` to the containing directory before launching the desktop app to inspect a dataset. Values deterministically include Chinese, emoji, nulls, and long text. The original text-only generator uses prepared inserts in one transaction. `--typed` creates a workspace through the service's schema and record operations, with ten leading text columns for rectangular paste, followed by numbers/currency/percent, checkboxes, dates/timestamps, selects, multiline text, and reference text. Larger schemas repeat that typed set. Field/option/record IDs are generated normally; field names, value distribution, and row order are reproducible. Typed generation uses bounded transactions and can leave a partial generated dataset if interrupted; use a new destination for another run. Never use a working database as the destination.

After packaging, run `npm run benchmark`. It creates fresh mixed-type databases under a timestamped `.artifacts/benchmarks/` directory, performs three instrumented launches per size, and records startup, 100 input-to-frame samples after ten warm-up inputs per launch, 1,000 × 10 paste/save, five scrolling circuits, per-process memory/CPU, display settings, and runtime versions in `results.json`. Query measurements cover the first page, numeric range, compound numeric/checkbox filter, primary text sort, and numeric sort. Each uses a saved view and records preparation, first request, and twenty samples after two warm-up requests; timings include authenticated HTTP and JSON decoding. Percentiles use the nearest-rank method, and raw input/query/frame samples retain outliers.

A separate forced-GC diagnostic follows the timed scrolling workload. The benchmark opens test windows and sends real keyboard input through browser automation. Paste dispatches a DOM clipboard event through the application's parser and staging path, without replacing the system clipboard; native clipboard interoperability is a separate final check. Avoid other workloads during acceptance measurements. Generated datasets and raw reports stay out of Git; the original [prototype validation](validation.md), [initial product performance](product-performance.md) and [current candidate report](connected-workflow-validation.md) distinguish historical results, preliminary baselines, and final gates.

For memory attribution, run `npm run benchmark:memory -- <results.json>` using that report's path. It reuses only those generated workspaces and performs five scrolling circuits through the main-process Node inspector, without attaching a renderer debugger or recording HTTP response bodies. It writes `memory-without-renderer-debugger.json` beside the original report. Keep these measurements separate from the Playwright run; summed process working sets include shared pages and are not unique physical RAM usage.

Use `npm run benchmark -- --timings-only` to repeat startup, input, paste, and save measurements without the scrolling workload. A failed memory run can resume completed dataset checkpoints with `--resume`, provided the packaged archive checksum is unchanged.

For calculated-field service workloads, build once, then run `node scripts/benchmark-formulas.mjs` or `node scripts/benchmark-linked.mjs`. They create isolated databases under `.artifacts/` and retain raw timings and machine/source metadata. These direct service calls measure formula recalculation and linked-summary query costs without HTTP or UI overhead; see the [candidate report](refinement-validation.md#calculated-field-service-measurements) for dataset definitions and measured limits.

For connected formulas and grouped date workflows, run `node scripts/benchmark-connected.mjs` and `node scripts/benchmark-grouped-dates.mjs` after building. Run benchmarks sequentially after GUI tests finish. The [connected-workflow report](connected-workflow-validation.md) records their datasets, raw report locations, exact source, timings and remaining performance gaps.
