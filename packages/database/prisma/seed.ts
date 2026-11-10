import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { createHmac, randomUUID } from "node:crypto";

/**
 * Seed: demo user + personal workspace + 100 free credits via an immutable
 * ledger grant (idempotency key "seed:free-grant:<workspaceId>", so re-running
 * the seed never double-grants).
 *
 * The demo password is generated at seed time from SEED_DEMO_PASSWORD or a
 * random value printed once to the console — no password is committed to the repo.
 */
async function main() {
  const prisma = new PrismaClient();
  try {
    const email = (process.env.SEED_DEMO_EMAIL ?? "demo@mailcheckr.local").toLowerCase();
    const password = process.env.SEED_DEMO_PASSWORD ?? `demo-${randomUUID()}`;
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, passwordHash, emailVerifiedAt: new Date() },
    });

    let workspace = await prisma.workspace.findFirst({ where: { ownerUserId: user.id } });
    if (!workspace) {
      workspace = await prisma.workspace.create({
        data: { ownerUserId: user.id, name: "Demo Workspace", planCode: "free" },
      });
    }

    const hmacKey = process.env.HMAC_KEY ?? "seed-only-hmac-key";
    void createHmac; void hmacKey; // HMAC key is used by the API for email digests; seed stores no emails to digest.

    await prisma.creditLedger.upsert({
      where: { idempotencyKey: `seed:free-grant:${workspace.id}` },
      update: {},
      create: {
        workspaceId: workspace.id,
        entryType: "grant",
        quantity: 100,
        idempotencyKey: `seed:free-grant:${workspace.id}`,
        description: "Free tier grant: 100 checks (seed)",
      },
    });

    console.log(`Seeded demo user ${email} workspace=${workspace.id} credits=100`);
    if (!process.env.SEED_DEMO_PASSWORD) {
      console.log(`Generated demo password (shown once, store it now): ${password}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
