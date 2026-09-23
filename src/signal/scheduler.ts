import { runtimeMetrics } from '../ops/metrics.js';

/** Coalesces token updates and bounds enrichment fan-out across tokens. */
export class EvaluationScheduler {
  private readonly pending = new Set<string>();
  private readonly queue: string[] = [];
  private active = 0;
  private readonly running = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly queuedAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly options: {
    concurrency: number;
    delayMs: number;
    run: (token: string) => Promise<unknown>;
    onError: (token: string, error: unknown) => void;
  }) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('Invalid evaluation concurrency');
  }

  schedule(token: string): void {
    if (this.stopped) return;
    // New trades arriving during async enrichment must get a final evaluation.
    if (this.running.has(token)) { this.dirty.add(token); return; }
    if (this.pending.has(token)) return;
    this.pending.add(token);
    this.queuedAt.set(token, performance.now());
    this.queue.push(token);
    if (this.timer === null && this.active < this.options.concurrency) {
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, this.options.delayMs);
    }
  }

  snapshot(): {pending:number;active:number;oldestWaitMs:number} {
    const now=performance.now();
    let oldest=now;
    for(const at of this.queuedAt.values())oldest=Math.min(oldest,at);
    return {pending:this.queue.length,active:this.active,oldestWaitMs:Math.max(0,now-oldest)};
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.pending.clear();
    this.dirty.clear();
    this.queuedAt.clear();
  }

  private pump(): void {
    while (!this.stopped && this.active < this.options.concurrency && this.queue.length > 0) {
      const token = this.queue.shift()!;
      const started = performance.now();
      runtimeMetrics.observe('evaluation.queue', started - this.queuedAt.get(token)!);
      this.queuedAt.delete(token);
      this.running.add(token);
      this.active++;
      void Promise.resolve().then(() => this.options.run(token))
        .catch(error => this.options.onError(token, error))
        .finally(() => {
          runtimeMetrics.observe('evaluation.run', performance.now() - started);
          this.active--;
          this.running.delete(token);
          this.pending.delete(token);
          if (this.dirty.delete(token)) this.schedule(token);
          this.pump();
        });
    }
  }
}
