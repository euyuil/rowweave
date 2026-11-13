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

This endpoint provides detection only. A UI must retain drafts, active editors and composition state, and recheck those conditions immediately before applying fetched data. Keep using query schema/data/view/date-context guards when loading subsequent pages. Do not infer that a matching metadata response makes a later write conflict-free. Automatic desktop refresh is tracked separately in the [workflow gap plan](gap-closure-plan.md).
