"""Golden checks on the live month's real file (skipped when it is not on this machine).

- An unchanged slab table moves (almost) Rs 0: every component re-bucketed under its served layout pays what was
  settled (each dealer keeps their region's card). Allowed: Rs 1 or 0.01% of the component's CN, whichever is more.
  Known on Nov'26 v1: Luxury moves a few hundred rupees (a handful of dealers in one region below the first slab earned CN in the file;
  the engine pays nothing below the first slab).
- /months/edited answers (it once failed every call with a 500).
- An edit re-slabs only the components it changes; the rest come from the unedited month's cache, and the answer
  equals a full recompute (/all-slabs/adjusted and next month).
"""
import pytest

pytestmark = pytest.mark.data


@pytest.fixture(scope="module")
def live():
    from app.service import live as live_module

    if not live_module.LIVE.path.is_file():
        pytest.skip("the live month's file is not on this machine")
    live_module.get_df()
    return live_module


def test_unchanged_slab_tables_move_nothing(live):
    from app.core.plan import default_layout, is_carried
    from app.core.slab_engine import rebucket

    df = live.get_df()
    exposed = set(live.get_exposed_schemes())
    pairs = df[["scheme", "component", "formula"]].drop_duplicates()
    checked, moved = 0, []
    for scheme, component, formula in pairs.itertuples(index=False):
        if scheme not in exposed or is_carried(str(component), str(formula)):
            continue
        layout = default_layout(scheme, component)
        rows = rebucket(df, scheme, component, layout["edges"], None, sources=layout["sources"])
        if rows.empty:
            continue
        actual = float(rows["current_cn"].sum())
        delta = float(rows["simulated_cn"].sum()) - actual
        checked += 1
        if abs(delta) > max(1.0, 1e-4 * abs(actual)):
            moved.append((scheme, component, round(delta, 2)))
    assert checked > 50
    assert not moved, f"unchanged tables moved CN: {moved[:5]}"


def test_months_edited_answers(live):
    from fastapi.testclient import TestClient

    from app.main import app

    r = TestClient(app).post("/v1/months/edited", json={"current": {}, "next": {}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["next"]["month"] == live.next_month_label()
    assert body["current"]["rows"]


def _scheme_edit(live):
    """A volume edit of the biggest base scheme in its biggest region: it reaches a few components only."""
    from app.core.categories import BASE

    df = live.get_df()
    scheme = next(k for k in df["scheme"].value_counts().index.astype(str) if k in BASE)
    region = str(df[df["scheme"] == scheme]["region"].value_counts().index[0])
    return scheme, region, [{"scope_kind": "region", "scope_value": region, "mode": "S", "product": scheme,
                             "metric": "volume", "value": 15}]


def test_changed_pairs_are_few(live):
    """The edited scheme changes, and so do the whole-book schemes (Value, Early Bird: a base scheme's sales move the
    dealer's total, which they follow); the other schemes do not."""
    from app.core.categories import category_of

    scheme, _, adj = _scheme_edit(live)
    touched = {k for k, _ in live.touched_current(adj)}
    assert scheme in touched
    others = touched - {scheme}
    assert all(category_of(scheme)[0] != category_of(k)[0] for k in others)
    assert len(touched) < len(live.get_exposed_schemes()) / 2


def test_reused_slab_tables_equal_a_full_recompute(live, monkeypatch):
    """Components no edit reaches are taken from the unedited month's cache; the answer must not change."""
    from app.auth import LOCAL
    from app.routers.slabs import post_all_slabs_adjusted
    from app.schemas import AdjustedSlabsRequest

    _, region, adj = _scheme_edit(live)
    for scope in ({}, {"region": [region]}):
        reused = post_all_slabs_adjusted(AdjustedSlabsRequest(adjustments=adj, **scope), None, LOCAL)
        monkeypatch.setattr(live, "touched_current", lambda _adj: None)
        full = post_all_slabs_adjusted(AdjustedSlabsRequest(adjustments=adj, **scope), None, LOCAL)
        monkeypatch.undo()
        assert reused == full


def test_reused_next_month_equals_a_full_recompute(live):
    import json

    from app.core.plan import plan_schemes

    _, region, adj = _scheme_edit(live)
    factor = live.plan_factor(10)
    key = live.adj_key(adj)
    for scope in ((None, None, None), (None, (region,), None)):
        reused = live.plan_cached(factor, "{}", "[]", key, *scope)
        frame = live.next_frame([], json.loads(key), factor)[0]
        full = {k: v["cn"] for k, v in plan_schemes(frame, {}, *scope,
                                                    schemes=set(live.get_exposed_schemes())).items()}
        assert reused.keys() == full.keys()
        assert all(abs(reused[k] - full[k]) <= 1e-6 * max(1.0, abs(full[k])) for k in full)
