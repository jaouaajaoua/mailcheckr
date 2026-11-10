import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { ApiError } from "../common/errors";
import { hmacDigest, safeEqual } from "../common/crypto";
import { APP_CONFIG, REPOSITORY, type ApiKeyRow, type Repository } from "../repositories/repository";

export const API_KEY_PREFIX = "mc_live_";
const DEFAULT_SCOPES = ["verify:read", "verify:write"];

/**
 * API keys (PRD §8.1): secret = `mc_live_` + 32 random bytes (base64url).
 * The full secret is returned ONCE at creation. Only an HMAC-SHA256 digest
 * (keyed with HMAC_KEY) and a display prefix are stored — never plaintext.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(APP_CONFIG) private readonly config: any,
  ) {}

  private hash(secret: string) { return hmacDigest(secret, this.config.HMAC_KEY); }

  async create(workspaceId: string, name: string, scopes: string[] = DEFAULT_SCOPES, actorId?: string) {
    if (!name?.trim()) throw new ApiError("VALIDATION_ERROR", "API key name is required.", 422);
    const secret = API_KEY_PREFIX + randomBytes(32).toString("base64url");
    const keyPrefix = secret.slice(0, API_KEY_PREFIX.length + 8);
    const row = await this.repo.createApiKey({
      workspaceId, name: name.trim(), keyPrefix, keyHash: this.hash(secret),
      scopes, expiresAt: null,
    });
    if (actorId) await this.repo.createAudit({ workspaceId, actorId, action: "api_key.create", resourceType: "api_key", resourceId: row.id, metadata: { keyPrefix } });
    // `secret` is shown once here and is unrecoverable afterwards.
    return { id: row.id, name: row.name, keyPrefix, scopes: row.scopes, secret, createdAt: row.createdAt };
  }

  async list(workspaceId: string) {
    const rows = await this.repo.listApiKeys(workspaceId);
    return rows.map((k) => ({ id: k.id, name: k.name, keyPrefix: k.keyPrefix, scopes: k.scopes, lastUsedAt: k.lastUsedAt, expiresAt: k.expiresAt, revokedAt: k.revokedAt, createdAt: k.createdAt }));
  }

  async revoke(workspaceId: string, id: string, actorId?: string) {
    const row = await this.repo.revokeApiKey(workspaceId, id);
    if (!row) throw new ApiError("NOT_FOUND", "API key not found.", 404);
    if (actorId) await this.repo.createAudit({ workspaceId, actorId, action: "api_key.revoke", resourceType: "api_key", resourceId: id, metadata: {} });
    return { id: row.id, revokedAt: row.revokedAt };
  }

  /** Authenticate a presented secret. Returns the key row or null. */
  async authenticate(secret: string): Promise<ApiKeyRow | null> {
    if (!secret?.startsWith(API_KEY_PREFIX)) return null;
    const prefix = secret.slice(0, API_KEY_PREFIX.length + 8);
    const candidates = await this.repo.findApiKeysByPrefix(prefix);
    const digest = this.hash(secret);
    for (const k of candidates) {
      if (k.revokedAt) continue;
      if (k.expiresAt && k.expiresAt.getTime() < Date.now()) continue;
      if (safeEqual(k.keyHash, digest)) { await this.repo.touchApiKey(k.id); return { ...k, lastUsedAt: new Date() }; }
    }
    return null;
  }
}
