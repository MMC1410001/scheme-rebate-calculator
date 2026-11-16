"""
Adapter for the "CN working" family of monthly files.

These are the files the business settles from. They carry dealer geography and a
settled "CN (Clear Cut)", but no Next Slab columns -- so they support trend,
contribution and payout-rate analysis, but not slab simulation.

Two header shapes turn up, and both are handled here:

  grouped  (May xlsx, July csv)   title row / scheme-group row / metric row,
                                  metric names generic inside each block
                                  ("GSR (B)", "CN (Clear Cut)")

  flat     (April xlsx)           one header row, scheme baked into each column
                                  name ("Value Slab  GSR B Rest")

The shape is detected from the header rather than the filename, which is the
only thing that has proved stable across these exports.
"""
from __future__ import annotations

import csv
import itertools
import re
from functools import lru_cache
from pathlib import Path

import pandas as pd

from app.core.scheme_config import canonical_scheme_name, is_currency_scheme

DIM_HEADERS = {
    "zone": "zone",
    "region": "region",
    "depot code": "depot_code",
    "parent code": "customer_code",
    "customer": "customer_code",
    "customer name": "customer_name",
    # Dealers carrying an overdue balance have their credit note WITHHELD. The
    # settled payout therefore excludes them: for May the file's own summary shows
    # a payout "considering OD" several percent below the one without it.
    "od y/n": "od_flag",
    "od_y_n": "od_flag",
}

# Metric name -> role, for the grouped shape.
METRIC_ROLES = {
    "volume (q)": "volume", "volume a (q)": "volume", "volume b (q)": "volume",
    "gsr (b)": "gsr", "gsr (b) rest": "gsr", "gsr b rest": "gsr",
    "gsr (q)": "gsr_q",
    "cn%": "rate", "cnpercent": "rate",
    "condonation cn": "condonation",
}

# The payout column, most specific first. A bare "CN" is only accepted when the
# block has no explicit clear-cut column: in July's layout "CN" is the scheme
# TOTAL (clear cut plus condonation), and taking both inflated the month about
# fifteenfold.
# Most specific first. A bare "Clear Cut" is the BLOCK roll-up in the September
# working file -- each block also carries per-component clear-cut columns whose
# names are prefixed ("PREMIUM 01 Clear Cut"), so only the unprefixed one is
# matched here and the components cannot be double counted. A bare "CN" stays
# last: in July's layout that name is the scheme TOTAL (clear cut plus
# condonation), and preferring it inflated the month about fifteenfold.
CLEAR_CUT_NAMES = ("cn (clear cut)", "clear cut cn", "cn clear cut", "clear cut", "cn")

GRAND_TOTAL_BLOCKS = {"cn amount", "total cn", "grand total", "cn working", "total"}

# A dealer's business for the month is the Early Bird FULL-MONTH base, which
# these files split across two books:
#
#     "GSR Rest (B)"  the main book        (flat shape: "Early Bird GSR Rest B")
#     "GSR Wood (B)"  the Timbra book     (flat shape: "Early Bird GSR Wood B")
#
# Both are needed, and only from the Early Bird block -- every other block
# publishes its own GSR for its own scheme, and adding those up counts the same
# sale once per scheme it happens to qualify for. That mistake is what produced
# a monthly "GSR" several times the real book.
#
# Cross-checked against May's own summary sheet, which states the month's total.
# Two naming conventions for the same two columns, and a file may use either:
#
#   "GSR Rest (B)" / "GSR Wood (B)"                 Apr, May, Jul working files
#   "GSR(B) EB FULL MONTH" / "GSR(B) TMBR EB FULL MONTH"
#                                                   Sept working file, and the
#                                                   automated exports
#
# The second pair names itself completely, so it is matched on the metric alone.
# The first pair says only "Rest"/"Wood" and is meaningful only inside the Early
# Bird block, so that one still needs its group for context.
TOTAL_GSR_EXACT = ("gsrbebfullmonth", "gsrbtmbrebfullmonth")
TOTAL_GSR_SUFFIXES = ("gsrrestb", "gsrwoodb")


def _find_total_gsr_cols(groups: list[str] | None, metrics: list[str]) -> list[int]:
    """Columns holding the Early Bird full-month base, across every header shape."""
    cols: list[int] = []
    current = ""
    for j, metric in enumerate(metrics):
        if groups is not None and j < len(groups) and groups[j]:
            current = groups[j]
        bare = re.sub(r"[^a-z]", "", metric.lower())
        if bare in TOTAL_GSR_EXACT:
            cols.append(j)
            continue
        context = re.sub(r"[^a-z]", "", f"{current} {metric}".lower())
        if context.startswith("earlybird") and bare.endswith(TOTAL_GSR_SUFFIXES):
            cols.append(j)
    return cols


