import type { DatabaseSync } from 'node:sqlite';
import { isLookupSummary, valueField, lookupElementField, maxLinkedRecords, type CellValue, type Field, type RowRecord, type Table } from '../../contracts/src/index.js';
import { ServiceError } from '../../core/src/errors.js';
import { maxFormulaArrayItems } from '../../core/src/array-formulas.js';

const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

function isTwoHopSummary(field: Field): boolean {
  const target = field.lookupResult!;
  return isLookupSummary(field) && target.type === 'lookup' && !isLookupSummary(target) && target.lookupResult!.type !== 'lookup';
}

function chainedLookupSql(field: Field, alias = 'r', depth = 0): string {
  const targetField = field.lookupResult!;
  if (targetField.type !== 'lookup' || isTwoHopSummary(field)) return `json_object('value', ${isLookupSummary(field) ? lookupSql(field, alias) : `json(${lookupSql(field, alias)})`}, 'error', ${lookupErrorSql(field, alias)})`;
  const target = `linked${depth}`, edge = `link${depth}`, result = `computed${depth}`, choice = `member${depth}`, input = `lookup_inputs${depth}`;
  const array = !isLookupSummary(targetField), summary = isLookupSummary(field);
  const value = `${input}.value`;
  const item = array ? `CASE ${choice}.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE json_quote(${choice}.value) END` : value;
  // Read each linked result once before expanding its members; reparsing its error per member is quadratic.
  const inputs = `${input} AS MATERIALIZED (SELECT ${edge}.position, ${result}.value -> '$.value' AS value, json_extract(${result}.value, '$.error') AS error
    FROM relation_edges ${edge} JOIN records ${target} ON ${target}.id = ${edge}.target_record_id
    JOIN json_each(json_array(${chainedLookupSql(targetField, target, depth + 1)})) ${result}
    WHERE ${edge}.source_record_id = ${alias}.id AND ${edge}.field_id = ${literal(field.lookup!.relationFieldId)})`;
  const rows = `SELECT ${item} AS item, ${input}.error, ${array ? `${choice}.key IS NOT NULL` : '1'} AS present FROM ${input}
    ${array ? `LEFT JOIN json_each(${value}) ${choice}` : ''}
    ORDER BY ${input}.position${array ? `, CAST(${choice}.key AS INTEGER)` : ''}
    ${summary ? '' : `LIMIT ${maxFormulaArrayItems + maxLinkedRecords + 1}`}`;
  if (summary) {
    const functions = { count: 'COUNT', sum: 'SUM', average: 'AVG', min: 'MIN', max: 'MAX' };
    const aggregate = `${functions[field.lookup!.operation as keyof typeof functions]}(CAST(json_extract(item, '$') AS REAL))`;
    return `(WITH ${inputs} SELECT json_object('value', CASE WHEN MAX(error IS NOT NULL) OR abs(${aggregate}) > 1.7976931348623157e308 THEN NULL ELSE ${aggregate} END,
      'error', CASE WHEN MAX(error IS NOT NULL) THEN MAX(error) WHEN abs(${aggregate}) > 1.7976931348623157e308 THEN 'The linked summary exceeds the numeric range.' END) FROM (${rows}))`;
  }
  const oversized = `SUM(present) > ${maxFormulaArrayItems}`;
  return `(WITH ${inputs} SELECT json_object('value', CASE WHEN ${oversized} THEN NULL ELSE json_group_array(json(item)) FILTER (WHERE present) END,
    'error', CASE WHEN ${oversized} THEN 'Use lookup arrays of at most 40,000 items.' ELSE MAX(error) END) FROM (${rows}))`;
}

