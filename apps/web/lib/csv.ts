/**
 * Minimal client-side CSV reading used by the bulk-create form.
 *
 * The file is read as text in the browser (FileReader), parsed with a small
 * quote-aware parser, and the email column is detected. Only the extracted
 * email addresses are sent to POST /v1/batches; the authoritative streaming
 * parse, original-row preservation, and deduplication happen server-side in
 * the worker (see docs/architecture.md).
 */

export interface ParsedEmailList {
  emails: string[];
  rowCount: number;
  emailColumnIndex: number | null;
  emailColumnName: string | null;
  headers: string[] | null;
}

/** Splits CSV text into rows of cells, honouring double-quoted fields. */
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushCell();
    } else if (ch === "\n") {
      if (cell.endsWith("\r")) cell = cell.slice(0, -1);
      pushRow();
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

const EMAIL_HEADER_HINTS = ["email", "e-mail", "email_address", "emailaddress", "address", "mail"];

/**
 * Detects the email column: prefers a header whose name hints at email,
 * otherwise the column with the highest share of `@`-containing values.
 */
export function extractEmailsFromCsv(text: string): ParsedEmailList {
  const rows = parseCsvText(text);
  if (rows.length === 0) {
    return { emails: [], rowCount: 0, emailColumnIndex: null, emailColumnName: null, headers: null };
  }

  const first = rows[0].map((c) => c.trim());
  const headerIdx = first.findIndex((c) => EMAIL_HEADER_HINTS.includes(c.toLowerCase()));
  const hasHeader = headerIdx >= 0 || first.every((c) => !c.includes("@"));
  const headers = hasHeader ? first : null;
  const dataRows = hasHeader ? rows.slice(1) : rows;

  let emailColumnIndex: number | null = hasHeader && headerIdx >= 0 ? headerIdx : null;
  if (emailColumnIndex === null) {
    let bestScore = 0;
    const width = Math.max(...dataRows.map((r) => r.length), 0);
    for (let col = 0; col < width; col++) {
      const score = dataRows.reduce((acc, r) => acc + ((r[col] ?? "").includes("@") ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        emailColumnIndex = col;
      }
    }
  }
  if (emailColumnIndex === null) emailColumnIndex = 0;

  const emails = dataRows
    .map((r) => (r[emailColumnIndex as number] ?? "").trim())
    .filter((v) => v.length > 0);

  return {
    emails,
    rowCount: dataRows.length,
    emailColumnIndex,
    emailColumnName: headers ? (headers[emailColumnIndex] ?? null) : null,
    headers,
  };
}

/** Extracts addresses from a pasted list: newline/comma/semicolon separated. */
export function extractEmailsFromPaste(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsText(file);
  });
}
