# Product performance verification

The [completion plan](completion-plan.md#performance-gate) defines the acceptance targets. This report records progress toward them; the first baseline below is not a completed acceptance result. Native IME, external spreadsheet interoperability, final scrolling/memory measurements, and the user's end-to-end acceptance remain pending.

## Reproduce

Use the pinned toolchain, `npm run package:win`, and `npm run benchmark`. `--timings-only` skips scrolling and forced-GC diagnostics; it still measures input, paste/save, and queries. Run `npm run benchmark:memory -- <results.json>` separately for process working sets without a renderer debugger. See [development commands](development.md#reproducible-pressure-datasets) for mixed-type dataset generation and measurement details.

The datasets have 10,000 × 20 and 100,000 × 100 cells, including nullable/empty text, long Unicode text, numbers with currency/percent presentation, booleans, dates/timestamps, and single/multiple selections. The first ten columns accept a 1,000 × 10 text paste. Stable schema IDs come from normal service operations. Query cases use the primary `Name`, numeric `Amount >= 9900`, `Amount >= 9900 AND Done = true`, ascending `Name`, and descending `Amount`. Views retain all columns. Creation time, first query, and steady-state queries are reported separately.

Input sampling measures 100 keyboard inputs in a text editor after ten warm-up inputs on each of three launches. The input event to animation-frame callback is a paint proxy, not physical display latency. Paste timing includes parser, missing-page reads, draft staging, and the next frame showing the pending-cell count; wall time is retained as well. Save timing ends at successful UI feedback. Startup includes automation attachment and two frames after the grid loads, not a cold OS boot.

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
