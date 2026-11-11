# Prototype validation

Validation date: 2026-11-12. This is an early Windows x64 prototype with one fixed-schema text table. The measurements below describe one development machine, not product guarantees.

## Functional checks

- Strict TypeScript checking and production renderer compilation passed.
- Fifteen automated tests cover real SQLite persistence and transactions, HTTP authentication/validation, atomic rollback and conflicts, bounded client caching, stale-response protection, Unicode TSV parsing, and dataset overwrite protection.
- Source and packaged Electron smoke tests passed: editing with Enter or direct typing, cancellation, active-editor saves, close protection, keyboard navigation and rectangular selection, native clipboard transfer, 1,000 × 10 paste/save, conflict feedback, restart persistence, and separate-service failure. A synthetic non-text clipboard event must not erase cells or start a second clipboard read.
- Native Windows Pinyin input was checked separately: candidate UI, Space selection, Escape cancellation, Enter composition confirmation, Ctrl+S, and persisted Chinese/Latin text. Synthetic composition events in CI only check the editor's key guard.
- The portable ZIP contains the runtime and third-party notices; the app runs without a separate Node.js installation. The staged secret scan and dependency audit reported no findings.

Windows CI repeats both source and packaged desktop smoke tests. Ubuntu CI runs type checking, compilation, and the service/client/parser tests; Linux desktop behavior is not claimed.

## Measurement environment

| Item | Configuration |
| --- | --- |
| CPU / RAM | Intel Core i7-8700K at 3.70 GHz, 12 logical CPUs; 31.95 GiB RAM |
| GPU | NVIDIA GeForce GTX 1080; driver 32.0.15.6094 |
| OS | Windows 11 Enterprise x64, build 10.0.22631 |
| Display | 1920 × 1080, 100% scaling, 60 Hz; renderer viewport 1204 × 781 |
| App runtime | Electron 45.3.0, Chromium 156.0.8078.96, embedded Node 24.22.2, SQLite 3.53.4 |
| UI / tooling | React 18.3.1, Glide Data Grid 6.0.3, esbuild 0.28.2, TypeScript 7.0.2; build Node 24.22.1 / npm 11.19.1 |

Use the commands in [development.md](development.md#reproducible-pressure-datasets). Data includes Chinese, emoji, nulls, and 400-character text values. Each shape gets three launches against an already generated database, followed by a 1,000 × 10 paste/save. The first trial traverses the table five times in 120 scroll steps per traversal, waiting 100 ms between steps.

Startup includes Playwright attachment and ends after the populated grid and two animation frames; it is not a cold-OS startup measurement. Input and scrolling use animation-frame timing as a paint proxy. Batch timing includes browser interaction, HTTP, validation, SQLite, and UI feedback. The machine also runs ordinary development/background applications.

## Timing snapshot

Values are medians with the minimum–maximum of three trials in parentheses. The final timing snapshot was recorded at 2026-11-12 01:29–01:30 Asia/Shanghai; the scrolling snapshot was recorded earlier in the same session.

| Measurement | 10,000 × 20 | 100,000 × 100 |
| --- | ---: | ---: |
| Startup to populated grid | 994 ms (952–1,052) | 901 ms (867–946) |
| Input event to next animation frame | 7.4 ms (6.5–11.3) | 68.8 ms (7.3–256.3) |
| Stage 1,000 × 10 pasted cells | 127 ms (124–226) | 228 ms (225–261) |
| Save that batch and show success | 177 ms (170–189) | 911 ms (465–927) |
| Scrolling frame interval, p50 / p95 / max | 16.7 / 16.8 / 33.4 ms | 16.7 / 16.8 / 33.3 ms |
| Generate the database once | 0.54 s | 15.93 s |
| Seeded database size | 8.61 MiB | 442.40 MiB |

The two scrolling samples lasted about 70 seconds each. Frame cadence was generally near 60 Hz, but the repeated large-table input check included 69 ms and 256 ms delays. Earlier trials were faster; the cause of that variation has not been isolated. These results do **not** establish consistent low-latency input or a 60 FPS guarantee. Profile input scheduling on an otherwise idle machine before making that claim.

## Memory observations

The Playwright run's summed working sets rose to 549 MiB and 717 MiB, while renderer JS heaps after a forced-GC diagnostic were 7.5 MiB and 11.7 MiB. That alone does not establish a cache leak.

A separate run used only the main-process Node inspector, with no renderer debugger, no network-response recording, and no preceding paste workload. It scrolled the same generated workspaces five times without forcing GC:

| Measurement | 10,000 × 20 | 100,000 × 100 |
| --- | ---: | ---: |
| Total working sets at load | 388 MiB | 393 MiB |
| Total after each scrolling circuit | 455, 456, 459, 463, 456 MiB | 446, 450, 451, 460, 451 MiB |
| Data-service working set after last circuit | 75 MiB | 79 MiB |
| Sum of Electron-reported CPU percentages during circuits | 1.76–2.08% | 3.93–4.23% |

This workload settled within those ranges. Differences from the Playwright run are consistent with instrumentation and workload overhead; the comparison is not a single-cause memory analysis. Working-set sums include shared pages, and CPU figures are Electron's per-process interval averages. Client unit tests independently establish the 12-page/1,200-row cache bound and preservation of bounded drafts.

Raw local snapshots are under `.artifacts/benchmarks/2026-11-11T17-13-12-071Z/` (scrolling and memory) and `2026-11-11T17-29-57-276Z/` (final timings). Reports identify the packaged archive hash, source base revision, and uncommitted-build status. They and their generated databases are intentionally not version controlled.

## Remaining acceptance work

- Exercise a full Excel/WPS/LibreOffice clipboard round trip, additional input methods, and longer sessions. Current clipboard checks use the Windows clipboard and spreadsheet-compatible TSV, not automation of another spreadsheet application.
- Validate on other hardware, display scales, and desktop operating systems. A roughly one-minute scrolling workload does not prove leak-free operation over hours.
- Add signing, an installer, and update delivery when preparing a distributed release. The current artifact is an unsigned portable ZIP.
- Custom schemas/types, new-record creation, filtering, sorting, CSV workflows, team hosting, and host/agent integrations remain outside this prototype.
