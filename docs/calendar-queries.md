# Calendar queries

Read a calendar through the shared service, SDK, CLI or MCP. Configure the start field, optional end field and an explicit time zone. The queries return complete counts with bounded record previews and pages. Saved calendar presentation is a separate delivery step; these reads already work with explicit settings or an existing saved view's query.

## Read a date window

Use `POST /tables/:table/calendar/query`, SDK `queryCalendar`, CLI `records calendar`, or MCP `records_calendar`:

```json
{
  "calendar": {
    "startFieldId": "start-field-id",
    "endFieldId": "end-field-id",
    "timeZone": "Asia/Shanghai"
  },
  "from": "2026-11-01",
  "toExclusive": "2026-12-01",
  "previewLimit": 3,
  "fields": ["display-field-id", "start-field-id", "end-field-id"]
}
```

Use stable field IDs. Start and end must both be scalar dates or both be timestamps. Date/timestamp formulas and automatic record timestamps are supported; arrays of linked dates are not scalar start/end fields. An omitted end field or null end value creates a single-day date or a point timestamp.

The visible range contains 1–62 calendar dates and excludes `toExclusive`. Each day returns `{ date, count, records }`. `previewLimit` defaults to 3 and accepts 0–5; zero returns counts without record values. Project the fields needed for cards using `fields`. Returned records use their existing UUIDs and versions.

`totalRecords` counts all matching records. `scheduledRecords` counts distinct valid records overlapping the visible window. A record spanning several days contributes once to `scheduledRecords` and once to each occupied day's count. `unscheduled` and `invalid` return their complete counts and bounded previews across the entire matching query, including records outside the visible date window. Valid scheduled records outside the window contribute only to `totalRecords`.

## Date and interval semantics

| Stored values | Occupancy |
| --- | --- |
| Date start, null end | The start date |
| Date start and end | Every date from start through end, inclusive |
| Timestamp start, null or equal end | The local calendar date containing the start instant |
| Timestamp start before end | Every local day overlapping `[start, end)`; an end exactly at midnight does not occupy the following day |
| Null start with no configured-field error | Unscheduled, including a record that has only an end value |
| End before start, or an error in a configured formula field | Invalid; retain the record for inspection and correction |

Date-only values keep their calendar dates in every zone. Timestamp placement follows actual local day boundaries, including 23/25-hour days, half-hour changes and historical offsets. A skipped local day has no timestamp occupancy. Numeric instant comparisons preserve normalized timestamp ordering even when an offset crosses the four-digit year boundary.

## Page a bucket

Use `POST /tables/:table/calendar/records`, SDK `queryCalendarRecords`, CLI `records calendar-records`, or MCP `records_calendar_records`. Reuse the same calendar settings, query and projection:

```json
{
  "calendar": { "startFieldId": "start-field-id", "timeZone": "Asia/Shanghai" },
  "bucket": { "kind": "day", "date": "2026-11-14" },
  "offset": 0,
  "limit": 50,
  "expectedRevision": 12
}
```

Other buckets are `{ "kind": "unscheduled" }` and `{ "kind": "invalid" }`. Offset defaults to zero, limit to 100, and a page accepts at most 500 records. Every page includes the full bucket `total`, even if its offset is beyond the last record. An empty or skipped day returns an empty page with total zero. Records can be edited through the existing versioned record-write APIs; reading a calendar never mutates schema, records or views.

## Filtering and consistency

Explicit `filter`, `sort` and `search` use the standard record-query semantics. Alternatively, supply `viewId` and `expectedViewVersion` to inherit a saved view's filter and order, including saved grid grouping. Do not combine a saved view with explicit filter or sort settings. A temporary `search` can override saved search. Calendar counts and previews use the same ordering as their bucket pages.

Both responses include `revision`, `schemaVersion`, optional `dateContext`, and saved `viewId`/`viewVersion` when used. Reuse revision, date context and view version on continuation pages. Data or relative-period changes return `DATA_CHANGED`; a changed view returns `VIEW_CONFLICT`. Refresh the layout and reconcile any edits before continuing. A renamed field retains its ID; removed or incompatible configured fields require selecting valid settings.

Each read uses one SQLite snapshot. The layout streams configured values in query order, counts overlaps with a difference array and retains at most 320 preview IDs across 62 dates and two exceptional buckets. Only selected records and requested linked/attachment details are hydrated. Paging retains at most the requested number of IDs. Work grows with matching records and returned previews, without expanding every long interval into one row per occupied day.

Linked numeric conditions and sorting reuse grouped ID/value results instead of calculating the same linked summary repeatedly or materializing entire record JSON. Empty counts remain zero; null summaries, formula errors and overflow retain the standard record-query behavior. Workspace storage connections use a 96 MiB suggested SQLite page-cache limit, allocated as needed for the connection. This is a cache target, not a process memory cap; see [SQLite's cache-size semantics](https://www.sqlite.org/pragma.html#pragma_cache_size).

## Verification

The SQLite regression suite covers counts/previews/pages, null/reversed intervals, DST and skipped dates, normalized extended years, saved queries, linked-value filtering and projection, formula errors, automatic timestamps, stale continuations and restart. HTTP/SDK/CLI/MCP tests verify shared results, authentication, conflicts and read-only behavior. After building, run `node scripts/benchmark-calendar-queries.mjs` for the isolated 100,000-record service workload. It records source/environment and raw samples, independently verifies results and checks that reads preserve workspace state. Renderer and native-input measurements remain separate final-candidate work.

After the timing run, use `node scripts/benchmark-calendar-memory.mjs .artifacts/calendar-performance-GENERATED_DIRECTORY` with the directory printed by the benchmark. This opens the generated data in a fresh service-only process, avoiding the dataset generator's arrays, and records RSS over repeated equivalent query circuits. It rejects paths outside generated benchmark directories and does not operate on a working workspace.
