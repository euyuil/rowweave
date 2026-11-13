# Formula fields

Use a **Formula** field to calculate an amount, plan a date, build a label, or flag a record. In **Manage fields → Add field**, select **Formula**, choose its result type, and enter an expression. **Insert field** inserts a reference at the cursor. For example:

```text
["Quantity"] * ["Price"]
IF(["Quantity"] > 0, ROUND(["Quantity"] * ["Price"], 2), 0)
CONCAT(UPPER(["Name"]), " — ", ["Quantity"])
COALESCE(["Quantity"], 0)
```

The editor displays names; the service stores field UUID references. Renaming or moving a field keeps its formulas connected. Duplicate names are disambiguated in the field picker. Formula results are read-only and recalculate after saving a record or formula. Unsaved input drafts do not change the displayed result. A formula may be the primary display field.

## Preview before saving

Select **Preview formula** in field configuration to validate a draft and calculate it using one saved record. A field name is not required for preview. The first saved record is used by default; **Choose a sample record** provides search and pages of 50 records. The result names its sample and distinguishes an empty value from a calculation error. Changing the expression, result type or sample clears the previous preview.

Preview uses the same expression parser, result validation and dependency checks as saving, including cross-table cycles, linked summary types and saved-view constraints. It does not save fields, values, history or versions. An empty table can validate syntax and dependencies, but shows no fabricated sample. A successful preview is a snapshot of one record, not a guarantee that every record will calculate successfully or that later inputs are unchanged. Saving still validates the current schema and recalculates the complete table.

The shared read-only operation is `POST /tables/:table/formulas/preview`, SDK `previewFormula(tableId, input)`, CLI `rowweave formulas preview <table-id> --input request.json`, or MCP `formulas_preview` with `{ tableId, input }`. The input contains the current table `expectedVersion`, `formula: { expression, resultType }`, optional `fieldId` when editing an existing formula, and optional `recordId`. Use UUID references in API expressions. Supplying `fieldId` is necessary to check dependencies of that existing field; omit it to preview a new field.

The response is `{ tableId, schemaVersion, formula, sample }`. A sample contains its saved record `id`, `version`, primary display `label`, calculated `value` and optional `error`; `sample` is null for an empty table. Syntax/schema failures return ordinary API errors. A calculation failure returns a sample with a null value and an explicit error. A missing/deleted requested record returns `RECORD_NOT_FOUND`; a stale schema returns `SCHEMA_CONFLICT`. Preview never reserves a record or retries a write.

## Language

Choose a **Number**, **Text**, **Checkbox**, **Date**, or **Date and time (UTC)** result. A non-null result must have that type; there is no implicit text-to-number conversion. Number results use the same decimal, currency, percent and precision settings as ordinary numbers. Date results validate calendar dates; timestamp results validate explicit-zone ISO timestamps and normalize to UTC. They support the same ordered/relative-date filters, sorting, grouping and lookup operations as ordinary date/time values.

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

Except equality, IF, COALESCE and CONCAT, scalar operations with a null input return null. Equality distinguishes null from empty text. References to single-select fields return stable option IDs; dates and timestamps are strings. Formulas can reference other same-record formulas, numeric [linked summaries](linked-summaries.md), and collections through the array functions below. Remove or update dependent formulas before deleting a referenced field. Circular dependencies, including chains across tables, and invalid syntax prevent the schema change.

Expressions allow at most 4,096 characters, 512 tokens and 40 nested parsing levels. Variadic functions accept up to 20 arguments. There is no JavaScript evaluation, property access, network access, current-time function or random function. The result text limit is 10,000 characters. Source type conversions may produce formula errors; they do not silently coerce inputs.

## Array calculations

Linked-record and attachment fields provide ordered arrays of stable record/file IDs. Multiple-select fields provide option IDs; renaming their labels does not change calculation inputs. Array lookups provide their typed values in link order, including nulls and repeated values. Use array functions to produce a single declared result. Intermediate arrays can pass through IF and COALESCE, but cannot be saved directly as a formula result or silently converted to text/numbers by scalar operators.

