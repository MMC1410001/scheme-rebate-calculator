import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, isAbort, type GrowthResponse } from "../api/client";
import { ErrorBanner } from "./Feedback";
import { fmtMoney } from "../api/computeImpact";
import { useCountUp } from "../hooks/useCountUp";
import { NumericInput } from "./NumericInput";

/**
 * "We want to do X% more next month -- what does that cost us?"
 *
 * The answer people expect is "X% more credit note", and it is wrong. Slabs are
 * thresholds: a dealer just under a boundary earns the low rate on everything,
 * and nudging them over earns them the high rate on everything -- including the
 * volume they were already doing. So payout runs AHEAD of sales.
 *
 * This panel exists to make that visible. The target sets a growth rate, the
 * server grows every dealer individually and re-buckets them against the real
 * slab table, and the headline is the gap between the two bars: what you asked
 * for, and what it costs.
 *
 * Growth is applied evenly by default, which holds each scheme's share of the
 * book exactly where it is -- the proportional-to-contribution case. Individual
 * schemes can then be pushed harder to model a targeted campaign.
 */
export function TargetPlanner({
  zone,
  region,
  depotCode,
  rateMultipliers,
  onSelectScheme,
}: {
  zone?: string[];
  region?: string[];
  depotCode?: string[];
  /** Scheme key -> simulated CN / current CN, from rates edited in the Simulator. */
  rateMultipliers?: Record<string, number>;
  onSelectScheme?: (key: string) => void;
}) {
  const [target, setTarget] = useState(10);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [data, setData] = useState<GrowthResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const seq = useRef(0);

  // The request's inputs by their contents: the parent hands down equal new arrays and objects on each render.
  const ratesKey = JSON.stringify(rateMultipliers ?? {});
  const scopeKey = [zone, region, depotCode].map((v) => (v ?? []).join("|")).join("/");
  useEffect(() => {
    const mine = ++seq.current;
    const ctrl = new AbortController();
    // A fetch's loading flag: set when it starts, cleared when it answers.
    // eslint-disable-next-line react/set-state-in-effect
    setBusy(true);
    const rates = JSON.parse(ratesKey) as Record<string, number>;
    api
      .growth({
        growth_pct: target,
        per_scheme: Object.keys(overrides).length ? overrides : undefined,
        rate_multipliers: Object.keys(rates).length ? rates : undefined,
        zone, region, depot_code: depotCode,
      }, ctrl.signal)
      .then((d) => { if (mine === seq.current) { setData(d); setErr(null); } })
      .catch((e) => { if (mine === seq.current && !isAbort(e)) setErr(errorText(e)); })
      .finally(() => { if (mine === seq.current) setBusy(false); });
    return () => ctrl.abort();
    // zone / region / depotCode are read through scopeKey (their contents).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, overrides, attempt, ratesKey, scopeKey]);

  const cn = useCountUp(data?.grown_cn ?? 0, 600);
  const rate = useCountUp(data?.grown_rate_pct ?? 0, 600);

  const top = useMemo(
    () => (data?.schemes ?? []).filter((s) => s.base_cn > 0).slice(0, expanded ? 40 : 6),
    [data, expanded]
  );

  if (!data) {
    return (
      <section className="card-viz planner">
        {err ? <ErrorBanner text={`The plan did not load. ${err}`} onRetry={() => setAttempt((n) => n + 1)} />
          : <p className="muted" role="status">Loading target planner…</p>}
      </section>
    );
  }

  const elasticity = data.elasticity;
  const cnGrowth = data.base_cn ? (data.grown_cn / data.base_cn - 1) * 100 : 0;
  // Scale the two bars against whichever grew more, so the gap is the message.
  const span = Math.max(Math.abs(target), Math.abs(cnGrowth), 1);

  return (
    <section className={`card-viz planner viz-root ${busy ? "is-busy" : ""}`}>
      {err && <ErrorBanner text={`The plan did not update. ${err}`} onRetry={() => setAttempt((n) => n + 1)} />}
      <figcaption>
        <h3>Plan next month</h3>
        <p>
          Set a sales target and every dealer is grown by it, then re-bucketed against the
          real slab table. Payout runs ahead of sales because dealers cross boundaries —
          the gap below is that effect.
          {data.rates_edited && <> Your edited rate card is applied on top.</>}
        </p>
      </figcaption>

      <div className="planner-set">
        <label>
          <span>Sales target vs this month</span>
          <div className="planner-input">
            <NumericInput
              value={target}
              step={1}
              min={-50}
              onCommit={setTarget}
              ariaLabel="Sales growth target, percent"
            />
            <em>%</em>
          </div>
        </label>
        <input
          className="planner-slider"
          type="range" min={-20} max={40} step={1}
          value={target}
          onChange={(e) => setTarget(Number(e.target.value))}
          aria-label="Sales growth target slider"
        />
        <div className="planner-presets">
          {[0, 5, 10, 15, 20].map((p) => (
            <button key={p} className={`chip-btn ${target === p ? "on" : ""}`}
                    onClick={() => { setTarget(p); setOverrides({}); }}>
              {p > 0 ? `+${p}%` : "flat"}
            </button>
          ))}
        </div>
      </div>

      {/* The whole point in two bars: what you asked for vs what it costs. */}
      <div className="planner-bars">
        <div className="pbar">
          <span className="pbar-k">Sales</span>
          <div className="pbar-track">
            <i className="pbar-fill is-gsr" style={{ width: `${(Math.abs(target) / span) * 100}%` }} />
          </div>
          <span className="pbar-v">{target >= 0 ? "+" : ""}{target.toFixed(1)}%</span>
        </div>
        <div className="pbar">
          <span className="pbar-k">Credit note</span>
          <div className="pbar-track">
            <i className="pbar-fill is-cn" style={{ width: `${(Math.abs(cnGrowth) / span) * 100}%` }} />
          </div>
          <span className="pbar-v strong">{cnGrowth >= 0 ? "+" : ""}{cnGrowth.toFixed(1)}%</span>
        </div>
      </div>

      <div className="planner-kpis">
        <div className="pk">
          <span className="pk-label">Projected credit note</span>
          <strong>{fmtMoney(cn)}</strong>
          <em>{data.delta_cn >= 0 ? "+" : ""}{fmtMoney(data.delta_cn)} vs this month</em>
        </div>
        <div className="pk">
          <span className="pk-label">Payout rate</span>
          <strong>{rate.toFixed(2)}%</strong>
          <em>from {data.base_rate_pct.toFixed(2)}% of EB GSR</em>
        </div>
        <div className="pk pk-hero" title="CN growth divided by sales growth. Above 1 means the slab structure amplifies the target: every extra rupee of sales costs more than the current average rate.">
          <span className="pk-label">Elasticity</span>
          <strong className={elasticity > 1 ? "cost" : ""}>{elasticity.toFixed(2)}×</strong>
          <em>
            {elasticity > 1
              ? `each 1% of sales costs ${elasticity.toFixed(2)}% more CN`
              : "payout tracks sales"}
          </em>
        </div>
        <div className="pk">
          <span className="pk-label">Dealers crossing up</span>
          <strong>{data.dealers_moved_up.toLocaleString("en-IN")}</strong>
          <em>move into a higher band</em>
        </div>
      </div>

      {/* A plan settles a target AND a rate card together, so when rates have
          been edited the two are shown side by side rather than one replacing
          the other -- the difference between them is what the rate change
          costs at next month's volumes, which is the decision. */}
      {data.rates_edited && (
        <div className="plan-rates">
          <div className="pr-row">
            <span>At today's rates</span>
            <b>{fmtMoney(data.grown_cn)}</b>
          </div>
          <div className="pr-row is-new">
            <span>At your edited rates</span>
            <b>{fmtMoney(data.grown_cn_at_new_rates)}</b>
          </div>
          <div className={`pr-row is-diff ${data.grown_cn_at_new_rates > data.grown_cn ? "cost" : "lower"}`}>
            <span>What the rate change costs next month</span>
            <b>
              {data.grown_cn_at_new_rates >= data.grown_cn ? "+" : ""}
              {fmtMoney(data.grown_cn_at_new_rates - data.grown_cn)}
            </b>
          </div>
          <p className="hero-note">
            Exact when a scheme's rates all move by the same factor; an approximation when
            only some bands change, because growth also moves dealers between bands and the
            two effects compound. For an exact figure at this month's volumes, use the Simulator.
          </p>
        </div>
      )}

      <table className="planner-table">
        <thead>
          <tr>
            <th>Scheme</th>
            <th className="num">Growth</th>
            <th className="num">CN now</th>
            <th className="num">CN at target</th>
            <th className="num">Δ</th>
            <th className="num" title="How hard this scheme's payout reacts to growth">Elasticity</th>
            <th className="num">Crossing up</th>
          </tr>
        </thead>
        <tbody>
          {top.map((s) => {
            const over = overrides[s.scheme] !== undefined;
            return (
              <tr key={s.scheme} className={over ? "edited" : ""}>
                <td>
                  <button className="link-cell" onClick={() => onSelectScheme?.(s.scheme)}
                          title="Break this scheme down by slab">
                    {s.label}
                  </button>
                </td>
                <td className="num edit-col">
                  <NumericInput
                    value={Math.round(s.growth_pct * 10) / 10}
                    step={1}
                    min={-50}
                    onCommit={(v) =>
                      setOverrides((o) =>
                        Math.abs(v - target) < 1e-9
                          ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== s.scheme))
                          : { ...o, [s.scheme]: v }
                      )
                    }
                    ariaLabel={`Growth for ${s.label}`}
                  />
                </td>
                <td className="num muted">{fmtMoney(s.base_cn)}</td>
                <td className="num">{fmtMoney(s.grown_cn)}</td>
                <td className={`num ${s.delta_cn > 0 ? "cost" : s.delta_cn < 0 ? "lower" : "muted"}`}>
                  {s.delta_cn === 0 ? "—" : `${s.delta_cn > 0 ? "+" : ""}${fmtMoney(s.delta_cn)}`}
                </td>
                <td className={`num ${s.elasticity > 1.5 ? "cost" : "muted"}`}>
                  {s.elasticity ? `${s.elasticity.toFixed(2)}×` : "—"}
                </td>
                <td className="num muted">{s.dealers_moved_up.toLocaleString("en-IN")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="planner-foot">
        {(data.schemes.length > 6) && (
          <button className="btn btn-ghost sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show top 6" : `Show all ${data.schemes.length} schemes`}
          </button>
        )}
        {Object.keys(overrides).length > 0 && (
          <button className="btn btn-ghost sm" onClick={() => setOverrides({})}>
            Reset per-scheme growth
          </button>
        )}
        <p className="hero-note">
          Growth is applied to each dealer, not to the totals — so this includes slab
          crossings. Flat-amount-per-dealer schemes do not scale with sales, and pack-based
          rates are recomputed as whole packs rather than scaled.
        </p>
      </div>
    </section>
  );
}
