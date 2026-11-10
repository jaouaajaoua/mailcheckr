# scripts/

## `smtp-gate-check.mjs` — Deep SMTP network gate probe

Standalone Node script (no dependencies, Node ≥ 18). It produces the network evidence required by the PRD §6.2 release gate before Deep SMTP may be enabled.

**Run it only on a real production candidate host** — results from the Muse sandbox, a laptop, or CI are not gate evidence (the sandbox verdict is already recorded as BLOCKED in `docs/phase-0-audit.md`).

```bash
node scripts/smtp-gate-check.mjs | tee gate-evidence-$(date -u +%FT%TZ).json
echo "exit code: $?"   # 0 = PASS, 1 = BLOCKED
```

What it does:

1. Resolves MX for the controlled domains `gmail.com`, `example.com`, `outlook.com` via the system resolver **and** an explicit `8.8.8.8` resolver.
2. Attempts TCP/25 (6 s timeout) to the first public MX IP per domain, reads the banner, sends `QUIT`, and disconnects.
3. Prints a JSON evidence object with timestamp and egress IP (via `ifconfig.me`), and exits non-zero when blocked.

Safety invariants: it **never sends email** and **never issues the SMTP DATA command** — the only bytes sent are `QUIT\r\n`. A PASS is necessary but not sufficient: written provider approval and PTR/rDNS verification are also required before setting `SMTP_DEEP_ENABLED=true` / `SMTP_EGRESS_APPROVED=true` (full sequence in `docs/phase-0-audit.md` §4.1).
