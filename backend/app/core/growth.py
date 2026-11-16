"""
What a sales target costs in credit notes.

The business question is "we want to do X% more next month -- what does that do
to the payout?", and the tempting answer is to scale last month's CN by X%. That
answer is wrong, and wrong in the expensive direction.

Payout does not track sales, because slabs are thresholds. A dealer sitting just
under a boundary earns the LOW rate on everything; nudge them over and they earn
the HIGH rate on everything, including the volume they were already doing. So a
few percent more GSR can move a disproportionate number of dealers up a band and
lift the payout by much more than a few percent. The ratio between the two --
here called elasticity -- is the number worth knowing, and it is not 1.

So rather than scaling the aggregate, this grows each DEALER's achievement and
re-buckets them against the same slab table. Dealer counts per band change, and
the payout follows from where people land.

How each scheme type responds to growth is not uniform, and treating it as such
would quietly fabricate money:

    percent     cn_units = GSR/100            scales with the target
    per_unit    cn_units = litres             scales with the target
    per_pack    cn_units = whole packs        only the whole packs growth completes
                                              are added -- packs are a floor, so
                                              2.4 packs is still 2
    fixed       cn_units = 1 per dealer       does NOT scale. A flat amount per
                                              dealer is the same flat amount
                                              whatever they sell
    qualifier   cn_units = 0 unless qualified held as-is

Distributing the target: by default every scheme grows at the same rate, which
keeps each scheme's share of the book exactly where it is today -- that IS the
proportional-to-contribution case. A caller can override any scheme to model a
push concentrated in one part of the portfolio.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.core.scope import apply_scope
from app.core.slab_engine import edges_for


def _grown_units(sub: pd.DataFrame, g: float) -> pd.Series:
    """cn_units after growth, respecting how each formula actually behaves."""
    formula = str(sub.iloc[0].get("formula") or "percent")
    units = sub["cn_units"].astype(float)

    if formula == "fixed":
        # A flat amount per dealer. Selling more does not earn more of it; only
        # a dealer who newly QUALIFIES adds to it, which the re-bucket handles.
        return units
    if formula == "per_pack":
        # Packs are a floor, so growth adds only the WHOLE packs it completes. Those are added to the published
        # pack count rather than recounting from the basis: the recount does not always equal what was paid, and
        # at 0% growth it moved Terra 15 and Damp Guard by several lakh each.
        pack = float(sub.iloc[0].get("pack_size") or 0) or 1.0
        offset = float(sub.iloc[0].get("pack_offset") or 0.0)
        basis = sub["slab_basis"].astype(float)
        packs = lambda b: np.floor(np.maximum(b - offset, 0.0) / pack)
        return units + packs(basis * (1.0 + g)) - packs(basis)
    return units * (1.0 + g)


def _unexplained(sub: pd.DataFrame) -> float:
    """Payout that units x rate does not explain, held as it is under growth.

    The "Other (unattributed)" rows carry a scheme's payout that no slab row accounts for: no units, no rate, real
    money. Growth cannot scale what it cannot attribute, so it is carried through unchanged -- dropping it made a
    0% target "cost" tens of lakhs.
    """
    return float((sub["current_cn"] - sub["cn_units"] * sub["cn_rate"]).sum())


def grow_component(
    df: pd.DataFrame,
    scheme_key: str,
    component: str,
    g: float,
    zone: str | None = None,
    region: str | None = None,
    depot_code: str | None = None,
) -> dict | None:
    """Re-run one component with every dealer's achievement grown by `g`."""
    sub = apply_scope(
        df[(df["scheme"] == scheme_key) & (df["component"] == component)],
        zone, region, depot_code,
    )
    if sub.empty:
        return None

    sub = sub.copy()
    edges = list(edges_for(scheme_key, component))
    if not edges:
        # No slab table to cross, so payout moves with the base and nothing else.
        units = _grown_units(sub, g)
        cn = float((units * sub["cn_rate"].astype(float)).sum()) + _unexplained(sub)
        return {
            "component": component,
            "base_cn": float(sub["current_cn"].sum()),
            "grown_cn": cn,
            "base_gsr": float(sub["gsr"].sum()),
            "grown_gsr": float(sub["gsr"].sum() * (1.0 + g)),
            "dealers_moved_up": 0,
            "slab_driven": False,
        }

    arr = np.array(sorted(float(e) for e in edges))
    basis = sub["slab_basis"].astype(float).to_numpy()

    # A dealer earning 0% inside a paying band is a non-qualifier (Early Bird:
    # they did not hold the previous window's slab). Growth must not start
    # paying them -- qualification is a separate gate from achievement.
    cur_band = np.searchsorted(arr, basis, side="right")
    rate = sub["cn_rate"].astype(float).to_numpy()
    paying = cur_band[rate > 0]
    non_qual = (rate == 0) & (cur_band >= paying.min()) if len(paying) else np.zeros(len(sub), bool)

    new_band = np.searchsorted(arr, basis * (1.0 + g), side="right")

    # A band does not have ONE rate: regions run their own rate cards, so the
    # same band pays 0.4 in one region and 0.5 in another. Replacing a dealer's
    # rate with the band median therefore loses real money -- at zero growth it
    # rebuilt a test month about 5% below what the file actually paid, an error
    # that would have contaminated every delta measured from it.
    #
    # So a dealer KEEPS their own rate, and crossing a boundary scales it by the
    # step between bands rather than overwriting it. A dealer who does not move
    # is left exactly as they are, which makes g=0 reconstruct the month exactly.
    band_rate: dict[int, float] = {}
    for b in np.unique(np.concatenate([cur_band, new_band])):
        here = rate[(cur_band == b) & ~non_qual]
        here = here[here > 0]
        band_rate[int(b)] = float(np.median(here)) if len(here) else 0.0

    units = _grown_units(sub, g).to_numpy()
    eff = rate.copy()
    moved = new_band != cur_band
    for i in np.flatnonzero(moved):
        old_b, new_b = band_rate.get(int(cur_band[i]), 0.0), band_rate.get(int(new_band[i]), 0.0)
        if old_b > 0 and new_b > 0:
            eff[i] = rate[i] * (new_b / old_b)   # keep the region's card, take the step
        elif new_b > 0:
            eff[i] = new_b                        # was in a non-paying band; adopt the new one
        else:
            eff[i] = 0.0
    eff[non_qual] = 0.0

    return {
        "component": component,
        "base_cn": float(sub["current_cn"].sum()),
        "grown_cn": float((units * eff).sum()) + _unexplained(sub),
        "base_gsr": float(sub["gsr"].sum()),
        "grown_gsr": float(sub["gsr"].sum() * (1.0 + g)),
        "dealers_moved_up": int(((new_band > cur_band) & ~non_qual).sum()),
        "slab_driven": True,
    }


