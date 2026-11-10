import { PrismaClient } from "@prisma/client";

/** Singleton Prisma client for production services. Tests use the in-memory repository instead. */
const globalForPrisma = globalThis as unknown as { mailcheckrPrisma?: PrismaClient };

export const prisma =
  globalForPrisma.mailcheckrPrisma ??
  new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.mailcheckrPrisma = prisma;

export { PrismaClient } from "@prisma/client";
