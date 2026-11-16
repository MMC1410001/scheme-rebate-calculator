"""
Narrowing the dealer frame to a selection.

Every endpoint and every engine filters on the same three dimensions, and they
all used `df[df["zone"] == zone]` -- which silently commits the API to ONE zone.
Supporting "Delhi and Haryana" meant touching six call sites and getting the same
three lines right in each.

So the rule lives here once, and it accepts either shape: a bare string (one
value, as the whole app used to pass) or a list (several). Callers do not have to
care which they were given, and adding a fourth dimension later is one edit.

Empty list and None both mean "no filter" -- an explicit empty selection reads as
"everything" rather than "nothing", because a filter the user has cleared should
widen the view, not blank it.
"""
from __future__ import annotations

from collections.abc import Iterable

import pandas as pd

Selection = str | Iterable[str] | None


def _values(sel: Selection) -> list[str] | None:
    if sel is None:
        return None
    # Spaces around a value are ignored and a repeated value counts once (" 41 " is region 41, not an empty scope).
    if isinstance(sel, str):
        sel = [sel]
    vals = list(dict.fromkeys(str(v).strip() for v in sel if v is not None and str(v).strip()))
    return vals or None


def _as_column_type(col: pd.Series, vals: list[str]) -> list:
    """Query values arrive as text; a numeric column (depot codes in the GCS files) needs numbers to match."""
    dtype = col.cat.categories.dtype if isinstance(col.dtype, pd.CategoricalDtype) else col.dtype
    if pd.api.types.is_numeric_dtype(dtype):
        nums = [pd.to_numeric(v, errors="coerce") for v in vals]
        return [n for n in nums if pd.notna(n)]
    # A text column whose values look like numbers ("41"): "41.0" names the same value, as the 422 check reads it.
    known = col.cat.categories if isinstance(col.dtype, pd.CategoricalDtype) else col.dropna().unique()
    spelled = {_norm(k): k for k in known}
    return [spelled.get(_norm(v), v) for v in vals]


def _norm(value) -> str:
    """One spelling per value, as live._scope_norm: 41, "41" and "41.0" read alike; other text as it is."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value).strip()
    return repr(number) if number == number else str(value).strip()


def apply_scope(
    df: pd.DataFrame,
    zone: Selection = None,
    region: Selection = None,
    depot_code: Selection = None,
) -> pd.DataFrame:
    """Restrict to the selected zones / regions / depots."""
    for col, sel in (("zone", zone), ("region", region), ("depot_code", depot_code)):
        vals = _values(sel)
        if not vals or col not in df.columns:
            continue
        vals = _as_column_type(df[col], vals)
        if not vals:
            return df.iloc[0:0]
        df = df[df[col].isin(vals)] if len(vals) > 1 else df[df[col] == vals[0]]
    return df


def scope_key(zone: Selection, region: Selection, depot_code: Selection) -> tuple:
    """A hashable, order-independent form of a selection, for cache keys.

    Sorted so that picking Delhi then Haryana hits the same cache entry as
    picking Haryana then Delhi.
    """
    return tuple(
        tuple(sorted(v)) if (v := _values(sel)) else None
        for sel in (zone, region, depot_code)
    )


def scope_label(zone: Selection, region: Selection, depot_code: Selection) -> str:
    """How the selection reads in the UI: 'Delhi +2 regions', 'All India'."""
    for name, sel in (("depot", depot_code), ("region", region), ("zone", zone)):
        vals = _values(sel)
        if not vals:
            continue
        if len(vals) == 1:
            return vals[0]
        return f"{vals[0]} +{len(vals) - 1} {name}s"
    return "All India"
