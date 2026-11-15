# Gantt views

Create a **Gantt** view to plan records along a timeline. Choose a start field, optional end field, time zone and day/week scale. Start and end must both resolve to dates or both to timestamps. Calculated and automatic dates can be displayed; only writable dates can be adjusted directly.

## Working with a timeline

The timeline keeps the primary display value on the left and shows the first three visible fields other than its configured dates. **Display** controls their order and visibility. Open a title, double-click a time bar or press Enter on it to edit the complete record, including hidden fields. Record UUIDs remain the identities used for all edits.

- Drag a bar to move its range, or drag an end to resize that boundary. The drag previews locally and writes only on release. Escape cancels the gesture.
- With a bar focused, Left/Right moves one day, Shift+Left/Right adjusts the end, and Alt+Left/Right adjusts the start. Focus remains on the bar after saving.
- Select a bar and use **Action**, **Days** and **Apply date change** for an explicit signed-day adjustment. **Undo saved change** reviews and reverses the complete saved operation using the normal history checks.
- **Timeline start**, earlier/later buttons and **Today** change the visible window. Day scale shows 42 days; week scale shows 168 days with Monday labels. Scale is saved in the view; the visible start is local to the mounted timeline.
- Records without a start or with invalid dates remain visible with actions to edit their inputs. Dates outside the window offer **Show date**. Partial bars have dashed clipped ends.

Dates include their end day. Timestamp ranges exclude the end instant; equal or absent ends are points. Timestamps are placed in the configured zone, and date-only values remain calendar dates. [Scheduling semantics](record-scheduling.md) define duration preservation, daylight-saving transitions, read-only fields and validation. Native input methods remain part of final-candidate acceptance.

## Saved configuration and shared interfaces

Use the existing view create/update methods and endpoints with:

```json
{
  "name": "Project plan",
  "type": "gantt",
  "gantt": {
    "startFieldId": "start-field-uuid",
    "endFieldId": "end-field-uuid",
    "timeZone": "Asia/Shanghai",
    "scale": "day"
  }
}
```

The SDK, CLI `views create/update/query` and MCP `views_create/views_update/views_query` expose the same configuration. Normal saved filters, sort, search, projection and CSV export apply. Gantt views do not use grid grouping or board lanes. Renames retain date references by UUID; removing or converting a required date field requires updating the view first. Switching view types removes the previous type's settings. Format 36 gates Gantt settings while preserving older records, calendars and versions; backups include the configuration.

`queryView` reads at most 50 projected records per timeline page, with a complete matching count. The projection includes the title, configured dates and up to three card fields, even if a date is hidden. The shared model's initial read is also bounded. Rendering holds one record page and at most 168 date columns; it never loads the whole table to draw the chart. This is a loading bound, not a measured frame-rate claim.

Calendar query APIs can also use a Gantt `viewId` to inherit its date fields, zone, filters and sort. Explicit calendar settings must match the saved date configuration. Scheduling uses the shared versioned HTTP/SDK/CLI/MCP operation; pointer gestures retain both the original record version and the original view version.

## Refresh and conflicts

External changes refresh the visible record page atomically with the corresponding schema and view. Local form drafts, composition state and active drags prevent background replacement. A concurrent record or configuration change rejects a stale gesture without redirecting it to different fields. Writes are not retried automatically.

Refresh retains the visible start, record-page position, viewport and focus when possible. A removed last page clamps to the new last page. Navigation during an in-flight refresh invalidates that result. Schema and settings are published together, including manual reload. Failed reads expose an error and explicit reload; saved changes still use the service's normal version checks and recovery history.

## Verification

SQLite and client regressions cover configuration, dependencies, format-35 upgrade, backup/restore, restart, inclusive dates, timestamp boundaries, leap days, DST folds, read-only capabilities, bounded projection, cancellation and stale revisions. HTTP/SDK/CLI/MCP tests create saved timelines and compare filtered queries and scheduling; an independently installed SDK compiles the new configuration.

Automated desktop acceptance covers pointer and consecutive keyboard adjustments, no writes before release, Escape, undo, full record forms, exceptional dates, search, paging and saved scale. Held-response and concurrent-write tests cover record/view conflicts, composition drafts, focus/scroll retention, page clamping, navigation, schema replacement and failed reads. Installed Harness acceptance covers saved settings, zone placement, scheduling and read-only dates. Reviewed 1440 × 1100 and 1024 × 768 screenshots are emitted as `desktop-gantt-*.png` in the CI screenshot artifact. Whole-workspace restart, packaging and CI results are recorded in the [active inventory](gap-closure-plan.md).
