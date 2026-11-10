/**
 * Domain-level throttling for verification (PRD §5.4/§10.3/§11):
 * - at most `maxConcurrentPerDomain` (default 2) verifications in flight
 *   per normalized domain;
 * - a per-MX/domain cooldown map: after a failure, the domain cools down
 *   for `cooldownMs` (default 60s) before new probes are admitted.
 */
export class DomainThrottle {
  private inFlight = new Map<string, number>();
  private waiters = new Map<string, (() => void)[]>();
  private cooldownUntil = new Map<string, number>();
  constructor(private readonly maxConcurrentPerDomain = 2, private readonly cooldownMs = 60_000) {}

  isCoolingDown(domain: string, now = Date.now()): boolean {
    const until = this.cooldownUntil.get(domain);
    return until != null && until > now;
  }
  markFailure(domain: string, now = Date.now()): void { this.cooldownUntil.set(domain, now + this.cooldownMs); }
  markSuccess(domain: string): void { this.cooldownUntil.delete(domain); }
  inFlightCount(domain: string): number { return this.inFlight.get(domain) ?? 0; }

  async acquire(domain: string): Promise<void> {
    if (this.inFlightCount(domain) < this.maxConcurrentPerDomain) {
      this.inFlight.set(domain, this.inFlightCount(domain) + 1);
      return;
    }
    await new Promise<void>((resolve) => {
      const q = this.waiters.get(domain) ?? [];
      q.push(resolve);
      this.waiters.set(domain, q);
    });
    this.inFlight.set(domain, this.inFlightCount(domain) + 1);
  }
  release(domain: string): void {
    const next = Math.max(0, this.inFlightCount(domain) - 1);
    this.inFlight.set(domain, next);
    const q = this.waiters.get(domain);
    if (q && q.length > 0 && next < this.maxConcurrentPerDomain) {
      const resolve = q.shift()!;
      resolve();
    }
  }
  /** Run fn under the per-domain concurrency limit. */
  async run<T>(domain: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(domain);
    try { return await fn(); } finally { this.release(domain); }
  }
}
