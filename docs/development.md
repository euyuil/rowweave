# Development

Use Node.js 24.22.1 and npm 11.19.1. The repository uses strict TypeScript and ESM. Run commands from the repository root.

```sh
npm ci
npm run check
npm run build
npm test
```

On Windows, use `npm.cmd` if PowerShell execution policy prevents `npm` from running.

## Standalone service

Set `ROWWEAVE_TOKEN` to a random secret of at least 32 characters, then run `npm run start:server`. Do not commit this value or put it in a URL. `ROWWEAVE_DB` optionally selects the database (default: `.data/prototype.sqlite`), and `ROWWEAVE_PORT` selects the port (default: 4317). The prototype listens only on 127.0.0.1.

Requests use `Authorization: Bearer <token>`:

- `GET /tables/prototype`: field definitions and record count.
- `GET /tables/prototype/records?offset=0&limit=100`: records in a stable order, with at most 500 per page.
- `PATCH /tables/prototype/records`: a JSON array of `{ id, expectedVersion, values }` updates, where `values` maps stable field IDs to typed values. The entire batch commits or rolls back together. Successful records return their incremented versions. A stale version returns HTTP 409; reload before explicitly resolving the conflict.

Write limits are 2,000 distinct records, 20,000 changed cells, 10,000 UTF-16 code units per text value, and an 8 MiB JSON request body. Duplicate IDs and unknown fields are rejected. Empty strings and nulls remain distinct in storage.

A new database starts empty. Create a table from the desktop sidebar or `POST /tables`; deterministic datasets are only created explicitly by tests and `npm run dataset`. Opening an existing database never reseeds deleted tables. Node's built-in SQLite driver runs only in the service.

### Dynamic tables and schema

The service supports multiple tables with stable table, field, and record IDs. The desktop supports creating, switching, renaming, and deleting tables, with unsaved-edit navigation guards and explicit deletion confirmation. **Manage fields** adds/configures fields, selects the primary display field, changes field order, and confirms deletion. Forms expose the supported types, number formatting, options, required values, and defaults. Save or discard grid drafts before changing schema; changes use the displayed schema version and reject stale writes.

- `GET /tables`: list table definitions and counts.
- `POST /tables`: create an empty table with `{ "name": "Projects" }` and an initial **Name** field.
- `GET /tables/:tableId`: read a table, including its schema `version` and `primaryFieldId`.
- `PATCH /tables/:tableId`: pass `expectedVersion` and any of `name`, `primaryFieldId`, or `fieldOrder` (every field ID exactly once).
- `DELETE /tables/:tableId`: pass `{ "expectedVersion": 1 }` in the JSON body. The table, its fields, and its records are removed atomically.
- `POST /tables/:tableId/fields`: pass `expectedVersion`, `name`, `type`, and the type's configuration described below.
- `PATCH /tables/:tableId/fields/:fieldId`: pass `expectedVersion` and changed field settings. Type changes require the separate conversion workflow; they are not silently coerced by this endpoint.
- `DELETE /tables/:tableId/fields/:fieldId`: pass `expectedVersion`. Choose another primary field before deleting the primary field. Existing cell values are removed and affected record versions increment atomically.
- The existing paginated record reads and atomic updates work at `/tables/:tableId/records` for any table.

Schema writes return the updated table and increment its schema version. A stale version returns HTTP 409 with `SCHEMA_CONFLICT`; reload schema before retrying. Names contain 1–200 characters and tables support up to 200 fields. A newly added text field has no stored values until edited; an absent field value means null. Renaming and reordering do not rewrite record identities or values. Set `precision: null` in a number-field update to restore automatic decimal formatting without changing stored values.

SQLite stores relational table/field/view metadata and JSON record values, with a table/position index. Format version 3 added a persistent data revision; version 4 adds saved views. Opening older databases migrates transactionally, preserving field IDs, record IDs, positions, values, and record/schema versions. A failed migration rolls back; unsupported newer formats fail without replacing their schema. Back up a working database before upgrading; do not copy a live database without its pending WAL state.

### Typed values and record lifecycle

