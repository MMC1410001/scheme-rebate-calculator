import { useRef, useState } from "react";
import { useScrollToTarget } from "../hooks/useScrollTarget";
import { toggled, without } from "./edits";

/** The Simulator's two views and the way between them: Overall Schemes (the month table) and Scheme detail. A
 *  scheme's (or one of its components', or a gift scheme's) name in Overall Schemes opens it in Scheme detail, in
 *  view; "← Overall Schemes" goes back to the row it came from, its slabs as they were there. `tab` and
 *  `scrollTick` (bumped to scroll even when the view did not change) bring the target into view once rendered. */
export function useDetailNav(tab: string, scrollTick: number) {
  const [simView, setSimView] = useState<"months" | "detail">("months");
  /** Schemes open in Scheme detail: their own set, so opening one there does not open it in the month table too. */
  const [detailOpen, setDetailOpen] = useState<Set<string>>(new Set());
  /** Gift cards open in Scheme detail. */
  const [openGifts, setOpenGifts] = useState<Set<string>>(new Set());
  const toggleGift = (k: string) => setOpenGifts((prev) => toggled(prev, k));
  const toggleDetail = (k: string) => setDetailOpen((prev) => toggled(prev, k));
  /** The scheme whose name opened Scheme detail, and whether its slabs were open in the table before. */
  const detailFrom = useRef<{ key: string; wasOpen: boolean; component?: string; gift?: boolean } | null>(null);
  /** The element to bring into view once the view just switched to has rendered it. */
  const scrollTarget = useRef<string | null>(null);

  /** A scheme's (or one of its components') name in Overall Schemes: Scheme detail, that scheme open and the scheme
   *  (or the component's slab table) in view; the full list stays. */
  const openDetail = (key: string, component?: string) => {
    detailFrom.current = { key, wasOpen: true, component };
    setDetailOpen((prev) => new Set(prev).add(key));
    scrollTarget.current = component ? `sd-comp-${key}::${component}` : `sd-scheme-${key}`;
    setSimView("detail");
  };
  /** A gift scheme's name in Overall Schemes' gift table: its card in Scheme detail, open and in view. */
  const openGiftDetail = (name: string) => {
    detailFrom.current = { key: name, wasOpen: openGifts.has(name), gift: true };
    setOpenGifts((prev) => new Set(prev).add(name));
    scrollTarget.current = `sd-gift-${name}`;
    setSimView("detail");
  };
  /** "← Overall Schemes": back to the table, at the scheme that was opened, its slabs as they were there. */
  const backToOverall = () => {
    const from = detailFrom.current;
    if (from?.gift) {
      if (!from.wasOpen) setOpenGifts((prev) => without(prev, from.key));
      scrollTarget.current = `mv-gift-${from.key}`;
      detailFrom.current = null;
      setSimView("months");
      return;
    }
    scrollTarget.current = !from ? null : from.component ? `mv-comp-${from.key}::${from.component}` : `mv-scheme-${from.key}`;
    detailFrom.current = null;
    setSimView("months");
  };
  useScrollToTarget(scrollTarget, [simView, tab, scrollTick]);

  return {
    simView, setSimView, detailOpen, setDetailOpen, toggleDetail, openGifts, toggleGift,
    openDetail, openGiftDetail, backToOverall, scrollTarget,
  };
}
