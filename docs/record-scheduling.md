# Record scheduling

Move a record's configured date range or adjust one boundary through the shared service. These operations use a saved calendar's start/end fields and time zone. They are available through HTTP, the SDK, CLI and MCP; direct timeline interaction is a subsequent delivery step.

## Request

Send `POST /tables/:table/views/:view/records/:record/schedule`:

```json
{
  "expectedVersion": 3,
  "expectedViewVersion": 2,
  "action": "move",
  "days": 1
}
```

`expectedVersion` belongs to the record; `expectedViewVersion` belongs to the saved view. `days` is a non-zero signed whole number. The response is a normal `BatchResult` with the updated record and a durable history `batchId`.

The SDK method is `rescheduleRecord(tableId, viewId, recordId, input)`. The CLI command is:

```sh
rowweave records reschedule TABLE_ID VIEW_ID RECORD_ID --input schedule.json
```

MCP exposes `records_reschedule` with `{ tableId, viewId, recordId, input }`. It is a write and is not automatically retried.

## Date behavior

| Action | Behavior |
| --- | --- |
| `move` | Shift the start by `days` and preserve the range's duration. An absent end stays absent. |
| `resizeStart` | Shift only the start boundary by `days`. |
| `resizeEnd` | Shift only the end boundary by `days`; an absent end uses the start as its initial boundary. |

Date-only ranges retain inclusive ends and move by calendar days, including leap dates. Timestamp ends remain exclusive, with equal/absent ends representing points, as in [calendar reads](calendar-queries.md).

For timestamps, a move finds the new start by adding calendar days in the saved time zone. It applies that same elapsed-time difference to a present end, preserving elapsed duration through daylight-saving transitions. Consequently, the end's local clock time can change. Resizing instead shifts the selected boundary by calendar days in that zone. A local time in a spring-forward gap advances by the gap; a repeated clock time prefers the original offset when valid, otherwise the earlier occurrence. A whole skipped calendar date is rejected rather than moving to another date. Stored timestamps remain UTC.

For example, moving a 23-hour interval starting at noon before a spring-forward transition moves its start to noon the next day and keeps its duration at 23 hours. It does not silently turn it into a 24-hour interval.

## Validation and recovery

Resizing requires distinct configured start and end fields. A missing start, configured formula error, reversed resulting range or out-of-range date is rejected. Each changed field must be writable. A calculated start may still be used when only a writable end is resized; a read-only end with a value prevents moving the entire interval. Use normal record editing to set an initial date or repair inputs that cannot be scheduled.

The record UUID and unrelated values remain unchanged. Schema, view and record versions are checked within the same SQLite write transaction. A changed view cannot redirect a pending operation to different fields. Conflicts or invalid values leave the record, revisions and history unchanged. Successful writes use ordinary calculated-field propagation, edit timestamps, durable history and batch undo. Saved filters control browsing; scheduling addresses the specified record in the table and does not require it to match the view's current filter.

After a conflict, reread the record and view and reconcile the intended change. After a lost connection or uncertain response, inspect saved state/history before submitting another write. Do not retry the same move blindly.

## Verification

SQLite regressions cover leap dates, points, resizing, daylight-saving gaps/folds, duration preservation, skipped dates, read-only fields, formula errors, invalid requests, atomic version conflicts, history, undo and restart. Real HTTP/SDK/CLI/MCP tests compare writes and conflict responses, authentication and history behavior. The independently installed SDK compiles a scheduling consumer. This service-only change does not claim timeline UI or native-input acceptance.
