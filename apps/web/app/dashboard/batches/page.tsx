"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, asList, ApiError, type Batch, type VerificationMode } from "@/lib/api";
import { extractEmailsFromCsv, extractEmailsFromPaste, readFileAsText, type ParsedEmailList } from "@/lib/csv";
import { EmptyState, ErrorBox, formatDate, Loading } from "@/components/ui";

const MAX_JSON_EMAILS = 1000;
const MAX_CSV_ROWS = 10000;

export default function BatchesPage() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [paste, setPaste] = useState("");
  const [mode, setMode] = useState<VerificationMode>("quick");
  const [parsed, setParsed] = useState<ParsedEmailList | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setBatches(asList(await api.listBatches(50)));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load batches.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCreateError(null);
    try {
      const text = await readFileAsText(file);
      const result = extractEmailsFromCsv(text);
      setParsed(result);
      setFileName(file.name);
      setPaste("");
    } catch {
      setCreateError("Could not read that file in the browser. Try a plain-text .csv file.");
    }
  }

  function candidateEmails(): string[] {
    if (parsed) return parsed.emails;
    return extractEmailsFromPaste(paste);
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    const emails = candidateEmails();
    if (emails.length === 0) {
      setCreateError("Add at least one email address — paste a list or choose a CSV file first.");
      return;
    }
    if (emails.length > MAX_JSON_EMAILS) {
      setCreateError(
        `This form sends addresses as JSON, which the API caps at ${MAX_JSON_EMAILS} per batch. Split the list or use the upload flow described in the API docs.`,
      );
      return;
    }
    setCreating(true);
    try {
      const batch = await api.createBatch(name.trim() || fileName || "Untitled batch", emails, mode);
      setPaste("");
      setParsed(null);
      setFileName(null);
      if (fileRef.current) fileRef.current.value = "";
      await load();
      window.location.assign(`/dashboard/batches/${batch.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create the batch.");
    } finally {
      setCreating(false);
    }
  }

  const preview = candidateEmails();

  return (
    <>
      <h1>Bulk batches</h1>

      <section className="card">
        <h2>Create a batch</h2>
        <form onSubmit={onCreate}>
          <label htmlFor="bname">Batch name</label>
          <input
            id="bname"
            type="text"
            placeholder="November contacts"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <label htmlFor="paste">Paste email addresses (one per line, or comma-separated)</label>
          <textarea
            id="paste"
            placeholder={"one@example.com\ntwo@example.com"}
            value={paste}
            onChange={(e) => {
              setPaste(e.target.value);
              setParsed(null);
              setFileName(null);
            }}
          />

          <label htmlFor="csv">…or upload a CSV file (read as text in your browser; max {MAX_CSV_ROWS.toLocaleString()} rows server-side)</label>
          <input id="csv" type="file" accept=".csv,text/csv,text/plain" ref={fileRef} onChange={onFile} />
          {parsed && (
            <p className="hint" role="status">
              Parsed <strong>{fileName}</strong>: {parsed.rowCount.toLocaleString()} data row(s)
              {parsed.emailColumnName ? `, email column “${parsed.emailColumnName}”` : ""},{" "}
              {parsed.emails.length.toLocaleString()} address(es) found. Duplicates are detected
              server-side and are not charged twice.
            </p>
          )}
          {!parsed && preview.length > 0 && (
            <p className="hint" role="status">
              {preview.length.toLocaleString()} address(es) ready. The server counts unique addresses and
              the billable maximum before processing.
            </p>
          )}

          <label htmlFor="bmode">Mode</label>
          <select id="bmode" value={mode} onChange={(e) => setMode(e.target.value as VerificationMode)}>
            <option value="quick">Quick — syntax, risk signals, DNS/MX</option>
            <option value="deep" disabled>
              Deep SMTP — unavailable: port-25 gate has not passed
            </option>
          </select>

          {createError && <ErrorBox message={createError} />}
          <div className="form-actions">
            <button type="submit" className="btn" disabled={creating}>
              {creating ? "Creating batch…" : "Create batch"}
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2>Your batches</h2>
        {loading ? (
          <Loading label="Loading batches…" />
        ) : error ? (
          <ErrorBox message={error} />
        ) : batches.length === 0 ? (
          <EmptyState>No batches yet. Create your first batch with the form above.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Status</th>
                  <th>Mode</th>
                  <th>Rows</th>
                  <th>Unique</th>
                  <th>Duplicates</th>
                  <th>Completed</th>
                  <th>Charged</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/dashboard/batches/${b.id}`}>{b.name ?? b.id}</Link>
                    </td>
                    <td>{b.status}</td>
                    <td>{b.mode}</td>
                    <td>{b.row_count ?? "—"}</td>
                    <td>{b.unique_count ?? "—"}</td>
                    <td>{b.duplicate_count ?? "—"}</td>
                    <td>{b.completed_count ?? "—"}</td>
                    <td>{b.credits_charged ?? "—"}</td>
                    <td>{formatDate(b.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
