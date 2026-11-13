import { parentPort, workerData } from 'node:worker_threads';
import { SqliteRecordStore } from '../../../packages/storage-sqlite/src/record-store.js';
import type { CalculationRefresh } from '../../../packages/contracts/src/index.js';

export type CalculationWorkerReply = { result: CalculationRefresh } | { error: string };

const store = new SqliteRecordStore(workerData as string);
const port = parentPort!;
port.on('message', (command: 'refresh' | 'close') => {
  if (command === 'close') { store.close(); port.close(); return; }
  let reply: CalculationWorkerReply;
  try { reply = { result: store.refreshCalculations() }; }
  catch (error) { reply = { error: error instanceof Error ? error.message : 'Clock calculation failed.' }; }
  port.postMessage(reply);
});
