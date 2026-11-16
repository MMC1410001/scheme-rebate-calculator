import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Adjustment, MonthSlabRow, SlabLayout, SlabRow } from "../api/client";
import { api, errorText, isAbort } from "../api/client";
import { withSimulatedRate } from "../api/computeImpact";
import type { NextSlabEdit } from "../components/MonthsView";
import type { SlabField } from "../slabChange";
import { sameEdge, withEdgeMoved, withSlabAdded, withSlabRemoved } from "../slabLayout";
import type { RowsByScheme, ScopeSel } from "./constants";
import { asSlabRow, bandsOfRow, sameKey, slabTag, stackedPct } from "./edits";

type Set_<T> = Dispatch<SetStateAction<T>>;

interface SlabEditState {
  scope: ScopeSel;
  rowsByScheme: RowsByScheme;
  setRowsByScheme: Set_<RowsByScheme>;
  adjustments: Adjustment[];
  setAdjustments: Set_<Adjustment[]>;
  nextAdjustments: Adjustment[];
  setNextAdjustments: Set_<Adjustment[]>;
  /** The current month's edits as of the latest render (a debounced slab re-run reads them when it fires). */
  adjRef: MutableRefObject<Adjustment[]>;
  movedSlabs: Set<string>;
  setMovedSlabs: Set_<Set<string>>;
  slabLayouts: Record<string, SlabLayout>;
  setSlabLayouts: Set_<Record<string, SlabLayout>>;
  nextLayouts: Record<string, SlabLayout>;
  setNextLayouts: Set_<Record<string, SlabLayout>>;
  /** Next month's slab tables: the current month's, with next month's own on top (what the Next column shows). */
  nextPlanLayouts: Record<string, SlabLayout>;
  growth: number;
  setError: (text: string | null) => void;
  /** The component's slab table as it stands, including rate edits, ready to send (slabLayout.layoutFromRows). */
  layoutOf: (schemeKey: string, component: string) => SlabLayout;
  componentRows: (schemeKey: string, component: string) => SlabRow[];
  slabsAllowed: (schemeKey: string, component: string) => boolean;
}

/** Every edit of a slab table: the current month's rates, boundaries (+ / ×) and slab figures (Volume, GSR, Mix,
 *  CN %, CN), and next month's own tables (user's choice, 3 Nov 2026). Moving a boundary re-buckets dealers, which
 *  only the server can do (it needs dealer-level rows), so that is debounced per component. */
