import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { summarize } from './record-summary.js';
import type { CheckedSummary } from '../../core/src/record-summary.js';
import type { RecordSummary, RecordHistoryQuery, RecordHistoryPage, RecordChangeDetail, RecordRestore, RecordTrashPage } from '../../contracts/src/index.js';
import { RecordHistory } from './record-history.js';
import { tableId, type BatchResult, type CellValue, type ConversionPreview, type DeleteResult, type Field, type GridView, type QueryPage, type RecordDelete, type RecordPage, type RecordUpdate, type RowRecord, type Table } from '../../contracts/src/index.js';
import { ServiceError, type RecordStore } from '../../core/src/record-service.js';
import type { CheckedQuery } from '../../core/src/record-query.js';
import { defaultView, groupedViewQuery, reconcileView } from '../../core/src/grid-views.js';
import { migrate } from './migrations.js';
import { querySql } from './query-sql.js';
import { queryPage, type StoredRecord } from './query-page.js';
import { syncQueryIndexes } from './query-indexes.js';
import { Relations } from './relations.js';
import { Lookups } from './lookups.js';
import { maxCsvBytes, maxCsvCells, maxCsvRows, type CsvPreview } from '../../contracts/src/index.js';
import { csvCell, csvLimit, csvRecord, csvRecordValues, type CheckedCsvImport } from '../../core/src/csv.js';
import { compileFormulas } from '../../core/src/formulas.js';
import { ConnectedCalculations, type ChangedRecords } from './connected-calculations.js';
import { relativeDateRanges } from './relative-date-ranges.js';

export interface SeedOptions {
  rows: number;
  columns: number;
}

interface StoredTable {
  id: string;
  name: string;
  version: number;
  primary_field_id: string;
  revision: number;
  fields_json: string;
  total: number;
}

interface StoredView {
  id: string;
  table_id: string;
  name: string;
  version: number;
  config_json: string;
}

const selectTables = `SELECT t.*,
  (SELECT json_group_array(json(definition_json)) FROM
    (SELECT definition_json FROM fields WHERE table_id = t.id ORDER BY position)) AS fields_json,
  (SELECT COUNT(*) FROM records WHERE table_id = t.id) AS total FROM tables t`;

export class SqliteRecordStore implements RecordStore {
  private readonly db: DatabaseSync;
  private readonly relations: Relations;
  private readonly lookups: Lookups;
  private readonly history: RecordHistory;

