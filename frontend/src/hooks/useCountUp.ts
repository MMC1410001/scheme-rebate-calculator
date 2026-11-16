import { useEffect, useRef, useState } from "react";

/**
 * Eases a number to its new value so figures land rather than snap.
 *
 * The origin is the value CURRENTLY ON SCREEN, held in a ref that the animation
 * itself keeps up to date. An earlier version kept a second effect that wrote
 * that ref from render state on every target change; it ran after the animation
 * effect and clobbered the origin, so figures stopped tracking their input --
 * the projected credit note sat at one number while the elasticity beside it,
 * which is not animated, moved correctly. Anything that needs to know the
 * displayed value now reads it from the one place that owns it.
 */
export function useCountUp(target: number, ms = 700) {
  const [value, setValue] = useState(target);
  const shown = useRef(target);
  const raf = useRef(0);

  useEffect(() => {
    const origin = shown.current;
    const diff = target - origin;
    if (diff === 0) return;

    // Browsers pause requestAnimationFrame in a hidden tab, so an animation
    // started there never advances and the figure is left frozen part-way --
    // the number is simply wrong until something else re-renders it. When the
    // page cannot draw, skip the easing and take the value.
    if (typeof document !== "undefined" && document.hidden) {
      shown.current = target;
      // The page cannot draw: take the value at once (syncing with the browser's hidden state, not a render).
      // eslint-disable-next-line react/set-state-in-effect
      setValue(target);
      return;
    }

    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const v = t < 1 ? origin + diff * (1 - Math.pow(1 - t, 3)) : target;
      shown.current = v;
      setValue(v);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);

    // The tab can also be hidden part-way through, which stops the frames
    // mid-count. A backstop just past the animation's own duration lands the
    // figure on its real value whatever happened to the frames.
    const backstop = window.setTimeout(() => {
      if (shown.current !== target) {
        shown.current = target;
        setValue(target);
      }
    }, ms + 120);

    return () => {
      cancelAnimationFrame(raf.current);
      window.clearTimeout(backstop);
    };
  }, [target, ms]);

  return value;
}
