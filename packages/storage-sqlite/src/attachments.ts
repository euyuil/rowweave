import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Attachment, AttachmentPage, AttachmentQuery, CellValue, RowRecord, Table } from '../../contracts/src/index.js';
import type { AttachmentFile, CheckedAttachmentUpload } from '../../core/src/attachments.js';
import { ServiceError } from '../../core/src/errors.js';

const columns = 'id, table_id AS tableId, filename, media_type AS mediaType, size, sha256, created_at AS createdAt';

export class Attachments {
  constructor(private readonly db: DatabaseSync) {}

  upload(tableId: string, input: CheckedAttachmentUpload, createdAt: string): Attachment {
    const metadata: Attachment = { id: randomUUID(), tableId, filename: input.filename, mediaType: input.mediaType,
      size: input.bytes.byteLength, sha256: createHash('sha256').update(input.bytes).digest('hex'), createdAt };
    this.db.prepare('INSERT INTO attachments (id, table_id, filename, media_type, size, sha256, created_at, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(metadata.id, tableId, metadata.filename, metadata.mediaType, metadata.size, metadata.sha256, createdAt, input.bytes);
    return metadata;
  }

  list(tableId: string, query: AttachmentQuery & { limit: number }): AttachmentPage {
    const rows = this.db.prepare(`SELECT sequence, ${columns} FROM attachments WHERE table_id = ? ${query.before === undefined ? '' : 'AND sequence < ?'} ORDER BY sequence DESC LIMIT ?`)
      .all(tableId, ...(query.before === undefined ? [] : [query.before]), query.limit + 1) as unknown as Array<Attachment & { sequence: number }>;
    return { attachments: rows.slice(0, query.limit).map(({ sequence: _sequence, ...metadata }) => metadata),
      ...(rows.length > query.limit ? { nextBefore: rows[query.limit - 1]!.sequence } : {}) };
  }

  get(tableId: string, id: string): Attachment {
    const row = this.db.prepare(`SELECT ${columns} FROM attachments WHERE table_id = ? AND id = ?`).get(tableId, id) as unknown as Attachment | undefined;
    if (!row) throw new ServiceError('ATTACHMENT_NOT_FOUND', 'This attachment does not exist in this table.', 404);
    return { ...row };
  }

  download(tableId: string, id: string): AttachmentFile {
    const metadata = this.get(tableId, id);
    const row = this.db.prepare('SELECT content FROM attachments WHERE table_id = ? AND id = ?').get(tableId, id)!;
    return { metadata, bytes: row['content'] as Uint8Array };
  }

  delete(tableId: string, id: string): void {
    const file = this.db.prepare('SELECT retained FROM attachments WHERE table_id = ? AND id = ?').get(tableId, id);
    if (file?.['retained']) throw new ServiceError('ATTACHMENT_RETAINED', 'This file is retained for saved records and their history. Remove it from record fields to detach it; deleting its table permanently removes the file.', 409);
    if (!this.db.prepare('DELETE FROM attachments WHERE table_id = ? AND id = ?').run(tableId, id).changes) {
      throw new ServiceError('ATTACHMENT_NOT_FOUND', 'This attachment does not exist in this table.', 404);
    }
  }

  validateSchema(table: Table): void {
    if (table.fields.find(field => field.id === table.primaryFieldId)!.type === 'attachment') {
      throw new ServiceError('INVALID_SCHEMA', 'An attachment field cannot be the primary display field.');
    }
  }

  validateValues(table: Table, values: Record<string, CellValue>, retain: boolean): void {
    const ids = [...new Set(table.fields.filter(field => field.type === 'attachment').flatMap(field => (values[field.id] ?? []) as string[]))];
    if (!ids.length) return;
    const json = JSON.stringify(ids);
    const found = this.db.prepare('SELECT id FROM attachments WHERE table_id = ? AND id IN (SELECT value FROM json_each(?))').all(table.id, json);
    if (found.length !== ids.length) throw new ServiceError('INVALID_ATTACHMENT', 'Every attached file must be an existing upload in this table.');
    if (retain) this.db.prepare('UPDATE attachments SET retained = 1 WHERE id IN (SELECT value FROM json_each(?)) AND retained = 0').run(json);
  }

  hydrate(table: Table, records: RowRecord[]): RowRecord[] {
    const fields = table.fields.filter(field => field.type === 'attachment' || (field.type === 'lookup' && field.lookupResult!.type === 'attachment'));
    if (!fields.length || !records.length) return records;
    const ids = [...new Set(records.flatMap(record => fields.flatMap(field => (record.values[field.id] ?? []) as string[])))];
    const files = new Map(this.db.prepare(`SELECT ${columns} FROM attachments WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids))
      .map(row => [row['id'] as string, { ...row } as unknown as Attachment]));
    for (const record of records) {
      record.attachments = Object.fromEntries(fields.map(field => [field.id, ((record.values[field.id] ?? []) as string[]).map(id => files.get(id)!)]));
    }
    return records;
  }
}
