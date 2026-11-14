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

## Initial findings and remaining work

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

## Streaming layout follow-up

The service streams ordered record keys and retains only the active ancestry and requested segments, accumulating complete counts as it reads. Zero-count root seeds share the ordering, so configured empty headings need no separate full hierarchy or leaf-count aggregation. Only returned paths and labels are allocated. A second statement calculates complete selected measures directly from matching values within the same read transaction; SQLite still owns numeric aggregation. No persisted format, API contract, query cache or record identity changes.

- Final source: `e5b9710018a97ec6cff979ad17849b847dabfe58`, with `uncommittedChanges: false`.
- Measured at: `2026-11-13T23:58:19.110Z`.
- Environment, dataset, two warm-ups and 20 measured reads per workload are unchanged from the initial method above. No local tests or other benchmarks ran concurrently.
- Raw final report: `E:/euyuil/rowweave/.artifacts/nested-group-performance-7Bu82c/results.json`.
- An intermediate clean implementation at `5e6107ec2923c33a5a47ab16abff455d8e23eed2`, measured at `2026-11-13T23:43:14.088Z`, still missed the 500 ms p95 target in two workloads. Its complete report remains at `E:/euyuil/rowweave/.artifacts/nested-group-performance-xeRsB8/results.json`; the results below retain it rather than substituting exploratory samples.
- A second clean implementation at `68f0b6492974571c04d13e3f9b13831136f3ce7c`, measured at `2026-11-13T23:51:34.392Z`, reduced sorting and allocations but still missed the target. Its sparse workload included a 1,268.4 ms maximum; this report does not attribute that sample to a confirmed cause. Its complete report remains at `E:/euyuil/rowweave/.artifacts/nested-group-performance-5LkRkt/results.json`.

