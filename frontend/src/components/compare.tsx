/** Scheme detail: each figure beside the month before it (Current against Previous, Next against Current).
 *  Under each figure: the earlier month's value, and the change when material (±1%, shares ±0.1 pp). Volume, GSR,
 *  Dealers and Mix higher is green; Credit note and CN % higher is red (the company pays more). Slab rows are matched
 *  to the earlier month's by slab and rate, then by slab range alone (the rate changed). */
import { useEffect, useState } from "react";
import { api, type Formula, type MonthSlabRow, type SlabRow } from "../api/client";
import { fmtRate, fmtSlab } from "../api/computeImpact";
import { isMaterial } from "../format";

const STORE = "sd.compare";

/** The viewer's choice, remembered in this browser; on by default. */
export function useCompareOn(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => {
    try { return window.localStorage.getItem(STORE) !== "off"; } catch { return true; }
  });
  const set = (v: boolean) => {
    setOn(v);
    try { window.localStorage.setItem(STORE, v ? "on" : "off"); } catch { /* lasts this visit only */ }
  };
  return [on, set];
}

/** "Compare with: Oct 2026 | Off", beside the month toggle. */
export function CompareSwitch({ on, onChange, against }: { on: boolean; onChange: (on: boolean) => void; against: string }) {
  return (
    <div className="cmp-switch" role="group" aria-label="Compare each figure with the month before">
      <span>Compare with</span>
      <div className="tabs">
        <button type="button" className={on ? "is-active" : ""} aria-pressed={on} onClick={() => onChange(true)}>{against}</button>
        <button type="button" className={!on ? "is-active" : ""} aria-pressed={!on} onClick={() => onChange(false)}>Off</button>
      </div>
    </div>
  );
}

/** Under a figure: the earlier month's value and the change to `to`. `cost`: higher is red (CN, CN %). */
export function Was({ from, to, fmt, pp = false, cost = false, month, label = false }: {
  from: number | null | undefined; to: number | null | undefined; fmt: (n: number) => string;
  pp?: boolean; cost?: boolean; month: string; label?: boolean;
}) {
  const short = month.split(" ")[0];
  if (from == null || !Number.isFinite(from)) {
    return label ? <span className="cmp-was" title={`Not in ${month}`}>{short} —</span> : null;
  }
  if (from === 0 && !to) return null;
  let chg = null;
  if (to != null && Number.isFinite(to) && (pp || from !== 0)) {
    const x = pp ? to - from : (100 * (to - from)) / Math.abs(from);
    if (isMaterial(x, pp)) {
      const good = cost ? x < 0 : x > 0;
      chg = (
        <span className={`cmp-chg ${good ? "good" : "bad"}`}>
          <span aria-hidden="true">{x > 0 ? "▲" : "▼"}</span>
          {`${x > 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`}{pp ? " pp" : "%"}
        </span>
      );
    }
  }
  return (
    <span className="cmp-was" title={`${month}: ${fmt(from)}`}>
      {label && `${short} `}{fmt(from)}{chg}
    </span>
  );
}

/** A scheme's headline figures in one month. */
export interface SchemeFigs {
  volume: number | null;
  mix: number | null;
  gsr: number | null;
  dealers: number | null;
  cn: number | null;
  cnPct: number | null;
}

/** What a view compares against: the earlier month's name and figures. */
export interface CompareBase {
  label: string;           // "Oct 2026"
  figs?: SchemeFigs;
}

/** A slab row's figures, whichever table it comes from. */
export interface SlabFigs {
  mode: string;
  lower: number | null;
  upper: number | null;
  rate: number;
  dealers: number;
  volume: number;
  gsr: number;
  cn: number;
  label: string;
  rateText: string;
}

const keyOf = (s: SlabFigs) => s.mode === "slab"
  ? `slab|${(s.lower ?? 0).toFixed(3)}|${s.upper == null ? "inf" : s.upper.toFixed(3)}|${s.rate.toFixed(4)}`
  : `${s.mode}|${s.rate.toFixed(4)}`;

const rangeOf = (s: SlabFigs) => s.mode === "slab"
  ? `slab|${(s.lower ?? 0).toFixed(3)}|${s.upper == null ? "inf" : s.upper.toFixed(3)}` : s.mode;

export type SlabMatch = ReturnType<typeof matchSlabs>;

