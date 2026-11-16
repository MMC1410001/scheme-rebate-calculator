import type { SlabLayout, SlabRow } from "./api/client";

/** A component's slab table as the browser sends it (backend SlabLayout), and the edits to it: pure functions of the
 *  served rows and the table last sent, so App.tsx only keeps state and calls the server. Each edit returns a NEW
 *  layout; the one passed in is never changed. */

export const sameEdge = (a: number, b: number) => Math.abs(a - b) < 1e-6;

const rateOf = (r: SlabRow) => r.simulated_rate ?? r.cn_rate;

/** The component's slab table as it stands, including rate edits, ready to send.
 *
 *  After the first boundary move the server's rows are numbered by band position in the table last sent (`stored`),
 *  so its edges and sources are reused and only the rates are read back from the rows. Before it, the table comes
 *  from the served rows: every distinct boundary, each band its own source, so an unchanged table changes nothing
 *  (checked on every component in three scopes). `rows`: the component's rows only. */
export function layoutFromRows(rows: SlabRow[], stored?: SlabLayout): SlabLayout {
  const edited = rows.filter((r) => r.slab_mode !== "unrated" && rateOf(r) !== r.cn_rate);
  if (stored) {
    if (stored.rates) {
      const rates = [...stored.rates];
      for (const r of rows) if (r.slab_mode === "slab" && r.slab_index < rates.length) rates[r.slab_index] = rateOf(r);
      return { edges: [...stored.edges], rates };
    }
    return {
      edges: [...stored.edges],
      sources: [...(stored.sources ?? [])],
      rate_overrides: edited.map((r) => ({ band: r.slab_index, rate: r.cn_rate, new_rate: rateOf(r) })),
    };
  }
  // Always the portable form (edges + source bands + rate edits by old rate), never one rate card for the scope:
  // the table then means the same in every scope, so it can be kept when the filters change. In a scope with one
  // card per band the two forms price every dealer the same.
  const slab = rows.filter((r) => r.slab_mode === "slab");
  const cuts = [...new Set(slab.flatMap((r) => [r.slab_lower, r.slab_upper])
    .filter((v): v is number => v != null && v > 0))].sort((a, b) => a - b);
  const bounds = [0, ...cuts];
  const sources = bounds.map((lo, i): [number, number | null] => [lo, i + 1 < bounds.length ? bounds[i + 1] : null]);
  // A served row can span several bands (same-rate neighbours are merged for display), so its rate edit covers
  // every band inside its range. Per-dealer targets have one band.
  const rate_overrides = edited.flatMap((r) =>
    r.slab_mode === "target"
      ? [{ band: 0, rate: r.cn_rate, new_rate: rateOf(r) }]
      : bounds
          .map((lo, band) => ({ lo, band }))
          .filter(({ lo }) => lo >= r.slab_lower && (r.slab_upper == null || lo < r.slab_upper))
          .map(({ band }) => ({ band, rate: r.cn_rate, new_rate: rateOf(r) })));
  return { edges: cuts, sources, rate_overrides };
}

const copy = (l: SlabLayout): SlabLayout => ({
  ...l,
  edges: [...l.edges],
  rates: l.rates ? [...l.rates] : l.rates,
  sources: l.sources ? [...l.sources] : l.sources,
  rate_overrides: l.rate_overrides ? [...l.rate_overrides] : l.rate_overrides,
});

/** Move one boundary, found by value (the same edge ends one band and starts the next). null: no such edge. */
export function withEdgeMoved(layout: SlabLayout, from: number, value: number): SlabLayout | null {
  const i = layout.edges.findIndex((e) => sameEdge(e, from));
  if (i < 0) return null;
  const out = copy(layout);
  out.edges[i] = value;
  return out;
}

/** Split a band in two at its middle, so a new slab can be introduced. On per-dealer targets (no table yet) this
 *  creates the first boundary, at the middle of the component's achievement range. null: that edge exists. */
export function withSlabAdded(layout: SlabLayout, row: SlabRow, rows: SlabRow[]): SlabLayout | null {
  const lo = row.slab_mode === "target" ? 0 : row.slab_lower;
  const top = row.slab_mode === "target" ? Math.max(...rows.map((r) => r.slab_upper ?? r.slab_lower)) : row.slab_upper;
  const hi = top ?? (lo > 0 ? lo * 2 : 100);
  const mid = Math.round(lo + (hi - lo) / 2) || lo + 1;
  if (layout.edges.some((e) => sameEdge(e, mid))) return null;
  const out = copy(layout);
  const band = out.edges.filter((e) => e < mid).length;   // the band that holds the new edge
  out.edges.splice(band, 0, mid);
  out.rates?.splice(band + 1, 0, out.rates[band]);
  out.sources?.splice(band + 1, 0, out.sources[band]);
  if (out.rate_overrides) {
    out.rate_overrides = out.rate_overrides.flatMap((o) =>
      o.band < band ? [o] : o.band > band ? [{ ...o, band: o.band + 1 }] : [o, { ...o, band: band + 1 }]);
  }
  return out;
}

/** Remove a slab: its dealers drop to the slab below (user's choice, 30 Oct 2026). The row's lower edge goes, so
 *  the row merges into the band below and the merged band keeps the lower band's pricing (rate, or source band:
 *  each dealer then earns their region's rate of the lower slab). The first slab has no slab below, so its
 *  dealers earn nothing: band 0 is paid 0. `rows`: the component's rows. null: the row's edge is not in the table. */
export function withSlabRemoved(layout: SlabLayout, row: SlabRow, rows: SlabRow[]): SlabLayout | null {
  const out = copy(layout);
  if (row.slab_lower <= 0) {
    if (out.rates) out.rates[0] = 0;
    else {
      const paid = new Set(rows.filter((r) => r.slab_mode === "slab" && r.slab_lower <= 0).map((r) => r.cn_rate));
      out.rate_overrides = [
        ...(out.rate_overrides ?? []).filter((o) => o.band !== 0),
        ...[...paid].map((rate) => ({ band: 0, rate, new_rate: 0 })),
      ];
    }
    return out;
  }
  const i = out.edges.findIndex((e) => sameEdge(e, row.slab_lower));
  if (i < 0) return null;
  out.edges.splice(i, 1);
  out.rates?.splice(i + 1, 1);
  out.sources?.splice(i + 1, 1);
  if (out.rate_overrides) {
    out.rate_overrides = out.rate_overrides
      .filter((o) => o.band !== i + 1)
      .map((o) => (o.band > i + 1 ? { ...o, band: o.band - 1 } : o));
  }
  return out;
}
