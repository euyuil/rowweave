import { z } from 'zod';

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
const field = z.strictObject({
  name: z.string(),
  type: z.enum(['text', 'multiline', 'number', 'checkbox', 'date', 'datetime', 'singleSelect', 'multiSelect', 'relation', 'lookup', 'formula']),
  required: z.boolean().exactOptional(), defaultValue: value.exactOptional(),
  options: z.array(z.strictObject({ id: id.exactOptional(), name: z.string(), color: z.string().exactOptional() })).exactOptional(),
  numberFormat: z.enum(['decimal', 'currency', 'percent']).exactOptional(), precision: z.number().int().exactOptional(), currency: z.string().exactOptional(),
  relation: z.strictObject({ tableId: id, multiple: z.boolean() }).exactOptional(),
  formula: z.strictObject({ expression: z.string().min(1).max(4096), resultType: z.enum(['number', 'text', 'checkbox']) }).exactOptional(),
  lookup: z.strictObject({ relationFieldId: id, fieldId: id, operation: z.enum(['values', 'count', 'sum', 'average', 'min', 'max']).exactOptional() }).exactOptional(),
});
export const fieldCreate = field.extend(expectedVersion);
export const fieldUpdate = z.strictObject({
  ...field.shape,
  ...expectedVersion,
  name: z.string().exactOptional(), type: field.shape.type.exactOptional(),
  precision: z.number().int().nullable().exactOptional(),
});
export const conversion = z.strictObject({ ...expectedVersion, field });
const condition = z.strictObject({ fieldId: id, operator: z.enum(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty', 'hasAny']), value: value.exactOptional() });
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
};
export const recordQuery = z.strictObject({ ...page, ...query, recordIds: z.array(id).exactOptional() });
export const recordSummary = z.strictObject({
  viewId: id.exactOptional(), expectedViewVersion: version.exactOptional(),
  filter: filter.exactOptional(), search: z.string().exactOptional(), groupBy: id.exactOptional(),
  measures: z.array(z.strictObject({ fieldId: id, operation: z.enum(['sum', 'average', 'min', 'max']) })).max(12).exactOptional(),
  offset: page.offset, limit: page.limit, expectedRevision: page.expectedRevision,
});
export const recordCreate = z.array(z.strictObject({ values }));
export const recordUpdate = z.array(z.strictObject({ id, ...expectedVersion, values }));
export const recordDelete = z.array(z.strictObject({ id, ...expectedVersion }));
export const recordGet = z.strictObject({ ...tableId, recordId: id });
const view = {
  name: z.string(), query: z.strictObject(query).exactOptional(),
  columns: z.array(z.strictObject({ fieldId: id, width: z.number(), hidden: z.boolean() })).exactOptional(),
  rowHeight: z.union([z.literal(36), z.literal(48), z.literal(64)]).exactOptional(),
  frozenColumns: z.int().min(0).exactOptional(),
  type: z.enum(['grid', 'board']).exactOptional(), groupBy: id.exactOptional(),
};
export const viewCreate = z.strictObject(view);
export const viewUpdate = z.strictObject({ ...view, ...expectedVersion, name: z.string().exactOptional() });
export const viewPage = z.strictObject({ ...page, search: z.string().exactOptional(), expectedViewVersion: version.exactOptional(), lane: id.nullable().exactOptional() });
export const csvImport = z.strictObject({ ...expectedVersion, csv: z.string(), hasHeader: z.boolean(), mapping: z.array(id.nullable()).exactOptional() });
export const csvExport = z.strictObject({ viewId: id.exactOptional(), expectedViewVersion: version.exactOptional(), search: z.string().exactOptional() });
