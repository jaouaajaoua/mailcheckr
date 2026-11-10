/** In-memory token bucket rate limiter, keyed per workspace / API key (PRD §10.4).
 * Production multi-instance deployments should swap the store for Redis; the
 * bucket math and interface stay the same. */
export class TokenBucket {
  private tokens: number; private last: number;
  constructor(private readonly capacity: number, private readonly refillPerSecond: number, now = Date.now()) {
    this.tokens = capacity; this.last = now;
  }
  tryConsume(now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const elapsed = (now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.last = now;
    if (this.tokens >= 1) { this.tokens -= 1; return { allowed: true, retryAfterSeconds: 0 }; }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerSecond)) };
  }
}
export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  constructor(private readonly capacity = 60, private readonly refillPerSecond = 1) {}
  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    let b = this.buckets.get(key);
    if (!b) { b = new TokenBucket(this.capacity, this.refillPerSecond); this.buckets.set(key, b); }
    return b.tryConsume();
  }
}
export const RATE_LIMITER = "RATE_LIMITER";
export const BATCH_RATE_LIMITER = "BATCH_RATE_LIMITER";
