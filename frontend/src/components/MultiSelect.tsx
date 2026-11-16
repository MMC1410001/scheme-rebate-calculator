import { useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * A filter that takes several values.
 *
 * The three scope filters were native <select> elements, which commit the whole
 * page to exactly one zone, one region, one depot. "How does the North-West
 * cluster look?" was three separate page loads and a calculator.
 *
 * A native <select multiple> is not the answer: it shows a scrolling box sized
 * to its options, ctrl-click to add is undiscoverable, and clicking without the
 * modifier silently throws away the whole selection. So: a button showing the
 * current selection, a searchable checklist under it.
 *
 * Empty means everything, and clearing back to empty is one click -- a filter
 * the user has emptied should widen the view, never blank it.
 *
 * Ticks are a draft until the list closes (Done or a click outside; Escape
 * throws the draft away): each change of scope recomputes the whole book, so
 * picking five regions used to fire five refreshes.
 */
export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  allLabel,
  noun,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  allLabel: string;
  /** Plural noun for the summary, e.g. "regions". */
  noun: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<string[]>(selected);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  /** Close the list: apply the ticks (or, with `cancel`, drop them) and give focus back to the button. */
  const close = (cancel = false, refocus = true) => {
    setOpen(false);
    if (!cancel && !same(draftRef.current, selected)) onChange(draftRef.current);
    if (refocus) btn.current?.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // Close on an outside click or Escape, the two ways anyone expects to dismiss
  // a popover. Without the first it lingers behind whatever you click next.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) closeRef.current(false, false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(true); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  // A stale selection is worse than none: if the options change under it (a zone
  // filter narrowing the region list), drop whatever is no longer selectable.
  // No options yet means the lists have not loaded: a selection from the address
  // bar (a reload or a shared link) must survive until they do.
  useEffect(() => {
    if (options.length === 0) return;
    const valid = selected.filter((s) => options.includes(s));
    if (valid.length !== selected.length) onChange(valid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? options.filter((o) => o.toLowerCase().includes(needle)) : options;
  }, [options, q]);

  const shownSel = open ? draft : selected;
  const summary =
    shownSel.length === 0 ? allLabel
    : shownSel.length === 1 ? shownSel[0]
    : `${shownSel.length} ${noun}`;

  const toggle = (v: string) =>
    setDraft((d) => (d.includes(v) ? d.filter((x) => x !== v) : [...d, v]));

  return (
    <div className="ms" ref={box}>
      <span className="ms-label" id={labelId}>{label}</span>
      <button
        ref={btn}
        type="button"
        className={`ms-btn ${selected.length ? "has-sel" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${labelId}-v`}
        onClick={() => { if (open) close(); else { setDraft(selected); setOpen(true); } }}
        title={selected.length > 1 ? selected.join(", ") : undefined}
      >
        <span className="ms-summary" id={`${labelId}-v`}>{summary}</span>
        {selected.length > 1 && <i className="ms-count">{selected.length}</i>}
        {/* The same chevron, size and inset as every <select> (App.css, "Dropdowns"). */}
        <svg className="ms-caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6"
                strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="ms-pop" role="group" aria-labelledby={labelId}>
          {options.length > 8 && (
            <input
              className="ms-search"
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${noun}…`}
              aria-label={`Search ${noun}`}
            />
          )}
          <div className="ms-list">
            {shown.length === 0 && <p className="ms-empty">No match</p>}
            {shown.map((o) => {
              const on = draft.includes(o);
              return (
                <label key={o} className={`ms-opt ${on ? "on" : ""}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(o)} autoFocus={options.length <= 8 && o === shown[0]} />
                  <span>{o}</span>
                </label>
              );
            })}
          </div>
          <div className="ms-foot">
            <button type="button" className="btn btn-ghost sm" onClick={() => setDraft([])} disabled={!draft.length}>
              Clear
            </button>
            <button
              type="button"
              className="btn btn-ghost sm"
              onClick={() => setDraft((d) => [...new Set([...d, ...shown])])}
              disabled={shown.length === 0 || shown.every((o) => draft.includes(o))}
            >
              Select {q ? "matching" : "all"}
            </button>
            <button type="button" className="btn sm btn-primary" onClick={() => close()}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
