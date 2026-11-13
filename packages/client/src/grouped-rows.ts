import type { Field, RecordSummary } from '../../contracts/src/index.js';

interface GroupRow {
  key: string;
  label: string;
  count: number;
  offset: number;
  start: number;
  collapsed: boolean;
}

export class GroupedRows {
  readonly groups: GroupRow[];
  readonly rowCount: number;

  constructor(field: Field, summary: RecordSummary, collapsed: ReadonlySet<string>) {
    const counts = new Map(summary.groups.map(group => [JSON.stringify(group.key), group.count]));
    const choices = field.type === 'singleSelect' ? field.options!.map(option => ({ value: option.id, label: option.name }))
      : [{ value: false, label: 'Unchecked' }, { value: true, label: 'Checked' }];
    let start = 0, offset = 0;
    this.groups = [...choices, { value: null, label: 'No value' }].map(choice => {
      const key = JSON.stringify(choice.value), count = counts.get(key) ?? 0;
      const group = { key, label: choice.label, count, offset, start, collapsed: collapsed.has(key) };
      start += 1 + (group.collapsed ? 0 : count);
      offset += count;
      return group;
    });
    this.rowCount = start;
  }

  at(row: number): { kind: 'group'; group: GroupRow } | { kind: 'record'; index: number } | undefined {
    if (row < 0 || row >= this.rowCount) return;
    let low = 0, high = this.groups.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.groups[middle]!.start <= row) low = middle;
      else high = middle - 1;
    }
    const group = this.groups[low]!;
    return row === group.start ? { kind: 'group', group } : { kind: 'record', index: group.offset + row - group.start - 1 };
  }

  count(start: number, length: number): number {
    return this.groups.reduce((count, group) => count + (group.collapsed ? 0
      : Math.max(0, Math.min(start + length, group.start + 1 + group.count) - Math.max(start, group.start + 1))), 0);
  }

  indices(start: number, length: number): number[] {
    return this.groups.flatMap(group => {
      if (group.collapsed) return [];
      const first = Math.max(start, group.start + 1), end = Math.min(start + length, group.start + 1 + group.count);
      return Array.from({ length: Math.max(0, end - first) }, (_, index) => group.offset + first - group.start - 1 + index);
    });
  }

  pasteIndices(start: number, count: number): number[] {
    if (this.at(start)?.kind !== 'record') throw new Error('Select a record cell before pasting. Group headings are not records.');
    const indices: number[] = [];
    for (const group of this.groups) {
      if (group.collapsed) continue;
      const first = Math.max(start, group.start + 1), end = group.start + 1 + group.count;
      for (let row = first; row < end && indices.length < count; row++) indices.push(group.offset + row - group.start - 1);
    }
    if (indices.length !== count) throw new Error('The pasted rows exceed the expanded groups. Expand more groups or select fewer rows.');
    return indices;
  }
}
