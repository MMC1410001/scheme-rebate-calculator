"""
Reading slab structure out of a "CN working" book.

These files settle the month, and until now the app could only read totals from
them -- so the Simulator ran on an automated export instead, and the Overview
showed a day-25 part month next to a settled full month with nothing to tell
them apart. The slab columns were there the whole time: September's working file
carries 69 "Next Slab" columns.

The layout differs from the automated exports in one important way. There, a
block is a run of columns belonging to ONE component, ten metrics wide. Here, a
block is a whole scheme and its columns are grouped BY METRIC, with the component
named inside each one:

    Volume Q PREMIUM 01 | Volume Q PREMIUM 02 | GSR(B) PREMIUM 01 | ...
    PREMIUM 01 CN% | PREMIUM 02 CN% | PREMIUM 01 Clear Cut | ...
    Next Slab Qty PREMIUM 01 | Next Slab Qty PREMIUM 02 | Clear Cut | Premium CN

So components are recovered by stripping the metric name and keying on what is
left. Not every component gets every metric -- the per-litre adders carry volume,
a rate and a clear cut but no GSR and no slab table, because they are top-ups on
a parent scheme rather than slabbed lines of their own.

Everything after discovery is shared with the automated path: the same
calibration against each component's own Clear Cut column decides the formula,
and the same engine derives cn_units and the slab edges.
"""
from __future__ import annotations

import re

from app.core.scheme_config import Component, SchemeConfig, canonical_scheme_name, is_currency_scheme
from app.ingest.parse_working import DIM_HEADERS, _norm, _read_head, detect_layout

# Metric name -> role. Prefixes are stripped from the FRONT and whatever remains
# is the component; suffixes are stripped from the END. Order matters: the
# longest, most specific pattern has to win, or "Short Fall %" is read as
# "Short Fall" with a component called "%".
PREFIX_ROLES: tuple[tuple[str, str], ...] = (
    ("next slab qty", "next_slab_qty"),
    ("next slab value", "next_slab_value"),
    ("next slab", "next_slab_value"),
    ("volume q", "volume"),
    ("volume a q", "volume"),
    ("volume b q", "volume"),
    ("gsr(b)", "gsr"),
    ("gsr b", "gsr"),
    ("gsr(q)", "qty"),
    ("gsr q", "qty"),
    ("short fall %", "_skip"),
    ("short fall", "_skip"),
    ("condonation slab", "_skip"),
    ("condonation amount", "condonation"),
    ("adhoc condonation", "_skip"),
    ("total cn", "_skip"),
    ("clear cut", "clear_cut"),      # "Clear Cut TMBR EB FULL MONTH"
)
SUFFIX_ROLES: tuple[tuple[str, str], ...] = (
    (" clear cut", "clear_cut"),
    (" cn%", "rate"),
    (" cnpercent", "rate"),
)

# Blocks that roll up other blocks rather than paying anything themselves.
SKIP_BLOCKS = {
    "tdl cn", "cn amount", "total cn", "grand total", "cn working", "total",
    "sept26 scheme working", "scheme working",
}


def _split(metric: str) -> tuple[str | None, str]:
    """A metric name -> (role, component). Component "" means the block roll-up."""
    m = _norm(metric)
    low = m.lower()
    for suffix, role in SUFFIX_ROLES:
        if low.endswith(suffix):
            return role, m[: -len(suffix)].strip()
    for prefix, role in PREFIX_ROLES:
        if low == prefix:
            return role, ""                      # bare "Clear Cut" = whole block
        if low.startswith(prefix + " "):
            return role, m[len(prefix):].strip()
    return None, m


def discover_working(source, sheet: str | None = None):
    """-> ({scheme_key: SchemeConfig}, {dimension: column})."""
    layout = detect_layout(source, sheet)
    head = _read_head(source, sheet, layout["data_start"])
    metrics = [_norm(c) for c in head[layout["metric_row"]]]
    groups = (
        [_norm(c) for c in head[layout["group_row"]]]
        if layout["group_row"] is not None else [""] * len(metrics)
    )

    dims: dict[str, int] = {}
    for j, m in enumerate(metrics):
        key = DIM_HEADERS.get(m.lower())
        if key and key not in dims:
            dims[key] = j

    # columns, grouped by the block they sit under
    blocks: dict[str, list[tuple[int, str]]] = {}
    current = ""
    for j, m in enumerate(metrics):
        if j < len(groups) and groups[j]:
            current = groups[j]
        if not current or m.lower() in DIM_HEADERS:
            continue
        blocks.setdefault(current, []).append((j, m))

    configs: dict[str, SchemeConfig] = {}
    for block, cols in blocks.items():
        if block.strip().lower() in SKIP_BLOCKS:
            continue

        comps: dict[str, dict[str, int]] = {}
        block_roles: dict[str, int] = {}
        for j, metric in cols:
            role, name = _split(metric)
            if role is None or role == "_skip":
                continue
            if not name:
                block_roles.setdefault(role, j)
                continue
            # A component name can repeat inside a block (Luxury lists "Lux
            # Interior Per Litre" twice). Keying on the name alone would make the
            # second overwrite the first, so a repeat that already has this role
            # becomes its own component.
            key = name
            if key in comps and role in comps[key]:
                n = 2
                while f"{name} ({n})" in comps:
                    n += 1
                key = f"{name} ({n})"
            comps.setdefault(key, {})[role] = j

        label = canonical_scheme_name(block)
        scheme_key = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")

        components: list[Component] = []
        for name, roles in comps.items():
            rate = roles.get("rate")
            clear_cut = roles.get("clear_cut")
            if rate is None or clear_cut is None:
                continue  # not a payout line: no rate to apply, or nothing paid

            gsr, qty, vol = roles.get("gsr"), roles.get("qty"), roles.get("volume")
            # The rate is applied to rupees when the component publishes them,
            # and to litres otherwise -- calibration confirms which against the
            # component's own Clear Cut, so a wrong guess here is corrected.
            base = gsr if gsr is not None else (qty if qty is not None else vol)
            if base is None:
                continue

            # A slab basis MUST be in the same unit as its next-slab column.
            # "Next Slab Qty" counts litres, "Next Slab Value" counts rupees;
            # pairing them the wrong way round produces boundaries that are
            # arithmetic on two different scales.
            next_qty, next_val = roles.get("next_slab_qty"), roles.get("next_slab_value")
            if next_qty is not None:
                next_slab, slab_basis = next_qty, (vol if vol is not None else base)
            elif next_val is not None:
                next_slab = next_val
                slab_basis = gsr if gsr is not None else (qty if qty is not None else base)
            else:
                next_slab, slab_basis = None, base

            components.append(Component(
                name=name,
                base_col=base,
                rate_col=rate,
                next_slab_col=next_slab,
                slab_basis_col=slab_basis,
                condonation_col=roles.get("condonation", block_roles.get("condonation")),
                clear_cut_col=clear_cut,
                gsr_col=gsr,
                volume_col=vol,
                qty_col=qty if qty is not None else vol,
                gsrb_col=gsr,
                alt_base_cols=tuple(v for v in (gsr, qty, vol) if v is not None),
                formula="percent",  # replaced by calibration against Clear Cut
            ))

        if not components:
            continue

        total_col = block_roles.get("clear_cut", components[0].clear_cut_col)
        configs[scheme_key] = SchemeConfig(
            key=scheme_key,
            label=label,
            scheme_type="mixed",
            total_cn_col=total_col,
            clear_cut_total_col=total_col,
            is_currency=is_currency_scheme(label),
            components=components,
        )

    return configs, dims
