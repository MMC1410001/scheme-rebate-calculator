import { useMemo, useState } from "react";
import { fmtMoney } from "../api/computeImpact";

export interface SchemeStat {
  key: string;
  label: string;
  gsr: number;
  cn: number;
  dealers: number;
}

/**
 * Where the rebate pot actually goes.
 *
 * Two measures live in this chart and they are NOT comparable:
 *
 *   share of total payout   additive across schemes, so a share is meaningful
 *   payout rate on own GSR  a ratio inside one scheme, on its own scale
 *
 * They used to be drawn as two bars stacked in the same row, each normalised to
 * its own maximum. That is a dual-axis chart wearing a disguise: identical mark,
 * identical baseline, two unrelated scales, so a reader compares the lengths and
 * the comparison is meaningless. It also rendered the rate unreadable -- Early
 * Bird's 0.21% was a one-pixel stub next to a full-width share bar.
 *
 * So the two now use DIFFERENT MARKS. Share keeps the bar, because length from a
 * zero baseline is what a share deserves. Rate becomes a dot on a shared,
 * labelled scale with the blended average marked on it -- a dot plot, which
 * invites comparison down the column (against other schemes and against the
 * average) and not across the row.
 *
 * GSR is deliberately never shown as a share: the same sale sits in several
 * schemes' GSR at once, so "share of GSR" would be an invented number.
 */
export function ContributionChart({
  stats,
  avgPct,
  limit = 10,
  selected,
  onSelect,
}: {
  stats: SchemeStat[];
  /**
   * The business's blended CN % of GSR (the headline figure). Not CN over the
   * sum of scheme GSRs: the same sale counts under several schemes, so that sum
   * overstates GSR and put the average at about a third of the true rate.
   */
  avgPct: number;
  limit?: number;
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  // The top `limit` by default; "Other" (or the button under the list) opens
  // every scheme, so nothing is hidden behind a hover.
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? stats.length : limit;

  const { rows, maxPct } = useMemo(() => {
    const totalCn = stats.reduce((a, s) => a + s.cn, 0);
    if (!totalCn) return { rows: [], maxPct: 1 };

    const sorted = [...stats].sort((a, b) => b.cn - a.cn);
    const head = sorted.slice(0, shown);
    const tail = sorted.slice(shown);
    const all = [...head];
    if (tail.length) {
      all.push({
        key: "__other",
        label: `Other (${tail.length} schemes)`,
        gsr: tail.reduce((a, s) => a + s.gsr, 0),
        cn: tail.reduce((a, s) => a + s.cn, 0),
        dealers: 0,
      });
    }
    const built = all.map((s) => ({
      ...s,
      share: (s.cn / totalCn) * 100,
      pct: s.gsr > 0 ? (s.cn / s.gsr) * 100 : 0,
    }));
    return {
      rows: built,
      maxPct: Math.max(...built.map((r) => r.pct), avgPct, 1),
    };
  }, [stats, avgPct, shown]);

  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.share), 1);
  const posOf = (v: number) => Math.min(100, Math.max(0, (v / maxPct) * 100));

  return (
    <figure className="viz-root card-viz contrib-card">
      <figcaption>
        <h3>
          Where the payout goes
          {/* Say what the list holds, so no one reads the top 10 as all of them. */}
          <span className="contrib-scope">
            {showAll || stats.length <= limit
              ? `All ${stats.length} schemes`
              : `Top ${limit} of ${stats.length} schemes · by credit note`}
          </span>
        </h3>
        <p>
          Bars are each scheme's share of the total credit note. The dots are a
          separate measure on their own scale — what the scheme pays out as a
          percentage of <em>its own</em> GSR — so a small scheme can still be an
          expensive one. <b>Click a row to break it down by slab.</b>
        </p>
      </figcaption>

      <div className="contrib-head" aria-hidden="true">
        <span />
        <span className="ch-label">Share of total payout</span>
        <span className="ch-label ch-rate">
          Payout rate on own GSR
          {/* A caption, not tick labels on the strip: the blended average sits at
              1.8% against a 19% maximum, so an "avg" label placed at its true
              position would land on top of the 0% label. */}
          <i className="ch-axis">
            scale 0–{maxPct.toFixed(0)}% · <b>|</b> marks the {avgPct.toFixed(2)}% business rate
          </i>
        </span>
      </div>

      <div className="contrib">
        {rows.map((r, i) => {
          // Same split as the scatter's colours: above the business rate or not.
          const hot = r.pct > avgPct && r.key !== "__other";
          const isOther = r.key === "__other";
          return (
            <div
              key={r.key}
              className={`contrib-row ${hover === r.key ? "is-hover" : ""} ${
                selected === r.key ? "is-selected" : ""
              } ${selected && selected !== r.key ? "is-dim" : ""} ${
                isOther ? "" : "is-clickable"
              }`}
              onMouseEnter={() => setHover(r.key)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(r.key)}
              onBlur={() => setHover(null)}
              onClick={() => (isOther ? setShowAll(true) : onSelect(selected === r.key ? null : r.key))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (isOther) setShowAll(true);
                  else onSelect(selected === r.key ? null : r.key);
                }
              }}
              tabIndex={0}
              role="button"
              aria-pressed={isOther ? undefined : selected === r.key}
            >
              <span className="contrib-name" title={r.label}>{r.label}</span>

              <div className="contrib-bar">
                <div className="bar-track">
                  <div
                    className="bar bar-cn"
                    style={{ width: `${(r.share / max) * 100}%`, animationDelay: `${Math.min(i, 10) * 40}ms` }}
                  />
                </div>
                <b className="contrib-cn">{fmtMoney(r.cn)}</b>
              </div>

              {/* Dot plot: a different mark on its own labelled scale, so it
                  cannot be read as comparable to the bar beside it. */}
              <div className="contrib-rate">
                <span className="rate-scale">
                  <i className="rate-avg" style={{ left: `${posOf(avgPct)}%` }} />
                  <i
                    className={`rate-dot ${hot ? "is-hot" : ""}`}
                    style={{ left: `${posOf(r.pct)}%`, animationDelay: `${Math.min(i, 10) * 40 + 90}ms` }}
                  />
                </span>
                <b className={hot ? "hot" : ""}>{r.pct.toFixed(2)}%</b>
              </div>

              {hover === r.key && (
                <div className="viz-tip" role="tooltip">
                  <strong>{r.label}</strong>
                  <span>Credit note {fmtMoney(r.cn)} · {r.share.toFixed(1)}% of total payout</span>
                  {r.gsr > 0 && <span>On GSR of {fmtMoney(r.gsr)}</span>}
                  <span className={hot ? "warn" : ""}>
                    Payout rate {r.pct.toFixed(2)}%
                    {hot ? ` — above the ${avgPct.toFixed(2)}% business rate` : ""}
                  </span>
                  <span className="tip-cta">
                    {isOther ? "Click to list every scheme" : "Click to break down by slab"}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {stats.length > limit && (
        <button type="button" className="contrib-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? `Show top ${limit} only` : `Show all ${stats.length} schemes`}
        </button>
      )}
    </figure>
  );
}
