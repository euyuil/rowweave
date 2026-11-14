# Relative date filters

Use **Filters** on a date or timestamp field, choose **is in a relative period**, then choose a period and time zone. The saved rule follows the service clock; it does not store the dates from the day you configured it. Named zones such as `Asia/Shanghai`, `America/New_York` and `UTC` are supported. The editor initially uses your device's zone, which is then saved explicitly.

| Period | Matching calendar dates |
| --- | --- |
| Today, yesterday, tomorrow | One local calendar date |
| This, last, next week | Monday through Sunday |
| This, last, next month | The complete calendar month |
| This, last, next year | January 1 through December 31, including February 29 in leap years |
| Past N days | Today and the preceding N−1 dates |
| Next N days | Today and the following N−1 dates |

N must be an integer from 1 to 3,660. These are calendar periods, not rolling 24-hour durations. A date field compares its `YYYY-MM-DD` value with the calendar dates in the chosen zone. A timestamp field compares UTC instants with the first valid instant of each boundary date; daylight-saving transitions can produce days shorter or longer than 24 hours. Missing values do not match. Combine an empty check with OR when unscheduled records should also appear.

Date/timestamp lookups match when at least one linked value lies inside the entire range. Two linked dates on opposite sides of the range do not together constitute a match.

## Rolling hours

Timestamp fields, including automatic creation/update times, timestamp formulas and timestamp lookups, also offer **Past N hours** and **Next N hours**. N is an integer from 1 to 87,840. Past hours run from exactly N elapsed hours before the initial query time through that time; next hours run from that time through exactly N elapsed hours later. Both endpoints are included at millisecond precision. Records created at the initial query instant therefore match Past N hours.

These windows use elapsed durations, independent of time zones or daylight-saving changes. The named zone remains saved for switching back to calendar periods, but does not change an hourly result. Date-only fields have no hour setting. A fresh query uses the exact current time, without rounding away records from the current minute.

## Shared interfaces

HTTP, SDK, CLI and MCP use the same filter condition:

```json
{
  "fieldId": "due-field-id",
  "operator": "relativeDate",
  "relative": { "period": "pastDays", "days": 7, "timeZone": "Asia/Shanghai" }
}
```

Calendar period identifiers are `today`, `yesterday`, `tomorrow`, `thisWeek`, `lastWeek`, `nextWeek`, `thisMonth`, `lastMonth`, `nextMonth`, `thisYear`, `lastYear`, `nextYear`, `pastDays` and `nextDays`. Only the last two accept `days`. Relative conditions use `relative` instead of a fixed `value` and can appear in nested AND/OR groups. Save them in a view's `query.filter` or supply them to record queries and summaries. Years are full calendar years in the chosen zone, not rolling 365-day windows or fiscal years.

Queries and summaries return an optional `dateContext` when they contain relative filters. Pass it as `expectedDateContext` on continuation pages, paired group summaries or board lane requests, alongside the usual `expectedRevision` and view version. A calendar-boundary change returns `DATA_CHANGED` even when no records changed. Refresh the first page and restart continuation; do not combine pages from different contexts. A year rule retains its context throughout that local year and changes at the next January 1. The desktop forwards this marker, detects boundary changes and refreshes idle grids and boards automatically. Drafts, active editors and open forms postpone replacement; stale reads retain edits for review.

CSV exports resolve the saved view against the current clock once, inside the export transaction. They export the current matching records, including collapsed grid groups. Export can therefore differ from an open view that has not been refreshed since its calendar period changed.

For rolling windows, use `relative: { period: "pastHours", hours: 2, timeZone: "UTC" }` or `nextHours`. Only these periods accept `hours`; they do not accept `days`. Treat `dateContext` as an opaque string. An hourly context pins the initial time for continuation requests made less than 60 seconds later. At 60 seconds, a backward clock change or a mixed calendar boundary, the old context returns `DATA_CHANGED`. Queries without an expected context always start a fresh window.

When polling selected-view state, pass the last query's `dateContext` with `tableId` and `viewId`. The response preserves a valid rolling context and returns a new one after expiry. This avoids refreshing on every poll. Idle desktop/Harness views then prepare a fresh snapshot; active editors, composition and unsaved forms continue to postpone replacement. Data changes still trigger the normal protected refresh. Neither polling nor window expiry writes records.

## Implementation and verification

The service validates settings once at the input boundary. Temporal resolves ranges once per request, and SQLite performs parameterized range comparisons and pagination. No time-zone conversion runs for every record. Relative predicates never become fixed-date partial indexes; the independent grouped-order index remains available.

Workspace format 15 prevents older programs from reopening saved relative rules they cannot interpret. Upgrading format 14 preserves schema, record and view versions. The pinned Temporal polyfill is bundled into the desktop's date resolver with its dependency license notices; the portable app does not depend on the development checkout's `node_modules`.

Format 32 protects saved year periods from older writers. Upgrading format 31 preserves existing view definitions, records, UUIDs, history and revision counters; no record rewrite is needed. Year filters participate in schema dependency checks, restart and backup/restore.

Format 33 protects saved hourly periods. It preserves previous data and view definitions without rewriting records. The service resolves each hourly interval once per read transaction; SQLite uses the same parameterized range comparisons as calendar filters. Continuation contexts carry their time anchor and range digest, requiring no server-side cache or scheduled job.

Regression coverage includes DST gaps/folds and half-hour transitions, non-hour offsets, year/week/month boundaries, leap years, nested filters, lookup matching, summaries/export, restart/migration, HTTP/SDK/MCP/CLI and retained drafts after stale continuation. Year tests verify complete leap years, differing local years at the same instant, exact timestamp endpoints and year-boundary context without data writes. Automated desktop acceptance covers date and timestamp settings, persisted day counts, all three year options, invalid zones, concurrent view changes and the narrow-window layout. Native input methods remain part of final owner acceptance.

Hourly regressions cover exact inclusive endpoints, elapsed durations across DST, one matching lookup value, creation timestamps, 59.999/60-second context lifetime, clock rollback and mixed calendar rollover. Nested groups, summaries, CSV, restart/backup and SDK/CLI/MCP use the same boundaries. Automated desktop checks cover timestamp-only options, unit changes, persisted settings, steady polling without repeated loads and retained form drafts during a simulated context change. The actual expiration clock is exercised in SQLite/protocol tests; the UI test does not claim to simulate native IME.
