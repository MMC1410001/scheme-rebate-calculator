"""The slab engine and the what-if edits on a small made-up month (no client data, no file needed).

40 dealers in two regions buy two products, each a volume-slab scheme (slabs in litres, CN as a % of GSR):
Luxury and Premium, slab edges at 100 L and 200 L. Region R1's card pays 0 / 2 / 4 %, region R2's 0 / 3 / 5 %. One
dealer at 250 L earns 0 % (a non-qualifier).
"""
import numpy as np
import pandas as pd
import pytest

from app.core import slab_engine
from app.core.categories import dedup_sum
from app.core.plan import default_layout
from app.core.scenario import dealer_factors, scenario_frame
from app.core.slab_engine import (
    assign_dealers,
    edges_for,
    grow_frame,
    pin_edge_version,
    rebucket,
    set_edge_source,
    unpin_edge_version,
)

PRICE = {"luxury": 500.0, "premium": 300.0}
CARD = {"R1": (0.0, 2.0, 4.0), "R2": (0.0, 3.0, 5.0)}
EDGES = (100.0, 200.0)


def _band(v: float) -> int:
    return int(np.searchsorted(EDGES, v, side="right"))


def _month() -> pd.DataFrame:
    rows = []
    volumes = [40 + 6 * i for i in range(40)]          # 40 L .. 274 L: every band has >= 10 dealers
    for i, lux in enumerate(volumes):
        region = "R1" if i % 2 == 0 else "R2"
        code = 1000 + i
        for scheme, comp, vol, src in (("luxury", "LUX", float(lux), 1), ("premium", "PRM", float(lux) * 0.8, 2)):
            gsr = vol * PRICE[scheme]
            rate = CARD[region][_band(vol)]
            if code == 1035 and scheme == "luxury":       # 250 L, earns nothing: did not qualify
                rate = 0.0
            nxt = next((e - vol for e in EDGES if e > vol), 0.0)
            units = gsr / 100
            rows.append({"zone": "N", "region": region, "depot_code": 1 if region == "R1" else 2,
                         "customer_code": code, "customer_name": f"Dealer {i}", "od_blocked": False,
                         "total_gsr": 0.0, "scheme": scheme, "scheme_label": scheme.title(), "component": comp,
                         "formula": "percent", "pack_size": 0, "base_value": gsr, "cn_rate": rate,
                         "cn_units": units, "current_cn": units * rate, "volume": vol, "gsr": gsr,
                         "gsr_src": src, "vol_src": src, "slab_basis": vol, "next_slab": nxt,
                         "condonation_amount": 0.0})
    df = pd.DataFrame(rows)
    df["total_gsr"] = df.groupby("customer_code")["gsr"].transform("sum")
    return df


@pytest.fixture()
def month():
    """The made-up month as the edge source, pinned for the test; the live month's edges are put back after."""
    saved = dict(slab_engine._EDGE_SOURCES), slab_engine._EDGE_VERSION[0]
    df = _month()
    token = pin_edge_version(set_edge_source(df))
    try:
        yield df
    finally:
        unpin_edge_version(token)
        slab_engine._EDGE_SOURCES.clear()
        slab_engine._EDGE_SOURCES.update(saved[0])


def _rates(dealers: pd.DataFrame) -> dict[int, float]:
    return dict(zip(dealers["customer_code"], dealers["simulated_rate"], strict=True))


# ---- Slab edges and re-bucketing ------------------------------------------------------------------------------------

def test_edges_are_recovered_from_achievement_plus_shortfall(month):
    assert edges_for("luxury", "LUX") == EDGES


def test_unchanged_table_pays_exactly_what_was_settled(month):
    layout = default_layout("luxury", "LUX")
    d = assign_dealers(month, "luxury", "LUX", layout["edges"], sources=layout["sources"])
    own = month[month["scheme"] == "luxury"].set_index("customer_code")
    assert np.allclose(d.set_index("customer_code")["simulated_cn"], own["current_cn"])


def test_a_dealer_who_crosses_a_moved_edge_gets_their_regions_rate(month):
    # The top edge moves from 200 L to 150 L: dealers between 150 and 200 L now sit in the top band.
    layout = default_layout("luxury", "LUX")
    layout["edges"] = [100.0, 150.0]
    rates = _rates(assign_dealers(month, "luxury", "LUX", layout["edges"], sources=layout["sources"]))
    lux = month[month["scheme"] == "luxury"].set_index("customer_code")
    for code, vol in lux["volume"].items():
        if 150 <= vol < 200:
            assert rates[code] == CARD[lux.at[code, "region"]][2], code    # their own region's top rate
        elif code != 1035:
            assert rates[code] == lux.at[code, "cn_rate"]                    # everyone else unchanged


