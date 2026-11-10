import { domainToASCII } from "node:url";
import disposableDomains from "../data/disposable.json";
import freeProviderDomains from "../data/free-providers.json";
import rolePrefixes from "../data/role-prefixes.json";
import disposableMeta from "../data/disposable.metadata.json";
import freeMeta from "../data/free-providers.metadata.json";
import roleMeta from "../data/role-prefixes.metadata.json";

/**
 * @mailcheckr/datasets — versioned local risk datasets (PRD §4.5 Stage 2).
 *
 * IMPORTANT: these are small curated SEED lists compiled in-repo from
 * public facts. They are NOT licensed bulk datasets and coverage is
 * deliberately limited (~30 well-known disposable domains, common free
 * providers, conventional role prefixes). A production deployment must
 * import a properly licensed dataset through a process that records
 * source, license, version, imported timestamp and hash — exactly the
 * fields carried in each dataset's metadata.json.
 */

export interface DatasetMetadata {
  dataset: string;
  description: string;
  source: string;
  license: string;
  version: string;
  importedAt: string;
  hash: string;
}

export const DISPOSABLE_METADATA = disposableMeta as DatasetMetadata;
export const FREE_PROVIDER_METADATA = freeMeta as DatasetMetadata;
export const ROLE_PREFIX_METADATA = roleMeta as DatasetMetadata;

export const DATASET_METADATA: readonly DatasetMetadata[] = [
  DISPOSABLE_METADATA,
  FREE_PROVIDER_METADATA,
  ROLE_PREFIX_METADATA,
];

/** Normalize a domain for dataset comparison: trim, lowercase, punycode. */
export function normalizeDatasetDomain(domain: string): string {
  const cleaned = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!cleaned) return "";
  const ascii = domainToASCII(cleaned);
  return (ascii || cleaned).toLowerCase();
}

function toDomainSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map(normalizeDatasetDomain).filter(Boolean));
}

export const DISPOSABLE_DOMAINS: ReadonlySet<string> = toDomainSet(disposableDomains as string[]);
export const FREE_PROVIDER_DOMAINS: ReadonlySet<string> = toDomainSet(freeProviderDomains as string[]);
export const ROLE_PREFIXES: ReadonlySet<string> = new Set(
  (rolePrefixes as string[]).map((p) => p.trim().toLowerCase()).filter(Boolean),
);

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(normalizeDatasetDomain(domain));
}

export function isFreeProviderDomain(domain: string): boolean {
  return FREE_PROVIDER_DOMAINS.has(normalizeDatasetDomain(domain));
}

/**
 * Return the matched role prefix for a local part, or null.
 * Matches the whole local part (`support@`) or its first token when the
 * local part is segmented (`support.team@`, `sales-eu@`, `info+tag@`).
 * Heuristic only — a role account is a risk signal, never proof of
 * invalidity (PRD §4.5 Stage 2).
 */
export function getRolePrefix(localPart: string): string | null {
  const local = localPart.trim().toLowerCase();
  if (!local) return null;
  if (ROLE_PREFIXES.has(local)) return local;
  const firstToken = local.split(/[._+-]/)[0] ?? "";
  if (firstToken && firstToken !== local && ROLE_PREFIXES.has(firstToken)) return firstToken;
  return null;
}

export function isRoleLocalPart(localPart: string): boolean {
  return getRolePrefix(localPart) !== null;
}

/** Injectable lookup surface used by @mailcheckr/core so tests and future
 *  licensed-dataset imports can substitute their own data. */
export interface RiskLookup {
  isDisposableDomain(domain: string): boolean;
  isFreeProviderDomain(domain: string): boolean;
  getRolePrefix(localPart: string): string | null;
}

export const defaultRiskLookup: RiskLookup = {
  isDisposableDomain,
  isFreeProviderDomain,
  getRolePrefix,
};
