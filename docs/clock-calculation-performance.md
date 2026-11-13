# Clock calculation measurements

These are service measurements during implementation, not desktop input/scrolling measurements or final-candidate acceptance. Current-time formulas and explicit refresh are implemented; automatic scheduling still requires a separate design that keeps long calculations from blocking ordinary service requests.

## Reproduce

Build the production service with `npm run build`, then run `node scripts/benchmark-clock.mjs`. The script creates an isolated database under `.artifacts/`, checks result/version correctness, and writes raw timings and machine metadata. It seeds 100,000 records in batches of 2,000, each with a name, NOW timestamp, a dependent next-minute timestamp and a TODAY date in Asia/Shanghai. It measures three same-minute refreshes, three advancing-minute refreshes, one day transition and a 100-record read after refresh. Run it alone, without GUI tests or other benchmarks.

## Observed results

Measured on 2026-11-13 using the working tree based on `8e042cc0e7e0fcb893ecd4573ab29da5ec92c01f`, with uncommitted clock implementation changes. Windows 11 (`Windows_NT 10.0.22631 x64`), Intel Core i7-8700K, 12 logical processors, 32 GiB RAM; Node 24.22.1, SQLite 3.53.4, Temporal polyfill 0.5.1. Display settings are not applicable to these direct service calls. Source checks and final-candidate measurements must be repeated on the eventual release revision.

| Implementation | Same minute, milliseconds | Advancing minute, milliseconds | Day transition, milliseconds |
| --- | --- | --- | --- |
| Initial per-record evaluation | 4794, 4671, 4812 | 26646, 26120, 25778 | 31420 |
| Evaluate row-independent clock expressions once | 675, 561, 584 | 20396, 20680, 21091 | 24054 |
| Propagate row-independent results and apply them in SQLite | 349, 287, 285 | 8233, 8118, 7930 | 10334 |
| Compact temporary tracking tables | 333, 308, 300 | 7703, 7494, 7545 | 10085 |

The last comparison used an online backup of the preceding synthetic database, started at its saved March 1 clock and advanced by minutes and one day. It exercised the same 100,000 records and expressions without repeating seeding. The reusable script recreates the workload from an empty database. These are small sets of raw samples, not a percentile claim.

The original and first two optimized full runs are retained locally in `.artifacts/clock-performance-LkD4m2/results.json`, `.artifacts/clock-performance-7WYS37/results.json` and `.artifacts/clock-performance-vkvjfz/results.json`. The compact-table comparison is in `.artifacts/clock-variant-kzrwGP/results.json`. Generated databases/results remain ignored. The third full run's subsequent 100-record read took 33.6 ms; this does not measure a read competing with a refresh.

## Limits and remaining work

The final measured refresh still takes about 7.5–10 seconds for this dataset. Do not attach a blocking interval to the HTTP service and call the automatic-refresh workflow complete. The follow-up must keep reads responsive during a long calculation, coordinate concurrent writes, expose evaluation time/failures and preserve local drafts. Expressions that depend on per-record inputs use the bounded page path; these measurements do not establish their worst-case latency. Temporary tracking storage scales with affected field/record pairs even though JavaScript does not load all record bodies or IDs at once.

Regression tests verify paged rollback, stable UUIDs, one version increment per changed record, typed JSON results, unchanged user timestamps/history, cross-table propagation, zone-dependent selective updates, reciprocal edits, preview, CSV, restart, backup and format migration. Business validation uses Node/SQLite/HTTP/CLI/MCP; this change has no desktop control change. Native input and final renderer acceptance remain pending in the delivery plan.
