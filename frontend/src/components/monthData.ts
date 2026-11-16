/** The month table's data: fetching the three months, and helpers that read them. Kept apart from MonthsView.tsx so
 *  that file exports components only (React fast refresh). */
import { useEffect, useState } from "react";
import {
  api,
  type Adjustment,
  type MonthBlock,
  type MonthSlabRow,
  type MonthTable,
  type NextMonthBlock,
  type SchemeMonthRow,
  type SlabLayout,
  type SlabRow,
  errorText,
  isAbort,
} from "../api/client";
import { fmtRate } from "../api/computeImpact";
import type { DealerListTarget } from "./DealerList";
import type { CellEdit, Scope } from "./MonthsView";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** What an edited cell is called in its label. */
export const FIELD_LABEL: Record<CellEdit["field"], string> = { gsr: "GSR", mix: "mix %", cn_pct: "CN %", cn: "CN", volume: "volume" };

/** Previous and current month (the current with its edits) and next month's plan, 500 ms after the last edit. */
export function useMonthBlocks(scope: Scope, growth: number, layouts: Record<string, SlabLayout>, removedKeys: Set<string>,
                               adjustments: Adjustment[], nextAdjustments: Adjustment[]) {
  const [months, setMonths] = useState<{ previous: MonthBlock | null; current: MonthBlock } | null>(null);
  const [next, setNext] = useState<NextMonthBlock | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // One error per request, so a later success clears its own failure (a single failure used to blank the table
  // until the page was reloaded).
  const [errCur, setErrCur] = useState<string | null>(null);
  const [errNext, setErrNext] = useState<string | null>(null);
  const [busyCur, setBusyCur] = useState(false);
  const [busyNext, setBusyNext] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const scopeKey = `${scope.zone.join("|")}#${scope.region.join("|")}#${scope.depot_code.join("|")}`;
  const layoutsKey = JSON.stringify(layouts);
  const removedKey = [...removedKeys].sort().join("|");
  const adjKey = JSON.stringify(adjustments);
  const nextAdjKey = JSON.stringify(nextAdjustments);

  useEffect(() => {
    let live = true;
    const ctrl = new AbortController();   // a newer scope or edit cancels this request
    const adjs = JSON.parse(adjKey) as Adjustment[];
    setBusyCur(true);
    const req = adjs.length ? api.monthsEdited({ ...scope, adjustments: adjs }, ctrl.signal) : api.months(scope, ctrl.signal);
    req.then((m) => { if (live) { setMonths(m); setErrCur(null); setWarnings((m as { warnings?: string[] }).warnings ?? []); } })
      .catch((e) => live && !isAbort(e) && setErrCur(errorText(e)))
      .finally(() => live && setBusyCur(false));
    return () => { live = false; ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, adjKey, attempt]);

  useEffect(() => {
    let live = true;
    const ctrl = new AbortController();
    setBusyNext(true);
    const t = window.setTimeout(() => {
      api
        .nextMonth({ ...scope, volume_growth_pct: growth, layouts: JSON.parse(layoutsKey),
                     removed_schemes: removedKey ? removedKey.split("|") : [],
                     adjustments: JSON.parse(adjKey), next_adjustments: JSON.parse(nextAdjKey) }, ctrl.signal)
        .then((n) => { if (live) { setNext(n); setErrNext(null); } })
        .catch((e) => live && !isAbort(e) && setErrNext(errorText(e)))
        .finally(() => live && setBusyNext(false));
    }, 500);
    return () => { live = false; window.clearTimeout(t); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, growth, layoutsKey, removedKey, adjKey, nextAdjKey, attempt]);

  const err = errCur ?? errNext;
  return { months, next, warnings, err, busyCur, busyNext, retry: () => setAttempt((n) => n + 1) };
}

/** A scheme's own figures in one month (the first product it is listed under). */
export function schemeRowOf(block: MonthTable | null | undefined, key: string): SchemeMonthRow | undefined {
  for (const c of block?.rows ?? []) {
    const s = c.scheme_rows.find((x) => x.scheme === key);
    if (s) return s;
  }
  return undefined;
}

/** Product mix of a scheme: its volume ÷ all products' volume that month (an add-on repeats its base's sales: none). */
export function schemeMix(block: MonthTable | null | undefined, key: string): number | null {
  const s = schemeRowOf(block, key);
  const all = block?.total.volume;
  return s?.counts && s.volume && all ? (100 * s.volume) / all : null;
}

/** The dealers behind a previous or next month slab row, as the dealer list's target. */
export function monthDealers({ schemeKey, schemeLabel, row: r, kind, month, scope, layouts, growth }: {
  schemeKey: string; schemeLabel: string; row: MonthSlabRow; kind: "previous" | "next"; month: string | null;
  scope: Scope; layouts: Record<string, SlabLayout>; growth: number;
}): DealerListTarget {
  const row: SlabRow = {
    component: r.component, formula: r.formula, pack_size: r.pack_size, slab_mode: r.slab_mode,
    slab_index: r.slab_index, slab_lower: r.slab_lower ?? 0, slab_upper: r.slab_upper, cn_rate: r.cn_rate,
    simulated_rate: r.rate, dealer_count: r.dealers, achievement: 0, volume: r.volume, gsr: r.gsr, cn_units: 0,
    current_cn: r.cn, condonation_amount: 0, row_id: `${r.component}::${r.slab_index}::${r.cn_rate}`,
  };
  return {
    schemeKey, schemeLabel, component: r.component, row,
    layout: kind === "next" ? layouts[`${schemeKey}::${r.component}`] : undefined,
    scope, rateLabel: (v) => fmtRate(v, r.formula, r.pack_size),
    month: {
      kind, growth: kind === "next" ? growth : undefined,
      label: `${kind === "previous" ? "Previous" : "Next"} · ${month ? monthName(month) : ""}`,
    },
  };
}
