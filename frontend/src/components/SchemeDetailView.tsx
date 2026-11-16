import { useEffect, useState, type ReactNode } from "react";
import {
  api, errorText, isAbort, type Adjustment, type MonthTable, type SchemeMonthRow, type SchemeMonths, type SlabLayout, type SlabRow,
} from "../api/client";
import { fmtAsOf, fmtMoney, rateUnit } from "../api/computeImpact";
import { fmtInr, litresText, pct as fmtPct } from "../format";
import { ErrorBanner } from "./Feedback";
import { editHint } from "./editChoices";
import type { DealerListTarget } from "./DealerList";
import {
  EditNum, HeldFixedNote, SlabTable, type CellEdit, type Kind, type NextSlabEdit, type Scope,
} from "./MonthsView";
import { FIELD_LABEL, monthDealers, monthName, schemeMix, schemeRowOf, useMonthBlocks } from "./monthData";
import { useCanEdit } from "../userContext";
import {
  CompareSwitch, fromSlabRow, useCompareOn, Was, type CompareBase, type SchemeFigs, type SlabFigs,
} from "./compare";

/** What the current month's scheme cards compare against (the previous month). */
export interface CurrentCompare {
  base: CompareBase;
  scope: Scope;
}

/** A scheme figure that can be typed over (Volume, GSR, CN), as in the month table's scheme row. */
type SchemeField = "volume" | "gsr" | "cn" | "mix" | "cn_pct";
type EditFig = (key: string, field: SchemeField, value: number | null, shown: ReactNode,
                grow?: CellEdit["grow"]) => ReactNode;

/** The Simulator's Scheme detail: one month at a time, picked by a toggle. Current is the editor (rendered by the
 *  caller); Previous is read-only; Next shows the same figures as the Overall Schemes table. A scheme's Volume, GSR
 *  and CN can be typed over in Current and Next, exactly as in its Overall Schemes row (the same edits). */
