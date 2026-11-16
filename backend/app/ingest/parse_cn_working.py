"""
Adapter for the "CN Working" file (July 2026 csv).

This is the file the business actually works from, and it is the better source
for the figures themselves: it carries Zone / Region / Depot / Customer Name,
which the automated export drops entirely, and its CN column is the settled
"CN (Clear Cut)".

What it does NOT carry is any "Next Slab" column, so slab boundaries cannot be
recovered from it. The two July sources are therefore complementary:

    automated export  ->  slab mechanics (Next Slab, slab basis)
    CN Working file   ->  geography, GSR, volume and settled CN

Layout: a title row, then a row naming each scheme block (with a date-range
suffix), then a row of metric names that repeat generically inside each block
("Volume (Q)", "GSR (B)", "CN (Clear Cut)"). Numbers arrive as formatted text
(" 1,195,581 ", "0.50%", " -   ").
"""
from __future__ import annotations

import csv
import itertools
import re
from pathlib import Path

import pandas as pd

from app.core.scheme_config import canonical_scheme_name, is_currency_scheme

DIM_HEADERS = {
    "zone": "zone",
    "region": "region",
    "depot code": "depot_code",
    "parent code": "customer_code",
    "customer name": "customer_name",
}

# Metric name -> role. Blocks reuse the same generic names.
METRIC_ROLES = {
    "volume (q)": "volume",
    "volume a (q)": "volume",
    "gsr (b)": "gsr",
    "gsr (q)": "gsr_q",
    "cn%": "rate",
    "cn (clear cut)": "clear_cut",
    "condonation cn": "condonation",
}


def _to_number(series: pd.Series) -> pd.Series:
    """' 1,195,581 ' -> 1195581.0 ; '0.50%' -> 0.5 ; ' -   ' -> 0.0"""
    s = series.astype(str).str.strip()
    is_pct = s.str.endswith("%")
    s = s.str.replace(",", "", regex=False).str.replace("%", "", regex=False)
    s = s.str.replace(r"^\(\s*(.*?)\s*\)$", r"-\1", regex=True)  # (123) = negative
    s = s.replace({"-": "0", "": "0", "nan": "0", "None": "0"})
    out = pd.to_numeric(s, errors="coerce").fillna(0.0)
    return out.where(~is_pct, out)  # percentages kept as whole numbers (0.50% -> 0.5)


def read_layout(source: Path) -> tuple[dict[str, int], list[tuple[str, dict[str, int]]]]:
    with open(source, newline="", encoding="utf-8", errors="replace") as f:
        rows = list(itertools.islice(csv.reader(f), 3))
    groups, metrics = rows[1], rows[2]

    dims: dict[str, int] = {}
    for j, m in enumerate(metrics):
        key = DIM_HEADERS.get(re.sub(r"\s+", " ", m).strip().lower())
        if key and key not in dims:
            dims[key] = j

    # "CN Amount" is the sheet's grand total, not a scheme; including it would
    # double the reported payout.
    GRAND_TOTAL_BLOCKS = {"cn amount", "total cn", "grand total"}

    blocks: list[tuple[str, dict[str, int]]] = []
    current, cols = None, {}
    for j, (g, m) in enumerate(zip(groups, metrics)):
        g = re.sub(r"\s+", " ", g).strip()
        m = re.sub(r"\s+", " ", m).strip()
        if g:
            if current and cols:
                blocks.append((current, cols))
            current, cols = g, {}
        if current:
            role = METRIC_ROLES.get(m.lower())
            if role and role not in cols:
                cols[role] = j
    if current and cols:
        blocks.append((current, cols))
    blocks = [
        (name, cols) for name, cols in blocks
        if canonical_scheme_name(name).strip().lower() not in GRAND_TOTAL_BLOCKS
    ]
    return dims, blocks


def parse_cn_working(source: Path, force: bool = False) -> pd.DataFrame:
    source = Path(source)
    from app.ingest.parse_raw import CONFIG_VERSION

    cache = source.with_suffix(f".cnworking.v{CONFIG_VERSION}.parquet")
    if cache.exists() and not force:
        return pd.read_parquet(cache)

    dims, blocks = read_layout(source)
    needed = sorted({*dims.values(), *(c for _, cols in blocks for c in cols.values())})
    # header=None keeps the original column positions as labels, and usecols then
    # selects a subset without renumbering them. Passing `names` as well would
    # re-map the labels and silently shift every column.
    # Dealer names carry non-UTF8 bytes, so decode leniently.
    raw = pd.read_csv(source, skiprows=3, header=None, usecols=needed,
                      dtype=str, low_memory=False, encoding="latin-1")
    raw = raw[raw[dims["customer_code"]].notna()]

    base = pd.DataFrame({name: raw[col] for name, col in dims.items()})
    parts: list[pd.DataFrame] = []
    for block_name, cols in blocks:
        if "clear_cut" not in cols:
            continue
        label = canonical_scheme_name(block_name)
        zeros = pd.Series(0.0, index=raw.index)
        clear_cut = _to_number(raw[cols["clear_cut"]])
        gsr = _to_number(raw[cols["gsr"]]) if "gsr" in cols else zeros
        volume = _to_number(raw[cols["volume"]]) if "volume" in cols else zeros
        rate = _to_number(raw[cols["rate"]]) if "rate" in cols else zeros
        cond = _to_number(raw[cols["condonation"]]) if "condonation" in cols else zeros

        mask = (clear_cut != 0) | (gsr != 0) | (volume != 0)
        if not mask.any():
            continue

        part = base[mask].copy()
        part["scheme"] = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
        part["scheme_label"] = label
        part["component"] = block_name
        part["is_currency"] = is_currency_scheme(label)
        part["volume"] = volume[mask]
        part["gsr"] = gsr[mask]
        part["cn_rate"] = rate[mask]
        part["current_cn"] = clear_cut[mask]
        part["condonation_amount"] = cond[mask]
        parts.append(part)

    df = pd.concat(parts, ignore_index=True)
    df["depot_code"] = df["depot_code"].astype(str).str.strip()
    df["customer_code"] = df["customer_code"].astype(str).str.strip()
    df.to_parquet(cache, index=False)
    return df
