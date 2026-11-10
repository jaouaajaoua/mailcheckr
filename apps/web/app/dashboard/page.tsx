"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  api,
  asList,
  ApiError,
  type Batch,
  type Usage,
  type VerificationResult,
} from "@/lib/api";
import { EmptyState, ErrorBox, formatDate, Loading, StatusBadge } from "@/components/ui";

export default function DashboardHome() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [checks, setChecks] = useState<VerificationResult[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [u, c, b] = await Promise.all([api.usage(), api.recentVerifications(10), api.listBatches(10)]);
        setUsage(u);
        setChecks(asList(c));
        setBatches(asList(b));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not load your dashboard data.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <Loading label="Loading usage, recent checks, and batches…" />;
  if (error) return <ErrorBox message={error} />;

  const balance = usage?.credits_balance ?? usage?.balance;
  const used = usage?.credits_charged ?? usage?.credits_used;

  return (
    <>
      <h1>Overview</h1>
      <div className="grid">
        <div className="card">
          <div className="stat">{balance ?? "—"}</div>
          <div className="stat-label">Credit balance (from GET /v1/usage)</div>
        </div>
        <div className="card">
          <div className="stat">{used ?? "—"}</div>
          <div className="stat-label">Credits charged</div>
        </div>
        <div className="card">
          <div className="stat">{usage?.credits_reserved ?? "—"}</div>
          <div className="stat-label">Credits reserved by running batches</div>
        </div>
        <div className="card">
          <div className="stat">{usage?.checks_this_month ?? usage?.checks_total ?? "—"}</div>
          <div className="stat-label">Checks this period{usage?.plan_code ? ` · plan: ${usage.plan_code}` : ""}</div>
        </div>
      </div>
      <p className="hint">
        Duplicates and <em>unknown</em> results are not charged. Every charge, reservation, release, and
        refund is recorded in the immutable credit ledger (see Settings for retention, or GET
        /v1/credits/ledger via the API).
      </p>

      <section className="card">
        <h2>Recent checks</h2>
        {checks.length === 0 ? (
          <EmptyState>
            No checks yet. Run your first one from <Link href="/dashboard/check">Single check</Link>.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Mode</th>
                  <th>Confidence</th>
                  <th>Checked</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={c.id}>
                    <td>{c.email ?? c.domain ?? c.id}</td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td>{c.mode}</td>
                    <td>{c.confidence}</td>
                    <td>{formatDate(c.checked_at ?? c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Recent batches</h2>
        {batches.length === 0 ? (
          <EmptyState>
            No bulk batches yet. Create one from <Link href="/dashboard/batches">Bulk batches</Link>.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Status</th>
                  <th>Rows</th>
                  <th>Completed</th>
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
                    <td>{b.row_count ?? "—"}</td>
                    <td>{b.completed_count ?? "—"}</td>
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
