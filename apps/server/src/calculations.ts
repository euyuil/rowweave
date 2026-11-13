import type { CalculationRefresh, CalculationStatus } from '../../../packages/contracts/src/index.js';
import { ServiceError } from '../../../packages/core/src/errors.js';

export interface CalculationRunner {
  refresh(): Promise<CalculationRefresh>;
  close(): Promise<void>;
}

export class Calculations {
  private readonly state: CalculationStatus;
  private active: Promise<CalculationRefresh> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;

  constructor(private readonly runner: CalculationRunner, automatic: boolean) {
    this.state = { automatic, running: false };
  }

  start(): void {
    if (!this.state.automatic) return;
    const tick = () => { void this.refresh().catch(error => console.error('Clock calculation failed:', error)); };
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
    tick();
  }

  status(): CalculationStatus { return { ...this.state }; }

  refresh(): Promise<CalculationRefresh> {
    if (this.stopping) return Promise.reject(new ServiceError('SERVICE_CLOSING', 'The service is closing.', 503));
    if (this.active) return this.active;
    this.state.running = true;
    this.state.startedAt = new Date().toISOString();
    delete this.state.lastError;
    this.active = Promise.resolve().then(() => this.runner.refresh()).then(result => {
      this.state.lastResult = result;
      return result;
    }, error => {
      this.state.lastError = error instanceof Error ? error.message : 'Clock calculation failed.';
      throw new ServiceError('CALCULATION_FAILED', this.state.lastError, 500);
    }).finally(() => {
      this.state.running = false;
      this.state.completedAt = new Date().toISOString();
      this.active = undefined;
    });
    return this.active;
  }

  async write<T>(operation: () => T): Promise<T> {
    if (this.stopping) throw new ServiceError('SERVICE_CLOSING', 'The service is closing.', 503);
    // A failed calculation has rolled back; allow accepted writes to fix the workspace.
    while (this.active) await this.active.catch(() => undefined);
    return operation();
  }

  stop(): void {
    this.stopping = true;
    clearInterval(this.timer);
  }

  async close(): Promise<void> {
    this.stop();
    if (this.active) await this.active.catch(() => undefined);
    await this.runner.close();
  }
}
