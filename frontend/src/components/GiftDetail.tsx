import { useEffect, useState, type ReactNode } from "react";
import { useCanEdit } from "../userContext";
import { api, type GiftBlock, type GiftDetail, type GiftEdit, type GiftFigures, errorText, isAbort } from "../api/client";
import { ErrorBanner } from "./Feedback";
import { fmtAsOf } from "../api/computeImpact";
import { fmtInr, litresText as litres, rupees } from "../format";
import { ColHead } from "./ColHead";
import { EditNum } from "./MonthsView";
import { monthName } from "./monthData";

/** Gift schemes in Scheme detail (user's request, 3 Nov 2026): the gift file's month (the live month's, else the
 *  month before), one card per scheme with dealers by gifts earned and by region. Where the scheme's rule reproduces
 *  the file (1 gift per N litres, or N% of GSR) its rule and its volume can be typed over, and every dealer's gifts
 *  are recomputed by the rule. Never part of CN; the edits live in this browser only and are not saved. */


export function GiftSchemes({ scope, edits, onEdit, open, onToggle, onBack }: {
  scope: { zone: string[]; region: string[]; depot_code: string[] };
  /** scheme -> its what-if edit (kept by the caller so it survives a switch to Overall Schemes). */
  edits: Record<string, GiftEdit>;
  onEdit: (scheme: string, edit: GiftEdit | null) => void;
  /** Open cards (kept by the caller: a gift's name in Overall Schemes opens its card here). */
  open: Set<string>;
  onToggle: (scheme: string) => void;
  /** "←" in an open card's header: back to Overall Schemes. */
  onBack: () => void;
}) {
  const [block, setBlock] = useState<GiftBlock | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const scopeKey = `${scope.zone.join("|")}#${scope.region.join("|")}#${scope.depot_code.join("|")}`;
  useEffect(() => {
    const ctrl = new AbortController();
    setErr(null);
    api.gifts(scope, ctrl.signal)
      .then((d) => setBlock(d.current?.schemes.length ? d.current : d.previous))
      .catch((e) => { if (!isAbort(e)) { setBlock(null); setErr(errorText(e)); } });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, attempt]);
  // A failure is said, with Retry, rather than the gift schemes silently missing from the page.
  if (err) {
    return (
      <section className="gift-detail" aria-label="Gift schemes">
        <ErrorBanner text={`Gift schemes could not be loaded. ${err}`} onRetry={() => setAttempt((n) => n + 1)} />
      </section>
    );
  }
  if (!block || block.schemes.length === 0) return null;

  return (
    <section className="gift-detail" aria-label="Gift schemes">
      <div className="scheme-list-head">
        <div>
          <h2>Gift schemes · {monthName(block.month)}</h2>
          <span>
            {block.as_of ? fmtAsOf(block.as_of, block.version) : ""} · from the separate gift file, <b>not part of CN</b>.
            Where a scheme's rule reproduces the file (1 gift per N litres, or N% of GSR), click its rule or volume to
            try another figure; every dealer's gifts are recomputed. Edits stay in this browser and are not saved.
          </span>
        </div>
      </div>
      <div className="scheme-list">
        {block.schemes.map((r) => (
          <GiftCard key={r.scheme} scheme={r.scheme} unit={r.unit} earned={r.earned} scope={scope}
                    open={open.has(r.scheme)} edit={edits[r.scheme]}
                    onToggle={() => onToggle(r.scheme)} onBack={onBack}
                    onEdit={(e) => onEdit(r.scheme, e)} />
        ))}
      </div>
    </section>
  );
}

