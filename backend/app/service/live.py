"""The live month, the frames derived from it and every cache built on them.

The live month is one State (its file, its dealer frame, its slab-edge version), replaced as a whole when a new file
is synced (reload_live). Each request keeps the State it started with (pin(), called by the API's middleware), so a
reload in the middle of a request never mixes one month's rows with another month's edges, labels or caches. Read
the month as `live.LIVE` (never `from ... import LIVE`): it is the request's State's file.

Every cache here is a pure function of the files and its arguments (scope, edits, layouts), so two users never see
each other's edits; caches are built once per key (app/core/cache.py), keyed by the State too, and dropped on a
reload.
"""
from __future__ import annotations

import json
import logging
import threading
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd
from fastapi import HTTPException
from pydantic import BaseModel

from app.config import get_settings
from app.core.cache import BuildGate
from app.core.cache import memo as _memo
from app.core.categories import dedup_sum
from app.core.growth import grow_portfolio
from app.core.months import data_signature as _data_signature
from app.core.months import live_month as _live_month
from app.core.scope import apply_scope, scope_key
from app.core.simulate import simulate, totals
from app.core.slab_engine import build_slabs, pin_edge_version, rebucket, set_edge_source, unpin_edge_version
from app.ingest.all_schemes import get_schemes as _get_schemes
from app.ingest.load_month import load_month
from app.ingest.reconcile import reconcile

log = logging.getLogger("app.live")


@dataclass(eq=False)
class State:
    """One live month: its file (meta), its dealer frame (built on first use) and the slab-edge version of that frame.
    `seq` grows by one per reload; every cache below is keyed by it."""
    meta: Any
    seq: int
    frame: pd.DataFrame | None = None
    edge_version: int | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)


# The live month: the newest file synced from GCS (app/ingest/gcs_sync.py), LIVE_MONTH when pinned, else the
# registry's settled September. One source for the whole app, so every view reports the same month. Looked up on
# first use (_current), not when this module is imported, so importing it reads no files.
_CURRENT: State | None = None
_PINNED: ContextVar[State | None] = ContextVar("live_state", default=None)
# Every synced month's main and gift file: a new previous month or gift file also changes what the API serves.
_SIGNATURE: Any = None
_INIT_LOCK = threading.Lock()
# One reload at a time: the scheduler and the file watcher (app/main.py) may both notice the same new file.
_RELOAD_LOCK = threading.Lock()
# True once the dealer frame and the All-India slab tables are built (GET /health).
READY = False

# At most two edited frames (~0.11 GB each, plus working copies) are built at the same time; a request that cannot
# get a slot within 90 s is answered 503 "busy" (app/main.py) instead of pushing the container past its memory.
HEAVY = BuildGate(slots=2, wait=90)


def _current() -> State:
    """The current live month, looked up on first use."""
    global _CURRENT, _SIGNATURE
    if _CURRENT is None:
        with _INIT_LOCK:
            if _CURRENT is None:
                first = _live_month()
                if first is None:
                    raise RuntimeError("LIVE_MONTH is not a registered month label")
                _SIGNATURE = _data_signature()
                _CURRENT = State(first, 1)
    return _CURRENT

# "verified" exposes only schemes whose computed CN reconciles against the raw file's own totals (see
# /reconciliation). "all" exposes everything, with the unreconciled ones flagged in the UI.
SCHEME_MODE = get_settings().scheme_mode


def _state() -> State:
    """The State of this request (pinned at its start), else the current one (warm-up, scheduler, scripts)."""
    return _PINNED.get() or _current()


def _meta():
    return _state().meta


def __getattr__(name: str):
    # live.LIVE: the request's live file (module attribute, looked up per access).
    if name == "LIVE":
        return _meta()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def state_seq() -> int:
    return _state().seq


def pin() -> tuple[Token, Token]:
    """Keep the current State (and its slab edges) for the rest of this request. Undo with unpin()."""
    state = _current()
    return _PINNED.set(state), pin_edge_version(state.edge_version)


def is_current() -> bool:
    """False when this request's (or this pinned job's) live month has since been replaced by a reload."""
    pinned = _PINNED.get()
    return pinned is None or pinned is _CURRENT


