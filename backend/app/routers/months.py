"""The Simulator's month table (previous, current and next month by product), gift schemes and the trend."""
from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from app import access
from app.auth import Session, current_user
from app.core.categories import category_of, category_table, scheme_figures
from app.core.gifts import gift_detail
from app.core.plan import plan_schemes, slab_rows
from app.core.slab_engine import build_slabs, grow_frame
from app.schemas import (
    EditedMonthsRequest,
    GiftDetailRequest,
    MonthsRequest,
    PlanRequest,
    ProductEdit,
    SchemeMonthsRequest,
)
from app.service import live

router = APIRouter(tags=["months"])

ScopeParam = Annotated[list[str] | None, Query(max_length=500)]
NO_EDITS = "[]"     # adj_key() of no edits
SERVED = "{}"       # layouts key of the served slab tables


def _next_header(volume_growth_pct: float, factor: float) -> dict:
    return {"month": live.next_month_label(), "from_month": live.month_label(),
            "volume_growth_pct": volume_growth_pct, "factor": factor,
            "pace_factor": factor / (1 + volume_growth_pct / 100)}  # always 1 now; kept for /v1 clients


@router.get("/months")
def get_months(zone: ScopeParam = None, region: ScopeParam = None, depot_code: ScopeParam = None):
    """Previous (settled) and current month by product category: volume, GSR, mix, CN, CN % of GSR."""
    return live.months_cached(*live.scope_of(zone, region, depot_code))


@router.post("/months")
def post_months(req: MonthsRequest, request: Request, user: Session = Depends(current_user)):
    """GET /months with the user's GSR / volume edits applied to the current month (CN stays actual here: the
    browser adds its re-priced slab tables to it, as for rate edits)."""
    access.check_request(user, req, request)
    scope = live.scope_of(req.zone, req.region, req.depot_code)
    base = live.months_cached(*scope)
    if not req.adjustments:
        return base
    frame, warnings = live.current_frame(req.adjustments)
    return {"previous": base["previous"], "current": live.month_block(live.month_label(), *scope, frame=frame),
            "warnings": warnings}


@router.post("/months/next")
def post_next_month(req: PlanRequest, request: Request, user: Session = Depends(current_user)):
    """Next month by product category: the current month as shown, grown by the volume change, under
    the slab structure being planned. Impact = that CN minus the CN of the same volumes under the served structure.
    """
    access.check_request(user, req, request)
    scope = live.scope_of(req.zone, req.region, req.depot_code)
    factor = live.plan_factor(req.volume_growth_pct)
    adj, next_adj = live.adj_key(req.adjustments), live.adj_key(req.next_adjustments)
    planned = live.plan_cached(factor, req.layouts_key(), adj, next_adj, *scope)
    # Impact is against next month with no edits at all: the same V, the served structure.
    served = live.plan_cached(factor, SERVED, NO_EDITS, NO_EDITS, *scope)
    removed = set(req.removed_schemes)
    frame, warnings = live.next_frame(req.adjustments, req.next_adjustments, factor)
    schemes, scheme_totals = scheme_figures(frame, live.currency_by_scheme(), *scope)
    for s in schemes:
        s["cn"] = served.get(s["scheme"], 0.0)
    table = category_table(schemes, scheme_totals["gsr"], scheme_totals["dealers"],
                           simulated_cn={k: 0.0 if k in removed else planned.get(k, 0.0) for k in served})
    return {
        **_next_header(req.volume_growth_pct, factor),
        "edited": bool(req.layouts or req.next_layouts or removed or req.adjustments or req.next_adjustments),
        "warnings": warnings,
        **table,
    }


