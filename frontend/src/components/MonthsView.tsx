import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useCanEdit, useUser } from "../userContext";
import {
  api,
  type Adjustment,
  type CategoryRow,
  type MonthBlock,
  type MonthSlabRow,
  type NextMonthBlock,
  type SchemeMonthRow,
  type SchemeMonths,
  type SlabLayout,
  type SlabRow,
  errorText,
  isAbort,
} from "../api/client";
import { fmtAsOf, fmtRate, fmtRegions, fmtSlab, rateUnit } from "../api/computeImpact";
import { cnClass, fmtInr, isMaterial, money, pct, vol as litres } from "../format";
import type { DealerListTarget } from "./DealerList";
import { ColHead } from "./ColHead";
import { editHint, MIX_CHOICES } from "./editChoices";
import { ErrorBanner } from "./Feedback";
import { NumericInput } from "./NumericInput";
import { FIELD_LABEL, monthDealers, monthName, useMonthBlocks } from "./monthData";
import { edgeBounds } from "./editChoices";
import { fromMonthSlab, GoneSlabs, matchSlabs, SlabTag, Was, type SlabFigs } from "./compare";

/** Previous | Current | Next month side by side, as drawn on the whiteboard, with the columns of Book1:
 *  Product | Dealers | Volume | Product mix | GSR | CN % | CN | Impact.
 *
 *  - Previous: the settled month, read-only.
 *  - Current: the live month with this user's edits (Impact = edited CN − actual CN).
 *  - Next: the current month as shown, grown by V (the planned volume change), under the structure
 *    being edited (Impact = that CN − the same volumes under the served structure).
 *
 *  One table, three levels: a product opens its schemes; a scheme opens its slab tables inside each month's columns
 *  (each month its own table -- slab rows are not aligned across months). The Current column IS the editor:
 *  boundaries and rates are typed there. Every dealer count opens the dealers behind it, for that month. */
/** Figures per month block: Volume, Mix, GSR, CN %, CN (Impact is added once something is edited). */
const FIGS = 5;

/** Always on screen next to simulated figures (domain rule): rate and slab edits hold dealer volumes fixed, and a
 *  lower CN is the cost of a future structure, never money recovered. */
/** The table's explanations behind one button, open or closed as this browser last left it. */
function HowToRead({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    try { return window.localStorage.getItem("ui.help") === "open"; } catch { return false; }
  });
  const toggle = (v: boolean) => {
    setOpen(v);
    try { window.localStorage.setItem("ui.help", v ? "open" : "closed"); } catch { /* this visit only */ }
  };
  return (
    <div className="mv-help" onKeyDown={(e) => { if (e.key === "Escape") toggle(false); }}>
      <button type="button" className="btn sm mv-help-btn" aria-expanded={open} onClick={() => toggle(!open)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 7.2v4M8 4.6v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        How to read
      </button>
      {open && (
        <div className="mv-help-pop" role="region" aria-label="How to read this table">
          {children}
          <button type="button" className="btn sm" onClick={() => toggle(false)}>Close</button>
        </div>
      )}
    </div>
  );
}

export function HeldFixedNote() {
  return (
    <p className="held-note">
      Rate and slab edits hold dealer volumes fixed, so a rate increase likely costs more than shown (higher rates can
      also lift sales). A lower CN is what a revised structure would cost, not money recovered.
    </p>
  );
}

/** An Impact figure: higher CN in the cost colour, lower in the neutral "lower" colour (never a saving). */
function impact(n: number) {
  if (Math.abs(n) < 1) return <span className="muted">—</span>;
  return <span className={cnClass(n)}>{n > 0 ? "+" : "−"}{money(Math.abs(n))}</span>;
}

export type Scope = { zone: string[]; region: string[]; depot_code: string[]; label: string };

/** Editing one component's slab table in the Next column (user's choice, 3 Nov 2026): next month only. */
export interface NextSlabEdit {
  /** Next month has its own table for this component (else it follows the current month's). */
  own: boolean;
  /** Drop next month's own table: follow the current month's again. */
  onUseCurrent: () => void;
  onRate: (r: MonthSlabRow, rate: number) => void;
  /** A row's Volume, GSR, Mix, CN % or CN typed over; returns a sentence when refused. */
  onFig: (r: MonthSlabRow, field: "volume" | "gsr" | "mix" | "cn_pct" | "cn", from: number, to: number,
          compVolume: number, choice?: string) => string | void;
  figEdited: (r: MonthSlabRow, field: "volume" | "gsr" | "mix" | "cn_pct" | "cn") => boolean;
  onEdge: (from: number, value: number) => void;
  onAdd: (r: MonthSlabRow, rows: MonthSlabRow[]) => void;
  onRemove: (r: MonthSlabRow, rows: MonthSlabRow[]) => void;
}
export type Kind = "prev" | "cur" | "next";



/** A figure typed into the month table: which cell, what it showed, and the new value (Mix in %). */
export interface CellEdit {
  period: "current" | "next";
  level: "total" | "product" | "scheme";
  /** The product's name or the scheme's key ("" for the total). */
  key: string;
  /** cn: the CN in rupees (its rates scale to reach it: R for a product or the total, C for a scheme). */
  field: "volume" | "gsr" | "mix" | "cn_pct" | "cn";
  from: number | null;
  to: number;
  /** A product's GSR typed as a price change (volume stays) rather than as more sales. */
  asPrice?: boolean;
  /** A product's Mix typed as "volume grows": only that product sells more, so it is a Volume edit of the product
   *  (its volume and the month's total volume, to solve the litres from the share). */
  grow?: { volume: number; total: number };
  /** Internal: a "volume grows" Mix replaces the product's "total held" Mix edit (a share target) in that scope. */
  replacesMix?: boolean;
}

/** A product's GSR typed over: more sales at the dealer's own price, or a price change on the same litres. */
const GSR_CHOICES = [
  { value: "sales", label: "more sales", title: "Litres move with the rupees, at each dealer's own price; slabs follow" },
  { value: "price", label: "price", title: "Same litres at a new price: GSR, CN paid as a % of GSR and slabs in rupees move; slabs in litres and CN per litre stay" },
];

/** A number in the unit it is shown in: money Cr / L (lakh) / rupees; volume kL (thousand litres) / litres. */
function unitOf(n: number, money: boolean): [number, string] {
  const a = Math.abs(n);
  if (money) return a >= 1e7 ? [1e7, "Cr"] : a >= 1e5 ? [1e5, "L"] : [1, ""];
  return a >= 1e5 ? [1e3, "kL"] : [1, "litres"];
}

/** A figure that can be typed over: click it, type the new figure in the unit shown, Enter (Escape cancels).
 *  `onCommit` may return a sentence: the edit was refused, and the box stays open with the reason under it. */