def unpin(tokens: tuple[Token, Token]) -> None:
    state_token, edge_token = tokens
    unpin_edge_version(edge_token)
    _PINNED.reset(state_token)


def memo(maxsize: int, keep=None):
    """A cache of this module: also keyed by the State, so a request never reads a result of another live month."""
    return _memo(maxsize, key_extra=state_seq, keep=keep)

# Columns that repeat a small set of values across every row. Left as Arrow strings, each mask and groupby pays a
# conversion -- pyarrow.take alone was 4.7s of a single All-India page build. As categoricals the comparisons run on
# integer codes instead, and the frame gets considerably smaller too. customer_code is deliberately NOT here: with
# 34k distinct values grouping on it as a categorical makes pandas build a row per unused category.
_CATEGORICAL = ("zone", "region", "depot_code", "scheme", "scheme_label", "component", "formula")


def _compact(df):
    """Narrow the dtypes of the live frame, in place of the Arrow-string ones."""
    for col in _CATEGORICAL:
        if col in df.columns and str(df[col].dtype) != "category":
            df[col] = df[col].astype("category")
    return df


def month_label() -> str:
    """The live month as YYYY-MM."""
    return _meta().label[:7]


def next_month_label() -> str:
    """The month after the live one, as YYYY-MM."""
    year, month = int(_meta().label[:4]), int(_meta().label[5:7])
    return f"{year + month // 12:04d}-{month % 12 + 1:02d}"


def get_df() -> pd.DataFrame:
    """The live month's dealer frame, built once (the first callers wait for one build, ~14 s)."""
    state = _state()
    if state.frame is None:
        with state.lock:
            if state.frame is None:
                # via load_month so the layout is detected and the dealer's total-GSR columns are picked up
                frame = _compact(load_month(state.meta.path, source_kind=state.meta.source))
                # Slab edges are derived nationally, so the engine needs the full frame whichever endpoint is first.
                state.edge_version = set_edge_source(frame)
                state.frame = frame
    return state.frame


def reload_live() -> bool:
    """Swap in the newest synced files without a restart. True when any month's file changed.

    The sync has already built the file's parquet cache, so the new frame loads in seconds. It is built before
    anything is swapped, so requests keep answering from the old month until the new one is ready. Then the new State
    replaces the old one in one step: requests already running finish on the old State (their caches are keyed by
    it), new ones start on the new State; every cache derived from the old frame is dropped (a build still running
    on it is not stored) and the All-India view is warmed again. A new file for an earlier month or a new gift file
    changes the month table, the trend and the gift table, though not the live frame.
    """
    with _RELOAD_LOCK:
        return _reload_live()


def _reload_live() -> bool:
    global _CURRENT, _SIGNATURE
    current = _current()
    new, signature = _live_month(), _data_signature()
    if new is None or signature == _SIGNATURE and new.path == current.meta.path:
        return False
    live_changed = new.path != current.meta.path
    if live_changed:
        frame = _compact(load_month(new.path, source_kind=new.source))
        _CURRENT = State(new, current.seq + 1, frame, set_edge_source(frame))
        for cached in (get_schemes_cached, get_status_by_key, all_slabs_cached, growth_cached, slabs_cached,
                       slabs_payload_cached, reconciliation_cached, components_of, grown_frame, plan_cached,
                       _current_frame_cached, _next_frame_cached, _touched_current, _touched_next,
                       served_component_records, _served_plan_components, _known_scope_values):
            cached.cache_clear()
    _SIGNATURE = signature
    for cached in (month_frame, months_cached, gift_frame, gifts_cached, trend_payload):
        cached.cache_clear()
    log.info("reload: live month %s from %s; files %s", new.label, new.path.name, signature)
    if live_changed:
        global READY
        all_slabs_cached(None, None, None)
        READY = True   # also when the first file arrives after start-up (a new server with an empty data folder)
        from app.service.saved_versions import recalculate_versions
        log.info("reload: versions recalculated: %s", recalculate_versions())
    trend_payload()
    return True


# ---- Schemes ---------------------------------------------------------------------------------------------------

