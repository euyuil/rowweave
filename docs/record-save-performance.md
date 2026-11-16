# Record-save performance

The final-candidate benchmark exposed a large-table save regression. This report preserves the failed gate, the history-query correction and subsequent background checkpoint measurements. The final-candidate acceptance target remains **2 seconds for an atomic 1,000 × 10 save**. Managed HTTP saves now take 520–610 ms on the large dataset; current packaged renderer measurements remain required.

## Production baseline

The clean Windows package from `5f3caa511c049b560d2b8fdcb446ba77c251b05d`, merged as `1895ce8dc09fad7a67372d4c7503d58fa44a999a`, has ZIP SHA-256 `5f372b286ddfde315e560118148279eee180425a11bc97fb4ece0253ef9b560b`. The full production benchmark used independently generated typed 10,000 × 20 and 100,000 × 100 databases, three launches per size, and a 1,000 × 10 staged paste followed by explicit Save. Save timing includes the client request, the complete transaction and successful UI feedback.

| Production save samples | 10,000 × 20 | 100,000 × 100 |
| --- | --- | --- |
| Three launches, milliseconds | 944.6, 1446.2, 925.2 | 4009.0, 4007.3, 3533.0 |

All three large-table samples fail the target. Input, paste and common indexed queries passed their separate timing targets, so they do not explain the save delay. The original raw report and databases are under `.artifacts/chained-lookup-worktree/.artifacts/benchmarks/2026-11-16T07-12-41-622Z/`.

## Diagnosis and bounded correction

A SQL-instrumented service run on an isolated backup of the large database reproduced 4088.2, 3324.3 and 3495.3 ms saves. Across those three operations, transaction commit consumed 8056.1 ms, history receipt finalization consumed 2060.6 ms, and all 3,000 record updates together consumed 449.1 ms. Instrumentation is diagnostic evidence, not a replacement for production timings.

The actual query plan for linking receipts to their affected tables scanned `record_changes` using `changes_by_record`, then joined batches and the temporary transaction context. This visited unrelated historical transactions. Both finalization statements now begin with the single current context and use `CROSS JOIN` to preserve that outer loop. The existing unique batch/record index bounds history reads to the current batch. No schema, retention policy, history content, version rule or durability setting changes.

After the correction, the same instrumented workload spent 3.8 ms total finalizing three receipts, down from 2060.6 ms. Complete saves still took 2961.3, 2821.5 and 2705.9 ms because commit remained dominant. The local diagnostic reports are `.artifacts/batch-save-worktree/.artifacts/save-profile-ZU2ywa/results.json` and `save-profile-osV9a7/results.json` in the same parent directory.

## Clean-source service measurements

The reproducible service benchmark ran from clean commit `5b8c9b951c8d60bd7e835e65145c865b8641eaa7`. It uses SQLite's backup API to create isolated copies of both production datasets, including their saved-query indexes and existing history. Each of three trials opens a separate store connection, reads 1,000 records and changes ten text fields. Only the version-checked service update is timed; reads and correctness checks are outside timing. There is no HTTP, renderer or SQL instrumentation in these measurements.

| Service save samples | 10,000 × 20 | 100,000 × 100 |
| --- | --- | --- |
| Three store connections, milliseconds | 774.2, 736.5, 771.1 | 2806.1, 2544.8, 2639.3 |

Every operation checks all returned values and versions, including unchanged fields; complete paged receipt membership; representative before/after snapshots; rejection and rollback of a partially valid stale batch; and restart persistence. All 457 Node regressions, strict type checking and the production build passed. An earlier test invocation in the new worktree omitted the package builds and failed interface tests because their bundles did not exist; the standard `npm test` command built the bundles and passed without skips.

Run after the production dataset benchmark:

```sh
npm run build
node scripts/benchmark-record-saves.mjs PATH_TO_DESKTOP_BENCHMARK_RESULTS_JSON
```

The script never updates the input databases. It records source identity, dirty state, runtime/hardware, input provenance and every timing sample. The clean-source report is `.artifacts/batch-save-worktree/.artifacts/record-save-performance-wj1N3R/results.json`.

