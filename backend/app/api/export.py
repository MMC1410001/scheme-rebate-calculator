"""The Excel export: what the user sees, with their own edits, as one workbook.

Edits live only in the user's browser (nothing per user is stored on the server), so the browser sends its rows and
this builds the file and returns it. Nothing is kept: two people exporting at the same time get their own files.
The workbook holds aggregates only (scheme and slab rows), no dealer-level data.
"""
from __future__ import annotations

import io
from datetime import datetime
from zoneinfo import ZoneInfo

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

# Indian digit grouping (1,23,45,678) for rupees and litres.
INR = '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0'
# Rates: whole numbers without a decimal point ("250", not "250."), fractions with up to 4 decimals.
RATE_WHOLE, RATE = "#,##0", "#,##0.0###"
PCT = "0.00%"
HEAD = Font(bold=True, color="FFFFFF")
HEAD_FILL = PatternFill("solid", fgColor="1B5AA6")
EDITED_FILL = PatternFill("solid", fgColor="FFF4D6")


def _table(ws, headers: list[str], rows: list[list], formats: dict[int, str], edited_rows: set[int] = frozenset()):
    ws.append(headers)
    for cell in ws[1]:
        cell.font, cell.fill = HEAD, HEAD_FILL
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    for i, row in enumerate(rows):
        ws.append(row)
        for col, fmt in formats.items():
            ws.cell(row=i + 2, column=col).number_format = fmt
        if i in edited_rows:
            for cell in ws[i + 2]:
                cell.fill = EDITED_FILL
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    for col in range(1, len(headers) + 1):
        def text(v):
            return f"{v:,.0f}" if isinstance(v, float) else str(v if v is not None else "")
        width = max([len(headers[col - 1])] + [len(text(r[col - 1])) for r in rows[:500]])
        ws.column_dimensions[get_column_letter(col)].width = min(max(width + 2, 10), 48)


def _regions(mine: list[str]) -> str:
    """A slab row's regions, every name, comma separated."""
    return ", ".join(sorted(set(mine)))


def _text_only(wb: Workbook) -> None:
    """Keep every text as text. openpyxl stores a string starting with "=" as a formula, and labels, components and
    the scope come from the browser, so "=HYPERLINK(...)" would run when the file is opened. The workbook has no
    formulas of its own."""
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if cell.data_type == "f":
                    cell.data_type = "s"


def _slab(r: dict) -> str:
    if r["slab_mode"] == "unrated":
        return "Not qualified"
    lo, hi = r.get("slab_lower"), r.get("slab_upper")
    if r["slab_mode"] == "target":
        return f"{lo:,.0f} – {hi:,.0f}" if lo is not None and hi is not None else ""
    if lo is None:   # allowed by the request (ExportRow); was a 500
        return "" if hi is None else f"up to {hi:,.0f}"
    return f"{lo:,.0f} and above" if hi is None else f"{lo:,.0f} – {hi:,.0f}"


