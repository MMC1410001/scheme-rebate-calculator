import { useEffect, useMemo, useState } from "react";
import { fmtInr, fmtMoney } from "../api/computeImpact";
import { api, errorText, isAbort } from "../api/client";

interface MonthRow {
  month: string;
  complete?: boolean;
  total_cn?: number;
  // The month's business: EB + Timbra full-month GSR (B), de-duplicated per
  // dealer. null when the export has no full-month block to read it from --
  // June is like this, and showing 0 would read as a collapse in sales.
  total_gsr?: number | null;
  dealers?: number;
  error?: string;
  schemes?: { scheme_label: string; cn: number; gsr: number; dealers: number }[];
}

interface Projection {
  method: string; label: string; cn: number; note: string; recommended: boolean;
  gsr: number; rate_pct: number;
}
interface PartialMonth {
  month: string; as_of: string; elapsed_days: number; month_days: number;
  note: string; reference_month: string;
  observed: {
    elapsed_share: number; partial_cn: number; partial_gsr: number;
    partial_rate_pct: number; reference_rate_pct: number;
    gsr_pace: number; cn_pace: number; projected_gsr: number;
  };
  projections: Projection[];
  error?: string;
}

interface TrendResponse {
  months: MonthRow[];
  partial?: PartialMonth[];
  excluded: { month: string; reason: string }[];
  forecast_status: {
    ready: boolean;
    have: string[];
    blockers: string[];
    unlocks: Record<string, string>;
  };
}

/**
 * The trend is built from six monthly exports. Warm it answers in under a
 * second, but a cold cache re-parses every file -- minutes of work behind a
 * single request. A bare "Loading months..." for that long is indistinguishable
 * from a hang, so after a few seconds this says what is actually happening.
 */
function LoadingMonths() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="loading-months" role="status" aria-live="polite">
      <div className="lm-bar"><i /></div>
      <p className="hint">Loading months…</p>
      {slow && (
        <p className="hint lm-note">
          Reading the monthly export files. This is a one-off after a data change —
          it is cached afterwards and opens instantly next time.
        </p>
      )}
    </div>
  );
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (m: string) => {
  const mm = /^(\d{4})-(\d{2})/.exec(m);
  return mm ? SHORT[Number(mm[2]) - 1] ?? m : m;
};

/**
 * Month-on-month movement, and an honest statement of what is still missing
 * before any of it becomes a forecast.
 *
 * Deliberately does NOT draw a trend line through two points. Two complete
 * months give a delta, not a trajectory, and drawing one would invite exactly
 * the reading the data cannot support.
 */
