"use client";

import { useState } from "react";
import { API_BASE } from "@/lib/api";
import { copyText } from "@/components/ui";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-small btn-secondary"
      onClick={async () => setDone(await copyText(text))}
    >
      {done ? "Copied ✓" : label}
    </button>
  );
}

export default function ApiDocsPage() {
  const createKey = `curl -X POST ${API_BASE}/v1/api-keys \\
  -H "Authorization: Bearer <dashboard-jwt>" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Production","scopes":["verifications:write","batches:write","batches:read","usage:read"]}'`;

  const singleCheck = `curl -X POST ${API_BASE}/v1/verifications \\
  -H "Authorization: Bearer mc_live_YOUR_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"person@example.com","mode":"quick","idempotency_key":"signup-12345"}'`;

  const createBatch = `curl -X POST ${API_BASE}/v1/batches \\
  -H "Authorization: Bearer mc_live_YOUR_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"November contacts","emails":["one@example.com","two@example.com"],"mode":"quick","idempotency_key":"nov-import-1"}'`;

  const pollBatch = `curl ${API_BASE}/v1/batches/BATCH_ID \\
  -H "Authorization: Bearer mc_live_YOUR_SECRET"

curl "${API_BASE}/v1/batches/BATCH_ID/results?status=invalid&limit=100" \\
  -H "Authorization: Bearer mc_live_YOUR_SECRET"`;

  const exportBatch = `curl -X POST ${API_BASE}/v1/batches/BATCH_ID/export \\
  -H "Authorization: Bearer mc_live_YOUR_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"statuses":["valid","likely_valid"]}' \\
  -o mailcheckr-export.csv`;

  const usage = `curl ${API_BASE}/v1/usage \\
  -H "Authorization: Bearer mc_live_YOUR_SECRET"`;

  const exampleResponse = `{
  "id": "ver_01...",
  "status": "likely_valid",
  "mode": "quick",
  "confidence": "medium",
  "email": "person@example.com",
  "domain": "example.com",
  "checks": {
    "syntax": "passed",
    "domain": "passed",
    "mx": "passed",
    "smtp_mailbox": "not_checked"
  },
  "reason_codes": ["smtp_not_attempted_quick_mode"],
  "explanation": "The address format and domain mail routing appear valid. The individual mailbox was not tested in Quick mode.",
  "checked_at": "2026-11-10T00:00:00Z"
}`;

  const errorEnvelope = `{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Request rate limit exceeded.",
    "request_id": "req_...",
    "retry_after_seconds": 30
  }
}`;

  return (
    <>
      <h1>API documentation</h1>
      <p>
        Base URL: <code className="inline-code">{API_BASE}/v1</code> · JSON request/response · OpenAPI 3.1
        contract in <code className="inline-code">docs/api.md</code>.
      </p>

      <div className="notice">
        <strong>Mode availability:</strong> Quick mode is available. Deep SMTP mode is gated on outbound
        TCP port 25 being tested and approved from the production worker environment and currently returns
        an error rather than a simulated result. MailCheckr never sends email and never issues the SMTP
        DATA command.
      </div>

      <section className="card">
        <h2>Authentication</h2>
        <p>
          Create a key in <strong>Dashboard → API keys</strong> (or via the API with a dashboard session
          token), then send it as a bearer token. The full secret is shown once; only a hash is stored.
          Never put API keys in query strings.
        </p>
        <pre>{createKey}</pre>
        <CopyButton text={createKey} label="Copy curl" />
      </section>

      <section className="card">
        <h2>Single verification — POST /v1/verifications</h2>
        <pre>{singleCheck}</pre>
        <CopyButton text={singleCheck} label="Copy curl" />
        <h3>Example response</h3>
        <pre>{exampleResponse}</pre>
        <CopyButton text={exampleResponse} label="Copy JSON" />
        <p className="hint">
          Statuses: <code>valid</code> (SMTP-accepted, Deep only, catch-all conclusive),{" "}
          <code>likely_valid</code>, <code>invalid</code>, <code>risky</code>, <code>unknown</code>.
          Confidence is a qualitative evidence label — high / medium / low — not a probability.
        </p>
      </section>

      <section className="card">
        <h2>Bulk batches — POST /v1/batches</h2>
        <p className="hint">
          JSON batches are capped at 1,000 emails; the dashboard CSV flow caps at 10,000 rows. Duplicate
          rows are not charged twice and <code>unknown</code> outcomes are not charged.
        </p>
        <pre>{createBatch}</pre>
        <CopyButton text={createBatch} label="Copy curl" />
        <h3>Poll status and page results</h3>
        <pre>{pollBatch}</pre>
        <CopyButton text={pollBatch} label="Copy curl" />
        <h3>Export results as CSV</h3>
        <pre>{exportBatch}</pre>
        <CopyButton text={exportBatch} label="Copy curl" />
      </section>

      <section className="card">
        <h2>Usage — GET /v1/usage</h2>
        <pre>{usage}</pre>
        <CopyButton text={usage} label="Copy curl" />
      </section>

      <section className="card">
        <h2>Errors</h2>
        <p>Every error uses the same envelope. Raw SMTP transcripts and stack traces are never returned.</p>
        <pre>{errorEnvelope}</pre>
        <CopyButton text={errorEnvelope} label="Copy JSON" />
      </section>
    </>
  );
}
