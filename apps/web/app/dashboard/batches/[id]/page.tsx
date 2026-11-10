"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  api,
  asList,
  ApiError,
  type Batch,
  type BatchResultRow,
} from "@/lib/api";
import { EmptyState, ErrorBox, formatDate, Loading, StatusBadge, STATUS_FILTERS } from "@/components/ui";

const TERMINAL = new Set(["completed", "completed_with_errors", "failed", "cancelled", "expired"]);

export default function BatchDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [batch, setBatch] = useState<Batch | null>(null);
  const [results, setResults] = useState<BatchResultRow[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadResults = useCallback(
    async (statusFilter: string) => {
      const payload = await api.batchResults(id, { status: statusFilter || undefined, limit: 200 });
      setResults(asList(payload as BatchResultRow[] | { data: BatchResultRow[] }));
    },
    [id],
  );

  const loadBatch = useCallback(async () => {
    const b = await api.getBatch(id);
    setBatch(b);
    return b;
  }, [id]);

  useEffect(() => {
    (async () => {
      try {
        await loadBatch();
        await loadResults(filter);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not load this batch.");
      } finally {
        setLoading(false);
      }
    })();
    // Poll progress every 3s while the batch is non-terminal.
    timer.current = setInterval(async () => {
      try {
        const b = await loadBatch();
        if (TERMINAL.has(b.status)) {
          if (timer.current) clearInterval(timer.current);
          await loadResults(filter);
        }
      } catch {
        /* transient poll errors are ignored; the next tick retries */
      }
    }, 3000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function onFilterChange(value: string) {
    setFilter(value);
    try {
      await loadResults(value);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load filtered results.");
    }
  }

  async function onCancel() {
    if (!window.confirm("Cancel this batch? Unused reserved credits are released.")) return;
    setBusy("cancel");
    try {
      setBatch(await api.cancelBatch(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel the batch.");
    } finally {
      setBusy(null);
    }
  }

  async function onExport() {
    setBusy("export");
    setExportNote(null);
    try {
      await api.exportBatch(id, filter ? [filter] : undefined);
      setExportNote("Export download started. Exports preserve every original CSV column and row order.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (!window.confirm("Delete this batch and its results permanently? This cannot be undone.")) return;
    setBusy("delete");
    try {
      await api.deleteBatch(id);
      router.push("/dashboard/batches");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the batch.");
      setBusy(null);
    }
  }

  if (loading) return <Loading label="Loading batch…" />;
  if (error && !batch) return <ErrorBox message={error} />;
  if (!batch) return <EmptyState>Batch not found.</EmptyState>;

  const total = batch.row_count ?? batch.unique_count ?? 0;
  const done = batch.completed_count ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : batch.status === "completed" ? 100 : 0;
  const isTerminal = TERMINAL.has(batch.status);

  return (
    <>
      <p>
        <Link href="/dashboard/batches">← All batches</Link>
      </p>
      <h1>{batch.name ?? batch.id}</h1>
      {error && <ErrorBox message={error} />}
      {exportNote && (
        <p className="state state-success" role="status">
          {exportNote}
        </p>
      )}

      <section className="card">
        <div className="table-wrap">
          <table>
            <tbody>
              <tr>
                <th scope="row">Status</th>
                <td>{batch.status}</td>
                <th scope="row">Mode</th>
                <td>{batch.mode}</td>
              </tr>
              <tr>
                <th scope="row">Rows / unique / duplicates</th>
                <td>
                  {batch.row_count ?? "—"} / {batch.unique_count ?? "—"} / {batch.duplicate_count ?? "—"}
                </td>
                <th scope="row">Credits reserved / charged / refunded</th>
                <td>
                  {batch.credits_reserved ?? "—"} / {batch.credits_charged ?? "—"} /{" "}
                  {batch.credits_refunded ?? "—"}
                </td>
              </tr>
              <tr>
                <th scope="row">Created</th>
                <td>{formatDate(batch.created_at)}</td>
                <th scope="row">Expires</th>
                <td>{formatDate(batch.expires_at)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Progress: {done.toLocaleString()} / {total.toLocaleString()} ({pct}%)
          {!isTerminal && " — refreshing automatically every 3 seconds."}
        </p>
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onExport} disabled={busy !== null || !isTerminal}>
            {busy === "export" ? "Preparing export…" : filter ? `Export ${filter.replace("_", " ")} rows (CSV)` : "Export all rows (CSV)"}
          </button>
          {!isTerminal && (
            <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy !== null}>
              {busy === "cancel" ? "Cancelling…" : "Cancel batch"}
            </button>
          )}
          <button type="button" className="btn btn-danger" onClick={onDelete} disabled={busy !== null}>
            {busy === "delete" ? "Deleting…" : "Delete batch & results"}
          </button>
        </div>
        {!isTerminal && <p className="hint">Exports are enabled when processing finishes.</p>}
      </section>

      <section className="card">
        <h2>Results</h2>
        <div className="filters" role="group" aria-label="Filter results by status">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.label}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => onFilterChange(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {results.length === 0 ? (
          <EmptyState>
            {isTerminal
              ? "No results match this filter."
              : "No results yet — they will appear here as processing completes."}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Confidence</th>
                  <th>Reason codes</th>
                  <th>Explanation</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.id}>
                    <td>{r.row_number ?? "—"}</td>
                    <td>
                      {r.email ?? "—"}
                      {r.is_duplicate ? ` (duplicate of row ${r.duplicate_of_row_number ?? "?"})` : ""}
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td>{r.confidence ?? "—"}</td>
                    <td>{r.reason_codes?.join(", ") ?? "—"}</td>
                    <td>{r.explanation ?? "—"}</td>
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
