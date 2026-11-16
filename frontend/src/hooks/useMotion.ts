import { useEffect, useRef } from "react";

const reduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Pointer-tracked spotlight on cards.
 *
 * One listener on the document, delegating to whichever card is under the
 * cursor, writing two custom properties straight onto that element. Deliberately
 * NOT React state: this fires on every pointer move, and re-rendering a table of
 * thousands of rows at that rate would make the page unusable. Writing a CSS
 * variable skips React entirely and only invalidates paint on one element.
 *
 * Throttled to one write per animation frame, because pointermove can fire far
 * faster than the display refreshes and the extra writes are wasted work.
 */
export function useSpotlight(selector = ".card-viz, .hero-alloc, .pk") {
  useEffect(() => {
    if (reduced()) return;
    let frame = 0;
    let pending: { el: HTMLElement; x: number; y: number } | null = null;

    const flush = () => {
      frame = 0;
      if (!pending) return;
      const { el, x, y } = pending;
      el.style.setProperty("--mx", `${x}px`);
      el.style.setProperty("--my", `${y}px`);
      pending = null;
    };

    const onMove = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.(selector) as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      pending = { el, x: e.clientX - r.left, y: e.clientY - r.top };
      if (!frame) frame = requestAnimationFrame(flush);
    };

    document.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      document.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [selector]);
}

/**
 * A ripple from the point of click, on elements matching `selector`.
 *
 * Same delegation argument as above, plus one of its own: the class has to come
 * off again or a second click on the same row does nothing (the animation is
 * already "finished"). Removing it on animationend restarts it cleanly.
 */
export function useRipple(selector = ".card-head") {
  useEffect(() => {
    if (reduced()) return;
    const onDown = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.(selector) as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--rx", `${e.clientX - r.left}px`);
      el.style.setProperty("--ry", `${e.clientY - r.top}px`);
      el.classList.remove("is-rippling");
      void el.offsetWidth; // force a reflow so the animation can restart
      el.classList.add("is-rippling");
    };
    const onEnd = (e: AnimationEvent) => {
      if (e.animationName === "ripple") {
        (e.target as HTMLElement).classList?.remove("is-rippling");
      }
    };
    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("animationend", onEnd);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("animationend", onEnd);
    };
  }, [selector]);
}

/**
 * Adds a one-shot class whenever `value` changes, so a figure can flash.
 *
 * Returns a ref to put on the element. The class is removed on animationend
 * rather than by a timer, so it cannot get out of step with the CSS duration.
 */
export function usePulse<T extends HTMLElement>(value: number) {
  const ref = useRef<T>(null);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    const el = ref.current;
    if (!el || reduced()) return;
    el.classList.remove("is-changed");
    void el.offsetWidth;
    el.classList.add("is-changed");
    const off = () => el.classList.remove("is-changed");
    el.addEventListener("animationend", off, { once: true });
    return () => el.removeEventListener("animationend", off);
  }, [value]);
  return ref;
}
