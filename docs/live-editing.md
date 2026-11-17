# Live editing

RowWeave saves a grid cell when its editor commits (Enter, Tab, Apply, or clicking away). Escape cancels the open cell editor. Paste and rectangular clearing each save as one atomic batch. Existing record details save after 300 ms without local input. Composition input and attachment transfers postpone submission. Creating records, deleting records and changing schema or view settings still require explicit actions.

The service sends authenticated change notifications after writes and calculation refreshes. Each workspace client shares one streaming connection across its catalog, table and record panel. Reconnection always checks current authoritative state; no event replay is required. Stream heartbeats run every 15 seconds; the existing two-second state checks remain as a fallback. The client retries a failed notification connection with a bounded backoff. Notification frames contain no record values or credentials.

The UI updates saved records in its cache without clearing the grid. A prepared snapshot then updates filtering, sorting, grouping and other views together. Active grid editors, composition, gestures and dialogs protect their current interaction from replacement. An open record panel synchronizes untouched fields while retaining its drafts. Failed writes retain drafts and pause automatic submission; they are never retried silently. Review the error before retrying or discarding a draft.

## Concurrent edits

Regular record updates retain their existing whole-record `expectedVersion` guard. Live edits additionally send `expectedValues` for exactly the changed fields and `expectedSchemaVersion`. Optional `expectedFieldVersions` supplies each field's baseline record version; otherwise `expectedVersion` is its baseline.

Inside one SQLite write transaction, the service checks the schema, current values, and intervening field history. Two clients may update different fields of the same record. A change to the same field rejects the operation, even if someone subsequently changes that field back to its old value. Batch failure rolls back every record, including derived relationship and calculation updates. No client retries a stale write with an unconditional overwrite.

Guarded write receipts include `previousFieldVersions`, the last committed change to each edited field before the write. Consecutive undo uses that provenance to advance a baseline only through its own uninterrupted changes. A later local edit and undo cannot conceal an earlier external change-and-change-back. Inputs edited while another field is saving keep their original baselines until their own writes succeed.

## Undo and redo

There are two separate forms of history:

- SQLite stores durable record changes and transaction receipts. They remain available through Saved changes and record History after restart.
- The currently open table keeps a bounded in-memory undo/redo stack for edits made in that editing session, including the record panel. It contains at most 100 operations and 60,000 changed cells. Closing the table, switching connections or restarting ends this stack. Other clients' operations never enter it.

Undo and redo are new service writes, recorded in durable history and synchronized to other clients. They restore only explicitly edited fields; unrelated changes to other fields remain. They use the same field and schema guards as ordinary edits. If a target cell changed elsewhere, the whole undo/redo is rejected and the stack entry remains available for review. A new local edit clears redo. Editing, undoing, and redoing the same field repeatedly advances only the relevant history baselines; it does not accept changes to other fields implicitly.

Ctrl+Z / Ctrl+Y act on the table's saved edit history when the grid has focus. Text inputs retain native text undo while being edited; the record panel also has explicit Undo and Redo controls. The durable Saved changes interface remains available for older operations, including creation and deletion.

## Verification

`npm test` covers atomic conflicts, independent-field writes, schema changes, consecutive undo/redo, change-and-change-back conflicts, retained failed drafts, and authenticated notification streams and shutdown. `node apps/desktop/tests/live-sync.mjs` runs isolated desktop acceptance for automatic commits, clipboard batches, undo/redo, record synchronization, synthetic composition events and failed-write recovery.

Synthetic composition events are not proof of native Chinese input-method behavior. Native input methods and external spreadsheet interoperability remain final-candidate checks.
