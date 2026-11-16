/** One scheme's slab tables with their editors (boundaries, rates, figures): the Current column's editor in the
 *  month table (embedded, one component) and the card in Scheme detail. */
import { useMemo, type ReactNode } from "react";
import { useUser } from "../userContext";
import type { SchemePayload, SlabRow } from "../api/client";
import { fmtMoney, fmtInr, fmtRate, fmtRegions, fmtSlab, fmtTarget, rateUnit, sumRows } from "../api/computeImpact";
import { EditNum } from "./MonthsView";
import { FIELD_LABEL } from "./monthData";
import { edgeBounds, MIX_CHOICES } from "./editChoices";
import { ColHead } from "./ColHead";
import { NumericInput } from "./NumericInput";
import { cnClass, litresText, pct as fmtPct } from "../format";
import { isMoved, rowMoved, type SlabField } from "../slabChange";
import { fromSlabRow, GoneSlabs, matchSlabs, SlabTag, usePrevSlabs, Was, type SchemeFigs, type SlabFigs } from "./compare";
import type { CurrentCompare } from "./SchemeDetailView";

export function SchemeCard({
  scheme,
  rows,
  baseline,
  open,
  onToggle,
  onEdit,
  onEditEdge,
  canEditSlabs,
  ownCards,
  movedSlabs,
  onAddSlab,
  onRemoveSlab,
  onShowDealers,
  onReset,
  embedded = false,
  only,
  productMix,
  figs,
  editFig,
  onBack,
  onEditSlab,
  slabEdited,
  compare,
  readOnly = false,
}: {
  /** Not this login's scheme: rates and figures are shown, not typed over. */
  readOnly?: boolean;
  /** Scheme detail: each figure against the previous month. */
  compare?: CurrentCompare;
  scheme: SchemePayload;
  rows: SlabRow[];
  /** The same component's rows as first served, before any edit. */
  baseline: SlabRow[];
  open: boolean;
  onToggle: () => void;
  onEdit: (rowId: string, rate: number) => void;
  /** Move the boundary at value `from` to `value`. */
  onEditEdge: (component: string, from: number, value: number) => void;
  canEditSlabs: (component: string) => boolean;
  /** Regions run different rate cards here, so each dealer keeps their region's card when a boundary moves. */
  ownCards: (component: string) => boolean;
  /** Components in THIS scheme whose boundaries the user has moved. */
  movedSlabs: Set<string>;
  onAddSlab: (component: string, row: SlabRow) => void;
  onRemoveSlab: (component: string, row: SlabRow) => void;
  /** List the dealers behind a row (its dealer count was clicked). */
  onShowDealers: (component: string, row: SlabRow) => void;
  onReset: () => void;
  /** Inside the month table, under the scheme's row: the body only, always open. */
  embedded?: boolean;
  /** Inside the month table's Current column: this one component, in the month table's columns
   *  (Slab, Dealers, Volume, Mix, GSR, Rate, CN %, CN, Impact), with no scheme summary. */
  only?: string;
  /** The scheme's volume ÷ all products' volume this month (the month table's Mix); undefined hides it. */
  productMix?: number | null;
  /** The scheme's volume and GSR this month with the GSR / volume edits (the month table's figures); else as served. */
  figs?: { volume: number | null; gsr: number | null };
  /** Scheme detail: the summary's Volume, GSR and CN typed over, as the month table's scheme row (modes S and C). */
  editFig?: (field: "volume" | "gsr" | "cn", value: number | null, shown: ReactNode) => ReactNode;
  /** Scheme detail: a "←" in the open card's header, back to Overall Schemes. */
  onBack?: () => void;
  /** A slab row's Volume, GSR or CN typed over. */
  onEditSlab?: (row: SlabRow, field: SlabField, from: number, to: number, compVolume: number, choice?: string) => string | void;
  /** Whether a slab row's Volume, GSR or Mix carries an edit. */
  slabEdited?: (row: SlabRow, field: "volume" | "gsr" | "mix") => boolean;
}) {
  // Dealer names: ADMIN only (a VIEWER sees the count, not the list).
  const { canSeeDealers } = useUser();
  // Draft text used to be held here and cleared on every `rows` change -- but
  // `rows` changes BECAUSE you typed, so the buffer was wiped mid-edit and the
  // box could never be emptied. NumericInput owns the draft instead, and holds
  // it for as long as the field has focus.
  const t = sumRows(rows);
  const money = scheme.is_currency;
  const unit = (n: number) => (money ? fmtMoney(n) : `${fmtInr(n)} gifts`);
  const delta = t.delta_cn;
  const pct = t.current_cn ? (delta / t.current_cn) * 100 : 0;
  const edited = rows.some(rowMoved);
  const volume = figs ? figs.volume ?? 0 : scheme.totals.volume;
  const gsr = figs ? figs.gsr ?? 0 : scheme.totals.gsr;
  const prevSlabs = usePrevSlabs(compare?.scope, scheme.key, Boolean(compare && open && !only));
  const cmpBase = only ? undefined : compare?.base;
  const was = (k: keyof SchemeFigs, to: number | null | undefined, f: (n: number) => string, pp = false, cost = false) =>
    cmpBase ? <Was from={cmpBase.figs?.[k]} to={to} fmt={f} pp={pp} cost={cost} month={cmpBase.label} label /> : null;
  /** A summary figure, typed over where the scheme can be edited. */
  const fig = (field: "volume" | "gsr" | "cn", value: number, shown: ReactNode) =>
    editFig && value > 0 ? editFig(field, value, shown) : shown;

  const components = useMemo(() => {
    const map = new Map<string, SlabRow[]>();
    for (const r of rows) {
      if (!map.has(r.component)) map.set(r.component, []);
      map.get(r.component)!.push(r);
    }
    return Array.from(map.entries());
  }, [rows]);

  return (
    <section className={`card ${edited ? "card-edited" : ""} ${embedded ? "card-embedded" : ""}`}
             id={embedded ? undefined : `sd-scheme-${scheme.key}`}>
      {!embedded && <header className="card-head" onClick={onToggle}>
        {open && onBack && (
          <button type="button" className="btn btn-ghost sm sd-card-back" title="Back to the Overall Schemes table"
                  onClick={(e) => { e.stopPropagation(); onBack(); }}>
            <span aria-hidden="true">←</span> Overall Schemes
          </button>
        )}
        <button
          className="chev"
          aria-expanded={open}
          aria-controls={`panel-${scheme.key}`}
          aria-label={`${open ? "Collapse" : "Expand"} ${scheme.label}`}
        >
          {open ? "▾" : "▸"}
        </button>
        <div className="card-title">
          <h2>{scheme.label}</h2>
          <span className={`badge ${scheme.status}`}
                title={scheme.status === "ok"
                  ? "Computed payout matches the source file's own total"
                  : "Computed payout does not yet match the source file — treat as provisional"}>
            {scheme.status === "ok" ? "Verified" : scheme.status === "needs_review" ? "Review" : scheme.status}
          </span>
          <span className="muted card-meta">
            {components.length} component{components.length !== 1 ? "s" : ""} · {fmtInr(scheme.totals.dealer_count)} dealers
          </span>
        </div>
        {/* Three equal-weight figure blocks used to sit here, and on an
            untouched scheme all three said the same thing -- 35 cards each
            ~95px tall repeating one number three times. Now: the current value
            alone until an edit exists, then the before/after and the delta. */}
        <div className="card-figs">
          {edited ? (
            <>
              <span className="fig-was">{unit(t.current_cn)}</span>
              <span className="fig-arrow" aria-hidden="true">→</span>
              <span className="fig-now">{unit(t.simulated_cn)}</span>
              <span className={`fig-delta ${!isMoved(delta) ? "" : cnClass(delta)}`}>
                {delta >= 0 ? "+" : ""}{unit(delta)}
                {t.current_cn > 0 && <em> ({pct >= 0 ? "+" : "−"}{Math.abs(pct).toFixed(2)}%)</em>}
              </span>
            </>
          ) : (
            <span className="fig-now">{unit(t.current_cn)}</span>
          )}
        </div>
      </header>}

      {open && (
        <div className="card-body" id={`panel-${scheme.key}${only ? `-${only}` : ""}`} role="region"
             aria-label={`${scheme.label}${only ? ` · ${only}` : ""} slabs and rates`}>
          {!only && <>
          {/* The scheme's own numbers, next to the table you are editing. The
              command bar shows these too, but only when exactly one scheme is
              open -- with several expanded it falls back to the whole book, and
              this is the one you are actually looking at. */}
          <div className={`scheme-summary ${edited ? "is-edited" : ""}`}>
            <div className="ss-stat">
              <span>Volume</span>
              <b>{fig("volume", volume, volume > 0 ? litresText(volume) : "—")}</b>
              {was("volume", volume, litresText)}
            </div>
            {productMix !== undefined && (
              <div className="ss-stat" title="This scheme's volume ÷ the volume of all products this month">
                <span>Product Mix</span>
                <b>{productMix != null ? fmtPct(productMix, 1) : "—"}</b>
                {was("mix", productMix, (n) => fmtPct(n, 1), true)}
              </div>
            )}
            <div className="ss-stat">
              <span>GSR</span>
              <b>{fig("gsr", gsr, gsr > 0 ? fmtMoney(gsr) : "—")}</b>
              {was("gsr", gsr, fmtMoney)}
            </div>
            <div className="ss-stat">
              <span>Dealers</span>
              <b>{fmtInr(scheme.totals.dealer_count)}</b>
              {was("dealers", scheme.totals.dealer_count, fmtInr)}
            </div>
            <div className="ss-stat">
              <span title="Credit note (CN) as settled in the file, before your edits">{edited ? "Actual CN" : "Credit note"}</span>
              {/* Unedited, this is the CN with edits too: the figure the month table's CN cell shows. */}
              <b>{edited ? unit(t.current_cn) : fig("cn", t.simulated_cn, unit(t.current_cn))}</b>
              {was("cn", t.current_cn, unit, false, true)}
            </div>
            <div className="ss-stat">
              <span>CN % of GSR</span>
              <b>
                {gsr > 0 && money
                  ? fmtPct((t.simulated_cn / gsr) * 100, 2)
                  : "—"}
                {edited && gsr > 0 && money && (
                  <em> was {fmtPct((t.current_cn / gsr) * 100, 2)}</em>
                )}
              </b>
              {money && gsr > 0 && was("cnPct", (t.simulated_cn / gsr) * 100, (n) => fmtPct(n, 2), true, true)}
            </div>
            {edited && (
              <>
                <div className="ss-stat is-est">
                  <span>Simulated CN</span>
                  <b>{fig("cn", t.simulated_cn, unit(t.simulated_cn))}</b>
                </div>
                <div className={`ss-stat is-impact ${cnClass(delta)}`}>
                  <span>Impact</span>
                  <b>
                    {delta >= 0 ? "+" : ""}{unit(delta)}
                    {t.current_cn > 0 && <em> ({pct >= 0 ? "+" : "−"}{Math.abs(pct).toFixed(2)}%)</em>}
                  </b>
                </div>
              </>
            )}
          </div>

          {scheme.status !== "ok" && (
            <p className="warning">
              This scheme's computed payout doesn't yet match the source file's own total. Treat these numbers as
              provisional.
            </p>
          )}
          {edited && (
            <button className="btn btn-ghost sm" onClick={onReset}>
              Reset this scheme
            </button>
          )}
          </>}

          {components.filter(([name]) => !only || name === only).map(([name, compRows]) => {
            const f = compRows[0];
            const editable = canEditSlabs(name);
            const mixed = ownCards(name);
            const slabsMoved = movedSlabs.has(name);
            const prevRows = prevSlabs?.[name] ?? [];
            const cmp = cmpBase && prevSlabs ? matchSlabs(compRows.map(fromSlabRow), prevRows) : null;
            const prevVolume = prevRows.reduce((t, b) => t + b.volume, 0);
            const wasSlab = (b: SlabFigs | undefined, k: "dealers" | "volume" | "gsr" | "cn" | "mix" | "cnPct",
                             to: number | null, fmt: (n: number) => string) => {
              if (!cmp || !cmpBase) return null;
              const from = !b ? undefined : k === "mix" ? (prevVolume ? (100 * b.volume) / prevVolume : null)
                : k === "cnPct" ? (b.gsr ? (100 * b.cn) / b.gsr : null) : b[k];
              return <Was from={from} to={to} fmt={fmt} pp={k === "mix" || k === "cnPct"} cost={k === "cn" || k === "cnPct"}
                          month={cmpBase.label} />;
            };
            const prevTotal: SlabFigs | undefined = prevRows.length ? {
              ...prevRows[0], dealers: prevRows.reduce((t, b) => t + b.dealers, 0), volume: prevVolume,
              gsr: prevRows.reduce((t, b) => t + b.gsr, 0), cn: prevRows.reduce((t, b) => t + b.cn, 0),
            } : undefined;
            const pctText = (n: number) => fmtPct(n, 2);
            const mixText = (n: number) => fmtPct(n, 1);

            // Actual CN comes from the ORIGINAL table at the same BAND POSITION
            // -- first band against first band, second against second.
            //
            // Position, not slab_index: build_slabs and rebucket number their
            // rows independently, so the original's indices do not correspond to
            // the re-bucketed ones. Keying on them shifted the whole column down
            // a row (band 4 showing band 3's payout) and left the unmatched ones
            // at zero, which is what produced a scheme reporting a few lakh on a
            // band nobody had touched.
            const curBands = compRows
              .filter((x) => x.slab_mode === "slab")
              .sort((a, b) => a.slab_index - b.slab_index);
            const baseBands = baseline
              .filter((x) => x.component === name && x.slab_mode === "slab")
              .sort((a, b) => a.slab_index - b.slab_index);
            const posOf = new Map(curBands.map((x, i) => [x.row_id, i]));
            const actualOf = (r: SlabRow) => {
              // Where each region keeps its card (or the component had no slab table), a band's rows are the same
              // dealers' rows, priced by their own card: what those dealers were actually paid is the honest figure.
              if (r.slab_mode !== "slab" || mixed || !baseBands.length) return r.current_cn;
              const pos = posOf.get(r.row_id);
              // A band added beyond what the original table had has no position
              // to compare with, so it starts from nothing.
              return pos === undefined ? 0 : baseBands[pos]?.current_cn ?? 0;
            };

            // The component's actual total is the ORIGINAL table's total, which
            // is the same money however the boundaries are redrawn.
            // Read from the ORIGINAL rows of the component, whatever their kind: a per-dealer target component
            // turned into a slab table has no original slab rows, and counting only those made its actual total 0
            // (the first boundary on Zen Star read as more than a crore).
            const baseTotal = baseline.filter((x) => x.component === name).reduce((a, x) => a + x.current_cn, 0);
            const ct = {
              ...sumRows(compRows),
              current_cn: baseTotal,
              delta_cn: sumRows(compRows).simulated_cn - baseTotal,
              // Volume and GSR are additive across the bands of ONE component:
              // each dealer sits in exactly one band, so there is nothing to
              // de-duplicate here (unlike across components of a scheme).
              volume: compRows.reduce((a, x) => a + (x.volume ?? 0), 0),
              gsr: compRows.reduce((a, x) => a + (x.gsr ?? 0), 0),
            };
            // Every boundary of the component, for the legal range of each box.
            const cuts = [...new Set(compRows.filter((x) => x.slab_mode === "slab")
              .flatMap((x) => [x.slab_lower, x.slab_upper])
              .filter((v): v is number => v != null && v > 0))].sort((a, b) => a - b);
            // The boundaries as served: one that is not among them was typed (shown as an edited figure).
            const baseCuts = new Set(baseline.filter((x) => x.component === name && x.slab_mode === "slab")
              .flatMap((x) => [x.slab_lower, x.slab_upper]).filter((v): v is number => v != null));
            // With several rate cards a band shows one row per rate; its boxes appear on the first of them.
            const firstOfRange = new Set<string>();
            const seenRange = new Set<string>();
            for (const x of compRows) {
              if (x.slab_mode !== "slab") continue;
              const k = `${x.slab_lower}|${x.slab_upper}`;
              if (!seenRange.has(k)) { seenRange.add(k); firstOfRange.add(x.row_id); }
            }
            const slabCount = seenRange.size;
            // Region labels only where rows cover different regions; a single national card needs none.
            const compRegions = [...new Set(compRows.flatMap((x) => x.regions ?? []))].sort();
            const byRegion = compRows.some((x) => (x.regions?.length ?? 0) !== compRegions.length);
            const slabCell = (r: SlabRow) => (
              <>
            {r.slab_mode === "slab" && !editable ? (
              <span className="slab-static">{fmtSlab(r.slab_lower, r.slab_upper)}</span>
            ) : r.slab_mode === "slab" && !firstOfRange.has(r.row_id) ? (
              <span className="slab-same" title="The same slab as the row above, at another region's rate">
                {fmtSlab(r.slab_lower, r.slab_upper)} · same slab
              </span>
            ) : r.slab_mode === "slab" ? (
              <span className="slab-edit">
                {/* The first band always starts at 0; every other "from" is the
                    previous band's "to" — the same edge, so editing
                    either end moves both. */}
                {r.slab_lower <= 0 ? (
                  <span className="fixed-end">0</span>
                ) : (
                  <NumericInput
                    asText shown={fmtInr(Math.round(r.slab_lower))} edited={!baseCuts.has(r.slab_lower)}
                    value={Math.round(r.slab_lower)}
                    {...edgeBounds(cuts, r.slab_lower)}
                    onCommit={(v) => onEditEdge(name, r.slab_lower, v)}
                    title="Start of this slab (also the end of the previous one)"
                    ariaLabel="Slab start"
                  />
                )}
                <span className="dash">–</span>
                {r.slab_upper == null ? (
                  <span className="fixed-end">∞</span>
                ) : (
                  <NumericInput
                    asText shown={fmtInr(Math.round(r.slab_upper))} edited={!baseCuts.has(r.slab_upper)}
                    value={Math.round(r.slab_upper)}
                    {...edgeBounds(cuts, r.slab_upper)}
                    onCommit={(v) => onEditEdge(name, r.slab_upper ?? 0, v)}
                    title="End of this slab (also the start of the next one)"
                    ariaLabel="Slab end"
                  />
                )}
                <button
                  className="slab-btn"
                  title="Split this slab in two"
                  aria-label={`Split this slab in two (${fmtSlab(r.slab_lower, r.slab_upper)})`}
                  onClick={() => onAddSlab(name, r)}
                >
                  +
                </button>
                {slabCount > 1 && (
                  <button
                    className="slab-btn"
                    title={r.slab_lower <= 0
                      ? "Remove this slab: there is no slab below, so its dealers earn nothing"
                      : "Remove this slab: its dealers drop to the slab below"}
                    aria-label={`Remove this slab (${fmtSlab(r.slab_lower, r.slab_upper)})`}
                    onClick={() => onRemoveSlab(name, r)}
                  >
                    ×
                  </button>
                )}
              </span>
            ) : r.slab_mode === "unrated" ? (
              <span
                className="muted"
                title="Dealers sitting inside a paying band who earn nothing — they did not hold the slab they qualified at in the previous window."
              >
                Not qualified
              </span>
            ) : r.slab_mode === "target" ? (
              <span className="slab-edit">
                <span>{fmtTarget(r.slab_lower, r.slab_upper, r.cn_rate, r.formula, r.pack_size)}</span>
                {editable && (
                  <button
                    className="slab-btn"
                    title="Add a slab boundary: the component becomes a slab table you can edit"
                    aria-label="Add a slab boundary"
                    onClick={() => onAddSlab(name, r)}
                  >
                    +
                  </button>
                )}
              </span>
            ) : (
              fmtSlab(r.slab_lower, r.slab_upper)
            )}
            {byRegion && r.regions && (
              <div className="slab-regions" title={r.regions.join(", ")}>
                {fmtRegions(r.regions, compRegions)}
              </div>
            )}
              </>
            );
            const dealersCell = (r: SlabRow) =>
              r.dealer_count > 0 && canSeeDealers ? (
                <button
                  type="button"
                  className="link-num"
                  onClick={() => onShowDealers(name, r)}
                  aria-label={`${fmtInr(r.dealer_count)} dealers: show the list`}
                  title="Show these dealers"
                >
                  {fmtInr(r.dealer_count)}
                </button>
              ) : fmtInr(r.dealer_count);
            /** A slab row's figure, typed over where it can be (a CN needs a rate to scale). */
            const slabFig = (r: SlabRow, field: SlabField, value: number, shown: ReactNode) =>
              onEditSlab && value > 0
              && (field === "cn" || field === "cn_pct" ? (r.simulated_rate ?? r.cn_rate) > 0 && (field === "cn" || r.gsr > 0)
                : field !== "mix" || value < 100) ? (
                <EditNum value={value} money={field === "gsr" || field === "cn"} isPct={field === "mix" || field === "cn_pct"}
                         edited={field === "cn" || field === "cn_pct" ? r.simulated_rate !== r.cn_rate : Boolean(slabEdited?.(r, field))}
                         label={`${FIELD_LABEL[field]}, ${name} ${fmtSlab(r.slab_lower, r.slab_upper)}`}
                         choices={field === "mix" ? MIX_CHOICES : undefined}
                         onCommit={(to, choice) => onEditSlab(r, field, value, to, ct.volume, choice)}>
                  {shown}
                </EditNum>
              ) : shown;
            const rateInput = (r: SlabRow) => readOnly ? (
              <span>{fmtRate(r.simulated_rate ?? r.cn_rate, r.formula, r.pack_size)}</span>
            ) : (
              <NumericInput
                asText shown={fmtRate(r.simulated_rate ?? r.cn_rate, r.formula, r.pack_size)}
                edited={(r.simulated_rate ?? r.cn_rate) !== r.cn_rate}
                value={r.simulated_rate ?? r.cn_rate}
                step={0.25}
                min={0}
                // Rates run from 0.005 to 40 depending on the scheme,
                // so the box must not round to a fixed precision.
                format={(v) => String(Math.round(v * 1e6) / 1e6)}
                onCommit={(v) => onEdit(r.row_id, v)}
                ariaLabel="New rebate rate"
              />
            );
            const head = (
              <div className="component-head">
                {onBack && (
                  <button type="button" className="btn btn-ghost sm sd-card-back" title="Back to the Overall Schemes table"
                          onClick={onBack}>
                    <span aria-hidden="true">←</span> Overall Schemes
                  </button>
                )}
                <h3 className={only ? "sr-only" : undefined}>{name}</h3>
                <span className="chip">{rateUnit(f.formula, f.pack_size)}</span>
                {slabsMoved && (
                  <span className="chip chip-note"
                        title="Dealers were re-bucketed by the boundaries you moved (or by a slab table kept from other filters). A dealer who stays in their slab keeps their rate; one who crosses into another slab is paid that slab's rate, so the total can move.">
                    boundaries moved · dealers re-bucketed
                  </span>
                )}
                {editable && mixed && f.slab_mode !== "target" && (
                  <span className="chip chip-muted" title="Regions run different rate cards for this scheme, so a band shows one row per rate. When you move a boundary, each dealer keeps their own region's card: a dealer who stays in their band keeps their rate, one who crosses into another band gets their region's rate for it.">
                    each region keeps its rate card
                  </span>
                )}
                {f.slab_mode === "target" && (
                  <span className="chip chip-muted" title="This scheme sets a target per dealer rather than one shared slab table, so rows are grouped by rate tier. Use + to add a slab boundary; every dealer keeps their own rate until you change a band's rate.">
                    per-dealer targets
                  </span>
                )}
              </div>
            );
            if (only) {
              // The month table's Current column, edited in place: Book1's columns with the rate as a box.
              const pctOf = (cn: number, gsr: number) => (gsr ? fmtPct((cn / gsr) * 100, 2) : "—");
              const impactCell = (d: number) => (
                <td className={`num ${!isMoved(d) ? "muted" : cnClass(d)}`}>
                  {!isMoved(d) ? "—" : `${d > 0 ? "+" : ""}${fmtMoney(d)}`}
                </td>
              );
              return (
                <div key={name} className="component component-inline">
                  {head}
                  <table className="mv-small mv-edit-table">
                    <thead>
                      <tr>
                        <th><ColHead name={f.slab_mode === "target" ? "Rate tier" : "Slab"} /></th>
                        <th className="num" title="Click a count to see those dealers"><ColHead name="Dealers" unit="count" /></th>
                        <th className="num"><ColHead name="Volume" unit="litres" /></th>
                        <th className="num" title="Slab volume ÷ the component's volume"><ColHead name="Product Mix" unit="%" /></th>
                        <th className="num"><ColHead name="GSR" unit="₹" /></th>
                        <th className="num edit-col" title="The rate paid in this slab: type a new one"><ColHead name="Rate" unit={rateUnit(f.formula, f.pack_size)} /></th>
                        <th className="num" title="CN ÷ GSR"><ColHead name="CN" unit="% of GSR" /></th>
                        <th className="num" title="With your edits"><ColHead name="CN" unit="₹" /></th>
                        <th className="num" title="Your edits: edited CN − actual CN"><ColHead name="Impact" unit="₹" /></th>
                      </tr>
                    </thead>
                    <tbody>
                      {compRows.map((r) => {
                        const changed = r.simulated_rate !== r.cn_rate;
                        const cn = r.simulated_cn ?? r.current_cn;
                        return (
                          <tr key={r.row_id} className={changed ? "edited" : ""}>
                            <td className="slab">{slabCell(r)}</td>
                            <td className="num">{dealersCell(r)}</td>
                            <td className="num">{r.volume ? slabFig(r, "volume", r.volume, fmtInr(Math.round(r.volume))) : <span className="muted">—</span>}</td>
                            <td className="num">{ct.volume ? slabFig(r, "mix", (100 * (r.volume ?? 0)) / ct.volume, fmtPct((100 * (r.volume ?? 0)) / ct.volume, 1)) : "—"}</td>
                            <td className="num">{r.gsr ? slabFig(r, "gsr", r.gsr, fmtMoney(r.gsr)) : <span className="muted">—</span>}</td>
                            <td className="num edit-col">
                              {rateInput(r)}
                              {changed && <em className="muted was">was {fmtRate(r.cn_rate, r.formula, r.pack_size)}</em>}
                            </td>
                            <td className="num">{r.gsr ? slabFig(r, "cn_pct", (100 * cn) / r.gsr, pctOf(cn, r.gsr)) : "—"}</td>
                            <td className="num">{slabFig(r, "cn", cn, fmtMoney(cn))}</td>
                            {impactCell(cn - actualOf(r))}
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="comp-total">
                        <td>Total</td>
                        <td className="num">{fmtInr(ct.dealer_count)}</td>
                        <td className="num">{ct.volume ? fmtInr(Math.round(ct.volume)) : "—"}</td>
                        <td className="num">{ct.volume ? "100%" : "—"}</td>
                        <td className="num">{ct.gsr ? fmtMoney(ct.gsr) : "—"}</td>
                        <td className="num edit-col" />
                        <td className="num">{pctOf(ct.simulated_cn, ct.gsr)}</td>
                        <td className="num">{unit(ct.simulated_cn)}</td>
                        {impactCell(ct.delta_cn)}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              );
            }
            return (
              <div key={name} className="component" id={embedded ? undefined : `sd-comp-${scheme.key}::${name}`}>
                {head}
                <table>
                  <thead>
                    <tr>
                      <th><ColHead name={f.slab_mode === "target" ? "Rate tier (achievement range)" : "Slab"} /></th>
                      <th className="num"><ColHead name="Dealers" unit="count" /></th>
                      <th className="num"><ColHead name="Volume" unit="litres" /></th>
                      <th className="num" title="Slab volume ÷ the component's volume"><ColHead name="Product Mix" unit="%" /></th>
                      <th className="num"><ColHead name="GSR" unit="₹" /></th>
                      <th className="num"><ColHead name="Current rate" unit={rateUnit(f.formula, f.pack_size)} /></th>
                      <th className="num edit-col"><ColHead name="New rate" unit={rateUnit(f.formula, f.pack_size)} /></th>
                      {/* "Current CN" read as "what this BAND paid before the
                          edit", which is not what it is. It is what the dealers
                          NOW IN THIS BAND actually earn under today's rules --
                          so moving a boundary moves their earnings between rows
                          even though no dealer's payout has changed. That is
                          also the only basis on which the per-row impacts add up
                          to the real impact. */}
                      {/* A 0% band once displayed tens of thousands of rupees of payout here,
                          because the figure was the earnings of whoever now fell
                          inside it rather than anything the band did. With a
                          boundary moved there is no honest per-band "before" at
                          all, so none is shown. */}
                      <th className="num"
                          title="What the dealers now in this band were actually paid, under the live slab table. After a boundary move this is what they earned in whichever band they were in before — so a 0% band can still show a figure, because the money was earned elsewhere. The component total below is the figure that does not move.">
                        <ColHead name="Actual CN" unit="₹" />
                      </th>
                      <th className="num"
                          title="What this band pays under the slabs and rates as currently set. Moves when you change a rate, a boundary, or both.">
                        <ColHead name="Simulated CN" unit="₹" />
                      </th>
                      <th className="num" title="Simulated minus actual, for the dealers in this band.">
                        <ColHead name="Δ Impact" unit="₹" />
                      </th>
                      <th className="num" title="Simulated CN as a percentage of GSR — the effective payout rate">
                        <ColHead name="CN" unit="% of GSR" />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {compRows.map((r, ri) => {
                      const changed = r.simulated_rate !== r.cn_rate;
                      const pb = cmp?.of(ri);
                      const rowCn = r.simulated_cn ?? r.current_cn;
                      // Against the original table at this position, not against
                      // the re-bucketed "current" for these particular dealers.
                      const rowDelta = (r.simulated_cn ?? r.current_cn) - actualOf(r);
                      return (
                        <tr key={r.row_id} className={changed ? "edited" : ""}>
                          <td className="slab">{slabCell(r)}<SlabTag m={cmp} i={ri} /></td>
                          <td className="num">{dealersCell(r)}{wasSlab(pb, "dealers", r.dealer_count, fmtInr)}</td>
                          <td className="num">{r.volume ? slabFig(r, "volume", r.volume, fmtInr(r.volume)) : <span className="muted">—</span>}{wasSlab(pb, "volume", r.volume ?? 0, fmtInr)}</td>
                          <td className="num">{ct.volume ? slabFig(r, "mix", (100 * (r.volume ?? 0)) / ct.volume, fmtPct((100 * (r.volume ?? 0)) / ct.volume, 1)) : "—"}{ct.volume ? wasSlab(pb, "mix", (100 * (r.volume ?? 0)) / ct.volume, mixText) : null}</td>
                          <td className="num">{r.gsr ? slabFig(r, "gsr", r.gsr, fmtMoney(r.gsr)) : <span className="muted">—</span>}{wasSlab(pb, "gsr", r.gsr ?? 0, fmtMoney)}</td>
                          <td className="num muted">{fmtRate(r.cn_rate, r.formula, r.pack_size)}</td>
                          <td className="num edit-col">{rateInput(r)}</td>
                          {/* Both figures stay populated after a boundary move.
                              An earlier version blanked them, on the grounds that
                              a new band has no previous version of itself -- true,
                              but it threw away the per-slab detail that makes the
                              table worth reading. What it does mean is that this
                              column is the earnings of the dealers NOW in the
                              band, not something the band's own rate produced:
                              hence the name, and the tooltip on the header. */}
                          <td className="num"
                              title={slabsMoved
                                ? "What this slab position paid under the original table, before you moved anything."
                                : undefined}>
                            {fmtMoney(actualOf(r))}{wasSlab(pb, "cn", actualOf(r), fmtMoney)}
                          </td>
                          <td className="num">{slabFig(r, "cn", rowCn, fmtMoney(rowCn))}</td>
                          <td className={`num ${!isMoved(rowDelta) ? "muted" : cnClass(rowDelta)}`}>
                            {!isMoved(rowDelta) ? "—"
                              : `${rowDelta > 0 ? "+" : ""}${fmtMoney(rowDelta)}`}
                          </td>
                          <td className="num muted">
                            {r.gsr ? slabFig(r, "cn_pct", ((r.simulated_cn ?? r.current_cn) / r.gsr) * 100,
                                             fmtPct(((r.simulated_cn ?? r.current_cn) / r.gsr) * 100, 2)) : "—"}
                            {r.gsr ? wasSlab(pb, "cnPct", (100 * rowCn) / r.gsr, pctText) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {/* Totals. Moving a boundary shuffles dealers and their
                      earnings between rows, so a reader watching one row can
                      think money appeared or vanished. The component line shows
                      it did neither: "CN today" is identical whatever the
                      boundaries are, because it is the same dealers either way. */}
                  <tfoot>
                    <tr className="comp-total">
                      <td>Component total</td>
                      <td className="num">{fmtInr(ct.dealer_count)}{wasSlab(prevTotal, "dealers", ct.dealer_count, fmtInr)}</td>
                      <td className="num">{ct.volume ? fmtInr(Math.round(ct.volume)) : "—"}{wasSlab(prevTotal, "volume", ct.volume, fmtInr)}</td>
                      <td className="num">{ct.volume ? "100%" : "—"}</td>
                      <td className="num">{ct.gsr ? fmtMoney(ct.gsr) : "—"}{wasSlab(prevTotal, "gsr", ct.gsr, fmtMoney)}</td>
                      <td className="num" />
                      <td className="num edit-col" />
                      <td className="num"
                          title="Actually paid. The same dealers whatever the boundaries are, so this figure does not move when you drag one.">
                        {unit(ct.current_cn)}{wasSlab(prevTotal, "cn", ct.current_cn, fmtMoney)}
                      </td>
                      <td className="num">{unit(ct.simulated_cn)}</td>
                      <td className={`num ${!isMoved(ct.delta_cn) ? "muted" : cnClass(ct.delta_cn)}`}>
                        {!isMoved(ct.delta_cn) ? "—"
                          : `${ct.delta_cn > 0 ? "+" : ""}${unit(ct.delta_cn)}`}
                      </td>
                      <td className="num muted">
                        {ct.gsr ? fmtPct((ct.simulated_cn / ct.gsr) * 100, 2) : "—"}
                        {ct.gsr ? wasSlab(prevTotal, "cnPct", (100 * ct.simulated_cn) / ct.gsr, pctText) : null}
                      </td>
                    </tr>
                  </tfoot>
                </table>
                {cmp && cmpBase && <GoneSlabs rows={cmp.gone} month={cmpBase.label} money={fmtMoney} />}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
