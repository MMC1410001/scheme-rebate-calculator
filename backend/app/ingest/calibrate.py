"""
Picks each component's payout formula from the DATA rather than from column names.

Column names in this export cannot be trusted to imply a formula:
  "LUXURY CN%"     -> really a percent of GSR
  "VALUE FA CN%"   -> a flat rupee amount per dealer
  "STAINERS CN%"   -> also a flat rupee amount, with no "FA" in the name
  "... Per 40 L"   -> a flat amount per whole 40L pack, not a linear rate

Each component has its own "<name> Clear Cut" column in the raw file, which is
the file's own computed CN for that component. We take it as ground truth, try
every candidate (base column x formula), and keep whichever reproduces it.
Anything we cannot reproduce is left flagged so reconciliation reports it rather
than silently shipping a wrong number.
"""
from __future__ import annotations

import dataclasses

import numpy as np
import pandas as pd

from app.core.scheme_config import Component, SchemeConfig

MATCH_TOL = 0.01          # 1% relative tolerance
MIN_MATCH_SHARE = 0.95    # a candidate must explain 95% of paying rows
# Always tried, because the names lie about pack size: "Waterproofing Per L" really
# pays per 50 L, and "TERRA 15" pays per 25 units.
COMMON_PACKS = (1, 4, 5, 10, 12, 20, 24, 25, 40, 50, 100, 200, 250, 500, 1000)


def _candidates(comp: Component) -> list[tuple[str, int | None, int | None]]:
    """(formula, base_col, pack_size) options worth testing for this component."""
    out: list[tuple[str, int | None, int | None]] = [("fixed", None, None)]
    bases = {comp.gsrb_col, comp.qty_col, comp.base_col} | set(comp.alt_base_cols)
    for col in sorted(c for c in bases if c is not None):
        if col is None:
            continue
        out.append(("percent", col, None))
        out.append(("per_unit", col, None))
        packs = set(COMMON_PACKS) | ({comp.pack_size} if comp.pack_size else set())
        for p in sorted(packs):
            out.append(("per_pack", col, p))
    return out