def grow_portfolio(
    df: pd.DataFrame,
    default_growth: float,
    per_scheme: dict[str, float] | None = None,
    rate_multipliers: dict[str, float] | None = None,
    zone=None,
    region=None,
    depot_code=None,
) -> dict:
    """Grow every scheme and report what the target costs.

    `per_scheme` overrides the growth rate for named schemes; anything not named
    grows at `default_growth`, which holds its share of the book constant.

    `rate_multipliers` folds in a rate card the user has edited but not adopted:
    for each scheme, simulated CN over current CN at today's volumes. It answers
    "what if next month runs at BOTH the new target and the new rates", which is
    the question a plan actually asks -- a target and a rate card are decided
    together, not one after the other.

    The multiplier is exact when a scheme's rates all move by the same factor,
    and an approximation when only some bands change, because growth also moves
    dealers between bands and the two effects compound. That is stated in the UI
    rather than hidden; resolving it exactly would mean re-running the edited
    rate card dealer by dealer, which is the Simulator's job, not a plan's.
    """
    per_scheme = per_scheme or {}
    rate_multipliers = rate_multipliers or {}
    scope = apply_scope(df, zone, region, depot_code)

    schemes: list[dict] = []
    for (key, label), part in scope.groupby(["scheme", "scheme_label"], sort=False, observed=True):
        g = per_scheme.get(str(key), default_growth)
        rows = [
            r for c in part["component"].unique()
            if (r := grow_component(df, str(key), str(c), g, zone, region, depot_code))
        ]
        if not rows:
            continue
        base_cn = sum(r["base_cn"] for r in rows)
        grown_cn = sum(r["grown_cn"] for r in rows)
        mult = float(rate_multipliers.get(str(key), 1.0))
        grown_cn_at_new_rates = grown_cn * mult
        schemes.append({
            "rate_multiplier": mult,
            "grown_cn_at_new_rates": grown_cn_at_new_rates,
            "scheme": str(key),
            "label": str(label),
            "growth_pct": g * 100,
            "base_cn": base_cn,
            "grown_cn": grown_cn,
            "delta_cn": grown_cn - base_cn,
            "base_gsr": sum(r["base_gsr"] for r in rows),
            "grown_gsr": sum(r["grown_gsr"] for r in rows),
            "dealers_moved_up": sum(r["dealers_moved_up"] for r in rows),
            # How hard this scheme's payout reacts to growth. Above 1 means the
            # slab structure amplifies the target; at 1 it merely tracks it.
            "elasticity": ((grown_cn / base_cn - 1) / g) if base_cn > 0 and g else 0.0,
        })

    schemes.sort(key=lambda s: abs(s["delta_cn"]), reverse=True)
    base_cn = sum(s["base_cn"] for s in schemes)
    grown_cn = sum(s["grown_cn"] for s in schemes)
    grown_cn_at_new_rates = sum(s["grown_cn_at_new_rates"] for s in schemes)

    # Business GSR is Value + Value % + Timbra, counted once per dealer -- never
    # the sum of per-scheme GSR, which counts the same sale several times.
    dealers = scope.drop_duplicates("customer_code")
    base_gsr = float(dealers["total_gsr"].sum()) if "total_gsr" in dealers else 0.0

    return {
        "default_growth_pct": default_growth * 100,
        "base_cn": base_cn,
        "grown_cn": grown_cn,
        "delta_cn": grown_cn - base_cn,
        "base_gsr": base_gsr,
        "grown_gsr": base_gsr * (1.0 + default_growth),
        "base_rate_pct": (base_cn / base_gsr * 100) if base_gsr else 0.0,
        "grown_rate_pct": (grown_cn / (base_gsr * (1 + default_growth)) * 100) if base_gsr else 0.0,
        "elasticity": ((grown_cn / base_cn - 1) / default_growth)
        if base_cn > 0 and default_growth else 0.0,
        "grown_cn_at_new_rates": grown_cn_at_new_rates,
        "rates_edited": bool(rate_multipliers)
        and any(abs(m - 1.0) > 1e-9 for m in rate_multipliers.values()),
        "dealers_moved_up": sum(s["dealers_moved_up"] for s in schemes),
        "schemes": schemes,
    }
