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

The chosen side must contain a record. This API restores saved values into an existing record; a deleted-record restore and batch undo are subsequent required delivery steps. Deletion retains snapshots for inspection by record ID. Table deletion removes its records and history. There is no automatic history expiration in this version, so journal storage grows with committed changes. Backups include it; copying a workspace or backup copies its historical values too.

## Desktop workflow

Open a record from a grid or board, then choose **History** in the details panel. History loads ten changes at a time with **Older changes**, **Newer changes** and **Refresh history** controls. Selecting a change compares its stored before/after values, including empty text, nulls, zero, false and formula errors. Select options use current labels when available; historical links keep their stable IDs.

Choose **Restore before change** or **Restore after change** to preview the writable values that differ from the record you opened. The confirmation compares that record's values against the selected snapshot, so later edits outside the original historical difference are visible too. **Restore values** makes one version-checked write. Success closes the panel and refreshes the active view; a conflict stays visible and does not retry the write.

You may inspect history while a form has unsaved changes, but restoration stays disabled. Switching back to **Details** preserves the draft. Closing the panel still asks whether to keep editing or discard it. Details/history navigation stays available while scrolling, and a failed restoration moves focus to its error message.

## Storage and verification

Workspace format 16 adds the journal and prevents older programs from opening it. Migration preserves existing records, UUIDs, versions, views and schemas without creating fictitious past events. The first subsequent edit captures the previous stored state. Service connections install temporary SQLite triggers on `main.records`, with transaction-local context; this captures indirect writes without spreading journal calls across relationship and calculation code. Direct SQLite edits outside the service are unsupported and are not journaled. Online backup/restore retains the durable journal, not the temporary connection context.

Regression coverage includes typed snapshots, rollback after a late batch conflict, stable pagination, current-schema restoration, retained later fields, recalculated formulas, missing targets, reverse links, coalesced calculations, multiple connections, CSV/conversion writes, restart, backup, migration, authenticated HTTP/SDK and real CLI/MCP subprocesses. Automated desktop acceptance verifies history pagination, keyboard entry, before/after comparison, current-value preview, draft retention, cancellation, stale restores and successful restoration with recalculation. Screenshots at 1024 × 768 were reviewed; native input-method checks remain a final-candidate task. Trash and batch undo remain open in [the active delivery plan](gap-closure-plan.md).
