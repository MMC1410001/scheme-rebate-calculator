import { useEffect, useRef, useState } from "react";
import type { Adjustment, AllSlabsResponse, Filters, SlabLayout } from "../api/client";
import { api, ApiError, errorText, isAbort } from "../api/client";
import { resetRow } from "../api/computeImpact";
import type { RowsByScheme, ScopeSel } from "./constants";

/** What happens once the scope's slab tables arrive: `rows` are the served rows (also the baseline). Return a
 *  promise to keep the page "loading" until it settles (re-running the edits, say). */
export type OnServed = (rows: RowsByScheme, mine: number, signal: AbortSignal) => Promise<unknown> | void;

/** The scope's slab tables and everything about fetching them: the served rows (`baseline`), the rows on screen
 *  (`rowsByScheme`, with edits), loading, the error line, the automatic retry while the server starts up, and the
 *  order of requests (a newer scope or edit cancels the one in flight, and a late answer is ignored).
 *
 *  Stale-while-revalidate: the previous scope stays on screen, dimmed, until the new one arrives. The sequence guard
 *  matters because the filters are three separate selects: picking a zone and then a region fires two requests, and
 *  without it the slower first reply can land last and overwrite the scope actually asked for. */
export function useScopeData(scope: ScopeSel, onServed: OnServed) {
  const { zone, region, depot } = scope;
  const [filters, setFilters] = useState<Filters>({ zones: [], regions: [], depots: [], hierarchy: [] });
  const [products, setProducts] = useState<string[]>([]);
  const [canSave, setCanSave] = useState(false);
  const [data, setData] = useState<AllSlabsResponse | null>(null);
  const [rowsByScheme, setRowsByScheme] = useState<RowsByScheme>({});
  /** The slab table exactly as the server first served it, never edited. "Actual CN" must stay anchored to the
      structure that actually paid out, so it cannot come from the live rows -- those are re-bucketed the moment a
      boundary moves, which made a 0% band appear to have paid tens of thousands of rupees. */
  const [baseline, setBaseline] = useState<RowsByScheme>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by Retry (and by the automatic retry while the server starts up) to fetch the scope again. */
  const [attempt, setAttempt] = useState(0);
  /** The first load failed because the server is starting up or cannot be reached: retried by itself. */
  const [startingUp, setStartingUp] = useState(false);

  const filtersLoaded = useRef(false);
  const metaLoaded = useRef(false);
  useEffect(() => {
    if (!filtersLoaded.current) {
      api.filters().then((f) => { filtersLoaded.current = true; setFilters(f); }).catch(() => { /* retried with the scope */ });
    }
    if (!metaLoaded.current) {
      api.versionMeta().then((m) => { metaLoaded.current = true; setProducts(m.products); setCanSave(m.can_save); })
        .catch(() => { /* Save stays hidden until the server answers */ });
    }
  }, [attempt]);

  const reqSeq = useRef(0);
  /** The slab-table request in flight: a newer scope or edit cancels it (its answer would be ignored anyway). */
  const inflight = useRef<AbortController | null>(null);
  const startRequest = () => {
    inflight.current?.abort();
    inflight.current = new AbortController();
    return { mine: ++reqSeq.current, signal: inflight.current.signal };
  };
  /** True while `mine` is the newest request (a newer scope or edit makes every older answer stale). */
  const isLatest = (mine: number) => mine === reqSeq.current;
  /** Run `work` as the newest request, the page marked loading until it settles. */
  const track = (work: (mine: number, signal: AbortSignal) => Promise<unknown>) => {
    const { mine, signal } = startRequest();
    setLoading(true);
    return work(mine, signal).finally(() => { if (isLatest(mine)) setLoading(false); });
  };

  const dataRef = useRef<AllSlabsResponse | null>(null);
  dataRef.current = data;
  const retryTimer = useRef<number | undefined>(undefined);
  const wakingRef = useRef(false);
  // The newest onServed, so the answer is handled with the latest state (it reads refs and setters only).
  const onServedRef = useRef(onServed);
  onServedRef.current = onServed;

  /** The scope by its contents, so an equal new array from a filter does not fetch again. */
  const scopeKey = [zone, region, depot].map((v) => v.join("|")).join("/");
  useEffect(() => {
    const { mine, signal } = startRequest();
    setLoading(true);
    // While retrying a server that is starting up, the message stays until it answers (no flicker every 5 s).
    if (!wakingRef.current) setError(null);
    api
      .allSlabs({ zone, region, depot_code: depot }, signal)
      .then((res) => {
        if (mine !== reqSeq.current) return;   // a newer scope is already in flight
        setData(res);
        if (wakingRef.current) { wakingRef.current = false; setStartingUp(false); setError(null); }
        const next: RowsByScheme = {};
        for (const s of res.schemes) next[s.key] = s.rows.map(resetRow);
        setBaseline(next);
        return onServedRef.current(next, mine, signal);
      })
      .catch((e) => {
        if (mine !== reqSeq.current) return;
        // While the server warms up (about a minute after a restart) it answers 502-504 or not at all: try again by
        // itself rather than leave an error on an empty page.
        const waking = (e instanceof ApiError && e.status >= 502 && e.status <= 504) || e instanceof TypeError;
        if (waking && !dataRef.current) {
          setStartingUp(true);
          wakingRef.current = true;
          setError(`${errorText(e)} Trying again by itself every few seconds.`);
          retryTimer.current = window.setTimeout(() => setAttempt((n) => n + 1), 5000);
          return;
        }
        setStartingUp(false);
        setError(errorText(e));
      })
      .finally(() => { if (mine === reqSeq.current) setLoading(false); });
    return () => window.clearTimeout(retryTimer.current);
    // Only a new scope (by its contents: a filter can hand back an equal new array) or Retry fetches again; the
    // helpers it calls read the latest state themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, attempt]);

  /** The current month's slab rows under the GSR / volume edits: every component re-bucketed on the edited month,
   *  then each component with a slab or rate edit re-run under its table. `base` holds the actual rows. */
  const refreshRows = (adjs: Adjustment[], layouts: Record<string, SlabLayout>, base: RowsByScheme, mine: number,
                       signal?: AbortSignal) => {
    /** Components whose slab or rate edit the server could not re-run, with the reason: shown, never hidden. */
    const failed: { name: string; reason: string }[] = [];
    return (adjs.length
      ? api.allSlabsAdjusted({ zone, region, depot_code: depot, adjustments: adjs }, signal).then((res) => {
          const out: RowsByScheme = {};
          for (const sc of res.schemes) out[sc.key] = sc.rows.map((r) => ({ ...r, rebucketed: true }));
          return out;
        })
      // A copy: the rows below are written into it, and `base` is the actual (served) table, which must never change.
      : Promise.resolve({ ...base }))
      .then((rows) => Promise.all(Object.entries(layouts).map(([key, layout]) => {
        const [scheme, component] = key.split("::");
        return api.simulateSlabs({ scheme, component, zone, region, depot_code: depot, ...layout, adjustments: adjs }, signal)
          .then((res) => { rows[scheme] = [...(rows[scheme] ?? []).filter((r) => r.component !== component),
                                           ...res.rows.map((r) => ({ ...r, rebucketed: true }))]; })
          .catch((e) => { if (!isAbort(e)) failed.push({ name: component, reason: errorText(e) }); });
      })).then(() => {
        if (mine !== reqSeq.current) return;
        setRowsByScheme(rows);
        if (failed.length) {
          const names = failed.map((f) => f.name).join(", ");
          setError(`The slab edits of ${names} could not be applied, so ${failed.length === 1 ? "it shows" : "they show"} `
                   + `the table without them. ${failed[0].reason}`);
        }
      }))
      .catch((e) => { if (mine === reqSeq.current && !isAbort(e)) setError(errorText(e)); });
  };

  /** Fetch the scope again (Retry on the error line). */
  const retry = () => { setError(null); setAttempt((n) => n + 1); };

  return {
    filters, products, canSave, data, setData, rowsByScheme, setRowsByScheme, baseline, setBaseline,
    loading, error, setError, startingUp, retry, startRequest, isLatest, track, refreshRows,
  };
}