def get_schemes(path):
    """A file's scheme definitions: as stored at load when the database holds the file (DATA_SOURCE=spi), else read
    from the file's header."""
    from app import spi

    if spi.enabled():
        from app.spi.frames import scheme_configs_for, schemes_from_configs

        configs = scheme_configs_for(path.name)
        if configs is not None:
            return schemes_from_configs(configs)
    return _get_schemes(path)


@memo(maxsize=1)
def get_schemes_cached():
    """Scheme configs for the live file, discovered the way its layout needs.

    get_schemes() reads the automated "Output"-sheet shape. A working book has neither that sheet nor that column
    arrangement, so it is routed to the working discoverer instead.
    """
    meta = _meta()
    if meta.source == "working_slabs":
        from app.ingest.discover_working import discover_working
        from app.ingest.load_month import WORKING_SHEETS, _has_sheet

        sheet = next((s for s in WORKING_SHEETS if s and _has_sheet(meta.path, s)), None)
        return discover_working(meta.path, sheet)[0]
    return get_schemes(meta.path)


@memo(maxsize=1)
def get_status_by_key() -> dict[str, str]:
    report = reconcile(get_df(), get_schemes_cached())
    return {r["scheme"]: r["status"] for r in report.to_dict(orient="records")}


def get_exposed_schemes():
    schemes = get_schemes_cached()
    if SCHEME_MODE != "verified":
        return schemes
    status = get_status_by_key()
    return {k: v for k, v in schemes.items() if status.get(k) == "ok"}


def currency_by_scheme() -> dict[str, bool]:
    """Rupee (True) or gift-count (False) payout, per scheme of the live month."""
    return {k: v.is_currency for k, v in get_schemes_cached().items()}


def require_scheme(scheme: str) -> None:
    if scheme not in get_exposed_schemes():
        raise HTTPException(404, f"The scheme '{scheme}' is not in the current data")


@memo(maxsize=1)
def components_of() -> dict[str, frozenset[str]]:
    df = get_df()
    pairs = df[["scheme", "component"]].drop_duplicates()
    return {str(k): frozenset(g["component"].astype(str)) for k, g in pairs.groupby("scheme", observed=True)}


def check_component(scheme: str, component: str) -> None:
    require_scheme(scheme)
    if component not in components_of().get(scheme, ()):
        raise HTTPException(404, f"scheme '{scheme}' has no component '{component}'")


# ---- Scope (the filters) ------------------------------------------------------------------------------------------

_SCOPE_COLUMNS = (("zone", "zone"), ("region", "region"), ("depot_code", "depot"))


def _scope_norm(value) -> str:
    """One spelling per value: depot codes arrive as text ("1234") but may be numbers in the frame (1234 / 1234.0)."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value).strip()
    return repr(number) if number == number else str(value).strip()


@memo(maxsize=1)
def _known_scope_values() -> dict[str, frozenset[str]]:
    df = get_df()
    return {col: frozenset(_scope_norm(v) for v in df[col].dropna().unique().tolist())
            for col, _ in _SCOPE_COLUMNS if col in df.columns}


def scope_of(zone, region, depot_code) -> tuple:
    """The filters as a cache key (scope_key), refused with 422 when a value is not in the live month.

    Every filtered view is cached by its filters, so made-up values would each add an entry and push the warm views
    out of the cache. The web app only offers values from /filters, so a real user never sees this."""
    key = scope_key(zone, region, depot_code)
    known = _known_scope_values()
    for (col, name), values in zip(_SCOPE_COLUMNS, key, strict=True):
        for value in values or ():
            if col in known and _scope_norm(value) not in known[col]:
                raise HTTPException(422, f"The {name} '{str(value)[:60]}' is not in the current data. "
                                         "Clear the filter and choose again.")
    return key


# ---- Shared helpers --------------------------------------------------------------------------------------------

def records(df):
    """NaN -> None. Has to go through object dtype: assigning None into a float column just turns straight back
    into NaN, which json.dumps rejects."""
    if df.empty:
        return []
    # Column by column as Python values (a whole-frame astype + to_dict was ~3-10 ms a table, ~90 tables an edit).
    columns = {}
    for c in df.columns:
        s = df[c]
        values = s.tolist()
        if s.isna().any():
            missing = s.isna().to_numpy()
            values = [None if m else v for v, m in zip(values, missing, strict=True)]
        columns[c] = values
    names = list(columns)
    return [dict(zip(names, row, strict=True)) for row in zip(*columns.values(), strict=True)]


def scheme_gsr_of(sub) -> float:
    """A scheme's GSR from an already-scoped sub-frame, counting each source column once."""
    return dedup_sum(sub, "gsr", "gsr_src")


