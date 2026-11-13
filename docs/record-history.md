# Record history and snapshot restoration

The service retains committed record changes in the workspace database. Desktop, SDK, CLI, MCP and CSV writes use the same transaction journal. A change contains the record's stored values, version and formula errors before and after the transaction, a batch ID and a service timestamp. Creates have no before snapshot; deletes have no after snapshot.

Each record has at most one history entry per transaction. Reciprocal relationship updates and stored formula recalculations share the initiating batch and coalesce intermediate values into the final snapshot. Failed writes roll back their journal entries too. Lookup values and display labels are resolved on read and are not historical snapshots; inspect the target record's changes for its stored values. History does not invent actor names or reconstruct changes made before the upgrade.

## Inspect and restore

`recordHistory(tableId, recordId, { limit?, before? })` returns newest-first metadata only, defaulting to 20 entries and allowing at most 100. Pass `nextBefore` as `before` to continue without shifting the page when newer changes arrive. Fetch one complete entry with `recordChange(tableId, recordId, changeId)`.

To restore an existing record, send `{ changeId, snapshot: 'before' | 'after', expectedVersion }` to `restoreRecord`. Read the current record version first. The service writes current writable fields present in the selected snapshot, keeps fields added later, and leaves deleted fields deleted. Renaming a field does not affect its stable ID. Current types, option IDs, required constraints and relationship cardinality/targets must accept every restored value. An incompatible historical value fails the entire operation; it is not silently converted or replaced.

Restoration preserves the record UUID, advances its version, recalculates formulas with current definitions and target values, updates reciprocal links, and records a new change with `restoredFrom: { changeId, snapshot }`. Never retry an uncertain restoration automatically. Read current state and history first.

```ts
const page = await api.recordHistory(tableId, recordId, { limit: 20 });
const selected = await api.recordChange(tableId, recordId, page.changes[0]!.id);
const current = await api.getRecord(tableId, recordId);
await api.restoreRecord(tableId, recordId, {
  changeId: selected.id,
  snapshot: 'before',
  expectedVersion: current.version,
});
```

The chosen side must contain a record. This API restores saved values into an existing record. Use trash restoration for a deleted record, as described below. Table deletion removes its records and history. There is no automatic history expiration in this version, so journal storage grows with committed changes. Backups include it; copying a workspace or backup copies its historical values too.

## Deleted records

`recordTrash(tableId, { limit?, before? })` returns a bounded page of currently deleted records, newest deletion first, with the same 20-default/100-maximum cursor limits. Each entry contains its UUID, `deletionId`, transaction `batchId`, deletion timestamp, last saved version and stored primary display value. It omits complete snapshots; fetch one with `recordChange(tableId, id, deletionId)`. Changing the primary display field uses that field's stored value, or null if it did not exist in the snapshot.

Send an array of `{ id, deletionId, values? }` to `restoreDeletedRecords`. The service atomically restores up to 2,000 records and 20,000 writable cells. Only each record's latest deletion is eligible, and a live record cannot be overwritten. A repeated request, an obsolete deletion ID, or a concurrent restore fails with `VERSION_CONFLICT`; refresh trash before deciding what to do next.

Restoration preserves each UUID and uses its last saved version plus one, rejecting writes based on a pre-deletion version. It appends restored records to the table in request order; original row positions are not retained. Current fields receive their stored values, or current defaults/null when added after deletion. Removed fields stay removed. Formulas use current definitions and target values, and reciprocal relationships are rebuilt. Every directly restored record references its own deletion entry in `restoredFrom`, and all resulting changes share one transaction batch.

Current required/type/option/relationship constraints apply to the entire batch. To repair an incompatible historical value, explicitly supply that writable field in `values`; unknown and computed fields are rejected. Missing linked targets or occupied single-link reverse fields reject the whole batch. A closed set of mutually linked records in one table can be restored together. Restore deleted targets in other tables first, or explicitly repair the links; there is no silent unlinking. Inspect current schema and snapshots before choosing repairs.

```ts
const trash = await api.recordTrash(tableId, { limit: 20 });
const deleted = trash.records[0]!;
const snapshot = await api.recordChange(tableId, deleted.id, deleted.deletionId);
// After reviewing snapshot.before and the current schema:
await api.restoreDeletedRecords(tableId, [{ id: deleted.id, deletionId: deleted.deletionId }]);
```

