"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { ErrorBox } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.login(email.trim(), password);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onReset() {
    setError(null);
    if (!email.trim()) {
      setError("Enter your email address first, then request a password reset.");
      return;
    }
    try {
      await api.requestPasswordReset(email.trim());
      setResetSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not request a password reset.");
    }
  }

  return (
    <div className="card" style={{ maxWidth: 460, margin: "2rem auto" }}>
      <h1>Sign in</h1>
      {error && <ErrorBox message={error} />}
      {resetSent && (
        <p className="state state-success" role="status">
          If an account exists for that address, a password-reset email is on its way.
        </p>
      )}
      <form onSubmit={onSubmit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="form-actions">
          <button type="submit" className="btn" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onReset}>
            Forgot password
          </button>
        </div>
      </form>
      <p className="hint">
        No account yet? <Link href="/register">Create one</Link>.
      </p>
    </div>
  );
}