def scheme_payload(scheme_key: str, cfg, status, sub) -> dict:
    """One scheme's payload. `sub` is this scheme's rows, already narrowed to the scope (re-scanning the national
    frame per scheme meant ~150 full passes over 484k rows for one page load)."""
    slabs = build_slabs(sub, scheme_key, None, None, None)
    result = simulate(slabs, {})
    t = totals(result)
    # totals() adds up row counts, which counts a dealer once per component; the scheme figure is distinct dealers.
    t["dealer_count"] = int(sub["customer_code"].nunique())
    t["gsr"] = scheme_gsr_of(sub)
    t["volume"] = dedup_sum(sub, "volume", "vol_src")
    return {
        "key": scheme_key,
        "label": cfg.label,
        "status": status.get(scheme_key, "unknown"),
        "is_currency": cfg.is_currency,
        "rows": records(result),
        "totals": t,
    }


# ---- Slab tables -----------------------------------------------------------------------------------------------

@memo(maxsize=1)
def reconciliation_cached():
    # Depends only on the live file. An inactive scheme has no total, so diff_pct is None; put it back after the
    # frame turns it into NaN, which json.dumps refuses.
    rec = reconcile(get_df(), get_schemes_cached())
    return rec.astype(object).where(rec.notna(), None).to_dict(orient="records")


def source_info() -> dict:
    """Which file the figures came from, so a part month is never mistaken for the settled one."""
    meta = _meta()
    return {
        "month": month_label(),
        "file": meta.path.name,
        "version": meta.version,
        "as_of": meta.as_of,
        "elapsed_days": meta.elapsed_days,
        "month_days": meta.month_days,
        "complete": meta.complete,
    }


# Rebuilding every scheme's slab table takes ~70s, and the result depends only on the three filters. Keyed on the
# filter triple (normalised by scope_key); the ~180 combinations that actually get used fit comfortably.
def _is_all_india(zone, region, depot_code) -> bool:
    return zone is None and region is None and depot_code is None


# All India is never evicted: it is the first view of every session and takes ~47 s to build.
@memo(maxsize=256, keep=_is_all_india)
def all_slabs_cached(zone: tuple | None, region: tuple | None, depot_code: tuple | None):
    status = get_status_by_key()
    schemes = get_exposed_schemes()
    # Narrow to the scope ONCE, then split by scheme ONCE.
    scoped = apply_scope(get_df(), zone, region, depot_code)
    by_scheme = {k: g for k, g in scoped.groupby("scheme", sort=False, observed=True)}
    payloads = [scheme_payload(k, cfg, status, by_scheme[k]) for k, cfg in schemes.items() if k in by_scheme]
    payloads = [p for p in payloads if p["totals"]["dealer_count"] > 0]
    payloads.sort(key=lambda p: -p["totals"]["current_cn"])
    grand = {
        # Unique dealers in scope (per-scheme counts are row counts).
        "dealer_count": int(scoped["customer_code"].nunique()),
        # GIFT schemes count gifts, not rupees, so they stay out of the money total.
        "current_cn": sum(p["totals"]["current_cn"] for p in payloads if p["is_currency"]),
        "gift_count": sum(p["totals"]["current_cn"] for p in payloads if not p["is_currency"]),
        # Per-scheme GSR cannot be summed -- the same sale sits in several schemes. The dealer's book is Value +
        # Value % + Timbra GSR (B), carried per dealer, so this is a de-duplicated sum of that total.
        "gsr": float(scoped.drop_duplicates("customer_code")["total_gsr"].sum()) if "total_gsr" in scoped else 0.0,
        # Each distinct volume column is a distinct product measure, counted once per dealer.
        "volume": dedup_sum(scoped, "volume", "vol_src"),
        "gsr_is_proxy": False,
        "scheme_count": len(payloads),
        "verified_count": sum(1 for p in payloads if p["status"] == "ok"),
    }
    return {"filters": {"zone": zone, "region": region, "depot_code": depot_code},
            "schemes": payloads, "grand": grand, "source": source_info()}


