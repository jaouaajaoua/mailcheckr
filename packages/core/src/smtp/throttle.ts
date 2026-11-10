/**
 * Per-domain connection throttle (resource protection).
 *
 * Bounds how many SMTP probes may run CONCURRENTLY against one
 * recipient domain, so a bulk job (or an abusive tenant) cannot open
 * an unbounded number of connections to a single mail operator.
 * Excess acquirers wait in a per-domain FIFO queue; a waiter that
 * cannot get a slot within `queueTimeoutMs` fails fast with
 * DomainThrottleTimeoutError instead of piling up without bound.
 *
 * In-process only: in the deployed worker this complements (does not
 * replace) BullMQ concurrency limits and per-MX cooldowns.
 */

export class DomainThrottleTimeoutError extends Error {
  readonly domain: string;
  constructor(domain: string, queueTimeoutMs: number) {
    super(`Timed out after ${queueTimeoutMs}ms waiting for a per-domain probe slot for ${domain}`);
    this.name = "DomainThrottleTimeoutError";
    this.domain = domain;
  }
}

export interface DomainThrottleOptions {
  /** Max simultaneous probes per domain. Default 2. */
  maxConcurrentPerDomain?: number;
  /** Max time an acquire() may queue before failing. Default 30s. */
  queueTimeoutMs?: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

export type ThrottleRelease = () => void;

export class DomainThrottle {
  private readonly maxConcurrent: number;
  private readonly queueTimeoutMs: number;
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, Waiter[]>();

  constructor(options: DomainThrottleOptions = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrentPerDomain ?? 2));
    this.queueTimeoutMs = Math.max(0, Math.floor(options.queueTimeoutMs ?? 30_000));
  }

  private key(domain: string): string {
    return domain.trim().toLowerCase();
  }

  activeCount(domain: string): number {
    return this.active.get(this.key(domain)) ?? 0;
  }

  queuedCount(domain: string): number {
    return this.queues.get(this.key(domain))?.filter((w) => !w.settled).length ?? 0;
  }

  /** Take a slot immediately if one is free; otherwise return null. */
  tryAcquire(domain: string): ThrottleRelease | null {
    const key = this.key(domain);
    if ((this.active.get(key) ?? 0) >= this.maxConcurrent) return null;
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    return this.makeRelease(key);
  }

  /**
   * Acquire a slot for `domain`, queueing FIFO if the domain is at its
   * concurrency cap. Resolves with an idempotent release function.
   * Rejects with DomainThrottleTimeoutError after queueTimeoutMs.
   */
  acquire(domain: string): Promise<ThrottleRelease> {
    const immediate = this.tryAcquire(domain);
    if (immediate) return Promise.resolve(immediate);
    const key = this.key(domain);
    return new Promise<ThrottleRelease>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        settled: false,
        timer: setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.removeWaiter(key, waiter);
          reject(new DomainThrottleTimeoutError(key, this.queueTimeoutMs));
        }, this.queueTimeoutMs),
      };
      const queue = this.queues.get(key) ?? [];
      queue.push(waiter);
      this.queues.set(key, queue);
    });
  }

  /** Run `fn` while holding a slot for `domain`; always releases. */
  async run<T>(domain: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(domain);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private removeWaiter(key: string, waiter: Waiter): void {
    const queue = this.queues.get(key);
    if (!queue) return;
    const next = queue.filter((w) => w !== waiter);
    if (next.length === 0) this.queues.delete(key);
    else this.queues.set(key, next);
  }

  private makeRelease(key: string): ThrottleRelease {
    let released = false;
    return () => {
      if (released) return; // idempotent: double release must not over-admit
      released = true;
      const remaining = (this.active.get(key) ?? 1) - 1;
      if (remaining > 0) this.active.set(key, remaining);
      else this.active.delete(key);
      this.pump(key);
    };
  }

  /** Hand freed capacity to the longest-waiting queued acquirer. */
  private pump(key: string): void {
    const queue = this.queues.get(key);
    if (!queue) return;
    while ((this.active.get(key) ?? 0) < this.maxConcurrent) {
      const waiter = queue.find((w) => !w.settled);
      if (!waiter) break;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      this.removeWaiter(key, waiter);
      this.active.set(key, (this.active.get(key) ?? 0) + 1);
      waiter.resolve(this.makeRelease(key));
    }
    if ((this.queues.get(key) ?? []).length === 0) this.queues.delete(key);
  }
}
