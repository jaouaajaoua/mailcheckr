import { Body, Controller, Delete, Get, Inject, Req } from "@nestjs/common";
import { ApiError } from "../common/errors";
import { AccountService } from "./account.service";
import type { AuthContext } from "../auth/auth.guard";

@Controller("v1/account")
export class AccountController {
  constructor(@Inject(AccountService) private readonly account: AccountService) {}

  @Get("settings")
  settings(@Req() req: any) {
    const a = req.auth as AuthContext;
    return this.account.getSettings(a.workspaceId);
  }

  /**
   * DELETE /v1/account — verified purge (see AccountService).
   * The dashboard gates this behind typing DELETE and sends the request with
   * no body; API callers may additionally send { "confirmation": "DELETE" },
   * which is validated when present.
   */
  @Delete()
  remove(@Req() req: any, @Body() body: any) {
    const a = req.auth as AuthContext;
    const confirmation = body?.confirmation ?? body?.confirm;
    if (confirmation !== undefined && confirmation !== "DELETE") {
      throw new ApiError("VALIDATION_ERROR", 'Account deletion confirmation must be the string "DELETE".', 422);
    }
    return this.account.deleteAccount({ workspaceId: a.workspaceId, userId: a.userId, via: a.via });
  }
}