| Field type | JSON value and configuration |
| --- | --- |
| `text`, `multiline` | String up to 10,000 UTF-16 code units, or null. Empty strings remain distinct from null. |
| `number` | Finite JSON number. Optional `numberFormat`: `decimal`, `currency`, or `percent`; `precision`: 0–10; currency formatting requires a three-letter uppercase `currency` code. Formatting never rounds stored values. Percent values use fractions: `0.5` displays as 50%. |
| `checkbox` | Boolean; false is a valid required value. |
| `date` | Valid `YYYY-MM-DD` calendar date. |
| `datetime` | ISO timestamp with seconds and an explicit zone (`Z` or an offset), normalized to UTC. |
| `singleSelect` | An existing option ID or null. |
| `multiSelect` | Array of unique existing option IDs, or null. |
| `relation` | Ordered array of unique record IDs from one target table, or null. Configure `relation: { tableId, multiple }`; allow one or up to 200 linked records. |
| `lookup` | Read-only array of scalar values from linked records. Configure `lookup: { relationFieldId, fieldId }`; returned `lookupResult` describes the current target field. |

Select fields have up to 200 `options`, each with `name`, optional `color` (`#RRGGBB`), and optional `id` on creation. The service generates missing IDs. Retain returned IDs when renaming options. IDs and names must be unique within the field. Removing an option still used by a record is rejected atomically.

Writable fields accept `required` and `defaultValue`. Defaults apply only when a new record omits that field; explicit null does not apply the default. Passing `defaultValue: null` clears a configured default. Required text must not be blank, required multi-select must contain an option, and required fields reject null. To add a required field to a populated table, add it as optional, populate it, then enable `required`; enabling it checks all existing values transactionally.

- `POST /tables/:tableId/records`: array of `{ values }` objects; returns `{ records }` with generated IDs and version 1. Creation is atomic and uses the same 2,000-record/20,000-cell limits (including defaulted cells).
- `GET /tables/:tableId/records/:recordId`: fetch one record by stable ID.
- `DELETE /tables/:tableId/records`: array of `{ id, expectedVersion }` objects; returns `{ deleted: [id, ...] }`. A missing/stale record rolls back the whole batch.

The desktop's **New record**, **Open record**, and **Duplicate** actions use typed forms with defaults, select option labels, multiline text, and UTC date-time inputs. Optional values can be cleared to null; an empty text value remains a string. Details load the complete record, including fields outside the visible grid. A failed validation or version conflict retains the form. Save or discard grid drafts before managing records. Select cells or row checkboxes, then **Delete records** to preview and confirm a versioned batch deletion (up to 2,000 records); cancellation leaves data unchanged.

The grid retains its text editor until the dedicated typed-editor workflow is introduced, but renders typed values and parses typed edits/paste. Select clipboard values use option names; multi-select uses a JSON array of names. Number input uses decimal notation, checkboxes use `true`/`false`, and blank non-text input means null. Invalid cells reject the complete pasted rectangle and preserve existing drafts. Service writes always validate again.

### Linked records

Create a **Linked records** field, choose its target table, and choose whether it allows multiple records. Defaults and required values work with linked IDs. Record forms, grid editors, and filters use a searchable picker with 50-record pages; selected records stay available outside the current search/page. Click a selected name to view the target's full record details. The primary display field must be a non-linked field, preventing circular labels.

Record responses keep IDs in `values` and include `links: { fieldId: [{ id, label }] }` for display. The service resolves labels within the same read snapshot, without a request per cell. Changing target records or schema advances the source tables' data revisions, so continuation pages cannot combine old labels with new data. Search and sorting use the target's primary labels; `hasAny` filters use record IDs. Clipboard relation values use JSON arrays of IDs to avoid ambiguous duplicate names. Query `recordIds` accepts up to 2,000 distinct IDs and can be combined with filters/projection to resolve a picker selection in one request.

SQLite format 5 adds indexed relation edges and field-to-target dependencies. JSON IDs and their edge index change in the same transaction. Foreign keys protect targets; input validation also checks table ownership, uniqueness, cardinality, and defaults. Invalid links or a late version conflict roll back the complete batch. Linked fields cannot be converted to/from ordinary fields; create the field and assign IDs explicitly. Unlink existing values before retargeting a field to another table.

