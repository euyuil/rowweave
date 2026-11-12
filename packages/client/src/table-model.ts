import {
  maxBatchCells, maxBatchRecords,
  type CellValue, type RecordPage, type RowRecord, type Table,
} from '../../contracts/src/index.js';
import { parseTextValue, validateValue } from '../../core/src/field-values.js';
import { ApiFailure, type TableApi } from './http-client.js';
import { sameValue } from './cell-values.js';

export interface CellEdit {
  row: number;
  fieldId: string;
  value: CellValue;
}

interface Draft {
  base: RowRecord;
  values: Record<string, CellValue>;
}

export class TableModel {
  table: Table | undefined;
  saving = false;
  error: string | undefined;
  conflicted = false;
  private revision = 0;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private readonly pages = new Map<number, RecordPage>();
  private readonly requests = new Map<number, Promise<RecordPage>>();
  private drafts = new Map<number, Draft>();

  constructor(private readonly api: TableApi, readonly pageSize = 100, readonly maxPages = 12) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500 ||
        !Number.isInteger(maxPages) || maxPages < 1) throw new Error('Invalid cache configuration.');
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.revision;

  private emit(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  get pendingCells(): number {
    return [...this.drafts.values()].reduce((total, draft) => total + Object.keys(draft.values).length, 0);
  }

  get cacheStats() {
    return { pages: this.pages.size, rows: [...this.pages.values()].reduce((n, page) => n + page.records.length, 0),
      inFlight: this.requests.size };
  }

  async initialize(): Promise<void> {
    this.table = await this.api.getTable();
    await this.readRange(0, Math.min(this.pageSize, this.table.total));
    this.emit();
  }

  getRecord(row: number): RowRecord | undefined {
    const draft = this.drafts.get(row);
    if (draft) return { ...draft.base, values: { ...draft.base.values, ...draft.values } };
    const page = this.pages.get(Math.floor(row / this.pageSize));
    return page?.records[row % this.pageSize];
  }

  private async loadPage(index: number): Promise<RecordPage> {
    const cached = this.pages.get(index);
    if (cached) {
      this.pages.delete(index);
      this.pages.set(index, cached);
      return cached;
    }
    const existing = this.requests.get(index);
    if (existing) {
      await existing;
      return this.loadPage(index);
    }
    if (this.requests.size >= 4) {
      await Promise.race([...this.requests.values()].map(request => request.catch(() => undefined)));
      return this.loadPage(index);
    }
    const generation = this.generation;
    const task = this.api.readPage(index * this.pageSize, this.pageSize).then(page => {
      if (generation === this.generation) {
        this.pages.set(index, page);
        while (this.pages.size > this.maxPages) {
          const oldest = this.pages.keys().next().value;
          if (oldest !== undefined) this.pages.delete(oldest);
        }
        this.emit();
      }
      return page;
    }).finally(() => {
      if (this.requests.get(index) === task) this.requests.delete(index);
    });
    this.requests.set(index, task);
    const page = await task;
    return generation === this.generation ? page : this.loadPage(index);
  }

  async readRange(start: number, count: number): Promise<RowRecord[]> {
    if (!this.table || !Number.isSafeInteger(start) || start < 0 ||
        !Number.isSafeInteger(count) || count < 0 || count > maxBatchRecords) {
      throw new Error('The requested range is invalid or too large.');
    }
    const end = Math.min(start + count, this.table.total);
    const rows: RowRecord[] = [];
    for (let offset = start; offset < end;) {
      const page = await this.loadPage(Math.floor(offset / this.pageSize));
      const pageEnd = Math.min(end, page.offset + page.records.length);
      if (pageEnd <= offset) throw new Error('The service returned an incomplete page.');
      for (; offset < pageEnd; offset++) {
        const record = page.records[offset - page.offset]!;
        const draft = this.drafts.get(offset);
        rows.push(draft ? { ...draft.base, values: { ...draft.base.values, ...draft.values } } : record);
      }
    }
    return rows;
  }

  applyEdits(edits: CellEdit[]): void {
    if (this.saving) throw new Error('Wait for the current save to finish.');
    if (!this.table) throw new Error('The table is still loading.');
    const fields = new Map(this.table.fields.map(field => [field.id, field]));
    const next = new Map(this.drafts);
    for (const edit of edits) {
      if (!Number.isSafeInteger(edit.row) || edit.row < 0 || edit.row >= this.table.total || !fields.has(edit.fieldId)) {
        throw new Error('One or more pasted values are invalid.');
      }
      const value = validateValue(fields.get(edit.fieldId)!, edit.value);
      const existing = next.get(edit.row);
      const base = existing?.base ?? this.getRecord(edit.row);
      if (!base) throw new Error('Load the selected rows before editing.');
      const values = { ...existing?.values, [edit.fieldId]: value };
      if (sameValue(value, base.values[edit.fieldId] ?? null)) delete values[edit.fieldId];
      if (Object.keys(values).length) next.set(edit.row, { base, values });
      else next.delete(edit.row);
    }
    const cellCount = [...next.values()].reduce((n, draft) => n + Object.keys(draft.values).length, 0);
    if (next.size > maxBatchRecords || cellCount > maxBatchCells) throw new Error('Save or discard existing edits before adding more.');
    this.drafts = next;
    this.emit();
  }

  async paste(startRow: number, startColumn: number, cells: readonly (readonly string[])[]): Promise<void> {
    if (!this.table || !Number.isSafeInteger(startRow) || startRow < 0 ||
        !Number.isSafeInteger(startColumn) || startColumn < 0 || !cells.length ||
        cells.length > maxBatchRecords || startRow + cells.length > this.table.total ||
        cells.some(row => startColumn + row.length > this.table!.fields.length) ||
        cells.reduce((n, row) => n + row.length, 0) > maxBatchCells) {
      throw new Error('The pasted rectangle exceeds the table or batch limits.');
    }
    // Keep the rows for this bounded operation even if their cache pages are evicted.
    const records = await this.readRange(startRow, cells.length);
    const originalDrafts = this.drafts;
    this.drafts = new Map(this.drafts);
    for (let i = 0; i < records.length; i++) {
      if (!this.drafts.has(startRow + i)) this.drafts.set(startRow + i, { base: records[i]!, values: {} });
    }
    try {
      this.applyEdits(cells.flatMap((row, y) => row.map((value, x) => ({
        row: startRow + y, fieldId: this.table!.fields[startColumn + x]!.id,
        value: parseTextValue(this.table!.fields[startColumn + x]!, value),
      }))));
      for (const [row, draft] of this.drafts) if (!Object.keys(draft.values).length) this.drafts.delete(row);
    } catch (error) {
      this.drafts = originalDrafts;
      throw error;
    }
  }

  async save(): Promise<void> {
    if (this.saving || !this.drafts.size) return;
    this.saving = true;
    this.error = undefined;
    this.conflicted = false;
    this.emit();
    try {
      const updates = [...this.drafts.values()].map(draft => ({
        id: draft.base.id, expectedVersion: draft.base.version, values: draft.values,
      }));
      const result = await this.api.save(updates);
      const saved = new Map(result.records.map(record => [record.id, record]));
      this.generation++;
      for (const page of this.pages.values()) {
        page.records = page.records.map(record => saved.get(record.id) ?? record);
      }
      this.drafts.clear();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Saving failed.';
      this.conflicted = error instanceof ApiFailure && error.code === 'VERSION_CONFLICT';
      throw error;
    } finally {
      this.saving = false;
      this.emit();
    }
  }

  async discardAndReload(): Promise<void> {
    if (this.saving) throw new Error('Wait for the current save to finish.');
    this.generation++;
    this.pages.clear();
    this.drafts.clear();
    this.error = undefined;
    this.conflicted = false;
    this.emit();
    await this.initialize();
  }
}
