import { maxAttachmentBytes, type Attachment, type AttachmentQuery } from '../../contracts/src/index.js';
import { ServiceError } from './errors.js';
import { schemaObject } from './schema-validation.js';

export interface CheckedAttachmentUpload { filename: string; mediaType: string; bytes: Uint8Array }
export interface AttachmentFile { metadata: Attachment; bytes: Uint8Array }

export function parseAttachmentUpload(input: unknown): CheckedAttachmentUpload {
  const item = schemaObject(input), filename = item['filename'], mediaType = item['mediaType'], data = item['data'];
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 200 || Buffer.from(filename, 'utf8').toString('utf8') !== filename || /[\x00-\x1f\x7f/\\]/.test(filename) || filename === '.' || filename === '..') {
    throw new ServiceError('INVALID_ATTACHMENT', 'Use a filename of up to 200 characters, without directory separators or control characters.');
  }
  if (typeof mediaType !== 'string' || mediaType.length > 150 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mediaType)) {
    throw new ServiceError('INVALID_ATTACHMENT', 'Use a media type such as image/png or application/octet-stream, without parameters.');
  }
  if (typeof data !== 'string') throw new ServiceError('INVALID_ATTACHMENT', 'Send file bytes as canonical base64 text.');
  if (data.length > Math.ceil(maxAttachmentBytes / 3) * 4) throw new ServiceError('PAYLOAD_TOO_LARGE', 'Files may contain at most 8 MiB.', 413);
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw new ServiceError('INVALID_ATTACHMENT', 'Send file bytes as canonical base64 text.');
  if (bytes.length > maxAttachmentBytes) throw new ServiceError('PAYLOAD_TOO_LARGE', 'Files may contain at most 8 MiB.', 413);
  return { filename, mediaType: mediaType.toLowerCase(), bytes };
}

export function parseAttachmentQuery(input: unknown): Required<Pick<AttachmentQuery, 'limit'>> & AttachmentQuery {
  const item = schemaObject(input), before = item['before'], limit = item['limit'] ?? 50;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100 ||
      (before !== undefined && (!Number.isSafeInteger(before) || (before as number) < 1))) {
    throw new ServiceError('INVALID_QUERY', 'Use a limit between 1 and 100 and a positive before cursor.');
  }
  return { limit: limit as number, ...(before === undefined ? {} : { before: before as number }) };
}