function GiftCard({ scheme, unit, earned, scope, open, edit, onToggle, onEdit, onBack }: {
  scheme: string;
  unit: "gifts" | "rupees";
  earned: number;
  scope: { zone: string[]; region: string[]; depot_code: string[] };
  open: boolean;
  edit: GiftEdit | undefined;
  onToggle: () => void;
  onEdit: (edit: GiftEdit | null) => void;
  onBack: () => void;
}) {
  const [d, setD] = useState<GiftDetail | null>(null);
  // The gift scheme's rule and volume: its manager's or an ADMIN's to edit.
  const editable = useCanEdit()(scheme);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([scope, edit ?? {}]);
  useEffect(() => {
    if (!open && !edit) return;
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      api.giftDetail({ ...scope, scheme, ...(edit ?? {}) }, ctrl.signal)
        .then((x) => { setD(x); setErr(null); })
        .catch((e) => { if (!isAbort(e)) setErr(errorText(e)); });
    }, 200);
    return () => { ctrl.abort(); window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scheme, key, attempt]);

  const money = unit === "rupees";
  const amount = (n: number) => (money ? rupees(n) : `${fmtInr(n)} gifts`);
  const t = d?.totals;
  const now = (f: GiftFigures) => f.edited_earned ?? f.earned;
  const rule = d?.rule;
  const ruleLabel = !rule ? null
    : rule.kind === "per_litre" ? `1 gift per ${fmtInr(d.rule_value ?? rule.value)} litres` : `${d.rule_value ?? rule.value}% of GSR`;
  const fileRule = !rule ? null
    : rule.kind === "per_litre" ? `1 gift per ${fmtInr(rule.value)} litres` : `${rule.value}% of GSR`;
  const change = (a: number, b: number) => {
    const x = b - a;
    if (Math.abs(x) < 0.005) return null;
    return <em className={x > 0 ? "cost" : "lower"}> {x > 0 ? "+" : "−"}{money ? rupees(Math.abs(x)) : fmtInr(Math.abs(x))}</em>;
  };

  /** Volume typed over: stored as a % on the file's volume, solved from what the figure showed. */
  const editVolume = (from: number, to: number) => {
    if (!(from > 0) || !(to > 0)) return;
    const pct = Math.round(((to / from) * (1 + (edit?.volume_pct ?? 0) / 100) - 1) * 100 * 1e6) / 1e6;
    const next = { ...edit, volume_pct: Math.abs(pct) < 1e-6 ? undefined : pct };
    onEdit(next.volume_pct == null && next.rule_value == null ? null : next);
  };
  const editRule = (to: number) => {
    if (!rule || !(to > 0)) return;
    const next = { ...edit, rule_value: Math.abs(to - rule.value) < 1e-9 ? undefined : to };
    onEdit(next.volume_pct == null && next.rule_value == null ? null : next);
  };

  const shownEarned = d && t ? now(t) : earned;
  return (
    <section className={`card ${edit ? "card-edited" : ""}`} id={`sd-gift-${scheme}`}>
      <header className="card-head" onClick={onToggle}>
        {open && (
          <button type="button" className="btn btn-ghost sm sd-card-back" title="Back to the Overall Schemes table"
                  aria-label="Back to Overall Schemes" onClick={(e) => { e.stopPropagation(); onBack(); }}>
            ←
          </button>
        )}
        <button className="chev" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${scheme}`}>
          {open ? "▾" : "▸"}
        </button>
        <div className="card-title">
          <h2>{scheme}</h2>
          <span className="chip">{money ? "paid in ₹ · not CN" : "gifts · count"}</span>
          {d && (rule ? <span className="chip chip-muted" title={`Matches the file for ${(rule.match * 100).toFixed(1)}% of dealers`}>rule: {ruleLabel}</span>
                      : <span className="chip chip-muted" title="No rule reproduces the file's gift counts, so this scheme can be viewed but not edited">view only</span>)}
          {edit && <span className="chip chip-note">edited</span>}
        </div>
        <div className="card-figs">
          {edit && d && t ? (
            <>
              <span className="fig-was">{amount(t.earned)}</span>
              <span className="fig-arrow" aria-hidden="true">→</span>
              <span className="fig-now">{amount(shownEarned)}</span>
            </>
          ) : <span className="fig-now">{amount(shownEarned)}</span>}
        </div>
      </header>
      {open && (
        <div className="card-body">
          {err && <ErrorBanner text={err} onRetry={() => { setErr(null); setAttempt((n) => n + 1); }} />}
          {!d && !err && <p className="hint">Loading…</p>}
          {d && t && (
            <>
              <div className={`scheme-summary ${edit ? "is-edited" : ""}`}>
                <Stat label="Dealers" value={fmtInr(t.dealers)} />
                <Stat label="Qualified" value={<>{fmtInr(t.edited_qualified ?? t.qualified)}{t.edited_qualified != null && change(t.qualified, t.edited_qualified)}</>} />
                <Stat label="Volume" value={rule && editable ? (
                  <EditNum value={t.edited_volume ?? t.volume} edited={Boolean(edit?.volume_pct)}
                           label={`volume, ${scheme}`} onCommit={(to) => editVolume(t.edited_volume ?? t.volume, to)}>
                    {litres(t.edited_volume ?? t.volume)}
                  </EditNum>
                ) : litres(t.volume)} />
                <Stat label="GSR" value={rupees(t.edited_gsr ?? t.gsr)} />
                {rule && (
                  <Stat label={rule.kind === "per_litre" ? "Litres per gift" : "% of GSR"} value={!editable
                    ? (rule.kind === "per_litre" ? `${fmtInr(d.rule_value ?? rule.value)} litres` : `${d.rule_value ?? rule.value}%`) :
                    <EditNum value={d.rule_value ?? rule.value} isPct={rule.kind === "pct_gsr"}
                             edited={edit?.rule_value != null}
                             label={`${rule.kind === "per_litre" ? "litres per gift" : "% of GSR"}, ${scheme}`}
                             onCommit={editRule}>
                      {rule.kind === "per_litre" ? `${fmtInr(d.rule_value ?? rule.value)} litres` : `${d.rule_value ?? rule.value}%`}
                    </EditNum>
                  } />
                )}
                <Stat label={money ? "Paid (₹)" : "Gifts (count)"}
                      value={<>{amount(now(t))}{t.edited_earned != null && change(t.earned, t.edited_earned)}</>} />
              </div>
              {edit && (
                <button className="btn btn-ghost sm" onClick={() => onEdit(null)}>Reset this gift scheme</button>
              )}
              <p className="hint">
                {rule
                  ? `Rule read from the file: ${fileRule} (matches ${(rule.match * 100).toFixed(1)}% of dealers). ` +
                    (rule.kind === "per_litre"
                      ? "With an edit, each dealer's gifts = what the file says plus the change the rule gives, so dealers the rule does not match keep their own count."
                      : "Qualification stays as in the file (its entry condition is not in it); the qualified are paid the % of their GSR.")
                  : "No rule reproduces this scheme's gift counts from the file (tiers or one-off thresholds), so it is shown as the file has it and cannot be edited."}
              </p>
              <Table first={money ? "Dealers" : "Gifts earned"} rows={d.levels.map((l) => ({ ...l, key: l.label }))}
                     amount={amount} money={money} edited={d.edited} />
              <Table first="Region" rows={d.regions.map((r) => ({ ...r, key: r.region, label: r.region }))}
                     amount={amount} money={money} edited={d.edited} withQualified />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return <div className="ss-stat"><span>{label}</span><b>{value}</b></div>;
}

function Table({ first, rows, amount, money, edited, withQualified = false }: {
  first: string;
  /** A rupee scheme: the figure is ₹ paid, in its own column; otherwise a count of gifts. */
  money: boolean;
  rows: (GiftFigures & { key: string; label: string })[];
  amount: (n: number) => string;
  edited: boolean;
  withQualified?: boolean;
}) {
  const sum = (k: keyof GiftFigures) => rows.reduce((t, r) => t + ((r[k] as number | undefined) ?? 0), 0);
  return (
    <div className="component">
      <table>
        <thead>
          <tr>
            <th><ColHead name={first} unit={first === "Gifts earned" ? "per dealer" : undefined} /></th>
            <th className="num"><ColHead name="Dealers" unit="count" /></th>
            {withQualified && <th className="num"><ColHead name="Qualified" unit="count" /></th>}
            <th className="num"><ColHead name="Volume" unit="litres" /></th>
            <th className="num"><ColHead name="GSR" unit="₹" /></th>
            <th className="num">{money ? <ColHead name="Paid" unit="₹" /> : <ColHead name="Gifts" unit="count" />}</th>
            {edited && <th className="num">{money ? <ColHead name="Paid with edits" unit="₹" /> : <ColHead name="Gifts with edits" unit="count" />}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td className="num">{fmtInr(r.dealers)}</td>
              {withQualified && <td className="num">{fmtInr(r.edited_qualified ?? r.qualified)}</td>}
              <td className="num">{fmtInr(Math.round(r.edited_volume ?? r.volume))}</td>
              <td className="num">{rupees(r.edited_gsr ?? r.gsr)}</td>
              <td className="num">{amount(r.earned).replace(" gifts", "")}</td>
              {edited && <td className="num">{amount(r.edited_earned ?? r.earned).replace(" gifts", "")}</td>}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="comp-total">
            <td>Total</td>
            <td className="num">{fmtInr(sum("dealers"))}</td>
            {withQualified && <td className="num">{fmtInr(rows.reduce((t, r) => t + (r.edited_qualified ?? r.qualified), 0))}</td>}
            <td className="num">{fmtInr(Math.round(rows.reduce((t, r) => t + (r.edited_volume ?? r.volume), 0)))}</td>
            <td className="num">{rupees(rows.reduce((t, r) => t + (r.edited_gsr ?? r.gsr), 0))}</td>
            <td className="num">{amount(sum("earned")).replace(" gifts", "")}</td>
            {edited && <td className="num">{amount(rows.reduce((t, r) => t + (r.edited_earned ?? r.earned), 0)).replace(" gifts", "")}</td>}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