# /slabs and /simulate depend only on the live file, the scheme and the scope (PERF-1).
@memo(maxsize=512)
def slabs_cached(scheme: str, zone: tuple | None, region: tuple | None, depot_code: tuple | None):
    return build_slabs(get_df(), scheme, zone, region, depot_code)


@memo(maxsize=256)
def slabs_payload_cached(scheme: str, zone: tuple | None, region: tuple | None, depot_code: tuple | None):
    df = get_df()
    sub = apply_scope(df[df["scheme"] == scheme], zone, region, depot_code)
    return scheme_payload(scheme, get_exposed_schemes()[scheme], get_status_by_key(), sub)


# ---- Frames with the user's GSR / volume edits (app/core/scenario.py) -------------------------------------------
# Edits travel with every request, so the API stays stateless. The edited frames are pure functions of the edits.
# Each is built once per key (other users' keys build in parallel). A frame is ~0.11 GB (534k rows, Nov'26), so
# 4 current + 3 next + 2 grown frames stay under ~1 GB.

def adj_key(adjustments) -> str:
    """The edits as one canonical string (order and reasons do not change the numbers)."""
    rows = [a.model_dump() if isinstance(a, BaseModel) else dict(a) for a in adjustments or []]
    rows = [{k: v for k, v in r.items() if k not in ("reason", "period")} for r in rows]
    return json.dumps(sorted(rows, key=lambda r: json.dumps(r, sort_keys=True)), sort_keys=True)


@memo(maxsize=4)
def _current_frame_cached(key: str):
    from app.core.scenario import scenario_frame
    df = get_df()
    with HEAVY:
        return scenario_frame(df, json.loads(key), 1.0)


def current_frame(adjustments):
    """The live month with the edits applied, and the edits' warnings. No edits: the live frame itself."""
    key = adj_key(adjustments)
    return (get_df(), []) if key == "[]" else _current_frame_cached(key)


def plan_factor(volume_growth_pct: float) -> float:
    from app.core.plan import growth_factor
    return round(growth_factor(volume_growth_pct), 6)


@memo(maxsize=2)
def grown_frame(factor: float):
    from app.core.slab_engine import grow_frame
    df = get_df()
    with HEAVY:
        return grow_frame(df, factor)


@memo(maxsize=3)
def _next_frame_cached(cur_key: str, next_key: str, factor: float):
    from app.core.scenario import scenario_frame
    cur, warnings = current_frame(json.loads(cur_key))
    with HEAVY:
        out, more = scenario_frame(cur, json.loads(next_key), factor)
    return out, warnings + more


def next_frame(adjustments, next_adjustments, factor: float):
    """Next month: the current month with its edits, grown by `factor`, then next month's own edits."""
    cur_key, next_key = adj_key(adjustments), adj_key(next_adjustments)
    if cur_key == "[]" and next_key == "[]":
        return grown_frame(factor), []
    return _next_frame_cached(cur_key, next_key, factor)


# ---- Reuse of untouched slab tables -------------------------------------------------------------------------------
# One edit usually touches a few schemes (a product, a scheme, a region's dealers), but the views re-slab every
# component. A component whose rows the edits left exactly as they were gives exactly the unedited result, so that
# result is taken from a cache of the unedited month instead (still a pure function of the file, scheme and scope).

