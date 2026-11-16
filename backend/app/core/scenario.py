"""What-if edits of GSR and volume: the actual month with dealer-level changes, priced by the engine.

The actual frame is never changed. Each adjustment becomes a factor per dealer and product (or scheme); every row of
the frame is then scaled by its factor with slab_engine.grow_frame (the same rule as next month's growth:
achievement, volume, GSR and CN units, as each formula behaves; qualification stays on the actual month) and
re-bucketed with assign_dealers under the user's slab tables, or the served ones. So a dealer who crosses a boundary
moves slab and is paid that band's rate in their region's card, and dealer counts, CN and CN % per slab follow.

Products are the categories of app/core/categories.py: a BASE scheme gives a product its GSR and volume per dealer.
In the month table the cell that is edited decides what an edit means (user's choice, 2 Nov 2026):

- B, total GSR or volume: every product of the dealer moves by the same %, and so does the whole book.
- P, one product's GSR or volume: only that product moves; the dealer's total moves with it.
- A, one product's mix (or a % / rupee move with the total held): sales move into (or out of) the product and the
  dealer's other products give (or take) the same rupees in proportion, so the total GSR stays the same. A target
  mix ("share") is solved for the scope as a whole.
- S, one scheme's GSR or volume: only that scheme's rows move (a base scheme's sales also move the dealer's total).
- Q, one product's GSR as a price change: GSR per litre moves, litres do not. GSR, a % of GSR paid as CN, and a slab
  measured in rupees move with it; a slab in litres and CN paid per litre or per pack stay (from a teammate's version).
- R, one product's CN % or CN: every rate of the product's schemes scales until its CN / GSR (or its CN) is the
  figure typed, payout carried outside the slabs included (from a teammate's version). Stored as the rate factor. With
  product "*" (the total's CN) every rate of every scheme scales.
- C, one scheme's CN: every rate of that scheme scales until its CN is the figure typed (3 Nov 2026).

Litres follow each dealer's own Rs per litre of the product. A dealer with no sales in a product is left out of an
edit of that product (warning): they have no row in its schemes, so there is no rate card to price new sales with.
Rows of schemes outside a product (Value, Early Bird, add-on lines without a base scheme) follow the dealer's total.

An adjustment's scope is All India, or one or more zones, regions, depots ("A|B") or one dealer: the filters the
user was looking through. Every view applies every adjustment, so an edit made for one region shows in All India
and an All India edit shows in every region. Broader scopes apply first; within a scope B, P, Q, A, S, R, C.
"""
from __future__ import annotations

import weakref

import numpy as np
import pandas as pd

from app.core.categories import BASE, category_of, dedup_sum
from app.core.plan import carried_cn, default_layout, is_carried, slab_rows
from app.core.slab_engine import aggregate_bands, assign_dealers, grow_frame

PRODUCTS = list(dict.fromkeys(BASE.values()))
REST = "__rest__"   # the dealer's GSR in no product scheme
SPECIFICITY = {"all": 0, "zone": 1, "region": 2, "depot": 3, "dealer": 4}
MODES = {"B": 0, "P": 1, "Q": 2, "A": 3, "S": 4, "R": 5, "C": 6}
_COLUMN = {"zone": "zone", "region": "region", "depot": "depot_code"}


def _product_figures(df: pd.DataFrame):
    """Per dealer: GSR and volume of each product and each base scheme (each source column once), and geography."""
    dealers = df.drop_duplicates("customer_code").set_index("customer_code")[
        ["zone", "region", "depot_code", "total_gsr"]]
    base = df[df["scheme"].astype(str).isin(BASE)][["customer_code", "scheme", "gsr", "gsr_src", "volume", "vol_src"]]
    base = base.assign(scheme=base["scheme"].astype(str))
    # Each source column once per dealer and scheme, its largest value: the rule of categories.dedup_sum.
    gsr = (base.groupby(["customer_code", "scheme", "gsr_src"], sort=False)["gsr"].max()
           .groupby(level=["customer_code", "scheme"]).sum())
    kept = base[base["vol_src"] >= 0]
    vol = (kept.groupby(["customer_code", "scheme", "vol_src"], sort=False)["volume"].max()
           .groupby(level=["customer_code", "scheme"]).sum())

    def wide(s: pd.Series) -> pd.DataFrame:
        s = s.rename(index=BASE, level="scheme")
        out = s.groupby(level=[0, 1]).sum().unstack("scheme", fill_value=0.0)
        return out.reindex(index=dealers.index, columns=PRODUCTS, fill_value=0.0).astype(float)

    g = wide(gsr)
    g[REST] = dealers["total_gsr"].astype(float) - g[PRODUCTS].sum(axis=1)
    by_scheme = gsr.unstack("scheme", fill_value=0.0).reindex(index=dealers.index, fill_value=0.0).astype(float)
    return g, wide(vol), by_scheme, dealers


