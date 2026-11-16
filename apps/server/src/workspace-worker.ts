import { parentPort, workerData } from 'node:worker_threads';
import { SqliteRecordStore, type CheckpointResult } from '../../../packages/storage-sqlite/src/record-store.js';
import type { CalculationRefresh } from '../../../packages/contracts/src/index.js';

export type WorkspaceWorkerReply = { command: 'ready' }
  | { command: 'refresh'; result: CalculationRefresh }
  | { command: 'checkpoint'; result: CheckpointResult }
  | { command: 'refresh' | 'checkpoint'; error: string };

const store = new SqliteRecordStore(workerData as string);
const port = parentPort!;
port.on('message', (command: 'refresh' | 'checkpoint' | 'close') => {
  if (command === 'close') { store.close(); port.close(); return; }
  let reply: WorkspaceWorkerReply;
  try {
    reply = command === 'refresh'
      ? { command, result: store.refreshCalculations() }
      : { command, result: store.checkpoint() };
  } catch (error) { reply = { command, error: error instanceof Error ? error.message : 'Workspace background operation failed.' }; }
  port.postMessage(reply);
});
port.postMessage({ command: 'ready' } satisfies WorkspaceWorkerReply);
