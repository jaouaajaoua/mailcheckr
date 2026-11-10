/**
 * CSV export safety (PRD §10.4): prevent spreadsheet formula injection.
 *
 * A cell whose first meaningful character is one of `=`, `+`, `-`, `@`
 * (optionally preceded by spaces/tabs/CR/LF, a common bypass) can be
 * interpreted as a formula when the export is opened in a spreadsheet
 * application. Such cells are neutralized by prefixing a single quote.
 * Cells are then RFC 4180-quoted when they contain a comma, quote or
 * line break.
 */

const FORMULA_LEAD = /^[ \t\r\n]*[=+\-@]/;

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let cell = typeof value === "string" ? value : String(value);
  if (FORMULA_LEAD.test(cell)) {
    cell = `'${cell}`;
  }
  if (/[",\r\n]/.test(cell)) {
    cell = `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

export function escapeCsvRow(values: readonly unknown[]): string {
  return values.map(escapeCsvCell).join(",");
}

/** Serialize rows (including a header row) to a CRLF-delimited CSV string. */
export function buildCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map(escapeCsvRow).join("\r\n") + (rows.length > 0 ? "\r\n" : "");
}
