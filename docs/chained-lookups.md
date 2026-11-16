# Chained lookups

A lookup can target another lookup in its linked table. For example, a portfolio can collect item amounts through its collections, or sum the totals already calculated on those collections. Use the existing field-create/update operations through HTTP, SDK, CLI or MCP; the desktop target chooser is tracked separately in the [active delivery plan](gap-closure-plan.md).

```ts
const table = await api.createField(portfolios.id, {
  expectedVersion: portfolios.version,
  name: 'Item amounts',
  type: 'lookup',
  lookup: { relationFieldId: collectionsLink.id, fieldId: collectionAmounts.id },
});
```

`relationFieldId` identifies a linked-record field in the source table. `fieldId` identifies a non-relation field in that field's target table, including another lookup. Both identities stay stable when names or positions change. Lookup fields remain read-only and cannot have defaults, require values or serve as primary display fields.

## Values and summaries

The `values` operation flattens array targets in outer-link order, then in each target's existing value order. It retains repeated values, null members, booleans, numeric strings and select/file IDs. An empty inner array contributes no members. A scalar summary contributes one value per linked record, including null for an empty sum and zero for an empty count.

For example, inner arrays `[null, 2]`, `[]` and `[2, 0]` produce `[null, 2, 2, 0]`. A numeric sum returns `4`; numeric count returns `3`. Summaries accept numeric array or scalar targets and ignore nulls. Sum, average, minimum and maximum inherit the effective numeric formatting; count remains a plain number. A chain through a count does not inherit currency formatting from that count's original input.

Calculated lookup arrays contain at most 40,000 items, matching the existing formula-array limit. An oversized result is null with an explicit `formulaErrors` entry, never a successful truncated array. Numeric summaries can consume several valid inner arrays without constructing an output array. Numeric overflow and linked calculation errors are explicit. Values lookups retain valid partial members alongside their error, consistent with direct formula lookups; numeric summaries return null while an input error remains. Fixing the input clears downstream errors and recalculates dependent formulas in the same transaction.

## Schema and revisions

Field dependencies must be acyclic, including cycles through formulas and other tables. Tables may refer to one another when their field dependency graph remains acyclic. Deleting a target or its relation requires removing dependent fields first. Changing an intermediate result type validates downstream numeric summaries and saved view operands before any schema or data change commits.

Result metadata, option labels/colors, file ownership and numeric formatting resolve through the complete chain. Returned lookup fields include nested `lookupResult` definitions and `lookupResultTableId`, the owning table of each immediate target field. These are read-only response properties and are not persisted as editable field configuration. For attachment downloads, follow the nested results to the attachment field's owning table.

Source changes propagate data revisions through lookup-only chains as well as formula chains, so stale continuation requests fail with `DATA_CHANGED`. Schema changes advance dependent table schema versions once per distinct table and reconcile saved views. A lookup read does not rewrite records; a stored formula changed by the same operation advances its record version once.

SQLite format 38 marks support for lookup-to-lookup targets. Upgrading preserves existing IDs, values, schema versions and view settings. Older applications reject this newer format. Restart and workspace backup/restore retain nested calculations and their original dependencies.

## Verification and performance

SQLite tests cover typed flattening, empty/scalar summaries, pure and mixed cycles, table cycles, transitive schema/view validation, operation changes, error recovery, numeric overflow, file ownership, typed queries/CSV, the 40,000-item boundary, sixteen mixed levels, migration, restart and backup. Real SDK/CLI/MCP tests create chained fields and compare their schemas, results, read-only errors and stale revisions through authenticated HTTP.

Run `npm run build`, then `node scripts/benchmark-chained-lookups.mjs`. It creates isolated data under `.artifacts/`, records the exact source state, machine, runtime and raw samples, and checks every result outside the timed interval. The workload has 1,000 items, 1,000 collections, 10,000 portfolios and 25,000 links, yielding ten numeric members per portfolio. Each read warms twice and records twenty samples. Dataset creation is measured separately.

During implementation, a 40,000-item regression initially took about 156 seconds because error extraction reparsed a whole linked JSON result for every expanded member. Materializing each linked value/error pair before expansion reduced that complete regression to about 2.2 seconds. A separate in-memory three-level, 10,000-member SQL probe fell from 854.5 ms to 15.6 ms. These are diagnostic measurements, not renderer or final-package acceptance claims. Production-service measurements and final-candidate gates remain in the active plan.

The first clean-source production run at `5e08878bfa96e48a262a4edfcc767e0dc8c6e74a` failed the 500 ms query target: filtered/sorted chained summaries measured p95 980.2 ms, with a 1,087.1 ms maximum. A same-dataset SQL comparison identified avoidable intermediate JSON work for summaries over a direct numeric lookup. That case now aggregates both relation levels directly, retaining null, duplicate-member, formula-error and overflow semantics. Deeper chains and scalar-summary targets keep their complete calculated-result handling. The optimized clean-source run reached p95 414.7 ms for chained summaries and 34.8 ms for value pages; original direct-lookup workloads also remained below 500 ms. The [measurement report](chained-lookup-performance.md) retains both revisions, environment, method, failed results and all raw samples.
