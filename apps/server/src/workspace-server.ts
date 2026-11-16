import { RecordService } from '../../../packages/core/src/record-service.js';
import { SqliteRecordStore } from '../../../packages/storage-sqlite/src/record-store.js';
import { startServer, type ServerOptions } from './http-server.js';
import { Calculations } from './calculations.js';
import { WorkspaceWorker } from './workspace-runner.js';

export async function startWorkspaceServer(database: string, options: Omit<ServerOptions, 'service' | 'calculations'>) {
  const store = new SqliteRecordStore(database);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let closing: Promise<void> | undefined;
  let startupFailure: Error | undefined;
  const close = () => closing ??= (async () => {
    try { if (server) await server.close(); else await worker.close(); }
    finally { store.close(); }
  })();
  const fail = (error: Error) => {
    if (closing) return;
    if (!server) { startupFailure = error; return; }
    console.error('Workspace background maintenance failed; closing the service:', error);
    void close().catch(error => console.error('Workspace shutdown failed:', error));
  };
  const worker = new WorkspaceWorker(database, fail);
  const checkpoint = () => { void worker.checkpoint().catch(fail); };
  try {
    await worker.start();
    store.useBackgroundCheckpoints(checkpoint);
    server = await startServer({ ...options, service: new RecordService(store), calculations: new Calculations({
      refresh: async () => { try { return await worker.refresh(); } finally { checkpoint(); } },
      close: () => worker.close(),
    }, true) });
    if (startupFailure) throw startupFailure;
    return { url: server.url, close };
  } catch (error) { await close(); throw error; }
}
