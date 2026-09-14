/** Coalesces token updates and bounds enrichment fan-out across tokens. */
export class EvaluationScheduler {
  private readonly pending = new Set<string>();
  private readonly queue: string[] = [];
  private active = 0;
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
    if (this.stopped || this.pending.has(token)) return;
    this.pending.add(token);
    this.queue.push(token);
    if (this.timer === null && this.active < this.options.concurrency) {
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, this.options.delayMs);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.pending.clear();
  }

  private pump(): void {
    while (!this.stopped && this.active < this.options.concurrency && this.queue.length > 0) {
      const token = this.queue.shift()!;
      this.active++;
      void Promise.resolve().then(() => this.options.run(token))
        .catch(error => this.options.onError(token, error))
        .finally(() => {
          this.active--;
          this.pending.delete(token);
          this.pump();
        });
    }
  }
}
