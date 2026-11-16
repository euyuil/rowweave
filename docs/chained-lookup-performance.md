# Chained lookup performance

These measurements cover production-compiled service calls for [chained lookups](chained-lookups.md), excluding HTTP, renderer and native input. They do not close the final-candidate gate.

## Environment and reproduction

Measured on 2026-11-16 with Node 24.22.1, SQLite 3.53.4, TypeScript 7.0.2, Windows 10.0.22631 x64, Intel Core i7-8700K at 3.70 GHz (12 logical processors), and 34,302,324,736 bytes RAM. Display settings do not apply. No local test suite or second benchmark ran concurrently; ordinary desktop activity was not isolated. Both recorded source revisions were clean.

Run `npm run build`, then `node scripts/benchmark-chained-lookups.mjs` and `node scripts/benchmark-linked.mjs` sequentially. Each creates its own synthetic database under `.artifacts/`. The chained fixture has 1,000 items, 1,000 collections, 10,000 portfolios and 25,000 links, with ten numeric values per portfolio. Its two workloads warm twice and record twenty samples. Every measured result is checked outside the timed interval against independently calculated counts, order and values. p95 uses nearest rank.

The original direct-lookup fixture has 10,000 source records, 1,000 targets and 100,000 links. Its filtered/sorted page has twenty samples after two warm reads; its complete-table summary has five samples. Seeding and the single update/post-update observations are separate from the read measurements.

## Results

The initial implementation at `5e08878bfa96e48a262a4edfcc767e0dc8c6e74a` failed the 500 ms chained-summary target. A same-dataset SQL probe identified intermediate JSON construction/parsing as avoidable for summaries over a direct numeric lookup. Those summaries now aggregate the two relation levels directly. Formula errors, nulls, duplicate members and numeric overflow retain their tested behavior; deeper arrays and scalar-summary targets still use the complete calculated result.

| Source / workload | p95 | Observed range |
| --- | ---: | ---: |
| Initial chained filtered/sorted page, 100 records | 980.2 ms | 528.7–1,087.1 ms |
| Initial chained values page, 100 records | 50.2 ms | 27.3–51.8 ms |
| Optimized chained filtered/sorted page, 100 records | 414.7 ms | 225.4–419.8 ms |
| Optimized chained values page, 100 records | 34.8 ms | 18.6–42.1 ms |
| Original direct-lookup filtered/sorted page, 100 records, after optimization | 261.8 ms | 205.8–264.0 ms |
| Original direct-lookup complete-table summary, after optimization | 229.4 ms | 174.2–229.4 ms |

The optimized runs use clean source `482ee570324486e9981bdb645e7d6cf94040c111`. The two chained workloads and the original direct workloads pass the 500 ms service target. Chained seeding took 10.58 s and direct seeding took 14.22 s. The original target-update and subsequent page took 32.0 ms and 223.5 ms respectively; these are single observations, not percentile measurements.

Type checking, production build and all 456 Node tests passed after the optimization. The 40,000-item limit, sixteen-level chain, rollback/error recovery and authenticated SDK/CLI/MCP regressions remain covered. Desktop chain configuration, current renderer performance and final package/native acceptance remain pending in the [active plan](gap-closure-plan.md).

## Raw samples

All samples below are milliseconds in observation order. Full machine/source reports remain under the named artifact directories; generated databases are not source files.

### chained-performance-QmJugW

Source: `5e08878bfa96e48a262a4edfcc767e0dc8c6e74a`; clean: true; measured at 2026-11-16T05:59:26.006Z.

Seed: 12984.6535 ms.

filteredSortedPage100:

```text
748.2674, 619.9405, 607.7454, 613.8443, 695.2858, 680.8296, 528.6748, 592.8924, 745.7504, 781.4170,
721.2803, 776.7387, 738.0503, 596.1435, 666.3271, 915.1874, 962.2772, 949.9925, 1087.0737, 980.1933
```

projectedValuesPage100:

```text
39.6566, 45.0358, 41.2426, 36.6156, 45.0757, 46.9518, 43.0555, 42.8628, 44.7902, 48.5206,
51.7943, 46.3164, 34.0552, 27.2897, 40.6577, 50.1903, 38.1932, 40.4374, 35.7040, 31.7177
```

### chained-performance-34PIeZ

Source: `482ee570324486e9981bdb645e7d6cf94040c111`; clean: true; measured at 2026-11-16T06:06:30.84Z.

Seed: 10580.0539 ms.

filteredSortedPage100:

```text
284.2943, 288.3011, 279.6967, 291.0378, 267.0370, 251.8746, 310.0106, 299.6840, 225.3966, 328.9794,
412.3359, 414.7136, 301.7137, 295.0519, 361.7125, 274.3736, 419.8092, 322.9573, 282.1815, 279.0621
```

projectedValuesPage100:

```text
31.2842, 42.1316, 33.3623, 34.8286, 32.6173, 31.9540, 31.7883, 20.9880, 24.2848, 18.5599,
26.8384, 32.3691, 31.0554, 27.4246, 27.6819, 34.1938, 32.5869, 21.2735, 25.3767, 27.0237
```

### linked-performance-pPzzI8

Source: `482ee570324486e9981bdb645e7d6cf94040c111`; clean: true; measured at 2026-11-16T06:06:49.318Z.

seed10000Groups100000Links:

```text
14222.4198
```

filteredSortedPage100:

```text
219.2078, 246.7689, 220.8562, 210.6026, 212.1880, 213.2000, 224.0689, 206.0323, 215.4136, 242.6322,
211.3886, 205.8381, 261.8068, 263.9973, 251.6257, 251.1297, 246.5926, 221.3024, 231.6536, 248.3574
```

fullTableSummary:

```text
229.3943, 226.8920, 197.2513, 174.2108, 207.7717
```

updateTargetWith100Dependents:

```text
31.9859
```

queryAfterTargetUpdate:

```text
223.5356
```
