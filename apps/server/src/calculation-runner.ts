import { Worker } from 'node:worker_threads';
import type { CalculationRefresh } from '../../../packages/contracts/src/index.js';
import type { CalculationRunner } from './calculations.js';
import type { CalculationWorkerReply } from './calculation-worker.js';

export class CalculationWorker implements CalculationRunner {
  private worker: Worker | undefined;
  private pending: { resolve(value: CalculationRefresh): void; reject(error: Error): void } | undefined;

  constructor(private readonly database: string) {}

  refresh(): Promise<CalculationRefresh> {
    if (!this.worker) {
      const worker = new Worker(new URL('./calculation-worker.js', import.meta.url), { workerData: this.database, name: 'rowweave-calculation-worker' });
      this.worker = worker;
      let failure: Error | undefined;
      worker.on('message', (reply: CalculationWorkerReply) => {
        const pending = this.pending!;
        this.pending = undefined;
        if ('result' in reply) pending.resolve(reply.result);
        else pending.reject(new Error(reply.error));
      });
      worker.on('error', error => { failure = error; });
      worker.once('exit', code => {
        this.worker = undefined;
        this.pending?.reject(failure ?? new Error('The calculation worker exited with code ' + code + '.'));
        this.pending = undefined;
      });
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker!.postMessage('refresh');
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>(resolve => { worker.once('exit', () => resolve()); worker.postMessage('close'); });
  }
}
