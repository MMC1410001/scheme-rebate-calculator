/** One place for how figures are written, so the same number reads the same on every screen.
 *
 *  - Money is Indian style: Cr (crore, 1e7) and L (lakh, 1e5), with the minus sign U+2212.
 *  - Volume is litres. A large volume is written in kL (thousand litres), never "L", because "L" is lakh in money.
 *  - CN % has 2 decimals, a share (mix) 1. */

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const MINUS = "−";

/** 12,34,567 (a negative with the minus sign U+2212: −12,345) */
export const fmtInr = (n: number) => {
  const r = Math.round(n);
  return r < 0 ? `${MINUS}${inr.format(-r)}` : inr.format(r);
};

/** Compact rupees without the ₹ sign (for columns whose header says ₹): 12.34 Cr / 5.67 L / 8,900. */
export function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n), s = n < 0 ? MINUS : "";
  if (a >= 1e7) return `${s}${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${s}${(a / 1e5).toFixed(2)} L`;
  return `${s}${fmtInr(a)}`;
}

/** Compact rupees with the ₹ sign: −₹12.34 Cr / ₹5.67 L / ₹8,900. */
export function rupees(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n), s = n < 0 ? MINUS : "";
  return `${s}₹${money(a)}`;
}

/** Signed compact rupees for a change: +₹1.20 L / −₹3.40 Cr. */
export function signedRupees(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? MINUS : ""}₹${money(Math.abs(n))}`;
}

/** Volume for a column whose header says litres: 8,900 / 2,722 kL. */
export function vol(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n), s = n < 0 ? MINUS : "";
  if (a >= 1e5) return `${s}${fmtInr(a / 1e3)} kL`;
  return `${s}${fmtInr(a)}`;
}

/** Volume in a sentence: 12,34,567 litres. */
export const litresText = (n: number) => `${fmtInr(n)} litres`;

/** A percentage: 1 decimal by default (shares), 2 for CN %. */
export const pct = (n: number | null | undefined, d = 1) =>
  n == null || !Number.isFinite(n) ? "—" : `${n < 0 ? MINUS : ""}${Math.abs(n).toFixed(d)}%`;

/** A month-on-month change worth showing: ±1% for amounts, ±0.1 percentage point (pp) for shares. */
export const isMaterial = (x: number, pp: boolean) => Math.abs(x) + 1e-9 >= (pp ? 0.1 : 1);

/** Class for a change in CN: higher is a cost (red); lower is "lower" (neutral blue), never a saving -- a settled
 *  month's credit notes are paid, and a lower simulated figure is the cost of a future structure, not money back. */
export const cnClass = (d: number, eps = 0.5) => (Math.abs(d) < eps ? "muted" : d > 0 ? "cost" : "lower");
