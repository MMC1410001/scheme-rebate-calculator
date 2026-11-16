import { useEffect, useRef, useState } from "react";
import type { Adjustment } from "../api/client";
import { useFocusTrap } from "../hooks/useFeedback";
import { describe } from "./describeEdit";

/** "Edits (n)" in the command bar: every edit in this browser, each with its own undo, so one product or total edit
 *  can be taken back without Reset all. Figure edits are listed one by one; slab and rate edits per scheme. */
export function EditsPanel({
  adjustments, nextAdjustments, onRemove, slabSchemes, onResetScheme, removed, onRestore, growth, onResetGrowth,
  giftEdits, onResetGifts, labelOf, nextTables, onDropNext,
}: {
  /** "scheme::component" of every next-month-only slab table. */
  nextTables: string[];
  onDropNext: (key: string) => void;
  adjustments: Adjustment[];
  nextAdjustments: Adjustment[];
  onRemove: (period: "current" | "next", index: number) => void;
  /** Schemes with slab boundary or rate edits. */
  slabSchemes: string[];
  onResetScheme: (key: string) => void;
  removed: string[];
  onRestore: (key: string) => void;
  growth: number;
  onResetGrowth: () => void;
  giftEdits: number;
  onResetGifts: () => void;
  labelOf: (key: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // Tab stays inside the open list, Escape closes it and focus goes back to the button (a dialog opened from it,
  // such as Reset's confirm, takes the keys while it is open).
  useFocusTrap(pop, open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // A click in a dialog opened from the list (Reset's confirm) is not a click outside it.
      const t = e.target as HTMLElement;
      if (box.current && !box.current.contains(t) && !t.closest?.("[role=dialog], [role=alertdialog]")) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const count = adjustments.length + nextAdjustments.length + slabSchemes.length + nextTables.length + removed.length
    + (growth !== 0 ? 1 : 0) + (giftEdits ? 1 : 0);
  if (count === 0) return null;
  const figure = (a: Adjustment, period: "current" | "next", i: number) => (
    <li key={`${period}-${i}`}>
      <span>{describe({ ...a, period })}</span>
      <button type="button" className="edits-x" aria-label={`Undo: ${describe({ ...a, period })}`} title="Undo this edit"
              onClick={() => onRemove(period, i)}>×</button>
    </li>
  );
  return (
    <div className="edits" ref={box}>
      <button type="button" className="btn" aria-expanded={open} aria-haspopup="true"
              onClick={() => setOpen((v) => !v)} title="Every edit in this browser, each with its own undo">
        Edits ({count})
      </button>
      {open && (
        <div ref={pop} className="edits-pop" role="dialog" aria-label="Your edits">
          <p className="muted">Your edits live in this browser only. Undo one here, or use Reset all.</p>
          <ul className="edits-list">
            {adjustments.map((a, i) => figure(a, "current", i))}
            {nextAdjustments.map((a, i) => figure(a, "next", i))}
            {slabSchemes.map((k) => (
              <li key={`slab-${k}`}>
                <span>{labelOf(k)}: slab boundaries or rates edited</span>
                <button type="button" className="edits-x" aria-label={`Reset ${labelOf(k)}`}
                        title="Reset this scheme: its slab boundaries and rates, and its typed Volume, GSR and CN"
                        onClick={() => onResetScheme(k)}>×</button>
              </li>
            ))}
            {nextTables.map((k) => {
              const [scheme, component] = k.split("::");
              return (
                <li key={`next-${k}`}>
                  <span>Next month, {labelOf(scheme)} · {component}: its own slab table</span>
                  <button type="button" className="edits-x" aria-label={`Undo next month's own table of ${labelOf(scheme)} ${component}`}
                          title="Follow the current month's table again" onClick={() => onDropNext(k)}>×</button>
                </li>
              );
            })}
            {removed.map((k) => (
              <li key={`rm-${k}`}>
                <span>{labelOf(k)}: deleted (pays nothing)</span>
                <button type="button" className="edits-x" aria-label={`Restore ${labelOf(k)}`} title="Restore this scheme"
                        onClick={() => onRestore(k)}>×</button>
              </li>
            ))}
            {growth !== 0 && (
              <li>
                <span>Next month volume change V: {growth > 0 ? "+" : "−"}{Math.abs(growth)}%</span>
                <button type="button" className="edits-x" aria-label="Set V back to 0%" title="Set V back to 0%"
                        onClick={onResetGrowth}>×</button>
              </li>
            )}
            {giftEdits > 0 && (
              <li>
                <span>Gift scheme what-ifs: {giftEdits}</span>
                <button type="button" className="edits-x" aria-label="Clear the gift what-ifs" title="Clear the gift what-ifs"
                        onClick={onResetGifts}>×</button>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
