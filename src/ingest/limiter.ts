export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

export interface TokenBucketOptions {
  /** 每秒补充的权重数（GMGN leaky bucket rate=20） */
  ratePerSecond: number;
  /** 突发容量（capacity=20） */
  capacity: number;
  clock?: Clock;
}

/**
 * 全局 Token Bucket：所有 GMGN 请求共享同一预算。
 * 权重按端点消耗（smartmoney/kol=1，follow=3，token=1，kline=2，wallet_stats=3 ...）。
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly queue: Array<{ weight: number; resolve: () => void }> = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly clock: Clock;

  constructor(private readonly opts: TokenBucketOptions) {
    if (!Number.isFinite(opts.ratePerSecond) || opts.ratePerSecond <= 0 ||
        !Number.isFinite(opts.capacity) || opts.capacity <= 0) {
      throw new Error('TokenBucket ratePerSecond/capacity must be finite and positive');
    }
    this.clock = opts.clock ?? realClock;
    this.tokens = opts.capacity;
    this.lastRefillMs = this.clock.now();
  }

  /** Fixed burst capacity, used to reserve feasible background headroom. */
  get capacity(): number { return this.opts.capacity; }

  /** 当前可用权重（含补算） */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  /** 同步尝试获取；失败不排队（测试与快速路径用） */
  tryAcquire(weight = 1): boolean {
    this.validateWeight(weight);
    this.refill();
    if (this.queue.length === 0 && this.tokens >= weight) {
      this.tokens -= weight;
      return true;
    }
    return false;
  }

  /** 异步获取：不足时排队，按补充速率唤醒 */
  acquire(weight = 1): Promise<void> {
    this.validateWeight(weight);
    this.refill();
    if (this.queue.length === 0 && this.tokens >= weight) {
      this.tokens -= weight;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ weight, resolve });
      this.schedulePump();
    });
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = now - this.lastRefillMs;
    if (elapsed <= 0) return;
    const gained = (elapsed / 1000) * this.opts.ratePerSecond;
    this.tokens = Math.min(this.opts.capacity, this.tokens + gained);
    this.lastRefillMs = now;
  }

  private validateWeight(weight: number): void {
    if (!Number.isFinite(weight) || weight <= 0 || weight > this.opts.capacity) {
      throw new Error('TokenBucket weight must be positive and no greater than capacity');
    }
  }

  private schedulePump(): void {
    if (this.timer) return;
    const head = this.queue[0];
    if (!head) return;
    this.refill();
    const deficit = head.weight - this.tokens;
    const waitMs = deficit <= 0 ? 0 : Math.ceil((deficit / this.opts.ratePerSecond) * 1000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, waitMs);
  }

  private pump(): void {
    this.refill();
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (!head || this.tokens < head.weight) break;
      this.tokens -= head.weight;
      this.queue.shift();
      head.resolve();
    }
    if (this.queue.length > 0) this.schedulePump();
  }
}

/** 429 / 封禁状态门：封禁期内所有请求等待，恢复后放行 */
export class BanGate {
  private bannedUntilMs = 0;
  private reason: string | null = null;
  private readonly clock: Clock;

  constructor(clock: Clock = realClock) {
    this.clock = clock;
  }

  get isBanned(): boolean {
    return this.bannedUntilMs > this.clock.now();
  }

  get bannedUntil(): number | null {
    return this.isBanned ? this.bannedUntilMs : null;
  }

  get banReason(): string | null {
    return this.isBanned ? this.reason : null;
  }

  /** 延长封禁（取更晚的截止时间）；封禁期零重试，恢复后由调用方回补 */
  banUntil(untilMs: number, reason: string): void {
    if (untilMs <= this.bannedUntilMs) return;
    this.bannedUntilMs = untilMs;
    this.reason = reason;
  }

  async waitIfBanned(): Promise<void> {
    while (this.isBanned) {
      await this.clock.sleep(this.bannedUntilMs - this.clock.now());
    }
  }
}
