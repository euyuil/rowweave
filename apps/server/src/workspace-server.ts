import { RecordService } from '../../../packages/core/src/record-service.js';
import { SqliteRecordStore } from '../../../packages/storage-sqlite/src/record-store.js';
import { startServer, type ServerOptions } from './http-server.js';
import { Calculations } from './calculations.js';
import { CalculationWorker } from './calculation-runner.js';

export async function startWorkspaceServer(database: string, options: Omit<ServerOptions, 'service' | 'calculations'>) {
  const store = new SqliteRecordStore(database);
  try {
    const server = await startServer({ ...options, service: new RecordService(store), calculations: new Calculations(new CalculationWorker(database), true) });
    return { url: server.url, close: async () => { await server.close(); store.close(); } };
  } catch (error) { store.close(); throw error; }
}