export function SchemeDetailView({
  scope, visibleKeys, removedKeys, filtering, schemeLabels, isCurrency, growth, layouts, adjustments, nextAdjustments,
  openSchemes, onToggleScheme, onShowDealers, isLive, onEditCell, isEdited, onBack, tools, notice, renderCurrent, gifts,
  month, onMonth, nextEditOf, currentRowsOf,
}: {
  /** The current month's slab rows of a scheme: what Next is compared with. */
  currentRowsOf?: (key: string) => SlabRow[];
  /** The Next month's editing of a component (next month's own slab table), where it can be edited. */
  nextEditOf?: (key: string, component: string) => NextSlabEdit | undefined;
  /** The month shown, kept by the caller so it is still the same after a visit to Overall Schemes. */
  month?: Kind;
  onMonth?: (k: Kind) => void;
  scope: Scope;
  /** The schemes the search and filters leave, in the chosen sort order. */
  visibleKeys: string[];
  removedKeys: Set<string>;
  filtering: boolean;
  schemeLabels: Record<string, string>;
  isCurrency: (key: string) => boolean;
  growth: number;
  layouts: Record<string, SlabLayout>;
  adjustments: Adjustment[];
  nextAdjustments: Adjustment[];
  openSchemes: Set<string>;
  onToggleScheme: (key: string) => void;
  onShowDealers: (target: DealerListTarget) => void;
  /** The scheme runs in the current month (its figures can be edited). */
  isLive: (key: string) => boolean;
  onEditCell: (edit: CellEdit) => string | void;
  isEdited: (period: "current" | "next", level: CellEdit["level"], key: string, field: CellEdit["field"]) => boolean;
  /** Back to the Overall Schemes table. */
  onBack: () => void;
  /** The gift schemes, under the scheme list in every month (they come from their own file and month). */
  gifts?: ReactNode;
  tools?: ReactNode;
  notice?: ReactNode;
  /** The current month's editable scheme list: a scheme's product mix and its edited volume and GSR that month, and
   *  its Volume / GSR / CN typed over. */
  renderCurrent: (mixOf: (key: string) => number | null,
                  figsOf: (key: string) => { volume: number | null; gsr: number | null } | undefined,
                  editFig: EditFig, compareOf: (key: string) => CurrentCompare | undefined) => ReactNode;
}) {
  const [ownKind, setOwnKind] = useState<Kind>("cur");
  const kind = month ?? ownKind;
  const setKind = onMonth ?? setOwnKind;
  const { months, next, err, retry } = useMonthBlocks(scope, growth, layouts, removedKeys, adjustments, nextAdjustments);
  const blocks = { prev: months?.previous ?? null, cur: months?.current ?? null, next };
  const name = { prev: "Previous", cur: "Current", next: "Next" } as const;
  const cur = months?.current;
  const sub = {
    prev: blocks.prev ? ["settled · read-only", fmtAsOf(blocks.prev.as_of, blocks.prev.version)].filter(Boolean).join(" · ")
                      : "no file on this server",
    cur: cur ? [cur.complete ? "settled" : `day ${cur.elapsed_days} of ${cur.month_days} · your edits`,
                fmtAsOf(cur.as_of, cur.version)].filter(Boolean).join(" · ") : "loading…",
    next: next ? `plan · ${monthName(next.from_month)} as in the file${growth ? ` × (1 ${growth > 0 ? "+" : "−"} ${Math.abs(growth)}%)` : ""} · slab edits here are next month only`
               : "plan · calculating…",
  };

  const canEdit = useCanEdit();
  /** A scheme figure of the Current or Next month, typed over as in the month table (modes S, and C for CN); only by
   *  the scheme's manager or an ADMIN. */
  const editFigOf = (period: "current" | "next"): EditFig => (key, field, value, shown, grow) => !canEdit(key) ? shown : (
    <EditNum value={value} money={field === "gsr" || field === "cn"} isPct={field === "mix" || field === "cn_pct"}
             edited={isEdited(period, "scheme", key, field)}
             label={`${FIELD_LABEL[field]}, ${key}, ${period} month`} hint={editHint("scheme", field)}
             onCommit={(to) => onEditCell({ period, level: "scheme", key, field, from: value, to, grow })}>
      {shown}
    </EditNum>
  );

  // Each month against the one before it: Current with Previous, Next with Current.
  const [cmpOn, setCmpOn] = useCompareOn();
  const baseBlock = kind === "cur" ? blocks.prev : kind === "next" ? blocks.cur : null;
  const figsIn = (b: MonthTable | null | undefined, key: string, settled: boolean): SchemeFigs | undefined => {
    const r = schemeRowOf(b, key);
    if (!r) return undefined;
    const cnOf = settled ? r.cn : r.simulated_cn;
    return { volume: r.volume, mix: schemeMix(b, key), gsr: r.gsr, dealers: r.dealers, cn: cnOf,
             cnPct: r.gsr ? (100 * cnOf) / r.gsr : null };
  };
  const compareOf = (key: string): CurrentCompare | undefined => cmpOn && blocks.prev
    ? { base: { label: monthName(blocks.prev.month), figs: figsIn(blocks.prev, key, true) }, scope }
    : undefined;
  const currentSlabs = (key: string): Record<string, SlabFigs[]> => {
    const out: Record<string, SlabFigs[]> = {};
    for (const r of currentRowsOf?.(key) ?? []) (out[r.component] ??= []).push(fromSlabRow(r));
    return out;
  };

  const order = new Map(visibleKeys.map((k, i) => [k, i]));
  const block = kind === "cur" ? null : blocks[kind];
  const keys: string[] = [];
  for (const c of block?.rows ?? []) for (const s of c.scheme_rows) if (!keys.includes(s.scheme)) keys.push(s.scheme);
  const shown = keys
    .filter((k) => !removedKeys.has(k) && (!filtering || order.has(k)))
    .sort((a, b) => (order.get(a) ?? 1e6) - (order.get(b) ?? 1e6));

  return (
    <>
      <div className="scheme-list-head">
        <div>
          <h2>Scheme detail</h2>
          <span>
            {kind === "cur" ? "Expand a scheme to edit its slab boundaries and rates; click its Volume, GSR or CN to type a new figure"
              : kind === "next" ? "Expand a scheme for its slab tables; every figure, rate and slab boundary can be typed over here, next month only"
                : "Expand a scheme for its slab tables; edits are made in Current"}
          </span>
        </div>
        <div className="list-tools">{tools}</div>
      </div>
      <div className="sim-view sd-month">
        <span>Month</span>
        <div className="tabs" role="tablist" aria-label="Month shown">
          {(["prev", "cur", "next"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? "is-active" : ""}
                    disabled={k === "prev" && months !== null && !blocks.prev}
                    onClick={() => setKind(k)}>
              {name[k]} · {blocks[k] ? monthName(blocks[k]!.month) : "—"}
            </button>
          ))}
        </div>
        <em className="sd-month-sub">{sub[kind]}</em>
        {baseBlock && <CompareSwitch on={cmpOn} onChange={setCmpOn} against={monthName(baseBlock.month)} />}
      </div>
      {err && <ErrorBanner text={err} onRetry={retry} />}
      {notice}
      {kind !== "prev" && <HeldFixedNote />}
      {kind === "cur" ? renderCurrent((key) => schemeMix(blocks.cur, key), (key) => schemeRowOf(blocks.cur, key),
                                      editFigOf("current"), compareOf) : (
        <div className="scheme-list stagger">
          {!block && <p className="hint">{kind === "next" ? "Calculating next month…" : "Loading…"}</p>}
          {shown.map((k) => (
            <MonthSchemeCard
              key={k}
              kind={kind}
              schemeKey={k}
              label={schemeLabels[k] ?? k}
              money={isCurrency(k)}
              figs={schemeRowOf(block, k)}
              mix={schemeMix(block, k)}
              month={block?.month ?? null}
              open={openSchemes.has(k)}
              onToggle={() => onToggleScheme(k)}
              scope={scope}
              growth={growth}
              layouts={layouts}
              adjustments={adjustments}
              nextAdjustments={nextAdjustments}
              onShowDealers={(t) => onShowDealers(kind === "next" ? { ...t, adjustments, nextAdjustments } : t)}
              editFig={kind === "next" && isLive(k) ? editFigOf("next") : undefined}
              nextEdit={kind === "next" && nextEditOf ? (c) => nextEditOf(k, c) : undefined}
              onBack={onBack}
              compare={kind === "next" && cmpOn && blocks.cur
                ? { base: { label: monthName(blocks.cur.month), figs: figsIn(blocks.cur, k, false) }, baseRows: currentSlabs(k) }
                : undefined}
            />
          ))}
          {block && shown.length === 0 && <p className="hint">No schemes match this selection.</p>}
        </div>
      )}
      {gifts}
    </>
  );
}

