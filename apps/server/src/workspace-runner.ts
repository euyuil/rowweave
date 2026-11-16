import { Worker } from 'node:worker_threads';
import type { CalculationRefresh } from '../../../packages/contracts/src/index.js';
import type { CheckpointResult } from '../../../packages/storage-sqlite/src/record-store.js';
import type { CalculationRunner } from './calculations.js';
import type { WorkspaceWorkerReply } from './workspace-worker.js';

interface Pending<T> { resolve(value: T): void; reject(error: Error): void }

export class WorkspaceWorker implements CalculationRunner {
  private worker: Worker | undefined;
  private ready: Promise<void> | undefined;
  private refreshPending: Pending<CalculationRefresh> | undefined;
  private checkpointPending: Pending<CheckpointResult> | undefined;
  private refreshing: Promise<CalculationRefresh> | undefined;
  private checkpointing: Promise<CheckpointResult> | undefined;
  private checkpointRequested = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly database: string, private readonly onFailure?: (error: Error) => void) {}

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL('./workspace-worker.js', import.meta.url), { workerData: this.database, name: 'rowweave-workspace-worker' });
      this.worker = worker;
      let failure: Error | undefined;
      worker.on('message', (reply: WorkspaceWorkerReply) => {
        if (reply.command === 'ready') { resolve(); return; }
        if (reply.command === 'refresh') {
          const pending = this.refreshPending!; this.refreshPending = undefined;
          if ('result' in reply) pending.resolve(reply.result);
          else pending.reject(new Error(reply.error));
        } else {
          const pending = this.checkpointPending!; this.checkpointPending = undefined;
          if ('result' in reply) pending.resolve(reply.result);
          else pending.reject(new Error(reply.error));
        }
      });
      worker.on('error', error => { failure = error; });
      worker.once('exit', code => {
        this.worker = undefined; this.ready = undefined;
        const error = failure ?? new Error('The workspace worker exited with code ' + code + '.');
        reject(error);
        this.refreshPending?.reject(error); this.refreshPending = undefined;
        this.checkpointPending?.reject(error); this.checkpointPending = undefined;
        if (!this.closing) this.onFailure?.(error);
      });
    });
    return this.ready;
  }

  refresh(): Promise<CalculationRefresh> {
    if (this.closing) return Promise.reject(new Error('The workspace worker is closing.'));
    if (!this.refreshing) this.refreshing = this.refreshOnce().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async refreshOnce(): Promise<CalculationRefresh> {
    await this.start();
    return new Promise((resolve, reject) => {
      this.refreshPending = { resolve, reject };
      this.worker!.postMessage('refresh');
    });
  }

  checkpoint(): Promise<CheckpointResult> {
    if (this.closing) return Promise.reject(new Error('The workspace worker is closing.'));
    this.checkpointRequested = true;
    if (!this.checkpointing) this.checkpointing = this.runCheckpoints();
    return this.checkpointing;
  }

  private async runCheckpoints(): Promise<CheckpointResult> {
    try {
      let result: CheckpointResult;
      do {
        this.checkpointRequested = false;
        await this.start();
        result = await new Promise<CheckpointResult>((resolve, reject) => {
          this.checkpointPending = { resolve, reject };
          this.worker!.postMessage('checkpoint');
        });
      } while (this.checkpointRequested);
      return result;
    } finally { this.checkpointing = undefined; }
  }

  close(): Promise<void> {
    return this.closing ??= this.stop();
  }

  private async stop(): Promise<void> {
    if (this.refreshing) await this.refreshing.catch(() => undefined);
    if (this.checkpointing) await this.checkpointing.catch(() => undefined);
    if (this.ready) await this.ready.catch(() => undefined);
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>(resolve => { worker.once('exit', () => resolve()); worker.postMessage('close'); });
  }
}
