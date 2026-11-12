import {
  maxBatchCells, maxBatchRecords,
  type CellValue, type Field, type QueryPage, type RecordLink, type RowRecord, type Table,
} from '../../contracts/src/index.js';
import { parseTextValue, validateValue } from '../../core/src/field-values.js';
import { ApiFailure, type TableApi, type TableQuery } from './http-client.js';
import { sameValue } from './cell-values.js';

export interface CellEdit {
  row: number;
  fieldId: string;
  value: CellValue;
  links?: RecordLink[];
}

interface Draft {
  base: RowRecord;
  values: Record<string, CellValue>;
}

interface EditState {
  drafts: Map<string, Draft>;
  rows: Map<number, string>;
}

interface HistoryEntry {
  before: EditState;
  after: EditState;
  cells: number;
}

export class TableModel {
  table: Table | undefined;
  rowCount = 0;
  saving = false;
  stale = false;
  error: string | undefined;
  conflicted = false;
  private revision = 0;
  private generation = 0;
  private disposed = false;
  private queryRevision: number | undefined;
  private query: TableQuery = {};
  private visibleFields: Field[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly pages = new Map<number, QueryPage>();
  private readonly requests = new Map<number, { promise: Promise<QueryPage>; controller: AbortController }>();
  private edits: EditState = { drafts: new Map(), rows: new Map() };
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(private readonly api: TableApi, readonly pageSize = 100, readonly maxPages = 12) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500 ||
        !Number.isInteger(maxPages) || maxPages < 1) throw new Error('Invalid cache configuration.');
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.revision;
  get queryVersion(): number { return this.generation; }
  get canUndo(): boolean { return !this.saving && this.undoStack.length > 0; }
  get canRedo(): boolean { return !this.saving && this.redoStack.length > 0; }
  get fields(): Field[] { return this.visibleFields; }

  private updateFields(): void {
    const fields = new Map(this.table?.fields.map(field => [field.id, field]));
    this.visibleFields = this.query.fields
      ? this.query.fields.flatMap(id => fields.has(id) ? [fields.get(id)!] : []) : this.table?.fields ?? [];
  }

