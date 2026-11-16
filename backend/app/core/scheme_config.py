"""
Declarative mapping from raw dealer-level report columns to scheme semantics.

The raw file has a 2-row header (row0 = scheme/product group name, spanning
several columns; row1 = metric name for that column). Column indices below
are 0-based positions in that raw sheet, fixed for the "Output" sheet layout
used in the September 2026 grouped export.

Each scheme is made of one or more "components" (a scheme can bundle several
sub-variants, e.g. Primer = PAP + PBP + PDP + ...). Each component has its
own base metric (Volume or GSR), its own CN rate column, and its own
next-slab column, but they roll up into one scheme-level total CN column.

scheme_type:
  - "percent"   : CN = base_value (GSR) * CN%      (CN% is a fraction, e.g. 0.032)
  - "per_unit"  : CN = base_qty (Volume/GSR) * rate (rate is currency per litre/unit,
                  not a percentage, even though the raw column is labelled "CN%")
  - "fixed"     : CN is a flat amount per dealer, not scaled by a rate (rare; not
                  covered by the 3 scaffold schemes below)
"""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Component:
    """One payout line inside a scheme.

    Three different columns can be involved, and they are NOT interchangeable:
      base_col       - what the rate is applied to (GSR value, or Volume qty)
      slab_basis_col - what decides WHICH slab the dealer lands in. Must be in the
                       same unit as next_slab_col: "Next Slab Qty" pairs with a
                       Volume Q column, "Next Slab Value" pairs with a GSR column.
                       e.g. Luxury: slab is decided by litres, but CN% is applied
                       to GSR rupees -- mixing them produces nonsense boundaries.
      next_slab_col  - distance from current achievement to the next slab edge.

    formula:
      percent  -> CN = base * rate / 100        (rate is a whole-number percent)
      per_unit -> CN = base * rate              (rate is currency per litre/unit)
      per_pack -> CN = floor(base/pack_size) * rate   (flat amount per full pack;
                  verified 100% exact against the file's own Clear Cut columns)
      fixed    -> CN = rate                     (rate col already holds a flat amount)
    """

    name: str
    base_col: int
    rate_col: int
    next_slab_col: int | None  # None = scheme publishes no slab table for this line
    slab_basis_col: int | None = None  # defaults to base_col when units already match
    # Only include a dealer row when every one of these columns is zero. Used for
    # mutually exclusive payout paths -- Early Bird pays EITHER an accumulated
    # percentage OR a flat amount, never both.
    requires_zero_cols: tuple[int, ...] = ()
    condonation_col: int | None = None
    formula: str = "percent"
    pack_size: int | None = None
    # per_pack only: volume below this earns no packs, because the per-pack top-up
    # starts above a qualifying floor. Damp Guard pays flat up to 80L and then
    # a fixed amount per additional 40L, i.e. floor((volume - 80) / 40).
    pack_offset: float = 0.0

    # Candidates used by app/ingest/calibrate.py to pick base_col + formula from the
    # data rather than from column names. Column names in this export are unreliable:
    # "VALUE FA CN%" and "STAINERS CN%" both hold flat rupee amounts, not percentages.
    qty_col: int | None = None
    gsrb_col: int | None = None
    clear_cut_col: int | None = None  # the file's own CN for this component = ground truth
    # Every base column in the scheme block. A sub-variant's payout is sometimes
    # driven by the scheme's TOTAL volume rather than its own column -- Damp Guard's
    # per-40L top-up is computed off total Damp Guard volume, not the per-40 column.
    alt_base_cols: tuple[int, ...] = ()

    # Reporting columns, independent of whichever one the rate happens to use.
    # Volume is litres, GSR is rupees -- never the same number, so the dashboard
    # reports both rather than one ambiguous "achievement".
    volume_col: int | None = None
    gsr_col: int | None = None

    @property
    def slab_col(self) -> int:
        return self.slab_basis_col if self.slab_basis_col is not None else self.base_col

    @property
    def extra_cols(self) -> tuple[int, ...]:
        return self.requires_zero_cols


@dataclass(frozen=True)
class SchemeConfig:
    key: str
    label: str
    scheme_type: str        # "percent" | "per_unit" | "fixed"
    total_cn_col: int       # scheme-level total CN column (includes condonation)
    # The business reads CN off "Clear Cut" (payout before condonation), so this
    # is what reconciliation targets.
    clear_cut_total_col: int | None = None
    # False for GIFT schemes, whose Clear Cut counts gifts rather than rupees.
    is_currency: bool = True
    components: list[Component] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Overrides, declared by COLUMN NAME rather than position.
