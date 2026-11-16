import { useEffect, useRef } from "react";

/** What the address bar carries: the tab and the filters (?tab=simulator&zone=North&region=Delhi&region=Haryana).
 *  A refresh keeps the user's place, Back / Forward move between tabs, and a link opens the same view. Edits are not
 *  in the address: they stay in this browser (a saved version is how edits are shared). */
export interface UrlState {
  tab: string | null;
  zone: string[];
  region: string[];
  depot: string[];
}

export function readUrl(search = window.location.search): UrlState {
  const qs = new URLSearchParams(search);
  return { tab: qs.get("tab"), zone: qs.getAll("zone"), region: qs.getAll("region"), depot: qs.getAll("depot_code") };
}

function toSearch(s: UrlState, defaultTab: string): string {
  const qs = new URLSearchParams();
  if (s.tab && s.tab !== defaultTab) qs.set("tab", s.tab);
  for (const v of s.zone) qs.append("zone", v);
  for (const v of s.region) qs.append("region", v);
  for (const v of s.depot) qs.append("depot_code", v);
  const text = qs.toString();
  return text ? `?${text}` : "";
}

/** Keeps the address bar in step with `state`, and calls `apply` when the user goes Back or Forward.
 *  A new tab adds a history entry; a filter change replaces the current one (no Back step per filter). */
export function useUrlSync(state: UrlState, defaultTab: string, apply: (s: UrlState) => void) {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const search = toSearch(state, defaultTab);
  useEffect(() => {
    if (search === window.location.search) return;
    const url = `${window.location.pathname}${search}${window.location.hash}`;
    const tabChanged = (readUrl().tab ?? defaultTab) !== (state.tab ?? defaultTab);
    if (tabChanged) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  useEffect(() => {
    const onPop = () => applyRef.current(readUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}
