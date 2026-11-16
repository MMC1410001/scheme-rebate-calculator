"""The API's middleware and cheap routes, without building the month (no lifespan, no warm-up)."""
from fastapi.testclient import TestClient

from app.main import MAX_BODY_BYTES, app

client = TestClient(app)


def test_health_answers_before_warm_up():
    body = client.get("/health").json()
    assert body["status"] == "ok" and isinstance(body["ready"], bool)


def test_body_over_the_limit_is_refused_in_plain_words():
    r = client.post("/v1/months", content=b"x" * (MAX_BODY_BYTES + 1), headers={"content-type": "application/json"})
    assert r.status_code == 413
    assert "too large" in r.json()["detail"]
    assert r.headers["x-content-type-options"] == "nosniff"     # the refusal carries the security headers too


def test_security_headers_on_every_response():
    r = client.get("/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["cache-control"] == "no-store"            # answers may hold client data


def test_a_full_build_gate_answers_503_busy_in_plain_words():
    from app.core.cache import BuildBusy

    @app.get("/test-busy")
    def busy():
        raise BuildBusy

    try:
        r = client.get("/test-busy")
    finally:
        app.router.routes.pop()
    assert r.status_code == 503 and "busy" in r.json()["detail"] and r.headers["retry-after"] == "30"


def test_cors_refuses_an_unknown_origin():
    r = client.options("/v1/saved-versions", headers={"Origin": "http://evil.example",
                                              "Access-Control-Request-Method": "POST"})
    assert r.status_code == 400


def test_too_many_edits_are_refused_before_any_work():
    edit = {"scope_kind": "all", "product": "*", "metric": "gsr", "mode": "B", "value": 1}
    r = client.post("/v1/months", json={"adjustments": [edit] * 501})
    assert r.status_code == 422


def test_business_routes_are_versioned():
    paths = set(app.openapi()["paths"])
    assert "/health" in paths
    assert all(p == "/health" or p.startswith("/v1/") for p in paths), sorted(paths)
    assert client.get("/schemes").status_code == 404     # the unversioned path is gone


# ---- QA run of 5 Nov 2026 -------------------------------------------------------------------------------------------

def _raw(path: str, body: str):
    return client.post(path, content=body.encode(), headers={"content-type": "application/json"})


def test_nan_and_infinity_are_refused_in_plain_words_not_a_500():
    for path, body in (("/v1/growth", '{"growth_pct": NaN}'), ("/v1/growth", '{"growth_pct": Infinity}'),
                       ("/v1/growth", '{"growth_pct": 1e300}'), ("/v1/growth", '{"per_scheme": {"luxury": NaN}}'),
                       ("/v1/growth", '{"rate_multipliers": {"luxury": Infinity}}'),
                       ("/v1/months/next", '{"volume_growth_pct": NaN}'),
                       ("/v1/simulate", '{"scheme": "luxury", "overrides": {"0": NaN}}'),
                       ("/v1/simulate-slabs", '{"scheme": "luxury", "component": "x", "edges": [NaN, 5],'
                                              ' "sources": [[0, 1], [1, 2], [2, null]]}')):
        r = _raw(path, body)
        assert r.status_code == 422, (path, body, r.status_code)
        detail = r.json()["detail"]
        assert isinstance(detail, str) and detail.startswith("This request was refused"), detail


def test_a_refusal_names_the_field_and_never_echoes_the_value():
    r = client.post("/v1/growth", json={"growth_pct": "ten"})
    assert r.status_code == 422 and "growth_pct" in r.json()["detail"] and "ten" not in r.json()["detail"]
    assert "is required" in client.post("/v1/simulate", json={}).json()["detail"]


def test_a_chunked_body_over_the_limit_is_413_not_400():
    def chunks():
        for _ in range(MAX_BODY_BYTES // 1_000_000 + 2):
            yield b"x" * 1_000_000
    r = client.post("/v1/growth", content=chunks(), headers={"content-type": "application/json"})
    assert r.status_code == 413 and "too large" in r.json()["detail"]


def test_filter_lists_are_limited_and_trimmed():
    from app.schemas import Scope
    assert client.post("/v1/months", json={"region": ["41"] * 501}).status_code == 422
    assert Scope(region=[" 41 ", "41", ""], zone=" North ").scope() == (("North",), ("41",), None)


def test_too_many_mix_edits_are_refused():
    from app.schemas import MAX_SHARE_EDITS
    edit = {"scope_kind": "all", "product": "Luxury", "metric": "volume", "mode": "A", "adjust_type": "share",
            "value": 10}
    r = client.post("/v1/months", json={"adjustments": [edit] * (MAX_SHARE_EDITS + 1)})
    assert r.status_code == 422 and "mix" in r.json()["detail"]


def test_export_with_an_open_lower_bound_is_not_a_500():
    from app.api.export import _slab
    assert _slab({"slab_mode": "band", "slab_lower": None, "slab_upper": 10}) == "up to 10"
    assert _slab({"slab_mode": "band", "slab_lower": None, "slab_upper": None}) == ""


def test_scope_values_with_spaces_or_a_number_spelling_match_the_frame():
    import pandas as pd

    from app.core.scope import apply_scope
    df = pd.DataFrame({"region": pd.Categorical(["41", "Delhi", "41"]), "depot_code": [1001, 1002, 1001]})
    assert len(apply_scope(df, region=" 41 ")) == 2
    assert len(apply_scope(df, region=["41.0"])) == 2
    assert len(apply_scope(df, depot_code="1001")) == 2


def test_export_lists_each_slabs_regions_beside_the_slab():
    import io

    from openpyxl import load_workbook

    from app.api.export import _regions, _slab
    assert _regions(["Haryana", "Delhi", "Delhi"]) == "Delhi, Haryana"
    assert _regions([]) == ""
    assert _slab({"slab_mode": "target", "slab_lower": 100, "slab_upper": 1684}) == "100 – 1,684"
    row = {"component": "C", "formula": "percent", "slab_mode": "slab", "slab_lower": 0, "slab_upper": 50,
           "cn_rate": 250, "simulated_rate": 4.5}
    r = client.post("/v1/export", json={"schemes": [{"key": "k", "label": "K", "rows": [
        {**row, "regions": ["Delhi", "Kerala"]}, {**row, "slab_lower": 50, "slab_upper": None, "regions": ["Kerala"]}]}]})
    assert r.status_code == 200
    ws = load_workbook(io.BytesIO(r.content))["Slabs"]
    assert [c.value for c in ws[1]][:5] == ["Scheme", "Component", "Applicable regions", "Slab", "Rate type"]
    assert [ws.cell(row=i, column=3).value for i in (2, 3)] == ["Delhi, Kerala", "Kerala"]
    assert (ws["I2"].number_format, ws["J2"].number_format) == ("#,##0", "#,##0.0###")   # 250, 4.5: no "250."
