# Runbook — SMTP provider block or abuse complaint

**Applies only when Deep mode is enabled** (it is currently BLOCKED — ADR-006). If Deep is disabled, a "block" report almost certainly concerns another tenant of the IP or a misunderstanding; still follow steps 1–3.

## Symptoms
- `smtp_connections_total` failures spike for one provider/MX family; `unknown_rate` jumps.
- Provider (hosting) abuse notice or a complaint from a mail operator.
- Gate script starts failing from the worker host.

## Immediate actions
1. **Stop the bleeding:** set `SMTP_DEEP_ENABLED=false` on the worker and restart it. Quick mode is unaffected — say so in any status update.
2. **Preserve evidence:** export structured logs for the window (`workspace_id`, `batch_id`, stage, reason codes; no plaintext addresses beyond what policy allows), plus the gate-script output and the provider notice. Do not delete logs.
3. **Verify our own behaviour from the logs:** confirm no DATA was ever issued, per-domain probe rates were within caps, catch-all probing ≤ 1 synthetic recipient/domain/24 h, MAIL FROM identity was the controlled probe address. If any invariant was violated, treat as a sev-1 product bug, not a provider dispute.

## Diagnosis
- Single MX family refusing ⇒ likely provider-side anti-abuse scoring of the probe IP; check PTR/rDNS and SPF alignment of the probe domain, recent volume changes, and `smtp_rate_limited` vs `smtp_policy_rejected` mix.
- All families failing ⇒ local egress change: re-run `node scripts/smtp-gate-check.mjs` on the worker host; check the host provider's port-25 posture hasn't been revoked.

## Resolution
- Respond to the provider/complainant with the evidence: probe-only design (no DATA, no sending), rate limits, contact/abuse address on the probe domain. Request reinstatement or the specific condition they require.
- Do **not** rotate to a fresh IP to evade a block, tunnel through a proxy, or move to an unapproved provider. That violates PRD §6.3 and the project's non-negotiables.
- Re-enable only after: written provider clearance + gate script passes + PTR verified. Set both flags, deploy, watch `unknown_rate` for 24 h.

## Prevention
- Alert on egress-failure and per-provider unknown-rate deltas; keep probe volume conservative; keep the abuse contact on the probe domain monitored.
