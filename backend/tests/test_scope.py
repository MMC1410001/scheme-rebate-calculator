"""app/core/scope.py: one filter for every endpoint."""
import pandas as pd

from app.core.scope import apply_scope, scope_key

FRAME = pd.DataFrame({"zone": ["N", "N", "S"], "region": ["Delhi", "Haryana", "Kerala"], "depot_code": [11, 12, 13]})


def test_string_and_list_select_the_same_rows():
    assert apply_scope(FRAME, zone="N").equals(apply_scope(FRAME, zone=["N"]))


def test_several_values_and_empty_means_all():
    assert len(apply_scope(FRAME, region=["Delhi", "Kerala"])) == 2
    assert len(apply_scope(FRAME, region=[])) == 3
    assert len(apply_scope(FRAME)) == 3


def test_numeric_depot_codes_match_text_from_the_query():
    assert apply_scope(FRAME, depot_code=["12"])["region"].tolist() == ["Haryana"]
    assert apply_scope(FRAME, depot_code=["not-a-number"]).empty


def test_scope_key_ignores_order():
    assert scope_key(None, ["Haryana", "Delhi"], None) == scope_key(None, ["Delhi", "Haryana"], None)
    assert scope_key("", [], None) == (None, None, None)
