# Everyday workflow candidate verification

This report covers the bounded [refinement plan](refinement-plan.md). The owner performs final acceptance using the [walkthrough](acceptance.md). It does not claim a public release or acceptance on the owner's behalf.

## Exact candidate

- Clean source: `15f8d15e771c69414b126526205f8a5e94993c66`, after PRs #41–#47 were squash merged individually with passing required checks.
- Package: `release/0.1.0-20261112T192443538Z/rowweave-0.1.0-win32-x64.zip` (161,494,039 bytes).
- SHA-256: `b4d56de4108a65d92792e8795954894e3a4db7cb3a4920af9f7a104aa9aa02f3`, independently checked against the ZIP.
- Executable inside the extracted archive: `rowweave-win32-x64/rowweave.exe`. `release/latest.json` records the same revision and `uncommittedChanges: false`.

The following acceptance-documentation change does not alter application code. The package above remains the measured candidate.

## Functional evidence

All 149 locally selected Node tests passed. The local environment cannot bind the IPv6 loopback fixture; the complete Linux and Windows CI suites passed on the feature PRs, including that test. Type checking and production builds passed. Each implementation PR passed its staged Gitleaks scan.

Automated source desktop checks cover identity wording, column menus, saved density/frozen columns, grouped full-set summaries, a 506-record board, formula editing/errors and linked summaries. The full workspace workflow passed after both final feature changes. Narrow-window acceptance used 1024 × 768. Screenshots of each changed flow were visually reviewed.

The exact extracted ZIP passed `npm run test:packaged`: full workspace lifecycle, connection switching, typed editing, keyboard/selection, 1,000 × 10 paste, synthetic composition guards, conflicts, restart persistence and service failure. `npm run test:interfaces` passed shared versioned-record operations through the packaged desktop, SDK bundle, CLI subprocess, MCP protocol and Harness UI, plus Harness archive installation/module lifecycle, typed editing and CSV import/download. Logs are `.artifacts/refinement-packaged-tests.log` and `.artifacts/refinement-interface-tests.log`.

## Calculated-field service measurements

These are direct calls to compiled Node service code and SQLite, without HTTP, renderer or display instrumentation. They establish service costs only. They do not establish input latency, frame rate or arbitrary-query performance.

Environment: Windows x64 10.0.22631, Intel Core i7-8700K @ 3.70 GHz (12 logical processors), 31.95 GiB RAM, Node 24.22.1, SQLite 3.53.4. Each workload used a newly created isolated database. No desktop regression suite overlapped these measurements.

| Workload | Observed time |
| --- | ---: |
| Add a formula to 100,000 records | 2,880.7 ms |
| Change its expression and recalculate 100,000 records | 2,624.2 ms |
| Indexed formula filter/sort, 100 returned rows, 20 samples after 2 warm-ups | p95 309.0 ms; max 310.3 ms |
| Full-table formula sum, 5 samples | max 116.6 ms |
| Update 1,000 records with formula recalculation | 185.6 ms |
| Linked-summary filter/sort, 10,000 source records and 100,000 links, 100 returned rows, 20 samples after 2 warm-ups | p95 605.5 ms; max 605.6 ms |
| Full-table sum of linked summaries, 5 samples | max 243.3 ms |
| Update a target referenced by 100 source records | 37.2 ms |
| Filter/sort after that target update | 602.5 ms |

