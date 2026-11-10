import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { loadConfigWithDevDefaults } from "./config";
import { APP_CONFIG, REPOSITORY } from "./repositories/repository";
import { InMemoryRepository } from "./repositories/in-memory.repository";
import { PrismaRepository } from "./repositories/prisma.repository";
import { NodeDnsResolver } from "./verification/dns";
import { VerificationService } from "./verification/verification.service";
import { AuthService } from "./auth/auth.service";
import { ApiKeysService } from "./api-keys/api-keys.service";
import { BatchesService } from "./batches/batches.service";
import { AuthGuard } from "./auth/auth.guard";
import { ErrorEnvelopeFilter } from "./common/error.filter";
import { BATCH_RATE_LIMITER, RATE_LIMITER, RateLimiter } from "./common/rate-limit";
import { RetentionService } from "./retention/retention.service";
import { AuthController } from "./auth/auth.controller";
import { ApiKeysController } from "./api-keys/api-keys.controller";
import { VerificationsController } from "./verification/verifications.controller";
import { BatchesController } from "./batches/batches.controller";
import { UsageController } from "./usage/usage.controller";
import { AccountService } from "./account/account.service";
import { AccountController } from "./account/account.controller";
import { HealthController } from "./health/health.controller";
import { OpenApiController } from "./openapi/openapi.controller";

const config = loadConfigWithDevDefaults();

@Module({
  controllers: [AuthController, ApiKeysController, VerificationsController, BatchesController, UsageController, AccountController, HealthController, OpenApiController],
  providers: [
    { provide: APP_CONFIG, useValue: config },
    // Production: Prisma/PostgreSQL when DATABASE_URL is set.
    // Tests/dev sandbox (no Docker/Postgres): in-memory implementation of the same contract.
    { provide: REPOSITORY, useFactory: () => (process.env.DATABASE_URL ? new PrismaRepository() : new InMemoryRepository()) },
    { provide: RATE_LIMITER, useFactory: () => new RateLimiter(Number(process.env.RATE_LIMIT_SINGLE_PER_MIN ?? 60), Number(process.env.RATE_LIMIT_SINGLE_PER_MIN ?? 60) / 60) },
    // Batch creation: 5 per hour per workspace by default (PRD resource protection).
    { provide: BATCH_RATE_LIMITER, useFactory: () => { const perHour = Number(process.env.RATE_LIMIT_BATCH_PER_HOUR ?? 5); return new RateLimiter(perHour, perHour / 3600); } },
    { provide: VerificationService, useFactory: () => new VerificationService(new NodeDnsResolver()) },
    AuthService, ApiKeysService, BatchesService, RetentionService, AccountService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
  ],
})
export class AppModule {}
