# Current candidate validation

Implementation and verification are complete for the owner's current authorized scope. The current clean package passes the measured performance targets, current-code CI/portable checks and final native interaction checks. The candidate is ready for the owner's end-to-end walkthrough. This report does not declare owner acceptance.

## Scope and artifact

The active scope is [Workflow gap closure](gap-closure-plan.md). Custom forms, pivot tables, dashboards, map views and automation remain **unimplemented and explicitly excluded by the owner**. They are neither completed capabilities nor acceptance gates for this candidate.

- Measured clean source: `2d93bd82281167a940e751b3f728d79d6f00f216`, with packaging recording `uncommittedChanges: false`.
- ZIP: `rowweave-0.1.0-win32-x64.zip`, built on 2026-11-16 at 11:19:55 UTC.
- SHA-256: `888d98bb40221315bee37269186618253fe3edf03c7da018dbd1565c3fae1d0d`.
- Delivery manifest: `release/latest.json`. The archive and executable are under `release/0.1.0-20261116T111933580Z/`. This is a checksum-verified copy of the measured and native-tested package in `.artifacts/batch-save-worktree/release/`; no application rebuild occurred between these checks and delivery.
- PR [#115](https://github.com/euyuil/rowweave/pull/115) delivered the cache change and test/report follow-ups, squash merged as `59bbc6bc9bcb8c7dbfd226eab746f3c2f054bbe4`. Later changes to column acceptance and documentation do not alter the packaged application code.

The executable is `rowweave.exe`; RowWeave remains the displayed brand. This evaluation package is not a signed installer or public release. Use an isolated profile for acceptance; synthetic datasets and native fixtures are not user workspaces.

## Automated evidence

The final feature delivery, [PR #112](https://github.com/euyuil/rowweave/pull/112), passed both CI platforms, including source and extracted-package desktop workflows and installed/shared interfaces. Subsequent [PR #113](https://github.com/euyuil/rowweave/pull/113) bounded history-receipt work, and [PR #114](https://github.com/euyuil/rowweave/pull/114) moved passive WAL checkpoints to the existing workspace worker while retaining FULL synchronous commits. Both merged after required CI passed. The [checkpoint CI run](https://github.com/euyuil/rowweave/actions/runs/43844982736) includes all 465 Node regressions, strict checking/build, source and portable desktop/restart, installed Harness and shared desktop/service/SDK/CLI/MCP acceptance.

Local strict checking, production build and all 465 Node regressions passed with the current 80 MiB cache setting. Crash tests verify acknowledged uncheckpointed writes survive process termination with exact values, versions and history. This is process-crash evidence, not a physical power-loss test; see the [save/checkpoint report](record-save-performance.md).

A separate clean-source checkpoint-worker run at `3d9fb9dcac857343fa802b350f689d75b25b3ae8` refreshed three clock formulas over 100,000 records in 8,679 ms while 68 concurrent HTTP reads reached p95 22.7 ms and maximum 27.3 ms. Each read observed a committed snapshot, the final result/version assertions passed, and the service shut down normally. This precedes the cache-budget change and is service-only evidence, retained in `.artifacts/batch-save-worktree/.artifacts/background-clock-JWfX8J/results.json`.

The first PR #115 Windows CI run passed Node and Harness checks but stopped in a pre-existing column-menu test race. Automatic refresh could load a changed view before the test expected a stale-version conflict. A controlled reproduction confirmed the current-version sort correctly succeeds. The corrected test separately verifies success after refresh and rejection of a remote change while the menu is open. Both focused paths passed and shut down normally. Clipboard I/O was stubbed only in that local diagnostic after native reads returned empty; the committed/full CI test retains its original native clipboard checks. The [corrected final-head CI](https://github.com/euyuil/rowweave/actions/runs/43860985755) passed on Linux and Windows, including complete source desktop, clean packaging, extracted-package desktop/restart, installed Harness and shared-interface acceptance. PR #115 merged only after these checks passed.

The [acceptance walkthrough](acceptance.md#verification-coverage) maps implemented workflows to regression coverage, including identity, atomic schema conversions, drafts/conflicts, relations/chains, CSV, durable recovery, attachments, calculations, grouping, calendars, Gantt and galleries. Synthetic composition and clipboard events do not establish native compatibility.

## Current performance

The measured clean package completed the full production desktop timing workload, an independent memory run without a renderer debugger, and the complete calendar service benchmark. All configured targets passed on the reference machine.

| Measurement | 10,000 × 20 | 100,000 × 100 |
| --- | ---: | ---: |
| Startup median across three launches | 843.9 ms | 938.1 ms |
| Input-to-next-frame p95, three trials | 16.4 / 16.7 / 16.9 ms | 15.1 / 15.5 / 15.6 ms |
| Maximum input-to-next-frame sample | 17.4 ms | 16.2 ms |
| Paste staging, three trials | 80.1 / 76.5 / 79.1 ms | 303.7 / 300.8 / 286.8 ms |
| Atomic save, three trials | 417.5 / 936.9 / 447.9 ms | 961.3 / 947.9 / 940.6 ms |
| Highest prepared-query p95 | 10.0 ms | 46.8 ms |
| Scrolling frame-interval p95 at 60 Hz | 18.3 ms | 16.8 ms |
| Frames over 25 / 50 ms | 0 / 0 of 4,010 | 1 / 0 of 4,056 |
| Independent peak summed working sets | 539.3 MiB | 648.2 MiB |
| Last-three memory-circuit spread | 5.7 MiB | 18.9 MiB |

Targets remain unchanged: median startup ≤ 2 seconds, input p95 ≤ 50 ms, paste ≤ 500 ms, save ≤ 2 seconds, prepared-query p95 ≤ 500 ms, scrolling p95 ≤ 25 ms, peak summed working sets below 650 MiB and final-three memory spread ≤ 50 MiB. The six calendar workloads reached p95 385.5–474.8 ms. All six timing-run lifetimes and both memory-run lifetimes exited normally.

The memory peak leaves only **1.8 MiB of measured margin**. Summed working sets may count shared pages more than once and are not unique physical RAM usage. These are workload-specific observations, not universal performance guarantees. Index preparation is separate from query latency; the large desktop workload took 282–1,540 ms to prepare each measured query.

Reference machine: Windows 11 x64 `10.0.22631`, Intel Core i7-8700K with 12 logical CPUs, 31.95 GiB RAM, NVIDIA GeForce GTX 1080 and `ST6000NM0115-1YZ110` storage on a RAID bus. Display: 1920 × 1080, 100% scaling, 60 Hz; viewport: 1204 × 781. Versions: build Node 24.22.1, npm 11.19.1, Electron 45.3.0, embedded Node 24.22.2, Chromium 156.0.8078.96, SQLite 3.53.4, React 18.3.1 and Glide Data Grid 6.0.3.

The [complete measurement report](workspace-memory.md) retains the exact method, raw paths, per-cycle memory, process accounting, every timing sample and query preparation costs. Timing uses 110 keyboard inputs per launch with ten warm-ups discarded, a 1,000 × 10 DOM paste, three launches per dataset, five scrolling circuits and twenty measured calls per query after two warm-ups. Input/frame timings are paint proxies rather than hardware input latency. Memory uses only the main-process inspector, with no renderer debugger or forced garbage collection. No concurrent local benchmark or test ran; ordinary desktop activity was not isolated.

Raw local reports:

- Renderer: `.artifacts/batch-save-worktree/.artifacts/benchmarks/2026-11-16T11-27-54-563Z/results.json`.
- Memory and original-dataset backup provenance: `.artifacts/batch-save-worktree/.artifacts/checkpoint-memory-KO720T/`.
- Calendar: `.artifacts/batch-save-worktree/.artifacts/calendar-performance-dv6twg/results.json`.

## Retained failures and corrections

The baseline feature package at `5f3caa511c049b560d2b8fdcb446ba77c251b05d` failed large-table saves at 4,009 / 4,007 / 3,533 ms and peaked at 653.5 MiB. Its raw reports remain in `.artifacts/chained-lookup-worktree/.artifacts/benchmarks/2026-11-16T07-12-41-622Z/`; its archive checksum is `5f372b286ddfde315e560118148279eee180425a11bc97fb4ece0253ef9b560b`. It is not the current candidate.

The [save investigation](record-save-performance.md) records the bounded receipt query, durable background checkpointing, independent correctness assertions and managed HTTP saves of 520–610 ms. The current renderer measurements above subsequently passed. The [memory report](workspace-memory.md#rejected-and-interrupted-measurements) retains the later 650.6 MiB incomplete run, its unexplained inspector timeout, and a separate interrupted run whose timeout crossed confirmed Windows sleep. Performance test applications now hold a temporary display-sleep blocker and retain partial failures/exit status. Global power settings, timing deadlines and targets were not changed. A 64 MiB cache alternative failed query latency and was rejected; 80 MiB passed both memory and query gates.

Service-specific workloads retain their own exact-source reports: [aggregate/linked queries](query-performance.md), [clock calculations](clock-calculation-performance.md), [nested groups](nested-group-performance.md), [business-day filters](business-day-performance.md), [calendar queries](calendar-performance.md) and [chained lookups](chained-lookup-performance.md). Historical reports establish their stated workloads separately from current renderer measurements.

## Final native interaction

Performed on 2026-11-16 after the owner unlocked Windows, using the clean package identified above. The installed input method was Sogou Input `16.10.0.5813`, using the owner's existing double-Pinyin configuration; its exact scheme was not inspected or changed. Excel was x64 `16.0.20326.20318`. These checks used real native windows, physical key input and the system clipboard, separately from automated desktop acceptance.

- **Chinese composition:** the first Escape canceled an active composition while retaining the cell editor; a second Escape canceled the draft and restored the saved value. Physical `v`, `s`, `w`, `f` keys then displayed the candidate `中文`. While its candidate panel was active, an independent process changed a different record through `RecordService.updateBatch`. The update notice appeared without closing the candidate panel or replacing the draft. Space selected the candidate, Enter staged the cell and Ctrl+S saved it. An independent service read confirmed `中文` and the concurrent record update.
- **Excel clipboard:** the copied synthetic workbook received a fresh `本次验收🌱 20261116` marker. Native Ctrl+C/Ctrl+V transferred its three populated rows and three columns to RowWeave, then back into the previously blank `E8:G10` rectangle. The initial Excel selection also included an empty fourth row; only the populated three-row rectangle was transferred, and the separate fifth RowWeave record remained unchanged. All nine stored values matched the source, including Chinese, emoji, quotes, a comma, multiline text and blank cells. Independently reading the saved workbook XML confirmed the nine return values after decoding OOXML escapes and normalizing CRLF to LF. The source and RowWeave stored LF; the Excel return cell contained CRLF. No other characters were normalized, and byte-for-byte newline equality is not claimed.
- **Native file dialogs:** the Windows Open dialog selected a generated file with a Chinese filename. After saving its attachment field, Download opened the Windows save dialog and wrote a new filename. The uploaded bytes, original file and downloaded copy were identical: 68 bytes, SHA-256 `b9757cc02727512addc14e02e18c92f5f59529287e0523f577c22291cc04e6d5`.
- **Browser handoff:** the URL cell's explicit Open link action opened `https://example.com/` in Microsoft Edge. The native browser address and document destination were observed. No browser setting or existing tab content was changed.
- **Restart:** the saved workspace was closed with its native window close button; the observed process exited without a termination signal. A new process opened the same isolated profile. Both the grid and an independent service read confirmed unchanged table/field/record UUIDs, record versions `[3, 2, 2, 2, 2]`, values, URL and attachment bytes. The external process handle did not report an exit code, so this observation establishes normal window-close/relaunch and persistence, not an additional measured zero-exit-code result.

Only an isolated RowWeave profile and generated spreadsheet/file fixtures were modified. The first hidden launch was terminated without being counted as shutdown evidence. The subsequent visible launch encountered the Windows lock screen at 19:51 local time; native input resumed only after the owner's unlock reply. During file-dialog automation, an unavailable accessibility element required a fresh observation and native keyboard input. Reading the workbook while Excel held it open failed; the saved workbook was closed before independent XML verification. These tooling attempts are not product failures or passing evidence.

Raw local evidence is under `.artifacts/batch-save-worktree/.artifacts/final-native-2026-11-16T11-49-57-082Z/`: `native-environment.json`, `ime-external-update.png`, `external-update.json`, `ime-saved-records.json`, `attachment-roundtrip.json`, `browser-handoff.json`, `excel-roundtrip.png`, `excel-roundtrip.json`, `before-restart.json`, `normal-shutdown.json`, `restart-launch.json`, `after-restart.json` and `after-restart.png`. The saved workbook and isolated database remain there for reproduction. Generated data and screenshots are not version-controlled source.

These observations cover the tested input method, spreadsheet version and fixture values on this machine. They do not establish every input method, spreadsheet type-inference rule or arbitrary workload. The [end-to-end walkthrough](acceptance.md) is ready for the owner to exercise their normal workflows. The owner has not accepted this candidate.
