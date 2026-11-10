/**
 * SMTP reply parsing (RFC 5321 §4.2, RFC 3463 enhanced status codes).
 *
 * Replies may be multi-line: `250-...` lines continue until a final
 * `250 ...` line with the same code. The enhanced status code, when
 * present, is the first token of the reply text (e.g. `5.1.1`).
 */

export interface SmtpResponse {
  code: number;
  /** Enhanced status code such as "5.1.1" or "2.0.0", when present. */
  enhancedCode: string | null;
  /** Reply text of the final line, without code/enhanced prefix. */
  message: string;
  /** Full text of every line (reply text portions only). */
  lines: string[];
  /** Raw lines exactly as received. */
  rawLines: string[];
}

const LINE_RE = /^(\d{3})([ -])(.*)$/;
const ENHANCED_RE = /^(\d\.\d{1,3}\.\d{1,3})(?:\s+(.*))?$/;

export function parseSmtpResponseLines(rawLines: readonly string[]): SmtpResponse {
  if (rawLines.length === 0) throw new Error("Cannot parse an empty SMTP response");
  let code: number | null = null;
  const lines: string[] = [];
  for (const raw of rawLines) {
    const m = LINE_RE.exec(raw);
    if (!m) throw new Error(`Malformed SMTP reply line: ${JSON.stringify(raw)}`);
    const lineCode = Number(m[1]);
    if (code === null) code = lineCode;
    if (lineCode !== code) throw new Error(`Inconsistent codes in multi-line SMTP reply: ${raw}`);
    lines.push(m[3] ?? "");
  }
  const finalText = lines[lines.length - 1] ?? "";
  const enhanced = ENHANCED_RE.exec(finalText);
  return {
    code: code!,
    enhancedCode: enhanced ? enhanced[1]! : null,
    message: enhanced ? (enhanced[2] ?? "") : finalText,
    lines,
    rawLines: [...rawLines],
  };
}

/** Minimal line source the reader needs — satisfied by SmtpTransport. */
export interface LineSource {
  readLine(): Promise<string>;
}

/**
 * Read one complete (possibly multi-line) SMTP response from a line
 * source. Continuation lines use `-` after the code; the response ends
 * at a line using a space.
 */
export async function readSmtpResponse(source: LineSource): Promise<SmtpResponse> {
  const rawLines: string[] = [];
  for (;;) {
    const line = await source.readLine();
    rawLines.push(line);
    const m = LINE_RE.exec(line);
    if (!m) throw new Error(`Malformed SMTP reply line: ${JSON.stringify(line)}`);
    if (m[2] === " ") break;
    if (rawLines.length > 100) throw new Error("SMTP response exceeds 100 lines");
  }
  return parseSmtpResponseLines(rawLines);
}

/**
 * Collect ESMTP extension keywords from an EHLO reply. The first line is
 * the server greeting/domain; extensions follow, one per line, e.g.
 * `250-STARTTLS`, `250 SMTPUTF8`.
 */
export function collectExtensions(response: SmtpResponse): ReadonlySet<string> {
  const extensions = new Set<string>();
  for (const line of response.lines.slice(1)) {
    const keyword = line.trim().split(/\s+/)[0]?.toUpperCase();
    if (keyword) extensions.add(keyword);
  }
  // Some servers put a single extension on the only line's text after the
  // domain token; slice(1) covers the standard multi-line form.
  return extensions;
}
