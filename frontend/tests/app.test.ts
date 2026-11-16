// Unit tests for the main screen's pure rules (src/app/edits.ts, src/app/stats.ts), split out of App.tsx.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Adjustment, SlabRow } from "../src/api/client.ts";
import { editScopeOf, modeOf, scopeLabelOf, slabTag, stackedPct, toggled, without } from "../src/app/edits.ts";
import { editedCountOf, simRowsOf, singleCardIn, slabsAllowedIn } from "../src/app/stats.ts";

function row(p: Partial<SlabRow>): SlabRow {
  return {
    component: "Main", formula: "percent", pack_size: 1, slab_mode: "slab", slab_index: 0, slab_lower: 0,
    slab_upper: null, cn_rate: 0.02, dealer_count: 1, achievement: 0, volume: 0, gsr: 0, cn_units: 0,
    current_cn: 100, condonation_amount: 0, row_id: "r", ...p,
  };
}

test("the cell typed over decides the edit's mode", () => {
  assert.equal(modeOf("total", "volume"), "B");
  assert.equal(modeOf("product", "gsr"), "P");
  assert.equal(modeOf("product", "gsr", true), "Q");
  assert.equal(modeOf("product", "mix"), "A");
  assert.equal(modeOf("product", "cn_pct"), "R");
  assert.equal(modeOf("total", "cn"), "R");
  assert.equal(modeOf("scheme", "volume"), "S");
  assert.equal(modeOf("scheme", "cn"), "C");
  assert.equal(modeOf("scheme", "cn_pct"), "C");
});

test("a % is solved from what the cell showed, replacing the cell's own edit", () => {
  assert.equal(stackedPct(100, 110), 10);
  const old = { value: 10 } as Adjustment;          // the cell shows 110 because of a +10% edit
  assert.equal(stackedPct(110, 121, old), 21);      // typing 121 over it is +21% on the file's 100
  assert.equal(stackedPct(110, 100, old), 0);       // back to the file's figure: the edit goes
});

test("an edit's scope is the narrowest filter on, values sorted", () => {
  assert.deepEqual(editScopeOf([], [], []), { scope_kind: "all", scope_value: "" });
  assert.deepEqual(editScopeOf(["North"], ["Punjab", "Delhi"], []), { scope_kind: "region", scope_value: "Delhi|Punjab" });
  assert.deepEqual(editScopeOf(["North"], ["Delhi"], ["D2", "D1"]), { scope_kind: "depot", scope_value: "D1|D2" });
});

test("the scope reads as one name, a count, or All India", () => {
  assert.equal(scopeLabelOf([], [], []), "All India");
  assert.equal(scopeLabelOf(["North"], ["Delhi"], []), "Delhi");
  assert.equal(scopeLabelOf(["North", "South"], [], []), "2 zones");
  assert.equal(scopeLabelOf([], [], ["1201"]), "Depot 1201");
});

test("set helpers return new sets and leave the old one alone", () => {
  const a = new Set(["x"]);
  assert.deepEqual([...toggled(a, "y")], ["x", "y"]);
  assert.deepEqual([...toggled(a, "x")], []);
  assert.deepEqual([...without(a, "x")], []);
  assert.deepEqual([...a], ["x"]);
});

test("a slab edit's tag names the slab it was typed on", () => {
  assert.equal(slabTag(row({ slab_lower: 50, slab_upper: 100, cn_rate: 0.03 })), "slab|Main|slab|50|100|0.03");
  assert.equal(slabTag(row({ slab_lower: 100 })), "slab|Main|slab|100||0.02");
});

test("a deleted scheme pays nothing; the others are untouched", () => {
  const rows = { a: [row({ current_cn: 100 })], b: [row({ current_cn: 50 })] };
  assert.equal(simRowsOf(rows, new Set()), rows);
  const out = simRowsOf(rows, new Set(["a"]));
  assert.equal(out.a[0].simulated_cn, 0);
  assert.equal(out.a[0].delta_cn, -100);
  assert.equal(out.b, rows.b);
});

test("bookkeeping components cannot have their boundaries moved", () => {
  const rows = [row({ component: "Main" }), row({ component: "Q", formula: "qualifier" as SlabRow["formula"] })];
  assert.equal(slabsAllowedIn(rows, "Main"), true);
  assert.equal(slabsAllowedIn(rows, "Q"), false);
  assert.equal(slabsAllowedIn(rows, "Other (unattributed)"), false);
  assert.equal(slabsAllowedIn(rows, "Missing"), false);
});

test("one rate card per band only when each band has one row", () => {
  assert.equal(singleCardIn([row({ slab_index: 0 }), row({ slab_index: 1 })], "Main"), true);
  assert.equal(singleCardIn([row({ slab_index: 0 }), row({ slab_index: 0, cn_rate: 0.03 })], "Main"), false);
});

test("Reset all counts schemes, plus one for edits or V that touch no single scheme", () => {
  assert.equal(editedCountOf(2, 5, 0, 0), 2);
  assert.equal(editedCountOf(0, 3, 0, 0), 1);
  assert.equal(editedCountOf(0, 0, 0, 5), 1);
  assert.equal(editedCountOf(1, 0, 2, 5), 3);
});
