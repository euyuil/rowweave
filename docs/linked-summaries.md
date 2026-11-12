# Linked summaries

Use a **Lookup** field to summarize numbers from linked records. For example, link a project to its line items, then show their total cost on the project.

1. Add a **Linked records** field and choose its target table.
2. Add a **Lookup** field, choose the linked field and a numeric target field.
3. In **Show**, choose **Sum**, **Average**, **Count numeric values**, **Minimum**, or **Maximum**. **Linked values** keeps the original list of values.

Numeric formulas are valid targets. Sum, average, minimum and maximum inherit the target's number formatting; count displays a plain number. Summaries are read-only. Saving changes to the links or target values changes the next read immediately, without maintaining an editable copy on the source record. Reload an open view to see external changes.

| Target values | Count | Sum | Average | Minimum | Maximum |
| --- | --- | --- | --- | --- | --- |
| `0, 10, null, 20` | 3 | 30 | 10 | 0 | 20 |
| `0` | 1 | 0 | 0 | 0 | 0 |
| Only nulls, or no linked records | 0 | No value | No value | No value | No value |

Count measures numeric values, not the number of links. All operations ignore nulls and retain zero. A linked formula error or an overflowing calculation produces no value and an explicit error, rather than a partial successful total. CSV export rejects selected calculation errors. Filters, sorting, search and the **Summarize** dialog use the current scalar results, with normal null semantics. Pagination revision checks detect changes to the target table; target edits do not change the source record's version because they do not modify its saved links or values.

The operation follows one relationship. Lookup targets cannot themselves be lookups or linked-record fields. Same-record formulas cannot reference a lookup. Delete dependent fields before removing their link/target; a formula used by a numeric summary must retain its numeric result type. Incompatible saved filters prevent a configuration change atomically.

## Interfaces

HTTP, SDK, CLI and MCP use the existing field-create/update operations with:

```json
{
  "expectedVersion": 4,
  "name": "Total cost",
  "type": "lookup",
  "lookup": {
    "relationFieldId": "<local-linked-field-id>",
    "fieldId": "<target-numeric-field-id>",
    "operation": "sum"
  }
}
```

`operation` accepts `values`, `count`, `sum`, `average`, `min`, or `max`. Omission preserves the original array lookup. Numeric operations return a number or null in `record.values`; errors appear in the existing `record.formulaErrors` map. Returned `lookupResult` describes the target field. Use stable IDs and current schema versions, and never write to the computed field directly.

SQLite format 11 marks support for scalar lookup results. Migration preserves existing field configuration, arrays, record versions and saved views; older application versions reject the newer workspace format. The same SQL expression drives record hydration and query operations, without another calculation runtime or whole-table renderer downloads.