/** One scheme in the previous or next month: its figures, and its slab tables when opened. */
function MonthSchemeCard({
  kind, schemeKey, label, money, figs, mix, month, open, onToggle, scope, growth, layouts, adjustments, nextAdjustments,
  onShowDealers, editFig, onBack, nextEdit, compare,
}: {
  /** Next month against the current: the current figures and slab rows per component. */
  compare?: { base: CompareBase; baseRows?: Record<string, SlabFigs[]> };
  /** Next month: a component's slab table edited in place (next month only). */
  nextEdit?: (component: string) => NextSlabEdit | undefined;
  kind: "prev" | "next";
  schemeKey: string;
  label: string;
  money: boolean;
  figs: SchemeMonthRow | undefined;
  mix: number | null;
  month: string | null;
  open: boolean;
  onToggle: () => void;
  scope: Scope;
  growth: number;
  layouts: Record<string, SlabLayout>;
  adjustments: Adjustment[];
  nextAdjustments: Adjustment[];
  onShowDealers: (target: DealerListTarget) => void;
  /** Next month: Volume, GSR and CN typed over. */
  editFig?: EditFig;
  /** A "←" in the open card's header, back to Overall Schemes. */
  onBack: () => void;
}) {
  const [data, setData] = useState<SchemeMonths | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const layoutsKey = JSON.stringify(layouts);
  const editsKey = JSON.stringify([adjustments, nextAdjustments]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      const [adjs, nextAdjs] = JSON.parse(editsKey) as [Adjustment[], Adjustment[]];
      api.schemeMonths({ ...scope, scheme: schemeKey, volume_growth_pct: growth, layouts: JSON.parse(layoutsKey),
                         adjustments: adjs, next_adjustments: nextAdjs }, ctrl.signal)
        .then((x) => { if (live) { setData(x); setErr(null); } })
        .catch((e) => { if (live && !isAbort(e)) setErr(errorText(e)); });
    }, 400);
    return () => { live = false; window.clearTimeout(t); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, attempt, schemeKey, growth, layoutsKey, editsKey, scope.zone.join("|"), scope.region.join("|"), scope.depot_code.join("|")]);

  const cn = figs ? (kind === "prev" ? figs.cn : figs.simulated_cn) : 0;
  const unit = (n: number) => (money ? fmtMoney(n) : `${fmtInr(n)} gifts`);
  const fig = (field: SchemeField, value: number | null | undefined, shown: ReactNode, grow?: CellEdit["grow"]) =>
    editFig && value != null && value > 0 ? editFig(schemeKey, field, value, shown, grow) : shown;
  const comps = kind === "prev"
    ? Object.entries(data?.previous?.components ?? {}).map(([c, rows]) => ({ c, rows, impact: undefined as number | undefined }))
    : Object.entries(data?.next.components ?? {}).map(([c, x]) => ({ c, rows: x.rows, impact: x.impact }));
  // The scheme's main slab table first, as in the month table: by GSR, then by volume.
  const sum = (rows: { gsr: number; volume: number }[], k: "gsr" | "volume") => rows.reduce((t, r) => t + r[k], 0);
  comps.sort((a, b) => sum(b.rows, "gsr") - sum(a.rows, "gsr") || sum(b.rows, "volume") - sum(a.rows, "volume"));
  const period = kind === "prev" ? "previous" : "next";
  const b = compare?.base;
  const was = (k: keyof SchemeFigs, to: number | null | undefined, f: (n: number) => string, pp = false, cost = false) =>
    b ? <Was from={b.figs?.[k]} to={to} fmt={f} pp={pp} cost={cost} month={b.label} label /> : null;
  const cnPct = figs?.gsr ? (cn / figs.gsr) * 100 : null;

  return (
    <section className="card" id={`sd-scheme-${schemeKey}`}>
      <header className="card-head" onClick={onToggle}>
        {open && onBack && (
          <button type="button" className="btn btn-ghost sm sd-card-back" title="Back to the Overall Schemes table"
                  onClick={(e) => { e.stopPropagation(); onBack(); }}>
            <span aria-hidden="true">←</span> Overall Schemes
          </button>
        )}
        <button className="chev" aria-expanded={open} aria-controls={`panel-${kind}-${schemeKey}`}
                aria-label={`${open ? "Collapse" : "Expand"} ${label}`}>
          {open ? "▾" : "▸"}
        </button>
        <div className="card-title">
          <h2>{label}</h2>
          {figs && !figs.counts && (
            <span className="muted card-meta" title="An add-on: the same sales as the product's own scheme">add-on</span>
          )}
        </div>
        <div className="card-figs"><span className="fig-now">{unit(cn)}</span></div>
      </header>
      {open && (
        <div className="card-body" id={`panel-${kind}-${schemeKey}`} role="region" aria-label={`${label} slabs`}>
          <div className="scheme-summary">
            <div className="ss-stat">
              <span>Volume</span>
              <b>{fig("volume", figs?.volume, figs?.volume ? litresText(figs.volume) : "—")}</b>
              {was("volume", figs?.volume, litresText)}
            </div>
            <div className="ss-stat" title="This scheme's volume ÷ the volume of all products that month">
              <span>Product Mix</span>
              <b>{fig("mix", mix, mix != null ? fmtPct(mix, 1) : "—",
                      // "Volume grows": the month's total volume, recovered from the share shown.
                      mix && figs?.volume ? { volume: figs.volume, total: (100 * figs.volume) / mix } : undefined)}</b>
              {was("mix", mix, (n) => fmtPct(n, 1), true)}
            </div>
            <div className="ss-stat">
              <span>GSR</span>
              <b>{fig("gsr", figs?.gsr, figs?.gsr ? fmtMoney(figs.gsr) : "—")}</b>
              {was("gsr", figs?.gsr, fmtMoney)}
            </div>
            <div className="ss-stat">
              <span>Dealers</span>
              <b>{figs?.dealers != null ? fmtInr(figs.dealers) : "—"}</b>
              {was("dealers", figs?.dealers, fmtInr)}
            </div>
            <div className="ss-stat">
              <span>Credit note</span>
              <b>{fig("cn", figs ? cn : null, unit(cn))}</b>
              {was("cn", figs ? cn : null, unit, false, true)}
            </div>
            <div className="ss-stat">
              <span>CN % of GSR</span>
              <b>{figs?.gsr && money ? fig("cn_pct", (cn / figs.gsr) * 100, fmtPct((cn / figs.gsr) * 100, 2)) : "—"}</b>
              {money && was("cnPct", cnPct, (n) => fmtPct(n, 2), true, true)}
            </div>
          </div>
          {err && <ErrorBanner text={err} onRetry={() => setAttempt((n) => n + 1)} />}
          {!data && !err && <p className="hint">Loading…</p>}
          {data && comps.length === 0 && <p className="hint">Not in this month.</p>}
          {comps.map(({ c, rows, impact }) => (
            <div key={c} className="component" id={`sd-comp-${schemeKey}::${c}`}>
              <div className="component-head">
                <h3>{c}</h3>
                {rows[0] && <span className="chip">{rateUnit(rows[0].formula, rows[0].pack_size)}</span>}
              </div>
              <SlabTable className="sd-slabs" rows={rows} withImpact={kind === "next"} total={impact} edit={nextEdit?.(c)}
                         compare={b ? { base: compare?.baseRows?.[c] ?? [], month: b.label } : undefined}
                         onDealers={(r) => onShowDealers(monthDealers({
                           schemeKey, schemeLabel: label, row: r, kind: period, month, scope, layouts, growth,
                         }))} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
