import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { valueField, isLookupSummary, type Field, type GroupPathCollapse, type GroupLayout, type GroupWindow, type ScalarValue, type SummaryMeasure, type Table } from '../../contracts/src/index.js';
import { fieldText } from '../../core/src/field-display.js';
import { ServiceError } from '../../core/src/errors.js';
import { lookupSql } from './lookups.js';
import { groupOrder } from './query-sql.js';
import { groupLayout } from './group-layout.js';

export function nestedGroupLayout(db: DatabaseSync, table: Table, fields: readonly Field[], collapse: GroupPathCollapse,
  where: string, parameters: Record<string, SQLInputValue>, offset: number, limit: number, window: GroupWindow, measures: SummaryMeasure[]): GroupLayout {
  if (collapse.defaultCollapsed && !collapse.exceptions.some(path => path.length === 1)) {
    const layout = groupLayout(db, table, fields[0]!, { defaultCollapsed: true, exceptions: [] }, where, parameters, offset, limit, window, measures);
    return { ...layout, groups: layout.groups.map(group => ({ ...group, path: [group.key], leaf: false })) };
  }
  const bindings: Record<string, SQLInputValue> = {};
  const expression = (field: Field, name: string) => {
    if (isLookupSummary(field)) return lookupSql(field);
    bindings[`:${name}`] = `$.${JSON.stringify(field.id)}`;
    return `json_extract(r.values_json, :${name})`;
  };
  const keys = fields.map((_, index) => `key${index}`);
  const inputKeys = fields.map((field, index) => `${expression(field, `nestedKey${index}`)} AS ${keys[index]}`);
  const selectedFields = fields.map(valueField);
  const root = selectedFields[0]!;
  const configured = root.type === 'singleSelect' ? [...root.options!.map(option => option.id), null]
    : root.type === 'checkbox' ? [false, true, null] : [null];
  const collapsed = (index: number) => `CASE WHEN e${index}.depth IS NULL THEN :nestedCollapsed ELSE NOT :nestedCollapsed END`;
  // A collapsed branch owns its record span; descendants do not need their own layout nodes.
  const nodes = fields.map((_, index) => `SELECT ${index + 1} AS depth,
    ${keys.map((key, column) => column <= index ? `input.${key}` : `NULL AS ${key}`).join(', ')}, COUNT(*) AS count
    FROM input ${keys.slice(0, index).map((_, ancestor) => `LEFT JOIN exceptions e${ancestor} ON e${ancestor}.depth = ${ancestor + 1} AND ` +
      keys.slice(0, ancestor + 1).map(key => `e${ancestor}.${key} IS input.${key}`).join(' AND ')).join(' ')}
    ${index ? 'WHERE ' + keys.slice(0, index).map((_, ancestor) => `NOT (${collapsed(ancestor)})`).join(' AND ') : ''}
    GROUP BY ${keys.slice(0, index + 1).map(key => `input.${key}`).join(', ')}`);
  const order = fields.flatMap((field, index) => [
    ...(index ? [`CASE WHEN depth = ${index} THEN 0 ELSE 1 END`] : []), ...groupOrder(field, keys[index]!),
  ]).join(', ');
  const path = (depth: number) => `json_array(${keys.slice(0, depth).map(key => `nodes.${key}`).join(', ')})`;
  const range = window === 'expandedRecords'
    ? 'expandedCount > 0 AND expandedOffset < :nestedOffset + :nestedLimit AND expandedOffset + expandedCount > :nestedOffset'
    : 'rowStart < :nestedOffset + :nestedLimit AND rowStart + span > :nestedOffset';

  const columns = new Map<string, string>();
  for (const measure of measures) {
    if (!columns.has(measure.fieldId)) columns.set(measure.fieldId, expression(table.fields.find(field => field.id === measure.fieldId)!, `nestedMeasure${columns.size}`));
  }
  const functions = { sum: 'SUM', average: 'AVG', min: 'MIN', max: 'MAX' };
  const measured = measures.length ? `, matching AS MATERIALIZED (
      ${fields.map((_, index) => `SELECT selected.path, input.recordId FROM selected JOIN input ON
        ${keys.slice(0, index + 1).map(key => `input.${key} IS selected.${key}`).join(' AND ')} WHERE selected.depth = ${index + 1}`).join(' UNION ALL ')}
    ), measureInput AS MATERIALIZED (
      SELECT matching.path, ${[...columns].map(([_, expression], index) => `${expression} AS measureInput${index}`).join(', ')}
      FROM matching JOIN records r ON r.id = matching.recordId
    ), measured AS (SELECT path, ${measures.map((measure, index) => `${functions[measure.operation]}(CAST(measureInput${[...columns.keys()].indexOf(measure.fieldId)} AS REAL)) AS measure${index}`).join(', ')}
      FROM measureInput GROUP BY path)` : '';
  const values = measures.length ? `, 'values', json_array(${measures.map((_, index) => `measured.measure${index}`).join(', ')})` : '';
  const row = db.prepare(`WITH input AS MATERIALIZED (
      SELECT ${inputKeys.join(', ')}${measures.length ? ', r.id AS recordId' : ''} FROM records r WHERE ${where}
    ), exceptions AS MATERIALIZED (
      SELECT json_array_length(value) AS depth, ${keys.map((key, index) => `json_extract(value, '$[${index}]') AS ${key}`).join(', ')} FROM json_each(:nestedExceptions)
    ), actual AS MATERIALIZED (${nodes.join(' UNION ALL ')}), nodes AS MATERIALIZED (SELECT * FROM actual UNION ALL
      SELECT 1, configured.value${keys.slice(1).map(() => ', NULL').join('')}, 0 FROM json_each(:nestedConfigured) configured
      WHERE NOT EXISTS (SELECT 1 FROM actual WHERE actual.depth = 1 AND actual.key0 IS configured.value)
    ), flags AS (
      SELECT nodes.*, CASE nodes.depth ${fields.map((_, index) => `WHEN ${index + 1} THEN ${path(index + 1)}`).join(' ')} END AS path,
        CASE WHEN chosen.depth IS NULL THEN :nestedCollapsed ELSE NOT :nestedCollapsed END AS collapsed
      FROM nodes LEFT JOIN exceptions chosen ON chosen.depth = nodes.depth AND ${keys.map(key => `chosen.${key} IS nodes.${key}`).join(' AND ')}
    ), spans AS (
      SELECT *, 1 + CASE WHEN depth = ${fields.length} AND NOT collapsed THEN count ELSE 0 END AS span,
        CASE WHEN depth = ${fields.length} OR collapsed THEN count ELSE 0 END AS sourceCount,
        CASE WHEN depth = ${fields.length} AND NOT collapsed THEN count ELSE 0 END AS expandedCount FROM flags
    ), layout AS MATERIALIZED (
      SELECT *, SUM(sourceCount) OVER (ORDER BY ${order} ROWS UNBOUNDED PRECEDING) - sourceCount AS recordOffset,
        SUM(span) OVER (ORDER BY ${order} ROWS UNBOUNDED PRECEDING) - span AS rowStart,
        SUM(expandedCount) OVER (ORDER BY ${order} ROWS UNBOUNDED PRECEDING) - expandedCount AS expandedOffset FROM spans
    ), selected AS MATERIALIZED (SELECT * FROM layout WHERE ${range} ORDER BY rowStart LIMIT :nestedLimit)
    ${measured}
    SELECT SUM(sourceCount) AS totalRecords, COUNT(*) AS totalGroups, SUM(span) AS totalRows,
      (SELECT json_group_array(json_object('path', json(selected.path), 'count', count,
        'recordOffset', recordOffset, 'rowStart', rowStart, 'expandedOffset', expandedOffset,
        'collapsed', collapsed, 'leaf', depth = ${fields.length}${values}) ORDER BY selected.rowStart) FROM selected
        ${measures.length ? 'LEFT JOIN measured ON measured.path = selected.path' : ''}) AS segments FROM layout`).get({
      ...parameters, ...bindings, ':nestedConfigured': JSON.stringify(configured),
      ':nestedExceptions': JSON.stringify(collapse.exceptions.map(path => path.map(key => typeof key === 'boolean' ? Number(key) : key))),
      ':nestedCollapsed': Number(collapse.defaultCollapsed), ':nestedOffset': offset, ':nestedLimit': limit,
    })!;
  const segments = JSON.parse(row['segments'] as string) as Array<{ path: ScalarValue[]; count: number; recordOffset: number; rowStart: number; expandedOffset: number; collapsed: number; leaf: number; values?: Array<number | null> }>;
  return { window, groups: segments.map(segment => {
    if (segment.values?.some(value => value !== null && !Number.isFinite(value))) throw new ServiceError('SUMMARY_OVERFLOW', 'A group summary exceeds the supported numeric range.');
    const path = segment.path.map((key, index) => selectedFields[index]!.type === 'checkbox' && key !== null ? Boolean(key) : key);
    const key = path.at(-1)!;
    return { ...segment, path, key, label: fieldText(fields[path.length - 1]!, key), collapsed: Boolean(segment.collapsed), leaf: Boolean(segment.leaf) };
  }), totalRecords: row['totalRecords'] as number, totalGroups: row['totalGroups'] as number, totalRows: row['totalRows'] as number,
    offset, revision: table.revision, schemaVersion: table.version };
}
