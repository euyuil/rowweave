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

Trash survives restart and backup/restore. Desktop, HTTP, SDK, CLI and MCP share the same recovery rules. Saved batch undo remains required delivery work.

## Desktop workflow

Open a record from a grid or board, then choose **History** in the details panel. History loads ten changes at a time with **Older changes**, **Newer changes** and **Refresh history** controls. Selecting a change compares its stored before/after values, including empty text, nulls, zero, false and formula errors. Select options use current labels when available; historical links keep their stable IDs.

Choose **Restore before change** or **Restore after change** to preview the writable values that differ from the record you opened. The confirmation compares that record's values against the selected snapshot, so later edits outside the original historical difference are visible too. **Restore values** makes one version-checked write. Success closes the panel and refreshes the active view; a conflict stays visible and does not retry the write.

You may inspect history while a form has unsaved changes, but restoration stays disabled. Switching back to **Details** preserves the draft. Closing the panel still asks whether to keep editing or discard it. Details/history navigation stays available while scrolling, and a failed restoration moves focus to its error message.

Choose **Trash** in a table's record toolbar after saving or discarding grid edits. Browse ten deletions per page, inspect saved values and select records across pages. **Select page** adds that page to the selection; **Clear selection** removes the selection. The selection limit accounts for the table's writable field count and the service's batch limits. Before restoring, the confirmation lists the selected records and explains the all-or-nothing behavior.

Open a deleted record, then expand **Adjust values for restoration** to repair current writable fields. The saved-value comparison retains removed fields, formula errors and original typed values. If a saved value is incompatible with its current field, the editor explicitly asks for a replacement; it does not silently convert that value. Later fields start with their current defaults. Adjustments survive paging and failed restoration; refreshing or closing asks before discarding them. A successful restore refreshes the active view and reports the restored count. A stale deletion or other conflict stays visible without automatically retrying the write.

## Storage and verification

Workspace format 16 introduced the journal; format 17 adds an index for bounded trash queries. Migration preserves existing records, UUIDs, versions, views, schemas and journal entries without creating fictitious past events. The first subsequent edit captures the previous stored state. Service connections install temporary SQLite triggers on `main.records`, with transaction-local context; this captures indirect writes without spreading journal calls across relationship and calculation code. Direct SQLite edits outside the service are unsupported and are not journaled. Online backup/restore retains the durable journal, not the temporary connection context. Older programs reject newer workspace formats.

Regression coverage includes typed snapshots, rollback after a late batch conflict, stable pagination, current-schema restoration, retained later fields, recalculated formulas, missing targets, reverse links, coalesced calculations, multiple connections, CSV/conversion writes, restart, backup, migration, authenticated HTTP/SDK and real CLI/MCP subprocesses. Trash tests cover deletion cycles, stale requests, explicit field repairs, reciprocal cardinality, late rollback and closed self-linked batches. Automated desktop acceptance verifies history pagination, keyboard entry, before/after comparison, current-value preview, draft retention, cancellation, stale restores and successful restoration with recalculation. Trash acceptance covers cross-page selection and adjustments, Unicode/zero/false snapshots, confirmation cancellation, concurrent restoration, current-type repairs and defaults added after deletion. Screenshots at 1024 × 768 were reviewed; native input-method checks remain a final-candidate task. Batch undo remains open in [the active delivery plan](gap-closure-plan.md).
