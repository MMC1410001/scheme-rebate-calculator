"""
Buckets dealers into the scheme's actual slab bands and aggregates what the
what-if UI needs per band: dealer count, achievement, CN units and current CN.

Slab bands are cumulative ranges, the way the business defines them:
    0 -> first boundary, first boundary -> second boundary, ... , last -> infinity

The boundaries are recovered from the data itself: a dealer's own
"achievement + next-slab-distance" lands exactly on the next slab edge, so the
distinct values of that sum ARE the slab edges. Both terms must be in the same
unit -- see Component.slab_col (Luxury's slab is decided in litres even though
its CN% is applied to rupees).

Achievement is measured on slab_basis, NOT on the rate base, for the same reason.
"""
from __future__ import annotations

import threading
from contextvars import ContextVar, Token
from functools import lru_cache

import numpy as np
import pandas as pd

from app.core.scope import apply_scope

_EDGE_LOCK = threading.Lock()

# A boundary only counts as a real slab edge if enough dealers sit against it.
# Edges are always derived from the WHOLE country, never from the filtered view:
# a published slab table belongs to the scheme, not to the region being looked at.
# Delhi has only 1 dealer above 4000L, but 4000 is still a real slab edge.
MIN_DEALERS_PER_EDGE = 10
MIN_SHARE_PER_EDGE = 0.001

# Published slab tables are short. If we "find" more edges than this, the scheme
# is really running per-dealer targets (e.g. last-year volume x growth), so there
# is no common slab to show and we fall back to grouping by rate tier.
MAX_EDGES = 20
# The edges we keep must explain most dealers, otherwise same conclusion.
MIN_COVERAGE = 0.5


def _slab_edges(group: pd.DataFrame) -> list[float]:
    eligible = group[group["next_slab"] > 0]
    if eligible.empty:
        return []
    boundaries = (eligible["slab_basis"] + eligible["next_slab"]).round(2)
    counts = boundaries.value_counts()
    threshold = max(MIN_DEALERS_PER_EDGE, int(len(group) * MIN_SHARE_PER_EDGE))
    kept = counts[counts >= threshold]
    if kept.empty or len(kept) > MAX_EDGES:
        return []
    if kept.sum() / len(eligible) < MIN_COVERAGE:
        return []
    return sorted(kept.index.tolist())


def _region_set(s: pd.Series) -> tuple[str, ...]:
    """Regions behind a row, so the All-India view can say which regions pay which rate."""
    return tuple(sorted(s.dropna().astype(str).unique()))


def _band_labels(edges: list[float], n: int) -> tuple[list[float], list[float]]:
    lowers = [0.0] + edges
    uppers = edges + [float("inf")]
    return lowers[:n], uppers[:n]


@lru_cache(maxsize=1024)
def _edges_cached(scheme_key: str, component: str, version: int) -> tuple[float, ...]:
    full = _EDGE_SOURCES.get(version)
    if full is None:   # older than the frames kept (several reloads during one request): the newest
        full = _EDGE_SOURCES[max(_EDGE_SOURCES)]
    group = full[(full["scheme"] == scheme_key) & (full["component"] == component)]
    return tuple(_slab_edges(group))


def edges_for(scheme_key: str, component: str) -> tuple[float, ...]:
    """Slab edges for a component, computed once from the full national frame of the live month (edge_version)."""
    return _edges_cached(scheme_key, component, edge_version())


# The national frames slab edges come from, by version: the live month's, and the one before it while requests that
# started on it finish. A reload adds a version (set_edge_source); a request keeps the version it started with
# (pin_edge_version), so it never mixes one month's rows with another month's edges.
_EDGE_SOURCES: dict[int, pd.DataFrame] = {}
_EDGE_VERSION = [0]
_PINNED_EDGES: ContextVar[int | None] = ContextVar("edge_version", default=None)
_KEEP_SOURCES = 2


