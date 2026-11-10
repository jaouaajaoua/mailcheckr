-- MailCheckr initial migration — hand-written SQL matching prisma/schema.prisma (PRD §7).
-- Signed quantity convention for credit_ledger: grants/purchases/refunds/releases are
-- positive deltas to the available balance; reserves and charges are negative deltas.
-- The available balance is SUM(quantity) over the workspace's ledger rows.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE "BatchSourceType" AS ENUM ('upload', 'paste', 'api');
CREATE TYPE "VerificationMode" AS ENUM ('quick', 'deep');
CREATE TYPE "BatchStatus" AS ENUM ('created', 'queued', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled', 'expired');
CREATE TYPE "VerificationStatus" AS ENUM ('valid', 'likely_valid', 'invalid', 'risky', 'unknown');
CREATE TYPE "Confidence" AS ENUM ('high', 'medium', 'low');
CREATE TYPE "CreditEntryType" AS ENUM ('grant', 'reserve', 'charge', 'release', 'refund', 'purchase', 'adjustment');
CREATE TYPE "DnsStatus" AS ENUM ('ok', 'nxdomain', 'servfail', 'timeout', 'null_mx', 'no_mx_implicit_route', 'unresolved');
CREATE TYPE "CatchAllStatus" AS ENUM ('suspected', 'not_suspected', 'unchecked', 'inconclusive');

CREATE TABLE "users" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL,
  "password_hash" TEXT,
  "auth_subject" TEXT,
  "email_verified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_auth_subject_key" ON "users"("auth_subject");

CREATE TABLE "password_reset_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

CREATE TABLE "workspaces" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_user_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "plan_code" TEXT NOT NULL DEFAULT 'free',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspaces_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "workspaces_owner_user_id_idx" ON "workspaces"("owner_user_id");

CREATE TABLE "api_keys" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "key_prefix" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "scopes" JSONB NOT NULL DEFAULT '["verify:write", "verify:read"]',
  "last_used_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "api_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
CREATE INDEX "api_keys_workspace_id_idx" ON "api_keys"("workspace_id");
CREATE INDEX "api_keys_key_prefix_idx" ON "api_keys"("key_prefix");

CREATE TABLE "verification_batches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "created_by_user_id" UUID,
  "source_type" "BatchSourceType" NOT NULL,
  "source_object_key" TEXT,
  "original_filename" TEXT,
  "email_column_name" TEXT,
  "mode" "VerificationMode" NOT NULL DEFAULT 'quick',
  "status" "BatchStatus" NOT NULL DEFAULT 'created',
  "row_count" INTEGER NOT NULL DEFAULT 0,
  "unique_count" INTEGER NOT NULL DEFAULT 0,
  "duplicate_count" INTEGER NOT NULL DEFAULT 0,
  "completed_count" INTEGER NOT NULL DEFAULT 0,
  "invalid_count" INTEGER NOT NULL DEFAULT 0,
  "risky_count" INTEGER NOT NULL DEFAULT 0,
  "unknown_count" INTEGER NOT NULL DEFAULT 0,
  "credits_reserved" INTEGER NOT NULL DEFAULT 0,
  "credits_charged" INTEGER NOT NULL DEFAULT 0,
  "credits_refunded" INTEGER NOT NULL DEFAULT 0,
  "idempotency_key" TEXT,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "verification_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verification_batches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "verification_batches_idempotency_key_key" ON "verification_batches"("idempotency_key");
CREATE INDEX "verification_batches_workspace_id_status_idx" ON "verification_batches"("workspace_id", "status");
CREATE INDEX "verification_batches_workspace_id_created_at_idx" ON "verification_batches"("workspace_id", "created_at");

CREATE TABLE "verification_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "batch_id" UUID,
  "email_ciphertext" TEXT NOT NULL,
  "email_hmac" TEXT NOT NULL,
  "domain_normalized" TEXT NOT NULL,
  "row_number" INTEGER,
  "original_row_payload" JSONB,
  "status" "VerificationStatus" NOT NULL,
  "mode" "VerificationMode" NOT NULL,
  "confidence" "Confidence" NOT NULL,
  "reason_codes" JSONB NOT NULL,
  "checks_performed" JSONB NOT NULL,
  "dns_evidence" JSONB,
  "smtp_evidence" JSONB,
  "idempotency_key" TEXT,
  "checked_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "verification_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verification_records_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "verification_records_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "verification_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "verification_records_idempotency_key_key" ON "verification_records"("idempotency_key");
CREATE INDEX "verification_records_workspace_id_batch_id_idx" ON "verification_records"("workspace_id", "batch_id");
CREATE INDEX "verification_records_workspace_id_email_hmac_idx" ON "verification_records"("workspace_id", "email_hmac");
CREATE INDEX "verification_records_domain_normalized_idx" ON "verification_records"("domain_normalized");

CREATE TABLE "batch_rows" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "batch_id" UUID NOT NULL,
  "row_number" INTEGER NOT NULL,
  "email_record_id" UUID,
  "is_duplicate" BOOLEAN NOT NULL DEFAULT false,
  "duplicate_of_row_number" INTEGER,
  "parse_error_code" TEXT,
  "original_row_ref" TEXT,
  CONSTRAINT "batch_rows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "batch_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "verification_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "batch_rows_email_record_id_fkey" FOREIGN KEY ("email_record_id") REFERENCES "verification_records"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "batch_rows_batch_id_row_number_key" ON "batch_rows"("batch_id", "row_number");
CREATE INDEX "batch_rows_batch_id_is_duplicate_idx" ON "batch_rows"("batch_id", "is_duplicate");

CREATE TABLE "credit_ledger" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "batch_id" UUID,
  "verification_record_id" UUID,
  "entry_type" "CreditEntryType" NOT NULL,
  "quantity" INTEGER NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "description" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_ledger_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "credit_ledger_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "verification_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "credit_ledger_verification_record_id_fkey" FOREIGN KEY ("verification_record_id") REFERENCES "verification_records"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "credit_ledger_idempotency_key_key" ON "credit_ledger"("idempotency_key");
CREATE INDEX "credit_ledger_workspace_id_created_at_idx" ON "credit_ledger"("workspace_id", "created_at");
CREATE INDEX "credit_ledger_workspace_id_entry_type_idx" ON "credit_ledger"("workspace_id", "entry_type");

CREATE TABLE "domain_cache" (
  "domain_normalized" TEXT NOT NULL,
  "mx_records" JSONB,
  "dns_status" "DnsStatus",
  "disposable_domain_flag" BOOLEAN NOT NULL DEFAULT false,
  "free_provider_flag" BOOLEAN NOT NULL DEFAULT false,
  "catch_all_status" "CatchAllStatus",
  "smtp_capability_status" TEXT,
  "source_dataset_version" TEXT,
  "checked_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "domain_cache_pkey" PRIMARY KEY ("domain_normalized")
);

CREATE TABLE "webhook_endpoints" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "url" TEXT NOT NULL,
  "secret_ciphertext" TEXT NOT NULL,
  "events" JSONB NOT NULL DEFAULT '["batch.completed", "batch.failed"]',
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_endpoints_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "webhook_endpoints_workspace_id_idx" ON "webhook_endpoints"("workspace_id");

CREATE TABLE "audit_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID,
  "actor_id" UUID,
  "action" TEXT NOT NULL,
  "resource_type" TEXT NOT NULL,
  "resource_id" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "audit_events_workspace_id_created_at_idx" ON "audit_events"("workspace_id", "created_at");
CREATE INDEX "audit_events_resource_type_resource_id_idx" ON "audit_events"("resource_type", "resource_id");
