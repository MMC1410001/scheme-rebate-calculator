"""
Parses the daily wide dealer-level xlsx export into a tidy long-format table:
one row per (dealer, scheme, component) with base qty/value, cn rate, next
slab, and condonation amount. Caches the result as parquet next to the
source file so repeated runs (dev, API calls) don't re-parse 27k rows x
650+ cols every time.

Uses the `calamine` engine (Rust-based xlsx reader) instead of openpyxl --
openpyxl's pure-Python XML parsing took 2-3+ minutes cold on this file;
calamine reads the same columns in a few seconds. Column extraction and
per-component filtering are vectorized with pandas instead of a per-row
Python loop, which was the other big cost (~275k row*component iterations).
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import pandas as pd

from app.core.scheme_config import DIMENSION_COLS, SchemeConfig
from app.ingest.calibrate import calibrate

# Bump whenever scheme mapping, aliases or payout logic change. Without it a
# stale parquet keeps serving labels from the previous config, which silently
# breaks cross-month comparison: an aliased scheme shows up under both its old
# and new name and reads as "-100% in one, brand new in the other".
CONFIG_VERSION = 15


def _cache_path(source: Path, suffix: str = "") -> Path:
    digest = hashlib.sha1(str(source.resolve()).encode()).hexdigest()[:10]
    return source.with_suffix(f".{digest}.v{CONFIG_VERSION}{suffix}.parquet")


def _needed_columns(schemes: dict[str, SchemeConfig], dimension_cols: dict[str, int]) -> list[int]:
    cols: set[int] = set(dimension_cols.values())
    for scheme in schemes.values():
        cols.add(scheme.total_cn_col)
        if scheme.clear_cut_total_col is not None:
            cols.add(scheme.clear_cut_total_col)
        for comp in scheme.components:
            cols.update([comp.base_col, comp.rate_col, comp.slab_col])
            cols.update(comp.requires_zero_cols)
            cols.update(comp.alt_base_cols)
            for optional in (comp.volume_col, comp.gsr_col):
                if optional is not None:
                    cols.add(optional)
            for optional in (comp.next_slab_col, comp.condonation_col, comp.qty_col,
                             comp.gsrb_col, comp.clear_cut_col):
                if optional is not None:
                    cols.add(optional)
    return sorted(cols)


def _whole_codes(df: pd.DataFrame) -> pd.DataFrame:
    """Dealer codes as int64 when every code is a whole number. Some extracts store them as floats (Nov'26 with
    condonation: 6100012744.0), which the database's bigint refuses and dealer lists would show with ".0"."""
    codes = df.get("customer_code")
    if codes is not None and codes.dtype.kind == "f" and codes.notna().all() and (codes % 1 == 0).all():
        df["customer_code"] = codes.astype("int64")
    return df


