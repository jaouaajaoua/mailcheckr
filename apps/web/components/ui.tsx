"use client";

import type { VerificationStatus } from "@/lib/api";

export function StatusBadge({ status }: { status: VerificationStatus | string }) {
  return <span className={`badge badge-${status.replace("_", "-")}`}>{status.replace("_", " ")}</span>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="state state-loading" role="status">
      {label}
    </p>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="state state-empty">{children}</div>;
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="state state-error" role="alert">
      {message}
    </div>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "valid", label: "Valid" },
  { value: "likely_valid", label: "Likely valid" },
  { value: "invalid", label: "Invalid" },
  { value: "risky", label: "Risky" },
  { value: "unknown", label: "Unknown" },
  { value: "duplicate", label: "Duplicate" },
];
