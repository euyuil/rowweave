import { maxGroupCollapseKeys, valueField, type Field, type GroupCollapse, type GroupPathCollapse, type ScalarValue } from '../../contracts/src/index.js';
import { ServiceError } from './errors.js';
import { validateValue } from './field-values.js';
import type { GroupWindow, SummaryMeasure } from '../../contracts/src/index.js';
import type { CheckedQuery } from './record-query.js';

export type CheckedGroupQuery = CheckedQuery & { window: GroupWindow; measures: SummaryMeasure[] };

export function parseGroupCollapse(field: Field, input: unknown): GroupCollapse {
  if (input === undefined) return { defaultCollapsed: false, exceptions: [] };
  const invalid = (): never => { throw new ServiceError('INVALID_QUERY', `Use a boolean defaultCollapsed and up to ${maxGroupCollapseKeys} distinct typed exception keys.`); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const item = input as Record<string, unknown>;
  if (typeof item['defaultCollapsed'] !== 'boolean' || !Array.isArray(item['exceptions']) ||
      item['exceptions'].length > maxGroupCollapseKeys) return invalid();
  const selected = { ...valueField(field), required: false };
  const exceptions = item['exceptions'].map(key => validateValue(selected, key) as ScalarValue);
  if (new Set(exceptions).size !== exceptions.length) return invalid();
  return { defaultCollapsed: item['defaultCollapsed'], exceptions };
}

export function parseGroupPaths(fields: readonly Field[], input: unknown): GroupPathCollapse {
  if (input === undefined) return { defaultCollapsed: false, exceptions: [] };
  const invalid = (): never => { throw new ServiceError('INVALID_QUERY', `Use a boolean defaultCollapsed and up to ${maxGroupCollapseKeys} distinct typed group paths.`); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const item = input as Record<string, unknown>;
  if (typeof item['defaultCollapsed'] !== 'boolean' || !Array.isArray(item['exceptions']) || item['exceptions'].length > maxGroupCollapseKeys) return invalid();
  const selected = fields.map(field => ({ ...valueField(field), required: false }));
  const exceptions = item['exceptions'].map(path => {
    if (!Array.isArray(path) || !path.length || path.length > fields.length) return invalid();
    return path.map((key, index) => validateValue(selected[index]!, key) as ScalarValue);
  });
  if (new Set(exceptions.map(path => JSON.stringify(path))).size !== exceptions.length) return invalid();
  return { defaultCollapsed: item['defaultCollapsed'], exceptions };
}