def set_edge_source(df: pd.DataFrame) -> int:
    """Make `df` the national frame for edges; returns its version."""
    with _EDGE_LOCK:
        _EDGE_VERSION[0] += 1
        version = _EDGE_VERSION[0]
        _EDGE_SOURCES[version] = df
        for old in [v for v in _EDGE_SOURCES if v <= version - _KEEP_SOURCES]:
            del _EDGE_SOURCES[old]
    return version


def edge_version() -> int:
    """The edge version of this request (pinned at its start), else the newest."""
    pinned = _PINNED_EDGES.get()
    return _EDGE_VERSION[0] if pinned is None or pinned not in _EDGE_SOURCES else pinned


def pin_edge_version(version: int | None) -> Token:
    """Keep `version` for the rest of this request (or thread); reset with unpin_edge_version(token)."""
    return _PINNED_EDGES.set(version)


def unpin_edge_version(token: Token) -> None:
    _PINNED_EDGES.reset(token)


def has_edge_source() -> bool:
    return bool(_EDGE_SOURCES)


def _merge_same_rate_bands(result: pd.DataFrame) -> pd.DataFrame:
    """Collapse adjacent bands that pay the same rate.

    Edges come from the whole country, but rate cards differ by region: Delhi's
    Premium card steps at 40/150/300/650, another region steps at 125/700. Viewed
    for Delhi alone, the foreign edges split one real slab into "40-125 @5.75%"
    and "125-150 @5.75%". If two neighbouring bands pay the same rate in the
    current scope, they are one slab in the current scope.
    """
    if result.empty:
        return result

    # Regions are part of the key: the same rate in neighbouring bands for different
    # regions is two rate cards, not one slab.
    merged: list[dict] = []
    for _key, group in result.groupby(["component", "cn_rate", "regions"], sort=False, observed=True):
        group = group.sort_values("slab_index")
        run: dict | None = None
        for row in group.to_dict("records"):
            adjacent = (
                run is not None
                and run["slab_mode"] == "slab"
                and row["slab_mode"] == "slab"
                and pd.notna(run["slab_upper"])
                and float(run["slab_upper"]) == float(row["slab_lower"])
            )
            if adjacent:
                run["slab_upper"] = row["slab_upper"]
                for field in ("dealer_count", "achievement", "volume", "gsr",
                              "cn_units", "current_cn", "condonation_amount"):
                    run[field] += row[field]
            else:
                if run is not None:
                    merged.append(run)
                run = dict(row)
        if run is not None:
            merged.append(run)

    out = pd.DataFrame(merged)
    return out.sort_values(["component", "slab_index", "cn_rate"]).reset_index(drop=True)


def _collapse_unqualified(result: pd.DataFrame) -> pd.DataFrame:
    """Pull non-earning dealers out of paying slabs into one "not qualified" row.

    Early Bird stages qualification: a dealer who fails to hold the slab he
    reached in the previous window earns 0% no matter how much he sells in this
    one (verified -- whenever EB2 band < EB1 band the rate is always 0). Those
    dealers sit physically inside a paying volume band, so grouping by band alone
    produced a duplicate 0% row against every paying slab and made a 3-slab rate
    card look like 8 slabs.

    Leading 0% bands (genuinely below the first paying slab, e.g. Premium's
    0-40L) are left alone -- they are real slabs with real headroom.
    """
    if result.empty:
        return result

    out: list[pd.DataFrame] = []
    for _component, group in result.groupby("component", sort=False, observed=True):
        paying = group[group["cn_rate"] > 0]
        zero = group[group["cn_rate"] == 0]
        if paying.empty or len(zero) <= 1:
            out.append(group)
            continue

        first_paying = paying["slab_index"].min()
        leading = zero[zero["slab_index"] < first_paying]
        inside = zero[zero["slab_index"] >= first_paying]

        keep = [paying, leading]
        if not inside.empty:
            row = inside.iloc[0].copy()
            for field in ("dealer_count", "achievement", "volume", "gsr", "cn_units",
                          "current_cn", "condonation_amount"):
                row[field] = inside[field].sum()
            row["regions"] = tuple(sorted(set().union(*inside["regions"])))
            row["slab_mode"] = "unrated"
            row["slab_lower"] = inside["slab_lower"].min()
            row["slab_upper"] = np.nan
            row["slab_index"] = 9999
            keep.append(pd.DataFrame([row]))
        out.append(pd.concat(keep))

    return pd.concat(out, ignore_index=True).sort_values(["component", "slab_index", "cn_rate"])


