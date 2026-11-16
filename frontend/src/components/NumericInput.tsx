import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A number box you can actually type in.
 *
 * The two editable fields on this dashboard -- a slab boundary and a rebate rate
 * -- were each bound straight to the value the server sent back. That makes them
 * unusable in the same way: clearing the box parses to NaN, NaN is coerced to 0,
 * 0 is committed, the server echoes 0 back, and the box refills itself. The user
 * never gets an empty field to type a fresh number into, and has to edit around
 * whatever digits are already there.
 *
 * The fix is to separate what is being TYPED from what has been COMMITTED:
 *
 *   * while the field has focus, the draft text is authoritative and incoming
 *     props never overwrite it -- so a round-trip triggered by your own last
 *     keystroke cannot yank the field out from under you;
 *   * an empty box is a legal intermediate state. It commits nothing and clears
 *     nothing; it just waits;
 *   * "0" is a real value and commits as 0, distinct from empty;
 *   * partial input on the way to a number ("", "-", "1.") holds without
 *     committing, so typing "0.75" does not commit 0 then 0 then 0.7;
 *   * commits are debounced, so one recompute follows a pause in typing rather
 *     than one per character;
 *   * on blur an empty or unparseable box reverts to the committed value, so the
 *     field cannot be left in a state the data does not have.
 *
 * Escape reverts and Enter commits immediately, because a field that only
 * settles on blur is a trap when the next thing you do is click a chart.
 */
export function NumericInput({
  value,
  onCommit,
  step,
  min,
  max,
  bound,
  format = (v) => String(v),
  debounceMs = 300,
  className,
  title,
  ariaLabel,
  asText = false,
  shown,
  edited = false,
}: {
  value: number;
  onCommit: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  /** Why a value outside [min, max] is not allowed, shown while it is typed. */
  bound?: (v: number) => string | null;
  format?: (v: number) => string;
  debounceMs?: number;
  className?: string;
  title?: string;
  ariaLabel?: string;
  /** Shown as text (the month table's editable figures: dashed outline) until clicked, then as this box. */
  asText?: boolean;
  /** The text shown while not editing; the formatted value if not given. */
  shown?: ReactNode;
  /** The value differs from the file's (solid outline, as an edited figure). */
  edited?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const focused = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  /** Set by Escape and Enter, which settle the box themselves: the blur that follows must not settle it again (the
   *  blur handler still sees the typed draft, so Escape used to commit it and Enter committed twice). */
  const skipBlur = useRef(false);
  /** The value when the box took focus, and whether a debounced commit went out since: Escape puts it back. */
  const start = useRef<number | null>(null);
  const committed = useRef(false);

  // The draft wins ONLY while focused -- the comment said so before but the code
  // did not check, so a draft that outlived its blur kept rendering over the
  // real value. After a Reset restored a boundary from 100 back to 40, the field
  // still read 100 while the band beside it read 40: the data was right and the
  // input was lying about it, until something forced a remount.
  const text = focused.current && draft !== null ? draft : format(value);

  // A committed value arriving from outside (a reset, a new scope, a re-bucket)
  // supersedes anything typed earlier and not committed.
  useEffect(() => {
    if (!focused.current && draft !== null) setDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const schedule = (v: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { committed.current = true; onCommit(v); }, debounceMs);
  };

  const change = (raw: string) => {
    setDraft(raw);
    const trimmed = raw.trim();
    // An empty box, a lone sign, or a trailing dot are all mid-typing states.
    // Committing them would fight the person using the field.
    if (trimmed === "" || trimmed === "-" || trimmed === "." || trimmed.endsWith(".")) {
      window.clearTimeout(timer.current);
      return;
    }
    const v = Number(trimmed);
    if (Number.isNaN(v)) return;

    // A slab boundary typed digit by digit passes through values that are not
    // legal boundaries: on the way from 150 to 136 the field is briefly "1",
    // which sits below the previous edge of 40. Committing that re-sorted the
    // edges server-side and the band vanished mid-edit. So an out-of-range
    // value is HELD, never committed, and the reason is shown instead.
    const why =
      bound?.(v) ??
      (min !== undefined && v < min ? `Must be more than ${min.toLocaleString("en-IN")}`
      : max !== undefined && v > max ? `Must be less than ${max.toLocaleString("en-IN")}`
      : null);
    if (why) {
      setProblem(why);
      window.clearTimeout(timer.current);
      return;
    }
    setProblem(null);
    schedule(v);
  };

  const settle = () => {
    if (skipBlur.current) { skipBlur.current = false; return; }
    focused.current = false;
    if (asText) setEditing(false);
    window.clearTimeout(timer.current);
    const trimmed = (draft ?? "").trim();
    if (draft === null) return;
    const v = Number(trimmed);
    const invalid =
      trimmed === "" || Number.isNaN(v) ||
      (min !== undefined && v < min) || (max !== undefined && v > max) ||
      Boolean(bound?.(v));
    if (invalid) {
      setDraft(null);   // leaving an invalid edge in place would corrupt the table
      setProblem(null);
      return;
    }
    setDraft(null);
    setProblem(null);
    if (v !== value) onCommit(v);
  };

  if (asText && !editing) {
    return (
      <button type="button" className={`mv-edit ${edited ? "is-edited" : ""}`} title={title ?? "Click to type a new figure"}
              aria-label={ariaLabel ? `Edit ${ariaLabel.toLowerCase()}` : "Edit"}
              onClick={(e) => { e.stopPropagation(); setEditing(true); }}>
        {shown ?? format(value)}
      </button>
    );
  }

  return (
    <span className={`num-wrap ${problem ? "has-problem" : ""}`}>
    <input
      autoFocus={asText}
      type="text"
      inputMode="decimal"
      aria-invalid={problem ? true : undefined}
      className={className}
      title={title}
      aria-label={ariaLabel}
      value={text}
      step={step}
      onFocus={(e) => {
        focused.current = true;
        skipBlur.current = false;
        start.current = value;
        committed.current = false;
        setDraft(format(value));
        e.currentTarget.select(); // typing replaces, rather than appending to, the old number
      }}
      onChange={(e) => change(e.target.value)}
      onBlur={settle}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          settle();
          skipBlur.current = true;
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          // Cancel: nothing typed is committed, and a figure a pause in typing already sent is put back.
          window.clearTimeout(timer.current);
          focused.current = false;
          setDraft(null);
          setProblem(null);
          if (asText) setEditing(false);
          if (committed.current && start.current !== null) onCommit(start.current);
          committed.current = false;
          skipBlur.current = true;
          e.currentTarget.blur();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          // type=text loses the native spinner, so the keys are re-implemented
          e.preventDefault();
          const s = step ?? 1;
          const base = Number((draft ?? format(value)).trim());
          if (Number.isNaN(base)) return;
          let next = base + (e.key === "ArrowUp" ? s : -s);
          if (min !== undefined && next < min) next = min;
          next = Math.round(next * 1e6) / 1e6;
          setDraft(String(next));
          schedule(next);
        }
      }}
    />
    {problem && <span className="num-problem" role="status">{problem}</span>}
    </span>
  );
}
