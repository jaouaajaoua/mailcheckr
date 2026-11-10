/**
 * MailCheckr API client.
 *
 * - Base URL: NEXT_PUBLIC_API_URL (default http://localhost:4000), versioned under /v1.
 * - Auth: JWT access token stored in localStorage under `mc_token`. The token is
 *   obtained from POST /v1/auth/login or /v1/auth/register. API keys (mc_live_…)
 *   are for server-to-server use and are never used by this browser client.
 * - Errors: the API returns the envelope
 *     { "error": { "code", "message", "request_id", "retry_after_seconds"? } }
 *   which this client surfaces as an ApiError with the server's code/message.
 */

export const API_BASE: string =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:4000";

const TOKEN_KEY = "mc_token";
const USER_KEY = "mc_user";

export class ApiError extends Error {
  code: string;
  status: number;
  requestId?: string;
  retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, requestId?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
}

export interface SessionUser {
  id: string;
  email: string;
  workspace_id?: string;
  created_at?: string;
}

export function getStoredUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

function storeUser(user: SessionUser): void {
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
    retry_after_seconds?: number;
  };
}

async function parseError(res: Response): Promise<ApiError> {
  let body: ErrorEnvelope | null = null;
  try {
    body = (await res.json()) as ErrorEnvelope;
  } catch {
    body = null;
  }
  const err = body?.error;
  return new ApiError(
    res.status,
    err?.code ?? `HTTP_${res.status}`,
    err?.message ?? `Request failed with status ${res.status}.`,
    err?.request_id,
    err?.retry_after_seconds,
  );
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", `Could not reach the API at ${API_BASE}. Is the API service running?`);
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Raw authenticated fetch for non-JSON responses (CSV export downloads). */
export async function apiFetchRaw(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", `Could not reach the API at ${API_BASE}. Is the API service running?`);
  }
  if (!res.ok) throw await parseError(res);
  return res;
}

