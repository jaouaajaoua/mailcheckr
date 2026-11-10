# @mailcheckr/database

Prisma schema + hand-written initial migration implementing PRD §7.

Tables: `users`, `password_reset_tokens` (supporting table for §3.1 password reset),
`workspaces`, `api_keys`, `verification_batches`, `verification_records`, `batch_rows`,
`credit_ledger`, `domain_cache`, `webhook_endpoints`, `audit_events`.

Conventions:
- UUID primary keys; every tenant-owned record has `workspace_id`.
- `credit_ledger.quantity` is a **signed delta** to the workspace balance:
  grant/purchase/refund/release are positive, reserve/charge are negative.
  Balance = `SUM(quantity)`. `idempotency_key` is unique — a retried mutation
  with the same key is a no-op, which is what makes charging idempotent.
- `batch_rows` has a unique `(batch_id, row_number)` constraint.
- API keys and password-reset tokens are stored only as hashes.
- Emails are stored as application-layer ciphertext plus a keyed HMAC digest.

Usage:
```bash
DATABASE_URL=postgresql://... npx prisma migrate deploy
DATABASE_URL=postgresql://... npm run seed
```
