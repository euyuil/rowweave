import type { GridSelection } from '@glideapps/glide-data-grid';
import type { RowRange } from '../../client/src/group-reader.js';

export function selectionRanges(selection: GridSelection, rowCount: number, includeColumns = false): RowRange[] {
  if (selection.rows.length) {
    const ranges: RowRange[] = [];
    for (const row of selection.rows) {
      const previous = ranges.at(-1);
      if (previous && previous.start + previous.count === row) previous.count++;
      else ranges.push({ start: row, count: 1 });
    }
    return ranges;
  }
  if (includeColumns && selection.columns.length) return [{ start: 0, count: rowCount }];
  const range = selection.current?.range;
  return range ? [{ start: range.y, count: range.height }] : [];
}