# The last frame's _product_figures and row mapping. Edits keep arriving against the same frame (the live month, or the
# edited current month for next month), and these are ~0.8 s of a ~1.3 s edit. Keyed on the frame object itself.
_INDEX: list = [None]


def _frame_index(df: pd.DataFrame):
    """_product_figures(df), plus per row: its dealer's position, its product's column (-1: none) and its scheme's
    code (with the scheme names)."""
    hit = _INDEX[0]
    if hit is not None and hit[0]() is df:
        return hit[1]
    g0f, v0f, by_scheme, dealers = _product_figures(df)
    pos = dealers.index.get_indexer(df["customer_code"])
    codes, names = pd.factorize(df["scheme"])
    names = [str(k) for k in names]
    col_of = np.array([PRODUCTS.index(c) if (c := category_of(k)[0]) in PRODUCTS else -1 for k in names], dtype=int)
    col = np.where(codes >= 0, col_of[np.maximum(codes, 0)], -1) if len(names) else np.full(len(df), -1)
    out = (g0f, v0f, by_scheme, dealers, pos, col, codes, {k: i for i, k in enumerate(names)})
    _INDEX[0] = (weakref.ref(df), out)
    return out


def _values(value: str) -> list[str]:
    return [v.strip() for v in str(value or "").split("|") if v.strip()]


def _scope_mask(dealers: pd.DataFrame, kind: str, value: str) -> np.ndarray:
    if kind == "all":
        return np.ones(len(dealers), dtype=bool)
    if kind == "dealer":
        return np.isin(dealers.index.astype(str), _values(value))
    return np.isin(dealers[_COLUMN[kind]].astype(str).to_numpy(), _values(value))


def _describe(a: dict) -> str:
    values = _values(a.get("scope_value"))
    where = ("All India" if a["scope_kind"] == "all"
             else f"{len(values)} dealers" if a["scope_kind"] == "dealer" and len(values) > 3
             else f"{a['scope_kind']} {', '.join(values)}")
    what = {"B": "every product", "S": f"scheme {a['product']}", "Q": f"{a['product']} price",
            "R": "every rate" if a["product"] == "*" else f"{a['product']} rates",
            "C": f"scheme {a['product']} rates"}.get(a["mode"], a["product"])
    unit = {"pct": "%", "share": "% mix"}.get(a["adjust_type"], " L" if a["metric"] == "volume" else " Rs")
    return f"{where}, {what}, {a['metric'].upper()} {a['value']:+g}{unit}"


def check_adjustment(a: dict) -> str | None:
    """Why an adjustment cannot be applied as given, or None."""
    if a["scope_kind"] not in SPECIFICITY:
        return f"unknown scope '{a['scope_kind']}'"
    if a["scope_kind"] != "all" and not _values(a.get("scope_value")):
        return f"name the {a['scope_kind']}"
    if a["mode"] not in MODES:
        return f"unknown mode '{a['mode']}'"
    if a["mode"] in ("A", "P", "Q") and a["product"] not in PRODUCTS:
        return "a product edit needs one product"
    if a["mode"] == "R" and a["product"] not in PRODUCTS and a["product"] != "*":
        return "a rate edit needs one product, or * for every rate"
    if a["mode"] in ("Q", "R", "C") and a["adjust_type"] != "pct":
        return "a price, CN % or CN edit is stored as a %"
    if a["mode"] == "B" and a["product"] != "*":
        return "a total edit (mode B) applies to every product"
    if a["mode"] in ("S", "C") and a["product"] in ("", "*"):
        return "a scheme edit needs the scheme"
    if a["adjust_type"] == "share" and (a["mode"] != "A" or not 0 < a["value"] < 100):
        return "a mix edit takes the product's share of volume, between 0 and 100%"
    if a["adjust_type"] == "delta" and (a["scope_kind"] != "dealer" or a["mode"] == "S"):
        return "a rupee or litre change applies to one dealer's product or total; use % otherwise"
    if a["adjust_type"] == "pct" and a["value"] <= -100:
        return "a change of -100% or less leaves nothing to sell"
    return None


