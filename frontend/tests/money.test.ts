// Unit tests for the CN figures the browser computes itself (no server, no DOM): rate edits (computeImpact.ts) and
// slab-table edits (slabLayout.ts). Run: npm test (Node's own test runner; Node strips the TypeScript types).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SlabLayout, SlabRow } from "../src/api/client.ts";
import { resetRow, sumRows, withSimulatedRate } from "../src/api/computeImpact.ts";
import { layoutFromRows, withEdgeMoved, withSlabAdded, withSlabRemoved } from "../src/slabLayout.ts";

function row(p: Partial<SlabRow>): SlabRow {
  return {
    component: "Main", formula: "percent", pack_size: 1, slab_mode: "slab", slab_index: 0, slab_lower: 0,
    slab_upper: null, cn_rate: 0.02, dealer_count: 10, achievement: 0, volume: 0, gsr: 0, cn_units: 0,
    current_cn: 0, condonation_amount: 0, row_id: "r", ...p,
  };
}

// ---- Rate edits ---------------------------------------------------------------------------------------------------

test("an untouched rate returns exactly what was paid", () => {
  const r = row({ cn_rate: 0.03, current_cn: 12_345.67, cn_units: 400_000 });
  const out = withSimulatedRate(r, 0.03);
  assert.equal(out.simulated_cn, 12_345.67);
  assert.equal(out.delta_cn, 0);
  assert.deepEqual(resetRow(out).simulated_cn, 12_345.67);
});

test("a rate edit scales the settled payout by the change in rate", () => {
  const out = withSimulatedRate(row({ cn_rate: 0.02, current_cn: 1_000, cn_units: 60_000 }), 0.03);
  assert.equal(out.simulated_cn, 1_500);
  assert.equal(out.delta_cn, 500);
});

test("a band paying nothing today is priced from its units", () => {
  const out = withSimulatedRate(row({ cn_rate: 0, current_cn: 0, cn_units: 50_000 }), 0.01);
  assert.equal(out.simulated_cn, 500);
});

test("after a boundary move the payout is units x rate, and a 0% band pays 0", () => {
  const r = row({ rebucketed: true, cn_rate: 0.02, current_cn: 900, cn_units: 40_000 });
  assert.equal(withSimulatedRate(r, 0.02).simulated_cn, 800);
  assert.equal(withSimulatedRate(r, 0).simulated_cn, 0);
});

test("sumRows adds actual and simulated CN and dealers", () => {
  const rows = [withSimulatedRate(row({ current_cn: 100, cn_rate: 0.02 }), 0.04), row({ current_cn: 50, dealer_count: 3 })];
  assert.deepEqual(sumRows(rows), { current_cn: 150, simulated_cn: 250, delta_cn: 100, dealer_count: 13 });
});

// ---- Slab tables --------------------------------------------------------------------------------------------------

const served = [
  row({ slab_index: 0, slab_lower: 0, slab_upper: 100, cn_rate: 0.01 }),
  row({ slab_index: 1, slab_lower: 100, slab_upper: 300, cn_rate: 0.02 }),
  row({ slab_index: 2, slab_lower: 300, slab_upper: null, cn_rate: 0.03 }),
];

test("an unedited table is sent as its boundaries and source bands, with no rate edit", () => {
  assert.deepEqual(layoutFromRows(served), {
    edges: [100, 300], sources: [[0, 100], [100, 300], [300, null]], rate_overrides: [],
  });
});

test("a rate edit on a merged row covers every band inside it", () => {
  const merged = [row({ slab_lower: 0, slab_upper: 100, cn_rate: 0.01 }),
                  row({ slab_lower: 100, slab_upper: null, cn_rate: 0.02, simulated_rate: 0.025 }),
                  row({ slab_lower: 300, slab_upper: 300, cn_rate: 0.02 })];
  const bands = layoutFromRows(merged).rate_overrides?.map((o) => o.band);
  assert.deepEqual(bands, [1, 2]);
});

test("edits return a new table and never change the one passed in", () => {
  const layout = layoutFromRows(served);
  const before = structuredClone(layout);
  const moved = withEdgeMoved(layout, 100, 150) as SlabLayout;
  assert.deepEqual(moved.edges, [150, 300]);
  assert.deepEqual(layout, before);
  assert.equal(withEdgeMoved(layout, 999, 1), null);
});

test("adding a slab splits its band in the middle, both halves from the same source", () => {
  const out = withSlabAdded(layoutFromRows(served), served[1], served) as SlabLayout;
  assert.deepEqual(out.edges, [100, 200, 300]);
  assert.deepEqual(out.sources, [[0, 100], [100, 300], [100, 300], [300, null]]);
  assert.equal(withSlabAdded(out, served[1], served), null);   // that edge exists now
});

test("removing a slab drops its dealers to the slab below; the first slab then pays 0", () => {
  const layout = layoutFromRows(served);
  const out = withSlabRemoved(layout, served[1], served) as SlabLayout;
  assert.deepEqual(out.edges, [300]);
  assert.deepEqual(out.sources, [[0, 100], [300, null]]);
  const first = withSlabRemoved(layout, served[0], served) as SlabLayout;
  assert.deepEqual(first.rate_overrides, [{ band: 0, rate: 0.01, new_rate: 0 }]);
});
