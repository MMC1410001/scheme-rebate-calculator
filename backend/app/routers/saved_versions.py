"""Saved what-if versions (app/service/saved_versions.py, app/spi/saved_versions.py). Any login may list and open them.
Saving needs ADMIN or SCHEME_MANAGER: a manager saves only its own schemes' edits (app/access.py) and changes,
archives or deletes only its own versions; an ADMIN any. Each login keeps at most 10 versions that are not archived. The moved dealers (client data) need a role that sees dealer lists."""
from __future__ import annotations

import logging
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from app import access, spi, users
from app.auth import NOT_ALLOWED, Session, current_user, require_saver
from app.core.categories import category_of
from app.core.scenario import PRODUCTS
from app.schemas import SavedVersionIn, SavedVersionStatus
from app.service import live
from app.service import saved_versions as service
from app.spi import saved_versions as store_module

router = APIRouter(prefix="/saved-versions", tags=["saved versions"])
# Who saved, archived or opened the moved dealers of which version; never the dealers themselves.
audit = logging.getLogger("app.audit")

GONE = "This version no longer exists; it may have been deleted"
NOT_YOURS = "Only the person who saved this version, or an administrator, can change it."


def _db_or_503() -> None:
    if not spi.configured():
        raise HTTPException(503, "Saving versions needs the database, which is not set up on this server")


def _store():
    _db_or_503()
    return store_module


def _is_editable(found: dict) -> bool:
    return found["base_month"] == service.live_month_start() and found["status"] != "ARCHIVED"


def _can_change(user: Session, found: dict) -> bool:
    return user.is_admin or (user.can_save and found.get("created_by") == user.username)


def _actor(user: Session) -> dict:
    return {"role": user.role, "username": user.username, "schemes": sorted(user.schemes), "user_id": user.user_id}


def _own_or_403(user: Session, found: dict) -> None:
    if not _can_change(user, found):
        raise HTTPException(403, NOT_YOURS)


@router.get("/meta")
def get_version_meta(user: Session = Depends(current_user)):
    """Products for mix edits, whether this user can save (a database, and the ADMIN or SCHEME_MANAGER role), the
    schemes it may edit (None: all), the months a version covers."""
    return {"products": PRODUCTS, "has_db": spi.configured(), "can_save": spi.configured() and user.can_save,
            "role": user.role, "edit_schemes": None if user.is_admin else sorted(user.schemes),
            "live_month": live.month_label(), "next_month": live.next_month_label(), "as_of": live.LIVE.as_of}


@router.post("/preview")
def post_version_preview(req: SavedVersionIn, request: Request, user: Session = Depends(current_user)):
    """The version's result for both months, without saving it."""
    access.check_request(user, req, request)
    layouts, next_layouts = req.engine_layouts()
    out = service.results(req.volume_growth_pct, req.adjustments, req.next_adjustments, layouts,
                          req.removed_schemes, next_layouts)
    return {period: service.payload(r) for period, r in out.items()}


@router.post("")
def post_version(req: SavedVersionIn, user: Session = Depends(require_saver)):
    """Save a new version: its changes, its live results and a dated snapshot of what it shows now. A manager's
    version may hold only its own schemes' edits (an opened version of someone else's is no exception)."""
    _db_or_503()
    access.check(user, access.request_edits(req), allow_version=False)
    out = service.save(None, req, _actor(user))
    audit.info("version saved: user=%s version=%s (new)", user.username, out["version_id"])
    users.audit(user.username, "version.create", str(out["version_id"]), {"name": req.meta()["name"]})
    return out


@router.put("/{version_id}")
def put_version(version_id: int, req: SavedVersionIn, user: Session = Depends(require_saver)):
    """Save changes to a version of the live month: only changed values are written, plus a new dated snapshot."""
    found = _store().get(version_id)
    if found is None:
        raise HTTPException(404, GONE)
    _own_or_403(user, found)
    if found["status"] == "ARCHIVED":
        raise HTTPException(409, "This version is archived; restore it to change it")
    if found["base_month"] != service.live_month_start():
        raise HTTPException(409, f"This version adjusts {found['base_month']:%b %Y}, which is no longer the live "
                                 "month; it is kept as saved and can no longer be changed")
    access.check(user, access.request_edits(req), allow_version=False)
    out = service.save(version_id, req, _actor(user))
    access.forget_version(version_id)
    audit.info("version saved: user=%s version=%s", user.username, version_id)
    users.audit(user.username, "version.update", str(version_id))
    return out


