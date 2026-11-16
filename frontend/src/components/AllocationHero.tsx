import { fmtMoney } from "../api/computeImpact";
import { useCountUp } from "../hooks/useCountUp";

/**
 * How much of the business we hand back.
 *
 * An arc rather than the nested circles this replaced: two plain circles read as
 * a static logo sitting apart from the page, and at a few percent the inner one
 * was too small to carry information. A gauge sweeps to its value and re-sweeps
 * whenever a simulated rate changes, so the panel belongs to the dashboard
 * rather than decorating it.
 *
 * The scale is capped at 20%: a rebate lives in single-digit percentages, and a
 * 0-100% gauge would pin every real value to a stub near zero.
 */
const MAX_PCT = 20;

export function AllocationHero({
  gsr,
  currentCn,
  simulatedCn,
  facts = [],
}: {
  gsr: number;
  currentCn: number;
  simulatedCn: number;
  /** Supporting figures shown beneath the gauge. The card was otherwise ~40%
      empty, which is what made the page read as sparse and cluttered at the
      same time -- whitespace pooling here while the tables ran cramped. */
  facts?: { label: string; value: string; hint?: string }[];
}) {
  const pct = gsr > 0 ? (currentCn / gsr) * 100 : 0;
  const simPct = gsr > 0 ? (simulatedCn / gsr) * 100 : 0;
  const changed = Math.abs(simulatedCn - currentCn) > 0.5;

  const animatedPct = useCountUp(pct, 900);
  const animatedCn = useCountUp(currentCn, 900);

  // 240-degree sweep, opening at the bottom
  const R = 74;
  const C = 92;
  const SWEEP = 240;
  const START = 150;
  const circ = 2 * Math.PI * R;
  const arcLen = (SWEEP / 360) * circ;
  const frac = (v: number) => Math.min(1, Math.max(0, v / MAX_PCT));

  return (
    <section className="hero-alloc viz-root">
      <div className="hero-gauge">
        <svg viewBox="0 0 184 184" role="img"
             aria-label={`Payout ${pct.toFixed(2)} percent of GSR`}>
          <g transform={`rotate(${START} ${C} ${C})`}>
            <circle className="g-track" cx={C} cy={C} r={R}
                    strokeDasharray={`${arcLen} ${circ}`} />
            {changed && (
              <circle className="g-sim" cx={C} cy={C} r={R}
                      strokeDasharray={`${arcLen * frac(simPct)} ${circ}`} />
            )}
            <circle className="g-val" cx={C} cy={C} r={R}
                    strokeDasharray={`${arcLen * frac(pct)} ${circ}`} />
          </g>
          <text className="g-num" x={C} y={C + 4} textAnchor="middle">
            {animatedPct.toFixed(2)}
          </text>
          <text className="g-unit" x={C} y={C + 24} textAnchor="middle">% of GSR</text>
          <text className="g-min" x={30} y={168} textAnchor="middle">0%</text>
          <text className="g-max" x={154} y={168} textAnchor="middle">{MAX_PCT}%</text>
        </svg>
      </div>

      <div className="hero-copy">
        <span className="hero-eyebrow">Payout as a share of business</span>
        <p className="hero-sub">
          <strong>{fmtMoney(animatedCn)}</strong> given back on{" "}
          <strong>{fmtMoney(gsr)}</strong>
        </p>
        {/* The "business = EB + Timbra full-month GSR (B)" note lived here.
            It described how the denominator is assembled from source columns --
            an ingest detail. The reader needs the number, not its provenance. */}

        {facts.length > 0 && (
          <dl className="hero-facts">
            {facts.map((f) => (
              <div key={f.label} className="hf" title={f.hint}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {changed && (
          <p className={`hero-delta ${simulatedCn > currentCn ? "up" : "down"}`}>
            Simulated <strong>{simPct.toFixed(2)}%</strong>
            <span>
              {simulatedCn > currentCn ? "▲" : "▼"} {fmtMoney(Math.abs(simulatedCn - currentCn))}
            </span>
          </p>
        )}
      </div>
    </section>
  );
}

