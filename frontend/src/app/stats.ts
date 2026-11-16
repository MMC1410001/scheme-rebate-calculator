import type { Adjustment, AllSlabsResponse, SlabLayout, SlabRow } from "../api/client";
import { sumRows } from "../api/computeImpact.ts";
import type { SchemeStat } from "../components/ContributionChart";
import { rowMoved } from "../slabChange.ts";
import type { RowsByScheme, SortKey } from "./constants";

/** Pure figures of the main screen, from the slab rows and the edits (App.tsx keeps them in useMemo). */

/** The rows every total reads: a deleted scheme pays nothing (its volume and GSR stay; the sales still happen). */
export function simRowsOf(rowsByScheme: RowsByScheme, removed: Set<string>): RowsByScheme {
  if (!removed.size) return rowsByScheme;
  return Object.fromEntries(Object.entries(rowsByScheme).map(([k, rows]) => [
    k,
    removed.has(k) ? rows.map((r) => ({ ...r, simulated_cn: 0, delta_cn: -r.current_cn })) : rows,
  ]));
}

/** Boundaries can be moved in every component except the bookkeeping ones: "Other (unattributed)" carries payout
 *  no slab explains, and a qualifier sets the rates of another block rather than paying anything itself.
 *  `schemeRows`: all of the scheme's rows. */
export function slabsAllowedIn(schemeRows: SlabRow[], component: string): boolean {
  if (component.startsWith("Other (unattributed)")) return false;
  const rows = schemeRows.filter((r) => r.component === component);
  return rows.length > 0 && (rows[0].formula as string) !== "qualifier";
}

/** ONE rate per band in this scope (shown as such in the editor). Either way the table is sent in the portable
 *  form, where each dealer keeps their own region's card when a boundary moves. */
export function singleCardIn(schemeRows: SlabRow[], component: string): boolean {
  const counts = new Map<number, number>();
  for (const r of schemeRows) {
    if (r.component !== component || r.slab_mode !== "slab") continue;
    counts.set(r.slab_index, (counts.get(r.slab_index) ?? 0) + 1);
  }
  return counts.size > 0 && [...counts.values()].every((n) => n === 1);
}

/** Every component with an edit (a rate or a boundary), as the slab table being planned: next month follows it. */
export function planLayoutsOf(rowsByScheme: RowsByScheme, movedSlabs: Set<string>,
                              allowed: (scheme: string, component: string) => boolean,
                              layoutOf: (scheme: string, component: string) => SlabLayout): Record<string, SlabLayout> {
  const out: Record<string, SlabLayout> = {};
  for (const [key, rows] of Object.entries(rowsByScheme)) {
    const comps = new Set(rows
      .filter((r) => movedSlabs.has(`${key}::${r.component}`) || (r.simulated_rate ?? r.cn_rate) !== r.cn_rate)
      .map((r) => r.component));
    for (const c of comps) if (allowed(key, c)) out[`${key}::${c}`] = layoutOf(key, c);
  }
  return out;
}

/** What the user has edited, as one string: compared with the same at the last save (or open) for "• unsaved". */
export function editKeyOf(adjustments: Adjustment[], nextAdjustments: Adjustment[], removed: Set<string>, growth: number,
                          planLayouts: Record<string, SlabLayout>, nextLayouts: Record<string, SlabLayout>): string {
  return JSON.stringify([adjustments, nextAdjustments, [...removed].sort(), growth,
    ...[planLayouts, nextLayouts].map((ls) => Object.entries(ls).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, l]) => [k, l.edges, l.rates ?? null, l.rate_overrides ?? null]))]);
}

/** Schemes the user has changed, by rate OR by slab. Counting SCHEMES rather than rows because "Reset all (2)"
 *  should mean two schemes, not the eight rows one boundary move happens to touch. */
export function editedSchemesOf(rowsByScheme: RowsByScheme, removed: Set<string>, adjustments: Adjustment[],
                                nextAdjustments: Adjustment[], movedSlabs: Set<string>,
                                nextLayouts: Record<string, SlabLayout>): Set<string> {
  const out = new Set<string>();
  // With GSR / volume edits every re-bucketed row pays a new CN, so a scheme counts as edited by its own changes:
  // a rate, a moved boundary, a deletion or an edit of the scheme itself.
  const own = new Set([...adjustments, ...nextAdjustments].filter((a) => a.mode === "S" || a.mode === "C").map((a) => a.product));
  for (const [key, rows] of Object.entries(rowsByScheme)) {
    const moved = [...movedSlabs].some((k) => k.startsWith(`${key}::`));
    if (adjustments.length ? moved || own.has(key) || rows.some((r) => (r.simulated_rate ?? r.cn_rate) !== r.cn_rate)
        : rows.some(rowMoved) || own.has(key)) out.add(key);
  }
  for (const key of removed) out.add(key);
  for (const k of Object.keys(nextLayouts)) out.add(k.split("::")[0]);
  return out;
}

