# Query performance follow-up

These measurements track the performance acceptance item in [gap-closure-plan.md](gap-closure-plan.md). They cover compiled service calls, not renderer latency or frame rate.

## Bounded group layouts

The 2026-11-14 local run used the grouped-layout working tree based on `dde1afe64e49a8ad91985016aa3db6666b4cef2f`, Node 24.22.1, SQLite 3.53.4, Windows 10.0.22631 x64, Intel Core i7-8700K at 3.70 GHz (12 logical processors), and 34,302,324,736 bytes RAM. Display settings do not apply. No local GUI or Node test suite ran concurrently with the measurements. These are production-compiled service calls, excluding HTTP and renderer work.

Reproduce with `npm run build`, then `node scripts/benchmark-group-layout.mjs`. The script creates 100,000 records in reverse group-key order, with 100,000 distinct text groups and an additional empty null heading. Each read warms twice, then takes 20 samples; p95 uses nearest rank. It independently checks complete counts, record offsets, display positions, contiguous coverage and matching record order outside each timed interval. The response contains only groups intersecting 50 display rows, even when 50,000 typed keys invert the default collapse state. Seeding took 49.5 s, outside timed reads.

| Workload | p95 | Observed range |
| --- | ---: | ---: |
| Expanded first window | 402.5 ms | 366.8–459.6 ms |
| Expanded deep window | 374.4 ms | 365.4–375.8 ms |
| All-collapsed deep window | 424.9 ms | 364.2–440.2 ms |
| Deep window with 50,000 collapse exceptions | 462.4 ms | 420.9–472.2 ms |
| Matching grouped record page, 50 records | 315.7 ms | 292.5–319.0 ms |

The initial implementation materialized two unnecessary intermediate row sets and reached 524.6 ms p95 for the 50,000-exception case. Removing those intermediates retained all grouping semantics and reduced that case below the 500 ms service target. Both runs evaluated every input group inside SQLite; bounded responses do not imply constant-time database work.

Raw reports are retained in `.artifacts/group-layout-performance-6E65zS/results.json` (initial) and `.artifacts/group-layout-performance-qZM2iU/results.json` (optimized). The optimized large-exception samples, in observation order and milliseconds, are:

```text
440.3352, 445.9701, 443.0129, 420.8670, 458.7978, 432.8246, 462.3575, 437.3202, 472.1961, 447.1628,
447.7427, 428.3659, 450.6181, 443.1593, 455.6295, 424.9940, 441.2839, 449.2877, 447.1575, 426.2094
```

This verifies the read API's large-group boundary. Broader editable grouping, nested groups, persisted collapse and final renderer/native acceptance remain required.

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

## Linked-summary queries

Record queries now reuse each referenced scalar linked summary for filtering, sorting and counting within one SQLite read snapshot. The materialized input is restricted to the requested table and record IDs; when filtering does not need computed values, that filter also runs before projection. The requested page and complete count share the matching set. Queries without scalar linked-summary references keep the original indexed path. Returned records still hydrate current relation labels, values and errors through the shared service.

The follow-up used clean source `0b82eb506375d055f891b11073dad5ea1d5c65c2` on 2026-11-13, with the same machine, OS and runtime versions listed above. Strict type checking, production build and all 188 locally selected Node tests passed. Added cases count actual linked-expression evaluations, verify multiple computed sort/filter fields, empty and past-end pages, narrow stored-field filters and explicit record IDs. Existing index, relative-date, aggregate error, revision, HTTP and SDK cases also pass. No renderer or native-input claim is made.

Reproduce with `npm run build`, then `node scripts/benchmark-linked.mjs`. The isolated dataset contains 10,000 source records, 1,000 target records and 100,000 links. The filter matches 4,800 source records; sorting returns 100. After two warm-ups, every one of 20 page samples verifies the complete matching count, record order and linked values against independently calculated fixture expectations, outside the timed interval. Summary samples and the read after a target change are also checked. Dataset creation took 13.4 s, outside timed reads.

| Workload | Before | After |
| --- | ---: | ---: |
| Linked-summary filter/sort, p95 of 20 | 732.4 ms | 347.4 ms |
| Linked-summary filter/sort, observed range | 669.8–735.3 ms | 312.2–357.9 ms |
| Full-table linked sum, maximum of 5 | 292.9 ms | 291.2 ms |
| Query after a target update, one sample | 725.5 ms | 336.3 ms |

Raw reports remain in `.artifacts/linked-performance-v5Usxx/results.json` and `.artifacts/linked-performance-yl8xmC/results.json`. The filter/sort samples below retain observation order, rounded to 0.0001 ms:

```text
Before: 700.9880, 696.0123, 681.3910, 669.8228, 685.8450, 705.1210, 694.8221, 696.2628, 732.4061, 700.4516, 675.9685, 684.9694, 735.2576, 704.6088, 730.5089, 700.9167, 727.3294, 717.6279, 673.7082, 717.6071
After:  316.8034, 344.8682, 339.9002, 329.7556, 340.1529, 326.1827, 333.6898, 333.7707, 334.1166, 326.2971, 322.5522, 335.5433, 328.0400, 357.8884, 337.0912, 338.9804, 347.3883, 324.0630, 312.2066, 325.1380
```

Both specified query workloads now measure below the 500 ms p95 criterion. This does not close the remaining functional inventory or establish UI input/scrolling performance; those remain explicit acceptance items.
