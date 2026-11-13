# Grouped table records

In a grid view, choose **Groups**, select a field, and save. Supported fields include text, multiline text, numbers, dates, timestamps, URLs, single-selects, checkboxes, automatic fields, scalar formulas and scalar linked summaries. Each group shows its matching record count and the actual editable rows. Click a heading, or select it with the arrow keys and press Enter or Space, to expand or collapse it. **Collapse all** and **Expand all** work across the complete view.

Single-select groups follow the field's option order. Checkbox groups show unchecked, checked, then no value. Other values sort ascending: text is case-sensitive, numbers sort numerically, and dates use normalized values. **No value** and **Empty text** are distinct groups. Filters and search determine the matching records; sorting applies within each group. Hidden grouping fields still define their groups. Each view keeps its own grouping configuration. Collapse choices stay local to the open table and reset when it is reopened.

Edit cells and save as usual. A draft remains in its original group until it is saved, then the record moves to its new group. Collapsing a group retains its drafts and undo history. Copy and clear skip headings and collapsed records. Paste starts at a record cell and continues through expanded record rows, skipping headings and collapsed groups. A paste that exceeds those rows fails without partially changing drafts. Record details, duplication and deletion use record UUIDs rather than visual row numbers.

External changes load automatically while editing is idle. Group counts and visible records update together, retaining collapse choices and following a selected record by UUID when it remains in the prepared window. Active editors, composition, dialogs, drafts and undo/redo postpone replacement; a read failure keeps the current groups and records. Record, schema and view version checks prevent stale writes and inconsistent paging. A conflict retains your drafts for review; refresh or explicitly discard them before proceeding. CSV export includes all matching records, including collapsed groups, in the grouped view's order.

The desktop currently supports one scalar grouping level. Multi-selects, raw relation lists and array lookups are not scalar groups; a linked summary such as a sum or count can be grouped. Nested grouping, per-group numeric summaries and persisted collapse choices remain required delivery work. Use **Summarize** for separate scalar summary/group operations. Native input-method and external spreadsheet round trips remain final-candidate acceptance checks.

## Shared interfaces

HTTP, SDK, CLI and MCP use the existing view operations:

```json
{
  "name": "By status",
  "type": "grid",
  "groupBy": "<status-field-id>",
  "query": {
    "sort": [{ "fieldId": "<amount-field-id>", "direction": "desc" }]
  }
}
```

Update with the current `expectedVersion` and `groupBy: null` to remove grouping. Grid queries return record pages in group order, without synthetic heading records. Use group-layout queries for complete counts and bounded heading windows. Pair their `expectedRevision`, `expectedViewVersion` and date context with the record query to keep counts and pages consistent. Board lane queries retain their existing behavior.

SQLite format 29 protects saved scalar grouping semantics; format 14 introduced select/checkbox groups. Migration preserves existing data and versions. The service indexes supported grouped sort orders independently of temporary searches and filters; linked summaries use their calculated query instead of an invalid SQLite subquery index. The client keeps up to 12 metadata windows, reads at most 500 segments per request and retains the visible window independently of cache eviction. Metadata reads are serialized; obsolete queued windows are skipped. An active read retains the queue until the service responds, because canceling HTTP does not cancel synchronous SQLite work. Its result is not applied to an abandoned viewport. It does not download every group or record before opening the view.

## Bounded scalar layout queries

`queryGroups(tableId, input, signal?)`, CLI `rowweave records groups TABLE_ID --input groups.json`, and MCP `records_groups` expose the same read-only [layout contract](http-api.md#group-layout-windows). For example, `{ "groupBy": "text-field-id", "offset": 10000, "limit": 50, "collapse": { "defaultCollapsed": true, "exceptions": ["Active"] } }` reads a deep display window while only the Active group is expanded. It does not download every preceding group.

The service calculates complete counts and prefix positions in one SQLite read snapshot. Only groups intersecting the requested display rows leave storage. Record offsets remain independent of collapse and match ordinary record queries with the same scalar `groupBy` or the saved grouped-grid query. Groups include configured empty select/checkbox headings and a null heading. Raw text is case-sensitive, numbers sort numerically, and dates/timestamps use stored normalized values. Group keys retain their types and never become display names.

For selected or pasted record ranges, use `window: "expandedRecords"`. Its offsets skip headings and collapsed records, so a small selection separated by thousands of collapsed groups needs only the intersecting group segments. Each segment includes `expandedOffset` alongside its display and record-query positions; clip to the requested interval before reading records. Both window kinds retain the same complete counts and revision guards. Desktop copy, clear, record actions and paste use these bounded reads and check operation limits before allocating record selections or changing drafts.

Tests cover more than 500 distinct groups, deep and past-end windows, cache eviction, large collapse exception sets, select order/renames, null and empty text, computed fields and linked summaries, filters, date rollover, stale schema/data/view guards, cancellation and HTTP/SDK/CLI/MCP parity. Automated desktop acceptance covers 800 text groups, deep keyboard editing, copying and pasting across 798 collapsed groups, a failed expanded-window read without partial edits, undo/redo and original record UUIDs. Existing select/checkbox, composition, fragmented viewport and automatic-refresh checks also apply. `node scripts/benchmark-group-layout.mjs` measures compiled service reads on an isolated 100,000-record dataset; renderer performance measurements remain separate.