export function lookupSql(field: Field, alias = 'r'): string {
  if (isTwoHopSummary(field)) return aggregateSql(field, alias);
  if (field.lookupResult!.type === 'lookup') return `json_extract(${chainedLookupSql(field, alias)}, '$.value')`;
  if (isLookupSummary(field)) return aggregateSql(field, alias);
  const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
  const path = literal(`$.${JSON.stringify(field.lookup!.fieldId)}`);
  const multi = ['multiSelect', 'attachment'].includes(field.lookupResult!.type);
  return `(SELECT json_group_array(${multi ? 'item' : 'json(item)'}) FROM (
    SELECT ${multi ? 'choice.value' : `target.values_json -> ${path}`} AS item
    FROM relation_edges edge JOIN records target ON target.id = edge.target_record_id
    ${multi ? `JOIN json_each(json_extract(target.values_json, ${path})) choice` : ''}
    WHERE edge.source_record_id = ${alias}.id AND edge.field_id = ${literal(field.lookup!.relationFieldId)}
    ORDER BY edge.position${multi ? ', CAST(choice.key AS INTEGER)' : ''}))`;
}

function aggregateValueSql(field: Field, error: boolean, source = field): string {
  const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
  const path = literal(`$.${JSON.stringify(source.lookup!.fieldId)}`);
  const functions = { count: 'COUNT', sum: 'SUM', average: 'AVG', min: 'MIN', max: 'MAX' };
  const operation = field.lookup!.operation as keyof typeof functions;
  const result = `${functions[operation]}(CAST(json_extract(target.values_json, ${path}) AS REAL))`;
  const invalid = source.lookupResult!.type === 'formula' ? `MAX(json_extract(target.formula_errors_json, ${path}) IS NOT NULL)` : '0';
  return `CASE WHEN ${invalid} THEN ${error ? "'A linked formula has an error.'" : 'NULL'}
    WHEN abs(${result}) > 1.7976931348623157e308 THEN ${error ? "'The linked summary exceeds the numeric range.'" : 'NULL'}
    ELSE ${error ? 'NULL' : result} END`;
}

function aggregateSql(field: Field, alias: string, error = false): string {
  const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
  const source = isTwoHopSummary(field) ? field.lookupResult! : field;
  // A direct numeric lookup has at most 200 scalar members; aggregate its edges without building JSON arrays.
  const route = source === field ? `WHERE edge.source_record_id = ${alias}.id`
    : `JOIN relation_edges outer_edge ON edge.source_record_id = outer_edge.target_record_id
      WHERE outer_edge.source_record_id = ${alias}.id AND outer_edge.field_id = ${literal(field.lookup!.relationFieldId)}`;
  return `(SELECT ${aggregateValueSql(field, error, source)} FROM relation_edges edge JOIN records target ON target.id = edge.target_record_id
    ${route} AND edge.field_id = ${literal(source.lookup!.relationFieldId)})`;
}

export function lookupSummaryRowsSql(field: Field): string {
  if (field.lookupResult!.type === 'lookup') return `SELECT r.id AS record_id, ${lookupSql(field)} AS value FROM records r
    WHERE r.id IN (SELECT source_record_id FROM relation_edges WHERE field_id = ${literal(field.lookup!.relationFieldId)})`;
  return `SELECT edge.source_record_id AS record_id, ${aggregateValueSql(field, false)} AS value
    FROM relation_edges edge JOIN records target ON target.id = edge.target_record_id
    WHERE edge.field_id = '${field.lookup!.relationFieldId.replaceAll("'", "''")}' GROUP BY edge.source_record_id`;
}

function lookupErrorSql(field: Field, alias = 'r'): string {
  if (isTwoHopSummary(field)) return aggregateSql(field, alias, true);
  if (field.lookupResult!.type === 'lookup') return `json_extract(${chainedLookupSql(field, alias)}, '$.error')`;
  if (isLookupSummary(field)) return aggregateSql(field, alias, true);
  if (field.lookupResult!.type !== 'formula') return 'NULL';
  const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
  return `(CASE WHEN EXISTS (SELECT 1 FROM relation_edges edge JOIN records target ON target.id = edge.target_record_id
    WHERE edge.source_record_id = ${alias}.id AND edge.field_id = ${literal(field.lookup!.relationFieldId)}
    AND json_extract(target.formula_errors_json, ${literal(`$.${JSON.stringify(field.lookup!.fieldId)}`)}) IS NOT NULL)
    THEN 'A linked formula has an error.' END)`;
}

export class Lookups {
  constructor(private readonly db: DatabaseSync) {}

