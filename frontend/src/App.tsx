import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import type { Adjustment, GiftEdit, MonthBlock, SlabLayout, SlabRow } from "./api/client";
import { api, errorText, setOpenedVersion } from "./api/client";
import { fmtRate, resetRow } from "./api/computeImpact";
import { RemovedSchemesNotice, EditedOnlyButton, SettledNote, SimViewSwitch, SortSelect } from "./components/SimulatorTools";
import { asTab, type RowsByScheme, type SortKey, type TabKey } from "./app/constants";
import { scopeLabelOf, toggled, without } from "./app/edits";
import {
  editedCountOf, editedSchemesOf, editKeyOf, grandOf, kpiOf, planLayoutsOf, rateMultipliersOf, schemeStatsOf,
  simRowsOf, singleCardIn, slabsAllowedIn, visibleSchemesOf,
} from "./app/stats";
import { useCellEdits } from "./app/useCellEdits";
import { useDetailNav } from "./app/useDetailNav";
import { useExport } from "./app/useExport";
import { useScopeData, type OnServed } from "./app/useScopeData";
import { useSlabEdits } from "./app/useSlabEdits";
import { UserBadge } from "./auth";
import { canEditOf, useUser } from "./userContext";
import { FilterBar, MainTabs, Readout, ThemeToggle, TitleBlock, type ReadoutPrev } from "./components/CommandBar";
import { monthName, schemeRowOf } from "./components/monthData";
import { DealerList, type DealerListTarget } from "./components/DealerList";
import { EditsPanel } from "./components/EditsPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ErrorBanner } from "./components/Feedback";
import { GiftSchemes } from "./components/GiftDetail";
import { GiftsView } from "./components/GiftsView";
import { MonthsView } from "./components/MonthsView";
import { OverviewTab } from "./components/OverviewTab";
import { SchemeCard } from "./components/SchemeCard";
import { SchemeDetailView } from "./components/SchemeDetailView";
import { StartingUp } from "./components/StartingUp";
import { TargetPlanner } from "./components/TargetPlanner";
import { TrendView } from "./components/TrendView";
import { SaveVersion, VersionsView, type OpenVersion } from "./components/VersionsView";
import { useConfirm, useToast } from "./hooks/useFeedback";
import { useRipple } from "./hooks/useMotion";
import { useCmdbarHeight } from "./hooks/useScrollTarget";
import { readUrl, useUrlSync } from "./hooks/useUrlState";
import { layoutFromRows } from "./slabLayout";
import "./App.css";

/** The main screen: one command bar (title, tabs, filters, live readout) and four tabs (Overview, Plan, Simulator,
 *  Versions). This component holds the user's edits -- they live in this browser only, above every tab, so changing
 *  the tab or the filters keeps them -- and wires them to the parts in src/app (loading, edits, navigation) and
 *  src/components (what each tab draws). */
