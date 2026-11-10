import { Body, Controller, Get, Inject, Post, Req } from "@nestjs/common";
import { ApiError } from "../common/errors";
import { AuthService } from "./auth.service";
import { Public, type AuthContext } from "./auth.guard";

/** Auth routes live under the versioned PRD prefix: /v1/auth/* (the web
 *  client and docs/api.md have always called them there). */
@Controller("v1/auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public() @Post("register")
  register(@Body() body: any) {
    if (!body?.email || !body?.password) throw new ApiError("VALIDATION_ERROR", "email and password are required.", 422);
    return this.auth.register(body.email, body.password, body.name);
  }
  @Public() @Post("login")
  login(@Body() body: any) {
    if (!body?.email || !body?.password) throw new ApiError("VALIDATION_ERROR", "email and password are required.", 422);
    return this.auth.login(body.email, body.password);
  }
  @Post("logout")
  logout(@Req() req: any) { const a = req.auth as AuthContext; return this.auth.logout(a.userId ?? "", a.workspaceId); }
  @Get("me")
  me(@Req() req: any) {
    const a = req.auth as AuthContext;
    if (!a.userId) throw new ApiError("UNAUTHORIZED", "A user session is required for this endpoint.", 401);
    return this.auth.getMe(a.userId);
  }
  @Public() @Post("password-reset/request")
  resetRequest(@Body() body: any) { return this.auth.requestPasswordReset(body?.email ?? ""); }
  @Public() @Post("password-reset/confirm")
  resetConfirm(@Body() body: any) {
    if (!body?.token || !body?.password) throw new ApiError("VALIDATION_ERROR", "token and password are required.", 422);
    return this.auth.confirmPasswordReset(body.token, body.password);
  }
}
