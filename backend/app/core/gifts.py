"""
Gift schemes per month: the gift / contest file's figures for a scope, kept apart from CN (app/ingest/gifts.py).

Measured on October v24: "Clear Cut" is the number of gifts a dealer earned (Glossa Gift: 1 per 30 L, 2 at 60 L
...; Vivid Look Shine: 1 per 25 L) and "CN%" is 1 once the dealer qualifies. Shine On is the exception: both
columns are 1 or 2, which reads as a gift tier rather than a count -- confirm with the client. A scheme whose Clear
Cut is not a whole number (5% Nova Prime) pays rupees, and is shown in rupees, still outside CN.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.core.scope import apply_scope


def unit_of(clear_cut: pd.Series) -> str:
    """'rupees' when any Clear Cut is not a whole number (5% Nova Prime), else 'gifts' (a count)."""
    return "rupees" if bool(((clear_cut.fillna(0) % 1).abs() > 1e-9).any()) else "gifts"


def gift_table(frame: pd.DataFrame, zone=None, region=None, depot_code=None) -> list[dict]:
    """One row per scheme, most gifts first: dealers with sales, dealers qualified, gifts (or rupees), volume, GSR."""
    sub = apply_scope(frame, zone, region, depot_code)
    rows = []
    for scheme, g in sub.groupby("scheme", sort=False):
        earned = g["clear_cut"].fillna(0)
        rupees = unit_of(earned) == "rupees"
        rows.append({
            "scheme": scheme,
            "unit": "rupees" if rupees else "gifts",
            "dealers": int((g["volume"].fillna(0) > 0).sum()),
            "qualified": int((g["level"].fillna(0) > 0).sum()),
            "earned": round(float(earned.sum()), 2),
            "rate": float(g["level"].max()) if rupees else None,
            "volume": round(float(g["volume"].fillna(0).sum()), 2),
            "gsr": round(float(g["gsr"].fillna(0).sum()), 2),
        })
    return sorted(rows, key=lambda r: (r["unit"] != "gifts", -r["earned"]))


# ---- One gift scheme in depth, and what-if edits of its rule (user's request, 3 Nov 2026) ------------------------
# A rule is only offered for editing when it reproduces the file itself for almost every dealer. Measured on October
# v24: Glossa Gift = 1 gift per 30 L (over 99% of dealers), Vivid Look Shine = 1 per 25 L (over 99%), 5% Nova Prime = 5%
# of GSR (exact). The other schemes (Shine On tiers, one-gift thresholds, wallpaper counts) follow no rule that can
# be read from the file, so they are shown but not edited.
RULE_MATCH = 0.99
# Gifts earned, grouped for the table: 0, 1 ... 5, 6-9, 10+.
LEVELS = [(0, 0, "0"), (1, 1, "1"), (2, 2, "2"), (3, 3, "3"), (4, 4, "4"), (5, 5, "5"), (6, 9, "6 – 9"),
          (10, None, "10+")]


def infer_rule(g: pd.DataFrame) -> dict | None:
    """The scheme's rule when it reproduces the file: per_litre (gifts = floor(volume / litres)) or pct_gsr (rupees =
    pct % of GSR, for the qualified). With how many dealers it matches. None when no rule does."""
    g = g.fillna(0)
    q = g[g["clear_cut"] > 0]
    if q.empty:
        return None
    if unit_of(g["clear_cut"]) == "rupees":
        ratio = (q["clear_cut"] / q["gsr"].where(q["gsr"] > 0)).dropna()
        if ratio.empty:
            return None
        pct = round(float(ratio.median()) * 100, 4)
        match = float((np.abs(ratio * 100 - pct) < 0.01).mean())
        return {"kind": "pct_gsr", "value": pct, "match": match} if match >= RULE_MATCH else None
    litres = round(float((q["volume"] / q["clear_cut"]).min()))
    if litres <= 0:
        return None
    match = float((np.floor(g["volume"] / litres + 1e-9) == g["clear_cut"]).mean())
    return {"kind": "per_litre", "value": float(litres), "match": match} if match >= RULE_MATCH else None


def gift_detail(frame: pd.DataFrame, scheme: str, zone=None, region=None, depot_code=None,
                rule_value: float | None = None, volume_pct: float = 0.0) -> dict | None:
    """One gift scheme: totals, dealers by gifts earned, and by region. With edits (a new rule value, and / or the
    scheme's volume moved by volume_pct, each dealer's GSR with it at the same price), every dealer's gifts are
    recomputed by the rule; the change is added to what the file says they earned, so an untouched scheme shows exactly
    the file. The rule is read from the whole country, the figures from the scope."""
    whole = frame[frame["scheme"] == scheme]
    if whole.empty:
        return None
    rule = infer_rule(whole)
    sub = apply_scope(whole, zone, region, depot_code).fillna({"volume": 0, "gsr": 0, "level": 0, "clear_cut": 0})
    rupees = unit_of(whole["clear_cut"]) == "rupees"
    edited = rule is not None and ((rule_value is not None and rule_value != rule["value"]) or volume_pct != 0)
    k = 1 + volume_pct / 100
    vol, gsr, earned = sub["volume"].to_numpy(float), sub["gsr"].to_numpy(float), sub["clear_cut"].to_numpy(float)
    qualified = sub["level"].to_numpy(float) > 0
    new_vol, new_gsr, new_earned, new_qualified = vol, gsr, earned, qualified
    if edited:
        value = rule["value"] if rule_value is None else rule_value
        new_vol, new_gsr = vol * k, gsr * k
        if rule["kind"] == "per_litre":
            before = np.floor(vol / rule["value"] + 1e-9)
            after = np.floor(new_vol / value + 1e-9)
            new_earned = np.maximum(earned + after - before, 0.0)
            new_qualified = new_earned > 0
        else:
            # Qualification is the file's (the scheme's entry condition is not in it); the qualified earn pct of GSR.
            new_earned = np.where(qualified, earned + new_gsr * value / 100 - gsr * rule["value"] / 100, 0.0)

    def figures(mask=slice(None)) -> dict:
        out = {"dealers": int((vol[mask] > 0).sum()), "qualified": int(qualified[mask].sum()),
               "earned": round(float(earned[mask].sum()), 2), "volume": round(float(vol[mask].sum()), 2),
               "gsr": round(float(gsr[mask].sum()), 2)}
        if edited:
            out.update({"edited_qualified": int(new_qualified[mask].sum()),
                        "edited_earned": round(float(new_earned[mask].sum()), 2),
                        "edited_volume": round(float(new_vol[mask].sum()), 2),
                        "edited_gsr": round(float(new_gsr[mask].sum()), 2)})
        return out

    # Dealers by gifts earned (with edits: by the gifts they would earn). A rupee scheme: qualified or not.
    levels = []
    by = new_earned if edited else earned
    if rupees:
        for label, m in (("Qualified", new_qualified if edited else qualified),
                         ("Not qualified", ~(new_qualified if edited else qualified))):
            if m.any():
                levels.append({"label": label, **figures(m)})
    else:
        for lo, hi, label in LEVELS:
            m = (by >= lo) & (by <= (hi if hi is not None else np.inf))
            if m.any():
                levels.append({"label": label, **figures(m)})
    regions = [{"region": str(r), **figures((sub["region"] == r).to_numpy())}
               for r in sorted(sub["region"].astype(str).unique())]
    regions.sort(key=lambda r: -r.get("edited_earned", r["earned"]))
    return {"scheme": scheme, "unit": "rupees" if rupees else "gifts", "rule": rule, "edited": edited,
            "rule_value": (rule["value"] if rule_value is None else rule_value) if rule else None,
            "volume_pct": volume_pct if rule else 0.0,
            "totals": figures(), "levels": levels, "regions": regions}
