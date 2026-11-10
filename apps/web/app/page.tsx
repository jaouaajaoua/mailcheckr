import Link from "next/link";

export default function LandingPage() {
  return (
    <>
      <section className="hero">
        <h1>Email verification that shows its evidence.</h1>
        <p className="lede">
          MailCheckr tells you what is known, what is risky, and what cannot be verified about an email
          address — then makes those results easy to use in your product and your bulk workflows. Every
          result includes the checks performed, stable reason codes, and a plain-language explanation.
        </p>
        <div className="form-actions">
          <Link href="/register" className="btn">
            Create a free account
          </Link>
          <Link href="/docs/api" className="btn btn-secondary">
            Read the API docs
          </Link>
        </div>
      </section>

      <section className="grid" aria-label="How verification works">
        <div className="card">
          <h3>Quick mode — available now</h3>
          <p>
            Syntax and normalisation, disposable / role / free-provider signals, and DNS mail-routing
            checks (MX, Null MX, implicit-MX fallback). Quick mode never claims an individual mailbox was
            tested: a passing address is reported as <strong>likely valid</strong>, not verified.
          </p>
        </div>
        <div className="card">
          <h3>Deep SMTP mode — gated</h3>
          <p>
            Mailbox-level SMTP probing (EHLO → STARTTLS → RCPT, never DATA, never sending mail) is only
            enabled after outbound TCP port 25 is tested and approved from the production worker
            environment. Until that gate passes, Deep mode stays disabled rather than simulated.
          </p>
        </div>
        <div className="card">
          <h3>Conservative results</h3>
          <p>
            Catch-all domains, greylisting, policy rejections, and providers that defer mailbox validation
            are reported honestly as <strong>risky</strong> or <strong>unknown</strong> — never silently
            rounded up to “valid”. Unknown results are not charged.
          </p>
        </div>
      </section>

      <section className="card">
        <h2>What you get</h2>
        <ul>
          <li>Single checks from the dashboard and a versioned REST API (<span className="inline-code">/v1</span>).</li>
          <li>Bulk CSV and paste-list jobs with duplicate detection, preserved original columns, and filtered exports.</li>
          <li>API keys shown once, stored hashed, revocable at any time.</li>
          <li>An auditable credit ledger: duplicates and unknown outcomes are not charged.</li>
          <li>Short default retention (results 7 days) and immediate deletion controls in Settings.</li>
        </ul>
        <p className="hint">
          Confidence in MailCheckr is a qualitative evidence label (high / medium / low), not a statistical
          probability or a 0–100 score. An SMTP acceptance means the mail server accepted the recipient at
          check time — it is not a guarantee of inbox delivery.
        </p>
      </section>
    </>
  );
}