Trash survives restart and backup/restore. Desktop, HTTP, SDK, CLI and MCP share the same recovery rules.

## Inspect a complete transaction

`recordBatches(tableId, { limit?, before? })` lists committed transactions that affected a table, newest first. Each receipt contains a stable batch ID, sequence, service timestamp, original `recordCount`, current `remainingCount`, and `recordWrite`. Sequence cursors remain stable when newer writes arrive. Pages default to 20 receipts and allow at most 100.

`recordBatchChanges(tableId, batchId, { limit?, before? })` returns the receipt and a bounded metadata page of all affected records across tables. Each change includes `tableId`; use it with `recordId` and the change ID to fetch a snapshot through `recordChange`. A reciprocal-link update and its calculated effects belong to the same transaction, even when they affect another table. Read every page when reviewing a complete operation.

Receipts capture the final coalesced record count in the same transaction as the write. Failed writes leave neither changes nor receipts. `recordWrite: true` identifies record creation, updates, deletion, CSV import or restoration. Schema-driven value conversions and recalculations have `recordWrite: false`; a record operation must not be mistaken for a schema undo.

Deleting a table removes its snapshots and table-to-batch associations, but keeps the receipt's original count. A surviving related table can therefore show that `remainingCount` is smaller than `recordCount`; the remaining entries are not a complete original batch. Receipt metadata is retained with history and included in backups.

Receipts start with workspace format 18. Older record history remains available through individual history APIs, but no original transaction size is invented: earlier entries may already have been removed with their tables. Legacy batch IDs return `HISTORY_NOT_FOUND` from receipt inspection.

## Undo a saved batch

After inspecting a complete transaction, call `undoRecordBatch(tableId, batchId)`. The service reverses the complete record operation, including changes to other tables through reciprocal links and stored calculations. Created records are deleted, edited records receive their prior writable values, and deleted records are recreated with their original UUIDs. Recreated records append to their tables. Existing later-added fields keep their current values; recreated rows use current defaults/null for later fields. Removed fields and schemas are not recreated, and formulas recalculate with current definitions and targets.

An optional field may have no stored key before its first assignment. If it appears in the operation's after snapshot, undo restores that prior emptiness to null, including both sides of newly assigned reciprocal links. This differs from fields absent on both sides of the historical operation, whose later values are retained.

Every record must still match the original transaction's final version. A deleted record must still have the same latest deletion entry and remain absent. One stale or missing record rejects the entire operation with `VERSION_CONFLICT`. Updates to unrelated records are preserved. Current field, relationship, required-value and deletion-dependency rules apply. Relationship assignments are validated as a single final graph, allowing complete reciprocal swaps and closed self-linked batches. A late failure rolls back every record, edge, revision and journal entry.

Only complete record-operation receipts can be undone. Schema batches return `INVALID_HISTORY`; receipts missing changes after table deletion return `HISTORY_INCOMPLETE`. An undo is limited to 2,000 original affected records, including indirect changes, and 20,000 current writable cells to restore. Larger operations return `INVALID_BATCH` without partially undoing them. Inspect and deliberately restore individual records or deleted sets when a complete batch is no longer eligible.

The result is `{ batchId, undoneBatchId }`. The new receipt records `undoOf`, and each directly reversed change references its original entry in `restoredFrom`. Undoing that new batch provides redo, subject to the same current-version and schema rules. A repeated request against the original batch fails; no write is automatically retried. If a response is lost, inspect current transaction history before deciding the next action. Batch IDs and undo links survive restart and backup/restore.

```ts
const page = await api.recordBatchChanges(tableId, batchId);
// Review every affected page and current schema before undoing.
const undo = await api.undoRecordBatch(tableId, page.batch.id);
// A later deliberate redo, if no affected record has changed:
await api.undoRecordBatch(tableId, undo.batchId);
```

HTTP, SDK, CLI and MCP expose saved-batch undo. Record creation, update and trash-restoration responses include their own `batchId` alongside `records`. Clients should retain that receipt when offering to undo their last save; querying the newest operation could select another client's later write. The SDK's optional property also permits existing compatible clients that do not supply a receipt. The grid's existing Undo/Redo controls still apply to unsaved drafts.