  private emit(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  get pendingCells(): number {
    return [...this.edits.drafts.values()].reduce((total, draft) => total + Object.keys(draft.values).length, 0);
  }

  get pendingRecords(): RowRecord[] {
    return [...this.edits.drafts.values()].map(draft => ({ ...draft.base, values: { ...draft.base.values, ...draft.values } }));
  }

  get cacheStats() {
    return { pages: this.pages.size, rows: [...this.pages.values()].reduce((n, page) => n + page.records.length, 0),
      inFlight: this.requests.size, historyCells: this.undoStack.reduce((n, entry) => n + entry.cells, 0) };
  }

  async initialize(): Promise<void> {
    this.table = await this.api.getTable();
    this.updateFields();
    await this.loadPage(0);
    this.emit();
  }

  private overlay(record: RowRecord): RowRecord {
    const draft = this.edits.drafts.get(record.id);
    if (!draft) return record;
    const links = { ...draft.base.links };
    for (const [fieldId, current] of Object.entries(record.links ?? {})) {
      links[fieldId] = [...new Map([...(links[fieldId] ?? []), ...current].map(link => [link.id, link])).values()];
    }
    return { ...draft.base, ...(Object.keys(links).length ? { links } : {}),
      values: { ...record.values, ...draft.base.values, ...draft.values } };
  }

  getRecord(row: number): RowRecord | undefined {
    const page = this.pages.get(Math.floor(row / this.pageSize));
    const record = page?.records[row % this.pageSize];
    if (record) return this.overlay(record);
    const id = this.edits.rows.get(row);
    const draft = id ? this.edits.drafts.get(id) : undefined;
    return draft ? this.overlay(draft.base) : undefined;
  }

  private async loadPage(index: number): Promise<QueryPage> {
    if (this.disposed) throw new Error('This table was closed.');
    if (index > 0 && this.queryRevision === undefined) await this.loadPage(0);
    const cached = this.pages.get(index);
    if (cached) {
      this.pages.delete(index);
      this.pages.set(index, cached);
      return cached;
    }
    const existing = this.requests.get(index);
    if (existing) return existing.promise;
    if (this.requests.size >= 4) {
      await Promise.race([...this.requests.values()].map(request => request.promise.catch(() => undefined)));
      return this.loadPage(index);
    }
    const generation = this.generation;
    const controller = new AbortController();
    const task = this.api.readPage(index * this.pageSize, this.pageSize, {
      ...this.query, ...(this.queryRevision === undefined ? {} : { expectedRevision: this.queryRevision }),
    }, controller.signal).then(page => {
      if (generation !== this.generation) return this.loadPage(index);
      if (page.schemaVersion !== this.table!.version) {
        throw new ApiFailure('SCHEMA_CONFLICT', 'The table schema changed. Reload before editing.', 409);
      }
      this.queryRevision = page.revision;
      this.rowCount = page.total;
      this.pages.set(index, page);
      while (this.pages.size > this.maxPages) this.pages.delete(this.pages.keys().next().value!);
      const rows = new Map(this.edits.rows);
      for (const [offset, record] of page.records.entries()) {
        const draft = this.edits.drafts.get(record.id);
        if (draft) {
          rows.set(page.offset + offset, record.id);
          if (draft.base.version !== record.version) this.conflicted = true;
        }
      }
      this.edits = { ...this.edits, rows };
      this.emit();
      return page;
    }).catch(error => {
      if (generation !== this.generation && !this.disposed) return this.loadPage(index);
      if (error instanceof ApiFailure && ['DATA_CHANGED', 'SCHEMA_CONFLICT', 'VIEW_CONFLICT'].includes(error.code)) {
        this.stale = true;
        this.error = 'The table changed. Refresh to load current rows; your drafts are retained.';
        this.emit();
      }
      throw error;
    }).finally(() => {
      if (this.requests.get(index)?.promise === task) this.requests.delete(index);
    });
    this.requests.set(index, { promise: task, controller });
    return task;
  }

  async readRange(start: number, count: number): Promise<RowRecord[]> {
    if (!this.table || !Number.isSafeInteger(start) || start < 0 ||
        !Number.isSafeInteger(count) || count < 0 || count > maxBatchRecords) {
      throw new Error('The requested range is invalid or too large.');
    }
    const generation = this.generation;
    const rows: RowRecord[] = [];
    for (let offset = start; offset < Math.min(start + count, this.rowCount);) {
      const page = await this.loadPage(Math.floor(offset / this.pageSize));
      if (generation !== this.generation) return this.readRange(start, count);
      const end = Math.min(start + count, this.rowCount, page.offset + page.records.length);
      if (offset >= this.rowCount) break;
      if (end <= offset) throw new Error('The service returned an incomplete page.');
      for (; offset < end; offset++) rows.push(this.overlay(page.records[offset - page.offset]!));
    }
    return rows;
  }

  private stage(edits: CellEdit[], loaded = new Map<number, RowRecord>()): void {
    if (this.saving) throw new Error('Wait for the current save to finish.');
    if (this.stale) throw new Error('Refresh the table before editing more cells.');
    if (!this.table) throw new Error('The table is still loading.');
    const fields = new Map(this.table.fields.map(field => [field.id, field]));
    const before = this.edits;
    const drafts = new Map(before.drafts);
    const rows = new Map(before.rows);
    let changedCells = 0;
    for (const edit of edits) {
      if (!Number.isSafeInteger(edit.row) || edit.row < 0 || edit.row >= this.rowCount || !fields.has(edit.fieldId)) {
        throw new Error('One or more pasted values are invalid.');
      }
      const value = validateValue(fields.get(edit.fieldId)!, edit.value);
      const record = loaded.get(edit.row) ?? this.getRecord(edit.row);
      if (!record) throw new Error('Load the selected rows before editing.');
      const existing = drafts.get(record.id);
      const original = existing?.base ?? before.drafts.get(record.id)?.base;
      const base = original ? { ...original, values: { ...record.values, ...original.values } } : record;
      const labeled = edit.links ? { ...base, links: { ...base.links, [edit.fieldId]: edit.links } } : base;
      const current = existing && Object.hasOwn(existing.values, edit.fieldId) ? existing.values[edit.fieldId]! : base.values[edit.fieldId] ?? null;
      if (sameValue(value, current)) continue;
      changedCells++;
      const values = { ...existing?.values, [edit.fieldId]: value };
      if (sameValue(value, base.values[edit.fieldId] ?? null)) delete values[edit.fieldId];
      if (Object.keys(values).length) {
        drafts.set(record.id, { base: labeled, values });
        rows.set(edit.row, record.id);
      } else {
        drafts.delete(record.id);
        rows.delete(edit.row);
      }
    }
    const cells = [...drafts.values()].reduce((n, draft) => n + Object.keys(draft.values).length, 0);
    if (drafts.size > maxBatchRecords || cells > maxBatchCells) throw new Error('Save or discard existing edits before adding more.');
    this.edits = { drafts, rows };
    if (changedCells) {
      this.undoStack.push({ before, after: this.edits, cells: changedCells });
      this.redoStack = [];
      while (this.undoStack.length > 100 || this.cacheStats.historyCells > maxBatchCells * 3) this.undoStack.shift();
    }
    this.emit();
  }

  applyEdits(edits: CellEdit[]): void { this.stage(edits); }

  undo(): void {
    if (!this.canUndo) return;
    const entry = this.undoStack.pop()!;
    this.edits = entry.before;
    this.redoStack.push(entry);
    this.emit();
  }

  redo(): void {
    if (!this.canRedo) return;
    const entry = this.redoStack.pop()!;
    this.edits = entry.after;
    this.undoStack.push(entry);
    this.emit();
  }

  async paste(startRow: number, startColumn: number, cells: readonly (readonly string[])[]): Promise<void> {
    const fields = this.fields;
    if (!this.table || !Number.isSafeInteger(startRow) || startRow < 0 ||
        !Number.isSafeInteger(startColumn) || startColumn < 0 || !cells.length ||
        cells.length > maxBatchRecords || startRow + cells.length > this.rowCount ||
        cells.some(row => startColumn + row.length > fields.length) ||
        cells.reduce((n, row) => n + row.length, 0) > maxBatchCells) {
      throw new Error('The pasted rectangle exceeds the table or batch limits.');
    }
    const generation = this.generation;
    const records = await this.readRange(startRow, cells.length);
    if (generation !== this.generation) throw new Error('The query changed before paste completed. Paste again into the current view.');
    this.stage(cells.flatMap((row, y) => row.map((value, x) => ({
      row: startRow + y, fieldId: fields[startColumn + x]!.id,
      value: parseTextValue(fields[startColumn + x]!, value),
    }))), new Map(records.map((record, index) => [startRow + index, record])));
  }

  async clearCells(rows: readonly number[], fieldIds: readonly string[]): Promise<void> {
    if (!rows.length || !fieldIds.length) return;
    if (rows.length > maxBatchRecords || rows.length * fieldIds.length > maxBatchCells) {
      throw new Error('Clear up to 20,000 cells and 2,000 rows at a time.');
    }
    const generation = this.generation;
    const values = fieldIds.map(id => {
      const field = this.fields.find(field => field.id === id)!;
      return { fieldId: id, value: parseTextValue(field, '') };
    });
    const loaded = new Map<number, RowRecord>();
    for (let index = 0; index < rows.length;) {
      const start = rows[index]!;
      let count = 1;
      while (rows[index + count] === start + count) count++;
      const records = await this.readRange(start, count);
      records.forEach((record, offset) => loaded.set(start + offset, record));
      index += count;
    }
    if (generation !== this.generation) throw new Error('The query changed before clearing completed. Select the cells again.');
    this.stage(rows.flatMap(row => values.map(value => ({ row, ...value }))), loaded);
  }

  private resetPages(): void {
    this.generation++;
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear();
    this.pages.clear();
    this.queryRevision = undefined;
    this.edits = { ...this.edits, rows: new Map() };
    this.stale = false;
    this.undoStack = [];
    this.redoStack = [];
  }

  async setQuery(query: Omit<TableQuery, 'offset' | 'limit' | 'expectedRevision'>): Promise<void> {
    if (this.saving) throw new Error('Wait for the current save to finish.');
    this.query = query;
    this.updateFields();
    this.resetPages();
    this.rowCount = 0;
    this.error = undefined;
    await this.loadPage(0);
  }

  async refresh(query?: TableQuery): Promise<void> {
    if (this.saving) throw new Error('Wait for the current save to finish.');
    if (query) this.query = query;
    this.resetPages();
    this.error = undefined;
    this.conflicted = false;
    await this.initialize();
  }

  async save(): Promise<void> {
    if (this.saving || !this.edits.drafts.size) return;
    this.saving = true;
    this.error = undefined;
    this.conflicted = false;
    this.emit();
    try {
      try {
        await this.api.save([...this.edits.drafts.values()].map(draft => ({
          id: draft.base.id, expectedVersion: draft.base.version, values: draft.values,
        })));
      } catch (error) {
        this.error = error instanceof Error ? error.message : 'Saving failed.';
        this.conflicted = error instanceof ApiFailure && error.code === 'VERSION_CONFLICT';
        throw error;
      }
      this.edits = { drafts: new Map(), rows: new Map() };
      this.resetPages();
      try { await this.initialize(); }
      catch (error) { this.error = `Changes saved, but refreshing failed: ${error instanceof Error ? error.message : 'connection unavailable'}.`; }
    } finally {
      this.saving = false;
      this.emit();
    }
  }

  async discardAndReload(query?: TableQuery): Promise<void> {
    if (this.saving) throw new Error('Wait for the current save to finish.');
    this.edits = { drafts: new Map(), rows: new Map() };
    await this.refresh(query);
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear();
    this.listeners.clear();
  }
}