def test_a_rate_edit_reaches_only_that_band_and_old_rate(month):
    layout = default_layout("luxury", "LUX")
    d = assign_dealers(month, "luxury", "LUX", layout["edges"], sources=layout["sources"],
                       rate_overrides=[{"band": 1, "rate": 2.0, "new_rate": 2.5}])
    lux = month[month["scheme"] == "luxury"].set_index("customer_code")
    for code, rate in _rates(d).items():
        hit = lux.at[code, "region"] == "R1" and _band(lux.at[code, "volume"]) == 1
        assert rate == (2.5 if hit else lux.at[code, "cn_rate"])


def test_a_non_qualifier_never_starts_earning(month):
    layout = default_layout("luxury", "LUX")
    d = assign_dealers(month, "luxury", "LUX", [100.0, 150.0], sources=layout["sources"])
    row = d[d["customer_code"] == 1035].iloc[0]
    assert row["slab_mode"] == "unrated" and row["simulated_cn"] == 0


def test_rebucket_rows_add_up_to_the_dealers(month):
    layout = default_layout("luxury", "LUX")
    rows = rebucket(month, "luxury", "LUX", layout["edges"], None, sources=layout["sources"])
    assert rows["dealer_count"].sum() == 40
    assert rows["simulated_cn"].sum() == pytest.approx(month[month["scheme"] == "luxury"]["current_cn"].sum())


def test_a_request_keeps_its_edges_through_a_reload(month):
    """A reload adds a new edge source; a request pinned to the old one keeps the old month's edges."""
    pinned = slab_engine.edge_version()
    other = month.copy()
    other["next_slab"] = np.where(other["next_slab"] > 0, other["next_slab"] + 20, 0)   # edges 120 / 220
    newest = set_edge_source(other)
    assert edges_for("luxury", "LUX") == EDGES                     # still pinned to the month it started on
    token = pin_edge_version(newest)
    try:
        assert edges_for("luxury", "LUX") == (120.0, 220.0)
    finally:
        unpin_edge_version(token)
    assert slab_engine.edge_version() == pinned


# ---- Growth ---------------------------------------------------------------------------------------------------------

def test_per_pack_units_add_only_whole_packs():
    df = pd.DataFrame({"formula": ["per_pack", "percent", "fixed"], "pack_size": [20, 0, 0],
                       "slab_basis": [50.0, 50.0, 50.0], "volume": [50.0] * 3, "gsr": [100.0] * 3,
                       "base_value": [100.0] * 3, "total_gsr": [100.0] * 3, "cn_units": [2.0, 1.0, 1.0]})
    out = grow_frame(df, 1.2)                       # 50 -> 60: a third whole pack of 20
    assert out["cn_units"].tolist() == [3.0, 1.2, 1.0]
    assert out["actual_basis"].tolist() == [50.0] * 3   # qualification stays on the actual month


# ---- What-if edits (app/core/scenario.py) ----------------------------------------------------------------------------

def _edit(mode, product, value, metric="gsr", kind="pct", scope="all", scope_value=""):
    return {"scope_kind": scope, "scope_value": scope_value, "product": product, "metric": metric, "mode": mode,
            "adjust_type": kind, "value": value}


def _by_scheme(df, frame, col):
    return {k: float(g[col].sum()) for k, g in frame.groupby(df["scheme"])}


def test_mode_b_moves_every_product_and_the_total(month):
    out, warnings = scenario_frame(month, [_edit("B", "*", 10)])
    assert not warnings
    assert np.allclose(out["gsr"], month["gsr"] * 1.1)
    assert np.allclose(out["total_gsr"], month["total_gsr"] * 1.1)


def test_mode_p_moves_one_product_and_the_total_with_it(month):
    out, _ = scenario_frame(month, [_edit("P", "Luxury", 20)])
    lux = (month["scheme"] == "luxury").to_numpy()
    assert np.allclose(out["gsr"][lux], month["gsr"][lux] * 1.2)
    assert np.allclose(out["gsr"][~lux], month["gsr"][~lux])
    before, after = month.drop_duplicates("customer_code"), out.drop_duplicates("customer_code")
    assert after["total_gsr"].sum() == pytest.approx(before["total_gsr"].sum() + 0.2 * month["gsr"][lux].sum())