#
# Column positions differ every month (September's export is 673 columns wide,
# August's is 910), so anything hard-coded to an index breaks on the next file.
# Names are stable, so overrides are resolved against each file's own header.
#
# Only schemes the generic engine cannot infer need an entry here. Early Bird is
# the main one: EB1/EB2/EB3 are date-staged qualification windows that each
# contribute a RATE, and the single payout is the accumulated rate applied to the
# FULL MONTH GSR -- not to each window's own GSR. Verified on 100% of rows:
# "EB FULL MONTH CN%" == EB1+EB2+EB3, and the scheme's CN == its Clear Cut.
# The FULL MONTH column is deliberately not a component: it is the total.
#
# "optional" components are skipped when their columns are absent, which is how
# one spec covers both months: August publishes the flat amounts as
# "Total Fixed CN", September does not and they have to be read back off the
# Clear Cut column for dealers who earned no percentage at all.
# ---------------------------------------------------------------------------
# Scheme labels drift between months. Canonicalising them is what lets the same
# scheme be tracked across files:
#   "Hue Basic & Glow Max - Economy"   (Aug) == "Hue Basic & Glow Max"
#   "Coat Lite & Wall Neat - Sub Economy"  (Aug) == "Coat Lite & Wall Neat"
#   "Luxury (1-31Jul)"                       (Jul) == "Luxury"
SCHEME_ALIASES: dict[str, str] = {
    "hue basic & glow max - economy": "Hue Basic & Glow Max",
    "coat lite & wall neat - sub economy": "Coat Lite & Wall Neat",
    "slow dying thinner": "Slow Drying Thinner",
    # July splits Terra 15 into a % and a fixed-amount block under a different name.
    "texture scheme %": "Terra 15",
    "texture scheme fa": "Terra 15",

    # --- July automated export splits each scheme across several blocks -------
    # Mapped only for the shortlist schemes, which are the ones with clean,
    # unambiguous relations across all three months. The messier blocks
    # (Waterproofing splits, Shine On, the WP- duplicate spellings) are
    # deliberately left unmapped until confirmed, rather than guessed.
    "value sch %": "Value Slab",
    "value sch fa": "Value Slab",
    "tmbr value sch": "TMBR Value Slab",
    "eb slab 1": "Early Bird",
    "eb slab 2": "Early Bird",
    "eb slab 3": "Early Bird",
    "eb full month": "Early Bird",
    "tmbr eb1": "TMBR Early Bird",
    "tmbr eb2": "TMBR Early Bird",
    "tmbr eb3": "TMBR Early Bird",
    "tmbr full month": "TMBR Early Bird",
    "luxury %": "Luxury",
    "luxury fa": "Luxury",
    "premium 01": "Premium",
    "premium 02": "Premium",
    "addtnl premium": "Premium",
    "addtnl premium 02": "Premium",
    "primers pdp": "Primer", "primers pgs": "Primer", "primers pap": "Primer",
    "primers pjp": "Primer", "primers pbp": "Primer", "primer pgs": "Primer",
    "primers ss": "Primer", "primers pmp": "Primer",
    "addtnl primer": "Primer", "addtnl primer fa": "Primer",
    "glsa enml/shade 9a": "Enamel", "glsa enml/shade 9b": "Enamel",
    "addn glsa enml 1": "Enamel", "addn glsa enml 2": "Enamel",
    "glsa sml pack cn": "Enamel", "glsa sml per 100": "Enamel",
    "topguard gloss enml": "Topguard Gloss", "addn topguard": "Topguard Gloss",
}

# GIFT schemes pay in GIFTS, not rupees: their "Clear Cut" is a count of gifts
# earned off a per-litre calculation. Summing them into a payout total would add
# a non-currency unit to a money figure, so they are tracked separately.
NON_CURRENCY_PREFIXES = ("gift",)


def canonical_scheme_name(raw_name: str) -> str:
    """Strip the date-range suffix some exports carry, then apply aliases."""
    import re as _re

    name = _re.sub(r"\s*\((?:\d|1-31|1Apr|[A-Za-z]{3}).*?\)\s*$", "", str(raw_name)).strip()
    return SCHEME_ALIASES.get(name.lower(), name)


