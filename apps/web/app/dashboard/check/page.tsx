"use client";

import { useState } from "react";
import { api, ApiError, type VerificationMode, type VerificationResult } from "@/lib/api";
import { copyText, ErrorBox, StatusBadge } from "@/components/ui";

export default function SingleCheckPage() {
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<VerificationMode>("quick");
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setCopied(false);
    setBusy(true);
    try {
      const res = await api.verify(email.trim(), mode);
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The check failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    if (!result) return;
    setCopied(await copyText(JSON.stringify(result, null, 2)));
  }

  const checksEntries: Array<[string, string]> = result?.checks
    ? Object.entries(result.checks)
    : result?.checks_performed && !Array.isArray(result.checks_performed)
      ? Object.entries(result.checks_performed as Record<string, unknown>).map(
          ([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)] as [string, string],
        )
      : [];

  return (
    <>
      <h1>Single check</h1>
      <div className="card">
        <form onSubmit={onSubmit}>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            type="email"
            required
            placeholder="person@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label htmlFor="mode">Mode</label>
          <select id="mode" value={mode} onChange={(e) => setMode(e.target.value as VerificationMode)}>
            <option value="quick">Quick — syntax, risk signals, DNS/MX (mailbox not tested)</option>
            <option value="deep" disabled>
              Deep SMTP — unavailable: port-25 gate has not passed (see docs/phase-0-audit.md)
            </option>
          </select>
          <p className="hint">
            Deep mode is disabled, not simulated: outbound TCP/25 has not been tested and approved from a
            production worker environment, so MailCheckr will not claim mailbox-level verification.
          </p>
          <div className="form-actions">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? "Checking…" : "Verify email"}
            </button>
          </div>
        </form>
      </div>

      {error && <ErrorBox message={error} />}

      {result && (
        <section className="card" aria-label="Verification result">
          <h2>
            Result: <StatusBadge status={result.status} />
          </h2>
          <div className="table-wrap">
            <table>
              <tbody>
                <tr>
                  <th scope="row">Email</th>
                  <td>{result.email ?? email}</td>
                </tr>
                <tr>
                  <th scope="row">Domain</th>
                  <td>{result.domain ?? "—"}</td>
                </tr>
                <tr>
                  <th scope="row">Mode</th>
                  <td>{result.mode}</td>
                </tr>
                <tr>
                  <th scope="row">Confidence</th>
                  <td>
                    {result.confidence}{" "}
                    <span className="hint">(qualitative evidence label, not a probability)</span>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Reason codes</th>
                  <td>{result.reason_codes?.length ? result.reason_codes.join(", ") : "—"}</td>
                </tr>
                <tr>
                  <th scope="row">Explanation</th>
                  <td>{result.explanation}</td>
                </tr>
                <tr>
                  <th scope="row">Checked at</th>
                  <td>{result.checked_at ?? "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {checksEntries.length > 0 && (
            <>
              <h3>Checks breakdown</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Check</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checksEntries.map(([name, outcome]) => (
                      <tr key={name}>
                        <td>{name}</td>
                        <td>{outcome}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onCopy}>
              {copied ? "Copied ✓" : "Copy JSON result"}
            </button>
          </div>
          <pre aria-label="Raw JSON result">{JSON.stringify(result, null, 2)}</pre>
        </section>
      )}
    </>
  );
}