Reference machine: Windows 11 x64 `10.0.22631`, Intel Core i7-8700K with 12 logical CPUs, 31.95 GiB RAM. The test volume reports `ST6000NM0115-1YZ110` on a RAID bus. Node 24.22.1 and SQLite 3.53.4 execute the service; the production renderer uses Electron 45.3.0 and embedded Node 24.22.2. The desktop run used 1920 × 1080 at 100% scaling/60 Hz; display settings do not apply to service-only timings. No other local test suite or download ran concurrently; ordinary desktop activity was not isolated.

## Background workspace checkpoints

An isolated diagnostic disabled automatic checkpointing while retaining the existing synchronous setting, then explicitly checkpointed after three writes. Saves took 497.5, 394.8 and 431.9 ms; the subsequent passive checkpoint took 3079.2 ms for 18,008 WAL pages. This demonstrates the checkpoint cost on this workload. Leaving checkpointing disabled without maintenance is not an acceptable solution. [SQLite documents](https://www.sqlite.org/wal.html#performance_considerations) the distinction between durable WAL commit and checkpointing, including checkpoint work on a separate thread.

The managed workspace now retains `synchronous = FULL` and moves passive checkpoint work to its existing calculation worker. A ready handshake precedes HTTP startup. Only committed transactions schedule maintenance, concurrent requests coalesce, and the minute clock tick requests another attempt after pinned readers release their snapshots. A partial checkpoint does not enter a busy retry loop. Checkpoint failures and unexpected worker exit close the service visibly; shutdown drains accepted work and the worker before closing the main connection. No extra process/worker or data-format migration is introduced. Direct storage consumers keep automatic checkpointing.

Clean source `8096908ae95551646a4f71935e416e151743faf2` passed all 465 Node tests, the production build and strict checking. Eight new regressions cover FULL durability configuration, post-commit notifications, rollback without notification/history changes, pinned readers, coalesced requests, graceful drain, startup/worker/command failures and recovery after process termination. The crash case pins an older reader, confirms acknowledged data remains uncheckpointed, kills the standalone service, and checks exact values, versions and before/after history after restart. This verifies process-crash recovery, not physical power-loss behavior.

The same generated datasets were copied with SQLite backup and measured through the managed workspace and shared HTTP client. Each size uses three separate service lifetimes; startup calculations finish before timing. Saves include request/response handling and the complete durable transaction. Correctness assertions, a following projected 100-record read, receipt pagination, stale-batch rollback and restart are outside save timing. No renderer or SQL/checkpoint instrumentation runs.

| Managed HTTP samples, ms | 10,000 × 20 | 100,000 × 100 |
| --- | --- | --- |
| Save | 283.0, 290.5, 271.3 | 610.2, 520.0, 553.0 |
| Read immediately after save | 5.6, 4.4, 4.5 | 24.4, 22.7, 18.1 |

Every correctness and restart assertion passed. Checkpoint overlap with the following reads is not instrumented, so these timings do not independently prove overlap. Environment is unchanged from the reference machine above. Raw data, source identity and dataset provenance are in `.artifacts/batch-save-worktree/.artifacts/record-save-performance-VRQJ1d/results.json`; all samples are retained. The first sandboxed invocation failed to launch Git before any measurement and is not counted as a run.

```sh
node scripts/benchmark-record-saves.mjs PATH_TO_DESKTOP_BENCHMARK_RESULTS_JSON --workspace
```

## Remaining renderer and memory gates

The separate baseline production memory run stayed bounded, with last-three-circuit spreads of 3.2 and 9.9 MiB. The large dataset reached 653.5 MiB in summed process working sets, slightly above the 650 MiB target; service working sets were 241.8–246.2 MiB. Shared pages can be counted more than once. This remains an unresolved final-candidate gate, alongside packaged renderer save measurements and final native/package verification. Current calendar-query remeasurement is also required: a later cache diagnostic exceeded the historical 500 ms query target. The overall goal stays active.
