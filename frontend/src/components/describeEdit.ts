import type { Adjustment } from "../api/client";

/** One edit in a sentence: "Current month, region North: Premium GSR +10%". Used by the Versions tab and the
 *  Simulator's Edits list. */
export function describe(a: Adjustment): string {
  const values = a.scope_value.split("|").filter(Boolean);
  const who = a.scope_kind === "all" ? "All India"
    : a.scope_kind === "dealer" && values.length > 3 ? `${values.length.toLocaleString("en-IN")} dealers`
      : `${a.scope_kind} ${values.join(", ")}`;
  // A slab edit (Simulator, 3 Nov 2026): its reason names the slab its dealers were in when it was typed.
  const mixPart = a.reason?.startsWith("mixrest|") ? "rest" : a.reason?.startsWith("mix|") ? "mix" : null;
  const tag = mixPart ? a.reason!.slice(a.reason!.indexOf("|") + 1) : a.reason;
  const slab = tag?.startsWith("slab|") ? tag.split("|") : null;
  const month = a.period === "next" ? "Next month" : "Current month";
  const what = a.mode === "B" ? `total ${a.metric === "gsr" ? "GSR" : "volume"}`
    : a.mode === "A" ? `${a.product} mix (total held)`
      : a.mode === "Q" ? `${a.product} price (same litres)`
      : a.mode === "R" ? (a.product === "*" ? "every rate (total CN)" : `${a.product} rates (CN % / CN)`)
      : a.mode === "C" ? `scheme ${a.product} rates (CN)`
      : a.mode === "S" && slab ? `scheme ${a.product}, ${slab[1]} ${mixPart === "rest" ? "other slabs than" : "slab"} ${slab[3]}–${slab[4] || "∞"} ${mixPart ? "volume (for a slab's mix, total held)" : a.metric === "gsr" ? "GSR" : "volume"}`
      : a.mode === "S" ? `scheme ${a.product} ${a.metric === "gsr" ? "GSR" : "volume"}`
        : `${a.product} ${a.metric === "gsr" ? "GSR" : "volume"}`;
  const value = a.value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const shown = a.adjust_type === "share" ? `to ${value}% of volume` : `${a.value > 0 ? "+" : ""}${value}${a.adjust_type === "pct" ? "%" : ""}`;
  return `${month}, ${who}: ${what} ${shown}`;
}
