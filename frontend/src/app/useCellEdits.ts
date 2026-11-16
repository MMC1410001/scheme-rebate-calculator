import type { Dispatch, SetStateAction } from "react";
import type { Adjustment } from "../api/client";
import type { CellEdit } from "../components/MonthsView";
import type { ScopeSel } from "./constants";
import { editScopeOf, metricOf, modeOf, sameKey, stackedPct } from "./edits";

interface CellEditState {
  scope: ScopeSel;
  adjustments: Adjustment[];
  setAdjustments: Dispatch<SetStateAction<Adjustment[]>>;
  nextAdjustments: Adjustment[];
  setNextAdjustments: Dispatch<SetStateAction<Adjustment[]>>;
  setError: (text: string | null) => void;
}

/** Figures typed into the month table (and Scheme detail's summary), as GSR / volume / CN edits. The cell decides
 *  the mode (edits.modeOf); the edit's scope is the filters now on. A % edit is solved from what the cell showed,
 *  so typing over an edited cell replaces its edit rather than stacking on it. */
export function useCellEdits({ scope, adjustments, setAdjustments, nextAdjustments, setNextAdjustments, setError }: CellEditState) {
  const editScope = () => editScopeOf(scope.zone, scope.region, scope.depot);

  /** Returns a sentence when the figure is refused (shown under the cell). */
  const editCell = (e: CellEdit): string | void => {
    if (e.field === "mix" && e.grow) {
      // "Volume grows": the product's own volume that gives it the typed share, the others unchanged (mode P).
      const t = e.to / 100, { volume: v, total: T } = e.grow;
      if (!(t > 0 && t < 1) || !(T > v)) return "A mix is a share of volume between 0 and 100%.";
      return editCell({ ...e, field: "volume", from: v, to: (t * (T - v)) / (1 - t), grow: undefined, replacesMix: true });
    }
    const field = metricOf(e.field);
    const mode = modeOf(e.level, e.field, e.asPrice);
    const draft: Adjustment = { ...editScope(), product: e.level === "total" ? "*" : e.key, metric: field, mode,
                                adjust_type: e.field === "mix" ? "share" : "pct", value: 0 };
    const list = e.period === "current" ? adjustments : nextAdjustments;
    const old = list.find((a) => sameKey(a, draft));
    if (e.field === "mix") {
      if (!(e.to > 0 && e.to < 100)) return "A mix is a share of volume between 0 and 100%.";
      draft.value = e.to;
    } else {
      if (!e.from || e.from <= 0) return "Only a positive figure can be changed by a %; this one is zero or negative.";
      if (e.to < 0) return "A volume, GSR, CN % or CN cannot be negative.";
      draft.value = stackedPct(e.from, e.to, old);
    }
    setError(null);
    const drop = e.field !== "mix" && Math.abs(draft.value) < 1e-6;
    // A "volume grows" Mix drops the product's "total held" Mix (a share target, applied after it, which would pull
    // the share back). A "total held" Mix needs no such step: as a target it lands on the typed share anyway.
    const otherMix = (a: Adjustment) => a.scope_kind === draft.scope_kind && a.scope_value === draft.scope_value
      && a.product === draft.product && (e.replacesMix ? a.mode === "A" : false);
    const next = [...list.filter((a) => !sameKey(a, draft) && !otherMix(a)), ...(drop ? [] : [draft])];
    if (e.period === "current") setAdjustments(next); else setNextAdjustments(next);
  };

  /** Whether a cell of the month table carries an edit typed through the filters now on. */
  const isEdited = (period: "current" | "next", level: CellEdit["level"], key: string, field: CellEdit["field"]) => {
    const own = editScope();
    const modes = field === "gsr" && level === "product" ? ["P", "Q"] : [modeOf(level, field)];
    return (period === "current" ? adjustments : nextAdjustments).some((a) =>
      a.scope_kind === own.scope_kind && a.scope_value === own.scope_value && modes.includes(a.mode)
      && a.product === (level === "total" ? "*" : key)
      && a.metric === metricOf(field));
  };

  return { editCell, isEdited };
}
