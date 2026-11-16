"""
The gift / contest file: a second extract in the same GCS folder as the CN extract (from October 2026).

It has the CN extract's 2-row layout -- Zone, Region, Depot Code, Customer, Customer Name, then per scheme
"Volume Q", "GSR(B)", "<scheme> CN%", "<scheme> Clear Cut", "Next Slab Qty", "Short Fall", "Short Fall %" --
but no business GSR and none of the CN schemes. Measured on October v24 (12 schemes):

- In a gift scheme (Shine On Gift, Wallpaper Roll, Zen King Gift ...) "CN%" and "Clear Cut" both hold the
  gift level the dealer earned (0, 1 or 2), not rupees: thousands of dealers at level 1 and level 2 in Shine On,
  whose Clear Cut would otherwise sum to a meaningless "rupee" total.
- 5% Nova Prime is a rupee scheme in the same file: CN% is 5 and Clear Cut is 5% of its GSR.

Gifts are kept apart from CN (user's decision, 2 Nov 2026): this file never enters the dealer frame, the slab
engine or the CN totals. It is parsed into its own tidy table, one row per dealer and scheme, cached as parquet
next to the file like the CN extract.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from app.ingest.discover_schemes import read_headers
from app.ingest.parse_raw import _cache_path

# Bump when the parsed columns change.
GIFTS_VERSION = 1

_DIMS = {"zone": 0, "region": 1, "depot_code": 2, "customer_code": 3}


def _metric(metric: str) -> str | None:
    m = metric.lower()
    if m.startswith("volume"):
        return "volume"
    if m.startswith("gsr"):
        return "gsr"
    if m.endswith("cn%"):
        return "level"
    if m.endswith("clear cut"):
        return "clear_cut"
    if m.startswith("next slab"):
        return "next_slab"
    if m.startswith("short fall") and not m.startswith("short fall %"):
        return "shortfall"
    return None


def load_gifts(source: Path, force: bool = False) -> pd.DataFrame:
    """One row per dealer and scheme with any figure: zone, region, depot_code, customer_code, scheme, volume,
    gsr, level (the "CN%" column), clear_cut, next_slab, shortfall."""
    source = Path(source)
    cache = _cache_path(source, suffix=f".gifts{GIFTS_VERSION}")
    if cache.exists() and not force:
        return pd.read_parquet(cache)

    columns: dict[str, dict[str, int]] = {}
    for cell in read_headers(source):
        if (name := _metric(cell.metric)) is not None:
            columns.setdefault(cell.scheme_name, {}).setdefault(name, cell.col)

    raw = pd.read_excel(source, header=None, skiprows=2, engine="calamine")
    raw = raw[pd.to_numeric(raw[_DIMS["customer_code"]], errors="coerce").notna()]
    dims = pd.DataFrame({k: raw[c].values for k, c in _DIMS.items()})
    dims["customer_code"] = dims["customer_code"].astype("int64")
    for col in ("zone", "region"):
        dims[col] = dims[col].astype(str).str.strip()

    parts = []
    for scheme, cols in columns.items():
        part = dims.copy()
        part["scheme"] = scheme
        for name in ("volume", "gsr", "level", "clear_cut", "next_slab", "shortfall"):
            part[name] = pd.to_numeric(raw[cols[name]], errors="coerce").values if name in cols else float("nan")
        figures = part[["volume", "gsr", "level", "clear_cut"]].fillna(0)
        parts.append(part[(figures != 0).any(axis=1)])
    frame = pd.concat(parts, ignore_index=True) if parts else dims.iloc[0:0]
    frame.to_parquet(cache, index=False)
    return frame