export function EditNum({ value, money, isPct, edited, label, hint, onCommit, choices, children }: {
  value: number | null;
  money?: boolean;
  isPct?: boolean;
  edited: boolean;
  label: string;
  /** What typing here does, in a sentence (shown as the tooltip). */
  hint?: string;
  onCommit: (to: number, choice?: string) => string | void;
  /** What the typed figure means, when it can mean more than one thing (a product's GSR: more sales or a price). */
  choices?: { value: string; label: string; title: string }[];
  children: ReactNode;
}) {
  const [text, setText] = useState<string | null>(null);
  // What the box opened with: leaving it unchanged commits nothing (the rounded figure is not an edit).
  const [start, setStart] = useState<string | null>(null);
  const [choice, setChoice] = useState(choices?.[0]?.value);
  const [problem, setProblem] = useState<string | null>(null);
  /** Set by Enter / Escape, which settle the box themselves: a blur as it closes must not commit again. */
  const settled = useRef(false);
  const errId = useId();
  const [unit, suffix] = isPct ? [1, "%"] : unitOf(value ?? 0, Boolean(money));
  if (value == null) return <>{children}</>;
  const close = () => { settled.current = true; setText(null); setProblem(null); };
  if (text === null) {
    return (
      <button type="button" className={`mv-edit ${edited ? "is-edited" : ""}`}
              title={`${edited ? "Edited. " : ""}${hint ?? `Click to type a new ${label}`}`}
              aria-label={`${edited ? "Edited: " : ""}edit ${label}`}
              onClick={(e) => { e.stopPropagation(); const t = (value / unit).toFixed(2); settled.current = false; setText(t); setStart(t); }}>
        {children}
      </button>
    );
  }
  const commit = () => {
    const raw = text.trim().replace(/,/g, "");
    const v = Number(raw);
    if (raw === "" || raw === start) { close(); return; }
    if (!Number.isFinite(v)) { setProblem("Type a number, for example 12.5."); return; }
    if (Math.abs(v * unit - value) <= 1e-6 * Math.max(1, Math.abs(value))) { close(); return; }
    const refused = onCommit(v * unit, choice);
    if (refused) setProblem(refused); else close();
  };
  return (
    <span className="mv-edit-box" onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            if (settled.current) return;
            if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !problem) commit();
          }}>
      <input autoFocus type="text" inputMode="decimal" value={text} aria-label={`New ${label}`}
             aria-invalid={problem ? true : undefined} aria-describedby={problem ? errId : undefined}
             onFocus={(e) => e.currentTarget.select()}
             onChange={(e) => { setText(e.target.value); setProblem(null); }}
             onKeyDown={(e) => {
               if (e.key === "Enter") { commit(); }
               if (e.key === "Escape") close();
             }} />
      {suffix && <em>{suffix}</em>}
      {choices && (
        <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label={`What the new ${label} means`}
                title={choices.find((c) => c.value === choice)?.title}>
          {choices.map((c) => <option key={c.value} value={c.value} title={c.title}>{c.label}</option>)}
        </select>
      )}
      {problem && <span id={errId} className="mv-edit-err" role="alert">{problem}</span>}
    </span>
  );
}


/** One month's figures for a product, scheme or the total. */
type Fig = { volume: number | null; mix: number | null; gsr: number | null; cnPct: number | null; cn: number; impact: number };

/** Change from the month compared with: % for amounts, percentage points for shares, never the amount itself
 *  (user's choice, 12 Nov 2026; Scheme detail keeps the earlier month's figure). CN and CN % show only a material
 *  change (±1%, ±0.1 pp); Volume, Mix and GSR always, two decimals under 1%. */
function change(a: number | null | undefined, b: number | null | undefined, pp: boolean, isCn = false) {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || (!pp && a === 0)) return null;
  const x = pp ? b - a : (100 * (b - a)) / Math.abs(a);
  if (isCn ? !isMaterial(x, pp) : Math.abs(x) < 0.005) return null;
  // CN (and CN %) moving is money: higher is a cost (red), lower is "lower" (blue). Volume, GSR, Mix: up green.
  const tone = isCn ? (x > 0 ? "is-higher" : "is-lower") : x > 0 ? "up" : "down";
  const sign = x > 0 ? "+" : "−";
  const rel = `${sign}${Math.abs(x).toFixed(!isCn && Math.abs(x) < 1 ? 2 : 1)}${pp ? " pp" : "%"}`;
  return (
    <span className={`mv-delta ${tone}`}>
      <span aria-hidden="true">{x > 0 ? "▲" : "▼"}</span>
      {rel}
    </span>
  );
}

