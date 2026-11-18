import { cellJson, fieldColumn, fieldPath, recordPatch, recordSource, recordTable } from './record-tables.js';
import type { DatabaseSync } from 'node:sqlite';
import { maxLinkedRecords, type CellValue, type Field, type RowRecord, type Table } from '../../contracts/src/index.js';
import { ServiceError } from '../../core/src/errors.js';
import { fieldText } from '../../core/src/field-display.js';
import { validateValue } from '../../core/src/field-values.js';

export class Relations {
  constructor(private readonly db: DatabaseSync) {}

  validateSchema(table: Table, before: Table): void {
    if (table.fields.find(field => field.id === table.primaryFieldId)!.type === 'relation') {
      throw new ServiceError('INVALID_SCHEMA', 'Use a non-linked field as the primary display value.');
    }
    for (const field of table.fields.filter(field => field.type === 'relation')) {
      if (!this.db.prepare('SELECT 1 FROM tables WHERE id = ?').get(field.relation!.tableId)) {
        throw new ServiceError('INVALID_SCHEMA', `${field.name}: the target table does not exist.`);
      }
      const previous = before.fields.find(item => item.id === field.id);
      if (previous?.relation?.inverseFieldId && previous.relation.tableId !== field.relation!.tableId) {
        throw new ServiceError('RELATION_DEPENDENCY', 'A two-way field cannot change its target table. Create a new field instead.', 409);
      }
      if (previous?.relation?.tableId !== field.relation!.tableId &&
          this.db.prepare('SELECT 1 FROM relation_edges WHERE field_id = ? LIMIT 1').get(field.id)) {
        throw new ServiceError('RELATION_DEPENDENCY', 'Remove existing links before changing their target table.', 409);
      }
      this.validateTargets(field, field.defaultValue ?? null);
    }
  }

  syncFields(table: Table): void {
    const write = this.db.prepare(`INSERT INTO field_relations VALUES (?, ?) ON CONFLICT(field_id)
      DO UPDATE SET target_table_id = excluded.target_table_id`);
    for (const field of table.fields.filter(field => field.type === 'relation')) write.run(field.id, field.relation!.tableId);
  }

