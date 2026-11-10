import type {
  Confidence,
  ReasonCode,
  VerificationChecks,
  VerificationMode,
  VerificationResultDto,
  VerificationStatus,
} from "@mailcheckr/contracts";
import { defaultRiskLookup, type RiskLookup } from "@mailcheckr/datasets";
import { parseEmail, type NormalizedEmail } from "./normalize";
import { resolveDomainRouting, type DnsResolver, type DnsErrorKind, type DomainRouting } from "./dns";
import { isPublicIp } from "./smtp/ssrf";
import type { SmtpProbeOutcome } from "./smtp/probe";
import type { CatchAllOutcome } from "./smtp/catchall";

/**
 * Stages 2–6 — classification and orchestration (PRD §4).
 *
 * Principles enforced here:
 * - Quick mode NEVER claims a mailbox was checked and NEVER returns
 *   `valid`: its ceiling is `likely_valid` + smtp_not_attempted_quick_mode.
 * - Deep mode is conservative: only enhanced 5.1.1 is invalid; generic
 *   550 is unknown/policy; greylisting, throttling, timeouts, TLS and
 *   port problems are all unknown with a specific reason code.
 * - `valid` in Deep mode requires RCPT acceptance AND a conclusively
 *   negative catch-all test AND no risk flag. Accepted + unchecked
 *   catch-all is `likely_valid` + catch_all_unchecked.
 * - Confidence is qualitative only (high/medium/low) — no numeric score.
 */

export interface RiskEvidence {
  isDisposable: boolean;
  rolePrefix: string | null;
  isFreeProvider: boolean;
}

export function assessRisk(normalized: NormalizedEmail, risk: RiskLookup = defaultRiskLookup): RiskEvidence {
  return {
    isDisposable: risk.isDisposableDomain(normalized.domain),
    rolePrefix: risk.getRolePrefix(normalized.localPart),
    isFreeProvider: risk.isFreeProviderDomain(normalized.domain),
  };
}

/**
 * DNS evidence attached to core results (mirrors the persisted
 * `dns_evidence` JSONB in PRD §7.5). `dns_error_kind` preserves the
 * DISTINCT resolver failure kind — nxdomain | servfail | refused |
 * timeout | no_data | other_temporary — so an infrastructure failure
 * is never silently conflated with a non-existent domain. It is null
 * when DNS did not fail.
 */
export interface DnsEvidence {
  dns_error_kind: DnsErrorKind | null;
  routing_kind: DomainRouting["kind"];
}

/** Core result: the wire DTO plus the core-only DNS evidence payload. */
export type CoreVerificationResult = VerificationResultDto & {
  dns_evidence?: DnsEvidence;
};

interface ResultArgs {
  status: VerificationStatus;
  mode: VerificationMode;
  confidence: Confidence;
  email: string;
  normalizedEmail?: string;
  domain: string | null;
  checks: VerificationChecks;
  checksPerformed: string[];
  reasonCodes: ReasonCode[];
  explanation: string;
  observedAt: string;
  dnsEvidence?: DnsEvidence;
}

function makeResult(args: ResultArgs): CoreVerificationResult {
  return {
    status: args.status,
    mode: args.mode,
    confidence: args.confidence,
    email: args.email,
    normalized_email: args.normalizedEmail,
    domain: args.domain,
    checks: args.checks,
    checks_performed: args.checksPerformed,
    reason_codes: args.reasonCodes,
    explanation: args.explanation,
    observed_at: args.observedAt,
    checked_at: args.observedAt,
    ...(args.dnsEvidence ? { dns_evidence: args.dnsEvidence } : {}),
  };
}

const CHECKS_SYNTAX_FAILED: VerificationChecks = {
  syntax: "failed",
  domain: "not_checked",
  mx: "not_checked",
  smtp_mailbox: "not_checked",
};

export interface VerifyOptions {
  dns: DnsResolver;
  risk?: RiskLookup;
  now?: () => Date;
}

/** Result for inputs that fail Stage 1, shared by Quick and Deep. */
function syntaxFailure(input: unknown, mode: VerificationMode, observedAt: string, message: string): VerificationResultDto {
  return makeResult({
    status: "invalid",
    mode,
    confidence: "high",
    email: typeof input === "string" ? input.trim() : "",
    domain: null,
    checks: CHECKS_SYNTAX_FAILED,
    checksPerformed: ["syntax"],
    reasonCodes: ["syntax_invalid"],
    explanation: `The address is not syntactically valid: ${message}`,
    observedAt,
  });
}