def _non_qualifiers(sub: pd.DataFrame, edges: list[float], basis: np.ndarray, rate: np.ndarray) -> np.ndarray:
    """Dealers earning 0% inside a paying band (Early Bird: they did not hold their previous window's slab).

    The same rule as _collapse_unqualified, at dealer level: it applies only when more than one band holds 0%
    dealers, and then to the 0% dealers at or above the first paying band of the scope.
    """
    if not edges:
        return np.zeros(len(sub), dtype=bool)
    band = np.searchsorted(np.array(edges), basis, side="right")
    paying = band[rate > 0]
    if not len(paying) or len(np.unique(band[rate == 0])) <= 1:
        return np.zeros(len(sub), dtype=bool)
    return (rate == 0) & (band >= paying.min())


def _component_rows(df, scheme_key, component, zone, region, depot_code) -> pd.DataFrame:
    sub = apply_scope(df[(df["scheme"] == scheme_key) & (df["component"] == component)], zone, region, depot_code)
    sub = sub.copy()
    sub["cn_rate"] = sub["cn_rate"].astype(float).round(4)
    return sub


def _mode(values: pd.Series) -> float:
    counts = values.value_counts()
    return float(counts.index[0]) if len(counts) else 0.0


def assign_dealers(
    df: pd.DataFrame,
    scheme_key: str,
    component: str,
    edges: list[float],
    rates: list[float] | None = None,
    sources: list[tuple[float, float | None]] | None = None,
    rate_overrides: list[dict] | None = None,
    zone=None,
    region=None,
    depot_code=None,
) -> pd.DataFrame:
    """Every dealer of a component under the given boundaries: band, rate before edits, rate after edits.

    Two ways to price a band:

    - `rates`, one per band: the whole scope runs ONE rate card (the band's rate applies to everyone in it).
    - `sources`, one per band: the band of the ORIGINAL table this band comes from, as [lower, upper]. Each dealer
      keeps their own region's rate card. A dealer whose achievement still lies in that source band keeps exactly
      their own rate; a dealer who crossed into it gets the rate most of their region's dealers earn in the source
      band (the national rate where the region has none). Unchanged boundaries therefore change nothing, and
      boundaries can be moved at All India even though regions run different cards. A component with no published
      table (per-dealer targets) uses source [0, none]: every dealer keeps their own rate until a rate is edited.

    `rate_overrides`, [{band, rate, new_rate}]: in band `band`, dealers whose rate is `rate` are paid `new_rate`.

    Dealers earning 0% inside a paying band (non-qualifiers) never start earning: they stay "unrated".
    """
    sub = _component_rows(df, scheme_key, component, zone, region, depot_code)
    if sub.empty:
        return sub
    basis = sub["slab_basis"].to_numpy(dtype=float)
    own = sub["cn_rate"].to_numpy(dtype=float)
    current_edges = list(edges_for(scheme_key, component))
    # Qualification is decided on what the dealer actually achieved. In a grown month (grow_frame) a dealer who was
    # simply below the first slab and grows past it must start earning, not be read as a non-qualifier.
    actual = sub["actual_basis"].to_numpy(dtype=float) if "actual_basis" in sub else basis
    held = _non_qualifiers(sub, current_edges, actual, own)

    new_edges = sorted(float(e) for e in edges)
    idx = np.searchsorted(np.array(new_edges), basis, side="right") if new_edges else np.zeros(len(sub), dtype=int)
    lowers = np.array([0.0] + new_edges)
    uppers = np.array(new_edges + [np.nan])

    if rates is not None:
        rate = np.array([rates[i] if i < len(rates) else 0.0 for i in idx], dtype=float)
    else:
        src = sources or [(0.0, None)] * (len(new_edges) + 1)
        # A source band starting at 0 is the first band, which also holds negative achievement (returns larger
        # than purchases): open below, or those dealers read as having moved into it and were paid on negative units.
        src_lo = np.array([-np.inf if float(s[0]) <= 0 else float(s[0]) for s in src])
        src_hi = np.array([np.inf if s[1] is None else float(s[1]) for s in src])
        lo, hi = src_lo[np.minimum(idx, len(src) - 1)], src_hi[np.minimum(idx, len(src) - 1)]
        stays = (basis >= lo) & (basis < hi)
        rate = own.copy()
        moved = np.flatnonzero(~stays & ~held)
        if len(moved):
            ok = ~held
            regions = sub["region"].astype(str).to_numpy()
            card: dict[tuple, float] = {}
            for i in moved:
                key = (regions[i], lo[i], hi[i])
                if key not in card:
                    in_src = ok & (basis >= lo[i]) & (basis < hi[i])
                    same = in_src & (regions == regions[i])
                    pool = own[same] if same.any() else own[in_src]
                    card[key] = _mode(pd.Series(pool)) if len(pool) else 0.0
                rate[i] = card[key]
    rate = np.where(held, 0.0, np.round(rate, 4))

    simulated = rate.copy()
    for o in rate_overrides or []:
        hit = (idx == int(o["band"])) & (np.abs(rate - float(o["rate"])) < 1e-9) & ~held
        simulated[hit] = float(o["new_rate"])

    out = sub.assign(
        slab_index=np.where(held, 9999, idx),
        slab_lower=np.where(held, np.nan, lowers[idx]),
        slab_upper=np.where(held, np.nan, uppers[idx]),
        slab_mode=np.where(held, "unrated", "slab"),
        band_rate=rate,
        simulated_rate=simulated,
        simulated_cn=sub["cn_units"].to_numpy(dtype=float) * simulated,
    )
    return out