/** Each row's earlier-month row, and the earlier rows nothing matched. */
export function matchSlabs(rows: SlabFigs[], base: SlabFigs[] | undefined) {
  if (!base) return { of: (_i: number) => undefined as SlabFigs | undefined, rateWas: (_i: number) => undefined as string | undefined,
                      gone: [] as SlabFigs[], ready: false };
  const left = [...base];
  const of = new Map<number, SlabFigs>();
  const take = (i: number, key: (s: SlabFigs) => string, r: SlabFigs) => {
    const j = left.findIndex((b) => key(b) === key(r));
    if (j >= 0) { of.set(i, left[j]); left.splice(j, 1); }
  };
  rows.forEach((r, i) => take(i, keyOf, r));
  rows.forEach((r, i) => { if (!of.has(i) && r.mode === "slab") take(i, rangeOf, r); });
  return {
    of: (i: number) => of.get(i),
    rateWas: (i: number) => { const b = of.get(i); return b && Math.abs(b.rate - rows[i].rate) > 1e-9 ? b.rateText : undefined; },
    gone: left, ready: true,
  };
}

/** Beside a slab row: "new slab" when the earlier month had none like it, "rate was …" when its rate changed. */
export function SlabTag({ m, i }: { m: SlabMatch | null; i: number }) {
  if (!m?.ready) return null;
  if (!m.of(i)) return <span className="cmp-new" title="No slab with this range and rate in the month compared with">new slab</span>;
  const was = m.rateWas(i);
  return was ? <span className="cmp-new" title="The same slab had another rate in the month compared with">rate was {was}</span> : null;
}

/** Earlier-month slab rows with no match in this month, so their dealers and CN are not silently lost. */
export function GoneSlabs({ rows, month, money }: { rows: SlabFigs[]; month: string; money: (n: number) => string }) {
  const paid = rows.filter((r) => r.dealers > 0);
  if (!paid.length) return null;
  return (
    <p className="cmp-gone">
      <b>In {month}, not in this month:</b>{" "}
      {paid.map((r, i) => (
        <span key={i}>{i ? "; " : ""}{r.label} · {r.dealers.toLocaleString("en-IN")} dealers · {money(r.cn)}</span>
      ))}
    </p>
  );
}

const slabLabel = (mode: string, lower: number | null, upper: number | null, rate: number, formula: Formula, pack: number) =>
  mode === "slab" ? fmtSlab(lower ?? 0, upper) : `rate ${fmtRate(rate, formula, pack)}`;

/** A Previous / Next month slab table row. */
export const fromMonthSlab = (r: MonthSlabRow): SlabFigs => ({
  mode: r.slab_mode, lower: r.slab_lower, upper: r.slab_upper, rate: r.cn_rate, dealers: r.dealers, volume: r.volume,
  gsr: r.gsr, cn: r.cn, label: slabLabel(r.slab_mode, r.slab_lower, r.slab_upper, r.cn_rate, r.formula, r.pack_size),
  rateText: fmtRate(r.cn_rate, r.formula, r.pack_size),
});

/** A current month editor row, with the edits. */
export const fromSlabRow = (r: SlabRow): SlabFigs => ({
  mode: r.slab_mode, lower: r.slab_lower, upper: r.slab_upper, rate: r.cn_rate, dealers: r.dealer_count,
  volume: r.volume ?? 0, gsr: r.gsr ?? 0, cn: r.simulated_cn ?? r.current_cn,
  label: slabLabel(r.slab_mode, r.slab_lower, r.slab_upper, r.cn_rate, r.formula, r.pack_size),
  rateText: fmtRate(r.cn_rate, r.formula, r.pack_size),
});

const prevCache = new Map<string, Record<string, SlabFigs[]>>();

/** The previous month's slab rows of a scheme per component (edits do not change them), fetched once per scope. */
export function usePrevSlabs(scope: { zone: string[]; region: string[]; depot_code: string[] } | undefined,
                             scheme: string, enabled: boolean): Record<string, SlabFigs[]> | undefined {
  const key = scope ? `${scheme}#${scope.zone.join("|")}#${scope.region.join("|")}#${scope.depot_code.join("|")}` : "";
  const [, bump] = useState(0);
  useEffect(() => {
    if (!enabled || !scope || prevCache.has(key)) return;
    const ctrl = new AbortController();
    api.schemeMonths({ ...scope, scheme, volume_growth_pct: 0, layouts: {}, adjustments: [], next_adjustments: [] }, ctrl.signal)
      .then((x) => {
        const out: Record<string, SlabFigs[]> = {};
        for (const [c, rows] of Object.entries(x.previous?.components ?? {})) out[c] = rows.map(fromMonthSlab);
        prevCache.set(key, out);
        bump((n) => n + 1);
      })
      .catch(() => { /* rows show without the comparison */ });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
  return enabled ? prevCache.get(key) : undefined;
}
