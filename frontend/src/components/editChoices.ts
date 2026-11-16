/** What a typed Mix means (user's choice, 3 Nov 2026): the total held, so the others give up the volume; or only
 *  this one sells more, so the total grows. Shown as a toggle beside the box. */
export const MIX_CHOICES = [
  { value: "held", label: "total held",
    title: "The others give up (or gain) the same litres in proportion: the total volume stays the same" },
  { value: "grow", label: "volume grows",
    title: "Only this one sells more (or less): the others stay as they are, so the total volume moves" },
];

/** What typing into a cell does, in one sentence (the cell's tooltip). */
export function editHint(level: "total" | "product" | "scheme", field: "volume" | "gsr" | "mix" | "cn_pct" | "cn"): string {
  const FIELD_LABEL = { gsr: "GSR", mix: "mix %", cn_pct: "CN %", cn: "CN", volume: "volume" } as const;
  if (level === "total") {
    return field === "cn" ? "Total CN: every rate scales until the total CN is the figure you type; volume and GSR stay."
      : `Total ${FIELD_LABEL[field]}: every product moves in proportion.`;
  }
  if (level === "scheme") {
    if (field === "cn") return "This scheme's CN: its rates scale until it pays the figure you type; volume and GSR stay.";
    if (field === "cn_pct") return "This scheme's rates scale until its CN is the % of GSR you type; volume and GSR stay.";
    if (field === "mix") return "This scheme's share of all volume: only this scheme sells more (or less), so the total volume moves; its dealers may cross slab boundaries.";
    return `This scheme's ${FIELD_LABEL[field]} only; its dealers may cross slab boundaries.`;
  }
  switch (field) {
    case "volume": return "This product's volume only; the total moves with it.";
    case "gsr": return "This product's GSR only: more sales at each dealer's own price, or a price change on the same litres (choose next to the box).";
    case "mix": return "This product's share of volume: other products give up sales (total held), or only this one sells more (choose next to the box).";
    default: return "This product's rates scale until its CN is the figure you type; volume and GSR stay.";
  }
}

/**
 * The legal range for one slab boundary.
 *
 * Boundaries are shared: the end of band N IS the start of band N+1, so a table
 * of bands is really an ordered list of edges. An edge is only meaningful
 * strictly between its neighbours -- the moment one crosses another the order
 * breaks, the server re-sorts, and bands merge or disappear. Rather than let
 * that happen and try to recover, the input refuses the value and says why.
 *
 * `edgeIndex` is the position in the edge list: edge i separates band i from
 * band i+1.
 */
export function edgeBounds(cuts: number[], edge: number) {
  const i = cuts.findIndex((e) => Math.abs(e - edge) < 1e-6);
  const lower = i > 0 ? cuts[i - 1] : 0;
  const upper = i >= 0 && i < cuts.length - 1 ? cuts[i + 1] : undefined;
  const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
  return {
    bound: (v: number): string | null => {
      if (!Number.isFinite(v)) return "Enter a number";
      if (v <= lower) return `Must be above ${fmt(lower)} — the slab below it`;
      if (upper !== undefined && v >= upper) return `Must be below ${fmt(upper)} — the slab above it`;
      return null;
    },
  };
}
