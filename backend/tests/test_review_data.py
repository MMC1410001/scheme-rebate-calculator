"""Checks on the live month's real file for the review fixes of 5 Nov 2026 (skipped when the file is not here).

- Filter values not in the live month are refused (422) before anything is built or cached; real ones pass.
- The aggregate views never carry dealer-level data (codes or names): only /dealers and a version's moved dealers
  may, and both need the ADMIN role.
- /all-slabs/adjusted no longer deep-copies the cached view, so it must not change it either.
"""
import json

import pytest
from fastapi import HTTPException

pytestmark = pytest.mark.data

DEALER_FIELDS = {"customer_code", "customer_name", "codes"}


@pytest.fixture(scope="module")
def live():
    from app.service import live as live_module

    if not live_module.LIVE.path.is_file():
        pytest.skip("the live month's file is not on this machine")
    live_module.get_df()
    return live_module


def _keys(value) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    if isinstance(value, (list, tuple)):
        return {k for v in value for k in _keys(v)}
    return set()


def test_unknown_filter_values_are_refused_and_real_ones_pass(live):
    df = live.get_df()
    region = str(df["region"].dropna().iloc[0])
    depot = df["depot_code"].dropna().iloc[0]
    assert live.scope_of(None, [region], [str(depot)])[1] == (region,)
    with pytest.raises(HTTPException) as refused:
        live.scope_of(None, ["No Such Region"], None)
    assert refused.value.status_code == 422 and "region" in refused.value.detail


def test_aggregate_views_carry_no_dealer_data(live):
    views = [live.all_slabs_cached(None, None, None), live.months_cached(None, None, None),
             live.gifts_cached(None, None, None)]
    assert not DEALER_FIELDS & _keys(views)


def test_adjusted_slabs_leave_the_cached_view_unchanged(live):
    from app.auth import LOCAL
    from app.routers.slabs import post_all_slabs_adjusted
    from app.schemas import AdjustedSlabsRequest

    before = json.dumps(live.all_slabs_cached(None, None, None), sort_keys=True, default=str)
    edit = {"scope_kind": "all", "product": "*", "metric": "gsr", "mode": "B", "value": 5}
    out = post_all_slabs_adjusted(AdjustedSlabsRequest(adjustments=[edit]), None, LOCAL)
    assert out["grand"]["gsr"] > 0
    assert json.dumps(live.all_slabs_cached(None, None, None), sort_keys=True, default=str) == before
