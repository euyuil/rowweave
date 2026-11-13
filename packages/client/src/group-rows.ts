import { valueField, type ScalarValue, type Field, type GroupLayout, type GroupSegment } from '../../contracts/src/index.js';
import { cellDisplay } from './cell-values.js';

export interface GroupRow {
  key: string;
  value: ScalarValue;
  label: string;
  count: number;
  offset: number;
  start: number;
  expandedOffset: number;
  collapsed: boolean;
}

export class GroupRows {
  readonly groups: GroupRow[];
  readonly rowCount: number;
  readonly expandedCount: number;
  constructor(field: Field, layout: GroupLayout, segments: readonly GroupSegment[] = layout.groups) {
    this.rowCount = layout.totalRows;
    this.expandedCount = layout.totalRows - layout.totalGroups;
    const selected = valueField(field);
    this.groups = [...new Map(segments.map(group => [group.rowStart, group])).values()].sort((a, b) => a.rowStart - b.rowStart).map(group => ({
      key: JSON.stringify(group.key), value: group.key, count: group.count, offset: group.recordOffset,
      start: group.rowStart, expandedOffset: group.expandedOffset, collapsed: group.collapsed,
      label: group.key === null ? 'No value' : group.key === '' ? 'Empty text' : selected.type === 'checkbox'
        ? group.key ? 'Checked' : 'Unchecked' : cellDisplay(field, group.key),
    }));
  }
  private groupAt(row: number): GroupRow | undefined {
    if (row < 0 || row >= this.rowCount || !this.groups.length) return;
    let low = 0, high = this.groups.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.groups[middle]!.start <= row) low = middle; else high = middle - 1;
    }
    const group = this.groups[low]!;
    return row >= group.start && row < group.start + 1 + (group.collapsed ? 0 : group.count) ? group : undefined;
  }
  at(row: number): { kind: 'group'; group: GroupRow } | { kind: 'record'; index: number } | undefined {
    const group = this.groupAt(row);
    if (!group) return;
    return row === group.start ? { kind: 'group', group } : { kind: 'record', index: group.offset + row - group.start - 1 };
  }
  before(row: number): number | undefined {
    if (row <= 0) return 0;
    if (row >= this.rowCount) return this.expandedCount;
    const group = this.groupAt(row);
    return group ? group.expandedOffset + Math.max(0, row - group.start - 1) : undefined;
  }
  count(start: number, length: number): number | undefined {
    const first = this.before(start), last = this.before(start + length);
    return first === undefined || last === undefined ? undefined : last - first;
  }
  position(index: number): number | undefined {
    const group = this.groups.find(group => !group.collapsed && index >= group.offset && index < group.offset + group.count);
    return group ? group.start + 1 + index - group.offset : undefined;
  }
  indices(start: number, length: number): number[] {
    return this.groups.flatMap(group => {
      if (group.collapsed) return [];
      const first = Math.max(start, group.start + 1), end = Math.min(start + length, group.start + 1 + group.count);
      return Array.from({ length: Math.max(0, end - first) }, (_, index) => group.offset + first - group.start - 1 + index);
    });
  }
}