@router.get("")
def list_versions(user: Session = Depends(current_user)):
    store = _store()
    return {"live_month": live.month_label(),
            "versions": [{**s, "editable": _is_editable(s), "can_change": _can_change(user, s)}
                         for s in store.list_all()]}


@router.get("/{version_id}")
def get_version(version_id: int, user: Session = Depends(current_user)):
    found = _store().get(version_id)
    if found is None:
        raise HTTPException(404, GONE)
    return {**found, "editable": _is_editable(found), "can_change": _can_change(user, found)}


@router.get("/{version_id}/snapshots/{snapshot_id}")
def get_version_snapshot(version_id: int, snapshot_id: int):
    """One snapshot (one month): totals, per scheme actual vs version, and both sides' slab rows."""
    snap = _store().snapshot(version_id, snapshot_id)
    if snap is None:
        raise HTTPException(404, "This saved version of the version no longer exists")
    labels = {k: v.label for k, v in live.get_schemes_cached().items()}
    for s in snap["schemes"]:
        s["label"] = labels.get(s["scheme_key"], s["scheme_key"])
        s["product"] = category_of(s["scheme_key"])[0]
    snap["schemes"] = service.product_order(snap["schemes"])
    return snap


@router.get("/{version_id}/dealers")
def get_version_dealers(version_id: int, user: Annotated[Session, Depends(current_user)],
                         month: Annotated[str | None, Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")] = None,
                         scheme: Annotated[str | None, Query(max_length=100)] = None,
                         q: Annotated[str, Query(max_length=100)] = "",
                         page: Annotated[int, Query(ge=1)] = 1,
                         page_size: Annotated[int, Query(ge=1, le=200)] = 50):
    """Dealers who moved slab in the version's live result (client data), one page at a time."""
    if not user.can_see_dealers:
        raise HTTPException(403, NOT_ALLOWED)
    store = _store()
    if store.get(version_id) is None:
        raise HTTPException(404, GONE)
    audit.info("moved dealers: user=%s version=%s month=%s scheme=%s", user.username, version_id, month, scheme)
    return store.moved_dealers(version_id, date.fromisoformat(month + "-01") if month else None, scheme, q, page,
                               page_size)


def _set_status(version_id: int, req: SavedVersionStatus, user: Session) -> dict:
    found = _store().get(version_id)
    if found is None:
        raise HTTPException(404, GONE)
    _own_or_403(user, found)
    try:
        changed = _store().set_status(version_id, req.status, _actor(user))
    except store_module.LimitReached as exc:
        raise HTTPException(409, service.limit_text(exc.owner, user.username)) from None
    if not changed:
        raise HTTPException(404, GONE)
    audit.info("version status: user=%s version=%s status=%s", user.username, version_id, req.status)
    users.audit(user.username, "version.status", str(version_id), {"status": req.status})
    return {"version_id": version_id, "status": req.status}


@router.patch("/{version_id}")
def patch_version(version_id: int, req: SavedVersionStatus, user: Annotated[Session, Depends(require_saver)]):
    """Archive a version or restore it (a restore counts towards its owner's limit of 10)."""
    return _set_status(version_id, req, user)


@router.delete("/{version_id}")
def delete_version(version_id: int, user: Annotated[Session, Depends(require_saver)]):
    """Delete a version for good, with its edits and snapshots: its owner or an ADMIN (as archiving)."""
    found = _store().get(version_id)
    if found is None:
        raise HTTPException(404, GONE)
    _own_or_403(user, found)
    if not _store().delete(version_id, _actor(user)):
        raise HTTPException(404, GONE)
    access.forget_version(version_id)
    audit.info("version deleted: user=%s version=%s", user.username, version_id)
    users.audit(user.username, "version.delete", str(version_id), {"name": found["name"]})
    return {"version_id": version_id, "deleted": True}


# Removal date of the old status route (RFC 8594 Sunset); the web app uses PATCH since 2 Nov 2026.
STATUS_ROUTE_SUNSET = "Sun, 31 Jan 2027 00:00:00 GMT"


@router.post("/{version_id}/status", deprecated=True)
def post_version_status(version_id: int, req: SavedVersionStatus, response: Response,
                        user: Annotated[Session, Depends(require_saver)]):
    """The same as PATCH /saved-versions/{id}; kept for clients built before it, until 31 Jan 2027."""
    response.headers["Deprecation"] = "true"
    response.headers["Sunset"] = STATUS_ROUTE_SUNSET
    return _set_status(version_id, req, user)
