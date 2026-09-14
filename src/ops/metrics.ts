/** Numeric-only runtime telemetry. Never use addresses, credentials or error text as labels. */
export class RuntimeMetrics {
  private readonly values = new Map<string, { count: number; sum: number; max: number; samples: number[]; next: number }>();
  constructor(private readonly sampleLimit = 2048) {
    if (!Number.isInteger(sampleLimit) || sampleLimit < 1) throw new Error('Invalid sample limit');
  }
  observe(name: string, milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    let row = this.values.get(name);
    if (!row) {
      if (this.values.size >= 128) return;
      row = { count: 0, sum: 0, max: 0, samples: [], next: 0 };
      this.values.set(name, row);
    }
    row.count++;
    row.sum += milliseconds;
    row.max = Math.max(row.max, milliseconds);
    row.samples[row.next] = milliseconds;
    row.next = (row.next + 1) % this.sampleLimit;
  }
  snapshot(): Record<string, { count: number; meanMs: number; maxMs: number; sampleCount: number; p50Ms: number; p95Ms: number }> {
    return Object.fromEntries([...this.values].map(([name, row]) => {
      const sorted = [...row.samples].sort((a, b) => a - b);
      const rounded = (value: number): number => Math.round(value * 100) / 100;
      const percentile = (p: number): number => rounded(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!);
      return [name, { count: row.count, meanMs: rounded(row.sum / row.count), maxMs: rounded(row.max),
        sampleCount: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95) }];
    }));
  }
}

export const runtimeMetrics = new RuntimeMetrics();

export async function measureAsync<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await operation(); }
  finally { runtimeMetrics.observe(name, performance.now() - start); }
}