| Function | Behavior |
| --- | --- |
| `ARRAY(value, ...)` | Construct 0–20 scalar items, including null. Nested arrays are rejected. `ARRAY()` is an empty collection. |
| `ARRAYLEN(values)` | Count all positions, including null values. |
| `ARRAYCOUNT(values)` | Count non-null items, including zero, false and empty text. |
| `ARRAYGET(values, position)` | Select a positive, one-based whole-number position. A position beyond the array returns null. |
| `ARRAYCONTAINS(values, item)` | Match a scalar by both type and value, including null. The number 1 does not match the text "1". |
| `ARRAYUNIQUE(values)` | Keep the first occurrence of each typed value, preserving order and retaining one null. |
| `ARRAYCOMPACT(values)` | Remove only nulls. Zero, false and empty text remain. |
| `ARRAYJOIN(values, separator?)` | Join scalar text representations; the default separator is ", ". Null contributes empty text, retaining its position. Use ARRAYCOMPACT first to omit null positions. |
| `ARRAYSUM(values)`, `ARRAYAVERAGE(values)`, `ARRAYMIN(values)`, `ARRAYMAX(values)` | Numeric summaries skip nulls. Any other nonnumeric item is an error. Empty/all-null arrays return null; use COALESCE when zero is intended. |

A null source array produces null. An empty array has length/count zero, joins to empty text, and does not contain any value. ARRAYGET with a null position and ARRAYJOIN with a null separator also return null; ARRAYCONTAINS can explicitly test for a null member. Arrays are limited to 40,000 items and joined text to 10,000 characters. Oversized results fail explicitly, with no silent truncation. Numeric summaries reject non-finite results.

Examples in the editor:

```text
ARRAYLEN(COALESCE(["Tasks"], ARRAY()))
ARRAYSUM(["Linked amounts"])
ARRAYJOIN(ARRAYUNIQUE(["Linked names"]), ", ")
DATEADD(ARRAYGET(["Linked dates"], 1), 7, "day")
```

Collection formulas recalculate in the same write transaction as their inputs. In particular, raw relation calculations run after both sides of a two-way link have been updated, so creation, reverse edits, deletion, restoration and saved undo cannot leave counts stale. Array lookup inputs remain derived; only the final formula values/errors are stored. Linked calculation errors propagate rather than being counted as successful empty items. Format 26 gates these evaluation and dependency semantics while preserving existing data.

## Date calculations

Date inputs are strings in the same formats as date/time fields: a valid Gregorian calendar date in YYYY-MM-DD form, or an ISO timestamp with seconds, up to three fractional digits and an explicit Z/UTC offset. No locale-dependent date parsing is used. Date/timestamp results use years 0000–9999. Timestamps are normalized to UTC before extracting calendar components or doing calendar arithmetic; the machine's local zone does not change a result.

| Function | Behavior |
| --- | --- |
| DATE(year, month, day) | Construct a date from whole numbers. Invalid calendar combinations are errors, including February 29 in a non-leap year. |
| DATEVALUE(value) | Return a date; timestamps use their UTC calendar date. |
| DATETIMEVALUE(value) | Normalize a timestamp; a date becomes midnight UTC. |
| YEAR(value), MONTH(value), DAY(value), WEEKDAY(value) | Extract calendar components. WEEKDAY uses Monday = 1 through Sunday = 7. |
| HOUR(value), MINUTE(value), SECOND(value) | Extract UTC time components. A date alone is an error; convert it with DATETIMEVALUE when midnight is intended. |
| DATEADD(value, amount, unit) | Add a signed whole number of units. Calendar month/year additions clamp to the last valid day. Dates retain date values; adding time units requires a timestamp. |
| DATEDIFF(start, end, unit) | Count signed complete units, truncating incomplete units. Dates are midnight UTC. For months/years, count forward from the earlier endpoint with month-end clamping, then apply the sign, so swapping endpoints negates the result. |

