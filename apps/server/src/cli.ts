import { resolve } from 'node:path';
import { RecordService } from '../../../packages/core/src/record-service.js';
import { SqliteRecordStore } from '../../../packages/storage-sqlite/src/record-store.js';
import { startServer } from './http-server.js';

const token = process.env['ROWWEAVE_TOKEN'];
if (!token) throw new Error('Set ROWWEAVE_TOKEN to at least 32 random characters.');
const store = new SqliteRecordStore(resolve(process.env['ROWWEAVE_DB'] ?? '.data/prototype.sqlite'));
const list = (key: string) => process.env[key]?.split(',').map(value => value.trim()).filter(Boolean);
const host = process.env['ROWWEAVE_HOST'];
const allowedHosts = list('ROWWEAVE_ALLOWED_HOSTS');
const allowedOrigins = list('ROWWEAVE_ALLOWED_ORIGINS');
try {
  const server = await startServer({
    service: new RecordService(store), token, port: Number(process.env['ROWWEAVE_PORT'] ?? '4317'),
    ...(host === undefined ? {} : { host }),
    ...(allowedHosts === undefined ? {} : { allowedHosts }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  });
  console.log(`RowWeave service listening at ${server.url}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    store.close();
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());
} catch (error) {
  store.close();
  throw error;
}
