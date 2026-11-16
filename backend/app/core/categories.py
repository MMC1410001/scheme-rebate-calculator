"""Product categories for the month view: previous, current and next month side by side.

The extract has no product-category column (BRD v1.0.1's product dimension), but each product range runs its own
volume-slab scheme, and those schemes partition the book: a month's product schemes add up to about the whole
business GSR. So a category is a set of schemes:

- a BASE scheme gives the category its volume and GSR (and its CN);
- an ADD-ON scheme (per-50 L / per-100 L offers, ADDN, topcoat, Hilltop / Lakeside depots) adds CN only -- its sales
  are the base scheme's sales, so counting them again would double the volume and GSR;
- Value and Early Bird pay on the dealer's whole book, so they are one "whole book" line with CN only.

The mapping is an inference from scheme names, not client configuration: change it here.
"""
from __future__ import annotations

import pandas as pd

from app.core.scope import apply_scope

WHOLE_BOOK = "Value & Early Bird (whole book)"
OTHER = "Other products"

# Base product schemes: scheme key -> category. Their volume and GSR are the category's.
BASE: dict[str, str] = {
    "luxury": "Luxury",
    "decor_finish": "Luxury",
    "premium": "Premium",
    "hue_basic_glow_max": "Economy",
    "coat_lite_wall_neat": "Sub-economy",
    "easy_white_easy_fill": "Distemper & putty",
    "waterproofing": "Waterproofing",
    "damp_guard": "Waterproofing",
    "enamel": "Enamel",
    "topguard_gloss": "Enamel",
    "luster": "Enamel",
    "aerosol": "Enamel",
    "primer": "Primer",
    "enamel_primer": "Primer",
    "xt_primer": "Primer",
    "terra_15": "Texture",
    "stainers": "Stainers",
    "classic_pu_basket": "Wood finishes",
    "classic_pu_color": "Wood finishes",
    "pu_color": "Wood finishes",
    "melamine": "Wood finishes",
    "melamine_plus": "Wood finishes",
    "pu_thinner": "Wood finishes",
    "timbra_thinner": "Wood finishes",
    "slow_drying_thinner": "Wood finishes",
    "filler_stains": "Wood finishes",
    "velvetouch": "Wood finishes",
    "fxcoat": "Wood finishes",
    "roller": "Tools",
    "masking_tape": "Tools",
    "sandpaper": "Tools",
}
WHOLE_BOOK_SCHEMES = {"value_slab", "tmbr_value_slab", "early_bird", "tmbr_early_bird", "value_scheme"}
# Add-on schemes: key prefix -> category (first match wins). CN only.
ADDON_PREFIXES: list[tuple[str, str]] = [
    ("lux_", "Luxury"), ("addn_vivid_life", "Luxury"), ("vivid_look", "Luxury"),
    ("zen_", "Premium"), ("aquawash", "Premium"), ("aquaclear", "Premium"),
    ("hb_", "Economy"), ("gm_", "Economy"),
    ("wn_", "Sub-economy"), ("cl_", "Sub-economy"),
    ("emlsn_", "Emulsion add-ons"),
    ("damp_guard", "Waterproofing"), ("addn_wallmend", "Waterproofing"),
    ("topguard", "Enamel"), ("glossa", "Enamel"), ("enml_", "Enamel"), ("addn_hilltop_enamel", "Enamel"),
    ("addn_lakeside_enamel", "Enamel"), ("addn_hltp", "Enamel"),
    ("primer_", "Primer"), ("xt_primers", "Primer"),
    ("addn_texture", "Texture"), ("terr_", "Texture"),
    ("addn_tmbr", "Wood finishes"), ("melamine_", "Wood finishes"), ("pu_color_", "Wood finishes"),
]
ORDER = ["Luxury", "Premium", "Economy", "Sub-economy", "Distemper & putty", "Emulsion add-ons", "Waterproofing",
         "Enamel", "Primer", "Texture", "Wood finishes", "Stainers", "Tools", OTHER, WHOLE_BOOK]


def category_of(key: str) -> tuple[str, bool]:
    """(category, counts volume and GSR) for a scheme key."""
    if key in BASE:
        return BASE[key], True
    if key in WHOLE_BOOK_SCHEMES:
        return WHOLE_BOOK, False
    for prefix, cat in ADDON_PREFIXES:
        if key.startswith(prefix):
            return cat, False
    return OTHER, False


def dedup_sum(sub: pd.DataFrame, col: str, src: str) -> float:
    """Sum a measure counting each source column once per dealer. The one rule for every total of the app.

    Components of one scheme sometimes read the SAME column (Early Bird's EB1/EB2/EB3 are time windows over one
    full-month base: adding them reported about three times the dealers' real book), and sometimes different ones
    (Premium's real products, which must add up). Grouping on (dealer, source column) collapses the first and keeps
    the second; max rather than first because a component's row mask can leave the dealer a 0. A source of -1 is
    counted in no total (an add-on's litres, already in its scheme's main column).
    """
    if sub.empty or col not in sub:
        return 0.0
    if src not in sub:
        return float(sub[col].sum())
    sub = sub[sub[src] >= 0]
    return float(sub.groupby(["customer_code", src], sort=False, observed=True)[col].max().sum())


