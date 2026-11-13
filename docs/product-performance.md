# Product performance verification

The measurements below describe the initial release. The [workflow report](refinement-validation.md) records the later calculated-field workloads and their measured limits; the [current UI candidate report](ui-refinement-validation.md) identifies the newest package and remaining manual checks. Historical native checks do not establish native behavior of the newer binary.

The [completion plan](completion-plan.md#performance-gate) defines the acceptance targets. The complete 60 Hz reference run below met every timing and memory target. A final-package rerun passed the other gates but encountered a different 32 Hz display environment, so it does not reestablish the 60 Hz scrolling gate. Both runs and a controlled display comparison are reported separately. Native Chinese IME and Excel clipboard checks passed as described below. The user's end-to-end acceptance remains their decision.

## Reproduce

Use the pinned toolchain, `npm run package:win`, and `npm run benchmark`. `--timings-only` skips scrolling and forced-GC diagnostics; it still measures input, paste/save, and queries. Run `npm run benchmark:memory -- <results.json>` separately for process working sets without a renderer debugger. See [development commands](development.md#reproducible-pressure-datasets) for mixed-type dataset generation and measurement details.

The datasets have 10,000 × 20 and 100,000 × 100 cells, including nullable/empty text, long Unicode text, numbers with currency/percent presentation, booleans, dates/timestamps, and single/multiple selections. The first ten columns accept a 1,000 × 10 text paste. Stable schema IDs come from normal service operations. Query cases use the primary `Name`, numeric `Amount >= 9900`, `Amount >= 9900 AND Done = true`, ascending `Name`, and descending `Amount`. Views retain all columns. Creation time, first query, and steady-state queries are reported separately.

Input sampling measures 100 keyboard inputs in a text editor after ten warm-up inputs on each of three launches. The input event to animation-frame callback is a paint proxy, not physical display latency. Paste timing includes parser, missing-page reads, draft staging, and the next frame showing the pending-cell count; wall time is retained as well. Save timing ends at successful UI feedback. Startup includes automation attachment and two frames after the grid loads, not a cold OS boot.

## Complete production run

Measured on 2026-11-12 from clean revision `3929ce1af88eb63ae508859081a5be07e7ef3b44` (merged through PR #36). Package SHA-256: `604336a5859215423c77d3636964e6de0ae7973e8f934d58137bdf06de02261a`. No dependency downloads, other regression suites, or other application benchmarks overlapped the measurements. The full timing run was followed by a separate memory run without a renderer debugger or forced garbage collection.

Environment: Windows 11 x64 10.0.22631, Intel Core i7-8700K (12 logical CPUs), 31.95 GiB RAM, NVIDIA GeForce GTX 1080, 1920 × 1080 at 100% scaling/60 Hz. Electron 45.3.0, Chromium 156.0.8078.96, embedded Node 24.22.2, React 18.3.1, and Glide Data Grid 6.0.3. Generation used Node 24.22.1 and the repository's typed generator: 2.9 seconds for 10,000 × 20 and 193.3 seconds for 100,000 × 100.

| Measurement | 10,000 × 20 | 100,000 × 100 | Target |
| --- | ---: | ---: | ---: |
| Startup, median of three launches | 1,042 ms | 1,033 ms | ≤2,000 ms |
| Input p95, range across three 100-sample trials | 14.3–14.9 ms | 14.8–15.0 ms | ≤50 ms |
| Maximum measured input delay | 15.9 ms | 16.3 ms | Report outliers |
| Paste 1,000 × 10, range of three trials | 86–113 ms | 351–368 ms | ≤500 ms |
| Atomic save, range of three trials | 310–328 ms | 927–951 ms | ≤2,000 ms |
| First-page query p95 | 12 ms | 68 ms | ≤500 ms |
| Numeric-range query p95 | 12 ms | 68 ms | ≤500 ms |
| Compound-filter query p95 | 8 ms | 61 ms | ≤500 ms |
| Primary-text sort p95 | 11 ms | 67 ms | ≤500 ms |
| Numeric sort p95 | 11 ms | 61 ms | ≤500 ms |
| Scrolling frame interval p95, five traversals | 16.8 ms | 16.8 ms | ≤25 ms |
| Long frames over 25 / 50 ms | 0 / 0 of 4,143 | 0 / 0 of 4,123 | Report separately |
| Summed working sets, five separate memory circuits | 471–480 MiB | 508–533 MiB | <650 MiB |
| Spread across the last three memory circuits | 7.3 MiB | 6.5 MiB | ≤50 MiB |

Four saved-query indexes cover the measured range/filter/sort cases; the first-page case uses the existing table/position index. Creating a new indexed view took 78–124 ms on the small dataset and 1.53–1.95 seconds on the large one. Those preparation costs are excluded from repeated-query latency and reported explicitly. The second and third paste/save trials ran with these indexes already present, so their maintenance cost is included in the write results. Queries return 100 records with all fields; twenty requests are measured after two warm-ups. No claim is made for arbitrary unindexed queries or a cold OS boot.

The separate memory run summed Electron's main, renderer, GPU, network and RowWeave service working sets. Shared pages may be counted in more than one process, so these sums are not unique physical RAM consumption. Service working sets were 69–76 MiB for 10,000 × 20 and 111–120 MiB for 100,000 × 100; corresponding private bytes were 36–43 MiB and 78–86 MiB. Last-three-circuit totals were 472.2/479.6/478.1 MiB and 532.5/529.9/526.1 MiB. The renderer cache remains bounded by the client regression tests. This establishes the stated five-circuit workload, not an indefinite-session memory guarantee.

The instrumented timing run also retains per-process snapshots and a forced-GC diagnostic, which include renderer-debugger overhead and are not substituted for the separate memory gate. Input/frame metrics remain animation-frame proxies rather than physical display latency. None of these automated results establishes native IME or external spreadsheet compatibility.

Raw local reports: `.artifacts/benchmarks/2026-11-12T12-33-52-773Z/results.json` and the adjacent `memory-without-renderer-debugger.json`. The directory also contains both generated databases and screenshots. The package manifest, runtime/display details, raw input/query/frame samples and per-process memory circuits identify the exact measured workload.

## Final package rerun and display comparison

The delivered clean package from `5091d04e4b2f77f9595225abd414513422b9f813` (PR #38) has SHA-256 `91d0543a2c020031f07dbb49cf390a9e047c14bc5aa37e039bbddb3145c9167f`. Its clipboard fix followed the reference run. The full production benchmark and separate memory measurement were repeated on 2026-11-12, without overlapping other test suites or downloads. Hardware/runtime versions were unchanged, but Electron reported a single **1728 × 1085, 100%, 32 Hz** display instead of the reference run's 1920 × 1080, 60 Hz display. Dataset generation took 2.2 and 201.1 seconds.

| Measurement | 10,000 × 20 | 100,000 × 100 |
| --- | ---: | ---: |
| Startup, median of three launches | 1,068 ms | 1,110 ms |
| Input p95, range across three trials | 28.8–28.9 ms | 28.8–29.0 ms |
| Maximum measured input delay | 29.2 ms | 29.7 ms |
| Paste 1,000 × 10, three trials | 111–122 ms | 420–437 ms |
| Atomic save, three trials | 358–387 ms | 971–998 ms |
| First-page / range / compound query p95 | 19 / 18 / 6 ms | 68 / 76 / 71 ms |
| Primary-text / numeric sort p95 | 19 / 10 ms | 79 / 69 ms |
| Scrolling frame interval p95 at 32 Hz | 31.6 ms | 31.6 ms |
| Long frames over 25 / 50 ms | 2,163 / 3 of 2,164 | 2,233 / 1 of 2,233 |
| Summed working sets, five separate circuits | 482–491 MiB | 511–549 MiB |
| Spread across the last three circuits | 8.4 MiB | 27.5 MiB |

All startup/input/paste/save/query/memory values meet their original targets. The scrolling values exceed 25 ms and are **not a pass of the 60 Hz gate**: the measured display itself presents one frame every 31.25 ms. A separate controlled check opened both the previously measured reference package and the final package on the same small dataset, with each window visible and focused. Both reported the same 32 Hz display and idle frame p50/p95 of 31.2/31.6 ms, supporting display cadence as the cause rather than a clipboard-code regression. No display settings, application frame limits or acceptance thresholds were changed. The earlier complete 60 Hz reference run remains the available evidence for that environment; a final-binary 60 Hz repeat was not available in the current desktop session.

Four saved-index preparation times were 71–98 ms and 1.65–2.13 seconds. Separate memory totals were 483.0/490.2/486.2/490.2/481.8 MiB and 510.9/517.4/521.3/548.8/546.3 MiB. Service working sets were 69–73 MiB and 108–145 MiB; private bytes were 36–39 MiB and 74–111 MiB. The same shared-page accounting and five-circuit limits as the reference run apply.

Raw reports: `.artifacts/benchmarks/2026-11-12T14-52-07-284Z/results.json`, its adjacent `memory-without-renderer-debugger.json`, and `.artifacts/display-cadence-comparison.json`. Each report identifies the artifact and observed environment. Owner acceptance should include scrolling on the user's normal display.

## Final native interaction checks

Performed on 2026-11-12 on the reference Windows machine, using Microsoft Pinyin and Microsoft Excel `16.0.20326.20318`. Only generated fixtures and an isolated RowWeave workspace were used. These checks used real application windows, native key input and the system clipboard, separately from browser automation.

- **Chinese input:** typing `ni` displayed the Pinyin candidate panel; Space selected `你`. Escape canceled the next composition without closing the editor. Enter confirmed a subsequent literal `n` composition without submitting the cell prematurely. Ctrl+S saved `你n`; a separate read-only SQLite connection confirmed the value and record version. This ran on the product candidate from `6f23fa9d9a2788ee16373e28feffb1337dd33a82`; the later clipboard-only fix did not change the cell editor.
- **Excel → RowWeave:** copied the generated workbook's `A2:C4` into three text/multiline fields, saved, and compared stored values through a read-only SQLite connection. Chinese, emoji, embedded quotes, a comma, multiline text and trailing blank cells were retained.
- **RowWeave → Excel:** the first native run exposed the grid library's HTML clipboard representation collapsing a line break to a space. PR #38 replaced grid copy with quoted plain-text TSV and added serializer/desktop regressions. The corrected clean package from `5091d04e4b2f77f9595225abd414513422b9f813` (ZIP SHA-256 `91d0543a2c020031f07dbb49cf390a9e047c14bc5aa37e039bbddb3145c9167f`) was opened on the same persisted workspace. Its selected rectangle was copied into Excel `E2:G4`, saved and compared against `A2:C4` by reading the workbook XML. All nine values matched after decoding Excel's carriage-return escape and normalizing Windows CRLF to LF. No other characters were normalized.

Evidence remains local under `.artifacts/`: `native-ime-composition.png`, `native-ime-saved.png`, `native-excel-paste-saved.png`, `native-excel-roundtrip-fixed.png`, `native-paste-persistence.json`, and `native-excel-roundtrip.json`. The generated workbook and isolated database are in `native-acceptance-2026-11-12T12-47-52-360Z/`. The test windows were closed after saving.

This establishes the tested input method and clipboard values on this machine, not every spreadsheet version, cell-type inference rule, CSV import mode or input method. Excel's legacy text import split an embedded newline in the preliminary CSV fixture, so the clipboard check used an exact `.xlsx` fixture. CSV service/export round trips have separate automated coverage; users should follow the [data exchange semantics](data-exchange.md) and try their normal applications in [owner acceptance](acceptance.md).

## Initial mixed-type baseline

Measured on 2026-11-12 using product revision `11c606db3904d4fe84719cb6e98a8656cbef47cf`. The package manifest correctly records uncommitted benchmark-only changes. This preliminary run overlapped an isolated Harness CLI dependency download, so it establishes investigation priorities, not final acceptance. The final candidate must be remeasured separately.

Environment: Windows 11 x64 10.0.22631, Intel Core i7-8700K (12 logical CPUs), 31.95 GiB RAM, NVIDIA GeForce GTX 1080, 1920 × 1080 at 100% scaling/60 Hz. Electron 45.3.0, Chromium 156.0.8078.96, embedded Node 24.22.2, React 18.3.1, and Glide Data Grid 6.0.3. Runtime/display details and process metrics are retained in the raw report.

| Measurement | 10,000 × 20 | 100,000 × 100 | Target |
| --- | ---: | ---: | ---: |
| Startup, median of three launches | 947 ms | 1,263 ms | ≤2,000 ms |
| Input p95, range across three 100-sample trials | 15.4–15.5 ms | 13.9–15.5 ms | ≤50 ms |
| Maximum measured input delay | 16.2 ms | 18.5 ms | Report outliers |
| Paste 1,000 × 10, range of three trials | 128–149 ms | 729–814 ms | ≤500 ms |
| Save 1,000 × 10, range of three trials | 226–344 ms | 949–1,023 ms | ≤2,000 ms |
| First-page query p95 | 11 ms | 66 ms | ≤500 ms |
| Numeric-range query p95 | 116 ms | 2,428 ms | ≤500 ms |
| Compound-filter query p95 | 125 ms | 3,551 ms | ≤500 ms |
| Primary-text sort p95 | 69 ms | 1,926 ms | ≤500 ms |
| Numeric sort p95 | 118 ms | 2,482 ms | ≤500 ms |

The baseline **does not meet** the large-table paste and query targets. This storage revision uses a table/position index and JSON record values; these filter/sort expressions scan records rather than using field expression indexes. The follow-up below addresses batch editing; query optimization remains required. Scrolling and memory are not measured by this `--timings-only` run. None of these targets has been relaxed.

Raw local report: `.artifacts/benchmarks/2026-11-12T10-54-35-417Z/results.json`. Package SHA-256: `3be1a6fce9d468e20fa49750825430d00fb4da15ef56bdf37bebbbb8c7c91ede`. Generated reports and databases are excluded from Git; this summary preserves the method and measured limits.

## Batch editing follow-up

Profiling attributed roughly 600 ms of the large paste to nine sequential display-page reads, versus about 50–65 ms to staging drafts. Batch editing now reads up to 500 rows per request without replacing the small display-page cache. It retains complete record values, revision checks, atomic staging, cancellation, and the global four-read limit. No write is retried.

The production package was retimed on isolated copies of both baseline databases, using the same DOM paste path, pending-count frame, and successful-save feedback. Each size used three separate launches. The Harness dependency download had completed before this run.

| Measurement | 10,000 × 20 | 100,000 × 100 |
| --- | ---: | ---: |
| Stage 1,000 × 10, range of three trials | 98–110 ms | 412–448 ms |
| Save that batch, range of three trials | 205–239 ms | 487–980 ms |

Both measured operations meet their targets in all three trials. This focused retest does not replace the final complete candidate run, query fixes, or scrolling/memory verification. TypeScript/build checks, 113 local Node tests, and the complete offscreen desktop workspace workflow passed; the local IPv6-bind restriction still leaves that test to CI.

Raw local report: `.artifacts/batch-edit-timings.json`. The manifest records base revision `cc17f9a8ed23847cb387ff05e05792b11ba58564` with the batch-read working-tree changes. Package SHA-256: `9d9c6c0a8f13711df3d471a620fce4b6eab8d24a1712b5f193be28a9c8a84442`. The final candidate will have its own clean revision and artifact identity.

## Saved-query index follow-up

SQLite now builds a partial expression index for each distinct supported saved query, combining its table, predicate, sort keys, and insertion-position tie breaker. Creation refreshes planner statistics. Indexes track view/schema changes transactionally and are removed when no view needs them. Scalar queries use these indexes for both bounded row reads and exact counts; relation/lookup and array-membership queries retain the scan path described in [development.md](development.md).

The production package was measured on isolated copies of the baseline databases, preserving the five saved benchmark views. Opening them performed the format-6-to-7 migration and created four indexes; the unfiltered view needs no new index. Each query used authenticated HTTP and twenty measured requests after two warm-up requests. Other regression suites had finished before timing began.

| Query p95 | 10,000 × 20 | 100,000 × 100 |
| --- | ---: | ---: |
| First page | 13 ms | 86 ms |
| Numeric range | 13 ms | 109 ms |
| Compound numeric/checkbox filter | 8 ms | 72 ms |
| Primary-text sort | 13 ms | 80 ms |
| Numeric sort | 12 ms | 95 ms |

All five workloads meet the 500 ms repeated-query target. Initial upgrade plus launch took 1.52 seconds for the small database and 9.55 seconds for the large database; this one-time index construction is not ordinary startup. The final complete run must measure normal startup, index preparation, writes with indexes, scrolling, and memory separately. Local verification also passed TypeScript/build checks, 118 Node tests (IPv6 binding remains CI-only on this machine), and the complete offscreen workspace/connection workflows. A real utility-process test confirms that initialization exceeding 30 seconds can finish and stop cleanly. Native input and spreadsheet checks remain deferred.

Raw local report: `.artifacts/query-index-timings.json`. The manifest records base revision `689f2e99a66184b85e10e7d5282935311f1c1559` with the saved-query index changes. Package SHA-256: `ecf623a502040eec0837c923bc2185a61094e541b4db85fcdf5d2d46d5b6d669`.
