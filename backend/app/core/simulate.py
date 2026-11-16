"""
Applies user-edited CN rates to a slab table and returns before/after CN per
slab plus totals.

Caveat worth stating to stakeholders: this holds dealer volumes FIXED. In
reality a higher slab rate pulls more dealers over their next threshold, so the
true cost of a rate increase is somewhat higher than shown -- and the extra
volume it buys is not modelled here either.
"""
from __future__ import annotations

import pandas as pd


def simulate(slabs: pd.DataFrame, overrides: dict[str, float]) -> pd.DataFrame:
    result = slabs.copy()
    if result.empty:
        result["simulated_rate"] = []
        result["simulated_cn"] = []
        result["delta_cn"] = []
        return result

    result["simulated_rate"] = [
        overrides.get(row_id, rate) for row_id, rate in zip(result["row_id"], result["cn_rate"])
    ]

    rate = result["cn_rate"].astype(float)
    new = result["simulated_rate"].astype(float)
    units = result["cn_units"].astype(float)

    # An UNTOUCHED row returns exactly what was paid -- nothing is re-derived
    # for it, so the baseline cannot drift. That matters because some rows carry
    # payout with no rate behind it: the unattributed residual, and lines the
    # file settled outside the rate card. Recomputing those as units x 0 quietly
    # deleted lakhs from a simulation nobody had touched.
    #
    # An EDITED row is rebuilt. Scaling the actual payout by the change in rate
    # keeps regional rate cards intact (a band can hold dealers on several), and
    # a row with no current rate to scale from falls back to its units.
    changed = new != rate
    scaled = result["current_cn"] * new.div(rate.where(rate != 0, 1.0))
    recomputed = scaled.where(rate != 0, units * new)
    result["simulated_cn"] = result["current_cn"].where(~changed, recomputed)

    result["delta_cn"] = result["simulated_cn"] - result["current_cn"]
    return result


def totals(result: pd.DataFrame) -> dict:
    if result.empty:
        return {"dealer_count": 0, "current_cn": 0.0, "simulated_cn": 0.0, "delta_cn": 0.0}
    current = float(result["current_cn"].sum())
    simulated = float(result["simulated_cn"].sum())
    return {
        "dealer_count": int(result["dealer_count"].sum()),
        "current_cn": current,
        "simulated_cn": simulated,
        "delta_cn": simulated - current,
        # GSR is what the payout is measured against, so the UI can show the
        # blended CN% -- the figure the business actually steers on.
        "gsr": float(result["gsr"].sum()) if "gsr" in result else 0.0,
        "volume": float(result["volume"].sum()) if "volume" in result else 0.0,
    }
