# Formula fields

Use a **Formula** field to calculate an amount, build a label, or flag a record. In **Manage fields → Add field**, select **Formula**, choose its result type, and enter an expression. **Insert field** inserts a reference at the cursor. For example:

```text
["Quantity"] * ["Price"]
IF(["Quantity"] > 0, ROUND(["Quantity"] * ["Price"], 2), 0)
CONCAT(UPPER(["Name"]), " — ", ["Quantity"])
COALESCE(["Quantity"], 0)
```

The editor displays names; the service stores field UUID references. Renaming or moving a field keeps its formulas connected. Duplicate names are disambiguated in the field picker. Formula results are read-only and recalculate after saving a record or formula. Unsaved input drafts do not change the displayed result. A formula may be the primary display field.

## Language

Choose a **Number**, **Text**, or **Checkbox** result. A non-null result must have that type; there is no implicit text-to-number conversion. Number results use the same decimal, currency, percent and precision settings as ordinary numbers.

| Construct | Behavior |
| --- | --- |
| `+ - * / %`, unary `+ -`, parentheses | Numeric arithmetic; multiplication/division/remainder precede addition/subtraction. |
| `== != > >= < <=` | Equality compares type and value. Ordered comparisons require two numbers or two strings; strings use JavaScript's ordinal comparison. |
| Numbers, `"text"`, `TRUE`, `FALSE`, `NULL` | Decimal/exponent numbers and JSON string literals. Keywords and function names are case-insensitive. |
| `IF(condition, yes, no)` | Evaluate only the selected branch. A null condition returns null. |
| `COALESCE(a, b, …)` | First non-null value, without evaluating later arguments. Empty text, zero and false are values. |
| `CONCAT(a, …)` | Join scalar values as text; null contributes empty text. |
| `LOWER(text)`, `UPPER(text)`, `TRIM(text)`, `LEN(text)` | Case conversion, outer whitespace removal and Unicode code-point count. |
| `ABS(number)`, `ROUND(number, precision?)` | Absolute value and decimal rounding (precision 0–10, default 0). Half ties round toward positive infinity; calculations use finite JavaScript numbers. |
| `AND(a, b, …)`, `OR(a, b, …)`, `NOT(value)` | Boolean inputs; AND/OR evaluate all arguments. |

Except equality, IF, COALESCE and CONCAT, an operation with a null input returns null. Equality distinguishes null from empty text. References to single-select fields return stable option IDs; dates and timestamps are strings. Formulas can reference other same-record formulas and numeric [linked summaries](linked-summaries.md). Raw linked-record fields, array lookups and multiple-select fields are not scalar inputs. Remove or update dependent formulas before deleting a referenced field. Circular dependencies, including chains across tables, and invalid syntax prevent the schema change.

Expressions allow at most 4,096 characters, 512 tokens and 40 nested parsing levels. Variadic functions accept up to 20 arguments. There is no JavaScript evaluation, property access, network access, current-time function or random function. The result text limit is 10,000 characters. Source type conversions may produce formula errors; they do not silently coerce inputs.

## Errors and consistency

Division by zero, non-finite results, wrong argument/result types and oversized results produce a null value with an explicit error. Grid cells, board cards and record details display `#ERROR` and the reason. Correct the input or expression to clear it. Dependent formulas and lookups report errors rather than disguising them as successful empty results.

The service calculates and stores results in the same SQLite transaction as record creation, updates, CSV imports and schema changes. Editing a formula recalculates existing records, incrementing a record's version only when its stored values or errors change. A source type conversion also recalculates formulas. Old record versions cannot overwrite these changes. A failed mutation rolls back the entire transaction.

For example, a lookup named **Subtotal** can sum linked line items, and a formula can calculate `ROUND(["Subtotal"] * (1 + ["Tax rate"]), 2)`. Saving a line-item amount recalculates affected orders and any further summaries/formulas that depend on them before the write completes. Changing links from either side has the same effect. A changed calculated value or error advances the affected record version; unrelated records are not rewritten. Reload an open view to see external changes. A stale edit is rejected and its draft is retained for review.

An empty sum/average/minimum/maximum is null, while count is zero. Use `COALESCE(["Subtotal"], 0)` when zero is the intended empty result. Referenced calculation errors propagate and clear when their cause is corrected. Do not create recursive totals: field dependencies must be acyclic even if today's record links happen to avoid a cycle.

Filters, sorting, search, grouped summaries and linked labels read saved results. Null results, including failed formulas, follow normal null query/summary semantics; summaries do not count nulls as zero. CSV exports containing a formula error fail explicitly: correct the error or export a view that excludes that field. CSV imports can map only writable fields; their formula results are calculated during import.

## API, CLI and MCP

Use the existing field-create/update and record operations through every interface. A field configuration is:

```json
{
  "expectedVersion": 3,
  "name": "Total",
  "type": "formula",
  "formula": {
    "expression": "[\"<quantity-field-id>\"] * [\"<price-field-id>\"]",
    "resultType": "number"
  }
}
```

API references use field IDs, not display names. `[field-id]` and `["field-id"]` are equivalent for ordinary UUIDs. Responses include scalar results in `record.values` and optional `record.formulaErrors: { "<field-id>": "reason" }`; projected queries include errors only for requested fields. The same error map can identify a lookup whose linked formula failed. Formula fields cannot set a default, require a value, receive direct writes, or convert to/from another field type. Read the current schema and record versions before changing data; do not retry uncertain writes automatically.
