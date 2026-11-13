# Workspace change state

Clients can read a small change signal without loading table schemas, records or all saved views. `POST /workspace/state` is authenticated and read-only; its JSON body is `{}`, `{ "tableId": "..." }`, or `{ "tableId": "...", "viewId": "..." }`. IDs are stable workspace IDs, not names or positions. A view requires its table ID.

```json
{
  "catalogRevision": 8,
  "table": {
    "id": "table-id",
    "schemaVersion": 4,
    "dataRevision": 21,
    "viewsRevision": 6,
    "view": { "id": "view-id", "version": 3 }
  }
}
```

- `catalogRevision` advances on table creation, deletion and name changes. Ordinary record edits do not change it.
- `schemaVersion` and `dataRevision` match the selected table's existing schema and query revisions. Data revisions include changes to linked labels and stored calculation results.
- `viewsRevision` advances when a saved view is created, updated or deleted, including schema-driven view reconciliation. The selected `view.version` matches its saved version.
- Relative-date filters add `view.dateContext`, using the same service clock, time zone and date ranges as querying that saved view. The context can change with no database write. It does not include a client's unsaved filter overrides.
- An unrequested table/view property is omitted. A requested missing table is `table: null`; a missing view, including one belonging to another table, is `view: null`.

Counters are opaque change signals within the same workspace, not operation counts, record counts or timestamps. Compare equality, then fetch the affected current data. The entire response uses one committed SQLite read snapshot; a writer's uncommitted changes remain invisible. Counters roll back with failed writes, survive restart and are included in backups. Format 28 initializes counters for older workspaces without changing saved record, field, table or view identities and versions. The endpoint never recalculates formulas or writes history.

Ordinary requests use indexed metadata reads. Relative-date views additionally read the bounded field definitions needed to interpret their filters. The response never contains table lists, records or file bytes. It is safe to poll one selected table/view with one request in flight, cancellation on disposal and a deliberate polling interval. An HTTP timeout is not a reason to retry a user write.

## Shared interfaces

```ts
const state = await client.workspaceState({ tableId, viewId }, abortController.signal);
```

The SDK defaults to catalog-only state when the request is omitted. CLI: `rowweave workspace state`, optionally with `--input state-request.json` or `--input -`. MCP exposes the read-only `workspace_state` tool with optional `tableId` and `viewId` arguments.

This endpoint provides detection only. A UI must retain drafts, active editors and composition state, and recheck those conditions immediately before applying fetched data. Keep using query schema/data/view/date-context guards when loading subsequent pages. Do not infer that a matching metadata response makes a later write conflict-free.

## Automatic grid refresh

Desktop and Harness check the selected table and view after each two-second interval, with one check in flight. Leaving the table or disconnecting cancels its reads. Read failures keep visible data and show a notice; subsequent checks use a five-second interval until recovery. No check retries a write.

For grid views, changed records, schema, saved views and relative-date boundaries load automatically when editing is idle. The client prepares the first and visible pages under schema, revision, view-version and date-context guards. It retains the visible records separately from the bounded page cache, including fragmented windows across collapsed groups. It replaces the visible snapshot only after rechecking the current query, interaction state and local history. A failed or obsolete read leaves the existing snapshot intact.

Active editors, composition, pointer gestures, clipboard reads, local drafts and undo/redo history postpone application. Open dialogs, record forms and focused workspace inputs also postpone application; an unrelated Harness host input keeps its text and focus while the table updates. A selected cell follows its record and field UUID when that record is in the fetched pages. Ranges remain selected only when their cached row and field identities still agree. Otherwise selection clears with an explicit notice before another edit can target changed positions. The grid stays mounted, and an editor follows its cell when a notice or window resize changes layout.

**Refresh view** explicitly reloads saved data/settings while retaining cell drafts and their original versions; it resets local undo history. **Reload** or **Discard edits** discards local work with the existing confirmation. An external deletion retains the visible table and edits, with a notice to choose another table. Automatic reads never silently resolve stale-write conflicts.

Grouped grids prepare their summary and visible records together against the same data revision and date context. Counts, group positions and record values change in one commit while the grid stays mounted. Collapse choices follow stable option keys within the same view and grouping field. Selection maps visual group positions through record UUIDs; a record moved into a collapsed group or outside the prepared window clears selection explicitly. Adding/removing grouping and changing saved filters use the same guarded transition. A failed summary leaves the previous groups and records available.

Boards currently detect changes and offer **Refresh view**; their automatic cache replacement is still required in the [workflow gap plan](gap-closure-plan.md).

Verification covers atomic client snapshots, cancellation, late responses, bounded paging, relative-date rollover, undo/redo protection and real service conflicts. Automated desktop acceptance covers UUID selection after sorting, schema/view changes, forms, Chinese composition events, in-flight reads, narrow-window editor alignment, failed reads, deleted views/tables and polling cleanup. Installed Harness acceptance checks refreshing while a host input retains focus. These checks do not establish native IME behavior; that remains a final-candidate check.

## Automatic table-list refresh

The workspace sidebar independently checks the catalog revision every two seconds. It fetches the table list only after a catalog change, with one poll in flight. Ordinary record changes do not reload every table's schema. Catalog read failures retain the last list, show a sidebar notice and use a five-second interval until recovery. Leaving the workspace or changing connections cancels outstanding reads.

External table creation, renaming and deletion update the sidebar without changing the selected table, active editor, local history or open form. Deleting the selected table removes its sidebar entry but retains its visible contents and drafts until the user explicitly leaves it; switching still asks before discarding local work. When an empty workspace receives its first table from another client, it offers that table in the sidebar without dismissing an open creation form or choosing on the user's behalf.

Catalog snapshots remember the revision read before fetching the list. A later change therefore remains detectable on the next poll. A response that overlaps a completed local create, rename or delete is discarded so it cannot replace that operation's immediate sidebar result. No catalog poll writes workspace data.

Automated acceptance covers empty-workspace discovery, renamed/deleted tables, Chinese editor and form focus, retained drafts after deletion, explicit navigation confirmation, late responses during local creation, read-failure recovery and metadata-only steady-state polling. Harness checks external table changes while a host input retains focus and verifies polling stops on plugin unload.
