"""The current month's schemes and slab tables, the what-if slab edits, the dealer list, growth and the export."""
from __future__ import annotations

import logging
from typing import Annotated

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from app import access
from app.api.export import build_workbook
from app.auth import NOT_ALLOWED, Session, current_user
from app.core.plan import carried_cn, default_layout, is_carried
from app.core.scope import apply_scope
from app.core.simulate import simulate, totals
from app.core.slab_engine import assign_dealers, dealers_in_row, edges_of, rebucket
from app.schemas import (
    AdjustedSlabsRequest,
    DealersRequest,
    ExportRequest,
    GrowthRequest,
    SimulateRequest,
    SlabSimRequest,
)
from app.service import live

router = APIRouter(tags=["slabs"])
# Who opened which dealer list (client data) and when; never the dealers themselves.
audit = logging.getLogger("app.audit")

# Each dimension repeats to select several: ?region=Delhi&region=Haryana.
ScopeParam = Annotated[list[str] | None, Query(max_length=500)]


@router.get("/schemes")
def list_schemes():
    status = live.get_status_by_key()
    return [
        {"key": s.key, "label": s.label, "type": s.scheme_type, "status": status.get(s.key, "unknown")}
        for s in live.get_exposed_schemes().values()
    ]


@router.get("/reconciliation")
def get_reconciliation():
    """Computed CN vs the raw file's own scheme-total column, per scheme."""
    return live.reconciliation_cached()


@router.get("/filters")
def list_filters():
    df = live.get_df()
    pairs = df[["zone", "region", "depot_code"]].drop_duplicates()
    return {
        "zones": sorted(df["zone"].dropna().unique().tolist()),
        "regions": sorted(df["region"].dropna().unique().tolist()),
        "depots": sorted(df["depot_code"].dropna().unique().tolist()),
        # lets the UI narrow Region/Depot to the selected Zone
        "hierarchy": pairs.dropna().to_dict(orient="records"),
    }


@router.get("/all-slabs")
def get_all_slabs(zone: ScopeParam = None, region: ScopeParam = None, depot_code: ScopeParam = None):
    """Every integrated scheme for the selected scope, in a single payload. The UI recomputes impact locally from
    cn_units, so one fetch covers the whole what-if session until the selection changes."""
    return live.all_slabs_cached(*live.scope_of(zone, region, depot_code))


@router.get("/slabs")
def get_slabs(scheme: Annotated[str, Query(max_length=100)], zone: ScopeParam = None, region: ScopeParam = None,
              depot_code: ScopeParam = None):
    live.require_scheme(scheme)
    return live.slabs_payload_cached(scheme, *live.scope_of(zone, region, depot_code))


@router.post("/all-slabs/adjusted")
def post_all_slabs_adjusted(req: AdjustedSlabsRequest, request: Request,
                             user: Session = Depends(current_user)):
    """/all-slabs with the user's GSR / volume edits: every component re-bucketed on the edited month under its
    served table, each dealer keeping their region's card. current_cn stays the actual payout (so impact is against
    actual) and simulated_cn is what the edited month pays. Payout no slab explains is carried as it is."""
    access.check_request(user, req, request)
    scope = live.scope_of(req.zone, req.region, req.depot_code)
    cached = live.all_slabs_cached(*scope)
    if req.scheme is not None:
        live.require_scheme(req.scheme)
    # A copy of only what this handler changes: the top level, each scheme, its totals and its list of rows (a row
    # dict that is changed is copied where it is changed). A deep copy of the whole view cost every edit.
    view = {**cached, "grand": dict(cached["grand"]),
            "schemes": [{**p, "totals": dict(p["totals"]), "rows": list(p["rows"])} for p in cached["schemes"]
                        if req.scheme is None or p["key"] == req.scheme]}
    frame, warnings = live.current_frame(req.adjustments)
    view["warnings"] = warnings
    if not req.adjustments:
        return view
    scoped = apply_scope(frame, *scope)
    by_scheme = {str(k): g for k, g in scoped.groupby("scheme", sort=False, observed=True)}
    # A component no edit reaches gives the unedited month's result, which is cached (None: re-slab all).
    touched = live.touched_current(req.adjustments)
    for p in view["schemes"]:
        sub = by_scheme.get(p["key"])
        rows = [dict(r) for r in p["rows"] if is_carried(r["component"], r["formula"])]
        if rows and sub is not None and "cn_scale" in sub:
            # A CN % edit also scales payout carried outside the slabs.
            for r in rows:
                own = sub[sub["component"] == r["component"]]
                actual = float(own["current_cn"].sum())
                scale = carried_cn(own) / actual if actual else 1.0
                r["simulated_cn"] = r["current_cn"] * scale
                r["delta_cn"] = r["simulated_cn"] - r["current_cn"]
        for component in dict.fromkeys(r["component"] for r in p["rows"] if not is_carried(r["component"], r["formula"])):
            if touched is not None and (p["key"], component) not in touched:
                rows += [dict(r) for r in live.served_component_records(p["key"], component, *scope)]
                continue
            layout = default_layout(p["key"], component)
            rows += live.records(rebucket(frame, p["key"], component, layout["edges"], None, *scope,
                                          sources=layout["sources"]))
        p["rows"] = rows
        t = p["totals"]
        t["simulated_cn"] = sum(r.get("simulated_cn", r["current_cn"]) or 0 for r in rows)
        t["delta_cn"] = t["simulated_cn"] - t["current_cn"]
        if sub is not None:
            t["gsr"], t["volume"] = live.scheme_gsr_of(sub), live.dedup_sum(sub, "volume", "vol_src")
    dealers = scoped.drop_duplicates("customer_code")
    view["grand"] = {**view["grand"], "gsr": float(dealers["total_gsr"].sum()),
                     "volume": live.dedup_sum(scoped, "volume", "vol_src")}
    return view


