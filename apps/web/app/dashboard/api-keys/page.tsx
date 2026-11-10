"use client";

import { useCallback, useEffect, useState } from "react";
import { api, asList, ApiError, type ApiKey, type CreatedApiKey } from "@/lib/api";
import { copyText, EmptyState, ErrorBox, formatDate, Loading } from "@/components/ui";

const SCOPE_OPTIONS = ["verifications:write", "batches:write", "batches:read", "usage:read"];

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["verifications:write", "batches:write", "batches:read", "usage:read"]);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys(asList(await api.listApiKeys()));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load API keys.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleScope(scope: string) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);
    setCopied(false);
    if (scopes.length === 0) {
      setError("Select at least one scope for the new key.");
      return;
    }
    setBusy(true);
    try {
      const key = await api.createApiKey(name.trim() || "Untitled key", scopes);
      setCreated(key);
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the API key.");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(key: ApiKey) {
    if (!window.confirm(`Revoke key “${key.name}” (${key.key_prefix}…)? Calls using it will fail immediately.`)) return;
    setRevoking(key.id);
    try {
      await api.revokeApiKey(key.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke the key.");
    } finally {
      setRevoking(null);
    }
  }

  return (
    <>
      <h1>API keys</h1>
      <p className="hint">
        Keys authenticate server-to-server calls as <span className="inline-code">Authorization: Bearer mc_live_…</span>.
        Only a hash is stored server-side; the full secret is shown exactly once, at creation.
      </p>

      {created && (
        <div className="secret-box" role="alert">
          <strong>Copy your new secret now — it will not be shown again.</strong>
          <p>
            <code>{created.secret}</code>
          </p>
          <button
            type="button"
            className="btn btn-small"
            onClick={async () => setCopied(await copyText(created.secret))}
          >
            {copied ? "Copied ✓" : "Copy secret"}
          </button>{" "}
          <button type="button" className="btn btn-small btn-secondary" onClick={() => setCreated(null)}>
            I have stored it — dismiss
          </button>
        </div>
      )}

      <section className="card">
        <h2>Create a key</h2>
        {error && <ErrorBox message={error} />}
        <form onSubmit={onCreate}>
          <label htmlFor="kname">Key name</label>
          <input
            id="kname"
            type="text"
            placeholder="Production signup form"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label>Scopes</label>
          {SCOPE_OPTIONS.map((scope) => (
            <label key={scope} className="checkbox-row">
              <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} />
              {scope}
            </label>
          ))}
          <div className="form-actions">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? "Creating…" : "Create API key"}
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2>Your keys</h2>
        {loading ? (
          <Loading label="Loading API keys…" />
        ) : keys.length === 0 ? (
          <EmptyState>No API keys yet. Create one with the form above.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Scopes</th>
                  <th>Last used</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td>
                      <code>{k.key_prefix}…</code>
                    </td>
                    <td>{k.scopes?.join(", ") ?? "—"}</td>
                    <td>{k.last_used_at ? formatDate(k.last_used_at) : "Never"}</td>
                    <td>{formatDate(k.created_at)}</td>
                    <td>{k.revoked_at ? `Revoked ${formatDate(k.revoked_at)}` : "Active"}</td>
                    <td>
                      {!k.revoked_at && (
                        <button
                          type="button"
                          className="btn btn-small btn-danger"
                          disabled={revoking === k.id}
                          onClick={() => onRevoke(k)}
                        >
                          {revoking === k.id ? "Revoking…" : "Revoke"}
                        </button>
                      )}
                    </td>
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
