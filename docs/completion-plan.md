# First product release

This is the delivery contract for turning the prototype into a usable RowWeave product. It takes precedence over the prototype milestones in [design.md](design.md). A checked item requires implemented behavior and recorded verification; a stub, screenshot, or API with no usable desktop workflow is not completion.

## Scope

Deliver one local workspace containing multiple structured tables, a Windows desktop application, and a standalone service that can also serve remote clients. Users can model their own data without editing code. Applications and agents use the same operations and validation as the desktop.

| Area | Required behavior |
| --- | --- |
| Tables | Create, list, rename, and delete tables; choose a primary display field; start with an empty workspace instead of a pressure dataset. |
| Fields | Add, rename, reorder, configure, and delete fields with stable IDs. Support text, multiline text, numbers (including currency/percent presentation), checkboxes, dates, timestamps, single select, multiple select, linked records, and read-only lookups. Required fields and defaults apply to new records. Option IDs survive renaming. |
| Schema changes | Versioned schema writes; explicit conversion preview and atomic application; invalid existing values prevent conversion without changing data. Preserve the prototype database through a tested migration. |
| Records | Create, duplicate, read, edit, and delete records; atomic batches; explicit save; conflict feedback that preserves drafts; draft undo/redo; consistent null/empty semantics. |
| Views | Named, persistent grid views with field visibility/order/width, compound filters, multi-field sorting, and search. Queries run in the service with deterministic ordering and bounded pagination. |
| Relationships | Link records across tables, select targets by their primary display value, navigate to them, and display lookup values. Define deletion behavior and prevent dangling references. |
| Data exchange | CSV preview, column mapping, typed validation, atomic import, and export of a table or current view. Preserve Unicode, quotes, line breaks, and empty values; document spreadsheet export semantics. |
| Desktop | A usable workspace/table/view navigation flow, field configuration, record details, typed editors, keyboard navigation, multi-cell copy/paste, clear loading/empty/error states, and explicit destructive-action confirmation. Persist view configuration and connection settings. |
| Service | Local bundled service plus independently operated service; bearer authentication, explicit remote binding/origin configuration, connection setup in the desktop, and documented backup/restore and migration procedures. No database access in Electron's main or renderer processes. |
| Developer interfaces | Documented HTTP API, a consumable TypeScript SDK, and a CLI with machine-readable output. Schema, views, queries, record operations, and import/export are available without the desktop. |
| Agent interfaces | A real MCP server with discoverable tools and schema resources, tested with a protocol client; usage Skills with concrete workflows and failure recovery. Mutations use the same business rules and conflict checks. |
| Host integration | A thin DeepSeek Harness entry point reusing the shared client and UI against the documented host API. Document installation and connection; do not duplicate storage or introduce an AI runtime. |
| Delivery | A tested Windows portable package, source/service setup instructions, aligned English and Simplified Chinese READMEs, and a final acceptance script with actual results and remaining limitations. |

The comparison with 钉钉 AI 表格 and 飞书多维表格 concerns schema flexibility and responsive structured-data workflows. This release does not promise every feature of those products. Built-in AI inference/chat, an Excel-style formula engine, complex automation, attachments, dashboards, additional view families, multitenancy, fine-grained permissions, real-time collaborative cursors, CRDTs, offline replication, installers, auto-updates, and additional desktop operating systems are outside this delivery contract. Do not add these as incidental work. A formal public release and license selection remain separate owner decisions; they do not block a private acceptance build.

## Implementation rules

- Every implementation task must satisfy a row above or a necessary correctness/performance prerequisite. Record the reason before expanding scope.
- Prefer one concrete implementation over a framework for hypothetical backends or future hosts. Validate untrusted input at service/protocol boundaries; trust checked internal types and database invariants. Do not silently catch failures, substitute fabricated data, retry non-idempotent writes, or add compatibility fallbacks without a real consumer.
- Use JSON record values keyed by stable field IDs, relational table/field/view metadata, and normalized relation edges in SQLite. Use parameterized SQL for queries and measured indexes for actual query paths. Schema edits must not require rebuilding physical tables for each field change.
- Schema and record operations are transactions. Conversion and import validate the entire operation before exposing any change. Migrations preserve IDs and versions, and reject unsupported newer database formats.
- Keep frontend loading bounded. Query changes invalidate caches; drafts are keyed by record identity, never by the current sorted position. Avoid per-cell network requests and full-table downloads.
- Keep this checklist current in each feature PR. Merge focused PRs as soon as CI and relevant verification pass, then branch from updated `main`.
- During implementation use unit, SQLite/HTTP/protocol integration, and automated browser/component tests. Do not use Computer Use for routine checks. Leave native IME, external spreadsheet clipboard interoperability, and human end-to-end acceptance to the final candidate; synthetic events are not native verification.