Deleting referenced records returns `RELATION_DEPENDENCY` until external links and linked-field defaults are removed. A single batch may delete a self-linked set when nothing outside that set refers to it. Deleting a source record/field removes its outgoing edges. Deleting a target table requires removing fields in other tables that point to it, even if those fields are empty. Deletion failures retain all data and edges.

### Read-only lookups

Add a **Lookup** field, choose an existing linked-record field, and select an ordinary field in its target table. The service computes values from saved links in link order, preserving numbers, booleans, timestamps, text, select IDs, and nulls. Multiple-select values are flattened without deduplication; no links produce an empty array. A lookup cannot target another lookup or a linked-record field, become a primary field, set defaults, or require values. This is a one-hop lookup, not a formula engine.

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

### Saved grid views

The desktop view selector switches between saved views without losing record drafts. **New view** copies the current configuration; **View settings** renames a view and saves search text, filters, sorting, column visibility, order, and width. Build nested AND/OR groups with typed operands and reorder multiple sort rules by priority. Empty AND groups match every record; empty OR groups match none. The search box temporarily overrides that view's search, waits until typing pauses, and defers requests during IME composition. The selected view is remembered per table on this device. Deleting a view leaves its records intact; every table retains at least one view.

Desktop pagination uses the saved view ID and version as well as the data revision. A concurrent view/schema change stops stale loading and retains drafts. **Refresh view** fetches current metadata while keeping drafts (and resets undo history); **Discard edits** asks before removing drafts. Configuration dialogs retain inputs when their own versioned save conflicts. Record details and duplication include fields hidden from the grid.

Every table starts with an **All records** view. A view contains a stable `id`, `tableId`, `name`, independent `version`, saved `query` (`filter`, `sort`, `search`), and ordered `columns` (`fieldId`, `width`, `hidden`). At least one column and one view remain visible/available. Column widths range from 50 to 1,000 pixels.

- `GET /tables/:tableId/views`: list saved views.
- `POST /tables/:tableId/views`: create with `{ name, query?, columns? }`. Omitting columns shows all fields in schema order; a supplied column list includes every field once.
- `GET /tables/:tableId/views/:viewId`: read one view.
- `PATCH /tables/:tableId/views/:viewId`: pass its `expectedVersion` and changed `name`, `query`, or `columns`. Query/columns replace the corresponding configuration; use `query: {}` to clear saved conditions. A stale version returns `VIEW_CONFLICT`.
- `DELETE /tables/:tableId/views/:viewId`: pass `expectedVersion`; the last view cannot be deleted.
- `POST /tables/:tableId/views/:viewId/query`: apply the saved query. The request accepts `offset`, `limit`, `expectedRevision`, `expectedViewVersion`, optional output `fields`, and an optional temporary `search` override. By default only visible columns' values are returned. The response adds `viewId` and `viewVersion`; pass both revision/version checks when continuing pages.

Adding a field appends a visible column to existing views. Deleting a field removes its column, filters, and sort rules; if that hides every remaining column, the primary field becomes visible. Affected views receive new versions. Field conversion or option removal that would make a remaining view's query invalid returns `VIEW_DEPENDENCY` with the view name; adjust that view before applying the schema change. These updates and schema writes share a transaction. Existing workspaces receive their initial view during migration without rewriting records.

Tests create and remove isolated temporary databases. No test opens a working database.

## Shared client

CSV service endpoints and client methods provide preview, mapped atomic import, and table/view export. Desktop **Import CSV** and **Export CSV** use these same operations. See [data-exchange.md](data-exchange.md) for the workflow, request format, value semantics, limits, and regression evidence.

`packages/client` exposes `createWorkspaceClient(connection)` for table, field, conversion, record, query, and saved-view operations. Its `table(id)` adapter supplies the host-independent `TableModel`; `createHttpClient` still selects the existing prototype table for the current desktop entry point. Requests support cancellation and never retry writes automatically.

