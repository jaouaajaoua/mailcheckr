import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from "@nestjs/common";
import { ApiError } from "../common/errors";
import { REPOSITORY, type Repository } from "../repositories/repository";
import { AuthService } from "./auth.service";
import { ApiKeysService } from "../api-keys/api-keys.service";

export const IS_PUBLIC = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface AuthContext {
  userId: string | null;
  workspaceId: string;
  via: "jwt" | "api_key";
  apiKeyId?: string;
  scopes: string[];
}

/**
 * Authenticates either a dashboard JWT (Bearer <jwt>) or an API key
 * (Bearer mc_live_<secret>). workspaceId ALWAYS comes from the verified
 * credential — never from request input (tenant isolation, PRD §7/§10).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ApiKeysService) private readonly apiKeys: ApiKeysService,
    @Inject(REPOSITORY) private readonly repo: Repository,
  ) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<any>();
    const handler = ctx.getHandler() as any;
    const cls = ctx.getClass() as any;
    const isPublic = Reflect.getMetadata(IS_PUBLIC, handler) || Reflect.getMetadata(IS_PUBLIC, cls);
    if (isPublic) return true;
    const header: string = req.headers?.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) throw new ApiError("UNAUTHORIZED", "Missing Authorization bearer token.", 401);
    if (token.startsWith("mc_live_")) {
      const key = await this.apiKeys.authenticate(token);
      if (!key) throw new ApiError("UNAUTHORIZED", "Invalid or revoked API key.", 401);
      req.auth = { userId: null, workspaceId: key.workspaceId, via: "api_key", apiKeyId: key.id, scopes: key.scopes } satisfies AuthContext;
      return true;
    }
    const payload = this.auth.tokenService.verify(token);
    if (!payload) throw new ApiError("UNAUTHORIZED", "Invalid or expired session token.", 401);
    // Confirm the workspace still belongs to the token's user.
    const ws = await this.repo.findWorkspaceById(payload.workspaceId);
    if (!ws || ws.ownerUserId !== payload.sub) throw new ApiError("UNAUTHORIZED", "Session workspace mismatch.", 401);
    req.auth = { userId: payload.sub, workspaceId: payload.workspaceId, via: "jwt", scopes: ["*"] } satisfies AuthContext;
    return true;
  }
}
