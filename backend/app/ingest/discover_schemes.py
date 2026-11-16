"""
Generic discovery of scheme configs from the raw file's 2-row header, instead
of hand-mapping every column index per scheme. Column-name pattern matching
replaces manual SCHEMES entries in scheme_config.py for every scheme beyond
the 3 manually-verified ones (value_slab, luxury, primer).

Why generic, and why still risky: column names in this export are not
fully reliable (e.g. "VALUE FA CN%" looks like a rate but is actually a
flat amount). We mitigate with a naming heuristic (an "FA" token in the
variant name -> formula="fixed") that matches every confirmed case so far,
but every auto-discovered scheme should be reconciled against its own
"<Scheme> CN" total column (see reconcile.py) before being trusted.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import openpyxl

from app.core.scheme_config import (
    OVERRIDES,
    Component,
    SchemeConfig,
    canonical_scheme_name,
    is_currency_scheme,
)

BASE_PREFIXES = ["Volume Q ", "GSR(Q) "]
GSRB_PREFIX = "GSR(B) "
RATE_SUFFIX = " CN%"
NEXT_SLAB_PREFIXES = ["Next Slab Qty ", "Next Slab Value "]
COND_AMOUNT_PREFIX = "Condonation Amount "
COND_AMOUNT_BARE = "Condonation Amount"


@dataclass
class HeaderCell:
    col: int
    scheme_name: str
    metric: str


def read_headers(source, sheet_name: str = "Output") -> list[HeaderCell]:
    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    ws = wb[sheet_name]
    row0 = next(ws.iter_rows(min_row=1, max_row=1, values_only=True))
    row1 = next(ws.iter_rows(min_row=2, max_row=2, values_only=True))
    wb.close()

    cells: list[HeaderCell] = []
    current_scheme = None
    for col, (v0, v1) in enumerate(zip(row0, row1)):
        if v0:
            current_scheme = v0
        if not v1 or not current_scheme or col < 5:  # skip dimension columns
            continue
        # The sheet ends with grand-total columns ("Total Clear Cut", "Total
        # Condonation Amount", "TOTAL CN"). They sit under the last scheme's header
        # but belong to no scheme -- without this the last block's total column
        # resolves to the whole-sheet TOTAL CN.
        # Header text is inconsistently spaced between months ("Total Fixed CN "
        # with a trailing space, "Fixed  CN EB2" with a double one), so normalise
        # before anything tries to match on it.
        metric = re.sub(r"\s+", " ", str(v1)).strip()
        if metric.lower() in {"total clear cut", "total condonation amount", "total cn"}:
            continue
        cells.append(HeaderCell(col=col,
                                scheme_name=canonical_scheme_name(current_scheme),
                                metric=metric))
    return cells


_PACK_RE = re.compile(r"\bper\s*(\d+)\s*(l|ltr|litre|kg)?\b", re.IGNORECASE)
_PER_UNIT_RE = re.compile(r"\bper\s+(l|ltr|litre|kg)\b", re.IGNORECASE)


def _parse_pack_size(variant: str) -> int | None:
    """"Luxury Exterior Per 40 L" -> 40; "DAMP GUARD PER 40" -> 40.
    "Waterproofing Per L" / "Filler Per Kg" -> 1 (rate is per single unit)."""
    m = _PACK_RE.search(variant)
    if m:
        return int(m.group(1))
    if _PER_UNIT_RE.search(variant):
        return 1
    return None


# A dealer's TOTAL business is the main (Rest) book plus the Timbra book.
# Confirmed by the business -- Timbra is a SEPARATE book, so both are needed.
#
# The main book is Value + Value %, not the EB full-month base: South runs no
# EB full-month scheme (its Early Bird pays on sales within each window), so that
# column is empty for every South dealer and their whole book read as zero
# (a large share of the month). Each dealer carries exactly one of Value / Value %, and
# outside South their sum equals the EB full-month base for almost every dealer.
# Timbra is likewise read from its value-slab base, which every region carries.
#
# Per-scheme GSR cannot be summed for this purpose because the same sale appears
# in several schemes at once; doing so is what inflated the monthly trend to
# several times the real size of the business.
TOTAL_GSR_METRICS = ("GSR(B) Value", "GSR(B) Value %", "GSR(B) TMBR Value Slab")


def find_total_gsr_cols(source, sheet_name: str = "Output") -> list[int]:
    cols: list[int] = []
    for cell in read_headers(source, sheet_name):
        if cell.metric in TOTAL_GSR_METRICS and cell.col not in cols:
            cols.append(cell.col)
    return cols


# Dealers carrying an overdue balance have their credit note withheld entirely:
# verified on 100% of May's rows, the settled CN is zero however much they earned.
OD_FLAG_METRICS = {"od(y/n)", "od y/n", "od_y_n", "od (y/n)"}


def find_od_col(source, sheet_name: str = "Output") -> int | None:
    for cell in read_headers(source, sheet_name):
        if cell.metric.strip().lower() in OD_FLAG_METRICS:
            return cell.col
    return None


def _resolve_override(
    spec: list[dict],
    by_metric: dict[str, int],
    volume_bases: dict[str, int],
    gsrb_bases: dict[str, int],
    clear_cuts: dict[str, int],
) -> list[Component]:
    """Turn a name-based override into Components against THIS file's headers.

    A component whose columns are missing is dropped when marked optional, so one
    spec can cover months whose exports differ.
    """
    out: list[Component] = []
    for item in spec:
        if item.get("skip_if_present") and item["skip_if_present"] in by_metric:
            continue
        base = by_metric.get(item["base"])
        rate = by_metric.get(item["rate"])
        if base is None or rate is None:
            if item.get("optional"):
                continue
            return []  # a required column is missing -> fall back to generic discovery

        slab_basis = by_metric.get(item.get("slab_basis") or "", base)
        next_slab = by_metric.get(item["next_slab"]) if item.get("next_slab") else None
        requires_zero = tuple(
            by_metric[c] for c in item.get("requires_zero", []) if c in by_metric
        )
        out.append(
            Component(
                name=item["name"],
                base_col=base,
                rate_col=rate,
                next_slab_col=next_slab,
                slab_basis_col=slab_basis,
                condonation_col=by_metric.get(item.get("condonation") or ""),
                formula=item.get("formula", "percent"),
                requires_zero_cols=requires_zero,
                gsr_col=base,
                clear_cut_col=clear_cuts.get(item["name"]),
                alt_base_cols=tuple(sorted(set(volume_bases.values()) | set(gsrb_bases.values()))),
            )
        )
    return out


def _strip_prefix(name: str, prefixes: list[str]) -> str | None:
    for p in prefixes:
        if name.startswith(p):
            return name[len(p):].strip()
    return None


def discover(source, sheet_name: str = "Output") -> dict[str, SchemeConfig]:
    cells = read_headers(source, sheet_name)

    schemes: dict[str, list[HeaderCell]] = {}
    for c in cells:
        schemes.setdefault(c.scheme_name, []).append(c)

    configs: dict[str, SchemeConfig] = {}
    for scheme_name, block in schemes.items():
        by_metric = {c.metric: c.col for c in block}

        # base candidates: variant name -> (col, kind). Kept separately by kind so a
        # component can take its rate base from GSR while taking its slab basis from
        # the Volume column (Luxury: slab decided by litres, CN% applied to rupees).
        # Volume Q and GSR(Q) are both "quantity-ish" bases for formula calibration,
        # but only Volume Q is litres -- GSR(Q) is rupees. They are kept apart so the
        # UI can report Volume and GSR as two separate, correctly-united figures.
        volume_bases: dict[str, int] = {}
        gsrq_bases: dict[str, int] = {}
        gsrb_bases: dict[str, int] = {}
        for c in block:
            if c.metric.startswith("Volume Q "):
                volume_bases.setdefault(c.metric[len("Volume Q "):].strip(), c.col)
            elif c.metric.startswith("GSR(Q) "):
                gsrq_bases.setdefault(c.metric[len("GSR(Q) "):].strip(), c.col)
            elif c.metric.startswith(GSRB_PREFIX):
                gsrb_bases[c.metric[len(GSRB_PREFIX):].strip()] = c.col

        qty_bases: dict[str, int] = {**gsrq_bases, **volume_bases}

        bases: dict[str, tuple[int, str]] = {k: (v, "qty") for k, v in qty_bases.items()}
        for k, v in gsrb_bases.items():
            bases[k] = (v, "gsrb")  # gsrb wins over qty for the RATE base

        # rate candidates: variant -> col
        rates: dict[str, int] = {}
        for c in block:
            if c.metric.endswith(RATE_SUFFIX):
                variant = c.metric[: -len(RATE_SUFFIX)].strip()
                rates[variant] = c.col

        # next slab candidates -> (col, unit) where unit is "qty" ("Next Slab Qty ...")
        # or "value" ("Next Slab Value ..."). The unit tells us which column the slab
        # boundary must be measured against.
        next_slabs: dict[str, tuple[int, str]] = {}
        for c in block:
            if c.metric.startswith("Next Slab Qty "):
                next_slabs[c.metric[len("Next Slab Qty "):].strip()] = (c.col, "qty")
            elif c.metric.startswith("Next Slab Value "):
                next_slabs[c.metric[len("Next Slab Value "):].strip()] = (c.col, "value")

        # per-variant "Clear Cut" columns: the file's own computed CN for that
        # component. Used as ground truth to calibrate the formula.
        # " Clear Cut" is not always the end of the name -- August has
        # "GLSA ENML/SHADE 9A Clear Cut Per 20 L", where the pack qualifier trails
        # it. The variant is whatever precedes " Clear Cut".
        clear_cuts: dict[str, int] = {}
        for c in block:
            if " Clear Cut" in c.metric:
                variant = c.metric.split(" Clear Cut")[0].strip()
                if variant:
                    clear_cuts.setdefault(variant, c.col)

        # condonation amount candidates (per-variant, else bare fallback used once)
        cond_amounts: dict[str, int] = {}
        bare_cond_col: int | None = None
        for c in block:
            if c.metric.startswith(COND_AMOUNT_PREFIX):
                variant = c.metric[len(COND_AMOUNT_PREFIX):].strip()
                cond_amounts[variant] = c.col
            elif c.metric == COND_AMOUNT_BARE:
                bare_cond_col = c.col

        # total scheme CN column: last column of the block whose metric ends with " CN"
        # and has no further qualifying words matched to a specific sub-variant name
        total_col = None
        scheme_short = re.sub(r"[^A-Za-z0-9 ]", "", scheme_name).strip()
        for c in reversed(block):
            if c.metric.endswith(" CN") and not c.metric.endswith("Clear Cut"):
                total_col = c.col
                break
        if total_col is None:
            total_col = block[-1].col

        def find_base(variant: str, bases: dict = bases) -> tuple[int, str] | None:
            if variant in bases:
                return bases[variant]
            if "" in bases:
                return bases[""]
            # fuzzy: longest base-variant name that is a case-insensitive prefix
            # of the rate variant (e.g. base "Value" matches rate variant "VALUE FA")
            v_low = variant.lower()
            best: tuple[int, str] | None = None
            best_len = -1
            for bname, bval in bases.items():
                if bname and v_low.startswith(bname.lower()) and len(bname) > best_len:
                    best, best_len = bval, len(bname)
            return best

        def find_in(mapping: dict, variant: str):
            """Exact, then bare-variant, then longest case-insensitive prefix match."""
            if variant in mapping:
                return mapping[variant]
            if "" in mapping:
                return mapping[""]
            v_low = variant.lower()
            best, best_len = None, -1
            for name, val in mapping.items():
                if name and v_low.startswith(name.lower()) and len(name) > best_len:
                    best, best_len = val, len(name)
            return best

        components: list[Component] = []
        used_bare_cond = False
        for variant, rate_col in rates.items():
            base = find_base(variant)
            forced_fixed = False
            if base is None:
                # A rate with no base column of its own is a flat-amount line
                # (e.g. "Primer FA CN%", "VELVET TOUCH FA CN%"): the rate IS the
                # payout, so no base is needed. Borrow any base purely so the row
                # still has an achievement figure to sit against.
                fallback = next(iter(gsrb_bases.values()), None) or next(iter(qty_bases.values()), None)
                if fallback is None:
                    continue
                base, forced_fixed = (fallback, "gsrb"), True
            base_col, _kind = base

            pack_size = _parse_pack_size(variant)
            is_fixed = (
                forced_fixed or "fa" in variant.lower().split() or variant.upper().endswith("FA")
            )
            if is_fixed:
                formula = "fixed"
            elif pack_size is not None:
                # "... Per 40 L" -> flat amount per full pack: floor(volume/40) * rate.
                # Verified 100% exact against the file's own Clear Cut columns.
                formula = "per_pack"
            elif _kind == "gsrb":
                # base is a GSR(B) value column -> rate is a whole-number percent (verified
                # against Luxury's "Clear Cut" column: 155500.44 * 1 / 100 = 1555.00)
                formula = "percent"
            else:
                # base is a Volume Q / GSR(Q) qty column -> rate is a currency-per-unit amount
                formula = "per_unit"

            # per_pack rates are applied to the VOLUME column, never to GSR
            if formula == "per_pack":
                qty_col = find_in(qty_bases, variant)
                if qty_col is not None:
                    base_col = qty_col

            ns = find_in(next_slabs, variant)
            if ns is None:
                next_slab_col, ns_unit = base_col, None
            else:
                next_slab_col, ns_unit = ns

            # The slab boundary must be measured in the same unit as next_slab.
            slab_basis_col = base_col
            if ns_unit == "qty":
                slab_basis_col = find_in(qty_bases, variant) or base_col
            elif ns_unit == "value":
                slab_basis_col = find_in(gsrb_bases, variant) or base_col

            cond_col = cond_amounts.get(variant)
            if cond_col is None and not used_bare_cond and bare_cond_col is not None:
                cond_col = bare_cond_col
                used_bare_cond = True

            components.append(
                Component(
                    name=variant or scheme_short,
                    base_col=base_col,
                    rate_col=rate_col,
                    next_slab_col=next_slab_col,
                    slab_basis_col=slab_basis_col,
                    condonation_col=cond_col,
                    formula=formula,
                    pack_size=pack_size,
                    qty_col=find_in(qty_bases, variant),
                    gsrb_col=find_in(gsrb_bases, variant),
                    volume_col=find_in(volume_bases, variant),
                    gsr_col=find_in(gsrb_bases, variant) or find_in(gsrq_bases, variant),
                    # A flat FA line has no Clear Cut of its own; a prefix match would hand it the
                    # main line's ("TERRA 15 FA" -> "TERRA 15 Clear Cut").
                    clear_cut_col=clear_cuts.get(variant) if is_fixed else find_in(clear_cuts, variant),
                    alt_base_cols=tuple(sorted(set(qty_bases.values()) | set(gsrb_bases.values()))),
                )
            )

        # The payout the business reads is "Clear Cut" (before condonation).
        # Multi-component blocks carry a bare "Clear Cut"; Early Bird uses
        # "Clear Cut +Fixed CN"; single-component blocks only have "<X> Clear Cut".
        clear_cut_total = by_metric.get("Clear Cut") or by_metric.get("Clear Cut +Fixed CN")
        if clear_cut_total is None and len(clear_cuts) == 1:
            clear_cut_total = next(iter(clear_cuts.values()))

        override = OVERRIDES.get(scheme_name.strip())
        if override:
            resolved = _resolve_override(override, by_metric, volume_bases, gsrb_bases, clear_cuts)
            if resolved:
                components = resolved

        if not components:
            continue

        key = re.sub(r"[^a-z0-9]+", "_", scheme_name.lower()).strip("_")
        configs[key] = SchemeConfig(
            key=key,
            clear_cut_total_col=clear_cut_total,
            is_currency=is_currency_scheme(scheme_name),
            label=scheme_name,
            scheme_type="mixed",
            total_cn_col=total_col,
            components=components,
        )

    return configs