def changed_pairs(frame: pd.DataFrame, base: pd.DataFrame) -> frozenset[tuple[str, str]] | None:
    """The (scheme, component) pairs with any row whose figures differ between `frame` (base with edits) and `base`.
    None when the two cannot be compared row by row: then every pair counts as changed."""
    if frame is base:
        return frozenset()
    if len(frame) != len(base) or not frame.index.equals(base.index):
        return None
    # grow_frame adds actual_basis (the base's own slab_basis) and a CN % edit adds cn_scale (1 = unchanged);
    # any other new column is unknown here, so nothing is reused.
    if set(frame.columns) - set(base.columns) - {"actual_basis", "cn_scale"}:
        return None
    changed = np.zeros(len(base), dtype=bool)
    for col in base.columns:
        # total_gsr is the dealer's whole book, repeated on each of their rows: a scheme edit moves it on every row
        # of the dealer, but no slab table reads it (views take it from the edited frame itself).
        if col == "total_gsr" or col not in frame.columns or not pd.api.types.is_numeric_dtype(base[col].dtype) \
                or pd.api.types.is_bool_dtype(base[col].dtype):
            continue
        a, b = frame[col].to_numpy(dtype=float), base[col].to_numpy(dtype=float)
        changed |= ~((a == b) | (np.isnan(a) & np.isnan(b)))
    if "cn_scale" in frame.columns:
        changed |= frame["cn_scale"].to_numpy(dtype=float) != 1.0
    rows = base.loc[changed, ["scheme", "component"]].drop_duplicates()
    return frozenset((str(k), str(c)) for k, c in rows.itertuples(index=False, name=None))


@memo(maxsize=4)
def _touched_current(key: str):
    return changed_pairs(current_frame(json.loads(key))[0], get_df())


def touched_current(adjustments) -> frozenset[tuple[str, str]] | None:
    """The pairs the current month's edits change (None: treat all as changed)."""
    return _touched_current(adj_key(adjustments))


@memo(maxsize=4)
def _touched_next(cur_key: str, next_key: str, factor: float):
    return changed_pairs(next_frame(json.loads(cur_key), json.loads(next_key), factor)[0], grown_frame(factor))


@memo(maxsize=2048)
def served_component_records(scheme: str, component: str, zone, region, depot_code) -> tuple[dict, ...]:
    """The live month's component re-slabbed under its served table (what /all-slabs/adjusted shows for a component
    no edit reaches), as records. Read only: callers copy before changing a row."""
    from app.core.plan import default_layout

    layout = default_layout(scheme, component)
    return tuple(records(rebucket(get_df(), scheme, component, layout["edges"], None, zone, region, depot_code,
                                  sources=layout["sources"])))


@memo(maxsize=64)
def _served_plan_components(factor: float, zone, region, depot_code) -> dict[tuple[str, str], float]:
    """Next month with no edits under the served tables: CN per (scheme, component) that is re-slabbed."""
    from app.core.plan import plan_schemes

    out: dict[tuple[str, str], float] = {}
    plan_schemes(grown_frame(factor), {}, zone, region, depot_code, schemes=set(get_exposed_schemes()),
                 component_cn=out)
    return out


@memo(maxsize=32)
def plan_cached(factor: float, layouts_key: str, adj: str, next_adj: str, zone, region, depot_code) -> dict:
    """Next month's CN per scheme under the layouts and edits; "{}", "[]", "[]" is the served plan."""
    from app.core.plan import plan_schemes

    exposed = set(get_exposed_schemes())
    frame = next_frame(json.loads(adj), json.loads(next_adj), factor)[0]
    touched = _touched_next(adj, next_adj, factor)
    reuse = None
    if touched is not None:
        served = _served_plan_components(factor, zone, region, depot_code)
        reuse = lambda k, c: None if (k, c) in touched else served.get((k, c), 0.0)  # noqa: E731
    return {k: v["cn"] for k, v in plan_schemes(frame, json.loads(layouts_key), zone, region,
                                                depot_code, schemes=exposed, reuse=reuse).items()}


# One pass costs ~5s, and a slider revisits the same few values constantly. Keyed on the rounded request.
@memo(maxsize=512)
def growth_cached(growth_pct, per_scheme, rate_multipliers, zone, region, depot_code):
    exposed = set(get_exposed_schemes())
    df = get_df()
    return grow_portfolio(
        df[df["scheme"].isin(exposed)],
        default_growth=growth_pct / 100.0,
        per_scheme={k: v / 100.0 for k, v in per_scheme},
        rate_multipliers=dict(rate_multipliers),
        zone=zone, region=region, depot_code=depot_code,
    )