The model uses query pages with data revisions. Its default page size is 100 records, its LRU cache holds at most 12 pages, and it permits at most four page requests in flight. Drafts are keyed by record ID and retained separately within the service's batch limits, so scrolling, sorting, filtering, or hiding a field cannot silently discard or redirect them. `setQuery` changes filters/sorting/projection, `rowCount` reflects the result count, and `fields` follows the selected field order. Paste follows this visible order. `pendingRecords` exposes retained drafts, including records hidden by the current query.

Saving is explicit. A failed request retains the pending values; version conflicts require deliberate resolution. Discard-and-reload replaces local drafts with the latest stored values. The UI must confirm before invoking that operation when edits are pending. Responses from an older cache generation cannot overwrite a completed save.

`refresh` retains drafts while reloading current schema/data; `discardAndReload` explicitly clears them. A changed data revision stops stale page loading until refresh/save. A successful save invalidates the query cache because edits may change filtering or order. If the subsequent refresh fails, the model reports that the changes were saved and does not resend them. Dispose a model when its panel closes to abort outstanding reads and remove listeners.

Draft undo/redo stores complete editing actions, including rectangular paste, up to 100 actions and 60,000 changed cells of history. Undo history ends on save, discard, query changes, or refresh; retained drafts remain editable. The grid exposes Undo/Redo buttons and Ctrl+Z/Ctrl+Y (or Ctrl+Shift+Z), scoped to its panel. Text editing retains its native undo behavior while a cell editor is open.

## Prototype PR sequence

1. SQLite persistence, paginated HTTP reads, and reproducible tooling.
2. Validated atomic batch writes and optimistic version checks.
3. A bounded client cache and explicit pending-edit/save state.
4. An Electron host and shared React grid with keyboard editing and clipboard support.
5. Packaging, deterministic pressure datasets, and recorded validation.

Merge each PR after its checks pass, then start the next dependent change from the updated `main`. The desktop target for this prototype is Windows; the service tests also run on Linux.

## Desktop

Run `npm start` to build the production renderer, install the pinned Electron binary if needed, and open the app. Electron's binary download requires network access on the first run. Use `npm run test:desktop` for workspace lifecycle and grid smoke tests; they use temporary workspaces. The grid smoke test uses the native clipboard, so avoid changing the clipboard during that test. After a build, `node apps/desktop/tests/workspace.mjs` runs only the hidden-window workspace lifecycle test without native clipboard access. `ROWWEAVE_HEADLESS=1` uses offscreen rendering without showing a window or background throttling; it is not used for performance measurements or native IME verification.

The Electron host starts the HTTP/SQLite service in a separate utility process. Its narrow preload bridge supplies the connection and host dialogs to the shared React UI; the renderer has no Node.js integration. SQLite never runs in the main or renderer process. The default database is `prototype.sqlite` under Electron's RowWeave user-data directory. `ROWWEAVE_DATA_DIR` selects an isolated workspace and browser profile.

Double-click a cell or press Enter to edit. Enter commits a draft, Escape cancels it, arrow keys move the selection, and Shift+arrows extend it. Copy and paste use plain-text TSV, preserving Unicode, quoted multiline cells, and trailing empty values. Save explicitly with Ctrl+S or **Save changes**. Closing with drafts requires confirmation. On conflict, drafts stay visible for copying before a deliberate discard/reload.

Grid editors use date/time inputs and select controls with stable option IDs; checkboxes toggle directly with a click or Space. Timestamps are entered in UTC. Invalid values remain in the editor with an error until corrected or canceled with Escape. Tab/Shift+Tab commit and navigate, Shift+Enter inserts a line break, and Ctrl+S commits valid input before saving. Opening and closing an unchanged empty text cell preserves its stored null value.

Delete clears the selected rectangle, rows, or columns as one undoable draft action. It loads the full selection even when some rows are outside the page cache, validates the whole operation, and never partially clears required fields. Text becomes an empty string; other types become null. Clear, paste, and save share the 2,000-record/20,000-cell limits. Native IME and external spreadsheet checks for the new typed editors remain pending until the final candidate; the offscreen suite checks keyboard behavior, typed persistence, synthetic composition, validation retention, and atomic clearing.

