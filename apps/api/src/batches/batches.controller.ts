import { Body, Controller, Delete, Get, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import { ApiError } from "../common/errors";
import { BatchesService } from "./batches.service";
import { BATCH_RATE_LIMITER, RateLimiter } from "../common/rate-limit";
import type { AuthContext } from "../auth/auth.guard";

@Controller("v1/batches")
export class BatchesController {
  constructor(@Inject(BatchesService) private readonly batches: BatchesService, @Inject(BATCH_RATE_LIMITER) private readonly batchLimiter: RateLimiter) {}

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const a = req.auth as AuthContext;
    const rate = this.batchLimiter.check(`batch-create:ws:${a.workspaceId}`);
    if (!rate.allowed) throw new ApiError("RATE_LIMITED", "Batch creation rate limit exceeded.", 429, rate.retryAfterSeconds);
    const created = await this.batches.createBatch({
      workspaceId: a.workspaceId, userId: a.userId,
      name: typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : null,
      emails: body?.emails, mode: body?.mode === "deep" ? "deep" : "quick",
      sourceType: "api", idempotencyKey: body?.idempotency_key,
    });
    // Process synchronously in the API-only runtime; in production the same
    // processing runs in the BullMQ worker (apps/worker) off the queue.
    return this.batches.processInline(a.workspaceId, created.id);
  }
  @Get()
  list(@Req() req: any, @Query("limit") limit?: string, @Query("offset") offset?: string) {
    const a = req.auth as AuthContext;
    return this.batches.listBatches(a.workspaceId, { limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined });
  }
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) { const a = req.auth as AuthContext; return this.batches.getBatch(a.workspaceId, id); }
  @Get(":id/results")
  results(@Req() req: any, @Param("id") id: string, @Query("cursor") cursor?: string, @Query("limit") limit?: string, @Query("status") status?: string) {
    const a = req.auth as AuthContext;
    return this.batches.getResults(a.workspaceId, id, { cursor, limit: limit ? Number(limit) : undefined, status });
  }
  @Post(":id/cancel")
  cancel(@Req() req: any, @Param("id") id: string) { const a = req.auth as AuthContext; return this.batches.cancel(a.workspaceId, id); }
  @Post(":id/export")
  async export(@Req() req: any, @Param("id") id: string, @Res() reply: any) {
    const a = req.auth as AuthContext;
    const csv = await this.batches.exportCsv(a.workspaceId, id);
    return reply.header("Content-Type", "text/csv").header("Content-Disposition", `attachment; filename="batch-${id}-results.csv"`).send(csv);
  }
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) { const a = req.auth as AuthContext; return this.batches.deleteBatch(a.workspaceId, id, a.userId ?? undefined); }
}
void ApiError;
