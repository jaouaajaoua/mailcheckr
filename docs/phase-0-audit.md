# Phase 0 — Repository and Environment Audit

**Product:** MailCheckr (PRD: `MAILCHECKR_PRD_MUSE_SPEC.md`)
**Phase scope (PRD §14, Phase 0):** inspect the environment, identify deployment candidates, verify whether outbound TCP port 25 is permitted, produce architecture decisions and a risk register.
**Gate rule (PRD §6):** Deep SMTP must never be enabled, advertised, or simulated without actual network evidence from the production candidate environment plus provider approval.

---

## 1. Build-sandbox findings (measured, not assumed)

The environment in which this codebase was authored and audited is a **Muse sandbox VM**. It is a development environment only — it is **not** a deployment candidate, and no SMTP conclusion favourable to Deep mode could be drawn from it.

| Property | Observed value |
|---|---|
| OS | Ubuntu 24.04.5 LTS |
| CPU / RAM | 4 vCPU (shared, ~1.5 effective) / 7.7 GiB |
| Node.js | v24.22.1 |
| npm | 10.9.4 |
| pnpm | 9.15.0 (installed during this audit) |
| Docker | **Not available** in the sandbox |
| PostgreSQL / Redis binaries | **Not installed** in the sandbox (provided via Docker Compose on a real host) |

### 1.1 Network egress

- The sandbox has **no direct internet egress**. All HTTP traffic is forced through an enforced proxy (`http_proxy` → `hatch-egress-proxy`). Arbitrary outbound TCP connections are not available.
- Consequently, an outbound **TCP/25 connection cannot even be attempted meaningfully** from this environment: there is no direct route to a remote MX host on port 25, and SMTP must never be tunnelled through an HTTP proxy or disguised as other traffic (PRD §6.3 explicitly forbids this).

### 1.2 DNS behaviour

| Test | Result |
|---|---|
| System resolver | `198.19.0.1` (synthetic/proxy resolver) |
| MX lookup via system DNS (Node `dns.resolveMx`) for `gmail.com`, `example.com`, `outlook.com` | **Refused** — `EREFUSED` for all three controlled domains |
| Direct DNS queries to `8.8.8.8` | **Hang / time out** (UDP/TCP 53 egress unavailable) |
| A-record resolution via system resolver | Returns **synthetic `198.18.x.x` proxy addresses**, not the real origin IPs |

Implications:

1. Even **Quick mode's DNS stage cannot be validated against live DNS from this sandbox** — MX evidence here is an artefact of the proxy resolver, not of the public DNS. Quick-mode DNS logic is therefore verified with controlled fixtures/mocks in tests (PRD §13.2), and live-DNS validation is a staging-environment task.
2. IP-based SSRF defences cannot be meaningfully exercised end-to-end here either: resolved addresses are synthetic. The IP blocklist logic is unit-tested against literal private/loopback/link-local/multicast/reserved/metadata ranges instead.

### 1.3 SMTP gate evidence

| Gate requirement (PRD §6.2) | Status from this environment |
|---|---|
| Resolve MX for controlled test domains | ❌ Refused by the only reachable resolver |
| TCP/25 connect to a public MX host | ❌ Cannot be attempted (proxy-only egress, no direct route) |
| Record egress IP / PTR / rDNS of a probe worker | ❌ No production worker exists yet; no stable egress IP |
| Provider acceptable-use confirmation for recipient-validation probes | ❌ No provider selected; no written approval exists |
| Provider port-25 unblock/removal approval | ❌ Not requested (no account/deployment exists) |

## 2. Verdict

> ## 🔴 Deep SMTP: **BLOCKED**
>
> Outbound TCP/25 **cannot be tested or approved from this environment**. There is no deployment, no provider, no PTR/rDNS, and no written approval. Per PRD §6.3 and the project's non-negotiable rules:
>
> - Deep mode ships **disabled** (`SMTP_DEEP_ENABLED=false`, `SMTP_EGRESS_APPROVED=false`).
> - The dashboard disables the Deep option and explains why; the API must reject Deep requests rather than simulate them.
> - **Quick mode proceeds**: syntax/normalisation, local risk datasets (disposable/role/free-provider), and DNS/MX classification returning conservative `likely_valid` / `invalid` / `risky` / `unknown` results with `smtp_not_attempted_quick_mode` where applicable.
> - No third-party verification service is substituted, and no proxy tunnelling is used.

This verdict can only be revisited after `scripts/smtp-gate-check.mjs` is run **on a real production candidate host** and passes, together with written provider approval (see §4).

## 3. What was built despite the block

The block affects exactly one stage (Stage 5, Deep SMTP probing). Everything independent of it proceeds per PRD §14:

