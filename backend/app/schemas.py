"""Request bodies of the API. Every list and text has a limit, so one request cannot exhaust the server; a value
that cannot be right is refused with its reason (BR-023), never turned into numbers."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator, model_validator


class Body(BaseModel):
    """Every request body. NaN and Infinity are refused: Python's JSON reader accepts them, they pass every ge / le
    check, and they either break the answer (a 500) or drop a row from a total without a word."""
    model_config = ConfigDict(allow_inf_nan=False)

# One value or several (at most 500, as on the GET routes); spaces around a value are ignored, repeats count once.
Selection = list[str] | str | None


class Scope(Body):
    """The filters a request is for. Each takes one value or several; empty means all."""
    zone: Selection = None
    region: Selection = None
    depot_code: Selection = None

    @field_validator("zone", "region", "depot_code")
    @classmethod
    def _limit(cls, v):
        if isinstance(v, list):
            if len(v) > 500:
                raise ValueError("at most 500 values per filter")
            v = list(dict.fromkeys(s.strip() for s in v if s and s.strip()))
        elif isinstance(v, str):
            if len(v) > 200:
                raise ValueError("a filter value is at most 200 characters")
            v = v.strip()
        return v

    def scope(self) -> tuple:
        from app.core.scope import scope_key
        return scope_key(self.zone, self.region, self.depot_code)


# ---- What-if edits of GSR and volume (app/core/scenario.py) ---------------------------------------------------------

class AdjustmentIn(Body):
    scope_kind: Literal["all", "zone", "region", "depot", "dealer"] = "all"
    # Several values as "A|B". A slab edit names the slab's dealers (scope_kind dealer), so up to ~40k codes.
    scope_value: str = Field("", max_length=500_000)
    product: str = Field("*", max_length=100)       # a product (modes A, P, Q, R), a scheme key (S, C) or "*" (B, R)
    metric: Literal["gsr", "volume"] = "gsr"
    # B total, P one product, A mix (total held), S one scheme, Q one product's price, R one product's CN % or CN
    # (product "*": every rate, the total's CN), C one scheme's CN
    mode: Literal["A", "B", "C", "P", "Q", "R", "S"] = "B"
    adjust_type: Literal["delta", "pct", "share"] = "pct"
    value: float = Field(ge=-1e12, le=1e12)
    reason: str | None = Field(None, max_length=500)

    @model_validator(mode="after")
    def _valid(self):
        from app.core.scenario import check_adjustment

        values = sorted({v.strip() for v in self.scope_value.split("|") if v.strip()})
        self.scope_value = "" if self.scope_kind == "all" else "|".join(values)
        problem = check_adjustment(self.model_dump())
        if problem:
            raise ValueError(problem)
        return self


# A Mix edit (adjust_type share) is solved by search, ~0.5 s each on a full month, inside one of the two heavy-build
# slots; 500 of them held a slot for minutes and made every other user's edits answer "busy". The web app makes one
# per product and filter, far fewer than this.
MAX_SHARE_EDITS = 40


def _few_share_edits(edits: list[AdjustmentIn]) -> list[AdjustmentIn]:
    if sum(e.adjust_type == "share" for e in edits) > MAX_SHARE_EDITS:
        raise ValueError(f"at most {MAX_SHARE_EDITS} product mix edits at a time; undo some and try again")
    return edits


Adjustments = Annotated[list[AdjustmentIn], AfterValidator(_few_share_edits)]


def _adjustments():
    return Field(default_factory=list, max_length=500)


class Edits(Body):
    """GSR / volume edits: the current month's (they carry into next month) and next month's own."""
    adjustments: Adjustments = _adjustments()
    next_adjustments: Adjustments = _adjustments()


# ---- Slab tables --------------------------------------------------------------------------------------------------

class RateOverride(Body):
    band: int = Field(ge=0)      # position of the band in `edges`
    rate: float                  # the rate the row pays before the edit
    new_rate: float = Field(ge=0)


class SlabLayout(Body):
    """A slab table: boundaries, and how each band is priced (see slab_engine.assign_dealers).

    Either `rates` (one per band: a single rate card for the scope) or `sources` (one per band: the original band
    it comes from, [lower, upper or null]; each dealer keeps their region's card), plus optional rate edits.
    """
    edges: list[float] = Field(max_length=200)
    rates: list[float] | None = Field(None, max_length=201)
    sources: list[tuple[float, float | None]] | None = Field(None, max_length=201)
    rate_overrides: list[RateOverride] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def _valid_structure(self):
        bands = len(self.edges) + 1
        if self.rates is None and self.sources is None:
            raise ValueError("give either rates (one per band) or sources (one per band)")
        if self.rates is not None and len(self.rates) != bands:
            raise ValueError(f"rates must have one value per band: {bands} for "
                             f"{len(self.edges)} boundaries, got {len(self.rates)}")
        if self.sources is not None and len(self.sources) != bands:
            raise ValueError(f"sources must have one band per band: {bands} for "
                             f"{len(self.edges)} boundaries, got {len(self.sources)}")
        if any(b <= a for a, b in zip(self.edges, self.edges[1:], strict=False)):
            raise ValueError("slab boundaries must be in ascending order, each above the one before")
        if any(r < 0 for r in self.rates or []):
            raise ValueError("a rate cannot be negative")
        if any(o.band >= bands for o in self.rate_overrides):
            raise ValueError("a rate edit names a band the table does not have")
        return self

    def engine_args(self) -> dict:
        return {"edges": self.edges, "rates": self.rates, "sources": self.sources,
                "rate_overrides": [o.model_dump() for o in self.rate_overrides]}


Layouts = dict[str, SlabLayout]


class AdjustedSlabsRequest(Scope):
    adjustments: Adjustments = _adjustments()
    scheme: str | None = Field(None, max_length=100)   # one scheme only (a scheme's Reset)


class SimulateRequest(Scope):
    scheme: str = Field(max_length=100)
    overrides: dict[str, float] = Field(default_factory=dict, max_length=2000)

    @model_validator(mode="after")
    def _rates_not_negative(self):
        bad = [k for k, v in self.overrides.items() if v < 0]
        if bad:
            raise ValueError(f"a rate cannot be negative (row {bad[0]})")
        return self


class SlabSimRequest(SlabLayout, Scope):
    scheme: str = Field(max_length=100)
    component: str = Field(max_length=200)
    adjustments: Adjustments = _adjustments()


class GrowthRequest(Scope):
    # Above -100%: at -100% nothing is sold, and the payout rate of nothing is undefined (it was a 500).
    growth_pct: float = Field(0.0, gt=-100, le=10_000)   # finite: 1e300 overflowed to inf (a 500)
    per_scheme: dict[str, float] | None = Field(None, max_length=200)   # scheme key -> growth %, over the default
    # scheme key -> simulated CN / current CN, from rates edited in the Simulator
    rate_multipliers: dict[str, float] | None = Field(None, max_length=200)

    @model_validator(mode="after")
    def _valid_values(self):
        if any(v <= -100 or v > 10_000 for v in (self.per_scheme or {}).values()):
            raise ValueError("a scheme's growth must be above -100% and at most 10,000%")
        if any(v < 0 or v > 1000 for v in (self.rate_multipliers or {}).values()):
            raise ValueError("a rate multiplier must be between 0 and 1000")
        return self


# ---- Dealer list --------------------------------------------------------------------------------------------------

class DealerRow(Body):
    """The slab row the user clicked, as served by /slabs, /all-slabs or /simulate-slabs."""
    slab_mode: str = Field(max_length=20)
    slab_lower: float | None = None
    slab_upper: float | None = None
    cn_rate: float = 0.0
    slab_index: int | None = None


class DealersRequest(Scope, Edits):
    scheme: str = Field(max_length=100)
    component: str = Field(max_length=200)
    row: DealerRow
    # The table the row belongs to, when the user has moved boundaries; omitted for the table as served.
    layout: SlabLayout | None = None
    q: str = Field("", max_length=100)       # dealer code or name
    # Only every dealer code of the row, no paging: a slab's Volume / GSR edit is scoped to these dealers.
    codes_only: bool = False
    # With codes_only: every dealer of the component in the scope, not only the row's (a slab's Mix edit).
    whole_component: bool = False
    page: int = Field(1, ge=1)
    page_size: int = Field(50, ge=1, le=200)
    # "previous" (as settled, its own edges), "next" (the live month grown by volume_growth_pct, under `layout` or
    # else the served table). "current" is the live month.
    month: Literal["previous", "current", "next"] = "current"
    volume_growth_pct: float = Field(0.0, gt=-100, le=500)


# ---- Export -------------------------------------------------------------------------------------------------------

class ExportRow(Body):
    component: str = Field(max_length=200)
    formula: str = Field(max_length=20)
    slab_mode: str = Field(max_length=20)
    slab_lower: float | None = None
    slab_upper: float | None = None
    dealer_count: int = 0
    volume: float = 0.0
    gsr: float = 0.0
    cn_rate: float = 0.0
    simulated_rate: float = 0.0
    current_cn: float = 0.0
    simulated_cn: float = 0.0
    # The regions whose dealers are in this row (a region's own rate card), as the app shows under the slab.
    regions: list[Annotated[str, Field(max_length=100)]] = Field(default_factory=list, max_length=200)


class ExportScheme(Body):
    key: str = Field(max_length=100)
    label: str = Field(max_length=200)
    status: str = Field("", max_length=20)
    is_currency: bool = True
    dealer_count: int = 0
    volume: float = 0.0
    gsr: float = 0.0
    rows: list[ExportRow] = Field(default_factory=list, max_length=5000)


class ExportRequest(Scope):
    scope_label: str = Field("All India", max_length=200)
    moved: list[str] = Field(default_factory=list, max_length=1000)   # "scheme::component" with moved boundaries
    schemes: list[ExportScheme] = Field(default_factory=list, max_length=500)


# ---- Month table --------------------------------------------------------------------------------------------------

class MonthsRequest(Scope):
    adjustments: Adjustments = _adjustments()


class PlanRequest(Scope, Edits):
    # Volume change for next month against the current month as shown, in percent.
    volume_growth_pct: float = Field(0.0, gt=-100, le=500)
    # "scheme::component" -> the slab table the user is editing in the current month (rates and / or boundaries).
    # Next month uses it too, unless next month has its own table for that component (next_layouts).
    layouts: Layouts = Field(default_factory=dict, max_length=500)
    # Next month's own slab tables (user's choice, 3 Nov 2026): a component listed here replaces its current-month
    # table for next month; the others follow the current month.
    next_layouts: Layouts = Field(default_factory=dict, max_length=500)
    # Schemes the user deleted: they pay nothing next month (volume and GSR stay; the sales still happen).
    removed_schemes: list[str] = Field(default_factory=list, max_length=200)

    def layouts_key(self) -> str:
        """Next month's slab tables (the current month's, with next month's own on top), as a cache key."""
        import json
        merged = {**self.layouts, **self.next_layouts}
        return json.dumps({k: v.engine_args() for k, v in sorted(merged.items())}, sort_keys=True)


class ProductEdit(Body):
    """One product's edit in the Month table."""
    volume: float = Field(1.0, gt=0, le=100)   # Volume / Mix edits, as a factor: sales grow, dealers re-slab
    price: float = Field(1.0, gt=0, le=100)    # GSR edits, as a factor: GSR per litre moves; volume and slabs stay
    # CN % edits, as the target itself: every rate of the product's schemes scales until its CN / GSR is this.
    cn_pct: float | None = Field(None, ge=0, le=100)


class EditedMonthsRequest(PlanRequest):
    # product -> edit: the current month's, and next month's on top of them
    current: dict[str, ProductEdit] = Field(default_factory=dict, max_length=50)
    next: dict[str, ProductEdit] = Field(default_factory=dict, max_length=50)


class SchemeMonthsRequest(PlanRequest):
    scheme: str = Field(max_length=100)


class GiftDetailRequest(Scope):
    scheme: str = Field(max_length=200)
    # What-if edits, only for a scheme whose rule the file reproduces: litres per gift, or % of GSR (5% Nova Prime) ...
    rule_value: float | None = Field(None, gt=0, le=1e6)
    # ... and the scheme's volume moved by this %, each dealer's GSR with it at the same price.
    volume_pct: float = Field(0.0, gt=-100, le=500)


# ---- Saved versions ----------------------------------------------------------------------------------------------

class SavedVersionIn(Edits):
    name: str = Field(min_length=1, max_length=200)  # unique (app/spi/saved_versions.py)
    note: str | None = Field(None, max_length=2000)
    volume_growth_pct: float = Field(0.0, gt=-100, le=500)
    layouts: Layouts = Field(default_factory=dict, max_length=500)
    # Next month's own slab tables (they replace the current month's for next month only).
    next_layouts: Layouts = Field(default_factory=dict, max_length=500)
    removed_schemes: list[str] = Field(default_factory=list, max_length=200)

    @field_validator("name")
    @classmethod
    def _named(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("a version needs a name")
        return v

    @model_validator(mode="after")
    def _one_per_key(self):
        for adjs in (self.adjustments, self.next_adjustments):
            keys = [(a.scope_kind, a.scope_value, a.product, a.metric, a.mode) for a in adjs]
            if len(keys) != len(set(keys)):
                raise ValueError("the same scope, product, metric and mode is edited twice; combine them into one")
        return self

    def meta(self) -> dict:
        return {"name": self.name.strip(), "note": (self.note or "").strip() or None,
                "volume_growth_pct": self.volume_growth_pct, "removed_schemes": sorted(set(self.removed_schemes))}

    def changes(self) -> list[dict]:
        """Both months' edits, each with its period, as stored."""
        return ([{**a.model_dump(), "period": "current"} for a in self.adjustments]
                + [{**a.model_dump(), "period": "next"} for a in self.next_adjustments])

    def engine_layouts(self) -> tuple[dict, dict]:
        return ({k: v.engine_args() for k, v in self.layouts.items()},
                {k: v.engine_args() for k, v in self.next_layouts.items()})


class SavedVersionStatus(Body):
    status: Literal["SAVED", "ARCHIVED"]