export function useSlabEdits(s: SlabEditState) {
  const { scope: { zone, region, depot }, rowsByScheme, setRowsByScheme, adjustments, setAdjustments,
          nextAdjustments, setNextAdjustments, adjRef, movedSlabs, setMovedSlabs, slabLayouts, setSlabLayouts,
          nextLayouts, setNextLayouts, nextPlanLayouts, growth, setError, layoutOf, componentRows, slabsAllowed } = s;
  const slabTimers = useRef<Record<string, number>>({});
  /** The re-bucketing request in flight per component: a newer edit, a Reset or a new scope cancels it, so a late
   *  answer can never put back rows the user has since replaced. */
  const slabRuns = useRef<Record<string, AbortController>>({});

  /** Cancel the pending and in-flight re-bucketing of every component (or those of one scheme). */
  const cancelSlabRuns = (schemeKey?: string) => {
    const mine = (k: string) => !schemeKey || k.startsWith(`${schemeKey}::`);
    for (const k of Object.keys(slabTimers.current)) {
      if (mine(k)) { window.clearTimeout(slabTimers.current[k]); delete slabTimers.current[k]; }
    }
    for (const k of Object.keys(slabRuns.current)) {
      if (mine(k)) { slabRuns.current[k].abort(); delete slabRuns.current[k]; }
    }
  };
  // A new scope fetches every table again (with the slab edits carried): an answer for the old scope is stale.
  const scopeKey = [zone, region, depot].map((v) => v.join("|")).join("/");
  useEffect(() => () => cancelSlabRuns(), [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const editRate = (schemeKey: string, rowId: string, rate: number) =>
    setRowsByScheme((prev) => ({
      ...prev,
      [schemeKey]: prev[schemeKey].map((r) => (r.row_id === rowId ? withSimulatedRate(r, rate) : r)),
    }));

  const pushSlabModel = (schemeKey: string, component: string, layout: SlabLayout, immediate = false) => {
    const key = `${schemeKey}::${component}`;
    setMovedSlabs((prev) => new Set(prev).add(key));
    setSlabLayouts((prev) => ({ ...prev, [key]: layout }));
    window.clearTimeout(slabTimers.current[key]);
    slabRuns.current[key]?.abort();
    const run = () => {
      delete slabTimers.current[key];
      const ctrl = new AbortController();
      slabRuns.current[key] = ctrl;
      return api
        .simulateSlabs({
          scheme: schemeKey,
          component,
          zone: zone || undefined,
          region: region || undefined,
          depot_code: depot || undefined,
          ...layout,
          adjustments: adjRef.current,
        }, ctrl.signal)
        .then((res) => {
          if (ctrl.signal.aborted || slabRuns.current[key] !== ctrl) return;   // replaced, reset or a new scope
          delete slabRuns.current[key];
          setRowsByScheme((prev) => ({
            ...prev,
            [schemeKey]: [
              ...(prev[schemeKey] ?? []).filter((r) => r.component !== component),
              // Tagged so a later rate edit on these rows uses cn_units rather than scaling from current_cn --
              // after a re-bucket that figure belongs to dealers who earned it in a different band.
              ...res.rows.map((r) => ({ ...r, rebucketed: true })),
            ],
          }));
        })
        .catch((e) => {
          if (isAbort(e) || ctrl.signal.aborted || slabRuns.current[key] !== ctrl) return;
          delete slabRuns.current[key];
          setError(errorText(e));
        });
    };
    if (immediate) void run();
    else slabTimers.current[key] = window.setTimeout(run, 600);
  };

  /** Move one boundary. Edges are found by value: the same edge is the end of one band and the start of the next. */
  const editSlabEdge = (schemeKey: string, component: string, from: number, value: number) => {
    const layout = withEdgeMoved(layoutOf(schemeKey, component), from, value);
    if (!layout) return;
    // reflect the typed value at once; the server reply then replaces the component
    setRowsByScheme((prev) => ({
      ...prev,
      [schemeKey]: prev[schemeKey].map((r) =>
        r.component !== component || r.slab_mode !== "slab"
          ? r
          : sameEdge(r.slab_lower, from)
            ? { ...r, slab_lower: value }
            : r.slab_upper != null && sameEdge(r.slab_upper, from)
              ? { ...r, slab_upper: value }
              : r
      ),
    }));
    pushSlabModel(schemeKey, component, layout);
  };

  /** Split a band in two at its middle (slabLayout.withSlabAdded). */
  const addSlab = (schemeKey: string, component: string, row: SlabRow) => {
    const layout = withSlabAdded(layoutOf(schemeKey, component), row, componentRows(schemeKey, component));
    if (layout) pushSlabModel(schemeKey, component, layout, true);
  };

  /** Remove a slab: its dealers drop to the slab below (slabLayout.withSlabRemoved; user's choice, 30 Oct 2026). */
  const removeSlab = (schemeKey: string, component: string, row: SlabRow) => {
    const layout = withSlabRemoved(layoutOf(schemeKey, component), row, componentRows(schemeKey, component));
    if (layout) pushSlabModel(schemeKey, component, layout, true);
  };

  /** A slab row's Volume / GSR edit, found by its tag (edits.slabTag). */
  const slabEdit = (schemeKey: string, r: SlabRow, metric: "volume" | "gsr", list: Adjustment[] = adjustments) =>
    list.find((a) => a.scope_kind === "dealer" && a.mode === "S" && a.product === schemeKey
                            && a.metric === metric && a.reason === slabTag(r));
  /** Whether a slab row's Volume, GSR or Mix carries an edit (the current month). */
  const slabEdited = (schemeKey: string, row: SlabRow, field: "volume" | "gsr" | "mix") =>
    field === "mix" ? adjustments.some((a) => a.reason === `mix|${slabTag(row)}`) : Boolean(slabEdit(schemeKey, row, field));

  /** Every dealer code of a slab row (or, with whole, of its component), in the filters now on. */
  const codesOf = async (schemeKey: string, r: SlabRow, whole = false, period: "current" | "next" = "current") => {
    const key = `${schemeKey}::${r.component}`;
    const res = await api.dealerCodes({
      scheme: schemeKey, component: r.component,
      row: { slab_mode: r.slab_mode, slab_lower: r.slab_lower, slab_upper: r.slab_upper, cn_rate: r.cn_rate,
             slab_index: r.slab_index },
      // Next month: its own table, else the current month's (as the Next column shows).
      layout: period === "next" ? nextPlanLayouts[key] : movedSlabs.has(key) ? slabLayouts[key] : undefined,
      zone, region, depot_code: depot, month: period, adjustments, whole_component: whole,
      ...(period === "next" ? { volume_growth_pct: growth, next_adjustments: nextAdjustments } : {}),
    });
    return res.codes;
  };

  /** A slab's Volume or GSR: a scheme edit (mode S) on the slab's dealers, found once and kept in the edit. */
  const editSlabSales = async (schemeKey: string, r: SlabRow, field: "volume" | "gsr", from: number, to: number,
                               period: "current" | "next" = "current") => {
    const old = slabEdit(schemeKey, r, field, period === "next" ? nextAdjustments : adjustments);
    let scopeValue = old?.scope_value;
    if (!scopeValue) {
      try {
        const codes = await codesOf(schemeKey, r, false, period);
        if (!codes.length) { setError("No dealer in this slab."); return; }
        scopeValue = codes.join("|");
      } catch (e) { setError(errorText(e)); return; }
    }
    const value = stackedPct(from, to, old);
    const draft: Adjustment = { scope_kind: "dealer", scope_value: scopeValue, product: schemeKey, metric: field,
                                mode: "S", adjust_type: "pct", value, reason: slabTag(r) };
    (period === "next" ? setNextAdjustments : setAdjustments)((prev) =>
      [...prev.filter((a) => !sameKey(a, draft)), ...(Math.abs(value) < 1e-6 ? [] : [draft])]);
  };

  /** A slab's Product Mix typed over, the component's total held (user's choice, 3 Nov 2026): the slab's dealers
   *  sell more (or less) until the slab has the typed share of the component's volume, and every other dealer of
   *  the component gives up (or gains) the same litres in proportion. Two scheme edits on those dealers. */
  const editSlabMix = async (schemeKey: string, r: SlabRow, total: number, toPct: number,
                             period: "current" | "next" = "current") => {
    const list = period === "next" ? nextAdjustments : adjustments;
    const v = r.volume ?? 0, t = toPct / 100;
    if (!(t > 0 && t < 1)) { setError("A slab's mix is its share of the component's volume, between 0 and 100%."); return; }
    if (!(v > 0) || !(total > v)) { setError("This slab holds all (or none) of the component's volume; its mix cannot move."); return; }
    const tagA = `mix|${slabTag(r)}`, tagB = `mixrest|${slabTag(r)}`;
    let oldA = list.find((a) => a.reason === tagA);
    let oldB = list.find((a) => a.reason === tagB);
    let slabCodes = oldA?.scope_value, restCodes = oldB?.scope_value;
    try {
      if (!slabCodes || !restCodes) {
        const own = await codesOf(schemeKey, r, false, period);
        const mine = new Set(own);
        const rest = (await codesOf(schemeKey, r, true, period)).filter((c) => !mine.has(c));
        if (!own.length) { setError("No dealer in this slab."); return; }
        if (!rest.length) { setError("No other dealer in this component to move sales from."); return; }
        slabCodes = own.join("|");
        restCodes = rest.join("|");
      }
    } catch (e) { setError(errorText(e)); return; }
    const base = { scope_kind: "dealer" as const, product: schemeKey, metric: "volume" as const, mode: "S" as const,
                   adjust_type: "pct" as const };
    // An edit on the very same dealers (a Volume edit of this slab) is the same key: combine with it.
    oldA = oldA ?? list.find((a) => sameKey(a, { ...base, scope_value: slabCodes!, value: 0 }));
    oldB = oldB ?? list.find((a) => sameKey(a, { ...base, scope_value: restCodes!, value: 0 }));
    const step = (old: Adjustment | undefined, f: number) =>
      Math.round(((1 + (old?.value ?? 0) / 100) * f - 1) * 100 * 1e6) / 1e6;
    const a: Adjustment = { ...base, scope_value: slabCodes!, value: step(oldA, (t * total) / v), reason: oldA?.reason ?? tagA };
    const b: Adjustment = { ...base, scope_value: restCodes!, value: step(oldB, ((1 - t) * total) / (total - v)),
                            reason: oldB?.reason ?? tagB };
    (period === "next" ? setNextAdjustments : setAdjustments)((prev) =>
      [...prev.filter((x) => !sameKey(x, a) && !sameKey(x, b)), ...[a, b].filter((x) => Math.abs(x.value) >= 1e-6)]);
  };

  /** A slab's Volume, GSR or CN typed over (Current month, user's request 3 Nov 2026).
   *  CN: the slab's rate scales so it pays the typed figure (a rate edit, as typing the rate).
   *  Volume / GSR: the sales in this scheme of the dealers in the slab move (mode S on those dealers), so dealers
   *  may cross into another slab and CN follows.
   *  Returns a sentence when the figure is refused (shown under the cell); dealer look-ups that fail later go to the
   *  error line, since the box has closed by then. */
  const editSlab = (schemeKey: string, r: SlabRow, field: SlabField, from: number, to: number,
                    compVolume = 0, choice?: string): string | void => {
    if (!(from > 0)) return "Only a positive figure can be changed by a %; this one is zero or negative.";
    if (to < 0) return "A volume, GSR, mix, CN % or CN cannot be negative.";
    setError(null);
    if (field === "mix" && choice === "grow") {
      // "Volume grows": the slab's own volume that gives it the typed share, the other slabs unchanged.
      const t = to / 100, v = r.volume ?? 0;
      if (!(t > 0 && t < 1) || !(compVolume > v)) return "A slab's mix is its share of the component's volume, between 0 and 100%.";
      return editSlab(schemeKey, r, "volume", v, (t * (compVolume - v)) / (1 - t));
    }
    if (field === "mix") {
      const v = r.volume ?? 0, t = to / 100;
      if (!(t > 0 && t < 1)) return "A slab's mix is its share of the component's volume, between 0 and 100%.";
      if (!(v > 0) || !(compVolume > v)) return "This slab holds all (or none) of the component's volume; its mix cannot move.";
      void editSlabMix(schemeKey, r, compVolume, to);
      return;
    }
    // CN % of GSR: the CN that share of the slab's GSR is, so the same rate edit as typing the CN.
    if (field === "cn_pct") { from = (from / 100) * r.gsr; to = (to / 100) * r.gsr; field = "cn"; }
    if (field === "cn") {
      const rate = r.simulated_rate ?? r.cn_rate;
      if (!(rate > 0)) return "This slab pays no rate; type a rate instead.";
      editRate(schemeKey, r.row_id, Math.round(rate * (to / from) * 1e6) / 1e6);
      return;
    }
    void editSlabSales(schemeKey, r, field, from, to);
  };

  // ---- Next month's own slab tables (user's choice, 3 Nov 2026) ----------------------------------------------------
  // Edited in the Next column, next month only. The first edit copies the current month's table (with its edits);
  // later edits change that copy. Rate edits live in the table itself (band + the dealers' own rate -> new rate).
  const nextLayoutOf = (schemeKey: string, component: string): SlabLayout | null => {
    const own = nextLayouts[`${schemeKey}::${component}`];
    if (own) return structuredClone(own);
    if (!(rowsByScheme[schemeKey] ?? []).some((r) => r.component === component) || !slabsAllowed(schemeKey, component)) return null;
    return structuredClone(layoutOf(schemeKey, component));
  };
  const putNext = (schemeKey: string, component: string, layout: SlabLayout) =>
    setNextLayouts((prev) => ({ ...prev, [`${schemeKey}::${component}`]: layout }));
  /** Next month's own table dropped: the component follows the current month's again. */
  const dropNext = (key: string) => setNextLayouts((prev) => { const n = { ...prev }; delete n[key]; return n; });
  const setNextRate = (schemeKey: string, r: MonthSlabRow, rate: number) => {
    const layout = nextLayoutOf(schemeKey, r.component);
    if (!layout) return;
    const bands = bandsOfRow(layout, r);
    if (layout.rates) {
      for (const b of bands) if (b < layout.rates.length) layout.rates[b] = rate;
    } else {
      const same = (o: { band: number; rate: number }) => bands.includes(o.band) && Math.abs(o.rate - r.cn_rate) < 1e-9;
      layout.rate_overrides = [
        ...(layout.rate_overrides ?? []).filter((o) => !same(o)),
        ...(Math.abs(rate - r.cn_rate) < 1e-9 ? [] : bands.map((band) => ({ band, rate: r.cn_rate, new_rate: rate }))),
      ];
    }
    putNext(schemeKey, r.component, layout);
  };
  const editNextEdge = (schemeKey: string, component: string, from: number, value: number) => {
    const own = nextLayoutOf(schemeKey, component);
    const layout = own && withEdgeMoved(own, from, value);
    if (layout) putNext(schemeKey, component, layout);
  };
  /** As addSlab, on next month's table: the band split at its middle (on per-dealer targets, the first boundary). */
  const addNextSlab = (schemeKey: string, r: MonthSlabRow, rows: MonthSlabRow[]) => {
    const own = nextLayoutOf(schemeKey, r.component);
    const layout = own && withSlabAdded(own, asSlabRow(r), rows.map(asSlabRow));
    if (layout) putNext(schemeKey, r.component, layout);
  };
  /** As removeSlab, on next month's table: the slab's dealers drop to the slab below (the first slab pays 0). */
  const removeNextSlab = (schemeKey: string, r: MonthSlabRow, rows: MonthSlabRow[]) => {
    const own = nextLayoutOf(schemeKey, r.component);
    const layout = own && withSlabRemoved(own, asSlabRow(r), rows.map(asSlabRow));
    if (layout) putNext(schemeKey, r.component, layout);
  };
  /** A next-month slab row's figure typed over, as editSlab does for the current month (next month's edits). */
  const editNextFig = (schemeKey: string, r: MonthSlabRow, field: SlabField, from: number, to: number,
                       compVolume = 0, choice?: string): string | void => {
    if (!(from > 0)) return "Only a positive figure can be changed by a %; this one is zero or negative.";
    if (to < 0) return "A volume, GSR, mix, CN % or CN cannot be negative.";
    setError(null);
    if (field === "mix" && choice === "grow") {
      const t = to / 100, v = r.volume ?? 0;
      if (!(t > 0 && t < 1) || !(compVolume > v)) return "A slab's mix is its share of the component's volume, between 0 and 100%.";
      return editNextFig(schemeKey, r, "volume", v, (t * (compVolume - v)) / (1 - t));
    }
    if (field === "mix") {
      const v = r.volume ?? 0, t = to / 100;
      if (!(t > 0 && t < 1)) return "A slab's mix is its share of the component's volume, between 0 and 100%.";
      if (!(v > 0) || !(compVolume > v)) return "This slab holds all (or none) of the component's volume; its mix cannot move.";
      void editSlabMix(schemeKey, asSlabRow(r), compVolume, to, "next");
      return;
    }
    if (field === "cn_pct") { from = (from / 100) * r.gsr; to = (to / 100) * r.gsr; field = "cn"; }
    if (field === "cn") {
      if (!(r.rate > 0)) return "This slab pays no rate; type a rate instead.";
      setNextRate(schemeKey, r, Math.round(r.rate * (to / from) * 1e6) / 1e6);
      return;
    }
    void editSlabSales(schemeKey, asSlabRow(r), field, from, to, "next");
  };
  /** The Next column's editing of one component, or nothing where it cannot be edited (not run this month, or a
   *  bookkeeping component). */
  const nextEditOf = (schemeKey: string, component: string): NextSlabEdit | undefined => {
    if (!(rowsByScheme[schemeKey] ?? []).some((r) => r.component === component) || !slabsAllowed(schemeKey, component)) return undefined;
    const key = `${schemeKey}::${component}`;
    return {
      own: key in nextLayouts,
      onUseCurrent: () => dropNext(key),
      onRate: (r, rate) => setNextRate(schemeKey, r, rate),
      onFig: (r, field, from, to, compVolume, choice) => editNextFig(schemeKey, r, field, from, to, compVolume, choice),
      figEdited: (r, field) => field === "cn" || field === "cn_pct" ? r.rate !== r.cn_rate
        : field === "mix" ? nextAdjustments.some((a) => a.reason === `mix|${slabTag(asSlabRow(r))}`)
          : Boolean(slabEdit(schemeKey, asSlabRow(r), field, nextAdjustments)),
      onEdge: (from, value) => editNextEdge(schemeKey, component, from, value),
      onAdd: (r, rows) => addNextSlab(schemeKey, r, rows),
      onRemove: (r, rows) => removeNextSlab(schemeKey, r, rows),
    };
  };

  return { editRate, editSlabEdge, addSlab, removeSlab, editSlab, slabEdited, nextEditOf, dropNext, cancelSlabRuns };
}
