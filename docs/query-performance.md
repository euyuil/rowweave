# Query performance follow-up

These measurements track the performance acceptance item in [gap-closure-plan.md](gap-closure-plan.md). They cover compiled service calls, not renderer latency or frame rate.

## Grouped summaries

Grouped summaries previously scanned and filtered records separately for totals, group counts and the requested group page. The query now materializes only the needed scalar values once, aggregates groups once, and reuses them for counts and bounded group pages. Overall averages still use all non-null record values; they are not averages of group averages. Ungrouped summaries retain their direct aggregate query.

The 2026-11-13 run used clean source `38e6c49ec8055788f25d35dc63a4a5cab6c053a4`, Node 24.22.1, SQLite 3.53.4, Windows 10.0.22631 x64, Intel Core i7-8700K at 3.70 GHz (12 logical processors), and 34,302,324,736 bytes RAM. Display settings do not apply to this service-only workload. No local GUI suite ran concurrently. Production build and all 187 locally selected Node tests passed; the local IPv6 fixture was excluded and remains covered by CI.

Reproduce with `npm run build`, then `node scripts/benchmark-grouped-dates.mjs`. It creates a temporary 100,000-record, five-field dataset, matches 50,001 records using a relative seven-day filter, warms each read twice and records 20 samples. Each measured result is checked outside its timed interval. Seed time (13.8 s) and view preparation (600.0 ms) are separate from read timings. p95 uses nearest rank.

| Workload | Before p95 | After p95 | After range |
| --- | ---: | ---: | ---: |
| Group counts for the relative-date view | 592.5 ms | 191.4 ms | 164.8–205.5 ms |
| Grouped ordered page, 100 records | 32.8 ms | 31.4 ms | 24.6–32.0 ms |
| Relative-date page, 100 records | 151.0 ms | 193.1 ms | 138.4–203.8 ms |
| Grouped relative-date page, 100 records | 162.8 ms | 169.7 ms | 134.5–170.2 ms |

The baseline is clean source `500e00c82fa81cf21272dba464cee0331213ae64` from [connected-workflow-validation.md](connected-workflow-validation.md). Complete raw reports remain in `.artifacts/grouped-date-performance-fAFGnh/results.json` and `.artifacts/grouped-date-performance-PgPAkj/results.json`. The grouped-summary samples below retain their observation order, rounded to 0.0001 ms:

```text
Before: 576.6545, 531.1450, 513.7725, 557.3749, 558.0401, 550.0367, 535.7408, 553.0304, 536.5063, 592.2007, 580.0081, 558.2320, 550.5470, 558.8772, 567.3855, 563.0648, 592.4962, 569.1820, 594.1642, 554.5440
After:  180.1023, 181.8375, 165.3831, 169.7252, 173.0099, 178.8119, 178.9382, 174.7486, 183.2916, 179.8217, 205.4519, 183.6426, 174.5783, 191.3544, 168.5892, 177.7087, 172.1661, 173.8732, 164.7819, 188.7911
```

Regression tests verify unequal group sizes with null values, empty results, pages beyond the final group, overflow, stable select identities, linked summaries, HTTP/SDK behavior and one predicate evaluation per input record. This closes the measured grouped-summary bottleneck only. Linked-summary filter/sort performance and the other workflow acceptance items remain open.
