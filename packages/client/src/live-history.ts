import type { BatchResult, CellValue, RecordUpdate, RowRecord, Table } from '../../contracts/src/index.js';

type Values = Record<string, CellValue>;
interface Change { record: RowRecord; values: Values; expectedFieldVersions?: Record<string, number> }
interface Entry { schemaVersion: number; updates: RecordUpdate[]; cells: number; restoredVersions: Record<string, Record<string, number>> }

// Only this session's explicit edits enter these stacks. Durable receipts remain in SQLite.
export class LiveHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private listeners = new Set<() => void>();
  private revision = 0;
  busy = false;
  constructor(private readonly write: (updates: RecordUpdate[]) => Promise<BatchResult>) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.revision;
  get hasUndo(): boolean { return this.past.length > 0; }
  get hasRedo(): boolean { return this.future.length > 0; }
  get canUndo(): boolean { return !this.busy && this.hasUndo; }
  get canRedo(): boolean { return !this.busy && this.hasRedo; }
  private emit(): void { this.revision++; for (const listener of this.listeners) listener(); }
  private inverse(schemaVersion: number, updates: RecordUpdate[], result: BatchResult): Entry {
    const records = new Map(result.records.map(record => [record.id, record]));
    return { schemaVersion, restoredVersions: result.previousFieldVersions!, cells: updates.reduce((sum, update) => sum + Object.keys(update.values).length, 0),
      updates: updates.map(update => ({ id: update.id, expectedVersion: records.get(update.id)!.version,
        expectedSchemaVersion: schemaVersion, values: update.expectedValues!,
        expectedFieldVersions: Object.fromEntries(Object.keys(update.values).map(id => [id, records.get(update.id)!.version])),
        expectedValues: Object.fromEntries(Object.keys(update.values).map(id => [id, records.get(update.id)!.values[id] ?? null])) })) };
  }
  async commit(table: Table, changes: Change[]): Promise<BatchResult> {
    if (this.busy) throw new Error('Wait for the current change to finish.');
    const updates = changes.flatMap(({ record, values, expectedFieldVersions }) => {
      const entries = Object.entries(values).filter(([id, value]) => JSON.stringify(value) !== JSON.stringify(record.values[id] ?? null));
      if (!entries.length) return [];
      return [{ id: record.id, expectedVersion: record.version, expectedSchemaVersion: table.version, values: Object.fromEntries(entries),
        ...(expectedFieldVersions ? { expectedFieldVersions: Object.fromEntries(entries.map(([id]) => [id, expectedFieldVersions[id]!])) } : {}),
        expectedValues: Object.fromEntries(entries.map(([id]) => [id, record.values[id] ?? null])) }];
    });
    if (!updates.length) return { records: changes.map(change => change.record) };
    this.busy = true; this.emit();
    try {
      const result = await this.write(updates);
      this.past.push(this.inverse(table.version, updates, result));
      this.future = [];
      while (this.past.length > 100 || this.past.reduce((sum, entry) => sum + entry.cells, 0) > 60_000) this.past.shift();
      return result;
    } finally { this.busy = false; this.emit(); }
  }
  async move(redo = false): Promise<(BatchResult & { updates: RecordUpdate[] }) | undefined> {
    if (this.busy) return;
    const source = redo ? this.future : this.past, target = redo ? this.past : this.future;
    const entry = source.at(-1);
    if (!entry) return;
    this.busy = true; this.emit();
    try {
      const result = await this.write(entry.updates);
      source.pop(); target.push(this.inverse(entry.schemaVersion, entry.updates, result));
      // Rebase only a proven chain of our own writes. Equal values alone would hide an
      // external change-and-change-back that occurred before a later local edit.
      for (const stack of [this.past, this.future]) for (const earlier of stack) for (const update of earlier.updates) {
        const applied = entry.updates.find(item => item.id === update.id);
        const record = result.records.find(item => item.id === update.id);
        if (!applied || !record) continue;
        for (const field of Object.keys(applied.values)) {
          if (Object.hasOwn(update.values, field) && update.expectedFieldVersions![field] === entry.restoredVersions[update.id]![field] &&
              JSON.stringify(update.expectedValues![field]) === JSON.stringify(record.values[field] ?? null)) {
            update.expectedFieldVersions![field] = record.version;
          }
        }
      }
      return { ...result, updates: entry.updates };
    } finally { this.busy = false; this.emit(); }
  }
}