Units are case-insensitive "year", "month", "week", "day", "hour", "minute" or "second". A timestamp day is 24 hours in UTC; these functions do not interpret regional daylight-saving calendars. For example, DATEADD("2024-01-31", 1, "month") is 2024-02-29, while DATEADD("2024-02-29", 1, "year") is 2025-02-28. DATEDIFF("2024-02-29", "2024-01-31", "month") is -1.

Use DATEADD(["Start"], 7, "day") with a Date result for a due date, or DATEADD(DATETIMEVALUE(["Start"]), 9, "hour") with a Date and time result for 09:00 UTC. Use field UUIDs instead of names through API/CLI/MCP. Null inputs stay null. Invalid arguments, arithmetic overflow and a result that does not match the chosen type produce visible calculation errors.

These date functions are deterministic from their inputs. Format 25 gates date formula semantics so an older service cannot reopen the workspace and calculate them incorrectly; upgrading preserves existing values and versions.

## Current time and explicit refresh

`NOW()` returns the service calculation time as a UTC timestamp rounded down to the minute. `TODAY()` returns its UTC calendar date; `TODAY("Asia/Shanghai")`, for example, uses that named time zone's calendar date. Named zones use the runtime's IANA data. Invalid zones and fixed numeric offsets produce calculation errors; a null zone produces null. Choose a Date and time result for NOW and a Date result for TODAY, or combine them with other date functions.

One record batch, schema change or refresh uses one captured service clock. Normal saves recalculate affected records and dependencies. The desktop's local service and the standalone service refresh clock formulas at startup and every 60 seconds while running. Sleep or a long calculation skips missed ticks instead of queuing them. The next evaluation uses the current service clock. Explicitly refresh with SDK `refreshCalculations()`, CLI `rowweave calculations refresh`, MCP `calculations_refresh`, or HTTP `POST /calculations/refresh` with `{}`. Concurrent refresh requests share the active operation. The response contains `evaluatedAt` (the UTC minute snapshot), `changedRecords` and `changedTableIds`. A draft preview evaluates only its draft and never refreshes stored values.

Calculations run in a service worker with its own SQLite connection. Reads continue against committed snapshots; service writes wait for the active calculation, then apply their usual validation and version checks. A queued edit may conflict if the calculation changed its record. Preserve the draft and compare against the latest record instead of retrying automatically. Shutdown stops new work and waits for accepted transactions. This does not make other synchronous operations, such as large imports, nonblocking.

Read SDK `calculationStatus()`, CLI `rowweave calculations status`, MCP `calculations_status` or HTTP `GET /calculations/status` for `automatic`, `running`, optional `startedAt`/`completedAt`, `lastResult` and `lastError`. Status is process-local; startup performs a fresh calculation. A failure rolls back the refresh, remains visible until another attempt starts, and does not prevent correcting the workspace. Automatic ticks may attempt calculation again; user writes are never retried. The SDK allows 120 seconds for explicit refresh and 15 seconds for other requests. After an uncertain response, inspect status and saved state. The low-level `startServer` embedding API defaults to manual in-process calculations; production entry points use `startWorkspaceServer` with automatic worker calculations. An open table still requires Reload to show external changes; background view refresh and desktop calculation controls remain in the active delivery plan.

Refresh reads record bodies in pages of 100 and tracks affected IDs in temporary SQLite tables. Temporary storage and total work grow with affected data. Values/errors, lookups, filters, sorting and exports agree after the atomic commit. Each changed record advances its version at most once; data revisions advance, while schema versions and user creation/edit times stay unchanged. Identical results cause no record rewrite; a late failure rolls back every earlier page.

Clock-only refresh does not create user-history snapshots or undo receipts. Its record-version changes can invalidate older edits or whole-operation undo; exact version protection still applies. Individual snapshot restoration using the current record version restores writable values and recalculates formulas at the current clock. Format 27 gates these semantics without rewriting existing data. Desktop status/control acceptance remains required in the [active delivery plan](gap-closure-plan.md).

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