def _edited_block(frame, edits: dict[str, ProductEdit], layouts: dict, removed: set[str], scope: tuple,
                  planned: dict[str, float], baseline: dict[str, float], replan: set[str],
                  carried: dict[str, float] | None = None) -> tuple[dict, dict[str, float]]:
    """One month of the Month table with product edits applied, and the rate factor each product ended on.

    `frame` is the month as it stands before the product edits: the current month with its GSR / volume edits, or
    next month (grown, with both months' edits). A scheme whose product's volume is edited is grown dealer by dealer
    and re-slabbed under `layouts`; so are the schemes in `replan`. Every other scheme keeps its `planned` CN. A price
    edit scales GSR and CN; a CN % target then scales the product's rates to meet it, else the `carried` factor (the
    current month's, for next month) applies. Whole-book schemes (Value, Early Bird) are left as they are.
    """
    schemes, scheme_totals = scheme_figures(frame, live.currency_by_scheme(), *scope)
    one = ProductEdit()
    edit = {s["scheme"]: edits.get(category_of(s["scheme"])[0], one) for s in schemes}
    grown = {k for k, e in edit.items() if abs(e.volume - 1) > 1e-9} | replan
    if grown:
        sub = frame[frame["scheme"].isin(list(grown))]
        factors = {k: edit.get(k, one).volume for k in grown}
        factor = sub["scheme"].astype(str).map(factors).fillna(1.0).to_numpy(dtype=float)
        with live.HEAVY:
            regrown = plan_schemes(grow_frame(sub, factor), layouts, *scope, schemes=grown)
        planned = {**planned, **{k: v["cn"] for k, v in regrown.items()}}
    gsr_delta, sim = 0.0, {}
    cat_gsr: dict[str, float] = {}
    cat_cn: dict[str, float] = {}
    for s in schemes:
        k, e = s["scheme"], edit[s["scheme"]]
        cat, counts = category_of(k)
        old_gsr = s["gsr"]
        s["volume"] *= e.volume
        s["gsr"] = old_gsr * e.volume * e.price
        if counts:
            gsr_delta += s["gsr"] - old_gsr
            cat_gsr[cat] = cat_gsr.get(cat, 0.0) + s["gsr"]
        s["cn"] = baseline.get(k, 0.0)
        sim[k] = 0.0 if k in removed else planned.get(k, 0.0) * e.price
        cat_cn[cat] = cat_cn.get(cat, 0.0) + sim[k]
    rates = dict(carried or {})
    for cat, e in edits.items():
        if e.cn_pct is not None and cat_cn.get(cat, 0.0) > 0:
            rates[cat] = e.cn_pct / 100 * cat_gsr.get(cat, 0.0) / cat_cn[cat]
    for s in schemes:
        sim[s["scheme"]] *= rates.get(category_of(s["scheme"])[0], 1.0)
    return category_table(schemes, scheme_totals["gsr"] + gsr_delta, scheme_totals["dealers"],
                          simulated_cn=sim), rates


@router.post("/months/edited")
def post_edited_months(req: EditedMonthsRequest, request: Request, user: Session = Depends(current_user)):
    """The Month table's current and next month with product edits (Volume, Mix, GSR, CN %), on top of the GSR /
    volume edits (adjustments, next_adjustments) and the slab tables (layouts; next month: next_layouts on top).

    Impact: current = edited CN - actual CN; next = edited plan - next month's plan with no edits at all.
    """
    access.check_request(user, req, request)
    scope = live.scope_of(req.zone, req.region, req.depot_code)
    removed = set(req.removed_schemes)
    base_frame, currency = live.month_frame(live.month_label())
    actual = {s["scheme"]: s["cn"] for s in scheme_figures(base_frame, currency, *scope)[0]}

    # Current month: the GSR / volume edits first; every scheme they or a slab table touch is re-slabbed.
    layouts = {k: v.engine_args() for k, v in req.layouts.items()}
    cur_frame, _ = live.current_frame(req.adjustments)
    touched = live.changed_pairs(cur_frame, live.get_df())
    edited_schemes = ({str(s) for s in cur_frame["scheme"].unique()} if touched is None
                      else {str(s) for s, _ in touched})
    replan = {k.split("::", 1)[0] for k in layouts} | edited_schemes
    current, cur_rates = _edited_block(cur_frame, req.current, layouts, removed, scope, actual, actual, replan)

    # Next month starts from the edited current month: its volume and price factors on top of the current ones, and
    # the current month's rate factors unless next month has its own CN % target. Next month's own slab tables
    # replace the current month's per component.
    one = ProductEdit()
    combined = {c: ProductEdit(volume=req.current.get(c, one).volume * req.next.get(c, one).volume,
                               price=req.current.get(c, one).price * req.next.get(c, one).price,
                               cn_pct=req.next.get(c, one).cn_pct)
                for c in set(req.current) | set(req.next)}
    factor = live.plan_factor(req.volume_growth_pct)
    adj, next_adj = live.adj_key(req.adjustments), live.adj_key(req.next_adjustments)
    planned = live.plan_cached(factor, req.layouts_key(), adj, next_adj, *scope)
    served = live.plan_cached(factor, SERVED, NO_EDITS, NO_EDITS, *scope)
    next_frame, _ = live.next_frame(req.adjustments, req.next_adjustments, factor)
    next_layouts = {k: v.engine_args() for k, v in {**req.layouts, **req.next_layouts}.items()}
    nxt, _ = _edited_block(next_frame, combined, next_layouts, removed, scope, planned, served, set(),
                           carried=cur_rates)
    return {"current": current, "next": {**_next_header(req.volume_growth_pct, factor), "edited": True, **nxt}}