def _compute(formula: str, base: pd.Series | None, rate: pd.Series, pack: int | None,
             offset: float = 0.0) -> pd.Series:
    if formula == "fixed":
        return rate
    assert base is not None
    if formula == "percent":
        return base * rate / 100
    if formula == "per_pack":
        return ((base - offset).clip(lower=0) // (pack or 1)) * rate
    return base * rate


def _solve_offset(base: pd.Series, rate: pd.Series, truth: pd.Series, pack: int) -> float:
    """Recover the qualifying floor of a per-pack scheme.

    If CN = floor((base - offset)/pack) * rate then n = CN/rate is the pack count
    and (base - n*pack) lands in [offset, offset + pack). The smallest such
    residual across dealers therefore sits just above the real offset.
    """
    n = (truth / rate).round()
    ok = (n > 0) & np.isclose(truth / rate, n, rtol=0.001, atol=0.001)
    if ok.sum() < 10:
        return 0.0
    residual = base[ok] - n[ok] * pack
    # The residual sits in [offset, offset + pack), so snapping its median down to
    # a whole pack recovers the offset. Using the median (not the minimum) keeps
    # rows that belong to a different base column from dragging the estimate
    # negative.
    est = float(np.floor(residual.median() / pack) * pack)
    return max(0.0, est)


def calibrate_component(raw: pd.DataFrame, comp: Component) -> tuple[Component, dict]:
    info = {"component": comp.name, "resolved": False, "match": 0.0, "formula": comp.formula}
    if comp.clear_cut_col is None or comp.clear_cut_col not in raw.columns:
        return comp, info

    truth = raw[comp.clear_cut_col].fillna(0)
    rate = raw[comp.rate_col].fillna(0)

    # A block whose own Clear Cut is zero everywhere pays nothing: it is a
    # qualification stage, not a payout line (July splits Early Bird this way --
    # EB SLAB 1/2/3 set the rate, EB FULL MONTH carries the money). Computing a
    # payout for it would double count the scheme.
    if (truth == 0).all() and (rate != 0).any():
        info.update(formula="qualifier", resolved=True, match=1.0)
        return dataclasses.replace(comp, formula="qualifier"), info

    # Only rows that actually pay out tell us anything about the formula.
    mask = (truth != 0) & (rate != 0)
    if mask.sum() < 20:
        return comp, info

    truth_m, rate_m = truth[mask], rate[mask]
    best = None
    for formula, base_col, pack in _candidates(comp):
        base_m = raw[base_col].fillna(0)[mask] if base_col is not None else None
        if base_m is not None and (base_m == 0).all():
            continue
        offsets = [0.0]
        if formula == "per_pack" and base_m is not None:
            solved = _solve_offset(base_m, rate_m, truth_m, pack or 1)
            if solved > 0:
                offsets.append(solved)
        for offset in offsets:
            got = _compute(formula, base_m, rate_m, pack, offset)
            share = float(np.isclose(got, truth_m, rtol=MATCH_TOL, atol=0.5).mean())
            if best is None or share > best[0]:
                best = (share, formula, base_col, pack, offset)

    if best is None:
        return comp, info

    share, formula, base_col, pack, offset = best
    info.update(match=round(share, 4), formula=formula, resolved=share >= MIN_MATCH_SHARE,
                pack=pack, offset=offset)
    if share < MIN_MATCH_SHARE:
        return comp, info  # keep the name-based guess, but flagged as unresolved

    updated = dataclasses.replace(
        comp,
        formula=formula,
        base_col=base_col if base_col is not None else comp.base_col,
        pack_size=pack,
        pack_offset=offset,
    )
    return updated, info


def _component_cn(raw: pd.DataFrame, comp: Component, formula: str) -> pd.Series:
    base = raw[comp.base_col].fillna(0)
    rate = raw[comp.rate_col].fillna(0)
    cn = _compute(formula, base, rate, comp.pack_size, comp.pack_offset)
    for zero_col in comp.requires_zero_cols:
        cn = cn.where(raw[zero_col].fillna(0) == 0, 0)
    return cn


def calibrate_scheme(raw: pd.DataFrame, cfg: SchemeConfig, unresolved: set[str]) -> SchemeConfig:
    """Decide the rate scale for components that have no ground truth of their own.

    Early Bird's EB1/EB2/EB3 have no per-window Clear Cut column, so nothing pins
    their formula individually -- but their SUM must equal the scheme's Clear Cut.
    That matters because the same scheme changes units between months: September
    writes 0.4 meaning 0.4%, August writes 0.005 meaning the same thing. Guessing
    wrong is a 100x error, so it is measured rather than assumed.
    """
    if cfg.clear_cut_total_col is None or not unresolved:
        return cfg
    if cfg.clear_cut_total_col not in raw.columns:
        return cfg

    truth = raw[cfg.clear_cut_total_col].fillna(0)
    mask = truth != 0
    if mask.sum() < 20:
        return cfg

    best_choice, best_share = None, -1.0
    for candidate in ("percent", "per_unit"):
        total = pd.Series(0.0, index=raw.index)
        for comp in cfg.components:
            formula = candidate if (comp.name in unresolved and comp.formula in ("percent", "per_unit")) else comp.formula
            total = total + _component_cn(raw, comp, formula)
        share = float(np.isclose(total[mask], truth[mask], rtol=MATCH_TOL, atol=1.0).mean())
        if share > best_share:
            best_choice, best_share = candidate, share

    if best_share < MIN_MATCH_SHARE or best_choice is None:
        return cfg
    comps = [
        dataclasses.replace(c, formula=best_choice)
        if (c.name in unresolved and c.formula in ("percent", "per_unit"))
        else c
        for c in cfg.components
    ]
    return dataclasses.replace(cfg, components=comps)


def calibrate(raw: pd.DataFrame, schemes: dict[str, SchemeConfig]) -> tuple[dict[str, SchemeConfig], pd.DataFrame]:
    calibrated: dict[str, SchemeConfig] = {}
    report: list[dict] = []
    for key, cfg in schemes.items():
        comps, unresolved = [], set()
        for comp in cfg.components:
            new_comp, info = calibrate_component(raw, comp)
            comps.append(new_comp)
            if not info["resolved"]:
                unresolved.add(comp.name)
            report.append({"scheme": key, **info})
        cfg = dataclasses.replace(cfg, components=comps)
        # Components with no ground truth of their own are pinned by the scheme total.
        calibrated[key] = calibrate_scheme(raw, cfg, unresolved)
    return calibrated, pd.DataFrame(report)
