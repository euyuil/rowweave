import { CompactSelection, type GridSelection } from '@glideapps/glide-data-grid';
import { maxBatchRecords } from '../../contracts/src/index.js';
import type { TableModel, TableRefresh } from '../../client/src/table-model.js';

export function refreshSelection(selection: GridSelection, model: TableModel, snapshot: TableRefresh): {
  selection: GridSelection; cleared: boolean;
} {
  const current = selection.current;
  const empty = () => ({ selection: { columns: CompactSelection.empty(), rows: CompactSelection.empty() },
    cleared: !!current || selection.rows.length > 0 || selection.columns.length > 0 });
  if (selection.columns.length || selection.rows.length + (current?.range.height ?? 0) > maxBatchRecords || current?.rangeStack.length) return empty();
  const definitions = new Map(snapshot.table.fields.map(field => [field.id, field]));
  const fields = snapshot.query.fields ? snapshot.query.fields.flatMap(id => definitions.has(id) ? [definitions.get(id)!] : []) : snapshot.table.fields;
  const record = (row: number) => snapshot.pages.get(Math.floor(row / model.pageSize))?.records[row % model.pageSize];
  const rows = [...selection.rows.toArray(), ...(current
    ? Array.from({ length: current.range.height }, (_, index) => current.range.y + index) : [])];
  const sameRows = rows.every(row => { const previous = model.getRecord(row); return !!previous && previous.id === record(row)?.id; });
  const columns = selection.rows.length ? model.fields.map((_, index) => index) : current
    ? Array.from({ length: current.range.width }, (_, index) => current.range.x + index) : [];
  const sameFields = columns.every(column => !!model.fields[column] && model.fields[column]!.id === fields[column]?.id) &&
    (!selection.rows.length || model.fields.length === fields.length);
  if (sameRows && sameFields) return { selection, cleared: false };
  if (!selection.rows.length && current?.range.width === 1 && current.range.height === 1) {
    const selected = model.getRecord(current.cell[1]);
    const column = fields.findIndex(field => field.id === model.fields[current.cell[0]]?.id);
    if (selected && column >= 0) for (const page of snapshot.pages.values()) {
      const index = page.records.findIndex(record => record.id === selected.id);
      if (index < 0) continue;
      const row = page.offset + index;
      return { selection: { ...selection, current: { ...current, cell: [column, row],
        range: { x: column, y: row, width: 1, height: 1 } } }, cleared: false };
    }
  }
  return empty();
}
