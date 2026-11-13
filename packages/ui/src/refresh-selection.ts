import { CompactSelection, type GridSelection } from '@glideapps/glide-data-grid';
import { maxBatchRecords } from '../../contracts/src/index.js';
import type { TableModel, TableRefresh } from '../../client/src/table-model.js';
import type { GroupedRows } from '../../client/src/grouped-rows.js';

export function refreshSelection(selection: GridSelection, model: TableModel, snapshot: TableRefresh,
  previousGroups?: GroupedRows, nextGroups?: GroupedRows): { selection: GridSelection; cleared: boolean } {
  const current = selection.current;
  const empty = () => ({ selection: { columns: CompactSelection.empty(), rows: CompactSelection.empty() },
    cleared: !!current || selection.rows.length > 0 || selection.columns.length > 0 });
  if (selection.columns.length || selection.rows.length + (current?.range.height ?? 0) > maxBatchRecords || current?.rangeStack.length) return empty();
  const definitions = new Map(snapshot.table.fields.map(field => [field.id, field]));
  const fields = snapshot.query.fields ? snapshot.query.fields.flatMap(id => definitions.has(id) ? [definitions.get(id)!] : []) : snapshot.table.fields;
  const record = (row: number) => snapshot.pages.get(Math.floor(row / model.pageSize))?.records[row % model.pageSize] ?? snapshot.visibleRows.get(row);
  const position = (row: number, groups?: GroupedRows) => groups ? groups.at(row) : { kind: 'record' as const, index: row };
  const rows = [...selection.rows.toArray(), ...(current
    ? Array.from({ length: current.range.height }, (_, index) => current.range.y + index) : [])];
  const sameRows = rows.every(row => {
    const previous = position(row, previousGroups), next = position(row, nextGroups);
    if (previous?.kind === 'group' && next?.kind === 'group') return previous.group.key === next.group.key;
    if (previous?.kind !== 'record' || next?.kind !== 'record') return false;
    const saved = model.getRecord(previous.index);
    return !!saved && saved.id === record(next.index)?.id;
  });
  const columns = selection.rows.length ? model.fields.map((_, index) => index) : current
    ? Array.from({ length: current.range.width }, (_, index) => current.range.x + index) : [];
  const sameFields = columns.every(column => !!model.fields[column] && model.fields[column]!.id === fields[column]?.id) &&
    (!selection.rows.length || model.fields.length === fields.length);
  if (sameRows && sameFields) return { selection, cleared: false };
  if (!selection.rows.length && current?.range.width === 1 && current.range.height === 1) {
    const previous = position(current.cell[1], previousGroups);
    const selected = previous?.kind === 'record' ? model.getRecord(previous.index) : undefined;
    const column = fields.findIndex(field => field.id === model.fields[current.cell[0]]?.id);
    const candidates = new Map(snapshot.visibleRows);
    for (const page of snapshot.pages.values()) page.records.forEach((record, index) => candidates.set(page.offset + index, record));
    if (selected && column >= 0) for (const [index, record] of candidates) {
      if (record.id !== selected.id) continue;
      const row = nextGroups ? nextGroups.position(index) : index;
      if (row === undefined) continue;
      return { selection: { ...selection, current: { ...current, cell: [column, row],
        range: { x: column, y: row, width: 1, height: 1 } } }, cleared: false };
    }
  }
  return empty();
}
