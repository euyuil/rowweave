# Workflow gap closure

This is the active delivery scope following the owner's 2026-11-13 instruction to continue closing the material gaps identified in [the workflow audit](connected-workflow-validation.md#remaining-workflow-gaps). The previous four-feature milestone was completed, but closing that milestone did not complete the owner's goal. This plan explicitly expands earlier exclusions for the capabilities listed below. It does not replace implemented behavior with a new prototype.

## Completion rule

Keep one continuous goal active until every material item below has a usable implementation and verification evidence. An individual PR, a fixed number of improvements, a report, or a packaged partial milestone is not the completion condition. Move an item out of scope only when the owner explicitly decides to do so. If further audit reveals a material defect in these workflows, record and resolve it under the same goal.

Use independently useful PRs, each with a concrete boundary, tests and documentation. Squash merge each passing PR promptly, then start dependent work from updated main. The rows below can span multiple PRs. Check a row only when its complete acceptance criteria pass; record intermediate PRs without marking the row complete.

## Required outcomes

| Status | Capability | Acceptance criteria and useful PR boundaries |
| --- | --- | --- |
| Pending | Aggregate/query performance | Remove repeated scans/calculations from the measured grouped-date counts and linked-summary filter/sort workloads. Both reproducible workloads must reach p95 ≤500 ms on the recorded reference machine without sacrificing consistency, bounded responses or correctness. Preserve raw before/after measurements; optimize grouped summaries and linked queries independently. |
| Pending | Durable recovery | Persist record change history, inspect previous values, restore a saved change, and restore deleted records from trash after restart. Preserve record UUIDs, enforce current schema/relationship constraints and stale-write checks, and record the restoration itself. Separate record history/restore from trash and batch undo as needed; provide a usable desktop workflow and shared API/CLI/MCP operations for each. |
| Pending | Field descriptions and URLs | Persist field descriptions and show them where users configure or enter data. Provide a URL field with explicit validation, safe opening, typed import/export, filtering and editing. Keep schema versions and existing identities intact. |
| Pending | Automatic fields | Service-owned automatic numbering and created/updated timestamps work consistently for desktop, CSV, CLI and MCP writes, including concurrent/batched operations, restart and backup. Values cannot be forged by ordinary edits. Document sequence and restoration semantics. |
| Pending | Attachments | Upload, view/download and remove real files through an attachment field, with authenticated service access, bounded requests, persisted metadata and safe file lifecycle. Restart, backup/restore and record deletion/restoration retain the documented file behavior. Share the same operations with SDK/CLI/MCP; no filesystem work in the renderer. |
| Pending | Date and array calculations | Add useful date construction/extraction/arithmetic and typed array operations over linked/lookup values, with stable references, explicit errors, dependency propagation and deterministic tests. Current-time functions require defined refresh/recalculation semantics. Do not introduce arbitrary JavaScript evaluation or an internal AI runtime. |
| Pending | Formula preview | Preview a draft expression against a real record before saving its schema, using the same service rules as persisted calculation. Invalid expressions and calculation errors remain visible without changing stored data. |
| Pending | Broader editable grouping | Group by supported text, number, date and linked values, support nested grouping, show per-group measures and retain collapse choices. Queries, group pagination, row identities, keyboard/clipboard/editing, filters and exports agree across complete datasets. Deliver field families/nesting/measures/persistence in independently useful steps. |
| Pending | Safe external-change refresh | Detect changes from another client and update open grid, board and other views without manual reload when no local draft would be overwritten. Retain drafts and editor/IME state during conflicts, avoid automatic write retries, and keep subscriptions/polling and caches bounded. Schema, view and calculated-data changes participate. |
| Pending | Select-color presentation | Render configured single/multiple-select colors in cells and relevant record/view surfaces, with readable text, keyboard access and correct clipboard values. Existing option IDs and saved colors remain stable. |
| Pending | Calendar and Gantt | Saved date/calendar and timeline views use configurable date fields, filters and record details. Date changes are versioned service writes; null dates, time zones, ranges, large datasets and stale edits have tested behavior. Each view is its own complete PR sequence. |
| Pending | Gallery and forms | A saved gallery offers useful configured record cards; a form provides configured field order/visibility and validated record creation. Both honor schema changes and existing field types. Workspace forms are required; anonymous public hosting is not assumed. |
| Pending | Pivot and dashboards | Saved pivot dimensions/measures and dashboard widgets query the complete matching dataset, expose configuration through shared interfaces and remain bounded. Empty values, numeric errors, filters and updates are consistent. |
| Pending | Map view | Plot records from configured location/coordinate data, open record details and save view settings. Define provider/network behavior explicitly, handle missing/invalid locations and avoid silent fabricated coordinates. Do not send private data to a geocoding provider without authorization. |
| Pending | Automation | Persist useful record-change and scheduled workflows with conditional create/update actions, execution history, explicit failures and recursion/concurrency handling. The service owns execution and shares management with SDK/CLI/MCP. Never blindly retry a non-idempotent action with an uncertain outcome. External messaging requires the user's separate authorization. |
| Pending | Existing relationship limitations | Allow pairing compatible existing one-way fields without losing links, and support useful chained lookup behavior with cycle/error validation. Cover schema changes, identity/version guarantees and mixed old/new records. |
| Pending | Relative-date completeness | Add relative years, rolling-hour windows and business-day ranges with explicit zone/calendar semantics and consistent date-context paging. Preserve existing calendar-day behavior. |
| Pending | Final candidate | After the inventory closes, validate a clean portable package and the shared desktop/service/SDK/CLI/MCP/Harness workflows. Measure current UI input/scrolling behavior separately from service timings, document the exact revision/checksum, and invite the owner to final end-to-end acceptance. Native IME and external spreadsheet checks remain final-candidate checks. |

## Boundaries and evidence

Keep reference data unchanged, except isolated synthetic test fixtures if further inspection is needed. Describe RowWeave in its own terms throughout source, product copy and documentation. Enterprise organization administration, billing, an internal AI runtime and new desktop operating systems remain excluded.

Validate business behavior primarily with Node, SQLite, HTTP, SDK, CLI and MCP tests. Changed UI receives automated desktop/component acceptance and screenshot review. Avoid Computer Use for routine implementation checks. Use real system-boundary validation and checked internal invariants; no speculative frameworks, redundant guards or silent fallbacks.

For each row, record merged PRs, observed behavior, regression evidence, current measurements and unresolved acceptance items. Historical reports remain historical. Do not describe the application as complete while a material required row is pending.

## Progress

- Baseline: PRs #54–#58 delivered two-way links, connected scalar formulas, one-level enum grouping, relative calendar dates and their verification report. They are prerequisites, not closure of this inventory.
- Active work starts with the measured grouped-summary bottleneck, followed by linked-query performance and durable recovery. This ordering does not remove the other required outcomes.
- Grouped-summary implementation and regression checks now pass: the 100,000-record relative-date workload reached p95 191.4 ms versus 592.5 ms before. See [query-performance.md](query-performance.md) for exact sources and samples. The aggregate/query row remains pending until linked-summary queries also meet its criteria.