/** Normalises list endpoints that return either an array or { data: [...] }. */
export function asList<T>(payload: T[] | { data?: T[]; items?: T[] } | null | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

export function newIdempotencyKey(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rand}`;
}

// ---------------------------------------------------------------------------
// Domain types (mirror docs/api.md and packages/contracts)
// ---------------------------------------------------------------------------

export type VerificationMode = "quick" | "deep";
export type VerificationStatus =
  | "valid"
  | "likely_valid"
  | "invalid"
  | "risky"
  | "unknown"
  | "duplicate";
export type Confidence = "high" | "medium" | "low";

export interface VerificationResult {
  id: string;
  email?: string;
  domain?: string;
  status: VerificationStatus;
  mode: VerificationMode;
  confidence: Confidence;
  reason_codes: string[];
  explanation: string;
  checks?: Record<string, string>;
  checks_performed?: Record<string, unknown> | string[];
  checked_at?: string;
  created_at?: string;
}

export type BatchStatus =
  | "created"
  | "queued"
  | "processing"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled"
  | "expired";

export interface Batch {
  id: string;
  name?: string | null;
  source_type?: string;
  mode: VerificationMode;
  status: BatchStatus;
  row_count?: number;
  unique_count?: number;
  duplicate_count?: number;
  completed_count?: number;
  invalid_count?: number;
  risky_count?: number;
  unknown_count?: number;
  credits_reserved?: number;
  credits_charged?: number;
  credits_refunded?: number;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  expires_at?: string | null;
}

export interface BatchResultRow {
  id: string;
  row_number?: number;
  email?: string;
  status: VerificationStatus;
  confidence?: Confidence;
  reason_codes?: string[];
  explanation?: string;
  is_duplicate?: boolean;
  duplicate_of_row_number?: number | null;
  checked_at?: string;
}

export interface Usage {
  workspace_id?: string;
  credits_balance?: number;
  balance?: number;
  credits_granted?: number;
  credits_reserved?: number;
  credits_charged?: number;
  credits_used?: number;
  checks_this_month?: number;
  checks_total?: number;
  period_start?: string;
  period_end?: string;
  plan_code?: string;
  [key: string]: unknown;
}

export interface LedgerEntry {
  id: string;
  entry_type: string;
  quantity: number;
  description?: string | null;
  batch_id?: string | null;
  created_at?: string;
}

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes?: string[];
  last_used_at?: string | null;
  expires_at?: string | null;
  revoked_at?: string | null;
  created_at?: string;
}

export interface CreatedApiKey extends ApiKey {
  /** Full secret. Returned exactly once by POST /v1/api-keys. */
  secret: string;
}

export interface WorkspaceSettings {
  workspace_id?: string;
  /** Hours the raw uploaded source file is kept after processing. */
  source_retention_hours?: number;
  source_retention_days?: number;
  /** Days verification results are kept before automatic expiry. */
  result_retention_days?: number;
  plan_code?: string;
  [key: string]: unknown;
}

interface AuthResponse {
  access_token: string;
  token?: string;
  user: SessionUser;
}

// ---------------------------------------------------------------------------
// Endpoint wrappers — every UI control in this app calls one of these.
// ---------------------------------------------------------------------------

export const api = {
  async register(email: string, password: string): Promise<SessionUser> {
    const res = await apiFetch<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setToken(res.access_token ?? res.token ?? "");
    storeUser(res.user);
    return res.user;
  },

  async login(email: string, password: string): Promise<SessionUser> {
    const res = await apiFetch<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setToken(res.access_token ?? res.token ?? "");
    storeUser(res.user);
    return res.user;
  },

  async logout(): Promise<void> {
    try {
      await apiFetch<void>("/auth/logout", { method: "POST" });
    } finally {
      clearSession();
    }
  },

  me(): Promise<SessionUser> {
    return apiFetch<SessionUser>("/auth/me");
  },

  requestPasswordReset(email: string): Promise<{ ok?: boolean }> {
    return apiFetch("/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  },

  usage(): Promise<Usage> {
    return apiFetch<Usage>("/usage");
  },

  ledger(limit = 50): Promise<LedgerEntry[] | { data: LedgerEntry[] }> {
    return apiFetch(`/credits/ledger?limit=${limit}`);
  },

  recentVerifications(limit = 10): Promise<VerificationResult[] | { data: VerificationResult[] }> {
    return apiFetch(`/verifications?limit=${limit}`);
  },

  verify(email: string, mode: VerificationMode): Promise<VerificationResult> {
    return apiFetch<VerificationResult>("/verifications", {
      method: "POST",
      body: JSON.stringify({ email, mode, idempotency_key: newIdempotencyKey("verify") }),
    });
  },

  listBatches(limit = 50): Promise<Batch[] | { data: Batch[] }> {
    return apiFetch(`/batches?limit=${limit}`);
  },

  createBatch(name: string, emails: string[], mode: VerificationMode): Promise<Batch> {
    return apiFetch<Batch>("/batches", {
      method: "POST",
      body: JSON.stringify({ name, emails, mode, webhook_url: null, idempotency_key: newIdempotencyKey("batch") }),
    });
  },

  getBatch(id: string): Promise<Batch> {
    return apiFetch<Batch>(`/batches/${encodeURIComponent(id)}`);
  },

  batchResults(
    id: string,
    opts: { status?: string; limit?: number; cursor?: string } = {},
  ): Promise<BatchResultRow[] | { data: BatchResultRow[]; next_cursor?: string | null }> {
    const qs = new URLSearchParams();
    qs.set("limit", String(opts.limit ?? 100));
    if (opts.status) qs.set("status", opts.status);
    if (opts.cursor) qs.set("cursor", opts.cursor);
    return apiFetch(`/batches/${encodeURIComponent(id)}/results?${qs.toString()}`);
  },

  cancelBatch(id: string): Promise<Batch> {
    return apiFetch<Batch>(`/batches/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  },

  deleteBatch(id: string): Promise<void> {
    return apiFetch<void>(`/batches/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  /**
   * POST /v1/batches/:id/export — the API either returns a JSON body with a
   * download URL or streams the CSV directly; both are handled here and the
   * file is saved via a temporary anchor download.
   */
  async exportBatch(id: string, statuses?: string[]): Promise<void> {
    const res = await apiFetchRaw(`/batches/${encodeURIComponent(id)}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(statuses && statuses.length > 0 ? { statuses } : {}),
    });
    const contentType = res.headers.get("content-type") ?? "";
    let blob: Blob;
    let filename = `mailcheckr-batch-${id}.csv`;
    if (contentType.includes("application/json")) {
      const body = (await res.json()) as { download_url?: string; url?: string };
      const url = body.download_url ?? body.url;
      if (!url) throw new ApiError(502, "EXPORT_NO_URL", "The export endpoint did not return a download URL.");
      const fileRes = await fetch(url);
      if (!fileRes.ok) throw new ApiError(fileRes.status, "EXPORT_DOWNLOAD_FAILED", "Could not download the exported file.");
      blob = await fileRes.blob();
    } else {
      blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = disposition.match(/filename="?([^";]+)"?/);
      if (match) filename = match[1];
    }
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  listApiKeys(): Promise<ApiKey[] | { data: ApiKey[] }> {
    return apiFetch("/api-keys");
  },

  createApiKey(name: string, scopes: string[]): Promise<CreatedApiKey> {
    return apiFetch<CreatedApiKey>("/api-keys", {
      method: "POST",
      body: JSON.stringify({ name, scopes }),
    });
  },

  revokeApiKey(id: string): Promise<void> {
    return apiFetch<void>(`/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  /** Workspace settings incl. the retention actually in force: GET /v1/account/settings. */
  getSettings(): Promise<WorkspaceSettings> {
    return apiFetch<WorkspaceSettings>("/account/settings");
  },

  /** Account deletion request: DELETE /v1/account (server schedules erasure). */
  requestAccountDeletion(): Promise<{ status?: string; message?: string }> {
    return apiFetch("/account", { method: "DELETE" });
  },
};
