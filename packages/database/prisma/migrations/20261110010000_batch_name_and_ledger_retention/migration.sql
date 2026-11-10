-- Reconciliation migration (web <-> API contract alignment):
-- 1. verification_batches.name — the caller-supplied batch label sent by
--    POST /v1/batches (PRD §8.3) and rendered by the dashboard batch list.
-- 2. credit_ledger.workspace_id becomes nullable with ON DELETE SET NULL so
--    that on verified account deletion (DELETE /v1/account) the ledger
--    entries and their amounts are retained as the accounting record while
--    the workspace and all personal-data-bearing rows are purged. The API
--    severs batch/record links explicitly before deleting the workspace.

ALTER TABLE "verification_batches" ADD COLUMN "name" TEXT;

ALTER TABLE "credit_ledger" ALTER COLUMN "workspace_id" DROP NOT NULL;

ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_workspace_id_fkey";

ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
