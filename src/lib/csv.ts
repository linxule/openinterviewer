// Safe CSV cell helpers
// Neutralizes spreadsheet formula injection: any cell whose first non-whitespace
// character is one of = + - @, or that begins with a tab/CR/LF, is prefixed with
// an apostrophe so spreadsheet apps treat it as text rather than executing it.
// Quotes are escaped for correct CSV quoting.

// Neutralize: leading formula characters (= + - @), possibly after leading
// whitespace, AND any cell that begins with a tab/CR/LF character (a common
// injection vector that spreadsheet apps may still interpret as a formula).
const FORMULA_PREFIX = /^(?:[\s]*[=+\-@]|[\t\r\n])/;

export function neutralizeCsvFormula(value: string): string {
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

// Render a string as a quoted, formula-safe CSV cell.
export function csvCell(value: string): string {
  return `"${neutralizeCsvFormula(value).replace(/"/g, '""')}"`;
}
