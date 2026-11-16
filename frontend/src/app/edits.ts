import type { Adjustment, MonthSlabRow, SlabLayout, SlabRow } from "../api/client";
import type { CellEdit } from "../components/MonthsView";

/** Pure rules of the Simulator's edits: which mode a typed cell becomes, how a % is solved, how a slab edit is
 *  tagged. No state here; the hooks in src/app call these. */

/** The scope the filters now on describe, as an edit's scope: the narrowest filter set (several values "A|B"). */
export function editScopeOf(zone: string[], region: string[], depot: string[]): Pick<Adjustment, "scope_kind" | "scope_value"> {
  return depot.length ? { scope_kind: "depot", scope_value: [...depot].sort().join("|") }
    : region.length ? { scope_kind: "region", scope_value: [...region].sort().join("|") }
      : zone.length ? { scope_kind: "zone", scope_value: [...zone].sort().join("|") }
        : { scope_kind: "all", scope_value: "" };
}

/** Two edits of the same scope, product, metric and mode: the newer replaces the older. */
export const sameKey = (a: Adjustment, b: Adjustment) =>
  a.scope_kind === b.scope_kind && a.scope_value === b.scope_value && a.product === b.product
  && a.metric === b.metric && a.mode === b.mode;

/** A figure typed into the month table becomes an edit (the cell decides the mode, user's choice 2 Nov 2026):
 *  total -> B (every product in proportion), product Volume / GSR -> P (that product only), product Mix -> A (the
 *  total held), scheme -> S (that scheme only). CN in rupees scales rates (3 Nov 2026): a product's or the
 *  total's -> R (product "*" for the total), a scheme's -> C; CN and CN % are the same edit (a scheme's Mix is a
 *  "volume grows" Volume edit, mode S). */
export const modeOf = (level: CellEdit["level"], field: CellEdit["field"], asPrice = false): Adjustment["mode"] =>
  field === "cn" || (level === "scheme" && field === "cn_pct") ? (level === "scheme" ? "C" : "R")
    : level === "total" ? "B" : level === "scheme" ? "S" : field === "mix" ? "A" : field === "cn_pct" ? "R"
      : field === "gsr" && asPrice ? "Q" : "P";

/** The metric an edit is stored under: a CN or CN % edit is a rate factor, kept under "gsr". */
export const metricOf = (field: CellEdit["field"]): Adjustment["metric"] =>
  field === "mix" || field === "volume" ? "volume" : "gsr";

/** A % edit solved from what the cell showed (`from` -> `to`), on top of the edit `old` that cell already carries,
 *  so typing over an edited cell replaces its edit rather than stacking another on it. */
export const stackedPct = (from: number, to: number, old?: Adjustment) =>
  Math.round(((to / from) * (1 + (old?.value ?? 0) / 100) - 1) * 100 * 1e6) / 1e6;

/** A slab row's edits are tagged with the slab (kept in the edit's reason): its dealers are fixed when it is first
 *  typed, so the tag finds the edit again after they have moved slab. */
export const slabTag = (r: SlabRow) =>
  `slab|${r.component}|${r.slab_mode}|${r.slab_lower}|${r.slab_upper ?? ""}|${r.cn_rate}`;

/** A next-month slab row in the shape the dealer look-ups and edit tags use. */
export const asSlabRow = (r: MonthSlabRow): SlabRow => ({
  component: r.component, formula: r.formula, pack_size: r.pack_size, slab_mode: r.slab_mode,
  slab_index: r.slab_index, slab_lower: r.slab_lower ?? 0, slab_upper: r.slab_upper, cn_rate: r.cn_rate,
  simulated_rate: r.rate, dealer_count: r.dealers, achievement: 0, volume: r.volume, gsr: r.gsr, cn_units: 0,
  current_cn: r.cn, condonation_amount: 0, row_id: `${r.component}::${r.slab_index}::${r.cn_rate}`,
});

/** The bands of `layout` a next-month row covers (a row can span several same-rate bands). */
export const bandsOfRow = (layout: SlabLayout, r: MonthSlabRow) => {
  if (r.slab_mode === "target") return [0];
  const lo = r.slab_lower ?? 0;
  return [0, ...layout.edges]
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b >= lo - 1e-6 && (r.slab_upper == null || b < r.slab_upper - 1e-6))
    .map(({ i }) => i);
};

/** How the current selection reads: "Delhi", "3 regions", "All India". */
export function scopeLabelOf(zone: string[], region: string[], depot: string[]): string {
  const parts: [string[], string, string][] = [
    [depot, "depot", "depots"],
    [region, "region", "regions"],
    [zone, "zone", "zones"],
  ];
  for (const [sel, one, many] of parts) {
    if (!sel.length) continue;
    if (sel.length === 1) return one === "depot" ? `Depot ${sel[0]}` : sel[0];
    return `${sel.length} ${many}`;
  }
  return "All India";
}

/** A copy of `set` with `key` added if it was missing, removed if it was there. */
export function toggled<T>(set: Set<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** A copy of `set` without `key`. */
export function without<T>(set: Set<T>, key: T): Set<T> {
  const next = new Set(set);
  next.delete(key);
  return next;
}
