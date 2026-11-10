import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { ApiKeysService } from "./api-keys.service";
import type { AuthContext } from "../auth/auth.guard";

@Controller("v1/api-keys")
export class ApiKeysController {
  constructor(@Inject(ApiKeysService) private readonly keys: ApiKeysService) {}
  @Post()
  create(@Req() req: any, @Body() body: any) {
    const a = req.auth as AuthContext;
    return this.keys.create(a.workspaceId, body?.name ?? "", Array.isArray(body?.scopes) ? body.scopes : undefined, a.userId ?? undefined);
  }
  @Get()
  list(@Req() req: any) { const a = req.auth as AuthContext; return this.keys.list(a.workspaceId); }
  @Delete(":id")
  revoke(@Req() req: any, @Param("id") id: string) {
    const a = req.auth as AuthContext;
    return this.keys.revoke(a.workspaceId, id, a.userId ?? undefined);
  }
}