def _move_into(cur: np.ndarray, p: int, delta: np.ndarray):
    """Mode A on rows of `cur` (dealers x PRODUCTS + REST): product p gains `delta` rupees, the other positive
    columns give them up in proportion. Returns the new rows and per-dealer flags (no sales, nowhere, capped)."""
    own = cur[:, p]
    others = cur.copy()
    others[:, p] = 0.0
    others = np.where(others > 0, others, 0.0)
    pool = others.sum(axis=1)
    no_sales, nowhere = own <= 0, pool <= 0
    capped = (delta > pool) | (delta < -own)
    ok = ~no_sales & ~nowhere
    delta = np.where(ok, np.clip(delta, -own, pool), 0.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        share = np.where(pool[:, None] > 0, others / pool[:, None], 0.0)
    new = cur - delta[:, None] * share
    new[:, p] = own + delta
    return new, no_sales, nowhere & ~no_sales, capped & ok


def _volumes(rows: np.ndarray, g0: np.ndarray, v0: np.ndarray, price: np.ndarray) -> np.ndarray:
    """Each product's litres for rupees `rows`, at each dealer's own Rs per litre (times any price edit)."""
    # A product with no positive rupees cannot be moved, so its litres stay as they are.
    with np.errstate(divide="ignore", invalid="ignore"):
        return v0 * np.where(g0[:, :-1] > 0, rows[:, :-1] / g0[:, :-1] / price, 1.0)


def dealer_factors(df: pd.DataFrame, adjustments: list[dict]) -> tuple[dict[str, np.ndarray], list[str]]:
    """Per row of df: the factor its sales (litres) move by, its price and rate factors, and the factor of its
    dealer's total GSR. Plus warnings."""
    g0f, v0f, by_scheme, dealers, pos, col, codes, code_of = _frame_index(df)
    g0, v0 = g0f.to_numpy(), v0f.to_numpy()
    g = g0.copy()
    price = np.ones(v0.shape)           # mode Q: GSR per litre, per dealer and product
    rate = np.ones(v0.shape)            # mode R: CN per unit, per dealer and product
    book_rate = np.ones(len(dealers))   # mode R on "*": every rate of the dealer
    scheme_rate: dict[str, np.ndarray] = {}   # mode C: one scheme's rates, per dealer
    book_f = np.ones(len(dealers))      # total (mode B) edits only: what rows without a product of their own follow
    scheme_f: dict[str, np.ndarray] = {}
    warnings: list[str] = []
    for a in sorted(adjustments, key=lambda a: (SPECIFICITY[a["scope_kind"]], MODES[a["mode"]])):
        mask = _scope_mask(dealers, a["scope_kind"], a.get("scope_value") or "")
        if not mask.any():
            warnings.append(f"{_describe(a)}: no dealer in this scope")
            continue
        idx = np.flatnonzero(mask)
        one = a["scope_kind"] == "dealer"
        cur = g[idx]
        vol_now = _volumes(cur, g0[idx], v0[idx], price[idx])
        value = float(a["value"])
        if a["mode"] == "C":
            scheme_rate.setdefault(a["product"], np.ones(len(dealers)))[idx] *= 1 + value / 100
            continue
        if a["mode"] == "R" and a["product"] == "*":
            book_rate[idx] *= 1 + value / 100
            continue
        if a["mode"] == "S":
            key = a["product"]
            f = scheme_f.setdefault(key, np.ones(len(dealers)))
            step = 1 + value / 100
            if key in BASE and key in by_scheme:
                # The scheme's own sales move the dealer's total: its rupees now, times the step.
                p = PRODUCTS.index(BASE[key])
                with np.errstate(divide="ignore", invalid="ignore"):
                    prod_now = np.where(g0[idx, p] > 0, cur[:, p] / g0[idx, p], 1.0)
                g[idx, -1] += by_scheme[key].to_numpy()[idx] * prod_now * f[idx] * (step - 1)
            f[idx] *= step
            continue
        if a["mode"] == "B":
            if a["adjust_type"] == "pct":
                step = np.full(len(idx), 1 + value / 100)
            else:
                base = cur.sum(axis=1) if a["metric"] == "gsr" else vol_now.sum(axis=1)
                with np.errstate(divide="ignore", invalid="ignore"):
                    step = np.where(base > 0, 1 + value / base, np.nan)
                if not np.isfinite(step).all() or (step <= 0).any():
                    warnings.append(f"{_describe(a)}: the dealer has no {a['metric'].upper()} to change, "
                                    "or the change is larger than it; not applied")
                    continue
            g[idx] = cur * step[:, None]
            book_f[idx] *= step
            continue
        p = PRODUCTS.index(a["product"])
        own = cur[:, p]
        if a["mode"] == "R":
            rate[idx, p] *= 1 + value / 100
            continue
        if a["mode"] == "Q":
            g[idx, p] = own * (1 + value / 100)
            price[idx, p] *= 1 + value / 100
            continue
        if a["mode"] == "P":
            if a["adjust_type"] == "pct":
                g[idx, p] = own * (1 + value / 100)
            else:
                with np.errstate(divide="ignore", invalid="ignore"):
                    rupees = value if a["metric"] == "gsr" else np.where(vol_now[:, p] > 0, value * own / vol_now[:, p], 0)
                g[idx, p] = np.where(own > 0, np.maximum(own + rupees, 0.0), own)
            if one and (own <= 0).any():
                warnings.append(f"{_describe(a)}: the dealer has no {a['product']} sales; left out")
            continue
        # Mode A: the total held, sales moved into (or out of) the product.
        if a["adjust_type"] == "share":
            delta = _solve_share(cur, p, value, g0[idx], v0[idx], price[idx])
            if delta is None:
                warnings.append(f"{_describe(a)}: that mix cannot be reached with the total held; not applied")
                continue
        elif a["adjust_type"] == "pct":
            delta = own * value / 100
        elif a["metric"] == "gsr":
            delta = np.full(len(idx), value)
        else:
            with np.errstate(divide="ignore", invalid="ignore"):
                delta = np.where(vol_now[:, p] > 0, value * own / vol_now[:, p], 0.0)
        new, no_sales, nowhere, capped = _move_into(cur, p, delta)
        # Over a zone, region or All India, dealers without the product simply do not move; that is only worth
        # saying for one dealer.
        if one and no_sales.any():
            warnings.append(f"{_describe(a)}: the dealer has no {a['product']} sales; left out")
        if one and nowhere.any():
            warnings.append(f"{_describe(a)}: the dealer sells no other product to take the sales from; left out")
        if capped.any() and a["adjust_type"] != "share":
            warnings.append(f"{_describe(a)}: {int(capped.sum())} dealer(s) capped at what they sell")
        g[idx] = new

    with np.errstate(divide="ignore", invalid="ignore"):
        t0, t1 = g0.sum(axis=1), g.sum(axis=1)
        total_f = np.where(t0 != 0, t1 / t0, 1.0)
        total_f = np.where(np.isfinite(total_f), total_f, 1.0)
        # Each product moves by its own factor, returns (negative) included, so a product's total lands on the figure
        # typed. A product with no base GSR at all (only add-on rows) moves only with total (mode B) edits: an edit
        # of another product must not reach it.
        prod_f = np.where(g0[:, :-1] != 0, g[:, :-1] / g0[:, :-1], book_f[:, None])

    # Per row: its product's factor, or the dealer's total for a scheme outside the products; times a scheme edit.
    has = col >= 0
    c = np.maximum(col, 0)
    row_price = np.where(has, price[pos, c], 1.0)
    # Litres move by the rupee factor less any price change.
    row_f = np.where(has, prod_f[pos, c] / row_price, total_f[pos])
    for key, f in scheme_f.items():
        hit = codes == code_of.get(key, -2)
        row_f[hit] *= f[pos[hit]]
    row_rate = np.where(has, rate[pos, c], 1.0) * book_rate[pos]
    for key, f in scheme_rate.items():
        hit = codes == code_of.get(key, -2)
        row_rate[hit] *= f[pos[hit]]
    return {"sales": row_f, "price": row_price, "rate": row_rate, "total": total_f[pos]}, warnings


def _solve_share(cur: np.ndarray, p: int, target_pct: float, g0: np.ndarray, v0: np.ndarray,
                 price: np.ndarray) -> np.ndarray | None:
    """The per-dealer rupee move (mode A, the same % of each dealer's product sales) that gives the product
    `target_pct` of the scope's product volume. None when it cannot be reached."""
    def share(pct: float) -> float:
        new, *_ = _move_into(cur, p, cur[:, p] * pct / 100)
        vol = _volumes(new, g0, v0, price)
        total = vol.sum()
        return 100 * vol[:, p].sum() / total if total > 0 else 0.0

    lo, hi = -100.0, 100.0
    while share(hi) < target_pct and hi < 1e6:
        hi *= 4
    if not share(lo) <= target_pct <= share(hi):
        return None
    for _ in range(60):
        if hi - lo < 1e-7:   # a millionth of a percent of each dealer's sales: far below a rupee
            break
        mid = (lo + hi) / 2
        if share(mid) < target_pct:
            lo = mid
        else:
            hi = mid
    return cur[:, p] * hi / 100


def _units(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """Per row: is its component's slab measured in litres, and is its rate base rupees. Read from the data: a slab
    in litres equals the dealer's volume (most components), one in rupees does not (GSR, or Early Bird's
    rupee windows); a rupee rate base equals the dealer's GSR."""
    def close(a, b):
        return np.isclose(a.to_numpy(dtype=float), b.to_numpy(dtype=float), rtol=1e-6, atol=1e-6)
    key = df["scheme"].astype(str) + "::" + df["component"].astype(str)
    live = df["slab_basis"].to_numpy(dtype=float) != 0
    litres = pd.Series(close(df["slab_basis"], df["volume"]), index=df.index)[live].groupby(key[live]).mean() >= 0.9
    rupee_base = pd.Series(close(df["base_value"].fillna(np.nan), df["gsr"]), index=df.index).groupby(key).mean() >= 0.9
    return key.map(litres).fillna(True).to_numpy(dtype=bool), key.map(rupee_base).fillna(False).to_numpy(dtype=bool)


def _apply_price(out: pd.DataFrame, price: np.ndarray) -> pd.DataFrame:
    """A price change on each row: rupees move, litres do not. GSR moves; so does a rupee rate base with the CN
    paid as its %, and a slab measured in rupees. A slab in litres and CN per litre or per pack stay."""
    litre_slab, rupee_base = _units(out)
    out["gsr"] = out["gsr"].astype(float) * price
    out["base_value"] = np.where(rupee_base, out["base_value"].astype(float) * price, out["base_value"])
    out["slab_basis"] = np.where(litre_slab, out["slab_basis"], out["slab_basis"].astype(float) * price)
    percent = (out["formula"].astype(str) == "percent").to_numpy()
    out["cn_units"] = np.where(percent & rupee_base, out["cn_units"] * price, out["cn_units"])
    return out


def scenario_frame(df: pd.DataFrame, adjustments: list[dict], factor: float = 1.0) -> tuple[pd.DataFrame, list[str]]:
    """`df` with the adjustments applied, grown by `factor` (1 + next month's volume change)."""
    if not adjustments:
        return (df if factor == 1.0 else grow_frame(df, factor)), []
    f, warnings = dealer_factors(df, adjustments)
    out = grow_frame(df, f["sales"] * factor)
    if (f["price"] != 1).any():
        out = _apply_price(out, f["price"])
    if (f["rate"] != 1).any():
        # CN = units x rate, so scaling the units scales every rate; payout carried outside the slabs reads
        # current_cn, so it scales by cn_scale (plan.carried_cn).
        out["cn_units"] = out["cn_units"] * f["rate"]
        out["cn_scale"] = (df["cn_scale"].to_numpy() if "cn_scale" in df else 1.0) * f["rate"]
    out["total_gsr"] = df["total_gsr"].astype(float).to_numpy() * f["total"] * factor
    return out, warnings


def _moved(base: pd.DataFrame, scen: pd.DataFrame) -> pd.DataFrame:
    """Dealers of one component whose slab or rate differs between the two sides."""
    cols = ["customer_code", "slab_basis", "slab_lower", "simulated_rate", "simulated_cn"]
    m = base[cols].merge(scen[cols], on="customer_code", suffixes=("_a", "_s"))
    lower_a, lower_s = m["slab_lower_a"].to_numpy(dtype=float), m["slab_lower_s"].to_numpy(dtype=float)
    same_lower = (lower_a == lower_s) | (np.isnan(lower_a) & np.isnan(lower_s))
    moved = ~same_lower | (np.abs(m["simulated_rate_a"] - m["simulated_rate_s"]) > 1e-9)
    return m[moved.to_numpy()]


def compute(scen: pd.DataFrame, base: pd.DataFrame, layouts: dict[str, dict], removed: set[str],
            schemes: set[str], currency: dict[str, bool]) -> dict:
    """`base` (the actual month, or next month without edits, served structure) against `scen` (the same month with
    the edits, under the user's slab tables). Totals, per scheme figures with both sides' slab rows, and the dealers
    who moved slab (a frame)."""
    out_schemes, moved_frames = [], []
    for key in sorted(schemes):
        b_sub, s_sub = base[base["scheme"] == key], scen[scen["scheme"] == key]
        if b_sub.empty:
            continue
        entry = {"scheme": key, "is_currency": bool(currency.get(key, True)), "removed": key in removed,
                 "dealers": int(b_sub["customer_code"].nunique()),
                 "actual_volume": dedup_sum(b_sub, "volume", "vol_src"),
                 "version_volume": dedup_sum(s_sub, "volume", "vol_src"),
                 "actual_gsr": dedup_sum(b_sub, "gsr", "gsr_src"),
                 "version_gsr": dedup_sum(s_sub, "gsr", "gsr_src"),
                 "actual_cn": 0.0, "version_cn": 0.0, "components": {}}
        moved_ids: set = set()
        pairs = b_sub[["component", "formula"]].drop_duplicates("component")
        for component, formula in pairs.itertuples(index=False):
            component = str(component)
            if is_carried(component, str(formula)):
                entry["actual_cn"] += carried_cn(b_sub[b_sub["component"] == component])
                entry["version_cn"] += 0.0 if key in removed else carried_cn(s_sub[s_sub["component"] == component])
                continue
            served = default_layout(key, component)
            layout = layouts.get(f"{key}::{component}") or served
            args = lambda lay: {k: lay.get(k) for k in ("edges", "rates", "sources", "rate_overrides")}
            b_d = assign_dealers(base, key, component, **args(served))
            s_d = assign_dealers(scen, key, component, **args(layout))
            if b_d.empty:
                continue
            if key in removed:
                s_d = s_d.assign(simulated_rate=0.0, simulated_cn=0.0)
            b_rows, s_rows = aggregate_bands(b_d, component), aggregate_bands(s_d, component)
            entry["actual_cn"] += float(b_d["simulated_cn"].sum())
            entry["version_cn"] += float(s_d["simulated_cn"].sum())
            entry["components"][component] = {"actual": slab_rows(b_rows, "simulated_cn"),
                                               "version": slab_rows(s_rows, "simulated_cn")}
            mv = _moved(b_d, s_d)
            if not mv.empty:
                moved_ids |= set(mv["customer_code"].tolist())
                moved_frames.append(mv.assign(scheme_key=key, component=component))
        entry["dealers_moved"] = len(moved_ids)
        out_schemes.append(entry)

    rupees = [s for s in out_schemes if s["is_currency"]]
    b_dealers = base.drop_duplicates("customer_code")
    s_dealers = scen.drop_duplicates("customer_code")
    moved = pd.concat(moved_frames, ignore_index=True) if moved_frames else pd.DataFrame(
        columns=["customer_code", "scheme_key", "component"])
    return {
        "totals": {
            "dealers": int(len(b_dealers)),
            "dealers_moved": int(moved["customer_code"].nunique()),
            "actual_gsr": float(b_dealers["total_gsr"].sum()),
            "version_gsr": float(s_dealers["total_gsr"].sum()),
            "actual_cn": sum(s["actual_cn"] for s in rupees),
            "version_cn": sum(s["version_cn"] for s in rupees),
        },
        "schemes": out_schemes,
        "moved": moved,
    }
