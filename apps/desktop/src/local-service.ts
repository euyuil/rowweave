import { utilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import type { Connection } from '../../../packages/client/src/http-client.js';

export interface LocalService {
  connection: Connection;
  stop(): Promise<void>;
}

export async function startLocalService(entry: string, database: string, onExit: (service: LocalService) => void): Promise<LocalService> {
  const token = randomBytes(32).toString('hex');
  const child = utilityProcess.fork(entry, [], { serviceName: 'RowWeave data service',
    env: { ...process.env, ROWWEAVE_DB: database, ROWWEAVE_TOKEN: token }, stdio: 'pipe' });
  child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
  let exited = false;
  let stopping: Promise<void> | undefined;
  let service: LocalService | undefined;
  child.once('exit', () => { exited = true; if (service) onExit(service); });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Data service startup timed out.')), 30_000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Data service exited with code ${code}.`)); });
      child.once('message', (message: unknown) => {
        clearTimeout(timer);
        const ready = message as { type?: string; url?: string };
        if (ready.type !== 'ready' || !ready.url?.match(/^http:\/\/127\.0\.0\.1:\d+$/)) reject(new Error('Invalid data service startup response.'));
        else resolve(ready.url);
      });
    });
    service = { connection: { url, token }, stop: () => {
      if (exited) return Promise.resolve();
      return stopping ??= new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 3_000);
        timer.unref();
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.postMessage('shutdown');
      });
    } };
    return service;
  } catch (error) { child.kill(); throw error; }
}