def parse_raw_file(
    source: Path,
    schemes: dict[str, SchemeConfig],
    sheet_name: str = "Output",
    force: bool = False,
    dimension_cols: dict[str, int] | None = None,
    total_gsr_cols: list[int] | None = None,
    od_col: int | None = None,
) -> pd.DataFrame:
    """Returns a tidy DataFrame with columns:
    zone, region, depot_code, customer_code, customer_name,
    scheme, scheme_label, component, formula, base_value, cn_rate,
    current_cn, next_slab, condonation_amount, scheme_cn
    """
    # cache key includes scheme count so adding/discovering more schemes invalidates it
    cache = _cache_path(source, suffix=f".s{len(schemes)}")

    if cache.exists() and not force:
        return _whole_codes(pd.read_parquet(cache))

    dimension_cols = dimension_cols or DIMENSION_COLS
    cols = _needed_columns(schemes, dimension_cols)
    cols = sorted(set(cols) | set(total_gsr_cols or []) | ({od_col} if od_col is not None else set()))
    raw = pd.read_excel(
        source,
        sheet_name=sheet_name,
        header=None,
        skiprows=2,  # 2-row header
        usecols=cols,
        names=cols,
        engine="calamine",
    )
    raw = raw[raw[dimension_cols["customer_code"]].notna()]

    # Resolve each component's real formula against the file's own Clear Cut columns
    # before computing anything -- column names alone are not reliable here.
    schemes, calib_report = calibrate(raw, schemes)
    calib_report.to_parquet(_cache_path(source, suffix=f".s{len(schemes)}.calib"), index=False)

    dims = raw[list(dimension_cols.values())].copy()
    dims.columns = list(dimension_cols.keys())
    # Layouts that carry only a customer code still need the geography columns to
    # exist; they are filled by joining a month that has them.
    for missing in ("zone", "region", "depot_code", "customer_name"):
        if missing not in dims.columns:
            dims[missing] = None
    # Depot codes stored as decimals (the manual November file) read as float; dealer codes: _whole_codes.
    depot = dims["depot_code"]
    if depot.dtype.kind == "f" and depot.notna().all() and (depot % 1 == 0).all():
        dims["depot_code"] = depot.astype("int64")

    # The dealer's whole book: main full-month GSR + Timbra full-month GSR.
    # Repeated on every row of that dealer, so a scope total is a de-duplicated sum.
    if total_gsr_cols:
        dims["total_gsr"] = sum(raw[c].fillna(0) for c in total_gsr_cols)
    else:
        dims["total_gsr"] = 0.0

    # An overdue dealer earns but is not paid, so settlement needs this flag.
    # Not every export carries it: the automated GCS files do not, which means a
    # settled figure cannot be produced from them alone.
    dims["od_blocked"] = (
        raw[od_col].astype(str).str.strip().str.upper().eq("Y")
        if od_col is not None else False
    )

    parts: list[pd.DataFrame] = []
    for scheme in schemes.values():
        # Payout of components with no Clear Cut of their own (flat FA lines, Early Bird), so the
        # residual below does not count it a second time.
        unclaimed = pd.Series(0.0, index=raw.index)
        unclaimed_parts: list[pd.DataFrame] = []   # their rows, to take the file's payout share below
        # In a scheme that has a GSR column, a component with none of its own is an add-on on the same sales
        # (Luxury's "Lux Exterior Per 50 L", "Addn Vivid Life 40", Primer FA, Premium's "Per 100 L"): its litres are
        # already in the main product column, as its rupees are in the main GSR. Adding them showed Luxury at
        # 3,571 kL against the file's 1,914 kL (Nov'26 v5). They keep their litres for their own slab table, with
        # vol_src -1 so no scheme or product total counts them.
        scheme_has_gsr = any(c.gsr_col is not None for c in scheme.components)
        for comp in scheme.components:
            base_value = raw[comp.base_col].fillna(0)
            rate_value = raw[comp.rate_col].fillna(0)

            # cn_units is the linear multiplier on the rate: CN = cn_units * rate.
            # Expressing every formula this way means the what-if simulation is the
            # same single multiplication for all scheme types, in both backend and UI.
            if comp.formula == "qualifier":
                # Sets a rate but pays nothing itself; kept so its slabs are still
                # visible, with no payout attached.
                mask = base_value != 0
                cn_units = pd.Series(0.0, index=raw.index)
            elif comp.formula == "fixed":
                mask = rate_value != 0
                cn_units = pd.Series(1.0, index=raw.index)
            elif comp.formula == "percent":
                # CN% columns store whole-number percentages (e.g. 1 means 1%),
                # verified against the raw file's own "Clear Cut" column for
                # Luxury (155500.44 * 1 / 100 = 1555.00, matches exactly).
                mask = base_value != 0
                cn_units = base_value / 100
            elif comp.formula == "per_pack":
                # flat amount per FULL pack above the qualifying floor;
                # partial packs earn nothing
                mask = base_value != 0
                eligible = (base_value - comp.pack_offset).clip(lower=0)
                cn_units = (eligible // (comp.pack_size or 1)).astype(float)
            else:  # per_unit: rate is a currency-per-unit amount, not a percentage
                mask = base_value != 0
                cn_units = base_value
            current_cn = cn_units * rate_value

            # Where the file publishes this component's OWN Clear Cut, that is
            # the truth and the derived formula is not. Calibration resolves
            # cleanly on the automated exports, but the working book has blocks
            # it cannot fit -- EMLSN ADDN/100 pays a few hundred dealers a few lakh in
            # total, and a per-litre fit applied to every dealer holding
            # volume reported crores, two thirds of the month out of one
            # block.
            #
            # So cn_units is RE-DERIVED from the published payout: clear cut
            # divided by the rate that earned it. That keeps the one property
            # the simulator depends on -- CN = cn_units x rate -- while making
            # the current state exactly what the business settled. A dealer who
            # earned nothing gets zero units, so raising a rate cannot start
            # paying someone who never qualified.
            if comp.clear_cut_col is not None and comp.clear_cut_col in raw.columns:
                truth = raw[comp.clear_cut_col].fillna(0).astype(float)
                payable = rate_value != 0
                cn_units = cn_units.where(~payable, truth.div(rate_value.where(payable, 1.0)))
                cn_units = cn_units.where(payable | (truth == 0), 0.0)
                current_cn = truth

            # Mutually exclusive payout paths (e.g. Early Bird: accumulated % OR flat)
            for zero_col in comp.requires_zero_cols:
                mask &= raw[zero_col].fillna(0) == 0

            own_clear_cut = comp.clear_cut_col is not None and comp.clear_cut_col in raw.columns
            if not own_clear_cut:
                unclaimed += current_cn.where(mask, 0.0).astype(float)

            if not mask.any():
                continue

            part = dims[mask].copy()
            part["scheme"] = scheme.key
            part["scheme_label"] = scheme.label
            part["component"] = comp.name
            part["formula"] = comp.formula
            part["pack_size"] = comp.pack_size or 0
            part["base_value"] = base_value[mask]
            part["cn_rate"] = rate_value[mask]
            part["cn_units"] = cn_units[mask]
            part["current_cn"] = current_cn[mask]
            # Reported separately and in their own units: litres vs rupees.
            part["volume"] = (
                raw.loc[mask, comp.volume_col].fillna(0) if comp.volume_col is not None else 0.0
            )
            part["gsr"] = (
                raw.loc[mask, comp.gsr_col].fillna(0) if comp.gsr_col is not None else 0.0
            )
            # WHICH column the GSR came from, so a scheme's GSR can be totalled
            # without double counting. Early Bird runs EB1/EB2/EB3 as three time
            # WINDOWS over one full-month base -- all three read column 54 and
            # report the identical figure, so summing the components gave
            # about three times the real book. Premium is the opposite
            # case: its components read different columns because they are
            # genuinely different products, and those must still add up. The
            # source column distinguishes the two exactly.
            part["gsr_src"] = -1 if comp.gsr_col is None else int(comp.gsr_col)
            # Same idea for litres: Terra 15 reads one volume column from two
            # components, so summing components would count those litres twice.
            part["vol_src"] = (-1 if comp.volume_col is None or (scheme_has_gsr and comp.gsr_col is None)
                               else int(comp.volume_col))
            part["slab_basis"] = raw.loc[mask, comp.slab_col].fillna(0)
            part["next_slab"] = (
                raw.loc[mask, comp.next_slab_col].fillna(0) if comp.next_slab_col is not None else 0.0
            )
            part["condonation_amount"] = (
                raw.loc[mask, comp.condonation_col].fillna(0) if comp.condonation_col is not None else 0.0
            )
            part["scheme_cn"] = raw.loc[mask, scheme.total_cn_col].fillna(0)
            cond_part = (
                raw.loc[mask, comp.condonation_col].fillna(0)
                if comp.condonation_col is not None else 0.0
            )
            part["settled_cn"] = (current_cn[mask] + cond_part).where(
                ~part["od_blocked"].to_numpy(), 0.0
            )
            # The component's own Clear Cut: per-row ground truth, which lets
            # reconciliation compare like with like even when several blocks roll
            # up into one scheme.
            part["component_clear_cut"] = (
                raw.loc[mask, comp.clear_cut_col].fillna(0)
                if comp.clear_cut_col is not None else float("nan")
            )
            # "Clear Cut" = payout before condonation; this is the figure the
            # business treats as the CN, so reconciliation targets it.
            part["clear_cut_total"] = (
                raw.loc[mask, scheme.clear_cut_total_col].fillna(0)
                if scheme.clear_cut_total_col is not None else float("nan")
            )
            parts.append(part)
            if not own_clear_cut:
                unclaimed_parts.append(part)

        # Whatever the block paid that no component claimed.
        #
        # A component is only taken when it publishes its own Clear Cut, because
        # a rate alone cannot be trusted to reproduce a payout. But some lines
        # have a rate and no Clear Cut of their own -- Value Slab's VALUE FA is
        # a flat amount per dealer whose money lands only in the block roll-up --
        # so dropping them silently loses real payout: Value Slab reported
        # a fraction of what the file pays.
        #
        # Rather than guess their formula, the gap between the block's own total
        # and the components that did resolve is carried as one residual line.
        # It is published money, attributed to the scheme but to no component,
        # and it is visible as such rather than quietly missing. cn_units is 0:
        # with no rate column behind it there is nothing a rate edit could
        # legitimately scale.
        # Each column once: two components can read the same Clear Cut.
        claimed = list(dict.fromkeys(c.clear_cut_col for c in scheme.components
                                     if c.clear_cut_col is not None and c.clear_cut_col in raw.columns))
        total_col = scheme.clear_cut_total_col
        # Also for blocks whose components publish no Clear Cut (Early Bird), so money they miss shows up here.
        if total_col is not None and total_col in raw.columns:
            if total_col not in claimed:          # a roll-up distinct from its parts
                total = raw[total_col].fillna(0).astype(float)
                paid = total - sum((raw[c].fillna(0).astype(float) for c in claimed), 0.0)
                # Where the block pays a dealer LESS than rate x base on these components, that share is the
                # file's own payout and goes into cn_units, as a Clear Cut does above: Nov'26 v5 pays Early Bird at
                # exactly 50% in a few regions (about two thousand dealers), and pricing them in full
                # put crores too much on EB 1-3 and the same amount negative on "Other", which no edit could move. An untouched
                # row then reproduces the file and a rate edit keeps the share. Paying more than rate x base, or
                # nothing, stays in the residual: there is no rate behind that money.
                share = paid / unclaimed.where(unclaimed > 0)
                share = share.where((share > 0) & (share < 1))
                if share.notna().any():
                    for part in unclaimed_parts:
                        s = share.reindex(part.index)
                        hit = s.notna()
                        if hit.any():
                            cut = part.loc[hit, "current_cn"] * (1 - s[hit])   # condonation is not scaled
                            part.loc[hit, "cn_units"] = part.loc[hit, "cn_units"] * s[hit]
                            part.loc[hit, "current_cn"] = part.loc[hit, "current_cn"] - cut
                            paid_out = hit & ~part["od_blocked"].astype(bool)
                            part.loc[paid_out, "settled_cn"] = part.loc[paid_out, "settled_cn"] - cut[paid_out[hit]]
                    unclaimed = unclaimed * share.fillna(1.0)
                residual = paid - unclaimed
                rmask = residual.abs() > 0.005
                if rmask.any():
                    rpart = dims[rmask].copy()
                    rpart["scheme"] = scheme.key
                    rpart["scheme_label"] = scheme.label
                    rpart["component"] = "Other (unattributed)"
                    rpart["formula"] = "fixed"
                    rpart["pack_size"] = 0
                    rpart["is_currency"] = scheme.is_currency
                    rpart["volume"] = 0.0
                    rpart["gsr"] = 0.0
                    rpart["gsr_src"] = -1
                    rpart["vol_src"] = -1
                    rpart["slab_basis"] = 0.0
                    rpart["next_slab"] = 0.0
                    rpart["cn_rate"] = 0.0
                    rpart["cn_units"] = 0.0
                    rpart["current_cn"] = residual[rmask]
                    rpart["condonation_amount"] = 0.0
                    rpart["scheme_cn"] = residual[rmask]
                    rpart["component_clear_cut"] = residual[rmask]
                    rpart["clear_cut_total"] = total[rmask]
                    rpart["settled_cn"] = (
                        residual[rmask].where(~rpart["od_blocked"].to_numpy(), 0.0)
                        if "od_blocked" in rpart else residual[rmask]
                    )
                    parts.append(rpart)

    df = _whole_codes(pd.concat(parts, ignore_index=True))
    df.to_parquet(cache, index=False)
    return df
