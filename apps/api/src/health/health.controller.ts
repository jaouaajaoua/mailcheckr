import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/auth.guard";

/** Liveness probe used by the docker-compose healthcheck (GET /health).
 *  Deliberately outside /v1: it is an operational endpoint, not part of the
 *  versioned product contract, and it reports process liveness only — it
 *  does not claim database/queue health it has not checked. */
@Controller()
export class HealthController {
  @Public() @Get("health")
  health() { return { status: "ok" }; }
}
