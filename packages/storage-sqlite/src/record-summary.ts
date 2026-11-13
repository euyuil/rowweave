import { valueField, isLookupSummary } from '../../contracts/src/index.js';
import { lookupSql } from './lookups.js';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { CellValue, RecordSummary, SummaryValues, Table } from '../../contracts/src/index.js';
import type { CheckedSummary } from '../../core/src/record-summary.js';
import { fieldText } from '../../core/src/field-display.js';
import { ServiceError } from '../../core/src/errors.js';

export function summarize(db: DatabaseSync, table: Table, summary: CheckedSummary,
  where: string, parameters: Record<string, SQLInputValue>, offset: number, limit: number): RecordSummary {
  const functions = { sum: 'SUM', average: 'AVG', min: 'MIN', max: 'MAX' };
  const aggregateParameters = { ...parameters };
  const columns = new Map<string, { expression: string; name: string }>();
  for (const id of [...summary.measures.map(measure => measure.fieldId), ...(summary.groupBy === undefined ? [] : [summary.groupBy])]) {
    if (columns.has(id)) continue;
    const field = table.fields.find(field => field.id === id)!;
    const name = `summaryField${columns.size}`;
    if (!isLookupSummary(field)) aggregateParameters[`:${name}`] = `$.${JSON.stringify(id)}`;
    columns.set(id, { name, expression: isLookupSummary(field) ? lookupSql(field) : `json_extract(r.values_json, :${name})` });
  }
  const aggregates = (projected: boolean) => ['COUNT(*) AS count', ...summary.measures.map((measure, index) => {
    const column = columns.get(measure.fieldId)!;
    return `${functions[measure.operation]}(CAST(${projected ? column.name : column.expression} AS REAL)) AS measure${index}`;
  })].join(', ');
  const values = (row: Record<string, unknown>): SummaryValues => ({ count: row['count'] as number,
    values: summary.measures.map((_, index) => {
      const value = row[`measure${index}`] as number | null;
      if (value !== null && !Number.isFinite(value)) throw new ServiceError('SUMMARY_OVERFLOW', 'A summary exceeds the supported numeric range.');
      return value;
    }) });
  const metadata = { offset, revision: table.revision, schemaVersion: table.version };
  if (summary.groupBy === undefined) {
    const totals = values(db.prepare(`SELECT ${aggregates(false)} FROM records r WHERE ${where}`).get(aggregateParameters)!);
    return { totals, groups: [], groupCount: 0, ...metadata };
  }
  const field = table.fields.find(field => field.id === summary.groupBy)!;
  const groupColumn = columns.get(field.id)!.name;
  const order = field.type === 'singleSelect' ? "json_extract(:summaryOptions, '$.' || json_quote(key))" : 'key';
  const jsonValues = ["'key', key", "'count', count", ...summary.measures.map((_, index) => `'measure${index}', measure${index}`)].join(', ');
  // Reuse filtered scalar values across totals and groups; compute averages from records, not group averages.
  const row = db.prepare(`WITH input AS MATERIALIZED (
      SELECT ${[...columns.values()].map(column => `${column.expression} AS ${column.name}`).join(', ')} FROM records r WHERE ${where}
    ), grouped AS MATERIALIZED (
      SELECT ${groupColumn} AS key, ${aggregates(true)} FROM input GROUP BY ${groupColumn}
    ) SELECT ${aggregates(true)}, (SELECT COUNT(*) FROM grouped) AS groupCount,
      (SELECT json_group_array(json_object(${jsonValues})) FROM (
        SELECT * FROM grouped ORDER BY key IS NULL, ${order} COLLATE NOCASE, key LIMIT :summaryLimit OFFSET :summaryOffset
      )) AS groups FROM input`)
    .get({ ...aggregateParameters, ':summaryLimit': limit, ':summaryOffset': offset,
      ...(field.type === 'singleSelect' ? { ':summaryOptions': JSON.stringify(Object.fromEntries(field.options!.map(option => [option.id, option.name]))) } : {}) })!;
  const rows = JSON.parse(row['groups'] as string) as Record<string, unknown>[];
  const groups = rows.map(row => {
    const key = valueField(field).type === 'checkbox' && row['key'] !== null ? Boolean(row['key']) : row['key'] as CellValue;
    return { key, label: fieldText(field, key), ...values(row) };
  });
  return { totals: values(row), groups, groupCount: row['groupCount'] as number, ...metadata };
}