def _norm(v) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()


def _to_number(series: pd.Series) -> pd.Series:
    """' 1,195,581 ' -> 1195581.0 ; '0.50%' -> 0.5 ; ' -   ' -> 0.0"""
    s = series.astype(str).str.strip()
    s = s.str.replace(",", "", regex=False).str.replace("%", "", regex=False)
    s = s.str.replace(r"^\(\s*(.*?)\s*\)$", r"-\1", regex=True)  # (123) = negative
    s = s.replace({"-": "0", "": "0", "nan": "0", "None": "0", "NaN": "0"})
    return pd.to_numeric(s, errors="coerce").fillna(0.0)


@lru_cache(maxsize=16)
def _read_head_cached(source: Path, sheet: str | None, n: int) -> tuple[tuple, ...]:
    """Header rows, read once per (file, sheet).

    openpyxl has to parse the workbook's shared-string table before it can hand
    back a single cell, and September's holds 245,880 entries -- about 5.5s per
    open. Discovery alone opened it three times, so simply listing the schemes
    cost 17 seconds, on every cold scope. The header never changes while the
    process runs, so it is read once.
    """
    return tuple(tuple(r) for r in _read_head_uncached(source, sheet, n))


def _read_head(source: Path, sheet: str | None, n: int) -> list[list]:
    return [list(r) for r in _read_head_cached(Path(source), sheet, n)]


def _read_head_uncached(source: Path, sheet: str | None, n: int) -> list[list]:
    if source.suffix.lower() == ".csv":
        with open(source, newline="", encoding="latin-1", errors="replace") as f:
            return [list(r) for r in itertools.islice(csv.reader(f), n)]
    import openpyxl

    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    ws = wb[sheet] if sheet else wb[wb.sheetnames[0]]
    rows = [list(r) for r in itertools.islice(ws.iter_rows(values_only=True), n)]
    wb.close()
    return rows


@lru_cache(maxsize=16)
def _detect_layout_cached(source: Path, sheet: str | None) -> tuple:
    d = _detect_layout_uncached(source, sheet)
    return (d["group_row"], d["metric_row"], d["data_start"])


def detect_layout(source: Path, sheet: str | None = None) -> dict:
    g, m, d = _detect_layout_cached(Path(source), sheet)
    return {"group_row": g, "metric_row": m, "data_start": d}


def _detect_layout_uncached(source: Path, sheet: str | None = None) -> dict:
    """Find which row holds the scheme names and which holds the metrics."""
    head = _read_head(source, sheet, 6)
    filled = [sum(1 for c in r if _norm(c)) for r in head]

    # the metric row is the first densely-filled row carrying a known dimension name
    metric_row = None
    for i, r in enumerate(head):
        names = {_norm(c).lower() for c in r}
        if names & set(DIM_HEADERS) and filled[i] > 5:
            metric_row = i
            break
    if metric_row is None:
        metric_row = max(range(len(filled)), key=lambda i: filled[i])

    # a sparse row above it means scheme groups sit there (grouped shape)
    group_row = None
    for i in range(metric_row - 1, -1, -1):
        if 1 < filled[i] < filled[metric_row] / 2:
            group_row = i
            break

    return {"group_row": group_row, "metric_row": metric_row, "data_start": metric_row + 1}