  resolve<T extends Pick<Table, 'fields'>>(table: T, override?: Table): T {
    const ids = table.fields.filter(field => field.type === 'lookup').map(field => field.id);
    if (!ids.length) return table;
    const rows = this.db.prepare(`WITH RECURSIVE overrides AS (
      SELECT json_extract(value, '$.id') AS id, value AS definition_json FROM json_each(?)
    ), needed(id) AS (
      SELECT value FROM json_each(?) UNION
      SELECT CASE WHEN o.id IS NOT NULL THEN json_extract(o.definition_json, '$.lookup.fieldId') ELSE l.target_field_id END
      FROM needed n LEFT JOIN overrides o ON o.id = n.id LEFT JOIN field_lookups l ON l.field_id = n.id
      WHERE CASE WHEN o.id IS NOT NULL THEN json_extract(o.definition_json, '$.lookup.fieldId') ELSE l.target_field_id END IS NOT NULL
    ) SELECT n.id, CASE WHEN o.id IS NOT NULL THEN ? ELSE f.table_id END AS table_id,
      COALESCE(o.definition_json, f.definition_json) AS definition_json
      FROM needed n LEFT JOIN overrides o ON o.id = n.id LEFT JOIN fields f ON f.id = n.id`)
      .all(JSON.stringify(override?.fields ?? []), JSON.stringify(ids), override?.id ?? null);
    const definitions = new Map(rows.filter(row => row['definition_json']).map(row => [row['id'] as string, JSON.parse(row['definition_json'] as string) as Field]));
    const owners = new Map(rows.map(row => [row['id'] as string, row['table_id'] as string]));
    const resolved = new Map<string, Field>(), resolving = new Set<string>();
    const resolve = (field: Field): Field => {
      if (field.type !== 'lookup') return field;
      if (resolved.has(field.id)) return resolved.get(field.id)!;
      if (resolving.has(field.id)) throw new ServiceError('INVALID_FORMULA', 'Formulas and lookups cannot form a dependency cycle across records or tables.');
      resolving.add(field.id);
      const target = definitions.get(field.lookup!.fieldId);
      if (!target) throw new ServiceError('INVALID_SCHEMA', `${field.name}: choose an existing field in the target table.`);
      const next = { ...field, lookupResult: resolve(target), lookupResultTableId: owners.get(target.id)! };
      resolving.delete(field.id); resolved.set(field.id, next);
      return next;
    };
    table.fields = table.fields.map(resolve);
    return table;
  }

