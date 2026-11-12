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
  const aggregates = ['COUNT(*) AS count', ...summary.measures.map((measure, index) => {
    const field = table.fields.find(field => field.id === measure.fieldId)!;
    const name = `:measure${index}`;
    if (!isLookupSummary(field)) aggregateParameters[name] = `$.${JSON.stringify(measure.fieldId)}`;
    const expression = isLookupSummary(field) ? lookupSql(field) : `json_extract(r.values_json, ${name})`;
    return `${functions[measure.operation]}(CAST(${expression} AS REAL)) AS measure${index}`;
  })].join(', ');
  const values = (row: Record<string, unknown>): SummaryValues => ({ count: row['count'] as number,
    values: summary.measures.map((_, index) => {
      const value = row[`measure${index}`] as number | null;
      if (value !== null && !Number.isFinite(value)) throw new ServiceError('SUMMARY_OVERFLOW', 'A summary exceeds the supported numeric range.');
      return value;
    }) });
  const totals = values(db.prepare(`SELECT ${aggregates} FROM records r WHERE ${where}`).get(aggregateParameters)!);
  const result: RecordSummary = { totals, groups: [], groupCount: 0, offset, revision: table.revision, schemaVersion: table.version };
  if (summary.groupBy === undefined) return result;
  const field = table.fields.find(field => field.id === summary.groupBy)!;
  const groupParameters = isLookupSummary(field) ? {} : { ':summaryGroup': `$.${JSON.stringify(field.id)}` };
  const expression = isLookupSummary(field) ? lookupSql(field) : 'json_extract(r.values_json, :summaryGroup)';
  result.groupCount = db.prepare(`SELECT COUNT(*) AS total FROM (
    SELECT ${expression} FROM records r WHERE ${where} GROUP BY ${expression})`)
    .get({ ...parameters, ...groupParameters })!['total'] as number;
  const order = field.type === 'singleSelect' ? "json_extract(:summaryOptions, '$.' || json_quote(key))" : 'key';
  const rows = db.prepare(`SELECT ${expression} AS key, ${aggregates} FROM records r WHERE ${where}
    GROUP BY ${expression} ORDER BY key IS NULL, ${order} COLLATE NOCASE, key LIMIT :summaryLimit OFFSET :summaryOffset`)
    .all({ ...aggregateParameters, ...groupParameters, ':summaryLimit': limit, ':summaryOffset': offset,
      ...(field.type === 'singleSelect' ? { ':summaryOptions': JSON.stringify(Object.fromEntries(field.options!.map(option => [option.id, option.name]))) } : {}) });
  result.groups = rows.map(row => {
    const key = valueField(field).type === 'checkbox' && row['key'] !== null ? Boolean(row['key']) : row['key'] as CellValue;
    return { key, label: fieldText(field, key), ...values(row) };
  });
  return result;
}
