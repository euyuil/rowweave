# Connected workflow candidate verification

This report records the bounded connected-workflow iteration in [refinement-plan.md](refinement-plan.md), including remaining gaps. Passing this iteration does not mean the wider product direction is complete. Use [acceptance.md](acceptance.md) for the owner's final walkthrough.

## Exact candidate

- Clean source: `500e00c82fa81cf21272dba464cee0331213ae64`, the tested head of PR #57. Its complete tracked tree was verified identical to merged main `44c52d56abe6e3e1f75d612395eb40d5aeb8a2ca` before this verification-only follow-up.
- Package: `release/0.1.0-20261113T052310594Z/rowweave-0.1.0-win32-x64.zip`, 161,566,179 bytes.
- SHA-256: `302ff782476114bcd9b12d92c14454d8782b9b73d1b696609b36ce49ec47fd91`, independently checked against the ZIP.
- Executable: `rowweave-win32-x64/rowweave.exe` inside the extracted archive. `release/latest.json` records the source and `uncommittedChanges: false`.
- Workspace format: 15. The portable archive contains the bundled Temporal resolver and both its and JSBI's license notices. Extracted-app tests ran outside the development checkout.

Each feature was independently squash merged after required Linux and Windows CI passed: [two-way links (#54)](https://github.com/euyuil/rowweave/pull/54), [connected calculations (#55)](https://github.com/euyuil/rowweave/pull/55), [grouped records (#56)](https://github.com/euyuil/rowweave/pull/56), and [relative dates (#57)](https://github.com/euyuil/rowweave/pull/57). This report and its reproduction scripts do not change the packaged application.

## Verified behavior

Strict type checking and production builds passed. All 184 locally selected Node tests passed; CI passed 185 tests including the IPv6 fixture unavailable in this environment. Staged Gitleaks scans passed before each commit.

| Workflow | Evidence |
| --- | --- |
| Two-way linked records | Atomic field creation and edits from either side; schema/cardinality/required constraints, self-links, deletion, CSV/defaults, versions, restart and backup; desktop creation and reverse editing. |
| Formulas using scalar linked summaries | Transactional propagation through acyclic table chains; precise affected-record versions, errors/recovery, schema/CSV writes, query/export agreement, restart/backup and shared-interface writes. |
| Editable grouped grids | Saved single-select/checkbox grouping, stable ordered paging and indexes, counts, collapse/expand, actual-row keyboard selection, cross-group clipboard, drafts/undo, save-time regrouping and conflict recovery. |
| Relative date filters | Named time zones, DST and non-hour transitions, calendar boundaries, inclusive day counts, same-value lookup ranges, migration and consistent query/view/summary/export rules. Date-context conflicts preserve drafts; UI summary continuation was checked across 55 groups. |

The exact extracted ZIP passed `npm run test:packaged`: the complete workspace workflow, connection switching/failures, keyboard selection/editing, clipboard, 1,000 × 10 paste/save, synthetic composition guards, conflict handling and restart persistence. `npm run test:interfaces` passed packaged desktop, SDK bundle, CLI subprocess, MCP protocol and Harness UI against one isolated service, including host/archive lifecycle and typed CSV exchange.

Screenshots from the final package are retained under `.artifacts/connected-candidate-screenshots/`. Narrow-window field pairing, reverse record details, connected formula editing/results, group settings/records and date settings were visually reviewed. Logs are `.artifacts/relative-date-node-tests.log`, `.artifacts/relative-date-desktop-tests.log`, `.artifacts/relative-date-package.log`, `.artifacts/relative-date-packaged-tests.log` and `.artifacts/connected-candidate-interfaces.log`. These are automated GUI checks and screenshot review, not native input-method or external spreadsheet verification.

## Measured service performance

Measurements used clean candidate source `500e00c82fa81cf21272dba464cee0331213ae64` on 2026-11-13: Intel Core i7-8700K at 3.70 GHz, 12 logical processors, 34,302,324,736 bytes RAM, Windows 10.0.22631 x64, Node 24.22.1 and SQLite 3.53.4. Runs were sequential after the local GUI suites finished. These are direct compiled-service calls; display settings are not applicable, and timings exclude HTTP, renderer work and drawing. They do not establish frontend frame rate.

| Workload | Samples | Observed range | p95 |
| --- | ---: | ---: | ---: |
| Change one target; recompute 10,000 dependent records / 20,000 formulas | 10 | 681.8–871.8 ms | 871.8 ms |
| Filter/sort those stored formula results; return 100 records | 20 | 15.8–28.0 ms | 23.9 ms |
| Linked-summary filter/sort: 10,000 records / 100,000 links; return 100 | 20 | 669.8–735.3 ms | 732.4 ms |
| Full-table sum of that linked summary | 5 | 278.8–292.9 ms | 292.9 ms |
| Grouped ordered page: 100,000 records / 5 fields; return 100 | 20 | 24.1–34.4 ms | 32.8 ms |
| Relative-date page on that dataset; return 100 of 50,001 matches | 20 | 134.5–159.8 ms | 151.0 ms |
| Grouped, sorted relative-date page on that dataset | 20 | 138.5–173.9 ms | 162.8 ms |
| Group counts for that relative-date view | 20 | 513.8–594.2 ms | 592.5 ms |

Query cases follow two warm-ups; p95 uses nearest rank. Dataset creation took 3.0 seconds for connected calculations, 13.0 seconds for linked summaries and 13.2 seconds for grouped dates, outside timed reads. Preparing three grouped/date views took 616.3 ms, also separate. All 10,000 dependent formula results were checked after the last update; every repeated grouped/date query and summary returned the expected complete count.

Reproduce with `npm run build`, then run `node scripts/benchmark-connected.mjs`, `node scripts/benchmark-linked.mjs` and `node scripts/benchmark-grouped-dates.mjs` sequentially. Each creates an isolated deterministic dataset and records raw samples, source and machine metadata. The new scripts are the same scripts used for these observations, published from their local copies. Raw reports are `.artifacts/connected-performance-xG6kaf/results.json`, `.artifacts/linked-performance-v5Usxx/results.json` and `.artifacts/grouped-date-performance-fAFGnh/results.json`.

The linked-summary scan and grouped relative-date summary exceed 500 ms. They remain explicit performance gaps; fast stored-formula or grouped-record reads do not imply fast aggregates. No current desktop input/scrolling benchmark is claimed. Historical desktop measurements in [refinement-validation.md](refinement-validation.md) retain their original revision and 32 Hz display limitation.

## Remaining workflow gaps

The following compares intended workflows with the actual contracts, service/storage implementation and UI in this candidate. It is an ordered follow-up list, not a claim that these capabilities were delivered or authorization to broaden a future PR without a concrete boundary.

| Priority | Actual remaining gap | Why it matters and affected layers |
| --- | --- | --- |
| High | Persistent history, restore/trash and undo after saving are absent; undo/redo covers drafts only. | Correcting a saved or deleted record still depends on deliberate edits or workspace backups. Requires storage/service recovery semantics and UI, not just an Undo button. |
| High | Field descriptions, attachments, URL semantics, automatic numbering and creation/update metadata are absent. | Common work records cannot be modeled with their expected behavior. Each field family needs its own contract, persistence, validation and editor boundary; attachments also need file lifecycle management. |
| High | Formula language has no date arithmetic/current-time functions, array operations or first-record preview. Raw relation/array values cannot be formula inputs. | Calculations remain a bounded scalar language. Add coherent function families and dependency/clock semantics separately; arbitrary JavaScript is intentionally not a requirement. |
| High | Grid grouping supports one single-select/checkbox level only; text/date/linked groups, nested levels, measure footers and persisted collapse state are absent. | Rich grouping needs ordered queries, group pagination and client row mapping as well as headings. Existing scalar summaries are not a replacement for grouped editing. |
| High | Large linked-summary queries and grouped relative-date counts have the measured latency above; open views do not receive live external updates. | Loading and cross-interface freshness still affect perceived responsiveness. Optimize measured query plans and design explicit invalidation separately; current version checks prevent stale writes but do not push updates. |
| Medium | Select colors are stored but grid cells use text rather than colored pills; field configuration and formula feedback remain comparatively basic. | Visual scanning and discoverability need UI work with keyboard/clipboard regression coverage. Color storage alone is not completed color presentation. |
| Larger scope | Calendar, Gantt, gallery, form, pivot and map views; dashboards and native automation are absent. | These are complete workflow families requiring new view/query or execution semantics. A tab or placeholder would not close them. MCP exposes the implemented service; it does not itself provide a built-in automation engine. |

Within the four delivered changes, existing one-way fields cannot yet be paired in place; formula dependencies must remain acyclic; lookup-to-lookup targets are unsupported; grouping collapse state is local; relative years, rolling-hour windows and business-day calendars are absent. Relative views and externally changed values require refresh. Organization permissions, real-time collaboration, an internal AI runtime and new platforms remain outside the current delivery scope.

## Owner acceptance still required

Use the exact candidate above to exercise the complete workflow, particularly creating a pair of links, changing a linked amount used by a formula, editing/copying through collapsed groups, and saving/reopening a relative-date view. Native Chinese IME, external spreadsheet clipboard round trips and scrolling on the owner's normal display remain pending. These checks and the owner's judgment of flexibility and usability cannot be inferred from Node tests or synthetic composition events.
