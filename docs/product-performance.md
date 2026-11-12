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

The large-table paste and query targets are **not met**. This storage revision uses a table/position index and JSON record values; these filter/sort expressions scan records rather than using field expression indexes. Query optimization and narrower reads for batch editing are the next focused changes. Scrolling and memory are not measured by this `--timings-only` run. None of these targets has been relaxed.

Raw local report: `.artifacts/benchmarks/2026-11-12T10-54-35-417Z/results.json`. Package SHA-256: `3be1a6fce9d468e20fa49750825430d00fb4da15ef56bdf37bebbbb8c7c91ede`. Generated reports and databases are excluded from Git; this summary preserves the method and measured limits.