Formula measurements used source `6d12b52fac3b18384a0ad5faa05088b67acdc7f3` (PR #46); linked-summary measurements used `027ab9beac596f0db6aad7652255d0f403b5f434` (PR #47). Both became part of the candidate through squash merges. Formula data has text, nullable Quantity, Price and a ROUND-based Total; its saved filter matches 59,377 rows. Linked data has 1,000 target amounts and 10,000 source records linking ten targets each; its saved numeric filter matches 4,800 records. Linked summary predicates/sorts remain scan paths and are slower than saved scalar indexes. The measured 605.5 ms p95 is above the scalar-query 500 ms target; the earlier scalar-index timing claim does not cover this relationship workload.

Reproduce from the repository root with the pinned toolchain: `npm run build`, then `node scripts/benchmark-formulas.mjs` or `node scripts/benchmark-linked.mjs`. Each script creates a fresh directory under `.artifacts/`, records raw samples and machine/source metadata, and retains its isolated database. Generation is excluded from query timing. These scripts reproduce the measured workload; the recorded observations used their initial local copies. Raw reports are `.artifacts/formula-performance-i5XDhL/results.json` and `.artifacts/linked-performance-RJrd1R/results.json`.

## Production desktop measurements

The exact candidate above was measured on 2026-11-13 (local time) with `npm run benchmark`. Hardware and OS match the service environment above; Windows lists an NVIDIA GeForce GTX 1080 (driver 32.0.15.6094) and Microsoft Remote Display Adapter (10.0.22621.7649). Electron reported a 1728 × 1085 display at 100% scaling and **32 Hz**, with a 1204 × 781 CSS-pixel viewport. Runtime versions were Electron 45.3.0, Chromium 156.0.8078.96, embedded Node 24.22.2, React 18.3.1 and Glide Data Grid 6.0.3. No other regression suite or benchmark overlapped the run.

The typed datasets and method are defined in the [initial report](product-performance.md#reproduce): three launches per size, 100 input samples after ten warm-ups per launch, a 1,000 × 10 paste/save, twenty measured authenticated HTTP queries after two warm-ups per case, and five scrolling traversals. Dataset creation took 2.3 and 188.2 seconds and is excluded from timings. Input-to-animation-frame and scrolling intervals are paint proxies, not hardware latency.

| Measurement | 10,000 × 20 | 100,000 × 100 | Target |
| --- | ---: | ---: | ---: |
| Startup, median of three launches | 769 ms | 932 ms | ≤2,000 ms |
| Input p95, range of three trials | 30.0–30.6 ms | 29.9–30.6 ms | ≤50 ms |
| Maximum measured input delay | 31.9 ms | 32.5 ms | Report outliers |
| Paste 1,000 × 10, range of three trials | 73–103 ms | 327–345 ms | ≤500 ms |
| Atomic save, range of three trials | 334–381 ms | 960–984 ms | ≤2,000 ms |
| First-page / range / compound query p95 | 6.6 / 7.2 / 4.6 ms | 61.6 / 59.3 / 47.2 ms | ≤500 ms |
| Primary-text / numeric sort p95 | 7.5 / 7.6 ms | 52.6 / 51.0 ms | ≤500 ms |
| Scrolling frame interval p95 at 32 Hz | 31.6 ms | 31.6 ms | ≤25 ms at 60 Hz |
| Long frames over 25 / 50 ms | 2,214 / 1 of 2,214 | 2,208 / 1 of 2,208 | Report separately |

Startup, input, paste, save and the five documented scalar-query cases meet their targets. Four saved indexes support the range/filter/sort queries; preparing those views took 60–90 ms and 1.27–1.73 seconds, separately from repeated query timing. Later paste/save trials include index maintenance. This does not extend those claims to unindexed relationship workloads.

The measured scrolling intervals exceed 25 ms. The current 32 Hz display itself presents a frame every 31.25 ms; this run **does not pass or establish the 60 Hz scrolling gate**. Display settings and thresholds were unchanged. The older 60 Hz result remains historical evidence only; the owner's normal-display check remains pending on this binary.

`npm run benchmark:memory` then measured five equivalent traversals separately without a renderer debugger or forced GC. Summed process working sets were 474.1–483.8 MiB for 10,000 × 20 and 503.7–520.5 MiB for 100,000 × 100. Last-three-circuit spreads were 9.75 and 10.73 MiB, meeting the <650 MiB total and ≤50 MiB spread targets. Service working sets were 74.1–77.1 / 107.3–115.8 MiB; private bytes were 40.8–43.2 / 72.8–80.9 MiB. These sums may double-count shared pages and establish this five-circuit workload, not indefinite-session memory behavior. Raw process snapshots are in the adjacent `memory-without-renderer-debugger.json`; debugger-heavy timing snapshots and forced-GC diagnostics remain separate.

Raw results are `.artifacts/benchmarks/2026-11-12T19-30-55-568Z/results.json`; the same directory retains both isolated databases and screenshots. The original [performance report](product-performance.md) remains historical evidence, not a measurement of this newer binary.

## Manual acceptance still required

Native Microsoft Pinyin, external spreadsheet clipboard round trips and the owner's normal-display scrolling need a final check on this exact binary. Automated composition/clipboard tests and historical native checks are separate evidence. No native check was performed during this iteration's implementation. The owner should also judge the complete workflow, schema flexibility, naming and visual usability.