function PaceBar({
  label, pct, tone, reads,
}: { label: string; pct: number; tone: string; reads: string }) {
  return (
    <div className="pace-row">
      <span className="pace-label">
        <i className={`sw sw-${tone}`} />
        {label}
      </span>
      <div className="pace-track">
        <i className={`pace-fill is-${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <b className="pace-val">{pct.toFixed(0)}%</b>
      <span className="pace-reads">{reads}</span>
    </div>
  );
}

export function TrendView({ children }: { children?: React.ReactNode }) {
  const [data, setData] = useState<TrendResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Through the API client: a failed answer (401, 503 ...) becomes plain words and a session that ended asks to
    // log in again; it was once read as the data, and drawing it blanked the whole app.
    const ctrl = new AbortController();
    api.trend<TrendResponse>(ctrl.signal)
      .then(setData)
      .catch((e) => { if (!isAbort(e)) setErr(errorText(e)); });
    return () => ctrl.abort();
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const months = data.months.filter((m) => !m.error);
    if (months.length < 2) return [];
    const [a, b] = [months[0], months[months.length - 1]];
    const map = new Map<string, { label: string; from: number; to: number; gsrTo: number }>();
    for (const s of a.schemes ?? [])
      map.set(s.scheme_label, { label: s.scheme_label, from: s.cn, to: 0, gsrTo: 0 });
    for (const s of b.schemes ?? []) {
      const e = map.get(s.scheme_label) ?? { label: s.scheme_label, from: 0, to: 0, gsrTo: 0 };
      e.to = s.cn;
      e.gsrTo = s.gsr;
      map.set(s.scheme_label, e);
    }
    return [...map.values()]
      .filter((r) => r.from > 0 || r.to > 0)
      .map((r) => ({ ...r, delta: r.to - r.from, pct: r.from > 0 ? ((r.to - r.from) / r.from) * 100 : null }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 14);
  }, [data]);

  if (err) return <p className="error">{err}</p>;
  if (!data) return <LoadingMonths />;

  const months = data.months.filter((m) => !m.error);
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.delta)), 1);
  const fs = data.forecast_status;

  return (
    <div className="trend-wrap">
      <div className="trend-top">
        {months.map((m, i) => {
          const prev = i > 0 ? months[i - 1] : null;
          const d = prev ? (m.total_cn ?? 0) - (prev.total_cn ?? 0) : 0;
          return (
            <div className="kpi" key={m.month} style={{ animationDelay: `${i * 70}ms` }}>
              <span className="kpi-label">{label(m.month)} payout</span>
              <span className="kpi-value">{fmtMoney(m.total_cn ?? 0)}</span>
              <span className="kpi-sub">
                <span>{fmtInr(m.dealers ?? 0)} dealers</span>
                {prev && (
                  <b className={d >= 0 ? "up" : "down"}
                     title={`vs ${label(prev.month)}`}>
                    {d >= 0 ? "▲" : "▼"} {fmtMoney(Math.abs(d))}
                  </b>
                )}
              </span>
              <span className="kpi-sub kpi-gsr"
                    title="Business for the month: EB + Timbra full-month GSR (B), counted once per dealer. Per-scheme GSR is not summed — the same sale sits in several schemes at once.">
                {m.total_gsr ? (
                  <>
                    <span>on {fmtMoney(m.total_gsr)} GSR</span>
                    <b>{(((m.total_cn ?? 0) / m.total_gsr) * 100).toFixed(2)}%</b>
                  </>
                ) : (
                  <em className="muted">GSR not in this export</em>
                )}
              </span>
            </div>
          );
        })}
        {data.excluded.map((e) => (
          <div className="kpi is-excluded" key={e.month} title={e.reason}>
            <span className="kpi-label">{label(e.month)}</span>
            <span className="kpi-value">excluded</span>
            <span className="kpi-sub">mid-month snapshot</span>
          </div>
        ))}
      </div>

      {(data.partial ?? []).filter((p) => !p.error && p.projections?.length).map((p) => {
        const o = p.observed;
        const best = p.projections.find((x) => x.recommended)!;
        const naive = p.projections.find((x) => x.method === "pro_rata_cn")!;
        const measured = best.method === "measured_accrual";
        return (
          <section className="partial-card viz-root" key={p.month}>
            <div className="pc-head">
              <div>
                <span className="drill-eyebrow">Month in progress</span>
                <h3>{label(p.month)} projected to close</h3>
                {/* The caveat has to follow the method actually being shown.
                    It used to say the projection assumes August's payout rate,
                    which stopped being true once two snapshots of this month
                    made the accrual curve measurable. */}
                <p className="pc-caveat">
                  {measured
                    ? <>Extrapolated from two snapshots of this month — it assumes the
                        observed accrual and sales pace hold for the remaining{" "}
                        {(p.month_days ?? 0) - (p.elapsed_days ?? 0)} days. Not a
                        forecast model.</>
                    : <>Arithmetic projection, not a forecast model — it assumes this
                        month settles at the same payout rate as {label(p.reference_month)}.</>}
                </p>
                <p className="pc-sub">
                  as of {p.as_of} · {p.elapsed_days} of {p.month_days} days ·{" "}
                  {measured
                    ? "measured within this month"
                    : `benchmarked against ${label(p.reference_month)}`}
                </p>
              </div>
              <div className="pc-headline">
                <span>Projected payout</span>
                <b>{fmtMoney(best.cn)}</b>
                <em>vs {fmtMoney(naive.cn)} if payout accrued evenly</em>
              </div>
            </div>

            {/* the pace gap IS the finding: sales on track, payout behind */}
            <p className="pace-intro">
              How far through the month each measure is, compared with all of{" "}
              {label(p.reference_month)}:
            </p>
            <div className="pace">
              <PaceBar
                label="Calendar" tone="ref" pct={o.elapsed_share * 100}
                reads={`${p.elapsed_days} of ${p.month_days} days gone`}
              />
              <PaceBar
                label="Sales (GSR)" tone="gsr" pct={o.gsr_pace * 100}
                reads={`${fmtMoney(o.partial_gsr)} so far — tracking the calendar`}
              />
              <PaceBar
                label="Payout (CN)" tone="cn" pct={o.cn_pace * 100}
                reads={`${fmtMoney(o.partial_cn)} so far — well behind the calendar`}
              />
            </div>

            <p className="pc-insight">
              Sales are running to schedule at <b>{(o.gsr_pace * 100).toFixed(0)}%</b> of last
              month with <b>{(o.elapsed_share * 100).toFixed(0)}%</b> of the month gone, but payout
              is only at <b>{(o.cn_pace * 100).toFixed(0)}%</b>. Dealers earn nothing until they
              cross a slab, so the rate climbs from <b>{o.partial_rate_pct.toFixed(2)}%</b> today
              toward <b>{o.reference_rate_pct.toFixed(2)}%</b> as the month closes — which is why
              scaling today's payout by elapsed days understates it by
              about <b>{fmtMoney(best.cn - naive.cn)}</b>.
            </p>

            <div className="pc-methods">
              {p.projections.map((pr) => (
                <div className={`pc-method ${pr.recommended ? "is-best" : ""}`} key={pr.method}>
                  <span className="pcm-label">{pr.label}{pr.recommended && <i>used</i>}</span>
                  <b>{fmtMoney(pr.cn)}</b>
                  <em>{pr.note}</em>
                </div>
              ))}
            </div>
          </section>
        );
      })}

      {/* The plan. It follows the history deliberately: the months above are
          what the target is judged against. */}
      {children}

      <div className="trend-grid">
        {/* Needs two readable months to compare. With fewer (a server without the monthly files) this read
            months[0] of an empty list and took the whole app down to a blank page (UI-1). */}
        {months.length < 2 ? (
          <p className="hint card-viz">
            Month-on-month movement needs at least two settled months; {months.length === 1
              ? `only ${label(months[0].month)} is`
              : "none are"} available on this server yet.
          </p>
        ) : (
        <figure className="viz-root card-viz">
          <figcaption>
            <h3>What moved between {label(months[0].month)} and {label(months[months.length - 1].month)}</h3>
            <p>
              Change in credit note by scheme, first month against last. Bars run both
              ways from zero, largest movement first.
            </p>
          </figcaption>

          <div className="mom">
            {rows.map((r, i) => {
              const w = (Math.abs(r.delta) / maxAbs) * 50;
              const up = r.delta >= 0;
              return (
                <div className="mom-row" key={r.label} style={{ animationDelay: `${i * 40}ms` }}>
                  <span className="mom-name" title={r.label}>{r.label}</span>
                  <div className="mom-track">
                    <i className="mom-zero" />
                    <i
                      className={`mom-bar ${up ? "up" : "down"}`}
                      style={{ width: `${w}%`, [up ? "left" : "right"]: "50%" }}
                    />
                  </div>
                  <span className={`mom-val ${up ? "up" : "down"}`}>
                    {up ? "+" : "−"}{fmtMoney(Math.abs(r.delta))}
                    {r.pct !== null && <em>{up ? "+" : ""}{r.pct.toFixed(0)}%</em>}
                  </span>
                </div>
              );
            })}
          </div>
        </figure>
        )}

        <aside className="card-viz forecast-card">
          <h3>Forecasting October</h3>
          <p className={`fc-status ${fs.ready ? "ok" : "blocked"}`}>
            {fs.ready ? "Ready" : "Not yet possible"} — have {fs.have.map(label).join(" + ")}
          </p>

          <h4>Why not yet</h4>
          <ul className="fc-list">
            {fs.blockers.map((b) => <li key={b}>{b}</li>)}
          </ul>

          <h4>What would unlock it</h4>
          <ul className="fc-list fc-unlock">
            {Object.entries(fs.unlocks).map(([k, v]) => (
              <li key={k}><b>{k}</b><span>{v}</span></li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
