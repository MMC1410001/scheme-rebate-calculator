"""A file's dealer frame read back from spi: the same columns, values, types and row order as parsing the file."""
from __future__ import annotations

import io
from pathlib import Path

import pandas as pd

from app.spi import connect

COLUMNS = [
    "zone", "region", "depot_code", "customer_code", "customer_name", "total_gsr", "od_blocked", "scheme",
    "scheme_label", "component", "formula", "pack_size", "base_value", "cn_rate", "cn_units", "current_cn", "volume",
    "gsr", "gsr_src", "vol_src", "slab_basis", "next_slab", "condonation_amount", "scheme_cn", "settled_cn",
    "component_clear_cut", "clear_cut_total", "is_currency",
]
_SELECT = """
SELECT g.zone, g.region, g.depot_code, f.dealer_code AS customer_code, fd.customer_name, fd.total_gsr, fd.od_blocked,
       s.code AS scheme, fc.scheme_label, c.name AS component, fc.formula, fc.pack_size, f.base_value, f.cn_rate,
       f.cn_units, f.current_cn, f.volume, f.gsr, f.gsr_src, f.vol_src, f.slab_basis, f.next_slab,
       f.condonation_amount, f.scheme_cn, f.settled_cn, f.component_clear_cut, f.clear_cut_total, f.is_currency
FROM spi.file_dealer_component f
JOIN spi.file_dealer fd ON fd.file_id = f.file_id AND fd.dealer_code = f.dealer_code
JOIN spi.file_component fc ON fc.file_id = f.file_id AND fc.component_id = f.component_id
JOIN spi.geo_unit g ON g.geo_id = f.geo_id
JOIN spi.component c ON c.component_id = f.component_id
JOIN spi.scheme s ON s.scheme_id = c.scheme_id
WHERE f.file_id = {file_id}
ORDER BY f.row_no
"""
_TEXT = ["zone", "region", "customer_name", "scheme", "scheme_label", "component", "formula"]
_INT = ["depot_code", "customer_code", "pack_size", "gsr_src", "vol_src"]
_FLOAT = ["total_gsr", "base_value", "cn_rate", "cn_units", "current_cn", "volume", "gsr", "slab_basis", "next_slab",
          "condonation_amount", "scheme_cn", "settled_cn", "component_clear_cut", "clear_cut_total"]
_BOOL = {"t": True, "f": False}


def file_id_of(file_name: str) -> int | None:
    """The id spi holds this file under (its newest load), or None."""
    with connect() as conn:
        row = conn.execute("SELECT max(file_id) FROM spi.source_file WHERE file_name = %s", (file_name,)).fetchone()
    return row[0]


def read_file(file_id: int) -> pd.DataFrame:
    """One bulk COPY of the file's rows; floats round-trip exactly (shortest repr both ways)."""
    buf = io.BytesIO()
    with connect() as conn, conn.cursor() as cur:
        query = _SELECT.format(file_id=int(file_id))
        with cur.copy(f"COPY ({query}) TO STDOUT WITH (FORMAT csv, HEADER true)") as copy:
            for chunk in copy:
                buf.write(chunk)
    buf.seek(0)
    # Types pinned, not guessed: a column that is all zero in a file would otherwise come back as int.
    df = pd.read_csv(buf, dtype={**{c: "str" for c in _TEXT + ["od_blocked", "is_currency"]},
                                 **{c: "float64" for c in _FLOAT}},
                     keep_default_na=False, na_values=[""])
    for c in _INT:
        df[c] = df[c].astype("int64")
    df["od_blocked"] = df["od_blocked"].map(_BOOL).astype(bool)
    if df["is_currency"].isna().all():
        # The parser adds the column only for a file with "Other (unattributed)" rows, whose values are never empty.
        return df[[c for c in COLUMNS if c != "is_currency"]]
    df["is_currency"] = df["is_currency"].map(_BOOL).astype(object).where(df["is_currency"].notna(), None)
    return df[COLUMNS]


def month_frame_for(source: Path) -> pd.DataFrame | None:
    """The frame for a file when spi holds that file; None to fall back to parsing it."""
    file_id = file_id_of(source.name)
    return None if file_id is None else read_file(file_id)


_GIFT_SELECT = """
SELECT g.zone, g.region, g.depot_code, x.dealer_code AS customer_code, s.code AS scheme, x.volume, x.gsr, x.level,
       x.clear_cut, x.next_slab, x.shortfall
FROM spi.file_dealer_gift x
JOIN spi.geo_unit g ON g.geo_id = x.geo_id
JOIN spi.scheme s ON s.scheme_id = x.scheme_id
WHERE x.file_id = {file_id}
ORDER BY x.row_no
"""
GIFT_COLUMNS = ["zone", "region", "depot_code", "customer_code", "scheme", "volume", "gsr", "level", "clear_cut",
                "next_slab", "shortfall"]


def read_gifts(file_id: int) -> pd.DataFrame:
    """A gift file's rows, as app.ingest.gifts.load_gifts parses them."""
    buf = io.BytesIO()
    with connect() as conn, conn.cursor() as cur:
        with cur.copy(f"COPY ({_GIFT_SELECT.format(file_id=int(file_id))}) TO STDOUT WITH (FORMAT csv, HEADER true)") as cp:
            for chunk in cp:
                buf.write(chunk)
    buf.seek(0)
    df = pd.read_csv(buf, dtype={"zone": "str", "region": "str", "scheme": "str",
                                 **{c: "float64" for c in GIFT_COLUMNS[5:]}}, keep_default_na=False, na_values=[""])
    for c in ("depot_code", "customer_code"):
        df[c] = df[c].astype("int64")
    return df[GIFT_COLUMNS]


def gifts_frame_for(source: Path) -> pd.DataFrame | None:
    """The gift rows for a file when spi holds it; None to fall back to parsing it."""
    file_id = file_id_of(source.name)
    return None if file_id is None else read_gifts(file_id)


def scheme_configs_for(file_name: str) -> list[dict] | None:
    """The scheme definitions the parser read from this file's header, as stored at load; None when not held."""
    with connect() as conn:
        row = conn.execute("SELECT scheme_configs FROM spi.source_file WHERE file_name = %s AND scheme_configs IS NOT NULL "
                           "ORDER BY file_id DESC LIMIT 1", (file_name,)).fetchone()
    return None if row is None else row[0]


def live_files(kind: str = "main") -> list[tuple]:
    """Each month's newest file of a kind: (month, file_name, version, extract_date, complete), oldest month first."""
    with connect() as conn:
        return conn.execute("SELECT month, file_name, version, extract_date, complete FROM spi.live_file "
                            "WHERE kind = %s ORDER BY month", (kind,)).fetchall()


def schemes_from_configs(configs: list[dict]) -> dict:
    """The stored scheme definitions as the parser's SchemeConfig objects, in the file's order."""
    from app.core.scheme_config import Component, SchemeConfig

    def component(c: dict) -> Component:
        return Component(**{k: tuple(v) if isinstance(v, list) else v for k, v in c.items()})

    return {c["key"]: SchemeConfig(**{**c, "components": [component(x) for x in c["components"]]}) for c in configs}
