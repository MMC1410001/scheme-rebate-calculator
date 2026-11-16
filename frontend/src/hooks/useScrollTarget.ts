import { useEffect, type DependencyList, type RefObject } from "react";

/** Bring the element whose id is in `target` into view once the view just switched to has rendered it (the month
 *  table loads its months first, so this waits up to 5 s for the row), then clear `target`. Runs when `deps` change. */
export function useScrollToTarget(target: RefObject<string | null>, deps: DependencyList) {
  useEffect(() => {
    const id = target.current;
    if (!id) return;
    let tries = 0;
    const t = window.setInterval(() => {
      const el = document.getElementById(id);
      if (el || ++tries > 50) {
        window.clearInterval(t);
        target.current = null;
        if (!el) return;
        // Below the sticky command bar (and Scheme detail's view switch); a table row with a little of the rows above it.
        // (Only while it is sticky: on a phone it scrolls away with the page.)
        const cmd = document.querySelector("header.cmdbar");
        const bar = (cmd && getComputedStyle(cmd).position === "sticky" ? cmd.getBoundingClientRect().height : 0)
          + (document.querySelector("#content > .sim-view:not(.sd-month)")?.getBoundingClientRect().height ?? 0);
        const gap = el.tagName === "TR" ? 120 : 12;
        window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - bar - gap, behavior: "smooth" });
      }
    }, 100);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** The sticky command bar's height, as --cmdbar-h, so the month table's frame fits the space under it (its header and
 *  Total row then both stay on screen). It changes with the window width and when the readout grows. */
export function useCmdbarHeight() {
  useEffect(() => {
    const bar = document.querySelector<HTMLElement>("header.cmdbar");
    if (!bar) return;
    const set = () => document.documentElement.style.setProperty("--cmdbar-h", `${Math.round(bar.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);
}