  validateTargets(field: Field, value: CellValue): void {
    const ids = (value ?? []) as string[];
    if (!ids.length) return;
    const rows = this.db.prepare(`SELECT id FROM record_ids WHERE table_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .all(field.relation!.tableId, JSON.stringify(ids));
    const found = new Set(rows.map(row => row['id']));
    const missing = ids.find(id => !found.has(id));
    if (missing) throw new ServiceError('INVALID_LINK', `${field.name}: record ${missing} does not exist in the target table.`);
  }

  write(inputFields: Field[], changes: Array<{ id: string; values: Record<string, CellValue> }>, deleting = new Set<string>()) {
    const key = (recordId: string, fieldId: string) => JSON.stringify([recordId, fieldId]);
    const fields = new Map(inputFields.map(field => [field.id, field]));
    const direct = new Map<string, { recordId: string; field: Field; ids: string[] }>();
    for (const change of changes) for (const [fieldId, value] of Object.entries(change.values)) {
      const field = fields.get(fieldId);
      if (field?.type !== 'relation') continue;
      this.validateTargets(field, value);
      direct.set(key(change.id, field.id), { recordId: change.id, field, ids: (value ?? []) as string[] });
    }
    if (!direct.size) return { records: new Map<string, Set<string>>(), values: new Map<string, Record<string, CellValue>>() };
    const states = new Map(direct);
    const readIds = this.db.prepare('SELECT target_record_id FROM relation_edges WHERE source_record_id = ? AND field_id = ? ORDER BY position');
    for (const entry of direct.values()) {
      const inverseId = entry.field.relation!.inverseFieldId;
      if (!inverseId) continue;
      let inverse = fields.get(inverseId);
      if (!inverse) {
        inverse = JSON.parse(this.db.prepare('SELECT definition_json FROM fields WHERE id = ?').get(inverseId)!['definition_json'] as string) as Field;
        fields.set(inverseId, inverse);
      }
      const before = readIds.all(entry.recordId, entry.field.id).map(row => row['target_record_id'] as string);
      for (const targetId of new Set([...before, ...entry.ids])) {
        const linked = entry.ids.includes(targetId);
        const targetKey = key(targetId, inverseId);
        const explicit = direct.get(targetKey);
        if (explicit) {
          if (explicit.ids.includes(entry.recordId) !== linked) {
            throw new ServiceError('INVALID_LINK', 'The batch contains conflicting assignments to the two sides of a relationship.');
          }
          continue;
        }
        if (before.includes(targetId) === linked) continue;
        let state = states.get(targetKey);
        if (!state) {
          state = { recordId: targetId, field: inverse, ids: readIds.all(targetId, inverseId).map(row => row['target_record_id'] as string) };
          states.set(targetKey, state);
        }
        state.ids = linked ? [...state.ids, entry.recordId] : state.ids.filter(id => id !== entry.recordId);
      }
    }
    const affected = new Map<string, Record<string, CellValue>>();
    for (const [stateKey, state] of states) {
      if (direct.has(stateKey)) continue;
      if (!deleting.has(state.recordId)) validateValue(state.field, state.ids);
      const values = affected.get(state.recordId) ?? {};
      values[state.field.id] = state.ids;
      affected.set(state.recordId, values);
    }
    const alreadyWritten = new Set(changes.map(change => change.id));
    const records = new Map<string, Set<string>>();
    const updatedValues = new Map<string, Record<string, CellValue>>();
    const owner = this.db.prepare('SELECT table_id FROM record_ids WHERE id = ?');
    const patches = new Map<string, ReturnType<typeof recordPatch>>();
    for (const [id, changed] of affected) {
      const tableId = owner.get(id)!['table_id'] as string;
      const fields = Object.keys(changed);
      const key = JSON.stringify([tableId, fields]);
      let patch = patches.get(key);
      if (!patch) { patch = recordPatch(this.db, tableId, fields); patches.set(key, patch); }
      patch(id, changed, alreadyWritten.has(id) ? 0 : 1);
      const ids = records.get(tableId) ?? new Set<string>();
      ids.add(id);
      records.set(tableId, ids);
      if (alreadyWritten.has(id)) {
        const row = this.db.prepare(`SELECT values_json FROM ${recordSource(tableId)} WHERE id = ?`).get(id)!;
        updatedValues.set(id, JSON.parse(row['values_json'] as string) as Record<string, CellValue>);
      }
    }
    const remove = this.db.prepare('DELETE FROM relation_edges WHERE source_record_id = ? AND field_id = ?');
    const insert = this.db.prepare('INSERT INTO relation_edges VALUES (?, ?, ?, ?)');
    for (const state of states.values()) {
      remove.run(state.recordId, state.field.id);
      for (const [position, id] of state.ids.entries()) insert.run(state.recordId, state.field.id, id, position);
    }
    return { records, values: updatedValues };
  }

  pairFields(field: Field, inverse: Field): Map<string, Set<string>> {
    const copy = (sourceId: string) => this.db.prepare(`INSERT INTO relation_edges (source_record_id, field_id, target_record_id, position)
      SELECT edge.target_record_id, ?, edge.source_record_id,
        COALESCE((SELECT MAX(existing.position) FROM relation_edges existing
          WHERE existing.source_record_id = edge.target_record_id AND existing.field_id = ?), -1)
        + ROW_NUMBER() OVER (PARTITION BY edge.target_record_id ORDER BY source.position, source.id)
      FROM relation_edges edge JOIN ${recordTable(sourceId)} source ON source.id = edge.source_record_id
      WHERE edge.field_id = ? AND NOT EXISTS (SELECT 1 FROM relation_edges existing
        WHERE existing.source_record_id = edge.target_record_id AND existing.field_id = ? AND existing.target_record_id = edge.source_record_id)
      RETURNING source_record_id`);
    const changed = new Map<string, Set<Field>>();
    const writeField = this.db.prepare('UPDATE fields SET definition_json = ? WHERE id = ?');
    for (const [current, reverse] of [[field, inverse], [inverse, field]] as const) {
      for (const row of copy(current.relation!.tableId).iterate(current.id, current.id, reverse.id, current.id)) {
        const id = row['source_record_id'] as string;
        const fields = changed.get(id) ?? new Set<Field>();
        fields.add(current);
        changed.set(id, fields);
      }
      current.relation!.inverseFieldId = reverse.id;
      writeField.run(JSON.stringify(current), current.id);
    }
    const owner = this.db.prepare('SELECT table_id FROM record_ids WHERE id = ?');
    const readIds = this.db.prepare('SELECT target_record_id FROM relation_edges WHERE source_record_id = ? AND field_id = ? ORDER BY position LIMIT ?');
    const records = new Map<string, Set<string>>();
    for (const [id, fields] of changed) {
      const tableId = owner.get(id)!['table_id'] as string;
      const values: Record<string, CellValue> = {};
      for (const current of fields) {
        const ids = readIds.all(id, current.id, (current.relation!.multiple ? maxLinkedRecords : 1) + 1).map(edge => edge['target_record_id'] as string);
        try { values[current.id] = validateValue(current, ids); }
        catch (error) {
          if (error instanceof ServiceError) throw new ServiceError(error.code, `Record ${id}: ${error.message}`);
          throw error;
        }
      }
      recordPatch(this.db, tableId, Object.keys(values))(id, values, 1);
      const ids = records.get(tableId) ?? new Set<string>();
      ids.add(id);
      records.set(tableId, ids);
    }
    return records;
  }

  detachFields(table: Table, before: Table): string[] {
    const affected = new Set<string>();
    for (const removed of before.fields.filter(field => field.relation?.inverseFieldId && !table.fields.some(next => next.id === field.id))) {
      const inverseId = removed.relation!.inverseFieldId!;
      const row = this.db.prepare('SELECT table_id, definition_json FROM fields WHERE id = ?').get(inverseId)!;
      const inverse = JSON.parse(row['definition_json'] as string) as Field;
      delete inverse.relation!.inverseFieldId;
      this.db.prepare('UPDATE fields SET definition_json = ? WHERE id = ?').run(JSON.stringify(inverse), inverseId);
      const targetId = row['table_id'] as string;
      if (targetId === table.id) table.fields = table.fields.map(field => field.id === inverseId ? inverse : field);
      else affected.add(targetId);
    }
    for (const id of affected) this.db.prepare('UPDATE tables SET version = version + 1 WHERE id = ?').run(id);
    return [...affected];
  }

  hydrate(table: Table, records: RowRecord[]): RowRecord[] {
    const fields = table.fields.filter(field => field.type === 'relation');
    if (!fields.length || !records.length) return records;
    const primary = new Map(this.db.prepare(`SELECT t.id, f.definition_json FROM tables t
      JOIN fields f ON f.id = t.primary_field_id WHERE t.id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(fields.map(field => field.relation!.tableId)))
      .map(row => [row['id'] as string, JSON.parse(row['definition_json'] as string) as Field]));
    const byId = new Map(records.map(record => {
      record.links = Object.fromEntries(fields.map(field => [field.id, []]));
      return [record.id, record];
    }));
    const recordIds = JSON.stringify(records.map(record => record.id));
    for (const [targetId, display] of primary) {
      const column = fieldColumn(display.id, 'target');
      const edges = this.db.prepare(`SELECT e.source_record_id, e.field_id, target.id, ${cellJson(column)} AS value_json,
        json_extract(target.formula_errors_json, ?) AS formula_error
        FROM relation_edges e JOIN ${recordTable(targetId)} target ON target.id = e.target_record_id
        WHERE e.source_record_id IN (SELECT value FROM json_each(?)) AND e.field_id IN (SELECT value FROM json_each(?))
        ORDER BY e.source_record_id, e.field_id, e.position`)
        .all(fieldPath(display.id), recordIds, JSON.stringify(fields.filter(field => field.relation!.tableId === targetId).map(field => field.id)));
      for (const edge of edges) {
        const value = JSON.parse(edge['value_json'] as string) as CellValue;
        byId.get(edge['source_record_id'] as string)!.links![edge['field_id'] as string]!.push({
          id: edge['id'] as string, label: edge['formula_error'] ? `#ERROR: ${edge['formula_error']}` : fieldText(display, value),
        });
      }
    }
    return records;
  }

  bumpRevision(tableId: string): void {
    this.bumpRevisions([tableId]);
  }

  bumpRevisions(tableIds: string[]): void {
    const ids = JSON.stringify(tableIds);
    this.db.prepare(`UPDATE tables SET revision = revision + 1 WHERE id IN (SELECT value FROM json_each(?)) OR id IN (
      SELECT f.table_id FROM field_relations rel JOIN fields f ON f.id = rel.field_id WHERE rel.target_table_id IN (SELECT value FROM json_each(?)))`)
      .run(ids, ids);
  }

  deleteTable(tableId: string): void {
    if (this.db.prepare(`SELECT 1 FROM field_relations rel JOIN fields f ON f.id = rel.field_id
      WHERE rel.target_table_id = ? AND f.table_id <> ? LIMIT 1`).get(tableId, tableId)) {
      throw new ServiceError('RELATION_DEPENDENCY', 'Remove linked fields in other tables before deleting this table.', 409);
    }
    this.db.prepare('DELETE FROM field_relations WHERE field_id IN (SELECT id FROM fields WHERE table_id = ?)').run(tableId);
  }

  deleteRecords(table: Table, ids: string[]) {
    const paired = table.fields.filter(field => field.relation?.inverseFieldId);
    const affected = this.write(table.fields, ids.map(id => ({ id, values: Object.fromEntries(paired.map(field => [field.id, null])) })), new Set(ids));
    this.removeRecords(ids);
    return affected;
  }

  removeRecords(ids: string[]): void {
    const selected = JSON.stringify(ids);
    if (this.db.prepare(`SELECT 1 FROM fields f, json_each(f.definition_json, '$.defaultValue') choice
      WHERE json_extract(f.definition_json, '$.type') = 'relation'
      AND choice.value IN (SELECT value FROM json_each(?)) LIMIT 1`).get(selected)) {
      throw new ServiceError('RELATION_DEPENDENCY', 'Remove linked-field defaults before deleting these records.', 409);
    }
    this.db.prepare('DELETE FROM relation_edges WHERE source_record_id IN (SELECT value FROM json_each(?))').run(selected);
    if (this.db.prepare('SELECT 1 FROM relation_edges WHERE target_record_id IN (SELECT value FROM json_each(?)) LIMIT 1').get(selected)) {
      throw new ServiceError('RELATION_DEPENDENCY', 'Unlink these records from other records before deleting them.', 409);
    }
  }
}