function smtpUtf8Unsupported(normalized: NormalizedEmail, mode: VerificationMode, observedAt: string): VerificationResultDto {
  return makeResult({
    status: "unknown",
    mode,
    confidence: "low",
    email: normalized.trimmed,
    normalizedEmail: normalized.email,
    domain: normalized.domain,
    checks: { syntax: "passed", domain: "not_checked", mx: "not_checked", smtp_mailbox: "not_checked" },
    checksPerformed: ["syntax"],
    reasonCodes: ["internationalized_local_part_unsupported"],
    explanation:
      "The local part contains non-ASCII characters and requires SMTPUTF8, which this verification engine does not support. The address was not altered, and no determination was made.",
    observedAt,
  });
}

interface DnsStageOutcome {
  /** Terminal result, when DNS/risk stages already decide the outcome. */
  terminal?: VerificationResultDto;
  /** Routing to continue with, when not terminal. */
  routing?: Extract<DomainRouting, { kind: "ok" }>;
  risk?: RiskEvidence;
  baseReasonCodes?: ReasonCode[];
  checksPerformed?: string[];
  dnsEvidence?: DnsEvidence;
}

/**
 * Shared Stages 2–3 for both modes. Disposable/role short-circuit to
 * `risky` here (a documented risk signal, PRD §4.2) — Deep mode does not
 * spend an SMTP probe on an address already classified risky.
 */
