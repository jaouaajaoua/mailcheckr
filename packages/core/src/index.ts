/**
 * @mailcheckr/core — MailCheckr's pure verification core.
 *
 * Pipeline (PRD §4.5): normalize/parse → local risk datasets → DNS
 * routing → Quick classification, plus the release-gated Deep SMTP
 * probe and catch-all check. The core never sends email and never
 * issues the SMTP DATA command.
 */

export { parseEmail, normalizeEmail, dedupKeyFor, type NormalizedEmail, type EmailParseResult } from "./normalize";
export {
  NodeDnsResolver,
  DnsResolutionError,
  mapDnsError,
  resolveDomainRouting,
  type DnsResolver,
  type DnsErrorKind,
  type MxRecord,
  type ResolvedHost,
  type DomainRouting,
} from "./dns";
export {
  verifyQuick,
  verifyDeep,
  classifyDeep,
  assessRisk,
  type VerifyOptions,
  type VerifyDeepOptions,
  type DeepProbeTarget,
  type RiskEvidence,
  type ClassifyDeepArgs,
  type DnsEvidence,
  type CoreVerificationResult,
} from "./verify";
export { escapeCsvCell, escapeCsvRow, buildCsv } from "./csv";
export {
  isChargeableResult,
  decideBatchCharges,
  countChargeable,
  type ChargeableRowInput,
  type ChargeableRowDecision,
} from "./credits";
export { isPublicIp, blockedIpReason } from "./smtp/ssrf";
export {
  parseSmtpResponseLines,
  readSmtpResponse,
  collectExtensions,
  type SmtpResponse,
  type LineSource,
} from "./smtp/parser";
export {
  NodeSmtpTransport,
  DataCommandForbiddenError,
  assertNotDataCommand,
  type SmtpTransport,
  type NodeSmtpTransportOptions,
} from "./smtp/transport";
export {
  probeSmtpMailbox,
  interpretRcptResponse,
  type SmtpProbeOutcome,
  type SmtpProbeOptions,
} from "./smtp/probe";
export {
  checkCatchAll,
  generateSyntheticLocalPart,
  type CatchAllOutcome,
  type CatchAllCheckOptions,
  type RandomBytesFn,
} from "./smtp/catchall";
export {
  DomainThrottle,
  DomainThrottleTimeoutError,
  type DomainThrottleOptions,
  type ThrottleRelease,
} from "./smtp/throttle";
