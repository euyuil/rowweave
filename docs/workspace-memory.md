# Workspace memory budget

The production SQLite page-cache target is now 80 MiB per connection, down from 96 MiB. The measured large-table service working set fell from 241.8–246.2 MiB to 221.9–225.3 MiB. Five complete desktop scrolling circuits stayed below the unchanged 650 MiB summed-working-set target; the largest observed sample was **648.2 MiB**. This leaves 1.8 MiB of measured margin, not a guarantee for arbitrary workloads.

## Boundary and source

This change adjusts a connection-local cache target. It does not change schemas, indexes, records, query semantics, WAL durability or the background checkpoint lifecycle. SQLite's cache target is not a cap on process memory. Direct stores, the managed HTTP service and desktop use the same setting.

The clean measured source is `2d93bd82281167a940e751b3f728d79d6f00f216`. Its Windows package was built at 2026-11-16T11:19:55Z and has ZIP SHA-256 `888d98bb40221315bee37269186618253fe3edf03c7da018dbd1565c3fae1d0d`. The local artifact is `.artifacts/batch-save-worktree/release/0.1.0-20261116T111933580Z/rowweave-0.1.0-win32-x64.zip`.

Strict TypeScript checking, the production build and all 465 Node regressions passed. No product UI behavior changed. [Final-head CI](https://github.com/euyuil/rowweave/actions/runs/43860985755) passed on Linux and Windows, including full source/extracted-package desktop and shared desktop/service/SDK/CLI/MCP/Harness acceptance, before PR #115 squash merged. The same clean package subsequently passed native input, Excel clipboard, file-dialog, browser-handoff and restart checks recorded separately in the [candidate report](final-candidate-validation.md#final-native-interaction).

## Desktop measurements

The test uses independent SQLite backups of the original typed 10,000 × 20 and 100,000 × 100 production benchmark databases. Their saved-query indexes and complete history remain present. The original databases are untouched. Each size opens a fresh desktop profile and performs five 120-step scrolling circuits, with 100 ms between steps. Only the main-process inspector is connected; there is no renderer debugger or forced garbage collection. All recorded windows were visible, not minimized and focused. Circuits took 13.0 seconds for the small dataset and 12.7–12.8 seconds for the large one.

| Summed process working sets, MiB | 10,000 × 20 | 100,000 × 100 |
| --- | ---: | ---: |
| Circuit 1 | 532.4 | 623.2 |
| Circuit 2 | 538.6 | 634.8 |
| Circuit 3 | 538.5 | 648.2 |
| Circuit 4 | 539.3 | 636.9 |
| Circuit 5 | 533.6 | 629.3 |
| Last-three-circuit spread | 5.7 | 18.9 |

Both datasets satisfy the 650 MiB peak and 50 MiB last-three spread gates. Both test applications exited with code 0 without the emergency kill. The large service's private memory was 189.9–191.9 MiB. Summed working sets can count shared pages more than once; they are not unique physical RAM usage.

Raw samples, individual process metrics, window states, circuit durations and shutdown results are in `.artifacts/batch-save-worktree/.artifacts/checkpoint-memory-KO720T/memory-without-renderer-debugger.json`. The adjacent `results.json` records input-dataset provenance. Reference machine and runtime are the same as the [save report](record-save-performance.md#clean-source-service-measurements): Windows 11 x64, Intel Core i7-8700K, 31.95 GiB RAM, Electron 45.3.0 and SQLite 3.53.4. No other local benchmark, test suite or dependency download ran concurrently; ordinary desktop activity was not isolated.

## Rejected and interrupted measurements

The baseline clean feature package reached 653.5 MiB and failed the memory target. The subsequent background-checkpoint package `3d9fb9dcac857343fa802b350f689d75b25b3ae8` reached 650.6 MiB in its first large circuit, then an inspector operation timed out. Its incomplete run is retained in `.artifacts/batch-save-worktree/.artifacts/checkpoint-memory.log`; it is not passing large-table or shutdown evidence.

An initial 80 MiB package at `97b57462d31821c6679a3ee2d4824ca56e4a9ea7` completed four small-table circuits at 527.8–538.3 MiB, then timed out in the fifth. Windows power events confirm system suspension from 2026-11-16T10:25:42Z until 11:15:18Z, crossing that operation. This interrupted run is invalid for complete memory acceptance. Its report is retained under `checkpoint-memory-34J57K/`; shutdown subsequently completed normally.

The benchmark now retains partial circuits, failure details, window states and exit status. Failed memory thresholds and forced/nonzero exits return failure. Resume preserves previous attempts and skips only complete passing datasets with normal exits. Performance test applications hold a temporary Electron display-sleep blocker and release it during cleanup; global power settings are unchanged. The successful run above used this test-only safeguard with the original 30-second evaluation deadline.

## Query tradeoff

Before changing the product setting, isolated current-dataset probes at 80 MiB measured linked-month/all-date/linked-day p95 of 445.0/344.7/451.2 ms. A backup of the older calendar dataset measured 444.8/344.4/441.1 ms. The 64 MiB experiment exceeded the linked-month target at 502.3 ms and was rejected. Earlier 96 MiB diagnostic results of 518–577 ms remain separate observations; the later complete 96 MiB standard suite passed all six workloads at 394–454 ms.

The complete clean-source 80 MiB standard calendar suite passed every correctness check and the 500 ms p95 target:

| Calendar workload | p95, ms |
| --- | ---: |
| Date month | 402.3 |
| Timestamp month across DST | 393.4 |
| Maximum 62-date window | 400.6 |
| Linked numeric filter/sort | 474.8 |
| Busy timestamp day page | 403.5 |
| Invalid-interval page | 385.5 |

All six workloads use the [existing generation and independent validation method](calendar-performance.md#workload-and-method), with two warm-ups and twenty measured calls. The maximum individual sample was 495.6 ms. All raw samples are retained in `.artifacts/batch-save-worktree/.artifacts/calendar-performance-dv6twg/results.json`. Service-only cache probes do not establish renderer performance or native input behavior.

## Complete packaged timing check

The same clean package subsequently passed the complete production desktop timing workload with newly generated typed datasets. Each size ran three application launches, 110 keyboard inputs per launch (ten discarded warm-ups), a 1,000 × 10 paste and save, five query workloads (two warm-ups and twenty measured calls), and five scrolling circuits. The display was 1920 × 1080 at 100% scaling and 60 Hz; the renderer viewport was 1204 × 781. All six application lifetimes shut down normally.

| Measured result, ms | 10,000 × 20 | 100,000 × 100 | Target |
| --- | ---: | ---: | ---: |
| Median startup to populated grid | 843.9 | 938.1 | ≤ 2,000 |
| Highest input-to-next-frame p95 across three trials | 16.9 | 15.6 | ≤ 50 |
| Paste, all three samples | 80.1 / 76.5 / 79.1 | 303.7 / 300.8 / 286.8 | ≤ 500 |
| Save, all three samples | 417.5 / 936.9 / 447.9 | 961.3 / 947.9 / 940.6 | ≤ 2,000 |
| Highest prepared-query p95 | 10.0 | 46.8 | ≤ 500 |
| Scrolling frame-interval p95 | 18.3 | 16.8 | ≤ 25 |

The small scrolling run recorded 4,010 frames, a 21.0 ms maximum and no frames above 25 ms. The large run recorded 4,056 frames, a 34.5 ms maximum, one frame above 25 ms and none above 50 ms. Query index preparation is separate from prepared-query latency: the large workload took 282–1,540 ms to prepare each query. These figures are measured on the reference machine, not universal latency guarantees.

Input-to-animation-frame and frame intervals are renderer paint proxies, not hardware input latency. Paste uses a DOM clipboard event and does not prove Excel interoperability or native IME behavior. Renderer instrumentation changes memory behavior, so memory acceptance uses the independent debugger-free run above. No other local benchmark or test ran concurrently; a roughly 3 MB CI screenshot artifact download happened during large-dataset generation before that dataset's timed phases. Raw timings, environment, dataset identities, preparation costs and all individual samples are retained in `.artifacts/batch-save-worktree/.artifacts/benchmarks/2026-11-16T11-27-54-563Z/results.json`.

Run the memory check after generating production datasets and packaging a clean source tree:

```sh
npm run benchmark:memory -- PATH_TO_BENCHMARK_RESULTS_JSON
```
