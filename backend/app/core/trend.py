"""
Month-on-month comparison across ingested files.

Two things the business can act on that a single month cannot show:

  * scheme trend    -- how volume, GSR and payout moved, and whether the payout
                       rate (CN as a % of GSR) drifted.
  * slab migration  -- which dealers moved up a slab, slipped down, or sit just
                       below a threshold. The last group is the actionable one:
                       a dealer 5% short of the next slab is a phone call, not a
                       forecast.

Schemes are matched on their canonical name, so labels that drift between months
("Hue Basic & Glow Max - Economy") still line up.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def scheme_trend(months: dict[str, pd.DataFrame], only_currency: set[str] | None = None) -> pd.DataFrame:
    """One row per (scheme, month) with the headline figures.

    `months` maps a label ("2026-07") to that month's tidy frame, ordered by key.
    """
    frames = []
    for label, df in sorted(months.items()):
        if df.empty:
            continue
        sub = df if only_currency is None else df[df["scheme"].isin(only_currency)]
        g = sub.groupby("scheme", as_index=False).agg(
            scheme_label=("scheme_label", "first"),
            dealers=("customer_code", "nunique"),
            volume=("volume", "sum"),
            gsr=("gsr", "sum"),
            cn=("current_cn", "sum"),
        )
        g["month"] = label
        frames.append(g)

    if not frames:
        return pd.DataFrame()

    out = pd.concat(frames, ignore_index=True)
    out["cn_pct_of_gsr"] = np.where(out["gsr"] > 0, out["cn"] / out["gsr"] * 100, np.nan)
    out = out.sort_values(["scheme", "month"])
    for col in ("volume", "gsr", "cn", "dealers"):
        out[f"{col}_mom_pct"] = out.groupby("scheme")[col].pct_change() * 100
    return out.reset_index(drop=True)


def slab_migration(
    prev_df: pd.DataFrame,
    curr_df: pd.DataFrame,
    scheme: str,
    component: str,
    edges: list[float],
) -> dict:
    """Where dealers sat last month vs this month, against one slab table.

    Both months are bucketed against the SAME edges, otherwise "moved up" would
    just mean "the slab table changed".
    """
    def banded(df: pd.DataFrame) -> pd.DataFrame:
        sub = df[(df["scheme"] == scheme) & (df["component"] == component)]
        if sub.empty:
            return pd.DataFrame(columns=["customer_code", "band", "slab_basis", "current_cn"])
        idx = np.searchsorted(np.array(sorted(edges)), sub["slab_basis"].to_numpy(), side="right")
        return sub.assign(band=idx)[["customer_code", "band", "slab_basis", "current_cn"]]

    prev, curr = banded(prev_df), banded(curr_df)
    if prev.empty or curr.empty:
        return {"scheme": scheme, "component": component, "rows": [], "summary": {}}

    merged = curr.merge(prev, on="customer_code", how="outer", suffixes=("_curr", "_prev"))
    merged["band_curr"] = merged["band_curr"].fillna(-1)
    merged["band_prev"] = merged["band_prev"].fillna(-1)

    moved_up = int((merged["band_curr"] > merged["band_prev"]).sum())
    moved_down = int((merged["band_curr"] < merged["band_prev"]).sum())
    held = int((merged["band_curr"] == merged["band_prev"]).sum())

    return {
        "scheme": scheme,
        "component": component,
        "summary": {
            "moved_up": moved_up,
            "moved_down": moved_down,
            "held": held,
            "cn_prev": float(prev["current_cn"].sum()),
            "cn_curr": float(curr["current_cn"].sum()),
        },
        "matrix": (
            merged.groupby(["band_prev", "band_curr"]).size().reset_index(name="dealers")
            .to_dict(orient="records")
        ),
    }


def near_threshold(df: pd.DataFrame, scheme: str, component: str, edges: list[float],
                   within_pct: float = 10.0) -> pd.DataFrame:
    """Dealers sitting just below their next slab edge.

    This is where a slab scheme actually bites: a dealer a few percent short is
    the cheapest incremental volume available, and the same bunching is what
    makes raw sales a biased basis for forecasting.
    """
    sub = df[(df["scheme"] == scheme) & (df["component"] == component)].copy()
    if sub.empty or not edges:
        return pd.DataFrame()

    arr = np.array(sorted(edges))
    idx = np.searchsorted(arr, sub["slab_basis"].to_numpy(), side="right")
    next_edge = np.where(idx < len(arr), arr[np.clip(idx, 0, len(arr) - 1)], np.nan)
    sub["next_edge"] = next_edge
    sub["gap"] = sub["next_edge"] - sub["slab_basis"]
    sub["gap_pct"] = np.where(sub["next_edge"] > 0, sub["gap"] / sub["next_edge"] * 100, np.nan)
    hit = sub[(sub["gap"] > 0) & (sub["gap_pct"] <= within_pct)]
    return hit[
        ["zone", "region", "depot_code", "customer_code", "customer_name",
         "slab_basis", "next_edge", "gap", "gap_pct", "current_cn"]
    ].sort_values("gap_pct")
