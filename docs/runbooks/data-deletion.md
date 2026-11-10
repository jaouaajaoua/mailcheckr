# Runbook — Data deletion request

Covers user-initiated deletion (dashboard/API) and external data-subject requests relayed by a customer. Product defaults (PRD §10.2): source files deleted 24 h after processing; results expire after 7 days; users can delete any batch immediately; account deletion via `DELETE /v1/account`.

## Request types and handling

### A. Single batch deletion
- User action: batch page → Delete, or `DELETE /v1/batches/:batchId`. Immediate: batch, rows, results, and stored source are removed; an audit event records the deletion (metadata only).
- Verify: the batch ID returns `404` for that workspace, and the export endpoint likewise.

### B. "Delete all my batch data" (Settings)
- The dashboard loops `DELETE /v1/batches/:id` over the workspace's batches and reports the count. Verify zero batches remain via `GET /v1/batches`.
- Note: the **credit ledger remains** — it is the accounting record and references batches by ID, not email content. Explain this to the requester rather than promising ledger erasure.

### C. Account deletion
1. Request: `DELETE /v1/account` (or a verified email request to support). Session is invalidated immediately; workspace enters deletion scheduling.
2. Erasure job deletes: batches, rows, verification records (ciphertext + HMAC), domain-cache entries are **kept** only if they contain no personal data (domain-level aggregates, no addresses), API keys, uploaded sources, and exports. The user row is anonymised/deleted per policy.
3. Confirm completion in the audit log and reply to the requester with what was deleted and the one retention exception below.

### D. Backups and propagation
- Deleted data persists in database backups until they age out (14-day backup retention — see `db-restore.md`). State this window honestly to requesters.
- After any backup **restore**, pending deletions must be re-applied before traffic reopens (the restore runbook includes this step).

## Verification checklist
- [ ] Workspace/batch IDs return `404` via API.
- [ ] Object storage: source + export objects for the scope are absent.
- [ ] Redis: no job payloads reference the deleted record IDs (payloads carry IDs only, never addresses).
- [ ] Logs were not altered (logs never contained the addresses in the first place — minimised metadata only).
- [ ] Requester notified with scope, completion time, and the backup-ageing window.

## Escalation
Requests involving another party's data, legal holds, or suspected breach-driven exfiltration go to legal review before any deletion that could destroy evidence; document the hold in the incident record.
