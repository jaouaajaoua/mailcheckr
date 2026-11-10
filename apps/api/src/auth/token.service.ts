import { createHmac, timingSafeEqual } from "node:crypto";

/** Minimal HS256 JWT implementation (issue + verify, constant-time signature
 * check, exp enforcement). Used for dashboard/session auth. */
export interface JwtPayload { sub: string; workspaceId: string; email: string; exp: number; iat: number; }
const b64 = (s: string) => Buffer.from(s).toString("base64url");
export class TokenService {
  constructor(private readonly secret: string) {}
  issue(input: { userId: string; workspaceId: string; email: string }, ttlSeconds = 7 * 24 * 3600): string {
    const now = Math.floor(Date.now() / 1000);
    const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64(JSON.stringify({ sub: input.userId, workspaceId: input.workspaceId, email: input.email, iat: now, exp: now + ttlSeconds }));
    const sig = createHmac("sha256", this.secret).update(`${header}.${payload}`).digest("base64url");
    return `${header}.${payload}.${sig}`;
  }
  verify(token: string): JwtPayload | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    const expected = createHmac("sha256", this.secret).update(`${header}.${payload}`).digest("base64url");
    const a = Buffer.from(sig); const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JwtPayload;
      if (!data.sub || !data.workspaceId || data.exp < Math.floor(Date.now() / 1000)) return null;
      return data;
    } catch { return null; }
  }
}