## Delivery sequence and evidence

Each item may need more than one focused PR. Do not batch completed PRs while waiting for the whole release.

- [x] Prototype: bounded grid, persistence, editing, packaging, and baseline measurements ([validation.md](validation.md)).
- [x] Multi-table storage migration, schema contracts, and text table/field operations (SQLite/HTTP regression tests; typed configuration and desktop workflows follow below).
- [x] Typed validation, record creation/deletion, defaults, and constraint changes (service/HTTP/client regression tests).
- [x] Schema conversion preview and atomic application (bounded diagnostics, stale-schema checks, failed-apply rollback, and HTTP regression tests).
- [x] Service queries, filtering, sorting, search, and consistent pagination (SQLite/HTTP regression tests, including schema/data revision changes).
- [x] Saved grid views and persistent column configuration (versioned HTTP operations, schema reconciliation, query dependencies, and migration regression tests).
- [ ] Desktop workspace navigation and schema/record management.
- [ ] Typed grid editors, draft undo/redo, views, and clipboard workflows.
- [ ] Relations, lookups, record picker, and record details/navigation.
- [ ] CSV import/export through service and desktop.
- [ ] SDK, CLI, HTTP reference, and standalone/remote connection workflow.
- [ ] MCP protocol server and agent usage Skills.
- [ ] Harness adapter and host integration verification.
- [ ] Complete cross-interface regression, migration/backup verification, production performance, and packaging.
- [ ] Final native-input checks and invitation for user end-to-end acceptance.

## Acceptance scenarios

1. From a fresh workspace, create Projects and Tasks, configure typed fields and select options, rename/reorder fields, add records, and restart. IDs, values, schemas, and views persist. Existing prototype workspaces migrate without lost edits.
2. Make an incompatible field conversion. Preview identifies offending records; applying fails atomically. Correct the data and convert successfully. A stale schema revision cannot overwrite another client's change.
3. Create a saved view with multiple filters and sort keys, hide/reorder/resize columns, search, and reopen it. Edits still address the correct records after sorting. Concurrent writes produce an explicit conflict and preserve unsaved drafts.
4. Link tasks to projects and show a project lookup. Renaming a project changes its display everywhere without changing IDs. Deleting referenced records/fields follows the documented policy without leaving broken values.
5. Paste a 1,000 × 10 rectangle, undo/redo drafts, save, copy a selection, import mapped CSV with Unicode/multiline values, and export/reimport supported values. Invalid input leaves stored data unchanged and identifies the failing row/field.
6. Use the packaged desktop, SDK, CLI, and MCP against the same isolated service. Discover schema, create a field and records, query a view, update with version checks, and verify the result from another interface. The Harness entry point uses this same service.
7. Stop/restart the service, lose a connection, encounter an unauthorized request, restore a backup, and reopen the packaged application outside the repository. Errors are actionable; no interface reports a failed write as successful.

## Performance gate

Use production builds and reproducible 10,000 × 20 and 100,000 × 100 datasets, including representative typed fields, Unicode, empty values, and long text. Keep timing runs separate from debugger-heavy memory diagnostics. Record hardware, OS, scaling, runtime versions, dataset generation, and raw-result locations in the validation report.

On the current reference Windows machine (documented in [validation.md](validation.md)), target:

- Median startup to usable first grid within 2 seconds across three launches.
- Input-to-next-paint p95 within 50 ms across at least 100 edits after warm-up; report the maximum and investigate stalls rather than hiding outliers.
- Scrolling frame-interval p95 within 25 ms at 60 Hz across five table traversals; report long frames separately.
- 1,000 × 10 paste staging within 500 ms and atomic save within 2 seconds, measured separately.
- Common first-page/filter/sort queries within 500 ms p95 across repeated requests; document the tested fields and indexes.
- Bounded page cache and no sustained memory growth: after warm-up, the last three equivalent scrolling circuits differ by at most 50 MiB in summed process working sets, with a target below 650 MiB for the tested workload. Explain shared-page accounting and report service memory separately.

These are acceptance targets, not existing performance claims. A missed target requires a fix or an explicit user-approved adjustment, not a reworded claim. CI verifies behavior on Windows and Linux; local reference measurements verify performance. Native IME and external spreadsheet interoperability remain final checks.

## Definition of ready for user acceptance

All required scope has working implementations, regression evidence, and merged PRs; there are no placeholder tools or known data-loss defects. The packaged candidate and service/interface instructions are reproducible. The final report maps the scenarios above to evidence and clearly identifies what the user's final manual acceptance still needs to verify. Notify the user at that point; do not call the product accepted on their behalf.