def scheme_figures(frame: pd.DataFrame, currency: dict[str, bool], zone=None, region=None, depot_code=None):
    """Per scheme of a month: volume, GSR, CN; plus the scope's dealers, business GSR and volume."""
    scoped = apply_scope(frame, zone, region, depot_code)
    rows = []
    for key, sub in scoped.groupby("scheme", observed=True, sort=False):
        key = str(key)
        rows.append({
            "scheme": key,
            "volume": dedup_sum(sub, "volume", "vol_src"),
            "gsr": dedup_sum(sub, "gsr", "gsr_src"),
            "cn": float(sub["current_cn"].sum()),
            "is_currency": bool(currency.get(key, True)),
            "dealer_ids": set(sub["customer_code"].unique().tolist()),
        })
    dealers = scoped.drop_duplicates("customer_code")
    totals = {
        "dealers": int(len(dealers)),
        "gsr": float(dealers["total_gsr"].sum()) if "total_gsr" in dealers else 0.0,
        "volume": dedup_sum(scoped, "volume", "vol_src"),
    }
    return rows, totals


def category_table(schemes: list[dict], total_gsr: float, total_dealers: int,
                   simulated_cn: dict[str, float] | None = None) -> dict:
    """Group per-scheme figures into category rows: volume, GSR, mix (share of volume), CN, CN % of GSR.

    `simulated_cn` (scheme -> CN) replaces a scheme's CN with the user's edited figure, for the current month.
    """
    cats: dict[str, dict] = {}
    for s in schemes:
        if not s["is_currency"]:
            continue  # gift schemes count gifts, not rupees
        cat, counts = category_of(s["scheme"])
        c = cats.setdefault(cat, {"category": cat, "volume": 0.0, "gsr": 0.0, "cn": 0.0, "simulated_cn": 0.0,
                                  "schemes": [], "scheme_rows": [], "dealer_ids": set()})
        if counts:
            c["volume"] += s["volume"]
            c["gsr"] += s["gsr"]
            c["dealer_ids"] |= s.get("dealer_ids", set())
        cn = s["cn"]
        c["cn"] += cn
        c["simulated_cn"] += (simulated_cn or {}).get(s["scheme"], cn)
        c["schemes"].append(s["scheme"])
        # The scheme's own figures, for its row under the product. An add-on's volume and GSR are the base scheme's
        # sales again, so they are shown on its row but never added to the product.
        sim = (simulated_cn or {}).get(s["scheme"], cn)
        c["scheme_rows"].append({
            "scheme": s["scheme"], "counts": counts, "dealers": len(s.get("dealer_ids", ())) or None,
            "volume": s["volume"] or None, "gsr": s["gsr"] or None, "cn": cn, "simulated_cn": sim,
            "cn_pct": 100 * cn / s["gsr"] if s["gsr"] else None,
            "simulated_cn_pct": 100 * sim / s["gsr"] if s["gsr"] else None,
        })
    product_volume = sum(c["volume"] for k, c in cats.items() if k != WHOLE_BOOK)
    product_gsr = sum(c["gsr"] for k, c in cats.items() if k != WHOLE_BOOK)
    # Sales in no product scheme: the business GSR not reached by any category (small; can be slightly negative
    # where two schemes share a product).
    rest = total_gsr - product_gsr
    if abs(rest) > 1:
        c = cats.setdefault(OTHER, {"category": OTHER, "volume": 0.0, "gsr": 0.0, "cn": 0.0, "simulated_cn": 0.0,
                                    "schemes": [], "scheme_rows": [], "dealer_ids": set()})
        c["gsr"] += rest
    rows = []
    for name in sorted(cats, key=lambda k: ORDER.index(k) if k in ORDER else len(ORDER)):
        c = dict(cats[name])
        whole = name == WHOLE_BOOK
        ids = c.pop("dealer_ids")
        rows.append({
            **c,
            # Dealers buying the category's products; the whole-book line covers every dealer in scope.
            "dealers": total_dealers if whole else (len(ids) or None),
            "volume": None if whole else c["volume"],
            "gsr": None if whole else c["gsr"],
            "mix_pct": None if whole or not product_volume else 100 * c["volume"] / product_volume,
            # The whole-book schemes pay on all sales, so their rate is against the business GSR.
            "cn_pct": (100 * c["cn"] / (total_gsr if whole else c["gsr"])) if (total_gsr if whole else c["gsr"]) else None,
            "simulated_cn_pct": (100 * c["simulated_cn"] / (total_gsr if whole else c["gsr"]))
            if (total_gsr if whole else c["gsr"]) else None,
        })
    cn = sum(c["cn"] for c in cats.values())
    sim = sum(c["simulated_cn"] for c in cats.values())
    return {
        "rows": rows,
        "total": {"dealers": total_dealers, "volume": product_volume, "gsr": total_gsr, "cn": cn, "simulated_cn": sim,
                  "cn_pct": 100 * cn / total_gsr if total_gsr else None,
                  "simulated_cn_pct": 100 * sim / total_gsr if total_gsr else None},
    }
