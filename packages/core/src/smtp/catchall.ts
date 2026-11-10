import { randomBytes } from "node:crypto";
import { probeSmtpMailbox, type SmtpProbeOutcome } from "./probe";
import type { SmtpTransport } from "./transport";

/**
 * Catch-all detection (PRD §4.5 Stage 6, §4.6).
 *
 * Exactly ONE synthetic random recipient per domain per cache window,
 * generated with a cryptographically secure random identifier. No
 * dictionaries, no enumeration, no DATA. If the synthetic recipient is
 * accepted the domain is catch-all suspected; if it is definitively
 * rejected the domain is conclusively not catch-all; anything else is
 * inconclusive ("unchecked") and must never be upgraded to a claim.
 */

export type CatchAllOutcome =
  | { kind: "not_catch_all"; syntheticRecipient: string }
  | { kind: "suspected"; syntheticRecipient: string }
  | { kind: "unchecked"; syntheticRecipient: string; detail: string };

export type RandomBytesFn = (size: number) => Buffer | Uint8Array;

export function generateSyntheticLocalPart(random: RandomBytesFn = randomBytes): string {
  const bytes = random(12);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `mc-probe-${hex}`;
}

export interface CatchAllCheckOptions {
  /** Factory: each probe needs its own fresh connection/transport. */
  createTransport: () => SmtpTransport;
  domain: string;
  ip: string;
  host: string;
  port?: number;
  heloDomain: string;
  mailFrom: string;
  /** Injectable for deterministic tests. */
  random?: RandomBytesFn;
}

export async function checkCatchAll(options: CatchAllCheckOptions): Promise<CatchAllOutcome> {
  const syntheticRecipient = `${generateSyntheticLocalPart(options.random)}@${options.domain}`;
  let outcome: SmtpProbeOutcome;
  try {
    outcome = await probeSmtpMailbox({
      transport: options.createTransport(),
      ip: options.ip,
      host: options.host,
      port: options.port,
      heloDomain: options.heloDomain,
      mailFrom: options.mailFrom,
      targetEmail: syntheticRecipient,
    });
  } catch (err) {
    return { kind: "unchecked", syntheticRecipient, detail: err instanceof Error ? err.message : String(err) };
  }
  switch (outcome.kind) {
    case "accepted":
      return { kind: "suspected", syntheticRecipient };
    case "rejected_definitive":
      return { kind: "not_catch_all", syntheticRecipient };
    default:
      return { kind: "unchecked", syntheticRecipient, detail: `synthetic probe outcome: ${outcome.kind}` };
  }
}