# ---- Other months: previous (settled) and gifts -----------------------------------------------------------------

def month_file(label: str):
    """A month by label, synced from GCS or registered, whose file is on this machine."""
    from app.core.months import complete_months, has_data, partial_months, synced_months

    for m in [*synced_months(), *complete_months(), *partial_months()]:
        if m.label[:7] == label and has_data(m):
            return m
    return None


@memo(maxsize=4)
def month_frame(label: str):
    """A month's parsed frame and its rupee / gift flag per scheme. The live month reuses the live frame."""
    if label == month_label():
        return get_df(), currency_by_scheme()
    m = month_file(label)
    frame = load_month(m.path, source_kind=m.source)
    try:
        currency = {k: v.is_currency for k, v in get_schemes(m.path).items()}
    except Exception:  # a working-book layout: every scheme counts as rupees
        currency = {}
    return frame, currency


def previous_label() -> str | None:
    from app.core.months import complete_months, has_data, synced_months

    live = month_label()
    labels = sorted({m.label[:7] for m in [*synced_months(), *complete_months()] if has_data(m)})
    earlier = [x for x in labels if x < live]
    return earlier[-1] if earlier else None


def month_block(label: str, zone, region, depot_code, frame=None) -> dict:
    from app.core.categories import category_table, scheme_figures
    from app.core.months import synced_months

    own, currency = month_frame(label)
    frame = own if frame is None else frame
    schemes, scheme_totals = scheme_figures(frame, currency, zone, region, depot_code)
    meta = next((m for m in synced_months() if m.label[:7] == label), None) or month_file(label)
    return {
        "month": label,
        "as_of": getattr(meta, "as_of", None),
        "version": getattr(meta, "version", None),
        "complete": bool(getattr(meta, "complete", True)),
        "elapsed_days": getattr(meta, "elapsed_days", None),
        "month_days": getattr(meta, "month_days", None),
        "dealers": scheme_totals["dealers"],
        # Every scheme's litres, as the header's Volume counts them (the table's TOTAL counts products only).
        "book_volume": dedup_sum(apply_scope(frame, zone, region, depot_code), "volume", "vol_src"),
        **category_table(schemes, scheme_totals["gsr"], scheme_totals["dealers"]),
    }


@memo(maxsize=128)
def months_cached(zone, region, depot_code) -> dict:
    prev = previous_label()
    return {
        "previous": month_block(prev, zone, region, depot_code) if prev else None,
        "current": month_block(month_label(), zone, region, depot_code),
    }


@memo(maxsize=4)
def gift_frame(label: str):
    from app.core.months import gift_months
    from app.ingest.gifts import load_gifts

    meta = next((m for m in gift_months() if m.label[:7] == label), None)
    if meta is None:
        return None, None
    if meta.in_db:
        from app.spi.frames import gifts_frame_for

        frame = gifts_frame_for(meta.path)
        if frame is not None:
            return meta, frame
    return meta, load_gifts(meta.path)


def _gift_block(label: str | None, zone, region, depot_code) -> dict | None:
    from app.core.gifts import gift_table

    if label is None:
        return None
    meta, frame = gift_frame(label)
    if meta is None:
        return {"month": label, "as_of": None, "version": None, "schemes": []}
    return {"month": label, "as_of": meta.as_of, "version": meta.version,
            "schemes": gift_table(frame, zone, region, depot_code)}


@memo(maxsize=128)
def gifts_cached(zone, region, depot_code) -> dict:
    return {"previous": _gift_block(previous_label(), zone, region, depot_code),
            "current": _gift_block(month_label(), zone, region, depot_code)}


def gift_month() -> str | None:
    """The month whose gift file Scheme detail shows: the live month's, else the month before it."""
    live = month_label()
    return live if gift_frame(live)[0] is not None else previous_label()


@memo(maxsize=1)
def trend_payload() -> str:
    """Cached as JSON text: builds from the monthly files, which are slow to parse."""
    from app.service.trend import build_trend
    return json.dumps(build_trend())
