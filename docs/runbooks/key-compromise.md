# Runbook — API key (or secret) compromise

Covers a leaked `mc_live_…` API key, and — with the noted differences — a leaked `JWT_SECRET`, `ENCRYPTION_KEY`, or `HMAC_KEY`.

## API key leaked (most likely case)
1. **Revoke immediately:** dashboard → API keys → Revoke, or `DELETE /v1/api-keys/:id`. Revocation is effective at once; confirm the key now returns `401`.
2. **Assess blast radius:** from audit events + usage, list calls made with the key since the suspected leak: verifications created, batches created/exported, deletions. Exports are the sensitive operation — determine whether customer list data left the system.
3. **Notify the workspace owner** with what was accessed and when; issue a replacement key (shown once — have them store it in their secret manager).
4. If exports of personal data occurred to an unknown party, escalate to the data-deletion/privacy process and legal review before making any external statements.

## JWT_SECRET leaked
- Rotate the secret and redeploy the API: all dashboard sessions are invalidated (users sign in again — acceptable). Audit for sessions/actions in the exposure window. There is no per-session revocation list in the MVP design, which is why rotation is the remedy.

## ENCRYPTION_KEY / HMAC_KEY leaked
- Treat as sev-1. Stored address ciphertext must be considered exposed if the database also leaked; HMAC digests likewise.
- Rotation requires a re-encryption migration (decrypt with old key, encrypt with new) run as a maintenance operation — it is **not** an env-var swap (ADR-007). Plan downtime or a dual-key read window with engineering support; do not improvise SQL.
- Force-expire all retained results early if exposure is confirmed, and follow `data-deletion.md` notification steps.

## Any secret committed to git
- The secret is compromised even if the commit was later removed: rotate first, then scrub history. Add/verify secret-scanning on the repo (Phase 8 control) and note the gap if scanning was absent.

## Prevention
- Keys shown once, hashed at rest, scoped minimally; encourage per-environment keys; `last_used_at` anomalies (sudden first use from a new geography/volume spike) are an alerting input.
