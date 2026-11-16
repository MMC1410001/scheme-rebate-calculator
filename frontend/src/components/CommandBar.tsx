import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { applyTheme, type Theme } from "../theme";
import type { AllSlabsResponse, Filters } from "../api/client";
import { fmtAsOf, fmtInr, fmtMoney } from "../api/computeImpact";
import { MONTH_SHORT, TABS, type TabKey } from "../app/constants";
import type { Kpi } from "../app/stats";
import { cnClass, litresText, signedRupees, pct as fmtPct } from "../format";
import { usePulse } from "../hooks/useMotion";
import { isMoved } from "../slabChange";
import { MultiSelect } from "./MultiSelect";

/** The parts of the sticky command bar (App.tsx). The title, the tab strip, the filters and the payout figures used
 *  to be three separate stacked blocks that together owned roughly the top 40% of every screen. Collapsed into a
 *  single bar that STAYS PUT: the whole point of the tool is watching the payout move while you edit a rate, and that
 *  is impossible if the number scrolls off the top. Counts that were cards are now a subtitle. */

type Source = AllSlabsResponse["source"];

/** The title, and under it the scope, the scheme and dealer counts, and which file the figures come from. */
export function TitleBlock({ scopeLabel, data, visibleCount, src }:
  { scopeLabel: string; data: AllSlabsResponse | null; visibleCount: number; src: Source }) {
  return (
    <div className="cmd-id">
      <h1>Scheme Performance &amp; Impact</h1>
      <p className="subtitle">
        <strong>{scopeLabel}</strong>
        <span className="dot-sep" />
        {data ? visibleCount : "—"} schemes
        <span className="dot-sep" />
        {data ? fmtInr(data.grand.dealer_count) : "—"} dealers
        {/* A part-month total next to a settled one reads as a contradiction unless the screen says which it is.
            Always say which file the figures come from, settled month or not. */}
        {src?.as_of && (
          <>
            <span className="dot-sep" />
            <span className="asof-badge" title={src.file ? `File ${src.file}` : undefined}>
              {fmtAsOf(src.as_of, src.version)}
            </span>
          </>
        )}
        {src && !src.complete && src.elapsed_days && (
          <>
            <span className="dot-sep" />
            <span className="src-badge"
                  title={`These figures are a snapshot taken on ${src.as_of}, covering ${src.elapsed_days} of ${src.month_days} days. The Plan tab reports the settled month in full.`}>
              part month · day {src.elapsed_days} of {src.month_days}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

/** The main tabs. Arrow keys, Home and End move between them (the standard tabs pattern). */
export function MainTabs({ tab, onTab, editedCount }: { tab: TabKey; onTab: (t: TabKey) => void; editedCount: number }) {
  const onKey = (e: ReactKeyboardEvent) => {
    const i = TABS.findIndex(([k]) => k === tab);
    const to = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length
      : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    onTab(TABS[to][0]);
    document.getElementById(`tab-${TABS[to][0]}`)?.focus();
  };
  return (
    <nav className="tabs" role="tablist" aria-label="Views" onKeyDown={onKey}>
      {TABS.map(([key, label]) => (
        <button key={key} id={`tab-${key}`} role="tab" aria-selected={tab === key} aria-controls="content"
                tabIndex={tab === key ? 0 : -1} className={tab === key ? "is-active" : ""}
                onClick={() => onTab(key)}>
          {label}
          {key === "simulator" && editedCount > 0 && (
            <span className="pill" aria-label={`${editedCount} edited`}>{editedCount}</span>
          )}
        </button>
      ))}
    </nav>
  );
}

/** The filters: Zone, Region, Depot, Find scheme, Verified only, and Clear filters. Region and Depot options follow
 *  the selected Zones (and Regions) so the filters stay coherent. */
export function FilterBar(p: {
  filters: Filters;
  zone: string[]; region: string[]; depot: string[];
  onZone: (v: string[]) => void; onRegion: (v: string[]) => void; onDepot: (v: string[]) => void;
  query: string; onQuery: (v: string) => void;
  onlyVerified: boolean; onOnlyVerified: (v: boolean) => void;
  /** Any filter on (Edited only included): Clear filters shows. */
  anyOn: boolean;
  onClear: () => void;
}) {
  const { regionOptions, depotOptions } = useMemo(() => {
    let h = p.filters.hierarchy;
    if (p.zone.length) h = h.filter((x) => p.zone.includes(x.zone));
    const regions = Array.from(new Set(h.map((x) => x.region))).sort();
    let hd = h;
    if (p.region.length) hd = hd.filter((x) => p.region.includes(x.region));
    const depots = Array.from(new Set(hd.map((x) => x.depot_code))).sort();
    return { regionOptions: regions, depotOptions: depots };
  }, [p.filters.hierarchy, p.zone, p.region]);
  return (
    <div className="cmd-row cmd-row-2">
      <MultiSelect label="Zone" noun="zones" allLabel="All zones" options={p.filters.zones} selected={p.zone}
                   onChange={p.onZone} />
      <MultiSelect label="Region" noun="regions" allLabel="All regions" options={regionOptions} selected={p.region}
                   onChange={p.onRegion} />
      <MultiSelect label="Depot" noun="depots" allLabel="All depots" options={depotOptions} selected={p.depot}
                   onChange={p.onDepot} />
      <label className="f f-grow">
        <span>Find scheme</span>
        <input value={p.query} onChange={(e) => p.onQuery(e.target.value)} placeholder="e.g. Luxury, Primer…" />
      </label>
      <label className="f f-check">
        <input type="checkbox" checked={p.onlyVerified} onChange={(e) => p.onOnlyVerified(e.target.checked)} />
        <span>Verified only</span>
      </label>
      {p.anyOn && (
        <button className="btn btn-ghost btn-clear" onClick={p.onClear}>
          Clear filters
        </button>
      )}
    </div>
  );
}

/** The live readout. Volume, GSR and CN are the three totals the business steers on, so they are always present;
 *  the estimate and the impact appear only once an edit exists, because a "-Rs 0" on an untouched simulation read as
 *  a saving. Everything here follows `kpi`, which narrows to a single scheme when one is in focus. The two figures an
 *  edit moves flash once when they land, so a change made far down a long table is still noticed up in the bar. */
/** The previous month's figures for the readout: the same scope, or the scheme in focus. */
export interface ReadoutPrev { label: string; volume: number | null; gsr: number | null; cn: number | null }

/** Under a readout figure: its change from the previous month. Volume and GSR up green; CN and CN % up red. */
function Vs({ from, to, label, pp = false, cost = false }:
  { from: number | null | undefined; to: number | null | undefined; label: string; pp?: boolean; cost?: boolean }) {
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to) || (!pp && from === 0)) return null;
  const x = pp ? to - from : (100 * (to - from)) / Math.abs(from);
  const flat = Math.abs(x) < 0.005;
  const tone = flat ? "flat" : cost ? (x > 0 ? "is-higher" : "is-lower") : x > 0 ? "up" : "down";
  return (
    <span className={`ro-vs ${tone}`}>
      {flat ? "no change" : `${x > 0 ? "▲" : "▼"} ${Math.abs(x).toFixed(Math.abs(x) < 1 ? 2 : 1)}${pp ? " pp" : "%"}`}
      <i> vs {label}</i>
    </span>
  );
}

/** Light / dark. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" className="btn btn-ghost theme-toggle" aria-label={`Switch to ${next} mode`}
            title={`Switch to ${next} mode`} onClick={() => { applyTheme(next); setTheme(next); }}>
      {theme === "dark" ? (
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      ) : (
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M15.5 12.5A6.5 6.5 0 017.5 4.5a6.5 6.5 0 108 8z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
      )}
    </button>
  );
}

export function Readout({ kpi, hasData, src, prev }: { kpi: Kpi; hasData: boolean; src: Source; prev?: ReadoutPrev | null }) {
  const edited = isMoved(kpi.delta);
  const estRef = usePulse<HTMLElement>(Math.round(kpi.simulatedCn));
  const impactRef = usePulse<HTMLElement>(Math.round(kpi.delta));
  return (
    <div className={`readout ${edited ? "is-live" : ""}`}>
      <div className="ro-scope" title={kpi.isScheme
        ? "Figures are for the scheme in focus. Close it to see the whole book."
        : "Figures cover every scheme in the current filter."}>
        {kpi.isScheme ? <><i className="ro-focus-dot" />{kpi.scope}</> : kpi.scope}
        {src && !src.complete && src.elapsed_days && (
          <em className="ro-asof">to {src.as_of?.slice(8)} {MONTH_SHORT[Number(src.month.slice(5, 7)) - 1]}</em>
        )}
      </div>
      <div className="ro-stats stagger">
        <div className="ro-stat is-standing">
          <span>Volume</span>
          <b>{kpi.volume > 0 ? litresText(kpi.volume) : "—"}</b>
          {prev && <Vs from={prev.volume} to={kpi.volume} label={prev.label} />}
        </div>
        <div className="ro-stat is-standing">
          <span>GSR</span>
          <b>{kpi.gsr > 0 ? fmtMoney(kpi.gsr) : "—"}</b>
          {prev && <Vs from={prev.gsr} to={kpi.gsr} label={prev.label} />}
        </div>
        <div className="ro-stat">
          <span title="Credit note (CN) as settled in the file, before your edits">{edited ? "Actual CN" : "Credit note"}</span>
          <b>{!hasData ? "—" : kpi.isCurrency ? fmtMoney(kpi.currentCn) : `${fmtInr(kpi.currentCn)} gifts`}</b>
          {prev && hasData && <Vs from={prev.cn} to={kpi.currentCn} label={prev.label} cost />}
        </div>
        {/* The payout rate is what the business steers on, so it is always present. When edited it shows the
            simulated rate with the original beneath it. */}
        <div className="ro-stat">
          <span>CN % of GSR</span>
          <b>
            {kpi.gsr > 0 && kpi.isCurrency ? fmtPct((kpi.simulatedCn / kpi.gsr) * 100, 2) : "—"}
            {edited && kpi.gsr > 0 && kpi.isCurrency && (
              <em> was {fmtPct((kpi.currentCn / kpi.gsr) * 100, 2)}</em>
            )}
          </b>
          {prev && kpi.gsr > 0 && kpi.isCurrency && prev.gsr && prev.cn != null && (
            <Vs from={(100 * prev.cn) / prev.gsr} to={(100 * kpi.simulatedCn) / kpi.gsr} label={prev.label} pp cost />
          )}
        </div>
        {edited && (
          <>
            <div className="ro-stat is-est">
              <span title="CN with your edits, dealer volumes held fixed">Simulated CN</span>
              <b ref={estRef}>
                {kpi.isCurrency ? fmtMoney(kpi.simulatedCn) : `${fmtInr(kpi.simulatedCn)} gifts`}
              </b>
            </div>
            <div className={`ro-stat is-impact ${cnClass(kpi.delta)}`}
                 title="Simulated CN − actual CN. Lower is what a revised structure would cost, not money recovered.">
              <span>Impact</span>
              <b ref={impactRef}>
                {kpi.isCurrency ? signedRupees(kpi.delta) : `${kpi.delta >= 0 ? "+" : "−"}${fmtInr(Math.abs(kpi.delta))} gifts`}
                <em> ({Math.abs(kpi.pct) < 0.005 ? "under 0.01%" : `${kpi.pct >= 0 ? "+" : "−"}${Math.abs(kpi.pct).toFixed(2)}%`})</em>
              </b>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
