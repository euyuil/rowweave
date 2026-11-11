import { RecordService } from '../../../packages/core/src/record-service.js';
import { SqliteRecordStore } from '../../../packages/storage-sqlite/src/record-store.js';
import { startServer } from '../../server/src/http-server.js';

const database = process.env['ROWWEAVE_DB'];
const token = process.env['ROWWEAVE_TOKEN'];
if (!database || !token || !process.parentPort) throw new Error('Missing service launch configuration.');
const store = new SqliteRecordStore(database);
try {
  const server = await startServer({ service: new RecordService(store), token });
  let closing = false;
  process.parentPort.on('message', async ({ data }: { data: unknown }) => {
    if (data !== 'shutdown' || closing) return;
    closing = true;
    await server.close();
    store.close();
    process.exit(0);
  });
  process.parentPort.postMessage({ type: 'ready', url: server.url });
} catch (error) {
  store.close();
  throw error;
}
