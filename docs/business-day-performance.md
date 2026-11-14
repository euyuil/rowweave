# Business-day query measurements

All six saved-view workloads below met the current 500 ms p95 service-query target on this machine. The slowest p95 was 425.7 ms; the largest single sample was 454.9 ms. These measurements cover the compiled service, including complete counts and bounded record hydration. They do not measure HTTP, renderer input/scrolling or native UI behavior.

## Source and environment

- Run started: 2026-11-14T01:21:50.431Z.
- Clean source: `e610759b970d0b52de3024fe8e8e64450eaf560e`; uncommitted changes: `false`.
- OS: Windows_NT 10.0.22631 x64.
- CPU: Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz; 12 logical processors.
- Memory: 31.95 GiB.
- Node: v24.22.1; SQLite: 3.53.4. Dependency versions are pinned by the source lockfile.
- Display settings: not applicable to these service-only calls. No local tests or other benchmarks ran concurrently.

## Reproduce and verify

From the repository root, use the declared Node version and lockfile, then run:

```sh
npm ci
npm run build
node scripts/benchmark-business-days.mjs
```

The script creates an isolated generated SQLite workspace under `.artifacts/business-day-performance-*` and writes a JSON report. It never opens the user's workspace. The dataset contains 100,000 chronological instants across 2010–2045, matching date and timestamp fields and a text label. Every 37th row has null date/timestamp values. The saved views use the exact clocks, zones and periods declared in the script.

Each workload performs two warmups and 20 measured first-page reads. A read resolves the relative period, counts the complete matching dataset and returns up to 50 records with query guards. Independent weekday iteration and `Intl` local-date formatting determine the expected matching UUIDs. Every measured read checks the total, exact returned UUIDs and context; a guarded second page is checked afterward. Workspace state must remain unchanged. p95 uses the nearest-rank 19th sorted sample of 20.

## Results

All times are milliseconds.

| Workload | Matching records | Minimum | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Next 5 weekdays, New York timestamp, crossing spring DST | 39 | 209.6 | 216.4 | 218.8 |
| Past 3,660 weekdays, UTC date | 27,856 | 159.9 | 163.8 | 164.6 |
| Past 3,660 weekdays, New York timestamp | 27,857 | 399.5 | 414.7 | 454.9 |
| Next 3,660 weekdays, New York timestamp | 27,858 | 417.8 | 425.7 | 427.3 |
| Past 3,660 weekdays, Lord Howe timestamp | 27,854 | 398.8 | 413.4 | 414.7 |
| Next 3,660 weekdays, Kathmandu timestamp | 27,857 | 181.9 | 185.7 | 187.3 |

Long timestamp windows include multiple UTC-offset transitions. The service resolves those intervals once per request and SQLite evaluates local weekdays using fixed offsets. This avoids per-record time-zone conversion and preserves complete matching counts at the maximum supported business-day duration.

## Regression evidence

Type checking, production build and all 388 locally supported Node tests passed. Business-day regressions cover weekday counting across weekends/leap years, public-holiday semantics, exact timestamp boundaries, skipped dates, historical second-level offsets, half-hour DST, maximum windows, complete linked-value matching, nested groups, summaries/CSV, stale continuation, restart/backup and SDK/CLI/MCP parity. Focused automated desktop acceptance verifies date/timestamp settings, unit changes, persisted rules, matching UUIDs, summaries and the visible first row; its settings screenshot was reviewed. Native input methods and the complete final-candidate renderer/package measurements remain in the delivery inventory.

## Raw samples

Values are in execution order, in milliseconds.

### shortNextTimestamp

211.302, 210.348, 212.728, 212.416, 215.180, 212.467, 211.405, 216.375, 210.660, 211.261, 212.454, 210.883, 212.616, 213.216, 210.374, 210.961, 209.628, 213.713, 218.797, 212.544

### longPastDate

161.671, 162.647, 161.513, 161.104, 163.576, 162.063, 159.881, 159.940, 162.130, 163.813, 162.386, 164.588, 161.150, 162.864, 159.953, 162.033, 163.827, 161.190, 161.977, 161.383

### longPastTimestamp

406.071, 407.793, 403.228, 405.207, 404.057, 406.462, 399.474, 405.956, 403.265, 413.140, 401.106, 414.666, 407.290, 454.892, 402.062, 407.572, 406.335, 409.212, 402.631, 406.021

### longNextTimestamp

419.476, 425.746, 420.941, 419.432, 419.606, 422.362, 423.125, 422.708, 419.226, 419.379, 421.233, 423.734, 420.029, 417.817, 422.741, 427.349, 421.592, 422.290, 418.781, 421.339

### halfHourTimestamp

404.916, 402.793, 407.504, 401.540, 403.289, 405.546, 400.023, 405.847, 405.456, 414.743, 406.087, 406.496, 406.343, 408.822, 404.133, 400.014, 404.713, 398.817, 402.966, 413.366

### fixedOffsetTimestamp

182.001, 183.701, 184.630, 183.814, 183.379, 183.766, 185.289, 182.532, 184.538, 184.152, 185.644, 182.570, 183.431, 182.769, 187.269, 181.873, 183.312, 183.849, 185.744, 183.556
