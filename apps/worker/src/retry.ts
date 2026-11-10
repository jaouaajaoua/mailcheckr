/** Bounded retry budget (PRD §11): at most `maxAttempts` total attempts
 * (default 3), exponential backoff with a cap. Only thrown errors are
 * retried — a *result* of unknown (e.g. DNS temporary failure) is a value,
 * not an exception, and is never retried by this helper. */
export interface RetryOptions { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; sleep?: (ms: number) => Promise<void>; }
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const base = opts.baseDelayMs ?? 200;
  const cap = opts.maxDelayMs ?? 5000;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); }
    catch (e) {
      lastError = e;
      if (attempt === maxAttempts) break;
      await sleep(Math.min(cap, base * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