/** The number on "Reset all (n)" and the Simulator tab: edited schemes, plus one for edits that touch no single
 *  scheme, one per gift what-if, and one for V when it is the only change. */
export function editedCountOf(editedSchemes: number, edits: number, giftEdits: number, growth: number): number {
  return editedSchemes + (edits && !editedSchemes ? 1 : 0) + giftEdits + (growth !== 0 && !edits && !editedSchemes ? 1 : 0);
}

/** The schemes the search, Verified only and Edited only leave, in the chosen order. */
export function visibleSchemesOf(data: AllSlabsResponse | null, query: string, onlyVerified: boolean, editedOnly: boolean,
                                 sortBy: SortKey, editedSchemes: Set<string>, simRows: RowsByScheme) {
  if (!data) return [];
  const q = query.trim().toLowerCase();
  const list = data.schemes.filter((s) => {
    if (onlyVerified && s.status !== "ok") return false;
    if (editedOnly && !editedSchemes.has(s.key)) return false;
    return !q || s.label.toLowerCase().includes(q);
  });
  // Sorting matters at 35 schemes: "biggest impact" surfaces what an edit actually moved, which is otherwise buried
  // somewhere down the list.
  const impactOf = (key: string) => Math.abs(sumRows(simRows[key] ?? []).delta_cn);
  if (sortBy === "name") return [...list].sort((a, b) => a.label.localeCompare(b.label));
  if (sortBy === "impact") return [...list].sort((a, b) => impactOf(b.key) - impactOf(a.key));
  return list; // server already orders by payout
}

/** Per-scheme figures for the charts, money schemes only (GIFT pays in gifts). */
export function schemeStatsOf(data: AllSlabsResponse | null, simRows: RowsByScheme): SchemeStat[] {
  if (!data) return [];
  return data.schemes
    .filter((s) => s.is_currency && s.totals.gsr > 0)
    .map((s) => ({
      key: s.key,
      label: s.label,
      gsr: s.totals.gsr,
      cn: sumRows(simRows[s.key] ?? []).simulated_cn,
      dealers: s.totals.dealer_count,
    }));
}

/** Each scheme's simulated CN over its current CN, at today's volumes. This is how a rate card edited in the
 *  Simulator reaches the plan: the plan grows volumes, then applies this. Schemes left alone come out at 1.0 and are
 *  dropped, so an untouched session sends nothing. */
export function rateMultipliersOf(simRows: RowsByScheme): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, rows] of Object.entries(simRows)) {
    const t = sumRows(rows);
    if (t.current_cn <= 0) continue;
    const m = t.simulated_cn / t.current_cn;
    if (Math.abs(m - 1) > 1e-9) out[key] = m;
  }
  return out;
}

/** The money total of every scheme (GIFT schemes, which pay in gifts, left out). */
export function grandOf(data: AllSlabsResponse | null, simRows: RowsByScheme) {
  const moneyKeys = new Set((data?.schemes ?? []).filter((s) => s.is_currency).map((s) => s.key));
  return sumRows(Object.entries(simRows).filter(([k]) => moneyKeys.has(k)).flatMap(([, rows]) => rows));
}

/** What the command bar's readout shows. */
export interface Kpi {
  scope: string;
  isScheme: boolean;
  isCurrency: boolean;
  volume: number;
  gsr: number;
  currentCn: number;
  simulatedCn: number;
  delta: number;
  pct: number;
  dealers: number;
}

/** The readout's figures. A rate edit is nearly always aimed at ONE scheme, and judging it against the whole book
 *  hides it -- a change worth lakhs inside Premium is a rounding error against the whole month's payout. So when a scheme is in focus
 *  (`focusKey`) the figures narrow to it, and otherwise they cover everything. */
export function kpiOf(focusKey: string | null, data: AllSlabsResponse | null, simRows: RowsByScheme,
                      grand: ReturnType<typeof grandOf>): Kpi {
  const focused = focusKey ? (data?.schemes ?? []).find((s) => s.key === focusKey) : null;
  if (focused) {
    const t = sumRows(simRows[focused.key] ?? []);
    return {
      scope: focused.label,
      isScheme: true,
      isCurrency: focused.is_currency,
      volume: focused.totals.volume,
      gsr: focused.totals.gsr,
      currentCn: t.current_cn,
      simulatedCn: t.simulated_cn,
      delta: t.simulated_cn - t.current_cn,
      pct: t.current_cn ? ((t.simulated_cn - t.current_cn) / t.current_cn) * 100 : 0,
      dealers: focused.totals.dealer_count,
    };
  }
  const delta = grand.simulated_cn - grand.current_cn;
  return {
    scope: "All schemes",
    isScheme: false,
    isCurrency: true,
    volume: data?.grand.volume ?? 0,
    gsr: data?.grand.gsr ?? 0,
    currentCn: grand.current_cn,
    simulatedCn: grand.simulated_cn,
    delta,
    pct: grand.current_cn ? (delta / grand.current_cn) * 100 : 0,
    dealers: data?.grand.dealer_count ?? 0,
  };
}
