"""Saved what-if versions: computed on the server from the actual month (which they never change) and kept in
Postgres (app/spi/saved_versions.py), so senior management can open them. Unsaved edits stay in the browser."""
from __future__ import annotations

import logging
from datetime import date

from fastapi import HTTPException

from app.service import live

log = logging.getLogger("app.versions")


def live_month_start() -> date:
    return date(int(live.LIVE.label[:4]), int(live.LIVE.label[5:7]), 1)


def version_month(period: str) -> str:
    return live.month_label() if period == "current" else live.next_month_label()


def source_of(result: dict) -> dict:
    """What a result was computed on: the live file, its extract date, and the month the figures are for."""
    return {"file": live.LIVE.path.name, "as_of": live.LIVE.as_of,
            "month": date.fromisoformat(result["month"] + "-01")}


def results(volume_growth_pct: float, adjustments, next_adjustments, layouts: dict[str, dict],
            removed: list[str], next_layouts: dict[str, dict] | None = None) -> dict[str, dict]:
    """The version against actual, for the current month and next month (no edits, same V). Next month
    uses next_layouts where it has its own table, else the current month's."""
    from app.core.scenario import compute

    next_layouts = next_layouts or {}
    for key in {*layouts, *next_layouts}:
        scheme, _, component = key.partition("::")
        live.check_component(scheme, component)
    currency = live.currency_by_scheme()
    exposed = set(live.get_exposed_schemes())
    factor = live.plan_factor(volume_growth_pct)
    cur, cur_warn = live.current_frame(adjustments)
    nxt, next_warn = live.next_frame(adjustments, next_adjustments, factor)
    out = {}
    merged = {**layouts, **next_layouts}
    for period, scen, base, f, warnings, tables in (("current", cur, live.get_df(), 1.0, cur_warn, layouts),
                                                    ("next", nxt, live.grown_frame(factor), factor, next_warn, merged)):
        result = compute(scen, base, tables, set(removed), exposed, currency)
        out[period] = {**result, "period": period, "month": version_month(period), "factor": f,
                       "warnings": warnings}
    return out


def product_order(schemes: list[dict]) -> list[dict]:
    """Products in the month table's order; within a product, the largest actual CN first."""
    from app.core.categories import ORDER

    rank = {c: i for i, c in enumerate(ORDER)}
    return sorted(schemes, key=lambda s: (rank.get(s["product"], len(ORDER)), -s["actual_cn"]))


def payload(result: dict) -> dict:
    """One month's result for the browser: totals and per-scheme figures with slab rows. No dealer codes or names."""
    from app.core.categories import category_of

    labels = {k: v.label for k, v in live.get_schemes_cached().items()}
    schemes = product_order([{**s, "label": labels.get(s["scheme"], s["scheme"]),
                              "product": category_of(s["scheme"])[0]} for s in result["schemes"]])
    return {k: result[k] for k in ("period", "month", "factor", "totals", "warnings")} | {"schemes": schemes}


def limit_text(owner: str | None, user: str | None) -> str:
    """The refusal when a version would pass its owner's limit (app/spi/saved_versions.py), in plain words."""
    from app.spi.saved_versions import MAX_VERSIONS_PER_USER as most

    if owner and user and owner.lower() != user.lower():
        return (f"{owner} already has {most} saved versions, the most one person may keep. Archive or delete one of "
                "them first.")
    return (f"You already have {most} saved versions, the most one person may keep. Archive or delete one of yours "
            "to save another.")


def save(version_id: int | None, req, actor: dict | None = None) -> dict:
    """Create or update a version (a SavedVersionIn) with its results, in one transaction. `actor`: who saves it
    (role, username, schemes, user_id; the version's created_by when it is new)."""
    from app.spi import connection
    from app.spi import saved_versions as store

    name = req.meta()["name"]
    owner = (actor or {}).get("username")
    with connection() as conn:  # refused before the results are computed; checked again under a lock when written
        if store.name_taken(conn, name, version_id):
            raise HTTPException(409, f'A version named "{name}" already exists; choose another name')
        if version_id is None and store.open_count(conn, owner) >= store.MAX_VERSIONS_PER_USER:
            raise HTTPException(409, limit_text(owner, owner))
    layouts, next_layouts = req.engine_layouts()
    out = results(req.volume_growth_pct, req.adjustments, req.next_adjustments, layouts, req.removed_schemes,
                  next_layouts)
    try:
        version_id = store.save(version_id, req.meta(), live_month_start(), req.changes(), layouts, next_layouts,
                                 [(r, source_of(r)) for r in out.values()], actor=actor)
    except store.NameTaken as exc:
        raise HTTPException(409, str(exc)) from None
    except store.LimitReached as exc:
        raise HTTPException(409, limit_text(exc.owner, owner)) from None
    return {"version_id": version_id, **{period: payload(r) for period, r in out.items()}}


def recalculate_versions() -> int:
    """Re-run the live month's open versions on its newest file; their changes stay, saved snapshots stay.

    Called after the warm-up and after each reload of the live file. Returns how many were recalculated.
    """
    from app import spi
    from app.spi import saved_versions as store

    if not spi.configured():
        return 0
    # One live month for the whole run (frame and slab edges together), as a request has. A reload during the run
    # recalculates on the new month itself, so results of the old month are not written once it is replaced.
    tokens = live.pin()
    try:
        done = 0
        for version_id in store.stale(live_month_start(), live.LIVE.path.name):
            if not live.is_current():
                log.info("versions: the live month was replaced; this run stops (the reload recalculates)")
                break
            try:
                d = store.definition(version_id)
                out = results(d["volume_growth_pct"], d["adjustments"], d["next_adjustments"],
                              d["layouts"], d["removed_schemes"], d["next_layouts"])
                if not live.is_current():
                    break
                store.write_live(version_id, [(r, source_of(r)) for r in out.values()])
                done += 1
            except Exception:  # one bad version must not stop the others; the detail stays in the server log
                log.exception("version %s: recalculation failed", version_id)
        return done
    finally:
        live.unpin(tokens)