def build_workbook(req, source: dict, grand: dict) -> tuple[bytes, str]:
    """The workbook and its file name."""
    wb = Workbook()
    now = datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%d-%m-%Y %H:%M")
    schemes = req.schemes
    actual = sum(sum(r.current_cn for r in s.rows) for s in schemes if s.is_currency)
    simulated = sum(sum(r.simulated_cn for r in s.rows) for s in schemes if s.is_currency)
    edited = sum(1 for s in schemes for r in s.rows if abs(r.simulated_rate - r.cn_rate) > 1e-12) + len(req.moved)

    ws = wb.active
    ws.title = "Summary"
    month = source.get("month") or ""
    status = "complete month" if source.get("complete") else (
        f"part month, day {source.get('elapsed_days')} of {source.get('month_days')}")
    lines = [
        ("Scheme Performance & Impact — export", None, None),
        ("Month", month, None),
        ("Data as of", source.get("as_of"), status),
        ("Scope", req.scope_label, None),
        ("Exported", f"{now} IST", None),
        ("Edits in this view", edited, "rates changed or boundaries moved; edited rows are highlighted on the Slabs sheet"),
        (None, None, None),
        ("Dealers", grand.get("dealer_count"), None),
        ("Volume (L)", grand.get("volume"), None),
        ("GSR (₹)", grand.get("gsr"), "Value + Value % + Timbra, once per dealer"),
        ("Credit note, actual (₹)", actual, "rupee schemes; gift schemes are listed apart"),
        ("Credit note, simulated (₹)", simulated, "with the edits in this view"),
        ("Impact (₹)", simulated - actual, "simulated minus actual"),
        ("CN % of GSR, actual", actual / grand["gsr"] if grand.get("gsr") else None, None),
        ("CN % of GSR, simulated", simulated / grand["gsr"] if grand.get("gsr") else None, None),
        (None, None, None),
        ("Note", "Simulations hold dealer volumes fixed. A settled month's credit notes are paid: a lower simulated "
                 "figure is what a revised structure would have cost, not money recovered.", None),
    ]
    for row in lines:
        ws.append(list(row))
    ws["A1"].font = Font(bold=True, size=14)
    for r in range(2, len(lines) + 1):
        ws.cell(row=r, column=1).font = Font(bold=True)
    for r in (9, 10, 11, 12, 13):
        ws.cell(row=r, column=2).number_format = INR
    ws.cell(row=8, column=2).number_format = INR
    for r in (14, 15):
        ws.cell(row=r, column=2).number_format = PCT
    ws.column_dimensions["A"].width, ws.column_dimensions["B"].width, ws.column_dimensions["C"].width = 30, 24, 70

    rows = []
    for s in schemes:
        a = sum(r.current_cn for r in s.rows)
        sim = sum(r.simulated_cn for r in s.rows)
        rows.append([s.label, s.key, s.status, "₹" if s.is_currency else "gifts", s.dealer_count, s.volume, s.gsr,
                     a, sim, sim - a, (sim / s.gsr) if s.gsr and s.is_currency else None])
    _table(wb.create_sheet("Schemes"),
           ["Scheme", "Key", "Reconciliation", "Pays in", "Dealers", "Volume (L)", "GSR (₹)", "Actual CN",
            "Simulated CN", "Impact", "CN % of GSR"],
           rows, {5: INR, 6: INR, 7: INR, 8: INR, 9: INR, 10: INR, 11: PCT})

    rows, marked = [], set()
    moved = set(req.moved)
    for s in schemes:
        for r in s.rows:
            changed = abs(r.simulated_rate - r.cn_rate) > 1e-12 or f"{s.key}::{r.component}" in moved
            if changed:
                marked.add(len(rows))
            rows.append([s.label, r.component, _regions(r.regions), _slab(r.model_dump()), r.formula,
                         r.dealer_count, r.volume, r.gsr, r.cn_rate, r.simulated_rate, r.current_cn, r.simulated_cn, r.simulated_cn - r.current_cn,
                         (r.simulated_cn / r.gsr) if r.gsr else None, "yes" if changed else ""])
    _table(wb.create_sheet("Slabs"),
           ["Scheme", "Component", "Applicable regions", "Slab", "Rate type", "Dealers", "Volume (L)", "GSR (₹)",
            "Current rate", "New rate", "Actual CN", "Simulated CN", "Impact", "CN % of GSR", "Edited"],
           rows, {6: INR, 7: INR, 8: INR, 9: RATE, 10: RATE, 11: INR, 12: INR, 13: INR, 14: PCT},
           marked)

    slabs = wb["Slabs"]
    for row in slabs.iter_rows(min_row=2, min_col=9, max_col=10):
        for cell in row:
            if isinstance(cell.value, (int, float)) and float(cell.value).is_integer():
                cell.number_format = RATE_WHOLE

    _text_only(wb)
    buf = io.BytesIO()
    wb.save(buf)
    # ASCII letters and digits only: a header must be Latin-1, and isalnum() alone also passes Devanagari, which made
    # the response fail.
    safe_scope = "".join(c if c.isascii() and c.isalnum() else "-" for c in req.scope_label).strip("-")[:40] or "All-India"
    return buf.getvalue(), f"scheme-performance_{month}_{safe_scope}.xlsx"