| Workload | Initial p95 (ms) | First intermediate p95 (ms) | Second intermediate p95 (ms) | Final p95 (ms) | Final minimum–maximum (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100,000 distinct roots, all collapsed | 410.1 | 409.7 | 406.8 | 409.4 | 397.7–412.9 |
| 100,000 distinct roots, three levels expanded | 1517.3 | 401.1 | 362.7 | 324.9 | 315.2–326.8 |
| Collapsed roots, four measures | 438.5 | 470.7 | 481.3 | 431.8 | 421.3–432.7 |
| 100 roots / 1,000 children / 100,000 leaves, four measures | 823.4 | 592.6 | 512.7 | 475.2 | 422.4–514.8 |
| 100 roots / 1,000 leaves, four measures | 379.9 | 343.2 | 309.4 | 369.6 | 354.0–395.1 |
| Two distant expanded leaves, four measures | 844.7 | 548.5 | 833.3 | 426.1 | 414.9–426.8 |

All six measured service workloads are now below 500 ms p95. The final balanced workload retains a 514.8 ms maximum; this is a p95 result, not a maximum-latency guarantee. These direct service measurements do not establish renderer, HTTP, native input or current packaged performance. Those checks remain part of final-candidate acceptance under the active delivery goal.

Type checking, the production build and all 369 locally supported Node tests passed. Nested regressions now also cover literal select IDs, zero-count roots sharing actual null paths, deep windows across leaves larger than a record page, concurrent commits between the count and measure reads, and complete SQLite aggregation across cancellation-sensitive numeric values. An isolated differential check compared 3,140 windows/collapse/filter/measure combinations with the previous layout implementation. Business-only validation was used for this optimization; no new manual GUI or native-input claim is made.

### Intermediate clean-source samples

Milliseconds in collection order, rounded to four decimal places.

```json
{
  "distinctCollapsed": [409.6815, 400.6457, 400.0116, 399.2648, 403.1215, 402.5142, 397.194, 405.4904, 399.4335, 401.2314, 402.8897, 406.638, 408.8133, 411.8359, 407.4588, 401.2175, 404.2461, 403.8748, 401.1456, 404.1283],
  "distinctExpanded": [382.4282, 387.3423, 392.6921, 400.5065, 401.0818, 395.8338, 396.2135, 394.2184, 392.4873, 392.4142, 396.2394, 393.6721, 447.4449, 390.609, 393.2763, 392.0092, 390.0467, 393.449, 391.2681, 391.8277],
  "distinctCollapsedMeasures": [431.5949, 472.1263, 434.4233, 470.7284, 443.3586, 436.8813, 437.2535, 460.0595, 470.5107, 435.9439, 430.9335, 438.2418, 433.7166, 429.4388, 428.8345, 430.1807, 437.7947, 431.171, 432.0356, 428.1606],
  "balancedExpandedMeasures": [560.6301, 583.7194, 566.8911, 599.3806, 538.9222, 541.9558, 538.4896, 538.9455, 535.9075, 547.0748, 537.2647, 540.8142, 542.3478, 532.8216, 592.6292, 555.5, 537.8724, 534.5267, 537.9381, 537.3991],
  "twoLevelExpandedMeasures": [338.7538, 335.6357, 339.3753, 336.1125, 342.2451, 343.1665, 340.8501, 342.2944, 342.2156, 337.7088, 339.0527, 342.1836, 338.2336, 337.0033, 336.133, 339.9859, 339.9649, 339.0578, 339.5896, 351.3673],
  "sparseExpandedMeasures": [528.9641, 515.3808, 516.4574, 527.6204, 517.7452, 520.0429, 520.4883, 521.0403, 516.051, 518.773, 520.01, 513.4586, 523.2786, 546.4826, 550.2571, 548.4752, 523.4285, 529.2377, 534.6622, 523.1808]
}
```

### Second intermediate clean-source samples

Milliseconds in collection order, rounded to four decimal places.

```json
{
  "distinctCollapsed": [396.9895, 401.073, 399.7009, 406.8051, 405.1583, 400.1165, 399.0303, 405.2535, 400.4875, 400.2788, 400.2067, 404.5806, 402.8126, 403.2968, 402.7437, 400.7222, 401.5384, 401.5833, 411.0071, 404.4105],
  "distinctExpanded": [332.854, 344.9355, 334.9647, 340.3137, 353.6776, 353.8764, 354.2112, 362.6779, 357.1769, 353.5977, 350.0721, 356.0106, 356.1741, 350.5507, 354.9388, 365.0977, 354.3787, 358.2134, 355.4745, 354.6861],
  "distinctCollapsedMeasures": [445.7284, 428.9682, 433.4008, 433.6755, 468.0793, 481.3328, 471.1818, 528.3484, 437.902, 437.8836, 428.1271, 432.3875, 427.1836, 448.2995, 444.0045, 430.3934, 437.7181, 437.0755, 441.2771, 431.8795],
  "balancedExpandedMeasures": [472.1056, 498.6885, 484.2513, 477.5239, 478.1855, 479.0637, 464.6698, 475.4261, 478.0237, 480.133, 468.0455, 484.6445, 492.2359, 512.7338, 495.2157, 525.7038, 494.9057, 474.8745, 501.5702, 491.535],
  "twoLevelExpandedMeasures": [298.3654, 301.1147, 310.6252, 309.4187, 299.4312, 300.3721, 297.3079, 297.5278, 296.9778, 298.2793, 295.8774, 292.8354, 296.7001, 297.5736, 292.6348, 296.2628, 293.902, 296.5848, 298.0775, 298.2838],
  "sparseExpandedMeasures": [629.9342, 536.3789, 507.4353, 459.9811, 449.4009, 479.4515, 455.5427, 454.8899, 448.9597, 451.0172, 449.4281, 445.9452, 458.6224, 480.1017, 464.892, 696.3713, 611.2014, 1268.4384, 833.3481, 569.2297]
}
```

### Final clean-source samples

Milliseconds in collection order, rounded to four decimal places.

```json
{
  "distinctCollapsed": [400.739, 398.9058, 399.6798, 400.6646, 397.6608, 399.4289, 403.8339, 409.3863, 405.0447, 402.9906, 405.1448, 412.9127, 408.5373, 404.4009, 401.0865, 399.3941, 403.6475, 400.3495, 401.3865, 404.9312],
  "distinctExpanded": [321.7161, 324.3641, 324.8835, 319.107, 326.823, 319.3109, 317.8419, 319.6623, 320.2323, 317.7946, 317.3102, 317.7947, 320.2005, 317.6598, 324.7412, 318.5932, 316.1046, 320.1041, 322.915, 315.1581],
  "distinctCollapsedMeasures": [430.2715, 430.4392, 421.3309, 427.2526, 429.2057, 428.8969, 432.6876, 427.7329, 423.8257, 426.1921, 426.5193, 428.8022, 431.8, 429.3567, 431.0228, 430.9364, 426.7881, 426.1078, 425.223, 424.1653],
  "balancedExpandedMeasures": [425.9058, 431.5935, 461.968, 461.0073, 440.3548, 514.7987, 442.5995, 463.5566, 447.2833, 475.1858, 434.983, 422.3704, 448.526, 440.5006, 430.9472, 432.5172, 424.5193, 428.1181, 448.123, 425.4823],
  "twoLevelExpandedMeasures": [361.1822, 356.8592, 354.7808, 360.9913, 357.5622, 359.1128, 358.0095, 362.7949, 356.1871, 359.526, 355.9227, 359.7294, 362.3152, 355.2493, 354.0473, 356.8846, 359.5635, 363.3539, 395.116, 369.6409],
  "sparseExpandedMeasures": [425.4034, 419.7072, 425.2466, 426.7903, 426.1271, 417.0734, 420.7954, 424.9578, 418.3446, 424.6618, 419.6709, 420.8869, 418.1851, 419.3253, 414.8513, 424.4897, 421.1621, 417.2392, 420.954, 424.8893]
}
```
