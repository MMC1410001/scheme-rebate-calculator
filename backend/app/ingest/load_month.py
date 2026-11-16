"""
Loads any monthly export into the one tidy schema, whichever layout it uses.

Three layouts have turned up so far and more should be expected:
  * September "grouped"  -- variant-named columns ("Volume Q LUXURY")
  * August   "working"   -- same idea, different positions and spacing
  * July     "uniform"   -- ten identical metrics per block, no geography

The layout is detected from the header rather than the filename, since the
filenames are not a reliable signal.
"""
from __future__ import annotations

import logging
from pathlib import Path

import pandas as pd

from app.core.scheme_config import DIMENSION_COLS
from app.ingest.all_schemes import get_schemes
from app.ingest.discover_schemes import find_od_col, find_total_gsr_cols
from app.ingest.discover_uniform import (
    discover_uniform,
    find_total_gsr_cols_uniform,
    looks_uniform,
)
from app.ingest.parse_raw import parse_raw_file
from app.ingest.parse_working import parse_working_file

GEO_COLS = ["zone", "region", "depot_code", "customer_name"]


def _has_sheet(source: Path, name: str) -> bool:
    if source.suffix.lower() == ".csv":
        return False
    import openpyxl

    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    try:
        return name in wb.sheetnames
    finally:
        wb.close()


def _working_total_gsr_cols(source: Path, sheet: str | None) -> list[int]:
    """The dealer's full-month base, located the way the working parser does."""
    from app.ingest.parse_working import (
        _find_total_gsr_cols,
        _norm,
        _read_head,
        detect_layout,
    )

    layout = detect_layout(source, sheet)
    head = _read_head(source, sheet, layout["data_start"])
    metrics = [_norm(c) for c in head[layout["metric_row"]]]
    groups = (
        [_norm(c) for c in head[layout["group_row"]]]
        if layout["group_row"] is not None else None
    )
    return _find_total_gsr_cols(groups, metrics)


def dealer_master(df: pd.DataFrame) -> pd.DataFrame:
    """customer_code -> geography, taken from a month that publishes it."""
    cols = ["customer_code", *GEO_COLS]
    master = df[cols].dropna(subset=["zone"]).drop_duplicates("customer_code")
    return master.reset_index(drop=True)


def attach_geography(df: pd.DataFrame, master: pd.DataFrame) -> pd.DataFrame:
    """Fill missing Zone/Region/Depot from a dealer master keyed on customer code."""
    if df.empty or "zone" not in df.columns or df["zone"].notna().any():
        return df
    out = df.drop(columns=GEO_COLS).merge(master, on="customer_code", how="left")
    return out


# Candidate data-sheet names, tried in order. These books also carry summary and
# reference sheets, and the data sheet is not always first -- September's opens
# on a pivot ("Sheet1") with the real rows in "CN Working", so taking sheet 0
# parses the summary and reports a month of about a thousand dealers.
WORKING_SHEETS = ("CN Working", "Working File", "Sheet1", None)


def load_month(
    source: Path,
    force: bool = False,
    master: pd.DataFrame | None = None,
    source_kind: str | None = None,
) -> pd.DataFrame:
    """A month's dealer frame: from the spi database when DATA_SOURCE=spi holds this file, else parsed from the file."""
    from app import spi

    if spi.enabled() and not force and master is None:
        from app.spi.frames import month_frame_for

        frame = month_frame_for(Path(source))
        if frame is not None:
            logging.getLogger("app.spi").info("%s read from the database (%d rows)", Path(source).name, len(frame))
            return frame
        logging.getLogger("app.spi").info("%s not in the database; parsed from the file", Path(source).name)
    return load_month_file(source, force=force, master=master, source_kind=source_kind)


def load_month_file(
    source: Path,
    force: bool = False,
    master: pd.DataFrame | None = None,
    source_kind: str | None = None,
) -> pd.DataFrame:
    """A month's dealer frame parsed from its file (parquet-cached)."""
    source = Path(source)

    # A working file WITH slab structure: discovered into the same Component
    # shape the automated exports use, then run through the same parser, so
    # calibration, cn_units and the slab engine are all shared rather than
    # reimplemented. Kept as its own source kind rather than applied to every
    # working file, because the other months already reconcile on the simpler
    # path and should not be silently re-derived.
    if source_kind == "working_slabs":
        from app.ingest.discover_working import discover_working

        sheet = next((s for s in WORKING_SHEETS if s and _has_sheet(source, s)), None)
        schemes, dims = discover_working(source, sheet)
        if not schemes:
            raise ValueError(f"no schemes discovered in {source.name}")
        df = parse_raw_file(
            source, schemes, sheet_name=sheet or 0, force=force,
            dimension_cols=dims,
            total_gsr_cols=_working_total_gsr_cols(source, sheet),
            od_col=dims.get("od_flag"),
        )
        return attach_geography(df, master) if master is not None else df

    # "CN working" files without slab columns: totals only.
    if source_kind in ("working_flat", "working_grouped", "cn_working") or source.suffix.lower() == ".csv":
        last: Exception | None = None
        for sh in WORKING_SHEETS:
            try:
                df = parse_working_file(source, sh, force=force)
                return attach_geography(df, master) if master is not None else df
            except Exception as exc:  # not this sheet -- try the next candidate
                last = exc
        raise last if last else RuntimeError(f"could not read {source}")

    if looks_uniform(source):
        schemes, dims = discover_uniform(source)
        # the uniform layout carries no geography at all
        dims = {**dims}
        df = parse_raw_file(source, schemes, force=force, dimension_cols=dims,
                            total_gsr_cols=find_total_gsr_cols_uniform(source))
        if master is not None:
            df = attach_geography(df, master)
        return df

    schemes = get_schemes(source, force=force)
    return parse_raw_file(source, schemes, force=force, dimension_cols=DIMENSION_COLS,
                          total_gsr_cols=find_total_gsr_cols(source),
                          od_col=find_od_col(source))


def load_month_schemes(source: Path):
    source = Path(source)
    if looks_uniform(source):
        return discover_uniform(source)[0]
    return get_schemes(source)
