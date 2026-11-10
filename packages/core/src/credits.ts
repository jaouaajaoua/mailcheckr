import type { ReasonCode, VerificationStatus } from "@mailcheckr/contracts";
import { dedupKeyFor } from "./normalize";

/**
 * Pure credit-accounting helpers (PRD §9.1). The ledger itself lives in
 * the database layer; these functions decide, deterministically, what
 * may be charged:
 *
 * - One unique normalized address = at most one charge per completed
 *   verification; duplicate rows in a batch are never charged twice.
 * - `unknown` outcomes are not charged.
 * - Parsing failures (syntax_invalid) are not charged.
 * - Definitive completed results (valid / likely_valid / risky, and
 *   invalid for a non-parsing reason such as NXDOMAIN, Null MX or a
 *   definitive SMTP rejection) are chargeable: the verification ran to
 *   a conclusion.
 */

export function isChargeableResult(status: VerificationStatus, reasonCodes: readonly ReasonCode[]): boolean {
  if (status === "unknown") return false;
  if (reasonCodes.includes("syntax_invalid")) return false;
  return status === "valid" || status === "likely_valid" || status === "risky" || status === "invalid";
}

export interface ChargeableRowInput {
  email: string;
  status: VerificationStatus;
  reasonCodes: readonly ReasonCode[];
}

export interface ChargeableRowDecision extends ChargeableRowInput {
  dedupKey: string | null;
  isDuplicate: boolean;
  chargeable: boolean;
}

/**
 * Apply dedup + chargeability to an ordered batch. The first occurrence
 * of a normalized address is canonical; later occurrences are duplicates
 * and are never chargeable, even if individually chargeable.
 */
export function decideBatchCharges(rows: readonly ChargeableRowInput[]): ChargeableRowDecision[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const dedupKey = dedupKeyFor(row.email);
    // Unparseable rows have no dedup key; key them by raw input so exact
    // repeats still dedupe, but they are never chargeable (syntax).
    const key = dedupKey ?? `unparseable:${row.email.trim().toLowerCase()}`;
    const isDuplicate = seen.has(key);
    if (!isDuplicate) seen.add(key);
    return {
      ...row,
      dedupKey,
      isDuplicate,
      chargeable: !isDuplicate && isChargeableResult(row.status, row.reasonCodes),
    };
  });
}

/** Count of credits a batch would consume. */
export function countChargeable(rows: readonly ChargeableRowInput[]): number {
  return decideBatchCharges(rows).filter((r) => r.chargeable).length;
}
