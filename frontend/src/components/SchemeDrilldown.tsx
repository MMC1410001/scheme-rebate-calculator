import { useEffect, useMemo, useRef } from "react";
import type { SchemePayload, SlabRow } from "../api/client";
import { fmtInr, fmtMoney, fmtRate, fmtSlab, fmtTarget } from "../api/computeImpact";

/**
 * What sits behind a single scheme's number.
 *
 * Opens when a bubble or bar is clicked. The point is to answer "why is this
 * scheme expensive?" in one look: which slabs hold the dealers, which hold the
 * money, and where the payout rate steps up. Those three rarely coincide --
 * the biggest dealer count is usually the cheapest band.
 */
export function SchemeDrilldown({
  scheme,
  rows,
  onClose,
  onOpenSimulator,
}: {
  scheme: SchemePayload;
  rows: SlabRow[];
  onClose: () => void;
  onOpenSimulator: () => void;
}) {
  // Clicking a bubble in the chart above opens this panel out of view, so bring
  // it to the user rather than making them hunt for it.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [scheme.key]);

  const components = useMemo(() => {
    const map = new Map<string, SlabRow[]>();
    for (const r of rows) {
      if (!map.has(r.component)) map.set(r.component, []);
      map.get(r.component)!.push(r);
    }
    return Array.from(map.entries()).map(([name, list]) => ({
      name,
      rows: [...list].sort((a, b) => a.slab_index - b.slab_index),
      cn: list.reduce((a, r) => a + (r.simulated_cn ?? r.current_cn), 0),
    }))
      .sort((a, b) => b.cn - a.cn)
      .slice(0, 3);
  }, [rows]);

  const totals = useMemo(() => {
    const cn = rows.reduce((a, r) => a + (r.simulated_cn ?? r.current_cn), 0);
    // Distinct dealers: summing rows counts a dealer once per component.
    const dealers = scheme.totals.dealer_count;
    const gsr = scheme.totals.gsr;
    return { cn, dealers, gsr, pct: gsr > 0 ? (cn / gsr) * 100 : 0 };
  }, [rows, scheme]);

  return (
    <section ref={ref} className="drill viz-root" role="region" aria-label={`${scheme.label} breakdown`}>
      <header className="drill-head">
        <div>
          <span className="drill-eyebrow">Breakdown</span>
          <h3>{scheme.label}</h3>
        </div>
        <div className="drill-stats">
          <div><span>Payout</span><b>{fmtMoney(totals.cn)}</b></div>
          <div><span>On GSR of</span><b>{fmtMoney(totals.gsr)}</b></div>
          <div><span>Rate</span><b>{totals.pct.toFixed(2)}%</b></div>
          <div><span>Dealers</span><b>{fmtInr(totals.dealers)}</b></div>
        </div>
        <div className="drill-actions">
          <button className="btn sm" onClick={onOpenSimulator}>Edit slabs →</button>
          <button className="btn sm icon" onClick={onClose} aria-label="Close breakdown">✕</button>
        </div>
      </header>

      <div className="drill-body">
        {components.map((comp) => {
          const maxCn = Math.max(...comp.rows.map((r) => r.simulated_cn ?? r.current_cn), 1);
          const maxDealers = Math.max(...comp.rows.map((r) => r.dealer_count), 1);
          return (
            <div className="drill-comp" key={comp.name}>
              <h4>{comp.name}</h4>
              <div className="drill-slabs">
                {comp.rows.map((r, i) => {
                  const cn = r.simulated_cn ?? r.current_cn;
                  return (
                    <div className="drill-slab" key={r.row_id}
                         style={{ animationDelay: `${i * 40}ms` }}>
                      <span className="ds-band">
                        {r.slab_mode === "unrated" ? "Not qualified"
                          : r.slab_mode === "target" ? fmtTarget(r.slab_lower, r.slab_upper, r.cn_rate, r.formula, r.pack_size)
                            : fmtSlab(r.slab_lower, r.slab_upper)}
                      </span>
                      <span className="ds-rate">{fmtRate(r.cn_rate, r.formula, r.pack_size)}</span>
                      <span className="ds-bars">
                        <i className="ds-cn" style={{ width: `${(cn / maxCn) * 100}%` }} />
                        <i className="ds-dealers" style={{ width: `${(r.dealer_count / maxDealers) * 100}%` }} />
                      </span>
                      <span className="ds-val">
                        <b>{fmtMoney(cn)}</b>
                        <em>{fmtInr(r.dealer_count)} dealers</em>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <footer className="drill-foot">
        <span><i className="sw sw-s2" /> Credit note</span>
        <span><i className="sw sw-rate" /> Dealers in band</span>
        <span className="muted">Bars are scaled within this scheme, not across schemes.</span>
      </footer>
    </section>
  );
}
