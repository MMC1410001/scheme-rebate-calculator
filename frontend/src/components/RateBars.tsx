import { useMemo } from "react";
import { fmtMoney } from "../api/computeImpact";
import type { SchemeStat } from "./ContributionChart";

/**
 * What each scheme pays, as a % of its own GSR, highest first.
 *
 * Replaced a bubble chart (GSR against rate, area = CN). That chart needed a
 * hover to name most of its marks and its large schemes piled into one corner;
 * this is shown to clients on a screen, so every figure is printed on its row.
 *
 * The reference is the business's blended rate -- the headline CN % of GSR,
 * passed in -- drawn as one line through every row. A scheme's own rate is on
 * its own GSR, and scheme GSRs overlap (one sale sits under several schemes),
 * so GSR is shown per row but never summed.
 */
export function RateBars({
  stats,
  avgPct,
  selected,
  onSelect,
}: {
  stats: SchemeStat[];
  /** The business's blended CN % of GSR (the headline figure). */
  avgPct: number;
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const { rows, ticks, maxPct, above, aboveCn, totalCn, idle } = useMemo(() => {
    const paying = stats.filter((s) => s.gsr > 0 && s.cn > 0);
    const rows = paying
      .map((s) => ({ ...s, pct: (s.cn / s.gsr) * 100 }))
      .sort((a, b) => b.pct - a.pct);

    // A 1/2/2.5/5 step that gives at most six intervals, top rounded up to it.
    const rawMax = Math.max(...rows.map((r) => r.pct), avgPct, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(rawMax / 6)));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((st) => rawMax / st <= 6)!;
    const maxPct = Math.ceil(rawMax / step - 1e-9) * step;
    const ticks: number[] = [];
    for (let v = 0; v <= maxPct + 1e-9; v += step) ticks.push(v);

    const above = rows.filter((r) => r.pct > avgPct);
    return {
      rows,
      ticks,
      maxPct,
      above: above.length,
      aboveCn: above.reduce((a, r) => a + r.cn, 0),
      totalCn: rows.reduce((a, r) => a + r.cn, 0),
      idle: stats.length - paying.length,
    };
  }, [stats, avgPct]);

  if (!rows.length) return null;
  const at = (v: number) => `${(v / maxPct) * 100}%`;
  const toggle = (key: string) => onSelect(selected === key ? null : key);

  return (
    <figure className="viz-root card-viz rate-card">
      <figcaption>
        <h3>What each scheme pays, as % of its own GSR</h3>
        <p>
          Highest first. The line is the business overall, <b>{avgPct.toFixed(2)}%</b> of GSR.{" "}
          <b>{above}</b> of {rows.length} schemes pay above it, carrying{" "}
          <b>{fmtMoney(aboveCn)}</b> ({totalCn ? ((aboveCn / totalCn) * 100).toFixed(0) : 0}%) of
          the credit note. Click a scheme for its slabs.
        </p>
      </figcaption>

      <div className="rb-head" aria-hidden="true">
        <span />
        <span className="rb-axis">
          {ticks.map((t) => (
            <i key={t} style={{ left: at(t) }}>{+t.toFixed(2)}%</i>
          ))}
          <b className="rb-avg-tag" style={{ left: at(avgPct) }}>
            business {avgPct.toFixed(2)}%
          </b>
        </span>
        <span className="rb-num">CN %</span>
        <span className="rb-num">Credit note</span>
        <span className="rb-num">GSR</span>
      </div>

      <div className="rb-list">
        {rows.map((r, i) => {
          const hot = r.pct > avgPct;
          return (
            <div
              key={r.key}
              role="button"
              className={`rb-row ${selected === r.key ? "is-selected" : ""} ${
                selected && selected !== r.key ? "is-dim" : ""
              }`}
              tabIndex={0}
              aria-pressed={selected === r.key}
              onClick={() => toggle(r.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(r.key);
                }
              }}
            >
              <span className="rb-name" title={r.label}>{r.label}</span>
              <span className="rb-track">
                {ticks.slice(1).map((t) => (
                  <i key={t} className="rb-grid" style={{ left: at(t) }} />
                ))}
                <span
                  className={`bar rb-bar ${hot ? "is-hot" : ""}`}
                  style={{ width: at(r.pct), animationDelay: `${i * 18}ms` }}
                />
                <i className="rb-avg" style={{ left: at(avgPct) }} />
              </span>
              <b className={`rb-num ${hot ? "hot" : ""}`}>{r.pct.toFixed(1)}%</b>
              <span className="rb-num">{fmtMoney(r.cn)}</span>
              <span className="rb-num rb-muted">{fmtMoney(r.gsr)}</span>
            </div>
          );
        })}
      </div>

      {idle > 0 && (
        <p className="rb-foot">
          {idle} scheme{idle === 1 ? "" : "s"} paid nothing this month and {idle === 1 ? "is" : "are"} not shown.
        </p>
      )}
    </figure>
  );
}
