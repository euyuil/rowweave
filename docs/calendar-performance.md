# Calendar query performance

All six tested 100,000-record service workloads meet the 500 ms p95 target after optimization. Linked numeric filtering and sorting improved from 1365.7 ms to 477.6 ms p95. The final largest individual sample was 479.5 ms. These are compiled service measurements; saved calendar UI and whole-desktop/native acceptance remain separate required work.

## Sources and environment

- Initial source: `bb6e2cca775c2fd57ba00e93d479c45120970131`, clean worktree; run started 2026-11-14T02:16:19.833Z.
- Optimized source: `9df9a8c5407de7868df81b3d6e30a6e7e1a3924c`, clean worktree; run started 2026-11-14T02:39:07.670Z.
- Hardware: Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz; 12 logical processors; 31.95 GiB RAM.
- OS: Windows_NT 10.0.22631 x64. Runtime: Node.js v24.22.1; SQLite 3.53.4; TypeScript 7.0.2; Temporal polyfill 0.5.1, from the repository lockfile.
- Display: not applicable to these service calls. No renderer, browser or debugger participates in timing. No other local tests or benchmarks ran concurrently.

## Workload and method

The versioned `scripts/benchmark-calendar-queries.mjs` creates an isolated workspace with 100,000 intervals spanning 2018–2032, corresponding date/timestamp fields, display labels and one relation per record to 20 numeric-score records. Every 37th start is null; every 41st remaining interval is reversed; every seventh other interval spans 4,000 days; other intervals last zero to four days. This includes point events, overlapping multi-day ranges, empty dates and invalid records.

Saved queries supply sort/filter settings. Five workloads cover all 100,000 records. The linked workload matches 50,000 records, orders them by a numeric lookup and then display label, and projects linked labels/summary values with the calendar fields. Layouts return three previews per bucket and complete counts; bucket pages return 50 records after offset 100. Dataset generation is outside timed reads. Each workload has two warm-ups and 20 measured calls; p95 is the nineteenth ordered sample, with no discarded outliers or repeated runs selected for a better result.

Independent per-day scans verify membership, complete counts, distinct scheduled totals, ordering and all preview/page UUIDs outside the timed region. Timestamp day boundaries use an independent Intl date formatter and binary search rather than the implementation's Temporal resolver. Every workload checks a guarded continuation page and unchanged workspace state. The initial correctness checks passed even though one timing target failed.

| Workload | Initial p95, ms | Optimized p95, ms | Optimized min–max, ms |
| --- | ---: | ---: | ---: |
| Date month, 30 days | 468.0 | 399.0 | 342.1–403.2 |
| Timestamp month, 42 days across US DST | 466.4 | 405.3 | 372.2–458.8 |
| Maximum 62-date window | 473.7 | 404.8 | 342.9–409.3 |
| Linked numeric filter/sort, 31 days | 1365.7 | 477.6 | 413.9–479.5 |
| Busy timestamp day, offset 100 / limit 50 | 468.7 | 397.1 | 373.4–402.9 |
| Invalid intervals, offset 100 / limit 50 | 461.9 | 392.5 | 338.3–396.4 |

The initial 62-date and busy-day runs included maxima of 516.1 and 500.6 ms, respectively; their p95 values still passed. The initial linked workload failed at 1365.7 ms p95. All original samples are retained below.

## Implementation and regression evidence

The layout streams configured scalar values, counts intervals with a difference array and retains bounded preview IDs. Only selected records are hydrated. Linked numeric expressions now reuse grouped ID/value results across filtering and ordering; normal linked queries and the calendar share the aggregate expression, preserving zero counts, null results, formula errors and overflow handling. Record JSON is not copied into a materialized whole-table intermediate.

