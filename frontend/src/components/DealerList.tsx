import { useEffect, useRef, useState } from "react";
import { api, type Adjustment, type DealerLine, type DealersResponse, type SlabLayout, type SlabRow, errorText, isAbort } from "../api/client";
import { fmtInr, fmtMoney, fmtTarget } from "../api/computeImpact";
import { pct as fmtPct } from "../format";
import { useFocusTrap } from "../hooks/useFeedback";

/** The dealers behind one slab row: opened from the row's dealer count.
 *
 *  Laid out like the Dealers list of the scheme calculator: search by code or name, a table from 640 px and cards
 *  below it, 50 a page with a window of page numbers, Previous / Next and "Go to page". The list is client data, so
 *  it is fetched a page at a time and never kept after the dialog closes. */
export interface DealerListTarget {
  schemeKey: string;
  schemeLabel: string;
  component: string;
  row: SlabRow;
  /** Present when the user moved this component's boundaries: the list follows the edited table. */
  layout?: SlabLayout;
  scope: { zone: string[]; region: string[]; depot_code: string[]; label: string };
  rateLabel: (rate: number) => string;
  /** A row of the month table: which month ("Previous · Sep 2026"); next month also carries the volume change V. */
  month?: { kind: "previous" | "current" | "next"; label: string; growth?: number };
  /** GSR / volume edits, so the list matches the edited month's counts (not used for the previous month). */
  adjustments?: Adjustment[];
  nextAdjustments?: Adjustment[];
}

const PAGE_SIZE = 50;
const PAGE_WINDOW = 10;

function bandLabel(r: SlabRow): string {
  if (r.slab_mode === "unrated") return "Not qualified";
  if (r.slab_mode === "target") {
    const range = fmtTarget(r.slab_lower, r.slab_upper, r.cn_rate, r.formula, r.pack_size);
    return range.startsWith("rate ") ? `Rate tier, ${range}` : `Rate tier, achievement ${range}`;
  }
  const lo = fmtInr(Math.max(0, r.slab_lower));
  return r.slab_upper == null ? `${lo} and above` : `${lo} – ${fmtInr(r.slab_upper)}`;
}

/** Page numbers: a window of 10 around the current page, the first and last outside it after "…". */
function PageLinks({ page, pages, go }: { page: number; pages: number; go: (p: number) => void }) {
  if (pages <= 1) return null;
  const start = Math.max(1, Math.min(page - Math.floor(PAGE_WINDOW / 2) + 1, pages - PAGE_WINDOW + 1));
  const end = Math.min(pages, start + PAGE_WINDOW - 1);
  const nums = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const num = (p: number) =>
    p === page ? (
      <span key={p} className="dl-page is-current" aria-current="page">{fmtInr(p)}</span>
    ) : (
      <button key={p} type="button" className="dl-page" onClick={() => go(p)} aria-label={`Page ${p}`}>{fmtInr(p)}</button>
    );
  const gap = (k: string) => <span key={k} className="dl-gap" aria-hidden="true">…</span>;
  return (
    <span className="dl-pages">
      {page > 1 && <button type="button" className="dl-page dl-nav" onClick={() => go(page - 1)}>‹ Previous</button>}
      {start > 1 && [num(1), start > 2 ? gap("g1") : null]}
      {nums.map(num)}
      {end < pages && [end < pages - 1 ? gap("g2") : null, num(pages)]}
      {page < pages && <button type="button" className="dl-page dl-nav" onClick={() => go(page + 1)}>Next ›</button>}
    </span>
  );
}

