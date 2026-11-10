/**
 * Log redaction (PRD §10/§12): structured logs must never contain plaintext
 * email addresses, API keys, passwords, or tokens. `redactForLog` deep-clones
 * a log object applying:
 * - key-based redaction for sensitive field names (password, token, secret,
 *   authorization, api_key, key_hash, email_ciphertext, ...)
 * - pattern redaction inside strings: email addresses are masked to
 *   `a***@domain`, `mc_live_...` secrets are masked to their prefix.
 */
const SENSITIVE_KEY = /password|passwd|secret|token|authorization|api[-_]?key|key[-_]?hash|password[-_]?hash|ciphertext|credential/i;
const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const API_KEY_RE = /mc_live_[A-Za-z0-9_-]+/g;

export function redactString(value: string): string {
  return value.replace(API_KEY_RE, "mc_live_[redacted]").replace(EMAIL_RE, "$1***@$2");
}

export function redactForLog<T>(input: T, depth = 0): T {
  if (depth > 6) return input;
  if (typeof input === "string") return redactString(input) as T;
  if (Array.isArray(input)) return input.map((v) => redactForLog(v, depth + 1)) as T;
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redactForLog(v, depth + 1);
    }
    return out as T;
  }
  return input;
}