def rebucket(
    df: pd.DataFrame,
    scheme_key: str,
    component: str,
    edges: list[float],
    rates: list[float] | None = None,
    zone: str | None = None,
    region: str | None = None,
    depot_code: str | None = None,
    sources: list[tuple[float, float | None]] | None = None,
    rate_overrides: list[dict] | None = None,
) -> pd.DataFrame:
    """Re-slab a component against user-supplied boundaries (see assign_dealers for how bands are priced).

    Moving a slab edge moves DEALERS between bands, which changes dealer count, volume, GSR and therefore payout --
    so this runs against dealer-level rows, not the pre-aggregated bands. cn_units is fixed per dealer at ingestion
    (GSR/100, litres, whole packs, or 1), so a dealer's payout is cn_units x the rate of the band they land in.
    One row per band and rate: with each region's card kept, a band shows one row per rate paid in it.
    """
    dealers = assign_dealers(df, scheme_key, component, edges, rates, sources, rate_overrides,
                             zone, region, depot_code)
    return aggregate_bands(dealers, component)


def aggregate_bands(dealers: pd.DataFrame, component: str) -> pd.DataFrame:
    """assign_dealers output as slab rows: one row per band and rate (rebucket's table)."""
    if dealers.empty:
        return pd.DataFrame()
    # Plain numpy over integer group ids. pandas' named agg() with a Python function per group (the region set) was
    # most of an edited month's cost (~2.4 s of ~3 s over 88 components), and even one groupby per reduction paid
    # ~17 ms a component in overhead, mostly on the Arrow-string slab_mode key.
    n = len(dealers)
    slab_index = dealers["slab_index"].to_numpy(dtype=np.int64)
    band_rate = dealers["band_rate"].to_numpy(dtype=float)
    unrated_row = (dealers["slab_mode"] == "unrated").to_numpy(dtype=bool)
    # Rows sorted by (slab_index, band_rate, slab_mode), as groupby sorts its keys; a new group where any key changes.
    order = np.lexsort((unrated_row, band_rate, slab_index))
    si, br, un = slab_index[order], band_rate[order], unrated_row[order]
    rate_changes = (br[1:] != br[:-1]) & ~(np.isnan(br[1:]) & np.isnan(br[:-1]))   # NaN rates are one group
    starts = np.flatnonzero(np.r_[True, (si[1:] != si[:-1]) | rate_changes | (un[1:] != un[:-1])])
    groups = len(starts)
    is_start = np.zeros(n, dtype=bool)
    is_start[starts] = True
    gid = np.empty(n, dtype=np.int64)
    gid[order] = np.cumsum(is_start) - 1

    def total(col: str) -> np.ndarray:
        # groupby sum skips NaN
        return np.bincount(gid, weights=np.nan_to_num(dealers[col].to_numpy(dtype=float), nan=0.0), minlength=groups)

    def first(col: str) -> np.ndarray:
        # groupby first: the first non-null value in row order, NaN when there is none
        values = dealers[col].to_numpy(dtype=float)
        out = np.full(groups, np.nan)
        rows = np.flatnonzero(~np.isnan(values))
        seen, at = np.unique(gid[rows], return_index=True)
        out[seen] = values[rows[at]]
        return out

    def distinct(codes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """The distinct (group, code) pairs of the rows with a code."""
        ok = codes >= 0
        width = int(codes.max(initial=0)) + 1
        pairs = np.unique(gid[ok] * width + codes[ok])
        return pairs // width, pairs % width

    customer, _ = pd.factorize(dealers["customer_code"])
    held_from = np.full(groups, np.inf)
    basis = dealers["slab_basis"].to_numpy(dtype=float)
    np.fmin.at(held_from, gid, basis)
    held_from[np.bincount(gid, weights=~np.isnan(basis), minlength=groups) == 0] = np.nan
    held_from = np.maximum(held_from, 0.0)   # a range never starts below 0 (returns make achievement negative)
    region_codes, region_names = pd.factorize(dealers["region"])
    reg_group, reg_code = distinct(region_codes)
    names = [str(r) for r in region_names]
    region_sets: list[list[str]] = [[] for _ in range(groups)]
    for gi, ci in zip(reg_group.tolist(), reg_code.tolist(), strict=True):
        region_sets[gi].append(names[ci])
    first_lower = first("slab_lower")
    slab_index_out, rate_out, unrated_out = si[starts], br[starts], un[starts]
    current_cn, simulated_cn = total("current_cn"), total("simulated_cn")
    # Groups come out in (slab_index, rate) order already: the order the table is shown in.
    return pd.DataFrame({
        "slab_index": slab_index_out,
        "cn_rate": rate_out,
        "slab_mode": np.where(unrated_out, "unrated", "slab"),
        "dealer_count": np.bincount(distinct(customer)[0], minlength=groups).astype(np.int64),
        "achievement": total("slab_basis"),
        "volume": total("volume"),
        "gsr": total("gsr"),
        "cn_units": total("cn_units"),
        "current_cn": current_cn,
        "condonation_amount": total("condonation_amount"),
        "simulated_cn": simulated_cn,
        "simulated_rate": first("simulated_rate"),
        # Non-qualifiers have no band: their row starts at the lowest achievement among them.
        "slab_lower": np.where(unrated_out, held_from, first_lower),
        "slab_upper": first("slab_upper"),
        "regions": [tuple(sorted(r)) for r in region_sets],
        "component": component,
        "formula": dealers["formula"].iat[0],
        "pack_size": dealers["pack_size"].iat[0],
        "delta_cn": simulated_cn - current_cn,
        "row_id": [f"{component}::{i}::{r}" for i, r in zip(slab_index_out.tolist(), pd.Series(rate_out).astype(str),
                                                            strict=True)],
    })


def dealers_in_row(
    df: pd.DataFrame,
    scheme_key: str,
    component: str,
    row: dict,
    zone=None,
    region=None,
    depot_code=None,
    edges: list[float] | None = None,
) -> pd.DataFrame:
    """The dealers behind one row of build_slabs: the same rules, at dealer level, so the list and the count agree.

    `row` needs slab_mode, slab_lower, slab_upper and cn_rate, as served. `edges`: another month's own edges
    (build_slabs with edge_frame); by default the live month's national edges.
    """
    sub = _component_rows(df, scheme_key, component, zone, region, depot_code)
    if sub.empty:
        return sub
    basis = sub["slab_basis"].to_numpy(dtype=float)
    rate = sub["cn_rate"].to_numpy(dtype=float)
    want = round(float(row.get("cn_rate") or 0.0), 4)
    if edges is None:
        edges = list(edges_for(scheme_key, component))
    if not edges:  # per-dealer targets: the rate is the tier
        return sub[np.abs(rate - want) < 1e-9]
    held = _non_qualifiers(sub, edges, basis, rate)
    if row.get("slab_mode") == "unrated":
        return sub[held]
    band = np.searchsorted(np.array(edges), basis, side="right")
    band_lower = np.array([0.0] + edges)[band]
    lo = float(row.get("slab_lower") or 0.0)
    up = row.get("slab_upper")
    hi = np.inf if up is None or pd.isna(up) else float(up)  # the top band has no upper bound (null or NaN)
    mask = ~held & (np.abs(rate - want) < 1e-9) & (band_lower >= lo - 1e-9) & (band_lower < hi - 1e-9)
    return sub[mask]


def edges_of(edge_frame: pd.DataFrame, scheme_key: str, component: str) -> list[float]:
    """Slab edges of a component from another month's whole frame (build_slabs for a month other than the live one)."""
    group = edge_frame[(edge_frame["scheme"] == scheme_key) & (edge_frame["component"] == component)]
    return _slab_edges(group)


def build_slabs(
    df: pd.DataFrame,
    scheme_key: str,
    zone: str | None = None,
    region: str | None = None,
    depot_code: str | None = None,
    edge_frame: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """The slab table of a scheme for a scope. `edge_frame`: the whole frame of ANOTHER month, whose own edges apply
    (the live month's edges come from the national edge source)."""
    if not has_edge_source() and edge_frame is None:
        set_edge_source(df)

    subset = apply_scope(df[df["scheme"] == scheme_key], zone, region, depot_code)

    if subset.empty:
        return pd.DataFrame(
            columns=[
                "component", "formula", "pack_size", "slab_mode", "slab_index", "slab_lower",
                "slab_upper", "cn_rate", "dealer_count", "achievement", "volume", "gsr",
                "cn_units", "current_cn", "condonation_amount", "regions", "row_id",
            ]
        )

    out: list[pd.DataFrame] = []
    for component, group in subset.groupby("component", sort=False, observed=True):
        group = group.copy()
        # The source stores rates as float32, so 0.4 arrives as 0.4000000059604645.
        # Round before grouping, or one rate splits into several near-identical rows.
        group["cn_rate"] = group["cn_rate"].astype(float).round(4)
        edges = (list(edges_for(scheme_key, component)) if edge_frame is None
                 else edges_of(edge_frame, scheme_key, str(component)))

        if edges:
            # side="right" so a dealer sitting exactly on an edge counts as having
            # reached that slab, not as still working towards it.
            idx = np.searchsorted(np.array(edges), group["slab_basis"].to_numpy(), side="right")
            group["slab_index"] = idx
            lowers = np.array([0.0] + edges)
            uppers = np.array(edges + [np.inf])
            group["slab_lower"] = lowers[idx]
            group["slab_upper"] = uppers[idx]
            group["slab_mode"] = "slab"
            keys = ["component", "formula", "pack_size", "slab_mode", "slab_index",
                    "slab_lower", "slab_upper", "cn_rate"]
            grouped = group.groupby(keys, as_index=False, observed=True).agg(
                dealer_count=("customer_code", "nunique"),
                achievement=("slab_basis", "sum"),
                volume=("volume", "sum"),
                gsr=("gsr", "sum"),
                cn_units=("cn_units", "sum"),
                current_cn=("current_cn", "sum"),
                condonation_amount=("condonation_amount", "sum"),
                regions=("region", _region_set),
            )
        else:
            # Per-dealer targets: no shared slab table exists, so the rate itself is
            # the tier. Achievement min/max is shown as context instead of a band.
            group["slab_mode"] = "target"
            keys = ["component", "formula", "pack_size", "slab_mode", "cn_rate"]
            grouped = group.groupby(keys, as_index=False, observed=True).agg(
                dealer_count=("customer_code", "nunique"),
                achievement=("slab_basis", "sum"),
                volume=("volume", "sum"),
                gsr=("gsr", "sum"),
                cn_units=("cn_units", "sum"),
                current_cn=("current_cn", "sum"),
                condonation_amount=("condonation_amount", "sum"),
                slab_lower=("slab_basis", "min"),
                slab_upper=("slab_basis", "max"),
                regions=("region", _region_set),
            )
            # Shown as a range, which never starts below 0: returns make some dealers' achievement negative.
            grouped[["slab_lower", "slab_upper"]] = grouped[["slab_lower", "slab_upper"]].clip(lower=0.0)
            grouped = grouped.sort_values("cn_rate").reset_index(drop=True)
            grouped["slab_index"] = grouped.index

        out.append(grouped)

    result = pd.concat(out, ignore_index=True).sort_values(["component", "slab_index", "cn_rate"])
    # Pull non-qualifiers out first, so the same-rate merge only ever joins
    # genuinely leading 0% bands and cannot produce a 0% band that overlaps a
    # paying one.
    result = _collapse_unqualified(result)
    result = _merge_same_rate_bands(result)
    result["slab_upper"] = result["slab_upper"].replace(np.inf, np.nan)  # JSON-safe
    result["row_id"] = (
        result["component"] + "::" + result["slab_index"].astype(str) + "::" + result["cn_rate"].astype(str)
    )
    return result.reset_index(drop=True)


def grow_frame(df: pd.DataFrame, factor: float | np.ndarray) -> pd.DataFrame:
    """Every dealer's month scaled by `factor`: achievement, volume, GSR and CN units, as each formula behaves.

    `factor` is one number, or one per row (an array aligned with df) for dealer-level changes (app/core/scenario.py).

    percent / per_unit units scale with sales; per_pack adds only the WHOLE packs the growth completes, on top of the
    published count (packs are a floor); a fixed amount or a qualifier stays as it is. current_cn is the actual
    month's payout and is left untouched: what the grown month pays comes from re-bucketing (rebucket).
    """
    out = df.copy()
    # Qualification stays on the actual month, also when an already grown frame is grown again (edits, then V).
    out["actual_basis"] = (df["actual_basis"] if "actual_basis" in df else df["slab_basis"]).astype(float)
    for col in ("slab_basis", "volume", "gsr", "base_value", "total_gsr"):
        if col in out:
            out[col] = out[col].astype(float) * factor
    formula = out["formula"].astype(str).to_numpy()
    units = out["cn_units"].astype(float).to_numpy()
    basis = df["slab_basis"].astype(float).to_numpy()
    pack = np.where(out["pack_size"].to_numpy() > 0, out["pack_size"].to_numpy(), 1).astype(float)
    packs = lambda b: np.floor(np.maximum(b, 0.0) / pack)
    grown = np.where(np.isin(formula, ["percent", "per_unit"]), units * factor,
                     np.where(formula == "per_pack", units + packs(basis * factor) - packs(basis), units))
    out["cn_units"] = grown
    return out

