import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { ApiError, errorEnvelope } from "./errors";

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<any>();
    const requestId = `req_${randomBytes(8).toString("hex")}`;
    if (exception instanceof ApiError) {
      return reply.status(exception.status).send(errorEnvelope(exception.code, exception.message, requestId, exception.retryAfterSeconds));
    }
    const status = (exception as any)?.status ?? 500;
    const message = status < 500 ? ((exception as any)?.message ?? "Request failed.") : "Internal server error.";
    const code = status === 404 ? "NOT_FOUND" : status === 401 ? "UNAUTHORIZED" : status < 500 ? "REQUEST_ERROR" : "INTERNAL_ERROR";
    return reply.status(status).send(errorEnvelope(code, message, requestId));
  }
}
