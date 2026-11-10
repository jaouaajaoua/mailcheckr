import { Inject, Injectable } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { ApiError } from "../common/errors";
import { sha256Hex } from "../common/crypto";
import { APP_CONFIG, REPOSITORY, type Repository } from "../repositories/repository";
import { CreditLedgerService } from "../credits/credit-ledger.service";
import { TokenService } from "./token.service";

export function normalizeEmail(email: string): string {
  const trimmed = String(email ?? "").trim();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return trimmed.toLowerCase();
  return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
}

@Injectable()
export class AuthService {
  private tokens: TokenService;
  constructor(
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(APP_CONFIG) private readonly config: any,
  ) { this.tokens = new TokenService(config.JWT_SECRET); }

  get tokenService() { return this.tokens; }

  async register(emailRaw: string, password: string, name?: string) {
    const email = normalizeEmail(emailRaw);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError("VALIDATION_ERROR", "A valid email address is required.", 422);
    if (!password || password.length < 10) throw new ApiError("VALIDATION_ERROR", "Password must be at least 10 characters.", 422);
    const existing = await this.repo.findUserByEmail(email);
    if (existing) throw new ApiError("EMAIL_ALREADY_REGISTERED", "An account with this email already exists.", 409);
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.repo.createUser({ email, passwordHash });
    const workspace = await this.repo.createWorkspace({ ownerUserId: user.id, name: name ?? `${email.split("@")[0]}'s workspace`, planCode: "free" });
    const credits = new CreditLedgerService(this.repo);
    await credits.grant(workspace.id, this.config.FREE_CREDITS_GRANT ?? 100, `grant:signup:${workspace.id}`, "Free tier signup grant");
    await this.repo.createAudit({ workspaceId: workspace.id, actorId: user.id, action: "auth.register", resourceType: "user", resourceId: user.id, metadata: {} });
    const token = this.tokens.issue({ userId: user.id, workspaceId: workspace.id, email });
    return { user: { id: user.id, email: user.email, workspace_id: workspace.id, created_at: user.createdAt }, workspace: { id: workspace.id, name: workspace.name, planCode: workspace.planCode }, accessToken: token, access_token: token };
  }

  async login(emailRaw: string, password: string) {
    const email = normalizeEmail(emailRaw);
    const user = await this.repo.findUserByEmail(email);
    // Same error for unknown user and wrong password — no account enumeration.
    if (!user || !user.passwordHash || !(await bcrypt.compare(password ?? "", user.passwordHash))) {
      throw new ApiError("INVALID_CREDENTIALS", "Email or password is incorrect.", 401);
    }
    const workspace = await this.repo.findWorkspaceByOwner(user.id);
    if (!workspace) throw new ApiError("WORKSPACE_NOT_FOUND", "No workspace exists for this account.", 500);
    const token = this.tokens.issue({ userId: user.id, workspaceId: workspace.id, email });
    await this.repo.createAudit({ workspaceId: workspace.id, actorId: user.id, action: "auth.login", resourceType: "user", resourceId: user.id, metadata: {} });
    return { user: { id: user.id, email: user.email, workspace_id: workspace.id, created_at: user.createdAt }, workspace: { id: workspace.id, name: workspace.name, planCode: workspace.planCode }, accessToken: token, access_token: token };
  }

  /** Current session user for GET /v1/auth/me (docs/api.md shape). */
  async getMe(userId: string) {
    const user = await this.repo.findUserById(userId);
    if (!user || user.deletedAt) throw new ApiError("UNAUTHORIZED", "Session user no longer exists.", 401);
    const workspace = await this.repo.findWorkspaceByOwner(user.id);
    if (!workspace) throw new ApiError("WORKSPACE_NOT_FOUND", "No workspace exists for this account.", 500);
    return { id: user.id, email: user.email, workspace_id: workspace.id, created_at: user.createdAt };
  }

  async logout(userId: string, workspaceId: string) {
    // Stateless JWT: logout is recorded for audit; clients discard the token.
    // (Server-side revocation list is a documented production hardening step.)
    await this.repo.createAudit({ workspaceId, actorId: userId, action: "auth.logout", resourceType: "user", resourceId: userId, metadata: {} });
    return { ok: true };
  }

  /**
   * Password reset request. The plaintext token is returned ONLY in
   * non-production (`devResetToken`) so the flow is testable locally.
   * In production a mail provider integration must deliver it — MailCheckr
   * itself never sends email (PRD non-goal), and this code does NOT fake-send:
   * without a provider the token is stored hashed and the response is generic.
   */
  async requestPasswordReset(emailRaw: string) {
    const email = normalizeEmail(emailRaw);
    const user = await this.repo.findUserByEmail(email);
    if (!user) return { ok: true }; // generic response — no enumeration
    const token = randomBytes(32).toString("base64url");
    await this.repo.createResetToken({ userId: user.id, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    const isProd = this.config.NODE_ENV === "production";
    return isProd ? { ok: true } : { ok: true, devResetToken: token };
  }

  async confirmPasswordReset(token: string, newPassword: string) {
    if (!newPassword || newPassword.length < 10) throw new ApiError("VALIDATION_ERROR", "Password must be at least 10 characters.", 422);
    const row = await this.repo.findResetTokenByHash(sha256Hex(token ?? ""));
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
      throw new ApiError("RESET_TOKEN_INVALID", "This password reset token is invalid or expired.", 400);
    }
    await this.repo.updateUserPassword(row.userId, await bcrypt.hash(newPassword, 12));
    await this.repo.markResetTokenUsed(row.id);
    return { ok: true };
  }
}
