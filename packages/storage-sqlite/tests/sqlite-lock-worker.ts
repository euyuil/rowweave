import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(workerData as string);
db.exec('PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;');
parentPort!.postMessage('locked');
parentPort!.once('message', () => {
  setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);
});