def test_mode_a_moves_sales_between_products_with_the_total_held(month):
    out, _ = scenario_frame(month, [_edit("A", "Luxury", 10)])
    g = _by_scheme(month, out, "gsr")
    g0 = _by_scheme(month, month, "gsr")
    assert g["luxury"] == pytest.approx(g0["luxury"] * 1.1)
    assert g["luxury"] + g["premium"] == pytest.approx(g0["luxury"] + g0["premium"])
    assert np.allclose(out["total_gsr"], month["total_gsr"])


def test_mode_q_moves_rupees_not_litres(month):
    out, _ = scenario_frame(month, [_edit("Q", "Luxury", 10)])
    lux = (month["scheme"] == "luxury").to_numpy()
    assert np.allclose(out["volume"], month["volume"])                     # same litres
    assert np.allclose(out["slab_basis"], month["slab_basis"])             # a litre slab stays
    assert np.allclose(out["gsr"][lux], month["gsr"][lux] * 1.1)
    assert np.allclose(out["cn_units"][lux], month["cn_units"][lux] * 1.1)  # CN as % of GSR moves with it


def test_mode_r_and_c_scale_rates(month):
    out, _ = scenario_frame(month, [_edit("R", "Luxury", -10), _edit("C", "premium", 5)])
    lux = (month["scheme"] == "luxury").to_numpy()
    assert np.allclose(out["cn_units"][lux], month["cn_units"][lux] * 0.9)
    assert np.allclose(out["cn_units"][~lux], month["cn_units"][~lux] * 1.05)
    assert np.allclose(out["cn_scale"][lux], 0.9)
    assert np.allclose(out["volume"], month["volume"])


def test_mode_s_moves_one_scheme(month):
    f, _ = dealer_factors(month, [_edit("S", "premium", 10)])
    prm = (month["scheme"] == "premium").to_numpy()
    assert np.allclose(f["sales"][prm], 1.1) and np.allclose(f["sales"][~prm], 1.0)


def test_an_edit_for_one_region_reaches_only_its_dealers(month):
    out, _ = scenario_frame(month, [_edit("B", "*", 10, scope="region", scope_value="R2")])
    r2 = (month["region"] == "R2").to_numpy()
    assert np.allclose(out["gsr"][r2], month["gsr"][r2] * 1.1)
    assert np.allclose(out["gsr"][~r2], month["gsr"][~r2])


def test_an_edit_with_no_dealer_in_scope_is_reported(month):
    _, warnings = scenario_frame(month, [_edit("B", "*", 10, scope="region", scope_value="Nowhere")])
    assert warnings and "no dealer in this scope" in warnings[0]


def test_dealers_crossing_a_slab_after_growth_keep_their_actual_rate(month):
    """The engine as built (kept by the user, 5 Nov 2026): crossers keep their actual-month rate.
    +30% on Luxury: an R1 dealer just under 100 L (0 %) passes 100 L in the grown month but is still paid 0 %, and
    is counted in the 100-200 L band. (The Plan tab's /growth re-rates crossers; both kept as built.)"""
    out, _ = scenario_frame(month, [_edit("P", "Luxury", 30)])
    layout = default_layout("luxury", "LUX")
    d = assign_dealers(out, "luxury", "LUX", layout["edges"], sources=layout["sources"])
    code = next(c for c, v, r in month[month["scheme"] == "luxury"][["customer_code", "volume", "region"]]
                .itertuples(index=False) if 80 <= v < 100 and v * 1.3 >= 100 and r == "R1")
    row = d[d["customer_code"] == code].iloc[0]
    assert row["slab_index"] == 1 and row["simulated_rate"] == 0.0


# ---- Totals ---------------------------------------------------------------------------------------------------------

def test_dedup_sum_counts_each_source_once_at_its_largest():
    sub = pd.DataFrame({"customer_code": [1, 1, 1, 2], "src": [7, 7, 8, 7], "v": [0.0, 5.0, 3.0, 4.0]})
    # dealer 1: source 7 once (5, not the masked 0 first), source 8 once (3); dealer 2: 4
    assert dedup_sum(sub, "v", "src") == 12.0
    assert dedup_sum(sub.assign(src=-1), "v", "src") == 0.0   # an add-on's litres count in no total