export function MonthsView({
  scope,
  rowsByScheme,
  schemeLabels,
  layouts,
  visibleKeys,
  removedKeys,
  growth,
  onGrowth,
  adjustments,
  nextAdjustments,
  products,
  onEditCell,
  isEdited,
  hasEdits,
  onRemoveScheme,
  onRestoreScheme,
  filtering,
  editedKeys,
  reviewKeys,
  onResetScheme,
  openSchemes,
  onToggleScheme,
  onCollapseAll,
  openProducts,
  onOpenProducts,
  onOpenDetail,
  renderEditor,
  onShowDealers,
  tools,
  trailing,
  viewSwitch,
  nextEditOf,
}: {
  /** The Next column's editing of a component (next month's own slab table), where it can be edited. */
  nextEditOf?: (key: string, component: string) => NextSlabEdit | undefined;
  scope: Scope;
  rowsByScheme: Record<string, SlabRow[]>;
  schemeLabels: Record<string, string>;
  /** "scheme::component" -> the edited slab table, for every component with an edit. */
  layouts: Record<string, SlabLayout>;
  /** The schemes the search and filters leave, in the chosen sort order. */
  visibleKeys: string[];
  /** Schemes the user deleted: left out of the table, paying nothing in the current and next month. */
  removedKeys: Set<string>;
  /** V: next month's volume change (%). */
  growth: number;
  onGrowth: (growth: number) => void;
  /** GSR / volume edits typed into the table: the current month's (carried into next) and next month's own. */
  adjustments: Adjustment[];
  nextAdjustments: Adjustment[];
  /** Products whose Volume, Mix and GSR can be edited (backend scenario.PRODUCTS). */
  products: string[];
  /** Returns a sentence when the edit is refused (shown under the cell). */
  onEditCell: (edit: CellEdit) => string | void;
  /** Whether a cell carries an edit made through the filters now on. */
  isEdited: (period: "current" | "next", level: CellEdit["level"], key: string, field: CellEdit["field"]) => boolean;
  /** Any edit at all, in any scope: the Impact columns show. */
  hasEdits: boolean;
  onRemoveScheme: (key: string) => void;
  onRestoreScheme: (key: string) => void;
  /** A search or filter is on: products holding a match open by themselves. */
  filtering: boolean;
  editedKeys: Set<string>;
  /** Schemes whose computed payout does not yet match the source file (provisional). */
  reviewKeys: Set<string>;
  onResetScheme: (key: string) => void;
  /** Schemes whose slab tables are open. */
  openSchemes: Set<string>;
  onToggleScheme: (key: string) => void;
  onCollapseAll: () => void;
  /** Products opened by hand (kept by the caller, so they are still open after a visit to Scheme detail). */
  openProducts: Set<string>;
  onOpenProducts: (next: Set<string>) => void;
  /** A scheme's (or a component's) name was clicked: show it in Scheme detail. */
  onOpenDetail: (key: string, component?: string) => void;
  /** The current month's editor of one component of a scheme (slab boundaries and rates), for the Current column. */
  renderEditor: (key: string, component: string) => ReactNode;
  onShowDealers: (target: DealerListTarget) => void;
  /** Sort and filter controls, shown in the header. */
  tools?: ReactNode;
  /** The Overall Schemes / Scheme detail switch, in the table's own toolbar. */
  viewSwitch?: ReactNode;
  /** Shown after Collapse all (Reset all). */
  trailing?: ReactNode;
}) {
  const { months, next, warnings, err, busyCur, busyNext, retry } =
    useMonthBlocks(scope, growth, layouts, removedKeys, adjustments, nextAdjustments);
  // The V box shows what is typed; when V changes from elsewhere (Reset, a version), it shows the new V.
  const [growthText, setGrowthText] = useState(String(growth));
  // A scheme's figures for its manager (or an ADMIN); product and total figures, V and Delete for an ADMIN only.
  const canEdit = useCanEdit();
  const [shownGrowth, setShownGrowth] = useState(growth);
  if (shownGrowth !== growth) {
    setShownGrowth(growth);
    setGrowthText(String(growth));
  }

  /** CN a scheme's edits move in the current month: simulated − actual. */
  const deltaOf = useMemo(() => {
    const d: Record<string, number> = {};
    for (const [k, rows] of Object.entries(rowsByScheme))
      d[k] = rows.reduce((a, r) => a + (r.simulated_cn ?? r.current_cn) - r.current_cn, 0);
    return d;
  }, [rowsByScheme]);

  /** Current month with this user's edits: each category's CN moves by its schemes' simulated − actual. */
  // (Named `actual`, not months.current: the React compiler reads a `.current` as a ref.)
  const actual = months?.current ?? null;
  const current = useMemo(() => {
    if (!actual) return null;
    const delta = (keys: string[]) => keys.reduce((t, k) => t + (deltaOf[k] ?? 0), 0);
    const rows = actual.rows.map((r) => ({
      ...r,
      simulated_cn: r.cn + delta(r.schemes),
      scheme_rows: r.scheme_rows.map((s) => ({ ...s, simulated_cn: s.cn + (deltaOf[s.scheme] ?? 0) })),
    }));
    const sim = rows.reduce((t, r) => t + r.simulated_cn, 0);
    return { ...actual, rows, total: { ...actual.total, simulated_cn: sim } };
  }, [actual, deltaOf]);

  if (!months || !current) {
    return err ? <ErrorBanner text={err} onRetry={retry} />
      : <p className="hint" role="status"><span className="spinner" aria-hidden="true" /> Loading months…</p>;
  }
  const prev = months.previous;
  const cats = current.rows.map((r) => r.category);
  for (const r of [...(prev?.rows ?? []), ...(next?.rows ?? [])]) if (!cats.includes(r.category)) cats.push(r.category);
  const find = (block: { rows: CategoryRow[] } | null | undefined, c: string) => block?.rows.find((r) => r.category === c);
  const order = new Map(visibleKeys.map((k, i) => [k, i]));

  /** A product's schemes in the sort order; with a filter on, only the matches. */
  const schemesOf = (c: string) => {
    const keys: string[] = [];
    for (const b of [current, prev, next]) for (const s of find(b, c)?.scheme_rows ?? []) if (!keys.includes(s.scheme)) keys.push(s.scheme);
    return keys
      .filter((k) => !removedKeys.has(k) && (!filtering || order.has(k)))
      .sort((a, b) => (order.get(a) ?? 1e6) - (order.get(b) ?? 1e6));
  };
  const productOpen = (c: string) =>
    openProducts.has(c) || (filtering && schemesOf(c).length > 0) || schemesOf(c).some((k) => openSchemes.has(k));
  const toggleProduct = (c: string) => {
    const n = new Set(openProducts);
    if (productOpen(c)) n.delete(c); else n.add(c);
    onOpenProducts(n);
  };

  // Impact columns appear only once something is edited; until then they would be a column of dashes.
  const showImpact = editedKeys.size > 0 || hasEdits;
  // One Impact column pinned after Product (Current over Next), not one per month block.
  const lead = showImpact ? 3 : 2;
  const cols = lead + FIGS * 3;
  // Each change is the figure shown against the figure shown in the month before (user's rule, 4 Nov 2026). No
  // pace by days elapsed: Nov'26 v5 is dated day 4 but holds about a full month, and x 30 / 4 put +535% under a CN
  // that had barely moved. Next is the current month x (1 + V), so its change is what V and the edits make.
  const totalVolume = { prev: prev?.total.volume, cur: current.total.volume, next: next?.total.volume };

  const catFig = (r: CategoryRow | undefined, kind: Kind): Fig | null => {
    if (!r) return null;
    const cn = kind === "prev" ? r.cn : r.simulated_cn;
    const whole = r.category.startsWith("Value & Early Bird");
    return {
      volume: r.volume, mix: r.mix_pct, gsr: r.gsr, cn, impact: r.simulated_cn - r.cn,
      cnPct: !whole && r.gsr ? (100 * cn) / r.gsr : kind === "prev" ? r.cn_pct : r.simulated_cn_pct,
    };
  };
  /** Product mix of a scheme: its volume against all products' volume that month (add-ons repeat a base's sales). */
  const schemeFig = (s: SchemeMonthRow | undefined, kind: Kind): Fig | null => {
    if (!s) return null;
    const cn = kind === "prev" ? s.cn : s.simulated_cn;
    const all = totalVolume[kind];
    return {
      volume: s.volume, gsr: s.gsr, cn, impact: s.simulated_cn - s.cn,
      mix: s.counts && s.volume && all ? (100 * s.volume) / all : null,
      cnPct: s.gsr ? (100 * cn) / s.gsr : null,
    };
  };
  const totalFig = (t: MonthBlock["total"] | NextMonthBlock["total"] | undefined, kind: Kind): Fig | null => {
    if (!t) return null;
    const cn = kind === "prev" ? t.cn : t.simulated_cn;
    return { volume: t.volume, mix: 100, gsr: t.gsr, cn, cnPct: t.gsr ? (100 * cn) / t.gsr : null, impact: t.simulated_cn - t.cn };
  };

  /** One month block's cells. Current is compared with Previous, Next with Current, each as shown.
   *  With `edit`, Volume, GSR and CN (and Mix and CN % for a product) of the Current and Next blocks can be typed over. */
  const figCells = (f: Fig | null, kind: Kind, from: Fig | null = null, addon = false,
                    edit?: { level: CellEdit["level"]; key: string; mix?: boolean }) => {
    const tint = `mv-c-${kind}`;
    if (!f) return <td className={`num muted mv-first ${tint}`} colSpan={FIGS}>—</td>;
    const amt = (k: "volume" | "gsr" | "cn") =>
      kind === "prev" || !from ? null
        : change(from[k], f[k], false, k === "cn");
    const pts = (k: "mix" | "cnPct") => (kind === "prev" || !from ? null : change(from[k], f[k], true, k === "cnPct"));
    const title = addon ? "An add-on: the same sales as the product's own scheme, so not added to the product" : undefined;
    const period = kind === "cur" ? "current" : "next";
    const editable = kind !== "prev" && edit && (edit.level === "scheme" ? canEdit(edit.key) : canEdit());
    const product = Boolean(editable && edit.mix);
    // A scheme's Mix and CN % are editable too (user's request, 3 Nov 2026): CN % scales its rates (mode C, as its
    // CN); Mix is "volume grows" only -- an add-on repeats its base's sales, so it has no mix of its own to type.
    const scheme = Boolean(editable && edit.level === "scheme");
    const cell = (field: CellEdit["field"], value: number | null, shown: ReactNode, opts: { money?: boolean; isPct?: boolean }) =>
      editable && ((field !== "mix" && field !== "cn_pct") || product || (scheme && value != null)) ? (
        <EditNum value={value} {...opts} edited={isEdited(period, edit.level, edit.key, field)}
                 label={`${FIELD_LABEL[field]}, ${edit.key || "total"}, ${period} month`}
                 hint={editHint(edit.level, field)}
                 choices={field === "gsr" && product ? GSR_CHOICES : field === "mix" && product ? MIX_CHOICES : undefined}
                 onCommit={(to, choice) => onEditCell({ period, level: edit.level, key: edit.key, field, from: value, to,
                                                        asPrice: choice === "price",
                                                        grow: field === "mix" && (choice === "grow" || scheme) && f.volume && totalVolume[kind]
                                                          ? { volume: f.volume, total: totalVolume[kind]! } : undefined })}>
          {shown}
        </EditNum>
      ) : shown;
    return (
      <>
        <td className={`num mv-first ${tint} ${addon ? "muted" : ""}`} title={title}>
          {cell("volume", f.volume, litres(f.volume), {})}{!addon && amt("volume")}
        </td>
        <td className={`num ${tint}`}>{cell("mix", f.mix, pct(f.mix), { isPct: true })}{pts("mix")}</td>
        <td className={`num ${tint} ${addon ? "muted" : ""}`} title={title}>
          {cell("gsr", f.gsr, money(f.gsr), { money: true })}{!addon && amt("gsr")}
        </td>
        <td className={`num ${tint}`}>{cell("cn_pct", f.cnPct, pct(f.cnPct), { isPct: true })}{pts("cnPct")}</td>
        <td className={`num ${tint}`}>{cell("cn", f.cn, money(f.cn), { money: true })}{amt("cn")}</td>
      </>
    );
  };
  /** The pinned Impact cell, the current month's over next month's. */
  const impactCell = (cur: Fig | null, nxt: Fig | null) => !showImpact ? null : (
    <td className="num mv-impact">
      {cur ? impact(cur.impact) : <span className="muted">—</span>}
      <span className="mv-impact-next">{nxt ? impact(nxt.impact) : <span className="muted">—</span>}</span>
    </td>
  );
  const dealersCell = (...rows: ({ dealers: number | null } | null | undefined)[]) => {
    const d = rows.find((r) => r?.dealers != null)?.dealers;
    return <td className="num">{d != null ? fmtInr(d) : "—"}</td>;
  };

  const busy = { prev: false, cur: busyCur, next: busyNext || !next };
  const head = (label: string, sub: string, kind: Kind, extra?: ReactNode) => (
    <th colSpan={FIGS} className={`mv-month is-${kind}`} scope="colgroup" aria-busy={busy[kind] || undefined}>
      <span>{label}{busy[kind] && <span className="mv-busy"><span className="spinner" aria-hidden="true" /> updating…</span>}</span>
      <em>{sub}</em>
      {extra}
    </th>
  );
  const subHeads = (kind: Kind, title: { cn: string; impact?: string }) => (
    <>
      <th className={`num mv-first mv-c-${kind}`} title="Litres; kL = thousand litres"><ColHead name="Volume" unit="litres" /></th>
      <th className={`num mv-c-${kind}`} title="Product mix: this volume ÷ the volume of all products that month"><ColHead name="Product Mix" unit="%" /></th>
      <th className={`num mv-c-${kind}`} title="GSR: sales in rupees, net of the in-bill discount. Cr = crore, L = lakh"><ColHead name="GSR" unit="₹" /></th>
      <th className={`num mv-c-${kind}`} title="CN (credit note) as a % of GSR"><ColHead name="CN" unit="% of GSR" /></th>
      <th className={`num mv-c-${kind}`} title={`CN (credit note) in rupees: ${title.cn}`}><ColHead name="CN" unit="₹" /></th>
    </>
  );
  const curSub = [current.complete ? "settled" : `day ${current.elapsed_days} of ${current.month_days} · your edits`,
                  fmtAsOf(current.as_of, current.version)].filter(Boolean).join(" · ");
  const prevSub = prev ? ["settled · read-only", fmtAsOf(prev.as_of, prev.version)].filter(Boolean).join(" · ")
                       : "no file on this server";
  const nextSub = next
    ? `plan · ${monthName(next.from_month)}${growth ? ` × (1 ${growth > 0 ? "+" : "−"} ${Math.abs(growth)}%)` : " as shown"}`
    : "plan · calculating…";
  const anyOpen = openProducts.size > 0 || openSchemes.size > 0;
  /** Next month's volume change (V), in the Next month's header. */
  const vInput = (
    <label className="mv-input mv-v" title="Next month's volume change against the current month">
      <span>V</span>
      <span className="mv-input-box">
        <input
          type="number" step={1} min={-50} max={100} value={growthText} disabled={!canEdit()}
          title={canEdit() ? undefined : "Only an administrator can change V"}
          onChange={(e) => setGrowthText(e.target.value)}
          onBlur={(e) => {
            // The box's own text, not growthText: Escape has just put it back, and state is not updated yet.
            const raw = e.currentTarget.value, v = Number(raw);
            if (raw.trim() !== "" && Number.isFinite(v) && v > -100) { if (v !== growth) onGrowth(v); }
            else setGrowthText(String(growth));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            // Escape cancels: the box shows V as it was, and the blur that follows has nothing new to commit.
            if (e.key === "Escape") {
              const was = String(growth);
              setGrowthText(was);
              (e.target as HTMLInputElement).value = was;
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label="Next month volume change, percent"
        />
        <em>%</em>
      </span>
    </label>
  );
  const productEdit = (c: string) => (products.includes(c) ? { level: "product" as const, key: c, mix: true } : undefined);

  return (
    <section className="months card-viz" aria-label="Previous, current and next month">
      <header className="mv-head mv-bar">
        {viewSwitch}
        <HowToRead>
          <p>By product. Click a product for its schemes; a scheme's ▸ opens its slab tables here and its name opens
            it in Scheme detail. Value and Early Bird pay on the whole book, so they show CN only.</p>
          <p>Click a figure in Current or Next to type a new value. Under each figure: its change from the month
            before. Volume, Mix and GSR: <b className="ok">green when higher</b>, <b className="cost">red when
            lower</b>. CN and CN %, from 1% (0.1 pp): <b className="cost">red when higher</b>,
            <b className="lower"> blue when lower</b>.</p>
          <ul>
            <li><b>Total</b> Volume or GSR moves every product in proportion; the total's CN ₹ scales every rate.</li>
            <li><b>A product's</b> Volume or GSR moves only that product (a GSR can also be typed as a price change,
              same litres). Its Mix moves sales between products with the total held, or with "volume grows" only
              that product sells more. Its CN % or CN ₹ scales the product's rates.</li>
            <li><b>A scheme's</b> Volume or GSR moves only that scheme; its CN ₹ scales its rates.</li>
            <li><b>Slab tables</b>: in Current, boundaries, rates and figures change the current month (next month
              follows). In Next they change next month only.</li>
            <li>Dealers who cross a slab boundary move slab. An edit covers the dealers in the filters now on.</li>
          </ul>
          <HeldFixedNote />
        </HowToRead>
        <span className="mv-hint">Click a Current or Next figure to edit it.</span>
        <div className="mv-tools">
          {tools}
          <button className="btn sm" disabled={!anyOpen}
                  onClick={() => { onOpenProducts(new Set()); onCollapseAll(); }}>
            Collapse all
          </button>
          {trailing}
        </div>
      </header>
      {showImpact && <HeldFixedNote />}
      {warnings.length + (next?.warnings?.length ?? 0) > 0 && (
        <ul className="sc-warn">
          {[...new Set([...warnings, ...(next?.warnings ?? [])])].map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}

      {removedKeys.size > 0 && (
        <p className="mv-removed">
          <b>Deleted schemes</b> (pay nothing in the current and next month; volume and GSR stay):
          {[...removedKeys].map((k) => (
            <span key={k} className="chip mv-chip">
              {schemeLabels[k] ?? k}
              <button type="button" className="mv-reset" aria-label={`Restore ${schemeLabels[k] ?? k}`}
                      onClick={() => onRestoreScheme(k)}>
                Restore
              </button>
            </span>
          ))}
        </p>
      )}

      {err && <ErrorBanner text={err} onRetry={retry} />}
      <div className="mv-scroll">
        <table className={`mv-table ${busyCur ? "busy-cur" : ""} ${busyNext ? "busy-next" : ""}`}>
          <thead>
            <tr>
              <th rowSpan={2} className="mv-product" scope="col">Product · scheme</th>
              {showImpact && (
                <th rowSpan={2} className="num mv-impact" scope="col"
                    title="Your edits: the current month's edited CN − actual CN, and below it next month's planned CN − CN under the current structure">
                  <ColHead name="Impact" unit={`${monthName(current.month).split(" ")[0]} · ${next ? monthName(next.month).split(" ")[0] : "next"}`} />
                </th>
              )}
              <th rowSpan={2} className="num mv-dealers" scope="col" title="Dealers in the current month"><ColHead name="Dealers" unit="count" /></th>
              {head(`Previous · ${prev ? monthName(prev.month) : "—"}`, prevSub, "prev")}
              {head(`Current · ${monthName(current.month)}`, curSub, "cur")}
              {head(`Next · ${next ? monthName(next.month) : "—"}`, nextSub, "next", vInput)}
            </tr>
            <tr>
              {subHeads("prev", { cn: "Credit note as settled" })}
              {subHeads("cur", { cn: "With your edits", impact: "Your edits: edited CN − actual CN" })}
              {subHeads("next", { cn: "Planned volumes under the structure you are editing", impact: "Your edits on next month's volumes: planned CN − CN under the current structure" })}
            </tr>
          </thead>
          <tbody>
            {cats.map((c) => {
              const cur = find(current, c);
              const keys = schemesOf(c);
              if (filtering && keys.length === 0) return null;
              const expandable = keys.length > 0;
              const isOpen = expandable && productOpen(c);
              const products = { prev: find(prev, c), cur, next: find(next, c) };
              return (
                <Fragment key={c}>
                  <tr className={`mv-cat ${isOpen ? "is-picked" : ""} ${expandable ? "is-clickable" : ""}`}
                      onClick={() => expandable && toggleProduct(c)}>
                    <th scope="row" className="mv-product">
                      {expandable ? (
                        <button type="button" className="mv-toggle" aria-expanded={isOpen}
                                onClick={(e) => { e.stopPropagation(); toggleProduct(c); }}>
                          <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span> {c}
                        </button>
                      ) : c}
                    </th>
                    {impactCell(catFig(cur, "cur"), catFig(products.next, "next"))}
                    {dealersCell(cur, products.prev, products.next)}
                    {figCells(catFig(products.prev, "prev"), "prev")}
                    {figCells(catFig(cur, "cur"), "cur", catFig(products.prev, "prev"), false,
                              productEdit(c))}
                    {figCells(catFig(products.next, "next"), "next", catFig(cur, "cur"), false, productEdit(c))}
                  </tr>
                  {isOpen && keys.map((k) => {
                    const label = schemeLabels[k] ?? k;
                    const live = k in rowsByScheme;
                    const open = live && openSchemes.has(k);
                    const of = (b: CategoryRow | undefined) => b?.scheme_rows.find((s) => s.scheme === k);
                    return (
                      <Fragment key={k}>
                        <tr id={`mv-scheme-${k}`}
                            className={`mv-scheme-row ${open ? "is-open" : ""} ${live ? "is-clickable" : ""}`}
                            onClick={() => live && onToggleScheme(k)}>
                          <th scope="row" className="mv-product mv-indent">
                            {live ? (
                              <>
                                {/* The arrow (and the rest of the row) opens the slabs here; the name opens Scheme detail. */}
                                <button type="button" className="mv-toggle" aria-expanded={open}
                                        aria-label={`${open ? "Collapse" : "Expand"} ${label} slabs here`}
                                        title={`${open ? "Hide" : "Show"} the slab tables here`}
                                        onClick={(e) => { e.stopPropagation(); onToggleScheme(k); }}>
                                  <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                                </button>
                                <button type="button" className="mv-toggle mv-name-link"
                                        title="Open this scheme in Scheme detail"
                                        onClick={(e) => { e.stopPropagation(); onOpenDetail(k); }}>
                                  {label}
                                </button>
                              </>
                            ) : <span title="Not running in the current month">{label}</span>}
                            {reviewKeys.has(k) && (
                              <span className="badge needs_review mv-chip"
                                    title="Computed payout does not yet match the source file — treat as provisional">Review</span>
                            )}
                            {editedKeys.has(k) && (
                              <>
                                <span className="chip chip-note mv-chip">edited</span>
                                <button type="button" className="mv-reset"
                                        onClick={(e) => { e.stopPropagation(); onResetScheme(k); }}>
                                  Reset
                                </button>
                              </>
                            )}
                            {live && canEdit() && (
                              <button type="button" className="mv-reset mv-delete"
                                      title="Delete this scheme: it pays nothing in the current and next month. Restore it from the list above the table."
                                      aria-label={`Delete ${label}`}
                                      onClick={(e) => { e.stopPropagation(); onRemoveScheme(k); }}>
                                Delete
                              </button>
                            )}
                          </th>
                          {impactCell(schemeFig(of(cur), "cur"), schemeFig(of(products.next), "next"))}
                          {dealersCell(of(cur), of(products.prev), of(products.next))}
                          {figCells(schemeFig(of(products.prev), "prev"), "prev", null, !of(products.prev)?.counts)}
                          {figCells(schemeFig(of(cur), "cur"), "cur", schemeFig(of(products.prev), "prev"), !of(cur)?.counts,
                                    live ? { level: "scheme", key: k } : undefined)}
                          {figCells(schemeFig(of(products.next), "next"), "next", schemeFig(of(cur), "cur"), !of(products.next)?.counts,
                                    live ? { level: "scheme", key: k } : undefined)}
                        </tr>
                        {open && (
                          <SchemeSlabRows
                            schemeKey={k}
                            schemeLabel={label}
                            rows={rowsByScheme[k] ?? []}
                            scope={scope}
                            growth={growth}
                            layouts={layouts}
                            adjustments={adjustments}
                            nextAdjustments={nextAdjustments}
                            prevMonth={prev?.month ?? null}
                            curMonth={current.month}
                            nextMonth={next?.month ?? null}
                            spans={{ prev: FIGS, cur: FIGS, next: FIGS }}
                            lead={lead}
                            editor={(comp) => renderEditor(k, comp)}
                            nextEdit={nextEditOf ? (comp) => nextEditOf(k, comp) : undefined}
                            onShowDealers={onShowDealers}
                            onOpenDetail={(comp) => onOpenDetail(k, comp)}
                          />
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
            {filtering && visibleKeys.length === 0 && (
              <tr><td colSpan={cols} className="hint">No schemes match this selection.</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="mv-product">Total</th>
              {impactCell(totalFig(current.total, "cur"), totalFig(next?.total, "next"))}
              <td className="num">{fmtInr(current.total.dealers)}</td>
              {figCells(totalFig(prev?.total, "prev"), "prev")}
              {figCells(totalFig(current.total, "cur"), "cur", totalFig(prev?.total, "prev"), false, { level: "total", key: "" })}
              {figCells(totalFig(next?.total, "next"), "next", totalFig(current.total, "cur"), false, { level: "total", key: "" })}
            </tr>
          </tfoot>
        </table>
      </div>
      {current.rows.some((r) => r.category === "Other products" && (r.gsr ?? 0) < 0) || prev?.rows.some((r) => r.category === "Other products" && (r.gsr ?? 0) < 0) ? (
        <p className="hint">
          A negative "Other products" GSR means two product schemes count some of the same sales, so the products add up
          to more than the dealers' book (GSR = Value + Value % + Timbra).
        </p>
      ) : null}
    </section>
  );
}

/** One scheme opened in the month table: per component, its slab table inside each month's columns. The Current
 *  cell is the editor itself; a component the current month does not run shows the read-only table. */
function SchemeSlabRows({
  schemeKey, schemeLabel, rows, scope, growth, layouts, adjustments, nextAdjustments, prevMonth, curMonth, nextMonth,
  spans, editor, onShowDealers, onOpenDetail, nextEdit, lead = 2,
}: {
  /** Columns before the month blocks: Product and Dealers, plus the pinned Impact once something is edited. */
  lead?: number;
  /** The Next column's editing of a component, where it can be edited. */
  nextEdit?: (component: string) => NextSlabEdit | undefined;
  adjustments: Adjustment[];
  nextAdjustments: Adjustment[];
  /** Columns each month block spans in the month table. */
  spans: Record<Kind, number>;
  schemeKey: string;
  schemeLabel: string;
  rows: SlabRow[];
  scope: Scope;
  growth: number;
  layouts: Record<string, SlabLayout>;
  prevMonth: string | null;
  curMonth: string;
  nextMonth: string | null;
  editor: (component: string) => ReactNode;
  onShowDealers: (target: DealerListTarget) => void;
  /** A component's name: its slab table in Scheme detail. */
  onOpenDetail: (component: string) => void;
}) {
  const [data, setData] = useState<SchemeMonths | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const layoutsKey = JSON.stringify(layouts);
  const editsKey = JSON.stringify([adjustments, nextAdjustments]);
  useEffect(() => {
    let live = true;
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      const [adjs, nextAdjs] = JSON.parse(editsKey) as [Adjustment[], Adjustment[]];
      api.schemeMonths({ ...scope, scheme: schemeKey, volume_growth_pct: growth, layouts: JSON.parse(layoutsKey),
                         adjustments: adjs, next_adjustments: nextAdjs }, ctrl.signal)
        .then((x) => { if (live) { setData(x); setErr(null); } })
        .catch((e) => { if (live && !isAbort(e)) setErr(errorText(e)); });
    }, 400);
    return () => { live = false; window.clearTimeout(t); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemeKey, growth, layoutsKey, editsKey, attempt, scope.zone.join("|"), scope.region.join("|"), scope.depot_code.join("|")]);

  // The scheme's main slab table first: components by GSR, then by volume; components only the previous month ran
  // come last.
  const weight = new Map<string, [number, number]>();
  for (const r of rows) {
    if (r.slab_mode === "unrated") continue;
    const w = weight.get(r.component) ?? [0, 0];
    weight.set(r.component, [w[0] + (r.gsr ?? 0), w[1] + (r.volume ?? 0)]);
  }
  const comps = [...weight.entries()].sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]).map(([c]) => c);
  for (const c of Object.keys(data?.previous?.components ?? {})) if (!comps.includes(c)) comps.push(c);

  const show = (r: MonthSlabRow, kind: "previous" | "next", month: string | null) =>
    onShowDealers(monthDealers({ schemeKey, schemeLabel, row: r, kind, month, scope, layouts, growth }));

  return (
    <>
      {err && (
        <tr className="mv-comp-row">
          <td colSpan={lead + spans.prev + spans.cur + spans.next}>
            <ErrorBanner text={`The previous and next month slab tables of ${schemeLabel} did not load. ${err}`}
                         onRetry={() => setAttempt((n) => n + 1)} />
          </td>
        </tr>
      )}
      {comps.map((comp) => {
        const live = rows.filter((r) => r.component === comp);
        const nextComp = data?.next.components[comp];
        const prevRows = data ? data.previous?.components[comp] ?? null : undefined;
        const nextRows = data ? nextComp?.rows ?? null : undefined;
        return (
          <tr key={comp} id={`mv-comp-${schemeKey}::${comp}`} className="mv-comp-row">
            <th scope="row" colSpan={lead} className="mv-product mv-indent-2">
              <button type="button" className="mv-toggle mv-name-link mv-comp-link"
                      title="Open this slab table in Scheme detail" onClick={() => onOpenDetail(comp)}>
                {comp}
              </button>
            </th>
            <td colSpan={spans.prev} className="mv-first mv-slab-cell mv-c-prev">
              <SlabTable rows={prevRows} onDealers={(r) => show(r, "previous", prevMonth)} />
            </td>
            <td colSpan={spans.cur} className="mv-first mv-slab-cell mv-cur-cell mv-c-cur" aria-label={`Current · ${monthName(curMonth)}`}>
              {live.length ? editor(comp) : <p className="hint">Not in this month.</p>}
            </td>
            <td colSpan={spans.next} className="mv-first mv-slab-cell mv-c-next">
              <SlabTable rows={nextRows} total={nextComp?.impact} withImpact edit={nextEdit?.(comp)}
                         onDealers={(r) => show(r, "next", nextMonth)} />
            </td>
          </tr>
        );
      })}
    </>
  );
}


export function SlabTable({ rows, withImpact, impacts, total, onDealers, className = "mv-small", edit, compare }: {
  /** Scheme detail: the month compared with, its rows of this component and its name. */
  compare?: { base: SlabFigs[]; month: string };
  /** Next month: the table can be edited (rates, boundaries and figures), next month only. */
  edit?: NextSlabEdit;
  /** undefined = loading; null = this component is not in that month. */
  rows: MonthSlabRow[] | null | undefined;
  withImpact?: boolean;
  impacts?: number[];
  total?: number;
  /** Open the dealers behind a row. */
  onDealers?: (row: MonthSlabRow, index: number) => void;
  className?: string;
}) {
  // Dealer names: ADMIN only (a VIEWER sees the count, not the list).
  const { canSeeDealers } = useUser();
  // A component without a slab table (per-dealer targets, per-100 L offers) is one band; its rows are rate tiers.
  const label = (r: MonthSlabRow) =>
    r.slab_mode === "unrated" ? "Not qualified"
      : r.slab_mode === "target" || ((r.slab_lower ?? 0) <= 0 && r.slab_upper == null)
        ? `rate ${fmtRate(r.rate, r.formula, r.pack_size)}`
        : fmtSlab(r.slab_lower ?? 0, r.slab_upper);
  const sum = (k: "dealers" | "volume" | "gsr" | "cn") => (rows ?? []).reduce((t, r) => t + r[k], 0);
  const totalImpact = total ?? (impacts ?? []).reduce((t, x) => t + x, 0);
  if (rows === undefined) return <p className="hint">Loading…</p>;
  if (rows === null || rows.length === 0) return <p className="hint">Not in this month.</p>;
  const allRegions = [...new Set(rows.flatMap((r) => r.regions ?? []))].sort();
  const byRegion = rows.some((r) => (r.regions?.length ?? 0) !== allRegions.length);
  const compVolume = sum("volume");
  // Editing (next month): every boundary of the table for the legal range of each box; with several rate cards a
  // band shows one row per rate, and its boxes sit on the first of them.
  const cuts = [...new Set(rows.filter((r) => r.slab_mode === "slab").flatMap((r) => [r.slab_lower, r.slab_upper])
    .filter((v): v is number => v != null && v > 0))].sort((a, b) => a - b);
  const firstOfRange = new Set<number>();
  const seenRange = new Set<string>();
  rows.forEach((r, i) => {
    if (r.slab_mode !== "slab") return;
    const k = `${r.slab_lower}|${r.slab_upper}`;
    if (!seenRange.has(k)) { seenRange.add(k); firstOfRange.add(i); }
  });
  const rangeOf = (r: MonthSlabRow) => fmtSlab(r.slab_lower ?? 0, r.slab_upper);
  const cmp = compare ? matchSlabs(rows.map(fromMonthSlab), compare.base) : null;
  const baseVolume = (compare?.base ?? []).reduce((t, b) => t + b.volume, 0);
  const baseOf = (b: SlabFigs | undefined) => b && {
    dealers: b.dealers, volume: b.volume, gsr: b.gsr, cn: b.cn,
    mix: baseVolume ? (100 * b.volume) / baseVolume : null, cnPct: b.gsr ? (100 * b.cn) / b.gsr : null,
  };
  type CmpKey = "dealers" | "volume" | "gsr" | "cn" | "mix" | "cnPct";
  const wasOf = (from: ReturnType<typeof baseOf>, k: CmpKey, to: number | null, f: (n: number) => string) =>
    cmp?.ready && compare ? <Was from={from?.[k]} to={to} fmt={f} pp={k === "mix" || k === "cnPct"}
                                 cost={k === "cn" || k === "cnPct"} month={compare.month} /> : null;
  const was = (i: number, k: CmpKey, to: number | null, f: (n: number) => string) => wasOf(baseOf(cmp?.of(i)), k, to, f);
  const baseTotal = compare?.base.length ? baseOf({ ...compare.base[0], dealers: compare.base.reduce((t, b) => t + b.dealers, 0),
    volume: baseVolume, gsr: compare.base.reduce((t, b) => t + b.gsr, 0), cn: compare.base.reduce((t, b) => t + b.cn, 0) }) : undefined;
  const slabCell = (r: MonthSlabRow, i: number) => {
    if (!edit || r.slab_mode === "unrated") return label(r);
    if (r.slab_mode === "target") {
      return (
        <span className="slab-edit">
          <span>{label(r)}</span>
          <button type="button" className="slab-btn" title="Add a slab boundary for next month: the component becomes a slab table"
                  aria-label="Add a slab boundary, next month" onClick={() => edit.onAdd(r, rows)}>+</button>
        </span>
      );
    }
    if (!firstOfRange.has(i)) return <span className="slab-same" title="The same slab as the row above, at another region's rate">{label(r)} · same slab</span>;
    const lo = r.slab_lower ?? 0;
    return (
      <span className="slab-edit">
        {lo <= 0 ? <span className="fixed-end">0</span> : (
          <NumericInput asText shown={fmtInr(Math.round(lo))} value={Math.round(lo)} {...edgeBounds(cuts, lo)}
                        onCommit={(v) => edit.onEdge(lo, v)} title="Start of this slab next month (also the end of the previous one)"
                        ariaLabel="Next month slab start" />
        )}
        <span className="dash">–</span>
        {r.slab_upper == null ? <span className="fixed-end">∞</span> : (
          <NumericInput asText shown={fmtInr(Math.round(r.slab_upper))} value={Math.round(r.slab_upper)}
                        {...edgeBounds(cuts, r.slab_upper)} onCommit={(v) => edit.onEdge(r.slab_upper ?? 0, v)}
                        title="End of this slab next month (also the start of the next one)" ariaLabel="Next month slab end" />
        )}
        <button type="button" className="slab-btn" title="Split this slab in two, next month"
                aria-label={`Split this slab in two (${rangeOf(r)}), next month`} onClick={() => edit.onAdd(r, rows)}>+</button>
        {seenRange.size > 1 && (
          <button type="button" className="slab-btn"
                  title={lo <= 0 ? "Remove this slab next month: there is no slab below, so its dealers earn nothing"
                    : "Remove this slab next month: its dealers drop to the slab below"}
                  aria-label={`Remove this slab (${rangeOf(r)}), next month`} onClick={() => edit.onRemove(r, rows)}>×</button>
        )}
      </span>
    );
  };
  /** A figure of a next-month row, typed over where it can be (a CN needs a rate to scale). */
  const fig = (r: MonthSlabRow, field: "volume" | "gsr" | "mix" | "cn_pct" | "cn", value: number | null, shown: ReactNode) =>
    edit && r.slab_mode !== "unrated" && value != null && value > 0
    && (field === "cn" || field === "cn_pct" ? r.rate > 0 && (field === "cn" || r.gsr > 0) : field !== "mix" || value < 100) ? (
      <EditNum value={value} money={field === "gsr" || field === "cn"} isPct={field === "mix" || field === "cn_pct"}
               edited={edit.figEdited(r, field)} label={`${FIELD_LABEL[field]}, ${r.component} ${rangeOf(r)}, next month`}
               hint={field === "cn" || field === "cn_pct" ? "Next month only: this slab's rate scales until it pays the figure you type."
                 : field === "mix" ? "Next month only: this slab's share of the component's volume."
                   : `Next month only: the ${FIELD_LABEL[field]} of this slab's dealers in this scheme; they may cross slabs.`}
               choices={field === "mix" ? MIX_CHOICES : undefined}
               onCommit={(to, choice) => edit.onFig(r, field, value, to, compVolume, choice)}>
        {shown}
      </EditNum>
    ) : shown;
  const rateCell = (r: MonthSlabRow) => r.slab_mode === "unrated" ? <span className="muted">—</span> : (
    <>
      <NumericInput asText shown={fmtRate(r.rate, r.formula, r.pack_size)} edited={r.rate !== r.cn_rate} value={r.rate}
                    step={0.25} min={0} format={(v) => String(Math.round(v * 1e6) / 1e6)}
                    onCommit={(v) => edit!.onRate(r, v)} ariaLabel="New next month rate"
                    title="The rate paid in this slab next month: type a new one (next month only)" />
      {r.rate !== r.cn_rate && <em className="muted was">was {fmtRate(r.cn_rate, r.formula, r.pack_size)}</em>}
    </>
  );
  return (
    <>
    {edit && (
      <p className="next-own">
        {edit.own ? (
          <>
            <span className="chip chip-note" title="Next month has its own slab table for this component; the current month's edits no longer change it">next month's own slabs</span>
            <button type="button" className="mv-reset" onClick={edit.onUseCurrent}
                    title="Drop next month's own table: it follows the current month's again">Use current month's</button>
          </>
        ) : <span className="muted">Follows the current month's slabs until you edit them here (next month only).</span>}
      </p>
    )}
    <table className={`${className} ${edit ? "mv-edit-table" : ""}`}>
      <thead>
        <tr>
          <th><ColHead name="Slab" /></th>
          <th className="num" title="Click a count to see those dealers"><ColHead name="Dealers" unit="count" /></th>
          <th className="num" title="Litres; kL = thousand litres"><ColHead name="Volume" unit="litres" /></th>
          <th className="num" title="Slab volume ÷ the component's volume"><ColHead name="Product Mix" unit="%" /></th>
          <th className="num" title="GSR: sales in rupees, net of the in-bill discount. Cr = crore, L = lakh"><ColHead name="GSR" unit="₹" /></th>
          {edit && <th className="num edit-col" title="The rate paid in this slab next month: type a new one"><ColHead name="Rate" unit={rateUnit(rows[0].formula, rows[0].pack_size)} /></th>}
          <th className="num" title="CN (credit note) as a % of GSR"><ColHead name="CN" unit="% of GSR" /></th>
          <th className="num"><ColHead name="CN" unit="₹" /></th>
          {withImpact && <th className="num"><ColHead name="Impact" unit="₹" /></th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.slab_index}-${r.rate}-${i}`} className={edit && r.rate !== r.cn_rate ? "edited" : undefined}>
            <td className={edit ? "slab" : undefined}>
              {slabCell(r, i)}
              <SlabTag m={cmp} i={i} />
              {byRegion && r.regions && (
                <div className="slab-regions" title={r.regions.join(", ")}>
                  {fmtRegions(r.regions, allRegions)}
                </div>
              )}
            </td>
            <td className="num">
              {onDealers && canSeeDealers && r.dealers > 0 ? (
                <button type="button" className="link-num" onClick={() => onDealers(r, i)}
                        aria-label={`${fmtInr(r.dealers)} dealers in ${label(r)}: show them`}>
                  {fmtInr(r.dealers)}
                </button>
              ) : fmtInr(r.dealers)}
              {was(i, "dealers", r.dealers, fmtInr)}
            </td>
            <td className="num">{fig(r, "volume", r.volume, litres(r.volume))}{was(i, "volume", r.volume, litres)}</td>
            <td className="num">{fig(r, "mix", r.mix_pct, pct(r.mix_pct))}{was(i, "mix", r.mix_pct, (n) => pct(n))}</td>
            <td className="num">{fig(r, "gsr", r.gsr, money(r.gsr))}{was(i, "gsr", r.gsr, money)}</td>
            {edit && <td className="num edit-col">{rateCell(r)}</td>}
            <td className="num">{fig(r, "cn_pct", r.cn_pct, pct(r.cn_pct, 2))}{was(i, "cnPct", r.cn_pct, (n) => pct(n, 2))}</td>
            <td className="num">{fig(r, "cn", r.cn, money(r.cn))}{was(i, "cn", r.cn, money)}</td>
            {withImpact && <td className="num">{impacts ? impact(impacts[i] ?? 0) : <span className="muted">·</span>}</td>}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td className="num">{fmtInr(sum("dealers"))}{wasOf(baseTotal, "dealers", sum("dealers"), fmtInr)}</td>
          <td className="num">{litres(sum("volume"))}{wasOf(baseTotal, "volume", sum("volume"), litres)}</td>
          <td className="num">100%</td>
          <td className="num">{money(sum("gsr"))}{wasOf(baseTotal, "gsr", sum("gsr"), money)}</td>
          {edit && <td className="num edit-col" />}
          <td className="num">{pct(sum("gsr") ? (100 * sum("cn")) / sum("gsr") : null, 2)}{wasOf(baseTotal, "cnPct", sum("gsr") ? (100 * sum("cn")) / sum("gsr") : null, (n) => pct(n, 2))}</td>
          <td className="num">{money(sum("cn"))}{wasOf(baseTotal, "cn", sum("cn"), money)}</td>
          {withImpact && <td className="num">{impact(totalImpact)}</td>}
        </tr>
      </tfoot>
    </table>
    {cmp && compare && <GoneSlabs rows={cmp.gone} month={compare.month} money={money} />}
    </>
  );
}
