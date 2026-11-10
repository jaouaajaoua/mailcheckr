import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "MailCheckr — Explainable email verification",
  description:
    "MailCheckr shows what is known, what is risky, and what cannot be verified about an email address — with reason codes for every result.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            MailCheckr
          </Link>
          <nav className="site-nav" aria-label="Primary">
            <Link href="/docs/api">API docs</Link>
            <Link href="/login">Sign in</Link>
            <Link href="/register" className="btn btn-small">
              Create account
            </Link>
          </nav>
        </header>
        <main className="container">{children}</main>
        <footer className="site-footer">
          <p>
            MailCheckr never sends email to the addresses it checks. Deep SMTP probing is only enabled after
            outbound TCP port 25 is tested and approved from the production worker environment — see the{" "}
            <Link href="/docs/api">API documentation</Link> for the current mode availability.
          </p>
        </footer>
      </body>
    </html>
  );
}
