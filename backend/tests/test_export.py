"""app/api/export.py: text from the browser never becomes a formula in the workbook."""
import io

from openpyxl import load_workbook

from app.api.export import build_workbook
from app.schemas import ExportRequest


def test_text_starting_with_equals_stays_text():
    req = ExportRequest(scope_label='=HYPERLINK("http://x","y")', schemes=[{
        "key": "k", "label": "=1+1", "rows": [{"component": "=SUM(A1:A9)", "formula": "percent", "slab_mode": "slab",
                                              "slab_lower": 0, "slab_upper": 100}]}])
    content, name = build_workbook(req, {"month": "2026-10", "as_of": "2026-10-28", "complete": False,
                                         "elapsed_days": 28, "month_days": 31}, {"gsr": 1.0, "dealer_count": 1})
    wb = load_workbook(io.BytesIO(content))
    cells = [c for ws in wb.worksheets for row in ws.iter_rows() for c in row]
    assert not [c.coordinate for c in cells if c.data_type == "f"]
    assert any(c.value == "=1+1" for c in cells)
    assert all(ch.isalnum() or ch in "-_." for ch in name)   # no quote, slash or parenthesis in the header


def test_file_name_is_ascii_whatever_the_scope():
    req = ExportRequest(scope_label="दिल्ली + Haryana", schemes=[])
    _, name = build_workbook(req, {"month": "2026-11", "complete": True}, {"gsr": 0.0, "dealer_count": 0})
    name.encode("latin-1")                                  # a header value must be Latin-1
    assert name == "scheme-performance_2026-11_Haryana.xlsx"
