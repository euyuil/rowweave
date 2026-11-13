# Nested group query measurements

The shared query interfaces now support two or three scalar grouping levels. These measurements cover compiled service calls against isolated synthetic SQLite data. They do not measure HTTP, renderer frames, native input or packaged desktop behavior.

## Clean source and method

- Source: `e60f5ea8f006543e1353f61bca081365b5da9769`, with `uncommittedChanges: false`.
- Measured at: `2026-11-13T22:44:36.020Z`.
- Environment: Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz, 12 logical processors, 31.95 GiB RAM; Windows_NT 10.0.22631 x64; Node v24.22.1; SQLite 3.53.4.
- Display: not applicable to direct service calls.
- Dataset: 100,000 records inserted in reverse order, each with a unique text value, a numeric bucket, a numeric part and an amount cycling from -50 to 50. There are 100 buckets of 1,000 records and ten parts of 100 records per bucket.
- Method: two warm-up reads and 20 timed reads per workload, run sequentially without concurrent local tests. Every response was checked outside the timed interval for complete counts, bounded segment counts, paths, leaf/source positions and independently calculated numeric measures. Sparse windows also checked expanded offsets. Workspace revisions did not change.
- Reproduce after building: `node scripts/benchmark-nested-groups.mjs`.
- Raw report: `E:/euyuil/rowweave/.artifacts/nested-group-performance-4EkrWp/results.json`.

| Workload | p95 (ms) | Minimum–maximum (ms) |
| --- | ---: | ---: |
| 100,000 distinct roots, all collapsed | 410.1 | 396.2–416.2 |
| 100,000 distinct roots, three levels expanded | 1517.3 | 1365.3–1671.1 |
| Collapsed roots, four measures | 438.5 | 424.2–483.2 |
| 100 roots / 1,000 children / 100,000 leaves, four measures | 823.4 | 802.4–833.9 |
| 100 roots / 1,000 leaves, four measures | 379.9 | 368.1–380.6 |
| Two distant expanded leaves, four measures | 844.7 | 761.1–902.8 |

## Findings and remaining work

The two-level measured workload and all-root-collapsed workloads were below 500 ms p95. Three-level high-cardinality expanded and sparse workloads remain above 500 ms; their latency is still required follow-up under the active grouping goal. This report does not close that performance gap or establish desktop responsiveness.

An exploratory first implementation built every descendant node even under collapsed ancestors. Its p95 values were 1,614.6 ms for collapsed roots, 1,766.5 ms for fully expanded distinct roots, 1,919.2 ms for collapsed roots with measures, 965.9 ms for balanced three-level measures and 1,833.5 ms for sparse expanded measures. Those uncommitted measurements are retained at `.artifacts/nested-group-performance-ShWFnH/results.json`; the initial source is retained at `.artifacts/nested-layout-before-optimization.ts`.

Pruning collapsed descendants reduced layout work. Collapsed branches own their complete source-record span, while only visible leaves own expanded record spans. When every root is collapsed, the existing scalar root layout supplies counts, positions and measures directly. Deeper retained collapse choices do not require hidden descendant layouts. Queries compare path components using checked scalar types instead of serialized JSON text, which can encode numeric zero as either `0` or `0.0`.

The six nested SQLite regressions cover every single-row window in several collapse states, complete parent measures, duplicate child names, configured root order, record UUID/order agreement, linked numeric/boolean keys, normalized timestamp paths, relative-date continuation guards, stale schema/data reads and numeric overflow. The complete 356-test local Node suite and installed SDK/MCP/CLI parity passed. Saved nested views, desktop editing and final native checks remain subsequent work.

## Raw clean-source samples

Times are milliseconds, in collection order.

```json
{
  "distinctCollapsed": [416.2092, 400.1537, 398.334, 396.2154, 404.4821, 405.1971, 400.5616, 397.7861, 396.9401, 398.3711, 402.9255, 397.6656, 402.1678, 399.167, 400.0151, 410.1323, 402.4368, 399.4215, 402.4276, 405.4595],
  "distinctExpanded": [1404.2604, 1385.5509, 1370.0875, 1397.0402, 1517.2696, 1381.578, 1375.6247, 1383.0601, 1475.2139, 1419.376, 1388.507, 1671.1155, 1413.4905, 1389.7729, 1378.4029, 1384.6751, 1402.0164, 1367.4757, 1376.482, 1365.2732],
  "distinctCollapsedMeasures": [429.4183, 424.8517, 427.086, 428.5375, 427.129, 426.2869, 428.9309, 430.1593, 426.2722, 430.1268, 435.5765, 429.3874, 425.531, 430.5836, 425.3178, 438.4515, 429.9208, 425.4096, 424.1528, 483.1626],
  "balancedExpandedMeasures": [819.9375, 822.7371, 823.4266, 813.4873, 833.9303, 812.5298, 816.9508, 818.2823, 803.7835, 814.2315, 819.2606, 811.4192, 819.9616, 821.0502, 821.8652, 809.6743, 802.4323, 818.1605, 819.123, 814.8692],
  "twoLevelExpandedMeasures": [368.0772, 368.3271, 371.5833, 372.2844, 371.3488, 373.8532, 373.5938, 373.8152, 379.9336, 375.3995, 375.9212, 375.7161, 375.3124, 374.3358, 377.0839, 376.1101, 370.4174, 368.1449, 380.566, 373.8184],
  "sparseExpandedMeasures": [763.1434, 775.6758, 782.1133, 798.1537, 832.9314, 815.3956, 802.0583, 902.8449, 775.585, 772.4387, 767.51, 774.7819, 767.0329, 776.9088, 821.2775, 824.9689, 844.7189, 761.0926, 771.5819, 776.2441]
}
```
