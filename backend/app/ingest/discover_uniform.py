"""
Adapter for the "uniform block" export (July 2026 v9).

A third layout, and the tidiest of them: row 0 names each block, row 1 repeats
the same ten metrics for every block, and blocks are exactly ten columns wide.

    GSR (Q) | Achievement % (Q) | GSR (B) | Rebate Rate | Clear Cut CN
    Next Slab Value | Short Fall | Short Fall % | Condonation Amount | Total Rebate

Two things make it easier than the September/August layouts:
  * every block publishes its own "Clear Cut CN", so the payout formula can be
    calibrated against ground truth rather than inferred from column names;
  * "GSR (Q)" is the slab basis and pairs with "Next Slab Value" in the same
    unit, so boundaries come out clean (Luxury: 16 L + 4 = the 20 L edge).

"GSR (Q)" carries different units per scheme -- litres for Luxury, rupees for
Value Slab -- which is why it is treated as an abstract "achievement" for slab
purposes and only reported as volume when the scheme is known to be quantity
based.

What this layout does NOT carry is dealer geography: there is only a customer
code, so Zone/Region/Depot have to be joined from another month's export.
"""
from __future__ import annotations

import re

import openpyxl

from app.core.scheme_config import Component, SchemeConfig, canonical_scheme_name, is_currency_scheme

# The first and sixth columns of a block come in two flavours depending on
# whether the scheme is measured in rupees or in litres:
#   value-based  (14 blocks): "GSR (Q)"              + "Next Slab Value"
#   volume-based (92 blocks): "Invoiced Quantity(Q)" + "Next Slab Quantity"
# Both play the same role, so both map to the same slot.
BLOCK_METRICS = {
    "GSR (Q)": "qty",
    "Invoiced Quantity(Q)": "qty",
    "GSR (B)": "gsrb",
    "Rebate Rate": "rate",
    "Clear Cut CN": "clear_cut",
    "Next Slab Value": "next_slab",
    "Next Slab Quantity": "next_slab",
    "Condonation Amount": "condonation",
    "Total Rebate": "total",
}

# Only the volume-based flavour is litres; "GSR (Q)" is rupees.
VOLUME_FIRST_COL = "Invoiced Quantity(Q)"


def looks_uniform(source, sheet_name: str = "Output") -> bool:
    """True when row 1 repeats the block metric names instead of naming variants."""
    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    ws = wb[sheet_name]
    it = ws.iter_rows(min_row=1, max_row=2, values_only=True)
    next(it)
    row1 = next(it)
    wb.close()
    names = [str(v).strip() for v in row1[1:40] if v]
    return names.count("Clear Cut CN") >= 2 or names.count("Rebate Rate") >= 2


# Same rule as the variant layout, but here the two full-month books are their
# own blocks rather than named columns. Both are needed: Timbra is a separate
# book from the main (Rest) one, not a subset of it.
TOTAL_GSR_BLOCKS = {"eb full month", "tmbr full month"}


def find_total_gsr_cols_uniform(source, sheet_name: str = "Output") -> list[int]:
    import openpyxl as _ox
    wb = _ox.load_workbook(source, read_only=True, data_only=True)
    ws = wb[sheet_name]
    it = ws.iter_rows(min_row=1, max_row=2, values_only=True)
    row0 = next(it)
    row1 = next(it)
    wb.close()

    starts = [(j, str(v).strip()) for j, v in enumerate(row0) if v not in (None, "")]
    cols: list[int] = []
    for col, name in starts:
        if name.strip().lower() not in TOTAL_GSR_BLOCKS:
            continue
        for offset in range(10):
            j = col + offset
            if j < len(row1) and re.sub(r"\s+", " ", str(row1[j] or "")).strip() == "GSR (B)":
                cols.append(j)
                break
    return cols


def discover_uniform(source, sheet_name: str = "Output") -> tuple[dict[str, SchemeConfig], dict[str, int]]:
    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    ws = wb[sheet_name]
    it = ws.iter_rows(min_row=1, max_row=2, values_only=True)
    row0 = next(it)
    row1 = next(it)
    wb.close()

    starts = [(j, str(v).strip()) for j, v in enumerate(row0) if v not in (None, "")]
    dimension_cols: dict[str, int] = {}
    blocks: list[tuple[str, int]] = []
    for col, name in starts:
        if name.lower() == "customer":
            dimension_cols["customer_code"] = col
            continue
        blocks.append((name, col))

    # Block width varies by export: July 2026 writes ten metrics per block, June
    # only five (no Next Slab, no condonation). Taking it from the distance to the
    # next block start means neither is hard-coded -- assuming ten would have read
    # June's NEXT block and mislabelled its columns.
    starts_only = [col for _, col in blocks]  # blocks are (name, col)
    widths = {
        c: (starts_only[i + 1] - c if i + 1 < len(starts_only) else len(row1) - c)
        for i, c in enumerate(starts_only)
    }

    configs: dict[str, SchemeConfig] = {}
    for name, start in blocks:
        cols: dict[str, int] = {}
        is_volume = False
        for offset in range(min(widths.get(start, 10), 12)):
            j = start + offset
            if j >= len(row1):
                break
            metric = re.sub(r"\s+", " ", str(row1[j] or "")).strip()
            if metric == VOLUME_FIRST_COL:
                is_volume = True
            role = BLOCK_METRICS.get(metric)
            if role and role not in cols:
                cols[role] = j
        if "rate" not in cols or "clear_cut" not in cols:
            continue

        label = canonical_scheme_name(name)
        key = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
        if key in configs:  # same canonical scheme split across blocks -> keep both as components
            existing = configs[key]
            components = list(existing.components)
        else:
            components = []

        components.append(
            Component(
                name=name,
                base_col=cols.get("gsrb", cols["rate"]),
                rate_col=cols["rate"],
                next_slab_col=cols.get("next_slab"),
                slab_basis_col=cols.get("qty", cols.get("gsrb")),
                condonation_col=cols.get("condonation"),
                clear_cut_col=cols["clear_cut"],
                gsr_col=cols.get("gsrb"),
                volume_col=cols.get("qty") if is_volume else None,
                qty_col=cols.get("qty"),
                gsrb_col=cols.get("gsrb"),
                alt_base_cols=tuple(v for k, v in cols.items() if k in ("qty", "gsrb")),
                formula="percent",  # replaced by calibration against Clear Cut CN
            )
        )
        configs[key] = SchemeConfig(
            key=key,
            label=label,
            scheme_type="mixed",
            total_cn_col=cols.get("total", cols["clear_cut"]),
            clear_cut_total_col=cols["clear_cut"],
            is_currency=is_currency_scheme(label),
            components=components,
        )

    return configs, dimension_cols