## Desktop workflow

Open a record from a grid or board, then choose **History** in the details panel. History loads ten changes at a time with **Older changes**, **Newer changes** and **Refresh history** controls. Selecting a change compares its stored before/after values, including empty text, nulls, zero, false and formula errors. Select options use current labels when available; historical links keep their stable IDs.

Choose **Restore before change** or **Restore after change** to preview the writable values that differ from the record you opened. The confirmation compares that record's values against the selected snapshot, so later edits outside the original historical difference are visible too. **Restore values** makes one version-checked write. Success closes the panel and refreshes the active view; a conflict stays visible and does not retry the write.

You may inspect history while a form has unsaved changes, but restoration stays disabled. Switching back to **Details** preserves the draft. Closing the panel still asks whether to keep editing or discard it. Details/history navigation stays available while scrolling, and a failed restoration moves focus to its error message.

Choose **Trash** in a table's record toolbar after saving or discarding grid edits. Browse ten deletions per page, inspect saved values and select records across pages. **Select page** adds that page to the selection; **Clear selection** removes the selection. The selection limit accounts for the table's writable field count and the service's batch limits. Before restoring, the confirmation lists the selected records and explains the all-or-nothing behavior.

Open a deleted record, then expand **Adjust values for restoration** to repair current writable fields. The saved-value comparison retains removed fields, formula errors and original typed values. If a saved value is incompatible with its current field, the editor explicitly asks for a replacement; it does not silently convert that value. Later fields start with their current defaults. Adjustments survive paging and failed restoration; refreshing or closing asks before discarding them. A successful restore refreshes the active view and reports the restored count. A stale deletion or other conflict stays visible without automatically retrying the write.

Choose **Saved changes** to browse complete operations after saving or discarding grid edits. Operations and affected records each load ten entries per page, including indirect changes in other tables. Inspecting one affected record loads its before/after snapshot and current field labels. Schema operations, incomplete history and oversized batches explain why whole-operation undo is unavailable.

After saving grid edits, **Undo saved change** opens that save's exact receipt, even if another client has since written to the table. **Undo operation** asks for confirmation before reversing all affected records across pages and tables. Cancellation makes no write. Success refreshes the view and offers **Redo saved change**, using the new reversal receipt. A concurrent change keeps the error visible and focused; it neither retries nor overwrites newer values. Other saved creations, deletions and restorations can be reviewed and reversed through **Saved changes**. Historical links display stable IDs, and restoring values follows the current schema rules above.

## Storage and verification

Workspace format 16 introduced the journal; format 17 added the trash query index; format 18 added transaction receipts and indexed table associations; format 19 adds receipt undo links. Migration preserves existing records, UUIDs, versions, views, schemas, journal entries and receipts without creating fictitious past events. The first subsequent edit captures the previous stored state. Service connections install temporary SQLite triggers on `main.records`, with transaction-local context; this captures indirect writes without spreading journal calls across relationship and calculation code. Direct SQLite edits outside the service are unsupported and are not journaled. Online backup/restore retains the durable journal, not the temporary connection context. Older programs reject newer workspace formats.

Regression coverage includes typed snapshots, rollback after a late batch conflict, stable pagination, current-schema restoration, retained later fields, recalculated formulas, missing targets, reverse links, coalesced calculations, multiple connections, CSV/conversion writes, restart, backup, migration, authenticated HTTP/SDK and real CLI/MCP subprocesses. Trash tests cover deletion cycles, stale requests, explicit field repairs, reciprocal cardinality, late rollback and closed self-linked batches. Automated desktop acceptance verifies history pagination, keyboard entry, before/after comparison, current-value preview, draft retention, cancellation, stale restores and successful restoration with recalculation. Trash acceptance covers cross-page selection and adjustments, Unicode/zero/false snapshots, confirmation cancellation, concurrent restoration, current-type repairs and defaults added after deletion. Saved-batch tests cover final-graph swaps, undo/redo version cycles, current constraints, incomplete/oversized rejection, late rollback, restart and backup. Desktop saved-operation acceptance covers exact save receipts, paging both lists, cancellation, draft guards, undo/redo, deletion recovery, concurrent edits and ineligible schema operations. Native input-method checks remain a final-candidate task in [the active delivery plan](gap-closure-plan.md).
