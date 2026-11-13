import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { valueField, isLookupSummary, type Field, type GroupPathCollapse, type GroupLayout, type GroupSegment, type GroupWindow, type ScalarValue, type SummaryMeasure, type Table } from '../../contracts/src/index.js';
import { ServiceError } from '../../core/src/errors.js';
import { fieldText } from '../../core/src/field-display.js';
import { lookupSql } from './lookups.js';
import { groupOrder } from './query-sql.js';
import { groupLayout } from './group-layout.js';

type PendingGroup = Omit<GroupSegment, 'label' | 'path' | 'leaf'> & { path: ScalarValue[]; leaf: boolean };

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
  const keys = fields.map((_, index) => `key${index}`), last = fields.length - 1;
  const expressions = fields.map((field, index) => expression(field, `nestedKey${index}`));
  const inputKeys = expressions.map((expression, index) => `${expression} AS ${keys[index]}`);
  const selectedFields = fields.map(valueField), root = selectedFields[0]!;
  const configured = root.type === 'singleSelect' ? [...root.options!.map(option => option.id), null] : root.type === 'checkbox' ? [false, true, null] : [null];
  const order = fields.flatMap((field, index) => groupOrder(field, keys[index]!)).join(', ');
  // Zero-count seeds retain empty root headings without creating synthetic child groups.
  const statement = db.prepare(`WITH input AS MATERIALIZED (SELECT ${inputKeys.join(', ')} FROM records r WHERE ${where}),
    seeded AS (SELECT ${keys.join(', ')}, COUNT(*) AS count FROM input GROUP BY ${keys.join(', ')}
      UNION ALL SELECT configured.value${keys.slice(1).map(() => ', NULL').join('')}, 0 FROM json_each(:nestedConfigured) configured)
    SELECT * FROM seeded ORDER BY ${order}`);
  statement.setReturnArrays(true);
  const iterator = statement.iterate({ ...parameters, ...bindings, ':nestedConfigured': JSON.stringify(configured) }) as unknown as Iterable<ScalarValue[]>;
  const rootExceptions = new Set<ScalarValue>(), childExceptions = new Map<ScalarValue, Set<string>>();
  for (const path of collapse.exceptions) {
    if (path.length === 1) rootExceptions.add(path[0]!);
    else {
      let choices = childExceptions.get(path[0]!);
      if (!choices) { choices = new Set(); childExceptions.set(path[0]!, choices); }
      choices.add(JSON.stringify(path));
    }
  }
  // Only the current ancestry and requested segments stay in service memory.
  const active: PendingGroup[] = [], groups: PendingGroup[] = [];
  let totalRecords = 0, totalGroups = 0, totalRows = 0, expanded = 0;
  const capture = (group: PendingGroup) => { if (groups.at(-1) !== group) groups.push(group); };
  for (const row of iterator) {
    const count = row[fields.length] as number;
    const path = keys.map((_, index) => selectedFields[index]!.type === 'checkbox' && row[index] !== null ? Boolean(row[index]) : row[index]!);
    let common = 0;
    while (common < active.length && active[common]!.key === path[common]) common++;
    active.length = common;
    for (let depth = common; depth < fields.length && (depth === 0 || count > 0 && !active[depth - 1]!.collapsed); depth++) {
      const prefix = path.slice(0, depth + 1), key = path[depth]!;
      const toggled = depth === 0 ? rootExceptions.has(key) : childExceptions.get(path[0]!)?.has(JSON.stringify(prefix));
      const group = { path: prefix, key, count: 0, recordOffset: totalRecords,
        rowStart: totalRows, expandedOffset: expanded, collapsed: toggled ? !collapse.defaultCollapsed : collapse.defaultCollapsed,
        leaf: depth === last };
      active.push(group); totalGroups++; totalRows++;
      if (window === 'displayRows' && group.rowStart >= offset && group.rowStart < offset + limit) capture(group);
    }
    for (const group of active) group.count += count;
    const leaf = active[last];
    if (leaf && !leaf.collapsed) {
      if (window === 'displayRows' ? leaf.rowStart < offset + limit && leaf.rowStart + 1 + count > offset
        : count > 0 && expanded < offset + limit && expanded + count > offset) capture(leaf);
      totalRows += count; expanded += count;
    }
    totalRecords += count;
  }
  // The store keeps both reads in one snapshot; SQLite computes complete selected measures.
  if (measures.length && groups.length) {
    const columns = new Map<string, string>();
    for (const measure of measures) if (!columns.has(measure.fieldId)) columns.set(measure.fieldId,
      expression(table.fields.find(field => field.id === measure.fieldId)!, `nestedMeasure${columns.size}`));
    const functions = { sum: 'SUM', average: 'AVG', min: 'MIN', max: 'MAX' };
    const rootFilter = groups.every(group => group.path[0] === null) ? `${expressions[0]} IS NULL`
      : `${expressions[0]} IN (SELECT key0 FROM selected)` + (groups.some(group => group.path[0] === null) ? ` OR ${expressions[0]} IS NULL` : '');
    const measured = db.prepare(`WITH selected AS MATERIALIZED (
      SELECT key AS groupIndex, json_array_length(value) AS depth, ${keys.map((key, index) => `json_extract(value, '$[${index}]') AS ${key}`).join(', ')}
      FROM json_each(:nestedSelected)
    ), input AS MATERIALIZED (
      SELECT ${inputKeys.join(', ')}, r.id AS recordId FROM records r WHERE ${where} AND
        (${rootFilter})
    ), matching AS MATERIALIZED (
      ${fields.map((_, index) => `SELECT selected.groupIndex, input.recordId FROM selected JOIN input ON
        ${keys.slice(0, index + 1).map(key => `input.${key} IS selected.${key}`).join(' AND ')} WHERE selected.depth = ${index + 1}`).join(' UNION ALL ')}
    ), measureInput AS MATERIALIZED (
      SELECT matching.groupIndex, ${[...columns].map(([_, expression], index) => `${expression} AS measureInput${index}`).join(', ')}
      FROM matching JOIN records r ON r.id = matching.recordId
    ) SELECT groupIndex, ${measures.map((measure, index) => `${functions[measure.operation]}(CAST(measureInput${[...columns.keys()].indexOf(measure.fieldId)} AS REAL)) AS measure${index}`).join(', ')}
      FROM measureInput GROUP BY groupIndex`).all({ ...parameters, ...bindings,
      ':nestedSelected': JSON.stringify(groups.map(group => group.path.map(key => typeof key === 'boolean' ? Number(key) : key))) });
    for (const group of groups) group.values = measures.map(() => null);
    for (const row of measured) groups[row['groupIndex'] as number]!.values = measures.map((_, index) => row[`measure${index}`] as number | null);
    if (groups.some(group => group.values!.some(value => value !== null && !Number.isFinite(value)))) throw new ServiceError('SUMMARY_OVERFLOW', 'A group summary exceeds the supported numeric range.');
  }
  return { window, groups: groups.map(group => ({ ...group, label: fieldText(fields[group.path.length - 1]!, group.key) })), totalRecords, totalGroups, totalRows, offset, revision: table.revision, schemaVersion: table.version };
}
