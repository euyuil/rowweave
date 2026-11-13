import { maxPageSize, type GridView, type GroupCollapse, type GroupLayout, type GroupQuery, type Table, type Field } from '../../contracts/src/index.js';
import { ApiFailure, type WorkspaceApi } from './http-client.js';
import { GroupRows } from './group-rows.js';

export interface GroupContext {
  table: Table;
  view: GridView;
  revision: number;
  dateContext?: string;
  search: string;
  collapse: GroupCollapse;
}
export interface RowRange { start: number; count: number }
export interface ExpandedRange { start: number; count: number }

export class GroupReader {
  private readonly controller = new AbortController();
  private readonly windows = new Map<number, { layout: GroupLayout; rows: GroupRows }>();
  private queue: Promise<unknown> = Promise.resolve();
  private metadata: GroupLayout | undefined;
  readonly field: Field;
  constructor(private readonly api: Pick<WorkspaceApi, 'queryGroups'>, readonly context: GroupContext) {
    this.field = context.table.fields.find(field => field.id === context.view.groupBy)!;
  }
  dispose(): void { this.controller.abort(); this.windows.clear(); }
  get cachedWindows(): number { return this.windows.size; }

  private cached(start: number, count: number): { layout: GroupLayout; rows: GroupRows } | undefined {
    for (const [key, entry] of this.windows) {
      const first = entry.rows.groups[0], last = entry.rows.groups.at(-1);
      const end = last ? last.start + 1 + (last.collapsed ? 0 : last.count) : 0;
      if ((start >= entry.rows.rowCount && !first) || (first && start >= first.start && Math.min(start + count, entry.rows.rowCount) <= end)) {
        this.windows.delete(key); this.windows.set(key, entry); return entry;
      }
    }
  }

  private serialized<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, this.controller.signal]);
    const task = this.queue.then(async () => {
      combined.throwIfAborted();
      // A caller leaving the viewport must not release the queue while SQLite is still reading.
      const result = await operation(this.controller.signal);
      combined.throwIfAborted();
      return result;
    });
    // Each caller receives its own failure; a failed read must not poison the next queued read.
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async request(input: Pick<GroupQuery, 'offset' | 'limit' | 'window'>, signal: AbortSignal): Promise<GroupLayout> {
    const { table, view, revision, dateContext, search, collapse } = this.context;
    const result = await this.api.queryGroups(table.id, { viewId: view.id, expectedViewVersion: view.version,
      expectedRevision: revision, ...(dateContext ? { expectedDateContext: dateContext } : {}), search, collapse, ...input }, signal);
    signal.throwIfAborted();
    if (result.schemaVersion !== table.version) throw new ApiFailure('SCHEMA_CONFLICT', 'The table schema changed. Refresh to load current groups.', 409);
    this.metadata = result;
    return result;
  }

  private async display(start: number, count: number, signal: AbortSignal) {
    signal.throwIfAborted(); this.controller.signal.throwIfAborted();
    const cached = this.cached(start, count);
    if (cached) return cached;
    return this.serialized(signal, async active => {
      const previous = this.cached(start, count);
      if (previous) return previous;
      const offset = Math.floor(start / 100) * 100;
      const limit = Math.min(maxPageSize, Math.max(200, start - offset + count));
      const layout = await this.request({ offset, limit, window: 'displayRows' }, active);
      const entry = { layout, rows: new GroupRows(this.field, layout) };
      this.windows.set(offset, entry);
      while (this.windows.size > 12) this.windows.delete(this.windows.keys().next().value!);
      return entry;
    });
  }

  async readWindow(start: number, count: number, signal: AbortSignal): Promise<GroupRows> {
    const parts = [];
    for (let row = start; row < start + Math.max(1, count);) {
      const entry = await this.display(row, Math.min(400, start + Math.max(1, count) - row), signal);
      parts.push(entry);
      if (row >= entry.layout.totalRows) break;
      const last = entry.rows.groups.at(-1)!;
      row = last.start + 1 + (last.collapsed ? 0 : last.count);
    }
    signal.throwIfAborted();
    return parts.length === 1 ? parts[0]!.rows
      : new GroupRows(this.field, parts[0]!.layout, parts.flatMap(part => part.layout.groups));
  }

  private async before(row: number, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    if (row <= 0) return 0;
    if (this.metadata && row >= this.metadata.totalRows) return this.metadata.totalRows - this.metadata.totalGroups;
    return (await this.display(row, 1, signal)).rows.before(row)!;
  }

  async ranges(ranges: readonly RowRange[], signal: AbortSignal): Promise<ExpandedRange[]> {
    const result = [];
    for (const range of ranges) {
      const start = await this.before(range.start, signal), end = await this.before(range.start + range.count, signal);
      if (end > start) result.push({ start, count: end - start });
    }
    signal.throwIfAborted(); return result;
  }

  async indices(ranges: readonly ExpandedRange[], signal: AbortSignal): Promise<number[]> {
    const indices: number[] = [];
    for (const range of ranges) for (let offset = range.start; offset < range.start + range.count;) {
      const limit = Math.min(maxPageSize, range.start + range.count - offset);
      const page = await this.serialized(signal, active => this.request({ offset, limit, window: 'expandedRecords' }, active));
      indices.push(...page.groups.flatMap(group => Array.from({
        length: Math.min(offset + limit, group.expandedOffset + group.count) - Math.max(offset, group.expandedOffset),
      }, (_, index) => group.recordOffset + Math.max(0, offset - group.expandedOffset) + index)));
      offset += limit;
    }
    signal.throwIfAborted(); return indices;
  }

  async pasteIndices(row: number, count: number, signal: AbortSignal): Promise<number[]> {
    const entry = await this.display(row, 1, signal);
    if (entry.rows.at(row)?.kind !== 'record') throw new Error('Select a record cell before pasting. Group headings are not records.');
    const start = entry.rows.before(row)!;
    if (start + count > entry.rows.expandedCount) throw new Error('The pasted rows exceed the expanded groups. Expand more groups or select fewer rows.');
    return this.indices([{ start, count }], signal);
  }
}