def parse_working_file(source: Path, sheet: str | None = None, force: bool = False) -> pd.DataFrame:
    source = Path(source)
    from app.ingest.parse_raw import CONFIG_VERSION

    cache = source.with_suffix(f".working.v{CONFIG_VERSION}.parquet")
    if cache.exists() and not force:
        return pd.read_parquet(cache)

    layout = detect_layout(source, sheet)
    head = _read_head(source, sheet, layout["data_start"])
    metrics = [_norm(c) for c in head[layout["metric_row"]]]
    groups = [_norm(c) for c in head[layout["group_row"]]] if layout["group_row"] is not None else None

    dims: dict[str, int] = {}
    for j, m in enumerate(metrics):
        key = DIM_HEADERS.get(m.lower())
        if key and key not in dims:
            dims[key] = j

    blocks: list[tuple[str, dict[str, int]]] = []
    if groups is not None:
        def finish(name, cols, seen):
            """Resolve the payout column by priority before closing a block."""
            for candidate in CLEAR_CUT_NAMES:
                if candidate in seen:
                    cols["clear_cut"] = seen[candidate]
                    break
            if cols.get("clear_cut") is not None:
                blocks.append((name, cols))

        current, cols, seen = None, {}, {}
        for j, (g, m) in enumerate(zip(groups + [""] * len(metrics), metrics)):
            if g:
                if current:
                    finish(current, cols, seen)
                current, cols, seen = g, {}, {}
            if current:
                key = m.lower()
                if key in CLEAR_CUT_NAMES and key not in seen:
                    seen[key] = j
                role = METRIC_ROLES.get(key)
                if role and role not in cols:
                    cols[role] = j
        if current:
            finish(current, cols, seen)
    else:
        # Flat shape (April): scheme and metric in one cell, separated by TWO or
        # more spaces -- "Value Slab  CN Clear Cut". Some carry a sub-scheme in
        # between ("Hilltop & Lakeside   Enamel & Primer  GSR B"), so the scheme is
        # the first segment and the metric the last.
        #
        # Only "CN Clear Cut" is taken as the payout. "<Scheme> CN" columns are the
        # scheme TOTAL (clear cut plus condonation) and would double count, and
        # bare "Total CN" / "Final CN" have no separator at all, so they fall out
        # naturally rather than being read as a scheme called "Final".
        flat_roles = {
            "cn clear cut": "clear_cut", "clear cut cn": "clear_cut",
            "condonation cn": "condonation",
            "gsr b rest": "gsr", "gsr b": "gsr", "gsr (b)": "gsr", "gsr": "gsr",
            "cnpercent": "rate", "cn%": "rate",
            "volume q": "volume", "volume (q)": "volume", "volume": "volume",
        }
        raw_metrics = [str(c) if c is not None else "" for c in head[layout["metric_row"]]]
        grouped: dict[str, dict[str, int]] = {}
        for j, raw_m in enumerate(raw_metrics):
            parts = [p.strip() for p in re.split(r"\s{2,}", raw_m.strip()) if p.strip()]
            if len(parts) < 2:
                continue  # a grand total, or a dimension column
            role = flat_roles.get(parts[-1].lower())
            if role:
                grouped.setdefault(parts[0], {}).setdefault(role, j)
        blocks = list(grouped.items())

    blocks = [
        (n, c) for n, c in blocks
        if canonical_scheme_name(n).strip().lower() not in GRAND_TOTAL_BLOCKS and "clear_cut" in c
    ]
    if not blocks or "customer_code" not in dims:
        raise ValueError(f"could not read {source.name}: blocks={len(blocks)} dims={list(dims)}")

    total_gsr_cols = _find_total_gsr_cols(groups, metrics)
    needed = sorted({*dims.values(), *total_gsr_cols,
                     *(c for _, cols in blocks for c in cols.values())})
    if source.suffix.lower() == ".csv":
        raw = pd.read_csv(source, skiprows=layout["data_start"], header=None,
                          usecols=needed, dtype=str, low_memory=False, encoding="latin-1")
    else:
        raw = pd.read_excel(source, sheet_name=sheet, header=None,
                            skiprows=layout["data_start"], usecols=needed,
                            names=needed, engine="calamine", dtype=str)
    raw = raw[raw[dims["customer_code"]].notna()]

    base = pd.DataFrame({name: raw[col] for name, col in dims.items()})
    for missing in ("zone", "region", "depot_code", "customer_name"):
        if missing not in base.columns:
            base[missing] = None
    # Carried per dealer, so it can be de-duplicated on customer_code later --
    # the same value repeats on every scheme row that dealer appears in.
    base["total_gsr"] = (
        sum(_to_number(raw[c]) for c in total_gsr_cols)
        if total_gsr_cols else 0.0
    )
    base["od_blocked"] = (
        base["od_flag"].astype(str).str.strip().str.upper().eq("Y")
        if "od_flag" in base.columns else False
    )
    base = base.drop(columns=[c for c in ("od_flag",) if c in base.columns])

    zeros = pd.Series(0.0, index=raw.index)
    parts: list[pd.DataFrame] = []
    for block_name, cols in blocks:
        label = canonical_scheme_name(block_name)
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
        part["current_cn"] = clear_cut[mask]          # EARNED
        part["condonation_amount"] = cond[mask]
        # What actually settles. Verified on 100% of May's rows:
        #   settled = clear cut + condonation, unless the dealer carries an
        #   overdue balance, in which case it is zero however much they earned.
        # over a thousand dealers earned Value Slab in May and received nothing for it.
        part["settled_cn"] = (
            (clear_cut[mask] + cond[mask]).where(~part["od_blocked"].to_numpy(), 0.0)
            if "od_blocked" in part else clear_cut[mask] + cond[mask]
        )
        parts.append(part)

    df = pd.concat(parts, ignore_index=True)
    for c in ("customer_code", "depot_code"):
        df[c] = df[c].astype(str).str.strip()
    df.to_parquet(cache, index=False)
    return df