def is_currency_scheme(label: str) -> bool:
    return not label.strip().lower().startswith(NON_CURRENCY_PREFIXES)


OVERRIDES: dict[str, list[dict]] = {
    "Early Bird": [
        dict(name="EB 1", base="GSR(B) EB FULL MONTH", rate="EB 1 CN%",
             slab_basis="GSR(B) EB 1", next_slab="Next Slab Value EB 1",
             formula="percent", condonation="Condonation Amount"),
        dict(name="EB 2", base="GSR(B) EB FULL MONTH", rate="EB 2 CN%",
             slab_basis="GSR(B) EB 2", next_slab="Next Slab Value EB 2", formula="percent"),
        dict(name="EB 3", base="GSR(B) EB FULL MONTH", rate="EB 3 CN%",
             slab_basis="GSR(B) EB 3", next_slab="Next Slab Value EB 3", formula="percent"),
        # South has no full-month GSR (Oct'26): each window pays its own rate on its own GSR.
        # Verified on all 3,464 paid South dealers. Same names, so the slab tables stay one per window.
        dict(name="EB 1", base="GSR(B) EB 1", rate="EB 1 CN%",
             slab_basis="GSR(B) EB 1", next_slab="Next Slab Value EB 1", formula="percent",
             requires_zero=["GSR(B) EB FULL MONTH"], optional=True),
        dict(name="EB 2", base="GSR(B) EB 2", rate="EB 2 CN%",
             slab_basis="GSR(B) EB 2", next_slab="Next Slab Value EB 2", formula="percent",
             requires_zero=["GSR(B) EB FULL MONTH"], optional=True),
        dict(name="EB 3", base="GSR(B) EB 3", rate="EB 3 CN%",
             slab_basis="GSR(B) EB 3", next_slab="Next Slab Value EB 3", formula="percent",
             requires_zero=["GSR(B) EB FULL MONTH"], optional=True),
        # August: flat amounts are published outright.
        dict(name="EB Fixed CN", base="GSR(B) EB FULL MONTH", rate="Total Fixed CN",
             slab_basis="GSR(B) EB FULL MONTH", next_slab=None, formula="fixed",
             optional=True),
        # September: they are not, so recover them from Clear Cut for the dealers
        # who earned no percentage. Skipped when "Total Fixed CN" exists.
        dict(name="EB Flat Amount", base="GSR(B) EB FULL MONTH",
             rate="Clear Cut EB FULL MONTH", slab_basis="GSR(B) EB FULL MONTH",
             next_slab=None, formula="fixed",
             requires_zero=["EB 1 CN%", "EB 2 CN%", "EB 3 CN%"],
             skip_if_present="Total Fixed CN", optional=True),
    ],
    "TMBR Early Bird": [
        dict(name="TMBR EB1", base="GSR(B) TMBR EB FULL MONTH", rate="TMBR EB1 CN%",
             slab_basis="GSR(B) TMBR EB1", next_slab="Next Slab Value TMBR EB1",
             formula="percent", condonation="Condonation Amount"),
        dict(name="TMBR EB2", base="GSR(B) TMBR EB FULL MONTH", rate="TMBR EB2 CN%",
             slab_basis="GSR(B) TMBR EB2", next_slab="Next Slab Value TMBR EB2",
             formula="percent"),
        dict(name="TMBR EB3", base="GSR(B) TMBR EB FULL MONTH", rate="TMBR EB3 CN%",
             slab_basis="GSR(B) TMBR EB3", next_slab="Next Slab Value TMBR EB3",
             formula="percent"),
        dict(name="TMBR EB Flat Amount", base="GSR(B) TMBR EB FULL MONTH",
             rate="Clear Cut TMBR EB FULL MONTH", slab_basis="GSR(B) TMBR EB FULL MONTH",
             next_slab=None, formula="fixed",
             requires_zero=["TMBR EB1 CN%", "TMBR EB2 CN%", "TMBR EB3 CN%"],
             optional=True),
    ],
}


# Columns shared by every row, used for filtering.
DIMENSION_COLS = {
    "zone": 0,
    "region": 1,
    "depot_code": 2,
    "customer_code": 3,
    "customer_name": 4,
}
