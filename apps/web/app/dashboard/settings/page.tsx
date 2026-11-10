"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  api,
  asList,
  ApiError,
  clearSession,
  getStoredUser,
  type LedgerEntry,
  type WorkspaceSettings,
} from "@/lib/api";
import { ErrorBox, formatDate, Loading } from "@/components/ui";

export default function SettingsPage() {
  const router = useRouter();
  const user = getStoredUser();
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  useEffect(() => {
    (async () => {
      try {
        setLedger(asList(await api.ledger(25)));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not load the credit ledger.");
      } finally {
        setLedgerLoading(false);
      }
    })();
    (async () => {
      try {
        setSettings(await api.getSettings());
      } catch (err) {
        // Honest fallback: label the product defaults as defaults, never as
        // the workspace's live setting.
        setSettingsError(
          err instanceof ApiError ? err.message : "The API did not return workspace settings.",
        );
      }
    })();
  }, []);

  const sourceRetention =
    settings?.source_retention_hours != null
      ? `${settings.source_retention_hours} hours`
      : settings?.source_retention_days != null
        ? `${settings.source_retention_days} day(s)`
        : null;
  const resultRetention =
    settings?.result_retention_days != null ? `${settings.result_retention_days} days` : null;

  async function onDeleteBatchData() {
    if (!window.confirm("Delete ALL of your batch data and results now? Single-check history in the ledger remains for accounting.")) return;
    setBusy("batches");
    setError(null);
    setNotice(null);
    try {
      const batches = asList(await api.listBatches(200));
      let deleted = 0;
      for (const b of batches) {
        await api.deleteBatch(b.id);
        deleted++;
      }
      setNotice(`Deleted ${deleted} batch(es) and their results via DELETE /v1/batches/:id.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Batch data deletion failed partway through. Reload the batches page to see what remains.");
    } finally {
      setBusy(null);
    }
  }

  async function onDeleteAccount() {
    setBusy("account");
    setError(null);
    try {
      await api.requestAccountDeletion();
      clearSession();
      router.push("/login");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit the account deletion request.");
      setBusy(null);
    }
  }

  return (
    <>
      <h1>Settings</h1>
      {error && <ErrorBox message={error} />}
      {notice && (
        <p className="state state-success" role="status">
          {notice}
        </p>
      )}

      <section className="card">
        <h2>Account</h2>
        <p>
          Signed in as <strong>{user?.email ?? "—"}</strong>
          {user?.workspace_id ? (
            <>
              {" "}· workspace <code>{user.workspace_id}</code>
            </>
          ) : null}
          .
        </p>
      </section>

      <section className="card">
        <h2>Data retention</h2>
        {settings ? (
          <p className="state state-success" role="status">
            Your workspace&apos;s live settings (GET /v1/account/settings): raw source files kept{" "}
            <strong>{sourceRetention ?? "per server default"}</strong> after processing; verification
            results kept <strong>{resultRetention ?? "per server default"}</strong>.
          </p>
        ) : settingsError ? (
          <p className="hint" role="status">
            The API did not return your workspace settings ({settingsError}), so the product defaults
            from PRD §10.2 are shown below — they are defaults, not a read-back of your workspace.
          </p>
        ) : (
          <Loading label="Loading your workspace retention settings…" />
        )}
        <ul>
          <li>
            <strong>Raw uploaded source files:</strong> deleted 24 hours after successful processing
            (product default).
          </li>
          <li>
            <strong>Verification results:</strong> retained 7 days by default, then expired automatically.
            You can delete any batch immediately from its detail page.
          </li>
          <li>
            <strong>Operational logs:</strong> minimised metadata only; full email addresses, API keys, and
            passwords are never written to logs.
          </li>
          <li>
            <strong>Credit ledger:</strong> kept as the accounting record of grants, reservations, charges,
            and refunds. Ledger entries reference batches by ID, not by email content.
          </li>
        </ul>
        <p className="hint">
          Retention defaults follow PRD §10.2 and are applied by the scheduler&apos;s expiry jobs; deleting
          below takes effect immediately through the API.
        </p>
        <div className="form-actions">
          <button type="button" className="btn btn-danger" onClick={onDeleteBatchData} disabled={busy !== null}>
            {busy === "batches" ? "Deleting batch data…" : "Delete all my batch data now"}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Credit ledger (recent entries)</h2>
        {ledgerLoading ? (
          <Loading label="Loading ledger…" />
        ) : ledger.length === 0 ? (
          <p className="hint">No ledger entries yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Quantity</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((e) => (
                  <tr key={e.id}>
                    <td>{formatDate(e.created_at)}</td>
                    <td>{e.entry_type}</td>
                    <td>{e.quantity}</td>
                    <td>{e.description ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Delete account</h2>
        <p>
          This submits an account-deletion request (<span className="inline-code">DELETE /v1/account</span>).
          Your workspace data is scheduled for erasure and you will be signed out. Type{" "}
          <strong>DELETE</strong> to enable the button.
        </p>
        <label htmlFor="confirm">Confirmation</label>
        <input
          id="confirm"
          type="text"
          value={deleteConfirm}
          onChange={(e) => setDeleteConfirm(e.target.value)}
          placeholder="DELETE"
        />
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-danger"
            disabled={deleteConfirm !== "DELETE" || busy !== null}
            onClick={onDeleteAccount}
          >
            {busy === "account" ? "Submitting…" : "Request account deletion"}
          </button>
        </div>
      </section>
    </>
  );
}