The workspace storage connection uses a 96 MiB suggested SQLite page-cache limit so the measured index working set remains resident. SQLite allocates its default cache as needed and resets this setting when the connection closes; the cache target does not cap total process memory. See [SQLite's cache-size documentation](https://www.sqlite.org/pragma.html#pragma_cache_size).

Exploratory whole-row materialization remained slower (1,369–1,478 ms). Narrowing that intermediate alone also failed to reach the target. Set-based grouping and a bounded cache were evaluated against the same complete baseline response; empty/error/overflow and multi-field cases were then added as regressions. Exploratory 80 MiB caching still produced a 537 ms sample, while 128 MiB offered no material benefit over 96 MiB. Those probes were working-tree diagnostics, not the clean-source results above. Local logs are `.artifacts/calendar-linked-materialized.log`, `calendar-sql-profile.log`, `calendar-cache-profile.log`, `calendar-join-profile.log`, `calendar-linked-bulk.log` and `calendar-cache-size.log` under the same directory.

Strict type checking, the production build and all 398 locally supported Node tests passed after optimization. Nine calendar SQLite tests cover counts/previews/pages, date/time boundaries, skipped dates, extended normalized years, saved query and field changes, linked projection, null/error/overflow ordering, automatic timestamps, restart and stale revisions/date contexts. Shared HTTP/SDK/CLI/MCP tests cover authentication, identical results, read-only discovery, version conflicts and installed SDK types. UI behavior was not changed in this read-API step; CI still runs the repository's desktop/package checks before merge.

## Separate process-memory check

A fresh service-only process reopened the final generated database at 2026-11-14T02:41:34.911Z, using the same clean source. It retained no dataset-generation arrays. After two warm-up circuits, eight measured circuits each read a linked month layout, whole-table date layout and linked day page. Each circuit checked counts and versions; the final workspace state remained unchanged. There was no forced garbage collection or renderer.

Process RSS was 57.91 MiB initially and 167.30 MiB after warm-up. The eight measured RSS samples were:

```text
168.13, 168.93, 169.29, 174.85, 176.86, 180.89, 180.94, 180.94 MiB
```

Maximum measured RSS was 180.94 MiB; the spread across the last three equivalent circuits was 0.05 MiB (53,248 bytes), below 50 MiB. RSS includes Node, SQLite and allocator memory. This establishes stability for the isolated service workload; it does not establish the whole-desktop 650 MiB target or native-input performance. Raw memory data is `.artifacts/calendar-performance-u2S8cX/memory-results.json`.

## Reproduction and raw samples

Run from a clean checkout of the selected source:

```sh
npm ci
npm run build
node scripts/benchmark-calendar-queries.mjs
node scripts/benchmark-calendar-memory.mjs .artifacts/calendar-performance-GENERATED_DIRECTORY
```

Substitute the generated directory printed by the timing script. Both scripts use isolated generated data; the memory helper rejects paths outside generated benchmark directories. Timing reports are `.artifacts/calendar-performance-ahrqA3/results.json` and `.artifacts/calendar-performance-u2S8cX/results.json`. The following samples preserve observation order, in milliseconds rounded to four decimals.

### Initial clean source

```text
dateMonth: 437.4184, 450.7107, 452.6673, 465.2422, 468.9435, 419.4029, 427.0633, 436.7024, 452.4636, 455.4427, 468.0347, 467.0591, 422.3434, 432.5003, 437.5241, 424.2252, 428.1774, 435.1688, 442.2362, 459.6380
timestampDST: 463.2216, 439.2722, 450.1866, 453.3749, 458.9845, 458.7001, 455.7147, 467.1265, 461.2780, 461.9326, 447.9025, 458.9077, 446.6517, 447.2017, 455.9259, 459.8384, 466.3624, 449.8994, 455.0859, 453.4442
sixtyTwoDates: 457.7476, 473.6697, 466.5195, 427.0206, 443.9463, 516.0532, 464.6320, 463.9953, 411.7081, 424.0276, 442.6668, 441.4764, 450.3884, 461.9596, 466.8984, 420.4670, 421.2557, 430.1969, 435.1429, 450.9874
linkedFilterSort: 1365.7206, 1303.7443, 1319.3720, 1374.5683, 1296.7801, 1339.5361, 1299.8870, 1308.8964, 1327.7599, 1303.3512, 1303.8894, 1283.2125, 1306.2738, 1310.2827, 1343.6197, 1353.5274, 1295.5565, 1303.2259, 1316.1052, 1288.0006
busyDayPage: 447.5091, 453.9150, 447.8791, 453.3907, 456.2103, 439.6089, 450.1160, 452.2482, 454.5960, 468.7397, 500.6068, 454.2898, 443.9236, 454.7993, 445.7483, 442.4704, 441.9259, 447.1407, 445.4865, 446.8864
invalidPage: 419.0757, 460.7594, 414.4693, 416.9912, 436.9106, 440.1670, 448.8374, 460.0122, 400.0049, 423.8179, 423.1545, 434.2530, 461.8790, 458.5167, 468.1089, 407.8966, 417.2232, 429.9697, 446.2554, 459.7469
```

### Optimized clean source

```text
dateMonth: 372.0228, 376.5531, 393.0569, 389.4877, 403.2005, 342.0515, 352.6589, 362.0939, 373.5382, 383.3602, 395.8425, 398.9558, 345.6648, 358.9346, 363.5254, 354.5975, 356.0759, 366.4663, 374.6776, 386.6538
timestampDST: 397.1202, 405.2753, 392.8843, 391.4023, 391.2163, 389.4715, 398.4047, 393.2499, 402.5860, 401.5246, 372.2259, 383.3375, 395.3513, 377.5352, 394.0155, 389.5330, 458.8454, 405.0403, 397.8397, 385.7829
sixtyTwoDates: 371.2402, 387.1731, 389.0479, 396.0592, 409.3109, 342.8987, 361.0127, 404.8360, 350.4612, 351.6028, 360.3317, 386.4059, 394.9972, 404.5149, 404.2585, 348.9590, 350.2663, 360.0642, 371.1646, 394.7950
linkedFilterSort: 459.1640, 451.1547, 456.2346, 448.5892, 459.7302, 459.4212, 463.0431, 477.6497, 465.1827, 479.5052, 470.6700, 454.9898, 465.9871, 463.0014, 458.5356, 413.8922, 447.7766, 450.7716, 455.1802, 452.0845
busyDayPage: 380.5215, 374.3097, 388.3536, 396.5740, 397.0874, 396.6560, 402.8920, 389.7658, 390.1467, 381.0125, 379.3759, 385.4385, 385.6728, 396.1379, 396.4428, 387.3073, 373.4323, 384.2425, 384.5047, 386.4150
invalidPage: 344.9884, 357.0296, 373.7079, 377.8821, 382.9487, 392.4561, 345.6276, 385.2759, 339.6714, 358.5466, 363.1243, 373.7021, 380.7770, 396.4060, 338.3070, 343.3926, 360.8087, 370.8254, 378.7762, 357.5732
```