export function DealerList({ target, onClose }: { target: DealerListTarget; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [goTo, setGoTo] = useState("");
  const [res, setRes] = useState<DealersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const seq = useRef(0);
  const { row } = target;
  const edited = Boolean(target.layout) || (row.simulated_rate ?? row.cn_rate) !== row.cn_rate;

  // Search as the user types, 300 ms after the last key; a new search opens page 1.
  useEffect(() => {
    const t = window.setTimeout(() => { setQuery(q.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const mine = ++seq.current;
    const ctrl = new AbortController();
    // A fetch's loading flag: set when it starts, cleared when it answers.
    // eslint-disable-next-line react/set-state-in-effect
    setLoading(true);
    setErr(null);
    api
      .dealers({
        scheme: target.schemeKey,
        component: target.component,
        row: { slab_mode: row.slab_mode, slab_lower: row.slab_lower, slab_upper: row.slab_upper,
               cn_rate: row.cn_rate, slab_index: row.slab_index },
        layout: target.layout,
        month: target.month?.kind,
        volume_growth_pct: target.month?.growth,
        adjustments: target.month?.kind === "previous" ? [] : target.adjustments ?? [],
        next_adjustments: target.month?.kind === "next" ? target.nextAdjustments ?? [] : [],
        zone: target.scope.zone, region: target.scope.region, depot_code: target.scope.depot_code,
        q: query, page, page_size: PAGE_SIZE,
      }, ctrl.signal)
      .then((r) => { if (mine === seq.current) setRes(r); })
      .catch((e) => { if (mine === seq.current && !isAbort(e)) setErr(errorText(e)); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
    return () => ctrl.abort();
  }, [target, row, query, page]);

  // A dialog: focus starts on Close and stays inside, Escape closes it, focus goes back to the count clicked, and
  // the page behind does not scroll.
  const boxRef = useRef<HTMLDivElement>(null);
  useFocusTrap(boxRef, true, onClose);

  // The rate the dealer earns now. With a rate edit, a simulated payout differs from the actual one.
  const rate = (d: DealerLine) =>
    d.simulated_rate !== d.cn_rate
      ? <>{target.rateLabel(d.simulated_rate)} <em className="muted">was {target.rateLabel(d.cn_rate)}</em></>
      : target.rateLabel(d.cn_rate);
  const pages = res?.pages ?? 1;

  return (
    <div className="dl-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dl" role="dialog" aria-modal="true" aria-labelledby="dl-title" ref={boxRef}>
        <header className="dl-head">
          <div>
            <span className="dl-eyebrow">{target.month && <>{target.month.label} · </>}{target.schemeLabel} · {target.component}</span>
            <h2 id="dl-title">Dealers in {bandLabel(row)}</h2>
            <p className="dl-sub">
              Rate {target.rateLabel(row.cn_rate)}
              {(row.simulated_rate ?? row.cn_rate) !== row.cn_rate && <> → {target.rateLabel(row.simulated_rate ?? row.cn_rate)}</>}
              {" · "}{target.scope.label}
              {target.layout && " · structure as edited"}
              {res && <> · <b>{fmtInr(res.dealers_in_row)}</b> dealers</>}
            </p>
          </div>
          <button ref={closeRef} type="button" className="btn sm" data-autofocus onClick={onClose}>Close</button>
        </header>

        <label className="dl-search">
          <span>Dealer code or name</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dealers…" maxLength={100} />
        </label>

        {err && <p className="error" role="alert">{err}</p>}
        {!err && res && res.rows.length === 0 && (
          <p className="hint">
            {query ? `No dealer found for “${query}” in this slab.` : "No dealer in this slab."}
          </p>
        )}

        {res && res.rows.length > 0 && (
          <div className={`dl-body ${loading ? "is-loading" : ""}`}>
            <div className="dl-table-wrap">
              <table className="dl-table">
                <caption className="sr-only">Dealers in {bandLabel(row)}, {target.component}</caption>
                <thead>
                  <tr>
                    <th scope="col">Dealer code</th>
                    <th scope="col">Name</th>
                    <th scope="col">Region</th>
                    <th scope="col">Depot</th>
                    <th scope="col" className="num" title="GSR (Q), or volume (Q) where the slab is decided in litres">Achievement (Q)</th>
                    <th scope="col" className="num" title="What the dealer still needs to reach the next slab">Shortfall</th>
                    <th scope="col" className="num" title="The next slab: achievement (Q) + shortfall">Next slab</th>
                    <th scope="col" className="num" title="Share of the next slab already reached: achievement ÷ next slab">Reached</th>
                    <th scope="col" className="num">GSR</th>
                    <th scope="col" className="num">Rate</th>
                    <th scope="col" className="num">Actual CN</th>
                    {edited && <th scope="col" className="num">Simulated CN</th>}
                  </tr>
                </thead>
                <tbody>
                  {res.rows.map((d) => (
                    <tr key={d.customer_code}>
                      <td className="dl-code">{d.customer_code}</td>
                      <td>
                        {d.customer_name ?? <span className="muted">—</span>}
                        {d.od_blocked && <span className="dl-od" title="Credit note withheld: the dealer carries an overdue balance">On hold (overdue)</span>}
                      </td>
                      <td>{d.region}</td>
                      <td>{d.depot_code}</td>
                      <td className="num">{fmtInr(d.achievement)}</td>
                      <td className="num">{d.shortfall > 0 ? fmtInr(d.shortfall) : <span className="muted">—</span>}</td>
                      <td className="num">{d.next_slab != null ? fmtInr(d.next_slab) : <span className="muted">top slab</span>}</td>
                      <td className="num">{d.reached_pct != null ? fmtPct(d.reached_pct, 0) : <span className="muted">—</span>}</td>
                      <td className="num">{d.gsr ? fmtMoney(d.gsr) : <span className="muted">—</span>}</td>
                      <td className="num">{rate(d)}</td>
                      <td className="num">{fmtMoney(d.current_cn)}</td>
                      {edited && <td className="num">{fmtMoney(d.simulated_cn)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Cards below 640 px: code, name, region and the payout stay visible without a sideways scroll. */}
            <ul className="dl-cards" aria-label={`Dealers in ${bandLabel(row)}`}>
              {res.rows.map((d) => (
                <li key={d.customer_code}>
                  <div className="dl-card-top">
                    <span className="dl-code">{d.customer_code}</span>
                    <span>{fmtMoney(edited ? d.simulated_cn : d.current_cn)}</span>
                  </div>
                  <p>{d.customer_name ?? "—"}</p>
                  <p className="muted">{d.region} · depot {d.depot_code}</p>
                  <p className="muted">Achievement (Q) {fmtInr(d.achievement)} · rate {rate(d)}</p>
                  <p className="muted">
                    {d.next_slab != null
                      ? <>Next slab {fmtInr(d.next_slab)} · shortfall {fmtInr(d.shortfall)} · {fmtPct(d.reached_pct, 0)} reached</>
                      : "Top slab"}
                  </p>
                  {d.od_blocked && <span className="dl-od">On hold (overdue)</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {res && res.total > 0 && (
          <nav className="dl-foot" aria-label="Pages">
            <span>
              Page {fmtInr(res.page)} of {fmtInr(pages)} · {fmtInr(res.total)} dealers
              {query && res.total !== res.dealers_in_row && <> matching “{query}”</>}
            </span>
            <PageLinks page={res.page} pages={pages} go={setPage} />
            {pages > PAGE_WINDOW ? (
              <form className="dl-goto" onSubmit={(e) => {
                e.preventDefault();
                const n = Math.min(pages, Math.max(1, Number(goTo) || 1));
                setPage(n);
                setGoTo("");
              }}>
                <label htmlFor="dl-go">Go to page</label>
                <input id="dl-go" type="number" min={1} max={pages} value={goTo} onChange={(e) => setGoTo(e.target.value)} required />
                <button type="submit" className="dl-page">Go</button>
              </form>
            ) : <span />}
          </nav>
        )}
        {loading && !res && <p className="hint">Loading dealers…</p>}
      </div>
    </div>
  );
}
