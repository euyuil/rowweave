# Pair existing linked fields

Two existing one-way linked-record fields can become the two sides of one relationship. The fields must point at each other's tables, and neither can already be paired. Two distinct fields in the same table are supported. Pairing retains both field UUIDs, names, descriptions, cardinalities, defaults and existing record UUIDs.

Read both current table schemas, then call:

```ts
const paired = await api.pairRelationFields(source.id, sourceField.id, {
  expectedVersion: source.version,
  targetFieldId: reverseField.id,
  expectedTargetVersion: target.version,
});
```

The target table is the source field's existing `relation.tableId`. The result is the complete updated source `Table`; read the target again to obtain its new schema version. Both fields now expose the other's stable `relation.inverseFieldId`. For a self-table pair, supply the same current table version twice.

HTTP uses `POST /tables/:tableId/fields/:fieldId/pair` with the same input. CLI uses `rowweave fields pair TABLE_ID FIELD_ID --input pair.json`. MCP uses `fields_pair` with `{ tableId, fieldId, input }`. This delivery adds the shared operation; the desktop configuration action is tracked separately in the [active inventory](gap-closure-plan.md).

## Keep both sets of links

Pairing takes the union of both sides. If A already links to B, or B already links to A, both links exist afterward. Existing order within each cell stays unchanged. Missing reverse links are appended in source-record position order, with UUID as the tie-breaker. Existing reciprocal entries are not duplicated. Empty/null cells with no new links retain their saved values.

Single-link fields must still contain at most one record, and multiple-link fields at most 200. If the union violates either field's capacity, the entire transaction fails with `INVALID_VALUE`, including all metadata, normalized edges, record values, revisions and history. The service does not choose a winning link or silently remove one. Resolve the conflict explicitly before trying again. Defaults stay unchanged and are subject to the normal reciprocal constraints when new records are created.

## Versions, calculations and recovery

Both schema versions are checked again inside the write transaction. A stale source or target returns `SCHEMA_CONFLICT`. Incompatible field types/targets return `INVALID_SCHEMA`; a missing field returns `FIELD_NOT_FOUND`; an already paired field returns `RELATION_DEPENDENCY`. A lost response is not safe to retry automatically: read both schemas and the current records first.

Each distinct table's schema version advances once. A record receiving new links advances its version once even if both fields or calculated values change. Unchanged records keep their versions. Connected formulas recalculate in the same transaction, and affected tables' data revisions invalidate stale queries. Pairing is a schema operation and preserves user edit timestamps. Saved views retain their identities and settings.

The durable journal captures changed records in one schema-operation batch (`recordWrite: false`). Record-batch undo does not undo schema pairing. Individual historical record values can still be restored under the current paired schema, including its reciprocal constraints and calculation propagation. Reopening and workspace backup/restore preserve the pair and its links. No new database format is needed: this operation uses the existing reciprocal-link representation.

## Verification

SQLite regressions cover union/order preservation, defaults, future reciprocal writes, schema/version conflicts, atomic rollback, capacity limits, self-table pairing, connected calculations, history/restore, empty records, restart and backup. Real SDK/CLI/MCP tests exercise the same operation and stale-version errors through authenticated HTTP. Installed SDK typing requires both schema versions. Desktop configuration and final-candidate acceptance remain separate delivery gates.
