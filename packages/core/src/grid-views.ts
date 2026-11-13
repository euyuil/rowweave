import { randomUUID } from 'node:crypto';
import { supportsScalarGrouping, type FieldFilter, type FilterGroup, type GridView, type RowHeight, type Table, type ViewQuery } from '../../contracts/src/index.js';
import { parseQuery } from './record-query.js';
import { parseSummary } from './record-summary.js';
import { schemaName, schemaObject } from './schema-validation.js';
import { ServiceError } from './errors.js';

export function defaultView(table: Pick<Table, 'id' | 'fields'>): GridView {
  return { id: randomUUID(), tableId: table.id, name: 'All records', version: 1, query: {}, rowHeight: 36, frozenColumns: 0, type: 'grid',
    columns: table.fields.map(field => ({ fieldId: field.id, width: 180, hidden: false })) };
}

export function parseView(table: Table, input: unknown, previous = defaultView(table)): GridView {
  const item = schemaObject(input);
  const type = item['type'] === undefined ? previous.type : item['type'];
  if (type !== 'grid' && type !== 'board') throw new ServiceError('INVALID_VIEW', 'Choose a grid or board view.');
  const groupBy = item['groupBy'] === undefined ? (type === previous.type ? previous.groupBy : undefined) : item['groupBy'];
  if (type === 'board' && (typeof groupBy !== 'string' || !table.fields.some(field => field.id === groupBy && field.type === 'singleSelect'))) {
    throw new ServiceError('INVALID_VIEW', 'A board needs a single-select grouping field. Choose another field or change the view to a grid.');
  }
  if (type === 'grid' && groupBy != null && (typeof groupBy !== 'string' ||
      !table.fields.some(field => field.id === groupBy && supportsScalarGrouping(field)))) {
    throw new ServiceError('INVALID_VIEW', 'Group a grid by a scalar field, or remove grouping.');
  }
  const grouped = type === 'grid' && groupBy != null;
  const measures = parseSummary(table, { measures: item['groupMeasures'] === undefined
    ? (grouped ? previous.groupMeasures : undefined) : item['groupMeasures'] }).measures;
  if (measures.length && !grouped) throw new ServiceError('INVALID_VIEW', 'Group a grid before adding group measures.');
  const query = parseQuery(table, item['query'] === undefined ? previous.query : item['query']);
  const saved: ViewQuery = {};
  if (query.filter) saved.filter = query.filter;
  if (query.sort) saved.sort = query.sort;
  if (query.search !== undefined) saved.search = query.search;
  let columns = previous.columns;
  if (item['columns'] !== undefined) {
    const values = item['columns'];
    const ids = new Set(table.fields.map(field => field.id));
    if (!Array.isArray(values) || values.length !== ids.size) throw new ServiceError('INVALID_VIEW', 'Include each table field exactly once in columns.');
    columns = values.map(value => {
      const column = schemaObject(value);
      if (typeof column['fieldId'] !== 'string' || !ids.delete(column['fieldId']) ||
          !Number.isInteger(column['width']) || (column['width'] as number) < 50 || (column['width'] as number) > 1_000 ||
          typeof column['hidden'] !== 'boolean') {
        throw new ServiceError('INVALID_VIEW', 'Columns need unique field IDs, widths from 50 to 1000, and boolean visibility.');
      }
      return { fieldId: column['fieldId'], width: column['width'] as number, hidden: column['hidden'] };
    });
    if (columns.every(column => column.hidden)) throw new ServiceError('INVALID_VIEW', 'Keep at least one field visible.');
  }
  const rowHeight = item['rowHeight'] === undefined ? previous.rowHeight : item['rowHeight'];
  if (![36, 48, 64].includes(rowHeight as number)) throw new ServiceError('INVALID_VIEW', 'Row height must be 36, 48 or 64 pixels.');
  const visible = columns.filter(column => !column.hidden).length;
  const frozenColumns = item['frozenColumns'] === undefined ? Math.min(previous.frozenColumns, visible) : item['frozenColumns'];
  if (!Number.isInteger(frozenColumns) || (frozenColumns as number) < 0 || (frozenColumns as number) > visible) {
    throw new ServiceError('INVALID_VIEW', 'Freeze a whole number of leading columns, up to the number of visible fields.');
  }
  const { groupBy: _previousGroup, groupMeasures: _previousMeasures, ...base } = previous;
  return { ...base, name: item['name'] === undefined ? previous.name : schemaName(item['name']), query: saved, columns,
    rowHeight: rowHeight as RowHeight, frozenColumns: frozenColumns as number, type,
    ...(groupBy == null ? {} : { groupBy: groupBy as string }), ...(measures.length ? { groupMeasures: measures } : {}) };
}

export function groupedViewQuery(view: GridView): ViewQuery & { groupBy?: string } {
  return { ...view.query, ...(view.type === 'grid' && view.groupBy ? { groupBy: view.groupBy } : {}) };
}

export function reconcileView(view: GridView, table: Table): GridView {
  const ids = new Set(table.fields.map(field => field.id));
  const columns = view.columns.filter(column => ids.has(column.fieldId)).map(column => ({ ...column }));
  for (const field of table.fields) {
    if (!columns.some(column => column.fieldId === field.id)) columns.push({ fieldId: field.id, width: 180, hidden: false });
  }
  if (columns.every(column => column.hidden)) columns.find(column => column.fieldId === table.primaryFieldId)!.hidden = false;
  function prune(group: FilterGroup): FilterGroup | undefined {
    const conditions: Array<FieldFilter | FilterGroup> = [];
    let changed = false;
    for (const condition of group.conditions) {
      if ('conjunction' in condition) {
        const child = prune(condition);
        if (child !== condition) changed = true;
        if (child) conditions.push(child);
      } else if (ids.has(condition.fieldId)) conditions.push(condition);
      else changed = true;
    }
    if (!changed) return group;
    return conditions.length ? { conjunction: group.conjunction, conditions } : undefined;
  }
  const query: ViewQuery = { ...view.query };
  if (query.filter) {
    const filter = prune(query.filter);
    if (filter) query.filter = filter;
    else delete query.filter;
  }
  if (query.sort) query.sort = query.sort.filter(sort => ids.has(sort.fieldId));
  try { return parseView(table, { query, columns }, view); }
  catch (error) {
    if (error instanceof ServiceError) throw new ServiceError('VIEW_DEPENDENCY', `Update view "${view.name}" before changing this field: ${error.message}`, 409);
    throw error;
  }
}
