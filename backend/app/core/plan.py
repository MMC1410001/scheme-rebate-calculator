"""Next month: the current month's dealers grown, priced under the slab structure the user is planning.

Every dealer's achievement, volume, GSR and CN units are grown by one factor (slab_engine.grow_frame): the current
month as shown times the planned volume change (no pace by days since 4 Nov 2026). Each component is then
re-bucketed under its layout -- the user's edited one where they changed rates or boundaries, otherwise the served
table, each dealer keeping their own region's rate card (slab_engine.assign_dealers). A dealer who grows across a
boundary is counted in the band reached but keeps their actual-month rate (qualification stays on the actual
month); only a moved boundary or a rate edit changes what a dealer is paid. The Plan tab's /growth
(app/core/growth.py) is a separate engine that re-rates crossers; both are kept as built (user, 5 Nov 2026).

Payout no slab explains ("Other (unattributed)", qualifier blocks) is carried at its actual amount.
"""
from __future__ import annotations

from collections.abc import Callable

import pandas as pd

from app.core.scope import apply_scope
from app.core.slab_engine import edges_for, rebucket


def default_layout(scheme_key: str, component: str) -> dict:
    """The served table as a layout: the national edges, each band its own source."""
    edges = [float(e) for e in edges_for(scheme_key, component)]
    bounds = [0.0, *edges]
    sources = [(lo, bounds[i + 1] if i + 1 < len(bounds) else None) for i, lo in enumerate(bounds)]
    return {"edges": edges, "rates": None, "sources": sources, "rate_overrides": []}


def is_carried(component: str, formula: str) -> bool:
    return component.startswith("Other (unattributed)") or formula == "qualifier"


def carried_cn(rows: pd.DataFrame) -> float:
    """Payout no slab explains, at its actual amount (times a CN % edit's rate factor, app/core/scenario.py)."""
    cn = rows["current_cn"].astype(float)
    return float((cn * rows["cn_scale"]).sum() if "cn_scale" in rows else cn.sum())


def plan_schemes(grown: pd.DataFrame, layouts: dict[str, dict], zone=None, region=None, depot_code=None,
                 schemes: set[str] | None = None, with_rows: bool = False,
                 reuse: Callable[[str, str], float | None] | None = None,
                 component_cn: dict[tuple[str, str], float] | None = None) -> dict[str, dict]:
    """Per scheme: next month's CN under `layouts` ("scheme::component" -> layout; others as served).

    With with_rows, also each component's slab rows (rebucket output) for the slab tables.
    `reuse(scheme, component)`: the CN of a component under its served table when it is known to be unchanged
    (None: compute it); used only for a component on its served table and without rows.
    `component_cn`: filled with the CN of each re-slabbed component.
    """
    scoped = apply_scope(grown, zone, region, depot_code)
    if schemes is not None:
        scoped = scoped[scoped["scheme"].isin(list(schemes))]
    out: dict[str, dict] = {}
    pairs = scoped[["scheme", "component", "formula"]].drop_duplicates(["scheme", "component"])
    for scheme, component, formula in pairs.itertuples(index=False):
        scheme, component = str(scheme), str(component)
        entry = out.setdefault(scheme, {"cn": 0.0, "components": {}})
        if is_carried(component, str(formula)):
            sub = scoped[(scoped["scheme"] == scheme) & (scoped["component"] == component)]
            entry["cn"] += carried_cn(sub)
            continue
        edited = layouts.get(f"{scheme}::{component}")
        if reuse is not None and not edited and not with_rows:
            known = reuse(scheme, component)
            if known is not None:
                entry["cn"] += known
                continue
        layout = edited or default_layout(scheme, component)
        rows = rebucket(grown, scheme, component, layout["edges"], layout.get("rates"),
                        zone, region, depot_code, sources=layout.get("sources"),
                        rate_overrides=layout.get("rate_overrides") or [])
        cn = 0.0 if rows.empty else float(rows["simulated_cn"].sum())
        if component_cn is not None:
            component_cn[(scheme, component)] = cn
        if rows.empty:
            continue
        entry["cn"] += cn
        if with_rows:
            entry["components"][component] = rows
    return out


def slab_rows(rows: pd.DataFrame, cn_col: str) -> list[dict]:
    """One component's slab rows in the Book1 shape: slab, dealers, volume, product mix, GSR, CN %, CN."""
    if rows.empty:
        return []
    total_volume = float(rows["volume"].sum())
    out = []
    for r in rows.to_dict("records"):
        cn = float(r[cn_col])
        gsr = float(r["gsr"] or 0.0)
        upper = r.get("slab_upper")
        out.append({
            "component": r["component"],
            "formula": r["formula"],
            "pack_size": int(r.get("pack_size") or 0),
            "slab_mode": r["slab_mode"],
            "slab_index": int(r["slab_index"]),
            "slab_lower": None if pd.isna(r.get("slab_lower")) else float(r["slab_lower"]),
            "slab_upper": None if upper is None or pd.isna(upper) else float(upper),
            "dealers": int(r["dealer_count"]),
            "volume": float(r["volume"] or 0.0),
            "mix_pct": 100 * float(r["volume"] or 0.0) / total_volume if total_volume else None,
            "gsr": gsr,
            "rate": float(r.get("simulated_rate", r["cn_rate"]) if cn_col == "simulated_cn" else r["cn_rate"]),
            # The band's rate before edits: with slab_index, it picks the row's dealers (POST /dealers).
            "cn_rate": float(r["cn_rate"]),
            "cn": cn,
            "cn_pct": 100 * cn / gsr if gsr else None,
            "regions": list(r.get("regions") or ()),
        })
    return out


def growth_factor(volume_growth_pct: float) -> float:
    """Next month = the current month as shown x (1 + V). No pace by days elapsed (user's choice, 4 Nov 2026): the
    extract date is not how many days of sales a file holds (Nov'26 v5, dated day 4, holds about a full month), and
    x month_days / elapsed_days planned next month at 7.5 times November."""
    return 1 + volume_growth_pct / 100

