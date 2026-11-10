"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, getStoredUser, getToken, type SessionUser } from "@/lib/api";
import { Loading } from "@/components/ui";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    setUser(getStoredUser());
    setReady(true);
    // Refresh the session user from the API; an expired token returns 401.
    api
      .me()
      .then((u) => setUser(u))
      .catch(() => {
        router.replace("/login");
      });
  }, [router]);

  async function onLogout() {
    await api.logout();
    router.push("/login");
  }

  if (!ready) return <Loading label="Checking your session…" />;

  return (
    <div className="dash-shell">
      <aside className="dash-nav" aria-label="Dashboard">
        <strong>{user?.email ?? "Account"}</strong>
        <Link href="/dashboard">Overview</Link>
        <Link href="/dashboard/check">Single check</Link>
        <Link href="/dashboard/batches">Bulk batches</Link>
        <Link href="/dashboard/api-keys">API keys</Link>
        <Link href="/dashboard/settings">Settings</Link>
        <Link href="/docs/api">API docs</Link>
        <button type="button" className="btn btn-secondary" onClick={onLogout}>
          Sign out
        </button>
      </aside>
      <div>{children}</div>
    </div>
  );
}