function dnsStage(
  normalized: NormalizedEmail,
  routing: DomainRouting,
  risk: RiskEvidence,
  mode: VerificationMode,
  observedAt: string,
): DnsStageOutcome {
  const checksPerformed = ["syntax", "disposable_dataset", "role_detection", "free_provider_detection", "dns_mx"];
  const baseChecks: VerificationChecks = { syntax: "passed", domain: "passed", mx: "not_checked", smtp_mailbox: "not_checked" };
  const dnsEvidence: DnsEvidence = {
    dns_error_kind: routing.kind === "temporary_failure" ? routing.errorKind : null,
    routing_kind: routing.kind,
  };
  const base: Pick<ResultArgs, "mode" | "email" | "normalizedEmail" | "domain" | "observedAt" | "dnsEvidence"> = {
    mode,
    email: normalized.trimmed,
    normalizedEmail: normalized.email,
    domain: normalized.domain,
    observedAt,
    dnsEvidence,
  };

  switch (routing.kind) {
    case "nxdomain":
      return {
        terminal: makeResult({
          ...base, status: "invalid", confidence: "high",
          checks: { ...baseChecks, domain: "failed", mx: "failed" },
          checksPerformed, reasonCodes: ["domain_nxdomain"],
          explanation: "The domain does not exist (DNS returned NXDOMAIN), so it cannot receive email.",
        }),
      };
    case "temporary_failure":
      // Infrastructure failure — servfail / refused / timeout /
      // other_temporary. NEVER invalid: the domain may be fine, the
      // resolver path failed. The distinct kind rides in dns_evidence.
      return {
        terminal: makeResult({
          ...base, status: "unknown", confidence: "low",
          checks: { ...baseChecks, domain: "inconclusive", mx: "inconclusive" },
          checksPerformed, reasonCodes: ["dns_temporary_failure"],
          explanation: `DNS lookup failed with a ${routing.errorKind} error — a resolver/infrastructure failure, not evidence the domain or address is invalid. No determination was made; retry later.`,
        }),
      };
    case "null_mx":
      return {
        terminal: makeResult({
          ...base, status: "invalid", confidence: "high",
          checks: { ...baseChecks, mx: "failed" },
          checksPerformed, reasonCodes: ["null_mx"],
          explanation: "The domain publishes a Null MX record (MX 0 .), which explicitly states it does not accept email.",
        }),
      };
    case "mx_host_unresolved":
      return {
        terminal: makeResult({
          ...base, status: "unknown", confidence: "low",
          checks: { ...baseChecks, mx: "inconclusive" },
          checksPerformed: [...checksPerformed, "dns_mx_address"],
          reasonCodes: ["mx_host_unresolved"],
          explanation: "The domain publishes MX records, but none of the mail exchanger hosts resolve to an address, so no SMTP route could be established.",
        }),
      };
    case "no_route":
      return {
        terminal: makeResult({
          ...base, status: "invalid", confidence: "medium",
          checks: { ...baseChecks, mx: "failed" },
          checksPerformed: [...checksPerformed, "dns_implicit_mx"],
          reasonCodes: ["mx_missing_implicit_route_checked"],
          explanation: "The domain publishes no MX records and the implicit-MX fallback found no A/AAAA address for the domain, so there is no mail route.",
        }),
      };
    case "ok": {
      const performed = [...checksPerformed, "dns_mx_address"];
      if (routing.usedImplicitMx) performed.push("dns_implicit_mx");
      const implicitReasons: ReasonCode[] = routing.usedImplicitMx ? ["mx_missing_implicit_route_checked"] : [];
      if (risk.isDisposable) {
        return {
          terminal: makeResult({
            ...base, status: "risky", confidence: "high",
            checks: { ...baseChecks, mx: "passed" },
            checksPerformed: performed,
            reasonCodes: [...implicitReasons, "disposable_domain"],
            explanation: "The domain is on the disposable-email dataset. Addresses on disposable domains are classified risky, not invalid.",
          }),
        };
      }
      if (risk.rolePrefix) {
        return {
          terminal: makeResult({
            ...base, status: "risky", confidence: "medium",
            checks: { ...baseChecks, mx: "passed" },
            checksPerformed: performed,
            reasonCodes: [...implicitReasons, "role_account", ...(risk.isFreeProvider ? (["free_provider"] as ReasonCode[]) : [])],
            explanation: `The local part ("${risk.rolePrefix}") is a role-based prefix typically shared by a function or team rather than an individual. Role accounts are classified risky, not invalid.`,
          }),
        };
      }
      return {
        routing,
        risk,
        baseReasonCodes: [...implicitReasons, ...(risk.isFreeProvider ? (["free_provider"] as ReasonCode[]) : [])],
        checksPerformed: performed,
        dnsEvidence,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 4 — Quick classification
// ---------------------------------------------------------------------------

export async function verifyQuick(input: unknown, options: VerifyOptions): Promise<CoreVerificationResult> {
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const parsed = parseEmail(input);
  if (!parsed.ok) return syntaxFailure(input, "quick", observedAt, parsed.message);
  const normalized = parsed.value;
  if (normalized.requiresSmtpUtf8) return smtpUtf8Unsupported(normalized, "quick", observedAt);

  const risk = assessRisk(normalized, options.risk);
  const routing = await resolveDomainRouting(options.dns, normalized.domain);
  const stage = dnsStage(normalized, routing, risk, "quick", observedAt);
  if (stage.terminal) return stage.terminal;

  // Syntax + routing pass, mailbox not tested: the Quick ceiling.
  return makeResult({
    status: "likely_valid",
    mode: "quick",
    confidence: "medium",
    email: normalized.trimmed,
    normalizedEmail: normalized.email,
    domain: normalized.domain,
    checks: { syntax: "passed", domain: "passed", mx: "passed", smtp_mailbox: "not_checked" },
    checksPerformed: stage.checksPerformed!,
    reasonCodes: [...(stage.baseReasonCodes ?? []), "smtp_not_attempted_quick_mode"],
    explanation:
      "The address format and domain mail routing appear valid. The individual mailbox was not tested in Quick mode, so this is not proof the mailbox exists.",
    observedAt,
    dnsEvidence: stage.dnsEvidence,
  });
}

// ---------------------------------------------------------------------------
// Stages 5–6 — Deep classification (pure) and orchestration
// ---------------------------------------------------------------------------

export interface ClassifyDeepArgs {
  normalized: NormalizedEmail;
  baseReasonCodes: ReasonCode[];
  checksPerformed: string[];
  smtpOutcome: SmtpProbeOutcome;
  /** Required when the SMTP outcome is "accepted"; null = not run. */
  catchAllOutcome: CatchAllOutcome | null;
  observedAt: string;
  dnsEvidence?: DnsEvidence;
}

/** Pure Deep classification from probe evidence. Conservative by design. */
export function classifyDeep(args: ClassifyDeepArgs): CoreVerificationResult {
  const { normalized, smtpOutcome, catchAllOutcome, observedAt } = args;
  const base: Pick<ResultArgs, "mode" | "email" | "normalizedEmail" | "domain" | "observedAt" | "dnsEvidence"> = {
    mode: "deep",
    email: normalized.trimmed,
    normalizedEmail: normalized.email,
    domain: normalized.domain,
    observedAt,
    dnsEvidence: args.dnsEvidence,
  };
  const performed = [...args.checksPerformed, "smtp_rcpt"];
  const smtpChecks = (smtp_mailbox: VerificationChecks["smtp_mailbox"]): VerificationChecks => ({
    syntax: "passed", domain: "passed", mx: "passed", smtp_mailbox,
  });
  const unknownWith = (reason: ReasonCode, explanation: string, extra: ReasonCode[] = []): VerificationResultDto =>
    makeResult({
      ...base, status: "unknown", confidence: "low",
      checks: smtpChecks("inconclusive"),
      checksPerformed: performed,
      reasonCodes: [...args.baseReasonCodes, ...extra, reason],
      explanation,
    });

  switch (smtpOutcome.kind) {
    case "rejected_definitive":
      return makeResult({
        ...base, status: "invalid", confidence: "high",
        checks: smtpChecks("failed"),
        checksPerformed: performed,
        reasonCodes: [...args.baseReasonCodes, "smtp_mailbox_rejected_definitive"],
        explanation:
          "The mail server returned an unambiguous mailbox-not-found response (enhanced status 5.1.1) at the SMTP RCPT stage, so this mailbox does not exist.",
      });
    case "policy_rejected":
      return unknownWith(
        "smtp_policy_rejected",
        "The mail server rejected the probe with a 5xx policy response (for example a generic 550). Generic 5xx responses are policy rejections, not proof the mailbox is missing, so no determination was made.",
      );
    case "provider_defers":
      return unknownWith(
        "provider_defers_recipient_validation",
        "The mail server defers recipient validation until after message DATA. MailCheckr never sends DATA, so no determination was made.",
      );
    case "greylisted":
      return unknownWith(
        "smtp_greylisted",
        "The mail server returned a temporary 4xx response (greylisting or a similar deferral). The mailbox could not be determined at check time.",
      );
    case "rate_limited":
      return unknownWith(
        "smtp_rate_limited",
        "The mail server rate-limited or throttled the probe, so the mailbox could not be determined at check time.",
      );
    case "starttls_unavailable":
      return unknownWith(
        "smtp_starttls_unavailable",
        "The mail server does not offer STARTTLS. The probe was aborted before transmitting the target address, which is never sent in cleartext, so no determination was made.",
      );
    case "tls_handshake_failed":
      return unknownWith(
        "smtp_tls_handshake_failed",
        "The TLS handshake or certificate validation failed after STARTTLS. The probe was aborted without transmitting the target address, so no determination was made.",
      );
    case "timeout":
      return unknownWith("smtp_connection_timeout", "The SMTP connection or read timed out, so the mailbox could not be determined.");
    case "connection_refused":
      return unknownWith("smtp_connection_refused", "The SMTP connection was refused by the mail exchanger, so the mailbox could not be determined.");
    case "port_unavailable":
    case "protocol_error":
      return unknownWith(
        "smtp_port_unavailable",
        "No usable SMTP service was available on the mail exchanger (port 25), so the mailbox could not be determined.",
      );
    case "blocked_non_public_ip":
      return unknownWith(
        "smtp_port_unavailable",
        "The mail exchanger resolves to a non-public address, which the SMTP worker is not permitted to connect to, so the mailbox could not be determined.",
      );
    case "peer_ip_mismatch":
      // DNS-rebinding / TOCTOU defense fired: the socket's actual peer
      // is not the validated resolved IP (or is not public). The probe
      // aborted before any SMTP command, so nothing was determined.
      return unknownWith(
        "smtp_port_unavailable",
        "The SMTP connection's actual peer address did not match the validated mail-exchanger address (possible DNS rebinding), so the probe was aborted before any SMTP command was sent and no determination was made.",
      );
    case "accepted": {
      const acceptedReasons: ReasonCode[] = [...args.baseReasonCodes, "smtp_mailbox_accepted"];
      const withCatchAll = [...performed, "smtp_catch_all_probe"];
      if (catchAllOutcome?.kind === "suspected") {
        return makeResult({
          ...base, status: "risky", confidence: "medium",
          checks: smtpChecks("passed"),
          checksPerformed: withCatchAll,
          reasonCodes: [...acceptedReasons, "catch_all_suspected"],
          explanation:
            "The mail server accepted both this recipient and a synthetic random recipient, indicating a catch-all (accept-all) domain. Individual mailbox existence cannot be confirmed on such domains.",
        });
      }
      if (catchAllOutcome?.kind === "not_catch_all") {
        return makeResult({
          ...base, status: "valid", confidence: "medium",
          checks: smtpChecks("passed"),
          checksPerformed: withCatchAll,
          reasonCodes: acceptedReasons,
          explanation:
            "The mail server accepted this recipient at the SMTP RCPT stage and a controlled catch-all test did not indicate catch-all behaviour. This means 'accepted by the mail server at check time', not guaranteed inbox delivery.",
        });
      }
      // Catch-all unchecked or inconclusive: never claim high-confidence valid.
      return makeResult({
        ...base, status: "likely_valid", confidence: "medium",
        checks: smtpChecks("passed"),
        checksPerformed: catchAllOutcome ? withCatchAll : performed,
        reasonCodes: [...acceptedReasons, "catch_all_unchecked"],
        explanation:
          "The mail server accepted this recipient at the SMTP RCPT stage, but catch-all behaviour could not be established, so the result is likely_valid rather than valid. Acceptance is not proof of inbox delivery.",
      });
    }
  }
}

export interface DeepProbeTarget {
  exchange: string;
  ip: string;
}

export interface VerifyDeepOptions extends VerifyOptions {
  /**
   * Injectable SMTP prober. In production this wraps probeSmtpMailbox
   * with a NodeSmtpTransport; tests inject a scripted fake. When absent,
   * Deep returns unknown/smtp_port_unavailable — it is never faked.
   */
  probeMailbox?: (targetEmail: string, target: DeepProbeTarget) => Promise<SmtpProbeOutcome>;
  /** Injectable catch-all probe; when absent, catch-all is unchecked. */
  checkCatchAll?: (domain: string, target: DeepProbeTarget) => Promise<CatchAllOutcome>;
}

export async function verifyDeep(input: unknown, options: VerifyDeepOptions): Promise<CoreVerificationResult> {
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const parsed = parseEmail(input);
  if (!parsed.ok) return syntaxFailure(input, "deep", observedAt, parsed.message);
  const normalized = parsed.value;
  if (normalized.requiresSmtpUtf8) return smtpUtf8Unsupported(normalized, "deep", observedAt);

  const risk = assessRisk(normalized, options.risk);
  const routing = await resolveDomainRouting(options.dns, normalized.domain);
  const stage = dnsStage(normalized, routing, risk, "deep", observedAt);
  if (stage.terminal) return stage.terminal;

  const okRouting = stage.routing!;
  const baseReasonCodes = stage.baseReasonCodes ?? [];
  const checksPerformed = stage.checksPerformed ?? [];

  // Pick the first public IP across the resolved MX hosts. Non-public
  // addresses are never connected to (SSRF guard, PRD §10.3).
  let target: DeepProbeTarget | null = null;
  for (const host of okRouting.hosts) {
    const ip = host.addresses.find((a) => isPublicIp(a));
    if (ip) {
      target = { exchange: host.exchange, ip };
      break;
    }
  }
  if (!target) {
    return classifyDeep({
      normalized, baseReasonCodes, checksPerformed, observedAt, dnsEvidence: stage.dnsEvidence,
      smtpOutcome: { kind: "blocked_non_public_ip", ip: okRouting.hosts[0]?.addresses[0] ?? "", reason: "no public address" },
      catchAllOutcome: null,
    });
  }
  if (!options.probeMailbox) {
    return classifyDeep({
      normalized, baseReasonCodes, checksPerformed, observedAt, dnsEvidence: stage.dnsEvidence,
      smtpOutcome: { kind: "port_unavailable", message: "No SMTP prober configured (Deep SMTP is release-gated)" },
      catchAllOutcome: null,
    });
  }

  const smtpOutcome = await options.probeMailbox(normalized.email, target);
  let catchAllOutcome: CatchAllOutcome | null = null;
  if (smtpOutcome.kind === "accepted" && options.checkCatchAll) {
    catchAllOutcome = await options.checkCatchAll(normalized.domain, target).catch((err: unknown) => ({
      kind: "unchecked" as const,
      syntheticRecipient: "",
      detail: err instanceof Error ? err.message : String(err),
    }));
  }
  return classifyDeep({ normalized, baseReasonCodes, checksPerformed, smtpOutcome, catchAllOutcome, observedAt, dnsEvidence: stage.dnsEvidence });
}
