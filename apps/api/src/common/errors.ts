export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly retryAfterSeconds?: number) {
    super(message);
  }
}
export function errorEnvelope(code: string, message: string, requestId: string, retryAfterSeconds?: number) {
  return { error: { code, message, request_id: requestId, ...(retryAfterSeconds ? { retry_after_seconds: retryAfterSeconds } : {}) } };
}
