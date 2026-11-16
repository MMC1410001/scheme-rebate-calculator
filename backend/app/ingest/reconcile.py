"""
Compares computed CN (sum of base*rate / flat amounts, per our config) against
the raw file's own "<Scheme> CN" total column, per scheme. This is how we
decide which auto-discovered schemes are trustworthy enough to expose in the
what-if simulator, instead of assuming the name-matching heuristic worked.
"""
from __future__ import annotations

import pandas as pd

from app.core.scheme_config import SchemeConfig


def reconcile(df: pd.DataFrame, configs: dict[str, SchemeConfig]) -> pd.DataFrame:
    rows = []
    for key, cfg in configs.items():
        subset = df[df["scheme"] == key]
        if subset.empty:
            rows.append({"scheme": key, "label": cfg.label, "status": "no_data", "computed_cn": 0,
                         "raw_total_cn": 0, "diff_pct": None, "components": len(cfg.components)})
            continue
        # The business reads CN off "Clear Cut" -- the payout before condonation --
        # so that is the target. Falls back to the scheme's CN column (which does
        # include condonation) only when the block publishes no Clear Cut.
        # Best target: the sum of each component's own Clear Cut. It is per-row, so
        # it stays correct when several blocks roll up into one scheme -- unlike a
        # single scheme-level total, which belongs to only one of them.
        per_comp = subset["component_clear_cut"] if "component_clear_cut" in subset else None
        if per_comp is not None and per_comp.notna().any():
            # Rows carry the file's Clear Cut by construction, so the real test is what the components explain:
            # the block total less the "Other (unattributed)" line, which holds whatever no component accounts for.
            unexplained = subset.loc[subset["component"].astype(str).str.startswith("Other (unattributed)"),
                                     "current_cn"].sum()
            raw_total = subset["current_cn"].sum()
            computed = raw_total - unexplained
            diff_pct = None if raw_total == 0 else round(100 * (computed - raw_total) / raw_total, 2)
            rows.append({
                "scheme": key, "label": cfg.label,
                "status": ("qualifier" if all(c.formula == "qualifier" for c in cfg.components)
                           else "no_data" if raw_total == 0 and computed == 0
                           else "ok" if diff_pct is not None and abs(diff_pct) <= 2
                           else "needs_review"),
                "computed_cn": round(float(computed), 2),
                "raw_total_cn": round(float(raw_total), 2),
                "diff_pct": diff_pct,
                "components": len(cfg.components),
            })
            continue

        has_cc = cfg.clear_cut_total_col is not None and subset["clear_cut_total"].notna().any()
        if has_cc:
            computed = subset["current_cn"].sum()
            raw_total = subset.drop_duplicates("customer_code")["clear_cut_total"].sum()
        else:
            computed = subset["current_cn"].sum() + subset["condonation_amount"].sum()
            raw_total = subset.drop_duplicates("customer_code")["scheme_cn"].sum()
        diff_pct = None if raw_total == 0 else round(100 * (computed - raw_total) / raw_total, 2)
        if all(c.formula == "qualifier" for c in cfg.components):
            # Sets rates for another block to pay out; nothing to reconcile here.
            status = "qualifier"
        elif raw_total == 0 and computed == 0:
            status = "no_data"  # scheme inactive this month
        elif diff_pct is not None and abs(diff_pct) <= 2:
            status = "ok"
        else:
            status = "needs_review"
        rows.append({
            "scheme": key,
            "label": cfg.label,
            "status": status,
            "computed_cn": round(float(computed), 2),
            "raw_total_cn": round(float(raw_total), 2),
            "diff_pct": diff_pct,
            "components": len(cfg.components),
        })
    return pd.DataFrame(rows).sort_values("status")