The grid's default TSV parser confuses Unicode code points with UTF-16 offsets; the UI intercepts spreadsheet paste with a bounded parser and tests this behavior. Transitive minimatch and glob dependencies are overridden to patched versions for the grid and packaging tools; dependency upgrades must preserve the audit check, clipboard tests, and packaged-app smoke test.

The automated smoke test covers editing, cancellation, unsaved-close protection (including text still in the editor), keyboard selection, the Windows clipboard, 1,000 × 10 paste/save, a synthetic composition guard, conflict feedback, restart persistence, and service failure. Synthetic composition events do not establish native Chinese IME compatibility.

Native Chinese input was separately exercised on Windows on 2026-11-12 with the installed Pinyin input method: its candidate window appeared, Space selected a Chinese candidate, Escape canceled composition without closing the editor, and Enter confirmed composition without prematurely submitting the cell. Ctrl+S saved the mixed Chinese/Latin value, and a separate read-only SQLite connection verified persistence. This is one-machine verification, not coverage of every IME or platform.

## Windows package

```sh
npm run package:win
npm run test:packaged
```

Build on Windows x64. Each build creates a timestamped directory under `release/`, containing the application folder, a portable ZIP, and its SHA-256 checksum. `release/latest.json` identifies the latest executable and archive, the source revision, and whether the build used uncommitted changes. Extract the entire ZIP, then open `RowWeave.exe`; Node.js is not required on the target machine. This prototype is unsigned and portable; it does not install shortcuts or provide automatic updates.

Packaging stages only compiled runtime files and third-party notices, with no test databases or development dependencies. A verified Electron ZIP in `.artifacts/` can be reused; otherwise the packager downloads the pinned runtime. The packaged smoke test verifies the archive checksum, extracts it to a temporary directory outside the repository, and runs the same edit/save/restart checks from that location with an isolated workspace.

Windows CI packages and tests the app, then publishes the `rowweave-windows-prototype` artifact for 14 days. Download it from the successful [workflow run](https://github.com/euyuil/rowweave/actions), extract the inner application ZIP, and launch the executable. Performance benchmarks are local measurements, not CI timing thresholds.

## Reproducible pressure datasets

Build once before generating data. These commands require new destination files and refuse to overwrite existing workspaces:

```sh
npm run build
npm run dataset -- .artifacts/data-10k/prototype.sqlite 10000 20
npm run dataset -- .artifacts/data-100k/prototype.sqlite 100000 100
```

Set `ROWWEAVE_DATA_DIR` to the containing directory before launching the desktop app to inspect a dataset. Values deterministically include Chinese, emoji, nulls, and long text. Generation constructs one row at a time and uses prepared inserts in a single transaction so an interrupted initialization cannot expose a partially seeded table.

After packaging, run `npm run benchmark`. It creates fresh databases under a timestamped `.artifacts/benchmarks/` directory, performs three instrumented launches per size, and records startup, input-to-frame, 1,000 × 10 paste/save, five scrolling circuits, per-process memory/CPU, display settings, and runtime versions in `results.json`. A separate forced-GC diagnostic follows the timed scrolling workload. It opens test windows and uses the clipboard. Avoid other workloads and clipboard changes during measurement. Generated datasets and raw reports stay out of Git; summarized measurements and their limits belong in [validation.md](validation.md).

For memory attribution, run `npm run benchmark:memory -- <results.json>` using that report's path. It reuses only those generated workspaces and performs five scrolling circuits through the main-process Node inspector, without attaching a renderer debugger or recording HTTP response bodies. It writes `memory-without-renderer-debugger.json` beside the original report. Keep these measurements separate from the Playwright run; summed process working sets include shared pages and are not unique physical RAM usage.

Use `npm run benchmark -- --timings-only` to repeat startup, input, paste, and save measurements without the scrolling workload. A failed memory run can resume completed dataset checkpoints with `--resume`, provided the packaged archive checksum is unchanged.
