import type { DatabaseSync } from 'node:sqlite';
import type { CellValue, Field, RowRecord, Table } from '../../contracts/src/index.js';
import { compileFormula } from '../../core/src/formulas.js';
import { ServiceError } from '../../core/src/errors.js';
import type { Lookups } from './lookups.js';

export type ChangedRecords = Map<string, Set<string>>;
interface Node {
  tableId: string;
  field: Field;
  dependencies: string[];
  formula?: ReturnType<typeof compileFormula>;
  linked: boolean;
}

export class ConnectedCalculations {
  private readonly nodes = new Map<string, Node>();
  private readonly ordered: Node[] = [];

  get hasLinked(): boolean { return this.ordered.some(node => node.linked); }

  constructor(private readonly db: DatabaseSync, override?: Table) {
    const definitions = db.prepare('SELECT table_id, definition_json FROM fields').all()
      .filter(row => row['table_id'] !== override?.id)
      .map(row => ({ tableId: row['table_id'] as string, field: JSON.parse(row['definition_json'] as string) as Field }));
    if (override) definitions.push(...override.fields.map(field => ({ tableId: override.id, field })));
    for (const { tableId, field } of definitions) {
      const formula = field.type === 'formula' ? compileFormula(field) : undefined;
      this.nodes.set(field.id, { tableId, field, linked: false,
        dependencies: formula ? [...formula.references] : field.type === 'lookup' ? [field.lookup!.relationFieldId, field.lookup!.fieldId] : [],
        ...(formula ? { formula } : {}) });
    }
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new ServiceError('INVALID_FORMULA', 'Formulas and lookups cannot form a dependency cycle across records or tables.');
      const node = this.nodes.get(id);
      if (!node) throw new ServiceError('INVALID_FORMULA', 'A calculation references a missing field. Remove its dependent fields first.');
      visiting.add(id);
      for (const dependency of node.dependencies) visit(dependency);
      node.linked = !!node.formula && node.dependencies.some(id => ['lookup', 'relation'].includes(this.nodes.get(id)!.field.type) || this.nodes.get(id)!.linked);
      visiting.delete(id);
      visited.add(id);
      if (node.formula || node.field.type === 'lookup') this.ordered.push(node);
    };
    for (const id of this.nodes.keys()) visit(id);
  }

  refreshClock(lookups: Lookups, getTable: (id: string) => Table, now: Date) {
    const tables = new Set<string>();
    if (!this.ordered.some(node => node.formula?.clockDependent)) return { changedRecords: 0, tables };
    this.db.exec(`CREATE TEMP TABLE clock_formula_dirty (field_id TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY (field_id, record_id)) WITHOUT ROWID;
      CREATE TEMP TABLE clock_formula_changed (record_id TEXT PRIMARY KEY, table_id TEXT NOT NULL) WITHOUT ROWID;`);
    try {
      const dirty = this.db.prepare('INSERT OR IGNORE INTO clock_formula_dirty VALUES (?, ?)');
      const changed = this.db.prepare('INSERT OR IGNORE INTO clock_formula_changed VALUES (?, ?)');
      const write = this.db.prepare(`UPDATE records SET values_json = ?, formula_errors_json = ?,
        version = version + CASE WHEN EXISTS (SELECT 1 FROM clock_formula_changed WHERE record_id = records.id) THEN 0 ELSE 1 END WHERE id = ?`);
      const read = this.db.prepare(`SELECT r.id, r.position, r.version, r.values_json, r.formula_errors_json FROM records r
        WHERE r.table_id = ? AND r.position > ? AND (? = 1 OR EXISTS (SELECT 1 FROM clock_formula_dirty d
          WHERE d.record_id = r.id AND d.field_id IN (SELECT value FROM json_each(?)))) ORDER BY r.position LIMIT 100`);
      const sources = this.db.prepare(`INSERT OR IGNORE INTO clock_formula_dirty
        SELECT ?, edge.source_record_id FROM relation_edges edge JOIN clock_formula_dirty d
        ON d.record_id = edge.target_record_id AND d.field_id = ? WHERE edge.field_id = ?`);
      const schemas = new Map<string, Table>();
      const hasDirtyInput = this.db.prepare('SELECT 1 FROM clock_formula_dirty WHERE field_id IN (SELECT value FROM json_each(?)) LIMIT 1');
      const constants = new Map<string, ReturnType<NonNullable<Node['formula']>['calculate']>>();
      const markConstant = this.db.prepare(`INSERT OR IGNORE INTO clock_formula_dirty SELECT ?, r.id FROM records r
        WHERE r.table_id = ? AND (? = 1 OR EXISTS (SELECT 1 FROM clock_formula_dirty d WHERE d.record_id = r.id AND d.field_id IN (SELECT value FROM json_each(?))))
        AND (json_type(r.values_json, ?) IS NOT json_type(?) OR json_extract(r.values_json, ?) IS NOT json_extract(?, '$')
          OR json_extract(r.formula_errors_json, ?) IS NOT ?)`);
      const writeConstant = this.db.prepare(`UPDATE records SET values_json = json_set(values_json, ?, json(?)),
        formula_errors_json = CASE WHEN ? IS NULL THEN json_remove(formula_errors_json, ?) ELSE json_set(formula_errors_json, ?, ?) END,
        version = version + CASE WHEN EXISTS (SELECT 1 FROM clock_formula_changed WHERE record_id = records.id) THEN 0 ELSE 1 END
        WHERE id IN (SELECT record_id FROM clock_formula_dirty WHERE field_id = ?)`);
      const changedConstant = this.db.prepare('INSERT OR IGNORE INTO clock_formula_changed SELECT record_id, ? FROM clock_formula_dirty WHERE field_id = ?');
      for (const node of this.ordered) {
        const field = node.field;
        if (field.type === 'lookup') {
          sources.run(field.id, field.lookup!.fieldId, field.lookup!.relationFieldId);
          if (this.db.prepare('SELECT 1 FROM clock_formula_dirty WHERE field_id = ? LIMIT 1').get(field.id)) tables.add(node.tableId);
          continue;
        }
        if (!node.formula!.clockDependent && !hasDirtyInput.get(JSON.stringify(node.dependencies))) continue;
        if (node.dependencies.every(id => constants.has(id))) {
          const values = Object.fromEntries(node.dependencies.map(id => [id, constants.get(id)!.value]));
          const errors = Object.fromEntries(node.dependencies.filter(id => constants.get(id)!.error).map(id => [id, constants.get(id)!.error!]));
          const result = node.formula!.calculate(values, errors, now);
          constants.set(field.id, result);
          const path = '$.' + JSON.stringify(field.id), value = JSON.stringify(result.value);
          markConstant.run(field.id, node.tableId, node.formula!.clockDependent ? 1 : 0, JSON.stringify(node.dependencies), path, value, path, value, path, result.error ?? null);
          if (writeConstant.run(path, value, result.error ?? null, path, path, result.error ?? null, field.id).changes) tables.add(node.tableId);
          changedConstant.run(node.tableId, field.id);
          continue;
        }
        let table = schemas.get(node.tableId);
        if (!table) { table = getTable(node.tableId); schemas.set(node.tableId, table); }
        const lookupIds = node.dependencies.filter(id => this.nodes.get(id)!.field.type === 'lookup');
        let position = -1;
        while (true) {
          const rows = read.all(node.tableId, position, node.formula!.clockDependent ? 1 : 0, JSON.stringify(node.dependencies));
          if (!rows.length) break;
          position = rows.at(-1)!['position'] as number;
          const records = rows.map(row => ({ id: row['id'] as string, version: row['version'] as number,
            values: JSON.parse(row['values_json'] as string) as Record<string, CellValue>,
            formulaErrors: JSON.parse(row['formula_errors_json'] as string) as Record<string, string> }));
          const inputs: RowRecord[] = records.map(record => ({ ...record, values: { ...record.values }, formulaErrors: { ...record.formulaErrors } }));
          lookups.hydrate(table, inputs, lookupIds);
          for (const [index, record] of records.entries()) {
            const input = inputs[index]!;
            const result = node.formula!.calculate(input.values, input.formulaErrors ?? {}, now);
            if (Object.hasOwn(record.values, field.id) && record.values[field.id] === result.value && record.formulaErrors[field.id] === result.error) continue;
            record.values[field.id] = result.value;
            if (result.error) record.formulaErrors[field.id] = result.error;
            else delete record.formulaErrors[field.id];
            write.run(JSON.stringify(record.values), JSON.stringify(record.formulaErrors), record.id);
            changed.run(record.id, node.tableId); dirty.run(field.id, record.id); tables.add(node.tableId);
          }
        }
      }
      return { changedRecords: this.db.prepare('SELECT COUNT(*) AS total FROM clock_formula_changed').get()!['total'] as number, tables };
    } finally { this.db.exec('DROP TABLE clock_formula_dirty; DROP TABLE clock_formula_changed;'); }
  }

  run(seeds: ChangedRecords, versioned: Set<string>, lookups: Lookups, getTable: (id: string) => Table, now: Date) {
    const changed = new Set<string>(), tables = new Set<string>();
    if (!this.hasLinked) return { changed, tables };
    const dirty = new Map<string, Set<string>>();
    for (const [id, node] of this.nodes) if (seeds.has(node.tableId)) dirty.set(id, seeds.get(node.tableId)!);
    const schemas = new Map<string, Table>();
    const read = this.db.prepare('SELECT id, version, values_json, formula_errors_json FROM records WHERE table_id = ? AND id IN (SELECT value FROM json_each(?))');
    const write = this.db.prepare('UPDATE records SET values_json = ?, formula_errors_json = ?, version = version + ? WHERE id = ?');
    const sources = this.db.prepare('SELECT DISTINCT source_record_id FROM relation_edges WHERE field_id = ? AND target_record_id IN (SELECT value FROM json_each(?))');
    for (const node of this.ordered) {
      const field = node.field;
      const ids = new Set(dirty.get(field.id));
      if (field.type === 'lookup') {
        for (const id of dirty.get(field.lookup!.relationFieldId) ?? []) ids.add(id);
        const targets = [...dirty.get(field.lookup!.fieldId) ?? []];
        for (let offset = 0; offset < targets.length; offset += 500) {
          for (const row of sources.all(field.lookup!.relationFieldId, JSON.stringify(targets.slice(offset, offset + 500)))) ids.add(row['source_record_id'] as string);
        }
        if (ids.size) { dirty.set(field.id, ids); tables.add(node.tableId); }
        continue;
      }
      for (const dependency of node.dependencies) for (const id of dirty.get(dependency) ?? []) ids.add(id);
      if (!ids.size) continue;
      if (!node.linked) { dirty.set(field.id, ids); continue; }
      let table = schemas.get(node.tableId);
      if (!table) { table = getTable(node.tableId); schemas.set(node.tableId, table); }
      const lookupIds = node.dependencies.filter(id => this.nodes.get(id)!.field.type === 'lookup');
      const computed = new Set<string>();
      const selected = [...ids];
      for (let offset = 0; offset < selected.length; offset += 100) {
        const records = read.all(node.tableId, JSON.stringify(selected.slice(offset, offset + 100))).map(row => ({
          id: row['id'] as string, version: row['version'] as number,
          values: JSON.parse(row['values_json'] as string) as Record<string, CellValue>,
          formulaErrors: JSON.parse(row['formula_errors_json'] as string) as Record<string, string>,
        }));
        const inputs: RowRecord[] = records.map(record => ({ ...record, values: { ...record.values }, formulaErrors: { ...record.formulaErrors } }));
        lookups.hydrate(table, inputs, lookupIds);
        for (const [index, record] of records.entries()) {
          const input = inputs[index]!;
          const result = node.formula!.calculate(input.values, input.formulaErrors ?? {}, now);
          if (Object.hasOwn(record.values, field.id) && record.values[field.id] === result.value && record.formulaErrors[field.id] === result.error) continue;
          record.values[field.id] = result.value;
          if (result.error) record.formulaErrors[field.id] = result.error;
          else delete record.formulaErrors[field.id];
          write.run(JSON.stringify(record.values), JSON.stringify(record.formulaErrors), versioned.has(record.id) ? 0 : 1, record.id);
          versioned.add(record.id);
          computed.add(record.id);
          changed.add(record.id);
          tables.add(node.tableId);
        }
      }
      dirty.set(field.id, computed);
    }
    return { changed, tables };
  }
}
