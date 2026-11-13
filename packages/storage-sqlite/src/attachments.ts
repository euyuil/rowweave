import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Attachment, AttachmentPage, AttachmentQuery } from '../../contracts/src/index.js';
import type { AttachmentFile, CheckedAttachmentUpload } from '../../core/src/attachments.js';
import { ServiceError } from '../../core/src/errors.js';

const columns = 'id, filename, media_type AS mediaType, size, sha256, created_at AS createdAt';

export class Attachments {
  constructor(private readonly db: DatabaseSync) {}

  upload(tableId: string, input: CheckedAttachmentUpload, createdAt: string): Attachment {
    const metadata: Attachment = { id: randomUUID(), filename: input.filename, mediaType: input.mediaType,
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
    if (!this.db.prepare('DELETE FROM attachments WHERE table_id = ? AND id = ?').run(tableId, id).changes) {
      throw new ServiceError('ATTACHMENT_NOT_FOUND', 'This attachment does not exist in this table.', 404);
    }
  }
}