  validateSchema(table: Table, before: Table): void {
    if (table.fields.find(field => field.id === table.primaryFieldId)!.type === 'lookup') {
      throw new ServiceError('INVALID_SCHEMA', 'A lookup cannot be the primary display field.');
    }
    const removed = before.fields.filter(field => !table.fields.some(next => next.id === field.id)).map(field => field.id);
    if (removed.length && this.db.prepare(`SELECT 1 FROM field_lookups WHERE
      (relation_field_id IN (SELECT value FROM json_each(?)) OR target_field_id IN (SELECT value FROM json_each(?)))
      AND field_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`).get(JSON.stringify(removed), JSON.stringify(removed), JSON.stringify(removed))) {
      throw new ServiceError('LOOKUP_DEPENDENCY', 'Remove dependent lookup fields before deleting this field.', 409);
    }
    for (const previous of before.fields) {
      const next = table.fields.find(field => field.id === previous.id);
      if (next && next.type !== previous.type && this.db.prepare('SELECT 1 FROM field_lookups WHERE target_field_id = ? LIMIT 1').get(previous.id)) {
        throw new ServiceError('LOOKUP_DEPENDENCY', 'Remove dependent lookup fields before converting this field.', 409);
      }
      if (next?.type === 'formula' && valueField(next).type !== 'number') {
        const dependents = this.db.prepare(`SELECT f.definition_json FROM field_lookups l JOIN fields f ON f.id = l.field_id WHERE l.target_field_id = ?`).all(next.id);
        if (dependents.some(row => isLookupSummary(JSON.parse(row['definition_json'] as string) as Field))) {
          throw new ServiceError('LOOKUP_DEPENDENCY', 'Remove dependent linked summaries before changing the formula result type.', 409);
        }
      }
    }
    for (const field of table.fields.filter(field => field.type === 'lookup')) {
      const relation = table.fields.find(source => source.id === field.lookup!.relationFieldId);
      if (relation?.type !== 'relation') throw new ServiceError('INVALID_SCHEMA', `${field.name}: choose a linked-record field in this table.`);
      const row = this.db.prepare('SELECT definition_json FROM fields WHERE id = ? AND table_id = ?')
        .get(field.lookup!.fieldId, relation.relation!.tableId);
      const target = relation.relation!.tableId === table.id ? table.fields.find(target => target.id === field.lookup!.fieldId)
        : row ? JSON.parse(row['definition_json'] as string) as Field : undefined;
      if (!target || target.type === 'relation') {
        throw new ServiceError('INVALID_SCHEMA', `${field.name}: choose a non-linked field in the target table.`);
      }
      field.lookupResult = target;
    }
    this.resolve(table, table);
    for (const field of table.fields) {
      if (isLookupSummary(field) && lookupElementField(field.lookupResult!).type !== 'number') {
        const previous = before.fields.find(previous => previous.id === field.id);
        const dependent = previous && JSON.stringify(previous.lookup) === JSON.stringify(field.lookup);
        throw new ServiceError(dependent ? 'LOOKUP_DEPENDENCY' : 'INVALID_SCHEMA', `${field.name}: numeric summaries require numeric values in the target field.`, dependent ? 409 : 400);
      }
    }
    const dependents = this.db.prepare(`SELECT definition_json FROM fields WHERE table_id IN (SELECT value FROM json_each(?))
      AND json_extract(definition_json, '$.type') = 'lookup'`).all(JSON.stringify(this.dependents(table.id)))
      .map(row => JSON.parse(row['definition_json'] as string) as Field);
    for (const field of this.resolve({ fields: dependents }, table).fields) {
      if (isLookupSummary(field) && lookupElementField(field.lookupResult!).type !== 'number') {
        throw new ServiceError('LOOKUP_DEPENDENCY', 'Remove dependent linked summaries before changing the lookup result type.', 409);
      }
    }
  }

  sync(table: Table): void {
    const write = this.db.prepare(`INSERT INTO field_lookups VALUES (?, ?, ?) ON CONFLICT(field_id)
      DO UPDATE SET relation_field_id = excluded.relation_field_id, target_field_id = excluded.target_field_id`);
    for (const field of table.fields.filter(field => field.type === 'lookup')) write.run(field.id, field.lookup!.relationFieldId, field.lookup!.fieldId);
  }

  hydrate(table: Table, records: RowRecord[], output?: string[]): RowRecord[] {
    const fields = table.fields.filter(field => field.type === 'lookup' && (!output || output.includes(field.id)));
    if (!fields.length || !records.length) return records;
    const rows = this.db.prepare(`SELECT r.id, ${fields.map((field, index) => `${lookupSql(field)} AS value_${index}, ${lookupErrorSql(field)} AS error_${index}`).join(', ')}
      FROM records r WHERE r.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(records.map(record => record.id)));
    const byId = new Map(records.map(record => [record.id, record]));
    for (const row of rows) {
      const record = byId.get(row['id'] as string)!;
      fields.forEach((field, index) => {
        const value = row[`value_${index}`];
        record.values[field.id] = isLookupSummary(field) || value === null ? value as number | null : JSON.parse(value as string) as CellValue;
        if (row[`error_${index}`]) {
          record.formulaErrors ??= {};
          record.formulaErrors[field.id] = row[`error_${index}`] as string;
        }
      });
    }
    return records;
  }

  dependents(tableId: string): string[] {
    return this.db.prepare(`WITH RECURSIVE affected(id) AS (VALUES (?) UNION
      SELECT source.table_id FROM affected a JOIN fields target ON target.table_id = a.id
      JOIN field_lookups l ON l.target_field_id = target.id JOIN fields source ON source.id = l.field_id)
      SELECT id FROM affected WHERE id <> ?`).all(tableId, tableId).map(row => row['id'] as string);
  }

  deleteTable(tableId: string): void {
    this.db.prepare('DELETE FROM field_lookups WHERE field_id IN (SELECT id FROM fields WHERE table_id = ?)').run(tableId);
  }
}