- Monorepo foundation (pnpm workspace, Next.js web, NestJS API/worker, shared packages).
- Database, authentication, tenant isolation, API keys.
- Quick verification core with controlled-fixture tests.
- Bulk CSV pipeline on BullMQ with idempotent credit ledger.
- REST API, dashboard, docs, Docker/Compose, CI, runbooks.

## 4. Deployment candidates for the SMTP worker

The SMTP worker is a separately deployable process precisely so it can live on a network where port 25 is approved, even if the web/API tiers live elsewhere. Candidates, in evaluation order:

| Candidate | Port-25 posture | Approval steps required | PTR / rDNS | Notes |
|---|---|---|---|---|
| **Hetzner Cloud** (EU) | Blocked by default on new accounts/servers; unblock request possible after first payment/identity checks | 1) Create account & server in target region. 2) Submit the Hetzner port-25 unblock request via support ticket stating the use case (recipient-validation probes, no DATA, no sending). 3) Wait for written approval. 4) Run `scripts/smtp-gate-check.mjs` on the server. | Settable in Hetzner Cloud console per floating/primary IP | Low cost; EU data residency suits GDPR posture. First-choice candidate. |
| **Vultr** | Blocked by default; unblock via support ticket with use-case justification | 1) Deploy instance. 2) Open support ticket requesting port-25 unblock with business justification and anti-abuse measures (rate limits, no DATA, identifiable probe domain). 3) Written approval. 4) Run gate script. | Settable in Vultr control panel | Similar posture to Hetzner; approval is discretionary and may be denied for new accounts. |
| **AWS EC2** | Outbound port 25 throttled/blocked by default on EC2 | 1) Submit AWS's "Request to remove email sending limitations" (port-25 removal) form for the specific region/Elastic IP, describing the use case accurately. 2) Approval is per-region. 3) Assign an Elastic IP, set reverse DNS via the EC2 console (Route 53 PTR). 4) Run gate script from the instance. | Via EC2 reverse-DNS form for the Elastic IP | Well-documented process, but the form is framed around *sending* email; the probe-only use case must be stated honestly. SES is **not** a substitute (it cannot probe MX hosts). |
| **DigitalOcean** | **Blocked by default** on Droplets per DigitalOcean's own documentation; unblocking is effectively not offered as a standard path | No reliable approval path to plan around | Available but moot | **Not recommended** for the SMTP worker. Fine for web/API tiers if desired. |
| **Google Cloud (GCE)** | External egress on port 25 **blocked by default** per Google documentation; Google directs users to submission ports/relays, which cannot probe MX servers | No standard unblock path for direct MX probing | Moot | **Not recommended** for the SMTP worker. Ports 465/587 are not a substitute for TCP/25 MX probing (PRD §6.1). |

### 4.1 Re-running the gate on a candidate (required sequence)

1. Provision the worker host; assign a **static egress IP**; set **PTR/rDNS** to the controlled probe domain; publish matching forward DNS and SPF for that domain.
2. Obtain **written provider approval** where the provider requires it (table above) — before any probing beyond the gate script's controlled domains.
3. Run, on the host itself:

   ```bash
   node scripts/smtp-gate-check.mjs
   ```

   The script resolves MX for controlled domains (`gmail.com`, `example.com`, `outlook.com`) via the system resolver and an explicit `8.8.8.8` resolver, attempts TCP/25 with a 6 s timeout, reads only the banner, sends `QUIT`, and prints JSON evidence. **It never sends DATA and never sends email.** It exits non-zero when blocked.
4. File the JSON output, timestamp, egress IP, and the provider's written approval together as the gate evidence pack.
5. Only then set `SMTP_DEEP_ENABLED=true` and `SMTP_EGRESS_APPROVED=true` for that worker, and record the change in `docs/DECISIONS.md` and the phase completion matrix.

## 5. Repository state at audit time

- `~/workspace/mailcheckr` started as an empty directory skeleton (`apps/{web,api,worker}`, `packages/{config,contracts,core,database,datasets}`, `infra/{docker,compose}`, `docs/runbooks`, `scripts/`, `.github/`).
- No pre-existing code, data, or unrelated files were modified by this audit.
- The PRD (`workspace/user/files/MAILCHECKR_PRD_MUSE_SPEC.md`) is the source of truth for all subsequent phases.

## 6. Audit conclusions feeding later phases

1. **Deep SMTP = BLOCKED** (this document is the evidence record). Phase 5 is conditional and remains unimplemented until §4.1 completes on a real host.
2. Quick mode, bulk pipeline, API, and UI are unblocked and proceed (Phases 1–4, 6–7).
3. All DNS/SMTP behaviour in CI is tested against **controlled local fixtures**, never live Gmail/Microsoft/Yahoo endpoints (PRD §13.2).
4. The deployment shortlist for the future SMTP worker is Hetzner → Vultr → AWS EC2; DigitalOcean and GCP are excluded for that role on documented port-25 posture.
