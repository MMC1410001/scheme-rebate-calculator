import type { Formula, SlabRow } from "./client";
import { fmtInr, rupees } from "../format.ts";

export { fmtInr };

/**
 * Mirrors backend app/core/simulate.py, and must keep mirroring it: the two run
 * the same edit, and if they disagree the figure changes when the server
 * replies.
 *
 * The payout is scaled by the CHANGE in rate rather than rebuilt from cn_units.
 * current_cn is what the file settled; cn_units * rate is a reconstruction of
 * it that agrees per dealer but not always per band, because a band can hold
 * dealers on different regional rate cards. Rebuilding it reported a -4.1%
 * impact on an untouched simulation. A band with no current rate -- a new slab,
 * or one paying nothing today -- has no ratio to scale and falls back to units.
 */
export function withSimulatedRate(row: SlabRow, newRate: number): SlabRow {
  // An untouched rate returns exactly what was paid -- nothing is re-derived,
  // so the baseline cannot drift.
  //
  // Once a boundary has moved, that no longer holds: the server has re-bucketed
  // the dealers, so a band's current_cn is what the people now in it earned
  // ELSEWHERE, and has nothing to do with this band's rate. There the payout is
  // units x rate, which is also what makes a 0% band return to Rs 0 when its
  // rate is set back to zero -- scaling from current_cn made it pay out again.
  const simulated_cn =
    row.rebucketed
      ? row.cn_units * newRate
      : newRate === row.cn_rate
        ? row.current_cn
        : row.cn_rate !== 0
          ? row.current_cn * (newRate / row.cn_rate)
          : row.cn_units * newRate;
  return { ...row, simulated_rate: newRate, simulated_cn, delta_cn: simulated_cn - row.current_cn };
}

export function resetRow(row: SlabRow): SlabRow {
  return withSimulatedRate(row, row.cn_rate);
}

export function sumRows(rows: SlabRow[]) {
  let current = 0;
  let simulated = 0;
  let dealers = 0;
  for (const r of rows) {
    current += r.current_cn;
    simulated += r.simulated_cn ?? r.current_cn;
    dealers += r.dealer_count;
  }
  return { current_cn: current, simulated_cn: simulated, delta_cn: simulated - current, dealer_count: dealers };
}

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Which file a month's figures come from: "data as of 1 Nov 2026 · v22" (the extract date and the GCS version). */
export function fmtAsOf(asOf: string | null | undefined, version?: number | null): string {
  if (!asOf) return "";
  const [y, m, d] = asOf.split("-").map(Number);
  return `data as of ${d} ${MONTHS_SHORT[m - 1]} ${y}${version != null ? ` · v${version}` : ""}`;
}

/** Compact Indian-style money: ₹1.20 Cr / ₹34.50 L / ₹12,300 (minus is U+2212). */
export const fmtMoney = (n: number): string => rupees(n);

/**
 * A per-dealer-target row (a component without a slab table; its rows are rate tiers): the achievement range of its
 * dealers, from 0 at the least (returns make achievement negative), or the rate tier where that range is 0 – 0 (a
 * flat amount, nothing measured: VALUE FA, "Other (unattributed)").
 */
export function fmtTarget(lower: number | null, upper: number | null, rate: number, formula: Formula,
                          packSize: number): string {
  const lo = Math.max(0, lower ?? 0);
  const hi = Math.max(0, upper ?? 0);
  if (lo === 0 && hi === 0) return `rate ${fmtRate(rate, formula, packSize)}`;
  return `${inr.format(Math.round(lo))} – ${inr.format(Math.round(hi))}`;
}

/** Rates mean different things per scheme type -- label them so nobody misreads a "22" as ₹22. */
export function fmtRate(rate: number, formula: Formula, packSize: number): string {
  switch (formula) {
    case "percent":
      return `${rate}%`;
    case "per_unit":
      return `₹${rate}/unit`;
    case "per_pack":
      return packSize > 1 ? `₹${rate} per ${packSize} litres` : `₹${rate}/litre`;
    case "fixed":
      return `₹${inr.format(rate)}/dealer`;
  }
}

export function rateUnit(formula: Formula, packSize: number): string {
  switch (formula) {
    case "percent":
      return "% of GSR";
    case "per_unit":
      return "₹ per unit";
    case "per_pack":
      return packSize > 1 ? `₹ per ${packSize}-litre pack` : "₹ per litre";
    case "fixed":
      return "₹ per dealer";
  }
}

/** "All 31 regions", "All except Bihar North", "Delhi, Haryana", "15 regions" */
export function fmtRegions(regions: string[], all: string[]): string {
  if (regions.length === all.length) return `All ${all.length} regions`;
  const missing = all.filter((r) => !regions.includes(r));
  if (missing.length <= 2 && all.length > 5) return `All except ${missing.join(", ")}`;
  if (regions.length <= 3) return regions.join(", ");
  return `${regions.length} regions`;
}

/** "0 – 40", "40 – 50", "1,200+". A slab never starts below 0. */
export function fmtSlab(lower: number, upper: number | null): string {
  const lo = inr.format(Math.round(Math.max(0, lower)));
  if (upper === null || !isFinite(upper)) return `${lo}+`;
  return `${lo} – ${inr.format(Math.round(upper))}`;
}
