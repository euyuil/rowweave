import { valueField, type ScalarValue, type Field, type GroupLayout, type GroupSegment } from '../../contracts/src/index.js';
import { cellDisplay } from './cell-values.js';

export interface GroupRow {
  key: string;
  value: ScalarValue | ScalarValue[];
  label: string;
  ancestors: string[];
  count: number;
  offset: number;
  start: number;
  expandedOffset: number;
  collapsed: boolean;
  span: number;
  values?: Array<number | null>;
}

export class GroupRows {
  readonly groups: GroupRow[];
  readonly rowCount: number;
  readonly expandedCount: number;
  constructor(field: Field | readonly Field[], layout: GroupLayout, segments: readonly GroupSegment[] = layout.groups) {
    this.rowCount = layout.totalRows;
    this.expandedCount = layout.totalRows - layout.totalGroups;
    const fields = Array.isArray(field) ? field : [field as Field];
    const label = (value: ScalarValue, index: number) => value === null ? 'No value' : value === '' ? 'Empty text'
      : valueField(fields[index]!).type === 'checkbox' ? value ? 'Checked' : 'Unchecked' : cellDisplay(fields[index]!, value);
    this.groups = [...new Map(segments.map(group => [group.rowStart, group])).values()].sort((a, b) => a.rowStart - b.rowStart).map(group => ({
      key: JSON.stringify(group.path ?? group.key), value: group.path ?? group.key, count: group.count, offset: group.recordOffset,
      start: group.rowStart, expandedOffset: group.expandedOffset, collapsed: group.collapsed,
      span: 1 + (group.leaf !== false && !group.collapsed ? group.count : 0),
      ...(group.values ? { values: group.values } : {}),
      label: label(group.key, (group.path?.length ?? 1) - 1),
      ancestors: group.path?.slice(0, -1).map(label) ?? [],
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
    return row >= group.start && row < group.start + group.span ? group : undefined;
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
    const group = this.groups.find(group => group.span > 1 && index >= group.offset && index < group.offset + group.count);
    return group ? group.start + 1 + index - group.offset : undefined;
  }
  indices(start: number, length: number): number[] {
    return this.groups.flatMap(group => {
      const first = Math.max(start, group.start + 1), end = Math.min(start + length, group.start + group.span);
      return Array.from({ length: Math.max(0, end - first) }, (_, index) => group.offset + first - group.start - 1 + index);
    });
  }
}