  constructor(path: string, seed: SeedOptions | null = null, private readonly clock: () => Date = () => new Date()) {
    if (seed && (!Number.isSafeInteger(seed.rows) || seed.rows < 1 || seed.rows > 100_000 ||
        !Number.isSafeInteger(seed.columns) || seed.columns < 1 || seed.columns > 100)) {
      throw new Error('Seed size must be 1–100,000 rows and 1–100 columns.');
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.relations = new Relations(this.db);
    this.lookups = new Lookups(this.db);
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      const fresh = migrate(this.db);
      this.history = new RecordHistory(this.db);
      if (fresh && seed) this.seed(seed);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(operation: () => T, mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE', restore?: RecordRestore): T {
    this.db.exec(`BEGIN ${mode}`);
    try {
      if (mode === 'IMMEDIATE') this.history.begin(this.clock().toISOString(), restore);
      const result = operation();
      if (mode === 'IMMEDIATE') this.history.end();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private insertFields(table: Table): void {
    const write = this.db.prepare(`INSERT INTO fields VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET position = excluded.position, definition_json = excluded.definition_json`);
    for (const [position, field] of table.fields.entries()) {
      const { lookupResult: _result, ...stored } = field;
      write.run(field.id, table.id, position, JSON.stringify(stored));
    }
  }

  private seed(options: SeedOptions): void {
    const fields: Field[] = Array.from({ length: options.columns }, (_, i) => ({
      id: `field_${i + 1}`, name: `Field ${i + 1}`, type: 'text',
    }));
    this.transaction(() => {
      const table: Table = { id: tableId, name: 'Prototype workspace', version: 1, revision: 1,
        primaryFieldId: fields[0]!.id, fields, total: options.rows };
      this.db.prepare('INSERT INTO tables (id, name, version, primary_field_id) VALUES (?, ?, 1, ?)').run(table.id, table.name, table.primaryFieldId);
      this.insertFields(table);
      this.writeView(defaultView(table));
      const insert = this.db.prepare('INSERT INTO records (id, table_id, position, values_json) VALUES (?, ?, ?, ?)');
      for (let row = 0; row < options.rows; row++) {
        const values = Object.fromEntries(fields.map((field, col) => {
          const cell = row * options.columns + col;
          const value = cell % 29 === 0 ? null
            : cell % 31 === 0 ? 'Long text '.repeat(40)
            : cell % 11 === 0 ? `中文示例 🌱 ${row + 1}`
            : `Row ${row + 1} · ${col + 1}`;
          return [field.id, value];
        }));
        insert.run(`record_${row + 1}`, tableId, row, JSON.stringify(values));
      }
    });
  }

  private decodeTable(row: StoredTable): Table {
    return this.lookups.resolve({ id: row.id, name: row.name, version: row.version, revision: row.revision, primaryFieldId: row.primary_field_id,
      fields: JSON.parse(row.fields_json) as Field[], total: row.total });
  }

  listTables(): Table[] {
    const rows = this.db.prepare(`${selectTables} ORDER BY t.rowid`).all() as unknown as StoredTable[];
    return rows.map(row => this.decodeTable(row));
  }

  getTable(id = tableId): Table {
    const row = this.db.prepare(`${selectTables} WHERE t.id = ?`).get(id) as unknown as StoredTable | undefined;
    if (!row) throw new ServiceError('TABLE_NOT_FOUND', 'This table does not exist.', 404);
    return this.decodeTable(row);
  }

  createTable(table: Table): Table {
    return this.transaction(() => {
      this.db.prepare('INSERT INTO tables (id, name, version, primary_field_id) VALUES (?, ?, 1, ?)').run(table.id, table.name, table.primaryFieldId);
      this.insertFields(table);
      this.writeView(defaultView(table));
      return this.getTable(table.id);
    });
  }

  private checkSchema(id: string, version: number): void {
    const row = this.db.prepare('SELECT version FROM tables WHERE id = ?').get(id);
    if (!row) throw new ServiceError('TABLE_NOT_FOUND', 'This table does not exist.', 404);
    if (row['version'] !== version) {
      throw new ServiceError('SCHEMA_CONFLICT', 'The table schema changed. Reload it before trying again.', 409);
    }
  }

  updateSchema(table: Table, expectedVersion: number, validateRecord?: (record: RowRecord) => void): Table {
    return this.transaction(() => this.writeSchema(table, expectedVersion, validateRecord));
  }

  createReciprocalFields(table: Table, target: Table, validateRecord?: (record: RowRecord) => void): Table {
    return this.transaction(() => {
      this.checkSchema(table.id, table.version);
      this.checkSchema(target.id, target.version);
      this.writeSchema(table, table.version, validateRecord, false);
      if (target.id !== table.id) this.writeSchema(target, target.version, undefined, false);
      this.syncLookupViews(this.getTable(table.id), true);
      if (target.id !== table.id) this.syncLookupViews(this.getTable(target.id), true);
      return this.getTable(table.id);
    });
  }

  private writeSchema(table: Table, expectedVersion: number, validateRecord?: (record: RowRecord) => void, syncDependents = true): Table {
    this.checkSchema(table.id, expectedVersion);
    if (table.version !== expectedVersion) {
      throw new ServiceError('SCHEMA_CONFLICT', 'The table schema changed. Reload it before trying again.', 409);
    }
    const before = this.getTable(table.id);
    this.relations.validateSchema(table, before);
    this.lookups.validateSchema(table, before);
    const calculate = compileFormulas(table, { skipLinked: true });
    const calculations = new ConnectedCalculations(this.db, table);
    const versioned = new Set<string>();
    if (validateRecord) {
      for (const row of this.db.prepare('SELECT id, version, values_json, formula_errors_json FROM records WHERE table_id = ?').iterate(table.id)) {
        validateRecord(this.decode(row as unknown as StoredRecord));
      }
    }
    const detached = this.relations.detachFields(table, before);
    for (const field of before.fields) {
      if (table.fields.some(next => next.id === field.id)) continue;
      this.db.prepare('DELETE FROM fields WHERE id = ? AND table_id = ?').run(field.id, table.id);
      this.db.prepare(`UPDATE records SET values_json = json_remove(values_json, ?), version = version + 1
        WHERE table_id = ? AND json_type(values_json, ?) IS NOT NULL`)
        .run(`$."${field.id}"`, table.id, `$."${field.id}"`);
    }
    this.insertFields(table);
    if (JSON.stringify(before.fields.filter(field => field.type === 'formula')) !== JSON.stringify(table.fields.filter(field => field.type === 'formula'))) {
      for (const id of this.recalculate(table, calculate)) versioned.add(id);
    }
    this.relations.syncFields(table);
    this.lookups.sync(table);
    this.syncViews(table);
    this.db.prepare('UPDATE tables SET name = ?, primary_field_id = ?, version = version + 1 WHERE id = ?')
      .run(table.name, table.primaryFieldId, table.id);
    this.relations.bumpRevisions([table.id, ...detached, ...this.recalculateConnectedTable(table.id, calculations, versioned)]);
    if (syncDependents) this.syncLookupViews(table, true);
    return this.getTable(table.id);
  }

  deleteTable(id: string, expectedVersion: number): void {
    this.transaction(() => {
      this.checkSchema(id, expectedVersion);
      this.lookups.deleteTable(id);
      this.relations.deleteTable(id);
      syncQueryIndexes(this.db, { id, fields: [] }, []);
      this.db.prepare('DELETE FROM tables WHERE id = ?').run(id);
    });
  }

  private scanConversion(table: Table, field: Field, convert: (value: CellValue) => CellValue, apply: boolean, versioned?: Set<string>): ConversionPreview {
    const preview: ConversionPreview = { tableId: table.id, fieldId: field.id, field, schemaVersion: table.version,
      total: 0, changed: 0, invalid: 0, samples: [], issues: [] };
    const update = this.db.prepare('UPDATE records SET values_json = ?, version = version + 1 WHERE id = ?');
    const rows = this.db.prepare('SELECT id, version, values_json, formula_errors_json FROM records WHERE table_id = ? ORDER BY position');
    for (const stored of rows.iterate(table.id)) {
      const record = this.decode(stored as unknown as StoredRecord);
      const before = record.values[field.id] ?? null;
      preview.total++;
      let after: CellValue;
      try { after = convert(before); }
      catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        preview.invalid++;
        if (preview.issues.length < 20) preview.issues.push({ recordId: record.id, message: error.message });
        continue;
      }
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      preview.changed++;
      if (preview.samples.length < 10) preview.samples.push({ recordId: record.id, before, after });
      if (apply) { update.run(JSON.stringify({ ...record.values, [field.id]: after }), record.id); versioned?.add(record.id); }
    }
    return preview;
  }

  previewConversion(id: string, version: number, field: Field, convert: (value: CellValue) => CellValue): ConversionPreview {
    return this.transaction(() => {
      this.checkSchema(id, version);
      const table = this.getTable(id);
      const next = { ...table, fields: table.fields.map(previous => previous.id === field.id ? field : previous) };
      this.lookups.validateSchema(next, table);
      compileFormulas(next);
      new ConnectedCalculations(this.db, next);
      for (const view of this.listViews(id)) reconcileView(view, next);
      this.syncLookupViews(next, false);
      return this.scanConversion(table, field, convert, false);
    }, 'DEFERRED');
  }

  applyConversion(id: string, version: number, field: Field, convert: (value: CellValue) => CellValue): Table {
    return this.transaction(() => {
      this.checkSchema(id, version);
      const table = this.getTable(id);
      const next = { ...table, fields: table.fields.map(previous => previous.id === field.id ? field : previous) };
      this.lookups.validateSchema(next, table);
      const calculate = compileFormulas(next, { skipLinked: true });
      const calculations = new ConnectedCalculations(this.db, next);
      const versioned = new Set<string>();
      this.syncViews(next);
      const result = this.scanConversion(table, field, convert, true, versioned);
      if (result.invalid) {
        throw new ServiceError('CONVERSION_FAILED', `${result.invalid} records could not be converted. Record ${result.issues[0]!.recordId}: ${result.issues[0]!.message}`);
      }
      this.db.prepare('UPDATE fields SET definition_json = ? WHERE id = ? AND table_id = ?')
        .run(JSON.stringify(field), field.id, id);
      for (const id of this.recalculate(next, calculate)) versioned.add(id);
      this.db.prepare('UPDATE tables SET version = version + 1 WHERE id = ?').run(id);
      this.relations.bumpRevisions([id, ...this.recalculateConnectedTable(id, calculations, versioned)]);
      this.syncLookupViews(next, true);
      return this.getTable(id);
    });
  }

  readPage(offset: number, limit: number, id = tableId): RecordPage {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT id, version, values_json, formula_errors_json FROM records WHERE table_id = ?
        ORDER BY position LIMIT ? OFFSET ?`).all(id, limit, offset) as unknown as StoredRecord[];
      const table = this.getTable(id);
      return { offset, records: this.lookups.hydrate(table, this.relations.hydrate(table, rows.map(row => this.decode(row)))) };
    }, 'DEFERRED');
  }

  private prepareQuery(table: Table, query: CheckedQuery, view?: GridView, materializeLookups = false) {
    this.checkSchema(table.id, table.version);
    if (view && this.getView(table.id, view.id).version !== view.version) {
      throw new ServiceError('VIEW_CONFLICT', 'This view changed. Refresh before continuing.', 409);
    }
    const current = this.getTable(table.id);
    if (query.expectedRevision !== undefined && query.expectedRevision !== current.revision) {
      throw new ServiceError('DATA_CHANGED', 'The table changed between pages. Refresh the query before continuing.', 409);
    }
    const targets = new Map(current.fields.filter(field => field.type === 'relation').map(field => {
      const target = this.getTable(field.relation!.tableId);
      return [target.id, target];
    }));
    const dates = relativeDateRanges(current, query.filter, this.clock());
    if (query.expectedDateContext !== undefined && query.expectedDateContext !== dates.dateContext) {
      throw new ServiceError('DATA_CHANGED', 'The relative date range changed. Refresh to use the current calendar period; your drafts are retained.', 409);
    }
    return { current, ...(dates.dateContext ? { dateContext: dates.dateContext } : {}),
      sql: querySql(current, { ...query, ...(view?.type === 'grid' && view.groupBy ? { groupBy: view.groupBy } : {}) }, targets,
        { dateRanges: dates.ranges, materializeLookups }) };
  }

  queryRecords(table: Table, query: CheckedQuery, view?: GridView): QueryPage {
    return this.transaction(() => {
      const { current, sql, dateContext } = this.prepareQuery(table, query, view, true);
      const { total, rows } = queryPage(this.db, sql, query);
      const output = query.fields ? { ...current, fields: current.fields.filter(field => query.fields!.includes(field.id)) } : current;
      const hydrated = this.lookups.hydrate(current, this.relations.hydrate(output, rows.map(row => this.decode(row))), query.fields);
      const records = hydrated.map(record => {
        if (query.fields) {
          record.values = Object.fromEntries(query.fields.map(id => [id, record.values[id] ?? null]));
          if (record.formulaErrors) {
            record.formulaErrors = Object.fromEntries(Object.entries(record.formulaErrors).filter(([id]) => query.fields!.includes(id)));
            if (!Object.keys(record.formulaErrors).length) delete record.formulaErrors;
          }
        }
        return record;
      });
      return { offset: query.offset, records, total, revision: current.revision, schemaVersion: current.version, ...(dateContext ? { dateContext } : {}) };
    }, 'DEFERRED');
  }

  summarizeRecords(table: Table, query: CheckedQuery, summary: CheckedSummary, view?: GridView): RecordSummary {
    return this.transaction(() => {
      const { current, sql, dateContext } = this.prepareQuery(table, query, view);
      return { ...summarize(this.db, current, summary, sql.where, sql.countParameters, query.offset, query.limit), ...(dateContext ? { dateContext } : {}) };
    }, 'DEFERRED');
  }

  private decodeView(row: StoredView): GridView {
    const config = JSON.parse(row.config_json) as Pick<GridView, 'query' | 'columns' | 'rowHeight' | 'frozenColumns' | 'type' | 'groupBy'>;
    return { id: row.id, tableId: row.table_id, name: row.name, version: row.version, ...config };
  }

  listViews(id: string): GridView[] {
    const rows = this.db.prepare('SELECT * FROM views WHERE table_id = ? ORDER BY rowid').all(id) as unknown as StoredView[];
    return rows.map(row => this.decodeView(row));
  }

  getView(id: string, viewId: string): GridView {
    const row = this.db.prepare('SELECT * FROM views WHERE table_id = ? AND id = ?').get(id, viewId) as unknown as StoredView | undefined;
    if (!row) throw new ServiceError('VIEW_NOT_FOUND', 'This view does not exist.', 404);
    return this.decodeView(row);
  }

  private writeView(view: GridView): void {
    this.db.prepare(`INSERT INTO views VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, version = excluded.version, config_json = excluded.config_json`)
      .run(view.id, view.tableId, view.name, view.version, JSON.stringify({ query: view.query, columns: view.columns,
        rowHeight: view.rowHeight, frozenColumns: view.frozenColumns, type: view.type, groupBy: view.groupBy }));
  }

  private syncViews(table: Table): void {
    for (const view of this.listViews(table.id)) {
      const next = reconcileView(view, table);
      if (JSON.stringify(next) !== JSON.stringify(view)) this.writeView({ ...next, version: view.version + 1 });
    }
    syncQueryIndexes(this.db, table, this.listViews(table.id).map(groupedViewQuery));
  }

  private syncLookupViews(changed: Table, write: boolean): void {
    const definitions = new Map(changed.fields.map(field => [field.id, field]));
    for (const id of this.lookups.dependents(changed.id)) {
      const source = id === changed.id ? changed : this.getTable(id);
      source.fields = source.fields.map(field => field.type === 'lookup' && definitions.has(field.lookup!.fieldId)
        ? { ...field, lookupResult: definitions.get(field.lookup!.fieldId)! } : field);
      if (!write) { for (const view of this.listViews(id)) reconcileView(view, source); }
      else {
        this.syncViews(source);
        if (id !== changed.id) this.db.prepare('UPDATE tables SET version = version + 1 WHERE id = ?').run(id);
      }
    }
  }

  saveView(table: Table, view: GridView, expectedVersion?: number): GridView {
    return this.transaction(() => {
      this.checkSchema(table.id, table.version);
      if (expectedVersion !== undefined && this.getView(table.id, view.id).version !== expectedVersion) {
        throw new ServiceError('VIEW_CONFLICT', 'This view changed. Reload before saving again.', 409);
      }
      const saved = { ...view, version: expectedVersion === undefined ? 1 : expectedVersion + 1 };
      this.writeView(saved);
      syncQueryIndexes(this.db, table, this.listViews(table.id).map(groupedViewQuery));
      return saved;
    });
  }

  deleteView(id: string, viewId: string, expectedVersion: number): void {
    this.transaction(() => {
      const view = this.getView(id, viewId);
      if (view.version !== expectedVersion) throw new ServiceError('VIEW_CONFLICT', 'This view changed. Reload before deleting again.', 409);
      if (this.listViews(id).length === 1) throw new ServiceError('LAST_VIEW', 'Keep at least one view in the table.');
      this.db.prepare('DELETE FROM views WHERE table_id = ? AND id = ?').run(id, viewId);
      syncQueryIndexes(this.db, this.getTable(id), this.listViews(id).map(groupedViewQuery));
    });
  }

  private decode(row: StoredRecord): RowRecord {
    const errors = JSON.parse(row.formula_errors_json) as Record<string, string>;
    return { id: row.id, version: row.version, values: JSON.parse(row.values_json) as RowRecord['values'],
      ...(Object.keys(errors).length ? { formulaErrors: errors } : {}) };
  }

  private recalculate(table: Table, calculate: ReturnType<typeof compileFormulas>): Set<string> {
    const changed = new Set<string>();
    const write = this.db.prepare('UPDATE records SET values_json = ?, formula_errors_json = ?, version = version + 1 WHERE id = ?');
    for (const stored of this.db.prepare('SELECT id, values_json, formula_errors_json FROM records WHERE table_id = ?').iterate(table.id)) {
      const result = calculate(JSON.parse(stored['values_json'] as string) as RowRecord['values'], JSON.parse(stored['formula_errors_json'] as string) as Record<string, string>);
      const values = JSON.stringify(result.values), errors = JSON.stringify(result.formulaErrors ?? {});
      if (values !== stored['values_json'] || errors !== stored['formula_errors_json']) {
        write.run(values, errors, stored['id']!);
        changed.add(stored['id'] as string);
      }
    }
    return changed;
  }

  private recalculateConnectedTable(tableId: string, calculations: ConnectedCalculations, versioned: Set<string>): Set<string> {
    if (!calculations.hasLinked) return new Set();
    const ids = new Set(this.db.prepare('SELECT id FROM records WHERE table_id = ?').all(tableId).map(row => row['id'] as string));
    return calculations.run(new Map([[tableId, ids]]), versioned, this.lookups, id => this.getTable(id)).tables;
  }

  private finishRecordWrite(tableId: string, ids: string[], linked: { records: ChangedRecords }): Set<string> {
    const seeds = new Map(linked.records);
    seeds.set(tableId, new Set([...seeds.get(tableId) ?? [], ...ids]));
    const versioned = new Set([...seeds.values()].flatMap(ids => [...ids]));
    const result = new ConnectedCalculations(this.db).run(seeds, versioned, this.lookups, id => this.getTable(id));
    this.relations.bumpRevisions([...seeds.keys(), ...result.tables]);
    return result.changed;
  }

  getRecord(id: string, recordId: string): RowRecord {
    return this.transaction(() => {
      const table = this.getTable(id);
      return this.lookups.hydrate(table, this.relations.hydrate(table, [this.readRecord(id, recordId)]))[0]!;
    }, 'DEFERRED');
  }

  importCsv(table: Table, plan: CheckedCsvImport, apply: boolean): CsvPreview {
    return this.transaction(() => {
      this.checkSchema(table.id, table.version);
      const result: CsvPreview = { tableId: table.id, schemaVersion: table.version, columns: plan.columns,
        mapping: plan.mapping, validated: plan.validated, total: 0, invalid: 0, samples: [], issues: [] };
      let position = (this.db.prepare('SELECT COALESCE(MAX(position), -1) AS last FROM records WHERE table_id = ?')
        .get(table.id)!['last'] as number) + 1;
      const calculate = compileFormulas(table, { skipLinked: true });
      const insert = this.db.prepare('INSERT INTO records (id, table_id, position, values_json, formula_errors_json) VALUES (?, ?, ?, ?, ?)');
      const links: Array<{ id: string; values: Record<string, CellValue> }> = [];
      const relationFields = table.fields.filter(field => field.type === 'relation');
      const created: string[] = [];
      for (const row of plan.rows) {
        result.total++;
        if (result.samples.length < 10) result.samples.push({ row: row.row, cells: row.cells.map(cell =>
          cell.text === '' && !cell.quoted ? null : cell.text.length > 200 ? cell.text.slice(0, 200) + '…' : cell.text) });
        if (!plan.validated) continue;
        try {
          const values = csvRecordValues(table, plan, row);
          if (apply) {
            const id = randomUUID();
            const result = calculate(values);
            insert.run(id, table.id, position++, JSON.stringify(result.values), JSON.stringify(result.formulaErrors ?? {}));
            created.push(id);
            if (relationFields.length) links.push({ id, values: Object.fromEntries(relationFields.map(field => [field.id, values[field.id]!])) });
          } else {
            for (const field of table.fields.filter(field => field.type === 'relation')) this.relations.validateTargets(field, values[field.id]!);
          }
        } catch (error) {
          if (!(error instanceof ServiceError)) throw error;
          if (apply) throw new ServiceError(error.code, `Row ${row.row}: ${error.message}`, error.status);
          result.invalid++;
          if (result.issues.length < 20) result.issues.push({ row: row.row, code: error.code, message: error.message });
        }
      }
      if (apply && result.total) this.finishRecordWrite(table.id, created, this.relations.write(table, links));
      return result;
    }, apply ? 'IMMEDIATE' : 'DEFERRED');
  }

  exportCsv(table: Table, query: CheckedQuery, view?: GridView): string {
    return this.transaction(() => {
      const { current, sql } = this.prepareQuery(table, query, view);
      const fields = query.fields ? query.fields.map(id => current.fields.find(field => field.id === id)!) : current.fields;
      const total = this.db.prepare(`SELECT COUNT(*) AS total FROM records r WHERE ${sql.where}`)
        .get(sql.countParameters)!['total'] as number;
      if (total > maxCsvRows || total * fields.length > maxCsvCells) csvLimit(`Export up to ${maxCsvRows} rows and ${maxCsvCells} cells; use a filtered view or fewer visible columns.`);
      const chunks: string[] = [];
      let bytes = 0;
      const append = (text: string) => {
        bytes += Buffer.byteLength(text, 'utf8');
        if (bytes > maxCsvBytes) csvLimit('The CSV exceeds 32 MiB; export a smaller filtered view.');
        chunks.push(text);
      };
      append('\uFEFF' + fields.map(field => csvCell(field.name)).join(',') + '\r\n');
      let batch: RowRecord[] = [];
      let batchSize = 0;
      const flush = () => {
        this.lookups.hydrate(current, batch, fields.map(field => field.id));
        for (const record of batch) {
          if (fields.some(field => record.formulaErrors?.[field.id])) {
            throw new ServiceError('CALCULATION_ERROR', `Record ${record.id} has a calculation error. Correct it or exclude the field before exporting.`);
          }
          append(csvRecord(fields, record.values));
        }
        batch = [];
        batchSize = 0;
      };
      for (const row of this.db.prepare(`SELECT r.id, r.version, r.values_json, r.formula_errors_json FROM records r WHERE ${sql.where} ORDER BY ${sql.order}`).iterate(sql.parameters)) {
        batch.push(this.decode(row as unknown as StoredRecord));
        batchSize += (row['values_json'] as string).length;
        if (batch.length === 500 || batchSize >= 1024 * 1024) flush();
      }
      if (batch.length) flush();
      return chunks.join('');
    }, 'DEFERRED');
  }

  private readRecord(id: string, recordId: string): RowRecord {
    const row = this.db.prepare('SELECT id, version, values_json, formula_errors_json FROM records WHERE table_id = ? AND id = ?')
      .get(id, recordId) as unknown as StoredRecord | undefined;
    if (!row) throw new ServiceError('RECORD_NOT_FOUND', `Record ${recordId} does not exist.`, 404);
    return this.decode(row);
  }

  createRecords(table: Table, values: Array<Record<string, CellValue>>): BatchResult {
    return this.transaction(() => {
      this.checkSchema(table.id, table.version);
      return this.insertRecords(table, values.map(values => ({ id: randomUUID(), version: 1, values })));
    });
  }

  private insertRecords(table: Table, input: Array<{ id: string; version: number; values: Record<string, CellValue> }>): BatchResult {
    let position = (this.db.prepare('SELECT COALESCE(MAX(position), -1) AS last FROM records WHERE table_id = ?').get(table.id)!['last'] as number) + 1;
    const calculate = compileFormulas(table, { skipLinked: true });
    const insert = this.db.prepare('INSERT INTO records (id, table_id, position, version, values_json, formula_errors_json) VALUES (?, ?, ?, ?, ?, ?)');
    const records = input.map(({ id, version, values }) => {
      const result = calculate(values);
      insert.run(id, table.id, position++, version, JSON.stringify(result.values), JSON.stringify(result.formulaErrors ?? {}));
      return { id, version, ...result };
    });
    const linked = this.relations.write(table, records);
    for (const record of records) if (linked.values.has(record.id)) record.values = linked.values.get(record.id)!;
    const computed = this.finishRecordWrite(table.id, records.map(record => record.id), linked);
    return { records: this.lookups.hydrate(table, this.relations.hydrate(table, records.map(record => computed.has(record.id) ? this.readRecord(table.id, record.id) : record))) };
  }

  recordTrash(table: Table, query: RecordHistoryQuery): RecordTrashPage {
    return this.transaction(() => { this.checkSchema(table.id, table.version); return this.history.trash(table, query); }, 'DEFERRED');
  }

  restoreDeletedRecords(table: Table, records: Array<{ id: string; deletionId: number; version: number; values: Record<string, CellValue> }>): BatchResult {
    return this.transaction(() => {
      this.checkSchema(table.id, table.version);
      for (const record of records) this.history.checkDeleted(table.id, record.id, record.deletionId);
      const result = this.insertRecords(table, records);
      for (const record of records) this.history.markRestored(record.id, record.deletionId);
      return result;
    });
  }

  deleteRecords(id: string, records: RecordDelete[]): DeleteResult {
    return this.transaction(() => {
      const remove = this.db.prepare('DELETE FROM records WHERE table_id = ? AND id = ?');
      for (const item of records) {
        const record = this.readRecord(id, item.id);
        if (record.version !== item.expectedVersion) {
          throw new ServiceError('VERSION_CONFLICT', `Record ${item.id} changed. Reload before deleting again.`, 409);
        }
      }
      const affected = this.relations.deleteRecords(this.getTable(id), records.map(record => record.id));
      for (const item of records) remove.run(id, item.id);
      this.finishRecordWrite(id, records.map(record => record.id), affected);
      return { deleted: records.map(record => record.id) };
    });
  }

  updateBatch(updates: RecordUpdate[], id: string, schemaVersion: number): BatchResult {
    return this.transaction(() => this.writeBatch(updates, id, schemaVersion));
  }

  recordHistory(id: string, recordId: string, query: RecordHistoryQuery): RecordHistoryPage {
    return this.transaction(() => this.history.list(id, recordId, query), 'DEFERRED');
  }

  recordChange(id: string, recordId: string, changeId: number): RecordChangeDetail {
    return this.history.get(id, recordId, changeId);
  }

  restoreRecord(update: RecordUpdate, id: string, schemaVersion: number, source: RecordRestore): RowRecord {
    return this.transaction(() => this.writeBatch([update], id, schemaVersion).records[0]!, 'IMMEDIATE', source);
  }

  private writeBatch(updates: RecordUpdate[], id: string, schemaVersion: number): BatchResult {
    const read = this.db.prepare('SELECT id, version, values_json, formula_errors_json FROM records WHERE id = ? AND table_id = ?');
    const write = this.db.prepare('UPDATE records SET values_json = ?, formula_errors_json = ?, version = version + 1 WHERE id = ? AND table_id = ?');
    this.checkSchema(id, schemaVersion);
    const table = this.getTable(id);
    const calculate = compileFormulas(table, { skipLinked: true });
    const records = updates.map(update => {
      const stored = read.get(update.id, id) as unknown as StoredRecord | undefined;
      if (!stored) throw new ServiceError('RECORD_NOT_FOUND', `Record ${update.id} does not exist.`, 404);
      if (stored.version !== update.expectedVersion) {
        throw new ServiceError('VERSION_CONFLICT', `Record ${update.id} changed. Reload before saving again.`, 409);
      }
      const record = this.decode(stored);
      const result = calculate({ ...record.values, ...update.values }, record.formulaErrors);
      record.values = result.values;
      if (result.formulaErrors) record.formulaErrors = result.formulaErrors;
      else delete record.formulaErrors;
      record.version++;
      write.run(JSON.stringify(record.values), JSON.stringify(record.formulaErrors ?? {}), record.id, id);
      return record;
    });
    const linked = this.relations.write(table, updates);
    for (const record of records) if (linked.values.has(record.id)) record.values = linked.values.get(record.id)!;
    const computed = this.finishRecordWrite(id, records.map(record => record.id), linked);
    return { records: this.lookups.hydrate(table, this.relations.hydrate(table, records.map(record => computed.has(record.id) ? this.readRecord(id, record.id) : record))) };
  }

  close(): void {
    this.db.close();
  }
}
