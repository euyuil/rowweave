import type { SQLInputValue } from 'node:sqlite';
import type { CellValue, Field, FieldFilter, FilterGroup, Table } from '../../contracts/src/index.js';
import type { CheckedQuery } from '../../core/src/record-query.js';
import { lookupSql } from './lookups.js';

function sqlLiteral(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return value.includes('\0') ? `CAST(X'${Buffer.from(value).toString('hex')}' AS TEXT)` : `'${value.replaceAll("'", "''")}'`;
}

export function querySql(table: Pick<Table, 'id' | 'fields'>, query: CheckedQuery, targets: Map<string, Table>, forIndex = false) {
  const fields = new Map(table.fields.map(field => [field.id, field]));
  const parameters: Record<string, SQLInputValue> = forIndex ? {} : { ':table': table.id };
  let parameterIndex = 0;
  const bind = (value: CellValue) => {
    const normalized = typeof value === 'boolean' ? Number(value) : Array.isArray(value) ? JSON.stringify(value) : value;
    if (forIndex) return sqlLiteral(normalized);
    const name = `:p${parameterIndex++}`;
    parameters[name] = normalized;
    return name;
  };
  const raw = (field: Field, alias = forIndex ? '' : 'r') => {
    if (field.type === 'lookup') return lookupSql(field, alias);
    const path = `$.${JSON.stringify(field.id)}`;
    return `json_extract(${alias ? `${alias}.` : ''}values_json, '${path.replaceAll("'", "''")}')`;
  };
  function formatted(field: Field, value: string): string {
    if (field.type === 'checkbox') return `(CASE ${value} WHEN 1 THEN 'true' WHEN 0 THEN 'false' END)`;
    if (field.type === 'singleSelect' || field.type === 'multiSelect') {
      if (!field.options!.length) return 'NULL';
      if (field.type === 'singleSelect') return `(CASE ${value} ${field.options!.map(option =>
        `WHEN ${sqlLiteral(option.id)} THEN ${sqlLiteral(option.name)}`).join(' ')} END)`;
      const labels = bind(JSON.stringify(Object.fromEntries(field.options!.map(option => [option.id, option.name]))));
      return `(SELECT group_concat(label.value, ', ') FROM json_each(${value}) choice
        JOIN json_each(${labels}) label ON label.key = choice.value)`;
    }
    return value;
  }
  function display(field: Field, alias = forIndex ? '' : 'r', sorting = false): string {
    const value = raw(field, alias);
    if (field.type === 'relation') {
      const target = targets.get(field.relation!.tableId)!;
      const primary = target.fields.find(item => item.id === target.primaryFieldId)!;
      return `(SELECT group_concat(label, ', ') FROM (SELECT ${display(primary, 'linked')} AS label
        FROM relation_edges edge JOIN records linked ON linked.id = edge.target_record_id
        WHERE edge.source_record_id = ${alias}.id AND edge.field_id = ${bind(field.id)} ORDER BY edge.position))`;
    }
    if (field.type === 'lookup') {
      const target = field.lookupResult!;
      const scalar = target.type === 'multiSelect' ? { ...target, type: 'singleSelect' as const } : target;
      if (sorting) return formatted(scalar, `json_extract(${value}, '$[0]')`);
      return `(SELECT group_concat(${formatted(scalar, 'entry.value')}, ', ') FROM json_each(${value}) entry)`;
    }
    return formatted(field, value);
  }
  function condition(filter: FieldFilter | FilterGroup): string {
    if ('conjunction' in filter) {
      if (!filter.conditions.length) return filter.conjunction === 'and' ? '1' : '0';
      return `(${filter.conditions.map(condition).join(filter.conjunction === 'and' ? ' AND ' : ' OR ')})`;
    }
    const field = fields.get(filter.fieldId)!;
    const value = raw(field);
    if (field.type === 'lookup') {
      if (filter.operator === 'isEmpty' || filter.operator === 'isNotEmpty') {
        const hasValue = `EXISTS (SELECT 1 FROM json_each(${value}) entry WHERE entry.value IS NOT NULL AND entry.value <> '')`;
        return filter.operator === 'isEmpty' ? `NOT ${hasValue}` : hasValue;
      }
      let match: string;
      if (filter.operator === 'contains') match = `instr(lower(entry.value), lower(${bind(filter.value!)})) > 0`;
      else if (filter.operator === 'hasAny') {
        const ids = filter.value as string[];
        match = ids.length ? `entry.value IN (${ids.map(bind).join(', ')})` : '0';
      } else {
        const operators = { eq: 'IS', neq: 'IS', gt: '>', gte: '>=', lt: '<', lte: '<=' };
        match = `entry.value ${operators[filter.operator]} ${bind(filter.value!)}`;
      }
      const any = `EXISTS (SELECT 1 FROM json_each(${value}) entry WHERE ${match})`;
      return filter.operator === 'neq' ? `NOT ${any}` : any;
    }
    if (filter.operator === 'isEmpty' || filter.operator === 'isNotEmpty') {
      const empty = `(${value} IS NULL OR ${value} = ''${['multiSelect', 'relation'].includes(field.type) ? ` OR json_array_length(${value}) = 0` : ''})`;
      return filter.operator === 'isEmpty' ? empty : `NOT ${empty}`;
    }
    if (filter.operator === 'contains') return `instr(lower(${value}), lower(${bind(filter.value!)})) > 0`;
    if (filter.operator === 'hasAny') {
      const ids = filter.value as string[];
      return ids.length ? `EXISTS (SELECT 1 FROM json_each(${value}) selected WHERE selected.value IN (${ids.map(bind).join(', ')}))` : '0';
    }
    const operators = { eq: 'IS', neq: 'IS NOT', gt: '>', gte: '>=', lt: '<', lte: '<=' };
    return `${value} ${operators[filter.operator]} ${bind(filter.value!)}`;
  }
  const clauses = [forIndex ? `table_id = ${sqlLiteral(table.id)}` : 'r.table_id = :table'];
  if (query.recordIds) clauses.push(`r.id IN (SELECT value FROM json_each(${bind(query.recordIds)}))`);
  if (query.filter) clauses.push(condition(query.filter));
  if (query.search) {
    const search = bind(query.search);
    clauses.push(`(${table.fields.map(field => `instr(lower(CAST(${display(field)} AS TEXT)), lower(${search})) > 0`).join(' OR ')})`);
  }
  const countParameters = { ...parameters };
  const order = (query.sort ?? []).flatMap(sort => {
    const expression = display(fields.get(sort.fieldId)!, forIndex ? '' : 'r', true);
    return [`(${expression} IS NULL) ASC`, `${expression} COLLATE NOCASE ${sort.direction === 'asc' ? 'ASC' : 'DESC'}`];
  });
  order.push(forIndex ? 'position ASC' : 'r.position ASC');
  return { where: clauses.join(' AND '), order: order.join(', '), parameters, countParameters };
}