@router.post("/simulate-slabs")
def post_simulate_slabs(req: SlabSimRequest, request: Request, user: Session = Depends(current_user)):
    """Re-slab a component against moved boundaries. Unlike /simulate (which only changes rates), this re-buckets
    dealers, so dealer count, volume, GSR and payout all move together."""
    live.check_component(req.scheme, req.component)
    args = req.engine_args()
    access.check(user, [*access.request_edits(req),
                        *access.layout_edits({f"{req.scheme}::{req.component}": args}, "current")], request)
    rows = rebucket(live.current_frame(req.adjustments)[0], req.scheme, req.component, args.pop("edges"),
                    args.pop("rates"), *live.scope_of(req.zone, req.region, req.depot_code), **args)
    if rows.empty:
        return {"scheme": req.scheme, "component": req.component, "rows": [], "totals": {}}
    current = float(rows["current_cn"].sum())
    simulated = float(rows["simulated_cn"].sum())
    return {
        "scheme": req.scheme,
        "component": req.component,
        "rows": live.records(rows),
        "totals": {
            "dealer_count": int(rows["dealer_count"].sum()),
            "current_cn": current,
            "simulated_cn": simulated,
            "delta_cn": simulated - current,
        },
    }


@router.post("/dealers")
def post_dealers(req: DealersRequest, request: Request, user: Session = Depends(current_user)):
    """The dealers behind one slab row: who they are, what they achieved, and what they earn.

    For the table as served, the same rules as build_slabs pick the dealers, so the total equals the row's dealer
    count. For a table with moved boundaries, the layout is re-applied dealer by dealer. Client data: dealer codes
    and names, one page at a time (ADMIN only). With codes_only, just the codes a slab's Volume / GSR edit is scoped
    to (no names; for the login that makes that edit).
    """
    if not req.codes_only and not user.can_see_dealers:
        raise HTTPException(403, NOT_ALLOWED)
    edits = access.request_edits(req)
    if req.layout is not None:
        edits.append(access.table_edit(req.scheme, req.component, req.layout.engine_args()))
    access.check(user, edits, request)
    scope = live.scope_of(req.zone, req.region, req.depot_code)
    if not req.codes_only:
        audit.info("dealer list: user=%s scheme=%s component=%s month=%s scope=%s", user.username, req.scheme,
                   req.component, req.month, scope)
    if req.codes_only and req.whole_component:
        if req.month != "current":
            raise HTTPException(422, "A whole component's dealers are listed for the current month only")
        live.check_component(req.scheme, req.component)
        frame = live.current_frame(req.adjustments)[0]
        sub = apply_scope(frame[(frame["scheme"] == req.scheme) & (frame["component"] == req.component)], *scope)
        codes = sorted(sub["customer_code"].astype(str).unique().tolist())
        return {"scheme": req.scheme, "component": req.component, "dealers_in_row": len(codes), "codes": codes}
    if req.month == "previous":
        prev_label = live.previous_label()
        frame = live.month_frame(prev_label)[0] if prev_label else None
        if frame is None or not ((frame["scheme"] == req.scheme) & (frame["component"] == req.component)).any():
            raise HTTPException(404, "This slab table is not in the previous month's data")
        dealers = dealers_in_row(frame, req.scheme, req.component, req.row.model_dump(), *scope,
                                 edges=edges_of(frame, req.scheme, req.component))
        if not dealers.empty:
            dealers = dealers.assign(simulated_rate=dealers["cn_rate"], simulated_cn=dealers["current_cn"])
        layout = None
    else:
        live.check_component(req.scheme, req.component)
        layout = req.layout.engine_args() if req.layout is not None else None
        if layout is None and (req.month == "next" or req.adjustments):
            # Next month, or a current month with GSR / volume edits: dealers re-bucketed under the served table.
            layout = default_layout(req.scheme, req.component)
    if req.month == "current" and layout is None:
        dealers = dealers_in_row(live.get_df(), req.scheme, req.component, req.row.model_dump(), *scope)
        if not dealers.empty:
            dealers = dealers.assign(simulated_rate=dealers["cn_rate"], simulated_cn=dealers["current_cn"])
    elif layout is not None:
        frame = (live.current_frame(req.adjustments)[0] if req.month == "current" else
                 live.next_frame(req.adjustments, req.next_adjustments, live.plan_factor(req.volume_growth_pct))[0])
        args = {k: layout.get(k) for k in ("edges", "rates", "sources", "rate_overrides")}
        dealers = assign_dealers(frame, req.scheme, req.component, **args,
                                 zone=scope[0], region=scope[1], depot_code=scope[2])
        if not dealers.empty:
            if req.row.slab_mode == "unrated":
                dealers = dealers[dealers["slab_mode"] == "unrated"]
            else:
                dealers = dealers[(dealers["slab_mode"] == "slab")
                                  & (dealers["slab_index"] == req.row.slab_index)
                                  & ((dealers["band_rate"] - round(req.row.cn_rate, 4)).abs() < 1e-9)]
    total_in_row = int(dealers["customer_code"].nunique()) if not dealers.empty else 0
    if req.codes_only:
        codes = sorted(dealers["customer_code"].astype(str).unique().tolist()) if not dealers.empty else []
        return {"scheme": req.scheme, "component": req.component, "dealers_in_row": total_in_row, "codes": codes}
    if not dealers.empty and req.q.strip():
        q = req.q.strip().lower()
        dealers = dealers[dealers["customer_code"].astype(str).str.lower().str.contains(q, regex=False)
                          | dealers["customer_name"].fillna("").astype(str).str.lower().str.contains(q, regex=False)]
    total = int(len(dealers))
    pages = max(1, -(-total // req.page_size))
    page = min(req.page, pages)
    rows = []
    if total:
        shown = dealers.sort_values(["slab_basis", "customer_code"], ascending=[False, True])
        shown = shown.iloc[(page - 1) * req.page_size: page * req.page_size]
        rows = [
            {
                "customer_code": str(r.customer_code),
                "customer_name": None if pd.isna(r.customer_name) else str(r.customer_name),
                "zone": str(r.zone), "region": str(r.region), "depot_code": str(r.depot_code),
                # GSR (Q) -- or volume (Q) where the slab is decided in litres -- the dealer's slab is measured on.
                "achievement": float(r.slab_basis),
                # The file's "Next Slab" column is the SHORTFALL to the next slab; the next slab itself is
                # achievement + shortfall (the same sum that recovers the slab edges). 0 / None in the top slab.
                "shortfall": float(r.next_slab),
                "next_slab": float(r.slab_basis + r.next_slab) if r.next_slab > 0 else None,
                # Share of the next slab already reached: achievement / next slab (Book1, column R).
                "reached_pct": float(100 * r.slab_basis / (r.slab_basis + r.next_slab))
                if r.next_slab > 0 and r.slab_basis + r.next_slab > 0 else None,
                "volume": float(r.volume), "gsr": float(r.gsr),
                "cn_rate": float(r.cn_rate), "simulated_rate": float(r.simulated_rate),
                "current_cn": float(r.current_cn), "simulated_cn": float(r.simulated_cn),
                "od_blocked": bool(r.od_blocked),
            }
            for r in shown.itertuples(index=False)
        ]
    return {"scheme": req.scheme, "component": req.component, "dealers_in_row": total_in_row,
            "total": total, "page": page, "pages": pages, "page_size": req.page_size, "rows": rows}


@router.post("/simulate")
def post_simulate(req: SimulateRequest, request: Request, user: Session = Depends(current_user)):
    live.require_scheme(req.scheme)
    if req.overrides:
        access.check_scheme(user, req.scheme, f"the rates of {req.scheme}", request)
    slabs = live.slabs_cached(req.scheme, *live.scope_of(req.zone, req.region, req.depot_code))
    result = simulate(slabs, req.overrides)
    return {"scheme": req.scheme, "rows": live.records(result), "totals": totals(result)}


@router.post("/growth")
def post_growth(req: GrowthRequest):
    """What a sales target costs in credit notes. Grows each DEALER's achievement and re-buckets them, so the answer
    includes dealers crossing slab boundaries -- the reason payout does not simply track sales. The Plan's calculator:
    it changes no scheme and saves nothing, so every role may use it."""
    return live.growth_cached(
        round(req.growth_pct, 4),
        tuple(sorted((k, round(v, 4)) for k, v in (req.per_scheme or {}).items())),
        tuple(sorted((k, round(v, 6)) for k, v in (req.rate_multipliers or {}).items())),
        *live.scope_of(req.zone, req.region, req.depot_code),
    )


@router.post("/export")
def post_export(req: ExportRequest):
    """The view as an Excel workbook: Summary, Schemes and Slabs, with the user's edits.

    The browser sends its rows (edits exist only there); the month, as-of date and the scope's dealers, volume and
    GSR come from the server. Nothing is stored.
    """
    view = live.all_slabs_cached(*live.scope_of(req.zone, req.region, req.depot_code))
    content, name = build_workbook(req, view["source"], view["grand"])
    return Response(
        content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"},
    )