@router.post("/months/scheme")
def post_scheme_months(req: SchemeMonthsRequest, request: Request, user: Session = Depends(current_user)):
    """One scheme's slab tables for the previous month (as settled) and next month (as planned), in the Book1 shape:
    slab, dealers, volume, product mix, GSR, CN %, CN -- and, next month, the impact against the served structure.
    The current month's table is the one the user edits in the browser.
    """
    access.check_request(user, req, request)
    live.require_scheme(req.scheme)
    scope = live.scope_of(req.zone, req.region, req.depot_code)
    previous = None
    prev_label = live.previous_label()
    if prev_label:
        frame, _ = live.month_frame(prev_label)
        if (frame["scheme"] == req.scheme).any():
            rows = build_slabs(frame, req.scheme, *scope, edge_frame=frame)
            previous = {"month": prev_label, "components": {
                str(c): slab_rows(g, "current_cn") for c, g in rows.groupby("component", sort=False)}}
    factor = live.plan_factor(req.volume_growth_pct)
    layouts = json.loads(req.layouts_key())
    grown = live.next_frame(req.adjustments, req.next_adjustments, factor)[0]
    planned = plan_schemes(grown, layouts, *scope, schemes={req.scheme}, with_rows=True).get(req.scheme, {})
    served = plan_schemes(live.grown_frame(factor), {}, *scope, schemes={req.scheme},
                          with_rows=True).get(req.scheme, {})
    nxt = {}
    for comp, rows in planned.get("components", {}).items():
        base = served.get("components", {}).get(comp)
        nxt[comp] = {"rows": slab_rows(rows, "simulated_cn"),
                     "impact": float(rows["simulated_cn"].sum() - (base["simulated_cn"].sum() if base is not None else 0))}
    return {"scheme": req.scheme, "previous": previous,
            "next": {"month": live.next_month_label(), "factor": factor, "components": nxt}}


# ---- Gift schemes: the gift / contest file, kept apart from CN (app/ingest/gifts.py, app/core/gifts.py) ----------

@router.get("/gifts")
def get_gifts(zone: ScopeParam = None, region: ScopeParam = None, depot_code: ScopeParam = None):
    """Gift schemes of the previous and current month: dealers, dealers qualified, gifts earned (a count; rupees for a
    rupee scheme such as 5% Nova Prime), volume and GSR. Never part of CN. A month without a gift file has no schemes."""
    return live.gifts_cached(*live.scope_of(zone, region, depot_code))


@router.post("/gifts/detail")
def post_gift_detail(req: GiftDetailRequest, request: Request, user: Session = Depends(current_user)):
    """One gift scheme in depth for a scope: totals, dealers by gifts earned, by region; with a new rule value or a
    volume change, each dealer's gifts recomputed by the scheme's rule (only where the rule reproduces the file).
    Never part of CN, and nothing is kept: the edits travel with the request."""
    if req.rule_value is not None or req.volume_pct:
        access.check_scheme(user, req.scheme, f"the gift scheme {req.scheme}", request)
    label = live.gift_month()
    meta, frame = live.gift_frame(label) if label else (None, None)
    if frame is None:
        raise HTTPException(404, "No gift data in the system yet for the current or the previous month")
    out = gift_detail(frame, req.scheme, *live.scope_of(req.zone, req.region, req.depot_code), rule_value=req.rule_value, volume_pct=req.volume_pct)
    if out is None:
        raise HTTPException(404, f"There is no gift scheme '{req.scheme}' in this month's gift data")
    if out["rule"] is None and (req.rule_value is not None or req.volume_pct):
        raise HTTPException(422, "This scheme's rule cannot be read from the gift file, so it cannot be edited")
    return {"month": label, "as_of": meta.as_of, "version": meta.version, **out}


@router.get("/trend")
def get_trend():
    """Month-on-month movement (complete months) and projected partial months. Served from cached JSON text."""
    return Response(live.trend_payload(), media_type="application/json")
