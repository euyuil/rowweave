# RowWeave task recipes

Read only the recipe relevant to the user's request. The IDs below are placeholders: replace them with actual IDs and versions from the configured workspace. MCP schemas remain the authority for argument shape; the service validates field-specific constraints.

## Filtered batch update

For a request such as "Mark the overdue open tasks Done":

1. Read Tasks schema; resolve the status and due-date fields, and the Open/Done option IDs. Determine the cutoff date from the user's intended timezone/date. Do not silently use a machine-local day for an ambiguous relative date.
2. Query the target set with status and due-date predicates. Project the primary field, status and due date so the affected records remain understandable. Collect stable IDs and versions across consistent pages before changing the queried values.

```json
{
  "tableId": "tasks-id",
  "query": {
    "limit": 100,
    "fields": ["name-field-id", "status-field-id", "due-field-id"],
    "filter": {
      "conjunction": "and",
      "conditions": [
        { "fieldId": "status-field-id", "operator": "eq", "value": "open-option-id" },
        { "fieldId": "due-field-id", "operator": "lt", "value": "2026-11-12" }
      ]
    },
    "sort": [{ "fieldId": "due-field-id", "direction": "asc" }]
  }
}
```

Call `records_query` with that object. Continuation uses `offset` plus the first page's `revision` as `expectedRevision`. Check `total`; the default page is not the complete result.

3. Call `records_update` with the reviewed stable IDs, their read versions, and only the changed values:

```json
{
  "tableId": "tasks-id",
  "records": [
    { "id": "record-id", "expectedVersion": 3, "values": { "status-field-id": "done-option-id" } }
  ]
}
```

Updates can remove rows from the queried set. Do not advance offsets through a result set while changing its predicate fields; first capture the selected IDs/versions or deliberately restart and reconcile. For large jobs, separate batches are separate transactions. Report which batches committed if interrupted.

CLI equivalents: `rowweave records query tasks-id --input query.json` and `rowweave records update tasks-id --input updates.json`. CLI request files contain just the inner query object or the record array, not the MCP outer `tableId`/`records` envelope.

## Add or change schema

Create a table with `tables_create { "name": "Projects" }`; retain the generated table/primary-field IDs. Add a select field with `fields_create`:

```json
{
  "tableId": "projects-id",
  "input": {
    "expectedVersion": 1,
    "name": "Status",
    "type": "singleSelect",
    "options": [{ "name": "Open" }, { "name": "Done" }]
  }
}
```

Read the returned table version and generated option IDs. Rename options with their existing IDs. Removing a used option is rejected; do not replace the entire option list with new IDs just to change labels. To add a required field to populated data, add it optional, populate existing records, then enable `required`. A default applies to future creates, not existing nulls.

For a type change, call `fields_preview_conversion` with `{ tableId, fieldId, input: { expectedVersion, field } }`. `field` is the complete desired writable configuration, including name/type/options/defaults/format. Inspect `invalid`, `issues`, `samples` and `changed`; correct invalid values first. Preview samples are bounded, not an exhaustive list of affected records.

For `fields_apply_conversion`, use `preview.schemaVersion` and the preview's resolved field configuration, retaining generated option IDs but omitting returned metadata `id` and `lookupResult`. Apply revalidates current records atomically. A successful preview neither reserves a version nor authorizes discarding invalid values. Relationships cannot be converted to/from ordinary fields.

CLI: `rowweave fields preview-conversion table-id field-id --input conversion.json`, followed by `apply-conversion` with the reviewed input. CLI JSON is the inner `{ expectedVersion, field }` object.

## Links and lookups

Read both source and target schemas. Search the target's primary display values and resolve ambiguous matches before linking. Create the source field with `fields_create` using:

```json
{
  "tableId": "tasks-id",
  "input": {
    "expectedVersion": 2,
    "name": "Project",
    "type": "relation",
    "relation": { "tableId": "projects-id", "multiple": false }
  }
}
```

Set the link's record value to `["project-record-id"]`, not the project name or a bare string. To display a project field in Tasks, create a `lookup` with `lookup: { "relationFieldId": "project-link-field-id", "fieldId": "target-field-id" }`. The lookup's target must be an ordinary field; chained lookups and linked targets are not supported. Omit lookup values when creating or duplicating records.

Renaming a target changes displayed link labels without changing IDs. Deleting referenced targets is rejected; altering relationships to permit deletion is a separate data change that must be within the user's scope.

## Saved views

`views_create` takes `{ tableId, input: { name, query, columns } }`. Its `query` includes filters, sort and search; each column is `{ fieldId, width, hidden }`. Query the resulting view using `views_query`, retaining both data revision and view version for pagination. Changing the view does not modify records. The last remaining view cannot be deleted.

When updating a view, send its current version, not the table's version. A temporary `search` in `views_query` overrides the saved search for that read; use `views_update` to persist a change.

## CSV preview, import and export

For small CSV content use `csv_preview` with `{ tableId, input: { expectedVersion, csv, hasHeader, mapping? } }`. Each mapping entry is a destination field ID or null to skip that source column. Omitted mapping matches header names when headers exist; inspect the returned mapping instead of assuming a duplicate/renamed header resolved correctly.

Check `validated`, `invalid`, `issues`, `total` and sample values. Fix mappings or typed errors, then call `csv_import` with the same reviewed options/content and a current schema version. Import appends all rows atomically; it is not an upsert and does not create a schema. Reimporting duplicates data. A schema conflict requires a new preview; an uncertain write requires checking the table before any retry.

Unquoted empty CSV cells represent null; quoted empty text represents `""`. Selects use labels (or IDs); multi-select and relation cells use JSON arrays. Lookup fields cannot be mapped for import. Exports include computed fields, so skip those columns when reimporting. Export to a spreadsheet preserves data; cells that resemble spreadsheet formulas remain text in the CSV file but the spreadsheet may interpret them on opening—use that application's text-import controls for untrusted content.

`csv_export { tableId, query: {} }` exports a table; add `viewId` and `expectedViewVersion` to export the current saved view's filtering/sorting/visible column order. The result is CSV text with a BOM, not JSON. Do not place large files in model context. Prefer the configured CLI:

```sh
rowweave csv preview table-id --file input.csv --input options.json
rowweave csv import table-id --file input.csv --input options.json
rowweave csv export table-id --output output.csv
```

`options.json` contains `{ "expectedVersion": 4, "hasHeader": true, "mapping": ["name-field-id", "status-field-id", null] }`, with actual IDs/version. Request the user's intended output path when it cannot be inferred. CLI file output replaces a completed file; use an appropriate destination within the authorized task.