export default function App() {
  const [showToast, toastNode] = useToast();
  const [confirm, confirmNode] = useConfirm();
  // The tab and the filters start from the address bar (a refresh or a shared link keeps the view; useUrlSync).
  const [initialUrl] = useState(readUrl);
  const [zone, setZone] = useState<string[]>(initialUrl.zone);
  const [region, setRegion] = useState<string[]>(initialUrl.region);
  const [depot, setDepot] = useState<string[]>(initialUrl.depot);
  const scope = { zone, region, depot };

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Bumped to scroll to scrollTarget even when the view did not change. */
  const [scrollTick, setScrollTick] = useState(0);
  const [sortBy, setSortBy] = useState<SortKey>("payout");
  const [editedOnly, setEditedOnly] = useState(false);
  /** "scheme::component" for every component whose boundaries the user moved. Used to explain that per-row CN moved
      because DEALERS moved, not because anyone's payout changed. */
  const [movedSlabs, setMovedSlabs] = useState<Set<string>>(new Set());
  /** The slab table last sent for each "scheme::component" whose boundaries were moved. The next edit and the
      dealer list start from it. Cleared whenever the server's own tables come back (scope change, reset). */
  const [slabLayouts, setSlabLayouts] = useState<Record<string, SlabLayout>>({});
  /** Schemes the user deleted in the Simulator: hidden there, paying nothing in the current and next month. Their
      edits are kept, so Restore brings a scheme back as it was. */
  const [removedSchemes, setRemovedSchemes] = useState<Set<string>>(new Set());
  /** Next month's own slab tables (user's choice, 3 Nov 2026): "scheme::component" -> the table edited in the Next
      column. It starts as the current month's table and then changes next month only; components without one
      follow the current month's table. Portable like every layout, so it is kept when the filters change. */
  const [nextLayouts, setNextLayouts] = useState<Record<string, SlabLayout>>({});
  /** The slab row whose dealers are listed, if any. */
  const [dealerView, setDealerView] = useState<DealerListTarget | null>(null);
  const [query, setQuery] = useState("");
  const [onlyVerified, setOnlyVerified] = useState(false);
  // A document-level click ripple, mounted once. Delegated rather than per-element so adding 35 scheme rows costs
  // nothing.
  useRipple();

  const [tab, setTab] = useState<TabKey>(() => asTab(initialUrl.tab));
  useUrlSync({ tab, zone, region, depot }, "overview", (u) => {
    setTab(asTab(u.tab));
    setZone(u.zone); setRegion(u.region); setDepot(u.depot);
  });
  /** V on the month table: next month's volume change. */
  const [growth, setGrowth] = useState(0);
  /** GSR / volume edits typed into the month table: the current month's (carried into next) and next month's own.
   *  They live here, not in the scope: an edit made through one region's filters shows in All India too. */
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [nextAdjustments, setNextAdjustments] = useState<Adjustment[]>([]);
  const adjRef = useRef<Adjustment[]>([]);
  adjRef.current = adjustments;
  /** The saved version being changed, if one was opened in the Simulator. */
  const [openVersion, setOpenVersion] = useState<{ id: number; name: string; note: string | null } | null>(null);
  /** editKey when the opened version was last saved or loaded. */
  const [savedKey, setSavedKey] = useState<string | null>(null);
  /** Set when a version is opened: its key is taken once its rows have loaded. */
  const markOnLoad = useRef(false);
  /** The month Scheme detail shows (kept across visits to Overall Schemes). */
  const [detailMonth, setDetailMonth] = useState<"prev" | "cur" | "next">("cur");
  /** Products opened by hand in Overall Schemes, kept here so they stay open across a visit to Scheme detail. */
  const [openProducts, setOpenProducts] = useState<Set<string>>(new Set());
  /** Gift schemes' what-if edits (Scheme detail): this browser only, outside CN, not saved in a version. */
  const [giftEdits, setGiftEdits] = useState<Record<string, GiftEdit>>({});
  // Which scheme the user clicked into on a chart.
  const [drill, setDrill] = useState<string | null>(null);

  const nav = useDetailNav(tab, scrollTick);
  useCmdbarHeight();

  // ---- The scope's slab tables (app/useScopeData.ts) ------------------------------------------------------------
  /** A version opened while filters were on: applied once All India has loaded. */
  const pendingOpen = useRef<OpenVersion | null>(null);
  /** The slab tables of every edited component, refreshed each render, to carry them into the next scope. */
  const carryLayouts = useRef<Record<string, SlabLayout>>({});
  const firstScope = useRef(true);
  const onServed: OnServed = (next, mine, signal) => {
    if (pendingOpen.current) {
      const open = pendingOpen.current;
      pendingOpen.current = null;
      applyOpen(open);
      return refreshRows(open.adjustments, open.layouts, next, mine, signal);
    }
    // Slab and rate edits are kept across a change of filters (user's choice, 3 Nov 2026), as a saved version
    // carries them: each is a slab table (national boundaries, each band's source band, rate edits as
    // band + old rate -> new rate), so it applies in any scope. Deleted schemes stay deleted.
    const carried = carryLayouts.current;
    const kept = Object.keys(carried).length;
    setSlabLayouts(carried);
    setMovedSlabs(new Set(Object.keys(carried)));
    if (kept && !firstScope.current) {
      showToast({ text: `${kept} slab or rate ${kept === 1 ? "edit was" : "edits were"} kept for the new filters. `
                        + "A rate edit applies to every dealer in that slab earning the same rate." });
    }
    firstScope.current = false;
    if (adjRef.current.length || kept) return refreshRows(adjRef.current, carried, next, mine, signal);
    setRowsByScheme(next);
  };
  const {
    filters, products, canSave, data, setData, rowsByScheme, setRowsByScheme, baseline, setBaseline,
    loading, error, setError, startingUp, retry, isLatest, track, refreshRows,
  } = useScopeData(scope, onServed);

  // ---- Slab tables as edited ---------------------------------------------------------------------------------------
  const componentRows = (schemeKey: string, component: string) =>
    (rowsByScheme[schemeKey] ?? []).filter((r) => r.component === component);
  /** The component's slab table as it stands, including rate edits, ready to send (slabLayout.ts). */
  const layoutOf = (schemeKey: string, component: string): SlabLayout =>
    layoutFromRows(componentRows(schemeKey, component), slabLayouts[`${schemeKey}::${component}`]);
  const slabsAllowed = (schemeKey: string, component: string) => slabsAllowedIn(rowsByScheme[schemeKey] ?? [], component);
  const singleCard = (schemeKey: string, component: string) => singleCardIn(rowsByScheme[schemeKey] ?? [], component);

  const simRows = useMemo(() => simRowsOf(rowsByScheme, removedSchemes), [rowsByScheme, removedSchemes]);
  const planLayouts = planLayoutsOf(rowsByScheme, movedSlabs, slabsAllowed, layoutOf);
  carryLayouts.current = planLayouts;
  /** Next month's slab tables: the current month's, with next month's own on top (what the Next column shows). */
  const nextPlanLayouts: Record<string, SlabLayout> = { ...planLayouts, ...nextLayouts };
  const editKey = editKeyOf(adjustments, nextAdjustments, removedSchemes, growth, planLayouts, nextLayouts);
  useEffect(() => {
    if (loading || pendingOpen.current || !markOnLoad.current) return;
    markOnLoad.current = false;
    setSavedKey(editKey);
  }, [loading, editKey]);

  // GSR / volume edits changed: the current month's slab tables are re-priced, keeping every slab and rate edit.
  const adjKey = JSON.stringify(adjustments);
  const firstAdj = useRef(true);
  const skipAdj = useRef(false);
  useEffect(() => {
    if (firstAdj.current) { firstAdj.current = false; return; }
    if (skipAdj.current) { skipAdj.current = false; return; }
    if (!data) return;
    const t = window.setTimeout(() => {
      void track((mine, signal) => refreshRows(adjustments, planLayouts, baseline, mine, signal));
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjKey]);

  const { editCell, isEdited } = useCellEdits({ scope, adjustments, setAdjustments, nextAdjustments,
                                               setNextAdjustments, setError });
  const slab = useSlabEdits({
    scope, rowsByScheme, setRowsByScheme, adjustments, setAdjustments, nextAdjustments, setNextAdjustments, adjRef,
    movedSlabs, setMovedSlabs, slabLayouts, setSlabLayouts, nextLayouts, setNextLayouts, nextPlanLayouts, growth,
    setError, layoutOf, componentRows, slabsAllowed,
  });

  // ---- Opening a version, Reset and Undo -----------------------------------------------------------------------------
  /** A saved version's slab edits, deleted schemes, edits and V, set on the Simulator. */
  const applyOpen = (o: OpenVersion) => {
    setSlabLayouts(o.layouts);
    setMovedSlabs(new Set(Object.keys(o.layouts)));
    setNextLayouts(o.next_layouts ?? {});
    setRemovedSchemes(new Set(o.removed_schemes));
  };
  /** Open a saved version in the Simulator, at All India (its slab edits belong to no one scope). */
  const openInSimulator = async (o: OpenVersion) => {
    const filtered = zone.length || region.length || depot.length;
    if (editedCount > 0 && !(await confirm({
      title: `Open "${o.name}"?`,
      body: <p>Your {editedCount === 1 ? "edit" : `${editedCount} edits`} in the Simulator will be replaced by this version
              {filtered ? ", and the filters go back to All India" : ""}. Save them first
              if you want to keep them.</p>,
      confirmLabel: "Open version", danger: true,
    }))) return;
    if (filtered) showToast({ text: `Opened "${o.name}" at All India: its slab edits belong to no one region.` });
    markOnLoad.current = true;
    setSavedKey(null);
    if (JSON.stringify(o.adjustments) !== JSON.stringify(adjustments)) skipAdj.current = true;
    adjRef.current = o.adjustments;
    setAdjustments(o.adjustments);
    setNextAdjustments(o.next_adjustments);
    setGrowth(o.volume_growth_pct);
    // Saved over only by whoever may change it; anyone may still calculate its own edits (X-Version-Id).
    setOpenVersion(o.editable && o.canChange !== false ? { id: o.id, name: o.name, note: o.note } : null);
    setOpenedVersion(o.id);
    setTab("simulator");
    nav.setSimView("months");
    if (filtered) {
      pendingOpen.current = o;
      setZone([]); setRegion([]); setDepot([]);
      return;
    }
    applyOpen(o);
    void track((mine, signal) => refreshRows(o.adjustments, o.layouts, baseline, mine, signal));
  };

  /** Everything the user has edited, to put back with Undo. */
  type EditSnapshot = { adjustments: Adjustment[]; next: Adjustment[]; layouts: Record<string, SlabLayout>;
                        nextLayouts: Record<string, SlabLayout>;
                        removed: string[]; growth: number; gifts: Record<string, GiftEdit>; opened: typeof openVersion };
  const snapshot = (): EditSnapshot => ({ adjustments, next: nextAdjustments, layouts: planLayouts, nextLayouts,
                                          removed: [...removedSchemes], growth, gifts: giftEdits, opened: openVersion });
  /** Undo of Reset all: the edits as they were, in the filters now on (slab tables are scope-free, see carryLayouts). */
  const restoreEdits = (snap: EditSnapshot) => {
    if (JSON.stringify(snap.adjustments) !== JSON.stringify(adjustments)) skipAdj.current = true;
    adjRef.current = snap.adjustments;
    setAdjustments(snap.adjustments);
    setNextAdjustments(snap.next);
    setGrowth(snap.growth);
    setGiftEdits(snap.gifts);
    setOpenVersion(snap.opened);
    applyOpen({ layouts: snap.layouts, next_layouts: snap.nextLayouts, removed_schemes: snap.removed } as OpenVersion);
    void track((mine, signal) => refreshRows(snap.adjustments, snap.layouts, baseline, mine, signal));
  };

  // Reset has to go back to the SERVER, not just undo rates locally. Rate edits live in the browser, so clearing them
  // is local. Slab boundaries do not: moving one re-buckets dealers server-side and the response replaces the
  // component's rows entirely, original edges included. Resetting locally therefore restored every rate and left the
  // boundaries where they had been dragged -- a "reset" that silently kept half the edit.
  const scopeArgs = () => ({ zone, region, depot_code: depot });

  /** A scheme's own figure edits (its Volume / GSR / CN typed over), which its Reset clears with the slab edits. */
  const ownBy = (schemeKey: string) => (a: Adjustment) => (a.mode === "S" || a.mode === "C") && a.product === schemeKey;
  const resetScheme = (schemeKey: string) => {
    const own = ownBy(schemeKey);
    slab.cancelSlabRuns(schemeKey);
    const remaining = adjustments.filter((a) => !own(a));
    if (remaining.length !== adjustments.length) setAdjustments(remaining);
    setNextAdjustments((prev) => prev.filter((a) => !own(a)));
    setNextLayouts((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith(`${schemeKey}::`))));
    setRemovedSchemes((prev) => without(prev, schemeKey));
    setRowsByScheme((prev) => ({ ...prev, [schemeKey]: prev[schemeKey].map(resetRow) }));
    setMovedSlabs((prev) => {
      const next = new Set(prev);
      for (const k of prev) if (k.startsWith(`${schemeKey}::`)) next.delete(k);
      return next;
    });
    setSlabLayouts((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith(`${schemeKey}::`))));
    void track((mine, signal) => slabsAgain(schemeKey, remaining, mine, signal));
  };
  /** The scheme's own slab table fetched again (after its Reset), with the edits that remain re-applied. */
  const slabsAgain = (schemeKey: string, remaining: Adjustment[], mine: number, signal: AbortSignal) =>
    api
      .slabs({ scheme: schemeKey, ...scopeArgs() }, signal)
      .then((res) => {
        if (!isLatest(mine)) return;
        const fresh = res.rows.map(resetRow);
        setBaseline((prev) => ({ ...prev, [schemeKey]: fresh }));
        if (!remaining.length) { setRowsByScheme((prev) => ({ ...prev, [schemeKey]: fresh })); return; }
        return api.allSlabsAdjusted({ ...scopeArgs(), adjustments: remaining, scheme: schemeKey }, signal).then((adj) => {
          if (!isLatest(mine)) return;
          const rows = adj.schemes[0]?.rows.map((r) => ({ ...r, rebucketed: true })) ?? fresh;
          setRowsByScheme((prev) => ({ ...prev, [schemeKey]: rows }));
        });
      })
      // The local rate reset already happened; say the boundaries could not be fetched again.
      .catch((e) => { if (isLatest(mine)) setError(`The scheme's own slab table did not load again. ${errorText(e)}`); });

  /** A scheme's Reset (its row, its slab editor or the Edits panel), after a confirm, with Undo for 10 seconds. It
   *  clears the scheme's slab and rate edits, its typed Volume / GSR / CN, next month's own tables, and a Delete. */
  const askResetScheme = async (schemeKey: string) => {
    const own = ownBy(schemeKey);
    const mine = ([k]: [string, unknown]) => k.startsWith(`${schemeKey}::`);
    const snap = {
      current: adjustments.filter(own), next: nextAdjustments.filter(own),
      layouts: Object.fromEntries(Object.entries(planLayouts).filter(mine)),
      nextLayouts: Object.fromEntries(Object.entries(nextLayouts).filter(mine)),
      removed: removedSchemes.has(schemeKey),
    };
    const parts = [
      Object.keys(snap.layouts).length && "slab boundaries and rates",
      snap.current.length + snap.next.length && "typed Volume, GSR and CN",
      Object.keys(snap.nextLayouts).length && "next month's own slab tables",
      snap.removed && "its Delete",
    ].filter(Boolean) as string[];
    if (parts.length && !(await confirm({
      title: `Reset ${labelOf(schemeKey)}?`,
      body: <p>This scheme's edits go back to the file's figures: {parts.join(", ")}. Other schemes are not changed,
              and you can undo this for 10 seconds.</p>,
      confirmLabel: "Reset scheme", danger: true,
    }))) return;
    resetScheme(schemeKey);
    if (!parts.length) return;
    showToast({ text: `${labelOf(schemeKey)} was reset.`, action: { label: "Undo", run: () => {
      const adjs = [...adjRef.current.filter((a) => !own(a)), ...snap.current];
      if (JSON.stringify(adjs) !== JSON.stringify(adjRef.current)) skipAdj.current = true;
      adjRef.current = adjs;
      setAdjustments(adjs);
      setNextAdjustments((prev) => [...prev.filter((a) => !own(a)), ...snap.next]);
      setNextLayouts((prev) => ({ ...prev, ...snap.nextLayouts }));
      if (snap.removed) setRemovedSchemes((prev) => new Set(prev).add(schemeKey));
      setSlabLayouts((prev) => ({ ...prev, ...snap.layouts }));
      setMovedSlabs((prev) => new Set([...prev, ...Object.keys(snap.layouts)]));
      const layouts = { ...carryLayouts.current, ...snap.layouts };
      void track((m, signal) => refreshRows(adjs, layouts, baseline, m, signal));
    } } });
  };

  /** Delete a scheme (it pays nothing in the current and next month), after a confirm, with Undo for 10 seconds. */
  const askRemoveScheme = async (k: string) => {
    if (!(await confirm({
      title: `Delete ${labelOf(k)}?`,
      body: <p>The scheme pays nothing in the current and next month; its volume and GSR stay. Its edits are kept, so
              Restore (or Undo, for 10 seconds) brings it back as it was.</p>,
      confirmLabel: "Delete scheme", danger: true,
    }))) return;
    const wasOpen = expanded.has(k);
    setRemovedSchemes((prev) => new Set(prev).add(k));
    setExpanded((prev) => without(prev, k));
    showToast({
      text: `${labelOf(k)} was deleted: it pays nothing in the current and next month.`,
      action: { label: "Undo", run: () => {
        restoreScheme(k);
        if (wasOpen) setExpanded((prev) => new Set(prev).add(k));
      } },
    });
  };

  /** Reset all, after a confirm, with Undo for 10 seconds. */
  const askResetAll = async () => {
    const n = editedCount;
    if (!(await confirm({
      title: "Reset all edits?",
      body: <p>Everything you edited goes back to the file's figures ({n === 1 ? "1 edit" : `${n} edits`}): typed figures,
              slab boundaries and rates, deleted schemes, gift what-ifs and next month's volume change (V)
              {openVersion ? `. "${openVersion.name}" is detached from the Simulator` : ""}. Saved versions are not
              changed, and you can undo this for 10 seconds.</p>,
      confirmLabel: "Reset all", danger: true,
    }))) return;
    const snap = snapshot();
    resetAll();
    showToast({ text: "All edits were reset.", action: { label: "Undo", run: () => restoreEdits(snap) } });
  };

  const resetAll = () => {
    slab.cancelSlabRuns();
    setGrowth(0);
    setGiftEdits({});
    setAdjustments([]);
    setNextAdjustments([]);
    setOpenVersion(null);
    setRowsByScheme((prev) =>
      Object.fromEntries(Object.entries(prev).map(([k, rows]) => [k, rows.map(resetRow)]))
    );
    setMovedSlabs(new Set());
    setSlabLayouts({});
    setNextLayouts({});
    setRemovedSchemes(new Set());
    void track((mine, signal) => api
      .allSlabs(scopeArgs(), signal)
      .then((res) => {
        if (!isLatest(mine)) return;
        setData(res);
        const next: RowsByScheme = {};
        for (const s of res.schemes) next[s.key] = s.rows.map(resetRow);
        setRowsByScheme(next);
        setBaseline(next);
      })
      .catch((e) => { if (isLatest(mine)) setError(errorText(e)); }));
  };

  /** Retry on the error line: with tables on screen, the edits are run again on them; else the scope is fetched. */
  const retryNow = () => {
    setError(null);
    if (!data) { retry(); return; }
    void track((m, signal) => refreshRows(adjRef.current, carryLayouts.current, baseline, m, signal));
  };
  // The same user logged in again after the session ended: what failed meanwhile (the last edit, say) runs again.
  const { relogins, user } = useUser();
  const canEdit = canEditOf(user);
  const firstLogin = useRef(relogins);
  useEffect(() => {
    if (relogins === firstLogin.current) return;
    firstLogin.current = relogins;
    if (error || !data) retryNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relogins]);

  // ---- Figures every view reads ------------------------------------------------------------------------------------
  const scopeLabel = useMemo(() => scopeLabelOf(zone, region, depot), [zone, region, depot]);
  const { exporting, exportView } = useExport(data, simRows, movedSlabs, scope, scopeLabel, setError);

  const grand = useMemo(() => grandOf(data, simRows), [simRows, data]);
  /** What the readout measures: the scheme drilled into on Overview, or -- on Simulator -- the one scheme left
   *  expanded. Several expanded at once is ambiguous, so it falls back to the whole book rather than guessing. */
  const focusKey = useMemo(() => {
    if (tab === "overview") return drill;
    if (tab === "simulator" && expanded.size === 1) return [...expanded][0];
    return null;
  }, [tab, drill, expanded]);
  const kpi = useMemo(() => kpiOf(focusKey, data, simRows, grand), [focusKey, data, simRows, grand]);
  /** The previous month under each readout figure, for the same scope (the scheme in focus when there is one). */
  const [prevMonth, setPrevMonth] = useState<MonthBlock | null>(null);
  const scopeKey = [zone.join("|"), region.join("|"), depot.join("|")].join("#");
  useEffect(() => {
    const ctrl = new AbortController();
    api.months({ zone, region, depot_code: depot }, ctrl.signal)
      .then((m) => setPrevMonth(m.previous ?? null))
      .catch(() => { /* the readout shows without the comparison */ });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);
  const readoutPrev = useMemo((): ReadoutPrev | null => {
    if (!prevMonth) return null;
    const label = monthName(prevMonth.month).split(" ")[0];
    if (focusKey) {
      const s = schemeRowOf(prevMonth, focusKey);
      return s ? { label, volume: s.volume, gsr: s.gsr, cn: s.cn } : null;
    }
    return { label, volume: prevMonth.book_volume ?? null, gsr: prevMonth.total.gsr, cn: prevMonth.total.cn };
  }, [prevMonth, focusKey]);
  const src = data?.source;

  const editedSchemes = useMemo(
    () => editedSchemesOf(rowsByScheme, removedSchemes, adjustments, nextAdjustments, movedSlabs, nextLayouts),
    [rowsByScheme, removedSchemes, adjustments, nextAdjustments, movedSlabs, nextLayouts]);
  const visibleSchemes = useMemo(
    () => visibleSchemesOf(data, query, onlyVerified, editedOnly, sortBy, editedSchemes, simRows),
    [data, query, onlyVerified, editedOnly, sortBy, editedSchemes, simRows]);
  const schemeStats = useMemo(() => schemeStatsOf(data, simRows), [data, simRows]);
  const rateMultipliers = useMemo(() => rateMultipliersOf(simRows), [simRows]);

  const edits = adjustments.length + nextAdjustments.length;
  const giftEditCount = Object.keys(giftEdits).length;
  const editedCount = editedCountOf(editedSchemes.size, edits, giftEditCount, growth);
  // "Edited only" with nothing edited would show an empty table with its button disabled: switch it off.
  useEffect(() => { if (editedOnly && editedSchemes.size === 0) setEditedOnly(false); }, [editedOnly, editedSchemes.size]);
  // Closing or reloading the tab loses every edit (they live in this browser only): ask first.
  useEffect(() => {
    if (editedCount === 0) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editedCount]);

  // The business's blended CN % of GSR -- the reference both Overview charts read against (scheme GSRs overlap, so it
  // is never CN over their sum).
  const businessPct = data && data.grand.gsr > 0 ? (grand.simulated_cn / data.grand.gsr) * 100 : 0;
  const drilled = useMemo(
    () => (drill ? (data?.schemes ?? []).find((s) => s.key === drill) ?? null : null),
    [drill, data]
  );

  // ---- Shared pieces of the Simulator --------------------------------------------------------------------------------
  const labelOf = (k: string) => data?.schemes.find((s) => s.key === k)?.label ?? k;
  const restoreScheme = (k: string) => setRemovedSchemes((prev) => without(prev, k));
  const filtering = Boolean(query.trim()) || editedOnly || onlyVerified;
  const viewScope = { zone, region, depot_code: depot, label: scopeLabel };
  /** List the dealers behind a current-month slab row. */
  const showDealers = (schemeKey: string, component: string, row: SlabRow) => {
    const key = `${schemeKey}::${component}`;
    setDealerView({
      schemeKey,
      schemeLabel: labelOf(schemeKey),
      component,
      row,
      layout: movedSlabs.has(key) ? slabLayouts[key] : undefined,
      scope: viewScope,
      rateLabel: (v) => fmtRate(v, row.formula, row.pack_size),
      adjustments, nextAdjustments,
    });
  };
  /** What every slab editor (SchemeCard) of a scheme needs, in Overall Schemes and in Scheme detail alike. A scheme
   *  this login may not edit (app/access.py) shows the same table read-only. */
  const cardProps = (key: string): Omit<ComponentProps<typeof SchemeCard>, "scheme" | "open" | "onToggle"> => ({
    rows: rowsByScheme[key] ?? [],
    baseline: baseline[key] ?? [],
    readOnly: !canEdit(key),
    onEdit: (rowId, rate) => slab.editRate(key, rowId, rate),
    onEditEdge: (component, from, value) => slab.editSlabEdge(key, component, from, value),
    canEditSlabs: (component) => canEdit(key) && slabsAllowed(key, component),
    ownCards: (component) => !singleCard(key, component),
    onShowDealers: (component, row) => showDealers(key, component, row),
    movedSlabs: new Set([...movedSlabs].filter((k) => k.startsWith(`${key}::`)).map((k) => k.slice(key.length + 2))),
    onAddSlab: (component, row) => slab.addSlab(key, component, row),
    onRemoveSlab: (component, row) => slab.removeSlab(key, component, row),
    onReset: () => { void askResetScheme(key); },
    onEditSlab: canEdit(key) ? (row, field, from, to, total, choice) => slab.editSlab(key, row, field, from, to, total, choice)
      : undefined,
    slabEdited: (row, field) => slab.slabEdited(key, row, field),
  });
  /** Next month's own slab tables: edited by the scheme's manager or an ADMIN only. */
  const nextEditOf = (key: string, component: string) => (canEdit(key) ? slab.nextEditOf(key, component) : undefined);
  const toggleExpanded = (key: string) => setExpanded((prev) => toggled(prev, key));
  const toggleEditedOnly = () => setEditedOnly((v) => !v);
  /** Reset all sits in the Simulator toolbar, after Collapse all (user's choice, 3 Nov 2026). */
  const resetAllButton = editedCount > 0 && (
    <button className="btn sm btn-reset" onClick={() => { void askResetAll(); }}>
      Reset all ({editedCount})
    </button>
  );


  // On Overall Schemes the view switch and the Edits panel sit in the table's own toolbar.
  const inToolbar = tab === "simulator" && nav.simView === "months";
  const editsPanel = data ? (
    <EditsPanel
      adjustments={adjustments} nextAdjustments={nextAdjustments}
      onRemove={(period, i) => (period === "current" ? setAdjustments : setNextAdjustments)((prev) => prev.filter((_, j) => j !== i))}
      slabSchemes={Object.keys(rowsByScheme).filter((k) => !removedSchemes.has(k)
        && ([...movedSlabs].some((m) => m.startsWith(`${k}::`))
            || (rowsByScheme[k] ?? []).some((r) => (r.simulated_rate ?? r.cn_rate) !== r.cn_rate)))}
      nextTables={Object.keys(nextLayouts)}
      onDropNext={slab.dropNext}
      onResetScheme={(k) => { void askResetScheme(k); }}
      removed={[...removedSchemes]}
      onRestore={restoreScheme}
      growth={growth} onResetGrowth={() => setGrowth(0)}
      giftEdits={giftEditCount} onResetGifts={() => setGiftEdits({})}
      labelOf={labelOf}
    />
  ) : null;
  const viewSwitch = (
    <SimViewSwitch view={nav.simView} onMonths={nav.backToOverall}
                   onDetail={() => { nav.setSimView("detail"); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
  );

  return (
    <div className="app">
      <header className="cmdbar">
        <div className="cmd-row cmd-row-1">
          <TitleBlock scopeLabel={scopeLabel} data={data} visibleCount={visibleSchemes.length} src={src} />
          <MainTabs tab={tab} onTab={setTab} editedCount={editedCount} />
          <UserBadge confirmLeave={async () => editedCount === 0 || confirm({
            title: "Log out?",
            body: <p>Your {editedCount === 1 ? "edit" : `${editedCount} edits`} in the Simulator live in this browser only
                    and will be lost. Save a version first if you want to keep them.</p>,
            confirmLabel: "Log out", danger: true,
          })} />
          <ThemeToggle />
          <button className="btn btn-export" onClick={exportView} disabled={!data || exporting}
                  title="Download this view as Excel: summary, schemes and every slab row, with your edits">
            {exporting ? "Exporting…" : "Export to Excel"}
          </button>
          {!inToolbar && editsPanel}
        </div>
        <FilterBar
          filters={filters} zone={zone} region={region} depot={depot}
          onZone={(next) => { setZone(next); setRegion([]); setDepot([]); }}
          onRegion={(next) => { setRegion(next); setDepot([]); }}
          onDepot={setDepot}
          query={query} onQuery={setQuery}
          onlyVerified={onlyVerified} onOnlyVerified={setOnlyVerified}
          anyOn={Boolean(zone.length || region.length || depot.length || query || onlyVerified || editedOnly)}
          onClear={() => { setZone([]); setRegion([]); setDepot([]); setQuery(""); setOnlyVerified(false); setEditedOnly(false); }}
        />
        <Readout kpi={kpi} hasData={Boolean(data)} src={src} prev={readoutPrev} />
      </header>

      <main id="content" role="tabpanel" aria-labelledby={`tab-${tab}`}
            className={loading && data ? "is-refreshing" : ""} aria-busy={loading || undefined}>
      <ErrorBoundary resetKey={tab}>
      {/* Only the very first load has nothing to show. */}
      {!data && !error && <StartingUp waking={startingUp} />}
      {error && (
        <ErrorBanner text={error} onRetry={retryNow} onDismiss={data ? () => setError(null) : undefined} />
      )}

      {tab === "overview" && data && (
        <OverviewTab
          stats={schemeStats} avgPct={businessPct} drill={drill} onDrill={setDrill}
          drilled={drilled} drilledRows={drill ? rowsByScheme[drill] ?? [] : []}
          onOpenSimulator={() => {
            if (!drill) return;
            setTab("simulator");
            nav.setSimView("months");
            setExpanded((prev) => new Set(prev).add(drill));
            nav.scrollTarget.current = `mv-scheme-${drill}`;
            setScrollTick((n) => n + 1);
            setDrill(null);
          }}
        />
      )}

      {tab === "trend" && (
        <TrendView>
          {/* The plan sits directly under the months it is judged against: a target is only meaningful next to what
              actually happened. */}
          <TargetPlanner
            zone={zone}
            region={region}
            depotCode={depot}
            rateMultipliers={rateMultipliers}
            onSelectScheme={(k) => { setDrill(k); setTab("overview"); }}
          />
        </TrendView>
      )}

      {tab === "simulator" && visibleSchemes.length > 0 && src?.complete && <SettledNote month={src.month} />}

      {tab === "simulator" && data && !inToolbar && viewSwitch}

      {/* One table on the Simulator: products, their schemes, and each scheme's slab tables for the previous,
          current and next month, with the current month's editor under them. */}
      {tab === "simulator" && nav.simView === "months" && data && (
        <>
          <MonthsView
            scope={viewScope}
            rowsByScheme={simRows}
            schemeLabels={Object.fromEntries(data.schemes.map((s) => [s.key, s.label]))}
            layouts={nextPlanLayouts}
            nextEditOf={nextEditOf}
            visibleKeys={visibleSchemes.map((s) => s.key).filter((k) => !removedSchemes.has(k))}
            removedKeys={removedSchemes}
            growth={growth}
            onGrowth={setGrowth}
            adjustments={adjustments}
            nextAdjustments={nextAdjustments}
            products={products}
            onEditCell={editCell}
            isEdited={isEdited}
            hasEdits={edits > 0}
            onRemoveScheme={(k) => { void askRemoveScheme(k); }}
            onRestoreScheme={restoreScheme}
            filtering={filtering}
            editedKeys={editedSchemes}
            openSchemes={expanded}
            onToggleScheme={toggleExpanded}
            onCollapseAll={() => setExpanded(new Set())}
            openProducts={openProducts}
            onOpenProducts={setOpenProducts}
            onOpenDetail={nav.openDetail}
            reviewKeys={new Set(data.schemes.filter((s) => s.status !== "ok").map((s) => s.key))}
            onResetScheme={(k) => { void askResetScheme(k); }}
            onShowDealers={(t) => setDealerView({ ...t, adjustments, nextAdjustments })}
            renderEditor={(key, component) => {
              const scheme = data.schemes.find((s) => s.key === key);
              if (!scheme) return null;
              return (
                <SchemeCard {...cardProps(key)} scheme={scheme} open embedded only={component}
                            onToggle={() => toggleExpanded(key)} />
              );
            }}
            tools={
              <>
                <SortSelect label="Sort schemes" value={sortBy} onChange={setSortBy} />
                <EditedOnlyButton on={editedOnly} onToggle={toggleEditedOnly} count={editedCount} />
                {inToolbar && editsPanel}
                <SaveVersion
                  canSave={canSave}
                  opened={openVersion}
                  build={() => ({ volume_growth_pct: growth, adjustments, next_adjustments: nextAdjustments,
                                  layouts: planLayouts, next_layouts: nextLayouts, removed_schemes: [...removedSchemes] })}
                  onSaved={(o) => { setOpenVersion(o); setOpenedVersion(o.id); setSavedKey(editKey); }}
                  hasEdits={editedCount > 0}
                  dirty={openVersion ? savedKey !== null && editKey !== savedKey : editedCount > 0}
                />
              </>
            }
            trailing={resetAllButton}
            viewSwitch={inToolbar ? viewSwitch : undefined}
          />
          <GiftsView scope={viewScope} onOpenDetail={nav.openGiftDetail} />
        </>
      )}

      {/* Saved what-if versions: dealer GSR / volume changes plus this user's slab edits, computed on the server. */}
      {tab === "versions" && <VersionsView onOpen={openInSimulator} />}

      {/* The full-width scheme list, one month at a time; Current shares edits with the month table. */}
      {tab === "simulator" && nav.simView === "detail" && data && (
        <SchemeDetailView
          scope={viewScope}
          visibleKeys={visibleSchemes.map((s) => s.key)}
          removedKeys={removedSchemes}
          filtering={filtering}
          schemeLabels={Object.fromEntries(data.schemes.map((s) => [s.key, s.label]))}
          isCurrency={(k) => data.schemes.find((s) => s.key === k)?.is_currency ?? true}
          growth={growth}
          layouts={nextPlanLayouts}
          nextEditOf={nextEditOf}
          adjustments={adjustments}
          nextAdjustments={nextAdjustments}
          month={detailMonth}
          onMonth={setDetailMonth}
          openSchemes={nav.detailOpen}
          onToggleScheme={nav.toggleDetail}
          onShowDealers={(t) => setDealerView({ ...t, adjustments, nextAdjustments })}
          isLive={(k) => k in rowsByScheme}
          onBack={nav.backToOverall}
          gifts={
            <GiftSchemes scope={{ zone, region, depot_code: depot }} edits={giftEdits}
                         open={nav.openGifts} onToggle={nav.toggleGift} onBack={nav.backToOverall}
                         onEdit={(k, e) => setGiftEdits((prev) => {
                           const next = { ...prev };
                           if (e) next[k] = e; else delete next[k];
                           return next;
                         })} />
          }
          onEditCell={editCell}
          isEdited={isEdited}
          tools={
            <>
              <SortSelect label="Sort" value={sortBy} onChange={setSortBy} />
              <EditedOnlyButton on={editedOnly} onToggle={toggleEditedOnly} count={editedCount} />
              <button className="btn sm" onClick={() => nav.setDetailOpen(new Set())}
                      disabled={nav.detailOpen.size === 0}>
                Collapse all
              </button>
              {resetAllButton}
            </>
          }
          notice={removedSchemes.size > 0 && (
            <RemovedSchemesNotice keys={[...removedSchemes]} labelOf={labelOf} onRestore={restoreScheme} />
          )}
          currentRowsOf={(k) => rowsByScheme[k] ?? []}
          renderCurrent={(mixOf, figsOf, editFig, compareOf) => (
          <div className="scheme-list stagger">
            {visibleSchemes.filter((s) => !removedSchemes.has(s.key)).map((scheme) => (
              <SchemeCard
                key={scheme.key}
                {...cardProps(scheme.key)}
                scheme={scheme}
                productMix={mixOf(scheme.key)}
                figs={figsOf(scheme.key)}
                compare={compareOf(scheme.key)}
                onBack={nav.backToOverall}
                editFig={scheme.key in rowsByScheme && canEdit(scheme.key)
                  ? (field, value, shown) => editFig(scheme.key, field, value, shown) : undefined}
                open={nav.detailOpen.has(scheme.key)}
                onToggle={() => nav.toggleDetail(scheme.key)}
              />
            ))}
            {!loading && visibleSchemes.length === 0 && <p className="hint">No schemes match this selection.</p>}
          </div>
          )}
        />
      )}
      </ErrorBoundary>
      </main>
      {dealerView && <DealerList target={dealerView} onClose={() => setDealerView(null)} />}
      {confirmNode}
      {toastNode}
    </div>
  );
}
