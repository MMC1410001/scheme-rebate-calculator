import type { SortKey } from "../app/constants";
import { MONTH_SHORT } from "../app/constants";

/** Small pieces of the Simulator shared by Overall Schemes and Scheme detail (App.tsx). */

/** Sorting by impact puts what your edits actually moved at the top of each product. */
export function SortSelect({ label, value, onChange }: { label: string; value: SortKey; onChange: (v: SortKey) => void }) {
  return (
    <label className="f">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as SortKey)}>
        <option value="payout">Largest payout</option>
        <option value="impact">Biggest impact</option>
        <option value="name">Name (A–Z)</option>
      </select>
    </label>
  );
}

export function EditedOnlyButton({ on, onToggle, count }: { on: boolean; onToggle: () => void; count: number }) {
  return (
    <button
      className={`btn sm ${on ? "btn-on" : ""}`}
      aria-pressed={on}
      onClick={onToggle}
      disabled={count === 0}
      title={count === 0 ? "Nothing edited yet" : "Show only schemes you have edited"}
    >
      Edited only{count > 0 && ` (${count})`}
    </button>
  );
}

/** What an edit here actually means. A settled month's credit notes have been disbursed. A slab or rate change
 *  cannot claw them back, so a negative "impact" is not money recovered -- it is what a revised structure WOULD
 *  have cost on this month's volumes, which is the useful reference for setting next month's scheme. Saying so
 *  matters: the figure reads as a saving and would otherwise be taken to the business as one. */
export function SettledNote({ month }: { month: string }) {
  return (
    <p className="settled-note">
      <b>{MONTH_SHORT[Number(month.slice(5, 7)) - 1]} is settled</b> — these credit
      notes have been paid. Edits here show what a revised structure would have cost
      on this month's volumes, as a reference for next month. They do not recover
      money already disbursed, and they hold dealer volumes fixed — a lower rate may
      also mean lower sales.
    </p>
  );
}

/** Overall Schemes (the month table) or Scheme detail. */
export function SimViewSwitch({ view, onMonths, onDetail }:
  { view: "months" | "detail"; onMonths: () => void; onDetail: () => void }) {
  return (
    <div className="sim-view">
      <span>View</span>
      <div className="tabs" role="tablist" aria-label="Simulator view">
        <button role="tab" aria-selected={view === "months"} className={view === "months" ? "is-active" : ""}
                onClick={() => { if (view !== "months") onMonths(); }}>Overall Schemes</button>
        <button role="tab" aria-selected={view === "detail"} className={view === "detail" ? "is-active" : ""}
                onClick={onDetail}>Scheme detail</button>
      </div>
    </div>
  );
}

/** Deleted in the month table: hidden in Scheme detail too, so no view shows a scheme the totals treat as paying
 *  nothing. Each can be restored here. */
export function RemovedSchemesNotice({ keys, labelOf, onRestore }:
  { keys: string[]; labelOf: (k: string) => string; onRestore: (k: string) => void }) {
  return (
    <p className="mv-removed">
      <b>Deleted schemes</b> (pay nothing in the current and next month; volume and GSR stay):
      {keys.map((k) => {
        const label = labelOf(k);
        return (
          <span key={k} className="chip mv-chip">
            {label}
            <button type="button" className="mv-reset" aria-label={`Restore ${label}`} onClick={() => onRestore(k)}>
              Restore
            </button>
          </span>
        );
      })}
    </p>
  );
}
