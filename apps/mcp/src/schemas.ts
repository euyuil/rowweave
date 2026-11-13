import { z } from 'zod';
import { maxRelativeDays, relativeDatePeriods, maxGroupCollapseKeys } from '../../../packages/contracts/src/index.js';

const id = z.string().describe('Stable ID from the workspace schema or a query result; never a display name or position.');
const version = z.number().int().describe('Version from the most recent read of this object.');
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const value = z.union([scalar, z.array(scalar)]).describe('Typed JSON value. Selects use option IDs; links use record ID arrays; null and empty text differ. Lookups are read-only.');
const values = z.record(z.string(), value).describe('Values keyed by stable field IDs. Omitted create fields use defaults.');
export const tableId = { tableId: id };
export const fieldId = { ...tableId, fieldId: id };
export const viewId = { ...tableId, viewId: id };
export const expectedVersion = { expectedVersion: version };
export const tableCreate = z.strictObject({ name: z.string() });
export const tableUpdate = z.strictObject({ ...expectedVersion, name: z.string().exactOptional(), primaryFieldId: id.exactOptional(), fieldOrder: z.array(id).exactOptional() });
const formula = z.strictObject({ expression: z.string().min(1).max(4096), resultType: z.enum(['number', 'text', 'checkbox', 'date', 'datetime']) });
export const formulaPreview = z.strictObject({ ...expectedVersion, formula, fieldId: id.exactOptional(), recordId: id.exactOptional() });
const field = z.strictObject({
  name: z.string(),
  description: z.string().max(2000).describe('Plain-text field guidance. Send empty text to clear it.').exactOptional(),
  type: z.enum(['text', 'multiline', 'url', 'attachment', 'number', 'autoNumber', 'createdTime', 'updatedTime', 'checkbox', 'date', 'datetime', 'singleSelect', 'multiSelect', 'relation', 'lookup', 'formula']),
  required: z.boolean().exactOptional(), defaultValue: value.exactOptional(),
  options: z.array(z.strictObject({ id: id.exactOptional(), name: z.string(), color: z.string().exactOptional() })).exactOptional(),
  numberFormat: z.enum(['decimal', 'currency', 'percent']).exactOptional(), precision: z.number().int().exactOptional(), currency: z.string().exactOptional(),
  relation: z.strictObject({ tableId: id, multiple: z.boolean() }).exactOptional(),
  formula: formula.exactOptional(),
  lookup: z.strictObject({ relationFieldId: id, fieldId: id, operation: z.enum(['values', 'count', 'sum', 'average', 'min', 'max']).exactOptional() }).exactOptional(),
});
export const fieldCreate = field.extend({ ...expectedVersion,
  reverseField: z.strictObject({ name: z.string(), multiple: z.boolean(), expectedVersion: version })
    .describe('For a new relation: atomically create its editable reverse field in the target table, using that table schema version.').exactOptional(),
});
export const fieldUpdate = z.strictObject({
  ...field.shape,
  ...expectedVersion,
  name: z.string().exactOptional(), type: field.shape.type.exactOptional(),
  precision: z.number().int().nullable().exactOptional(),
});
export const conversion = z.strictObject({ ...expectedVersion, field });
const condition = z.strictObject({ fieldId: id, operator: z.enum(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty', 'hasAny', 'relativeDate']), value: value.exactOptional(),
  relative: z.strictObject({ period: z.enum(relativeDatePeriods), timeZone: z.string().describe('Named time zone, such as Asia/Shanghai or UTC.'),
    days: z.int().min(1).max(maxRelativeDays).describe('For pastDays/nextDays only; includes today. Weeks start Monday.').exactOptional() }).exactOptional(),
});
const filter = z.strictObject({
  conjunction: z.enum(['and', 'or']),
  get conditions(): z.ZodArray<z.ZodUnion<[typeof condition, typeof filter]>> { return z.array(z.union([condition, filter])); },
});
const query = {
  filter: filter.exactOptional(),
  sort: z.array(z.strictObject({ fieldId: id, direction: z.enum(['asc', 'desc']) })).exactOptional(),
  search: z.string().exactOptional(),
};
const page = {
  offset: z.number().int().exactOptional(), limit: z.number().int().describe('At most 500; use small pages and project only needed fields.').exactOptional(),
  fields: z.array(id).exactOptional(), expectedRevision: version.describe('Reuse the first page revision for consistent continuation pages.').exactOptional(),
  expectedDateContext: z.string().regex(/^[a-f0-9]{64}$/).describe('Reuse dateContext from the first page or summary; DATA_CHANGED requires refreshing after the calendar period changes.').exactOptional(),
};
export const recordQuery = z.strictObject({ ...page, ...query, recordIds: z.array(id).exactOptional(), groupBy: id.exactOptional() });
export const recordGroups = z.strictObject({
  window: z.enum(['displayRows', 'expandedRecords']).describe('Offsets count display rows by default; expandedRecords skips all headings and collapsed records.').exactOptional(),
  viewId: id.exactOptional(), expectedViewVersion: version.exactOptional(), groupBy: id.exactOptional(),
  filter: filter.exactOptional(), search: z.string().exactOptional(),
  offset: page.offset, limit: page.limit, expectedRevision: page.expectedRevision, expectedDateContext: page.expectedDateContext,
  collapse: z.strictObject({ defaultCollapsed: z.boolean(), exceptions: z.array(scalar).max(maxGroupCollapseKeys) }).exactOptional(),
});
export const recordSummary = z.strictObject({
  viewId: id.exactOptional(), expectedViewVersion: version.exactOptional(),
  filter: filter.exactOptional(), search: z.string().exactOptional(), groupBy: id.exactOptional(),
  measures: z.array(z.strictObject({ fieldId: id, operation: z.enum(['sum', 'average', 'min', 'max']) })).max(12).exactOptional(),
  offset: page.offset, limit: page.limit, expectedRevision: page.expectedRevision, expectedDateContext: page.expectedDateContext,
});
export const recordCreate = z.array(z.strictObject({ values }));
export const recordUpdate = z.array(z.strictObject({ id, ...expectedVersion, values }));
export const recordDelete = z.array(z.strictObject({ id, ...expectedVersion }));
export const recordGet = z.strictObject({ ...tableId, recordId: id });
export const recordHistory = z.strictObject({ before: z.int().min(1).exactOptional(), limit: z.int().min(1).max(100).exactOptional() });
export const recordRestore = z.strictObject({ changeId: z.int().min(1), snapshot: z.enum(['before', 'after']), ...expectedVersion });
export const deletedRecordRestore = z.array(z.strictObject({ id, deletionId: z.int().min(1), values: values.exactOptional() })).min(1).max(2000);
const view = {
  name: z.string(), query: z.strictObject(query).exactOptional(),
  columns: z.array(z.strictObject({ fieldId: id, width: z.number(), hidden: z.boolean() })).exactOptional(),
  rowHeight: z.union([z.literal(36), z.literal(48), z.literal(64)]).exactOptional(),
  frozenColumns: z.int().min(0).exactOptional(),
  type: z.enum(['grid', 'board']).exactOptional(), groupBy: id.nullable().exactOptional(),
};
export const viewCreate = z.strictObject(view);
export const viewUpdate = z.strictObject({ ...view, ...expectedVersion, name: z.string().exactOptional() });
export const viewPage = z.strictObject({ ...page, search: z.string().exactOptional(), expectedViewVersion: version.exactOptional(), lane: id.nullable().exactOptional() });
export const csvImport = z.strictObject({ ...expectedVersion, csv: z.string(), hasHeader: z.boolean(), mapping: z.array(id.nullable()).exactOptional() });
export const csvExport = z.strictObject({ viewId: id.exactOptional(), expectedViewVersion: version.exactOptional(), search: z.string().exactOptional() });
