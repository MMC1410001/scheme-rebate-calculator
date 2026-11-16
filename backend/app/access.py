"""What a login may change (roles in app/auth.py; user's rules, 5 Nov 2026).

- ADMIN: every edit.
- SCHEME_MANAGER: only its own schemes and their components: slab tables (rates, boundaries, figures), a scheme's
  Volume / GSR / CN (modes S and C), a gift scheme's rule. Product and total edits, V (next month's volume change)
  and removing schemes are ADMIN only. (The Plan's sales-target calculator changes nothing and is open to all.)
- VIEWER: no edit.

Every request carrying edits is checked, also those that only calculate: an edit the login may not make is refused
(403), whatever sent it. One exception: a login may open someone else's saved version, so a request naming it
(header X-Version-Id) may carry that version's own edits, unchanged.
"""
from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterable
from dataclasses import dataclass

from fastapi import HTTPException, Request

from app.auth import Session

VERSION_HEADER = "x-version-id"
SCHEME_MODES = ("S", "C")


@dataclass(frozen=True)
class Edit:
    scheme: str | None      # the scheme it changes; None: product, total or global (ADMIN only)
    what: str               # for the refusal message
    keys: tuple[str, ...] = ()  # how a saved version stores it (any of them; none: never in a version)


def _num(v) -> float:
    return round(float(v), 9)


def _adj_key(period: str, a: dict) -> str:
    return json.dumps([period, a["scope_kind"], a["scope_value"] or "", a["product"], a["metric"], a["mode"],
                       a["adjust_type"], _num(a["value"])])


def _layout_key(period: str, key: str, layout: dict) -> str:
    return json.dumps([period, key, json.loads(json.dumps(layout))], sort_keys=True)


def adjustment_edits(adjustments: Iterable, period: str) -> list[Edit]:
    out = []
    for a in adjustments:
        d = a if isinstance(a, dict) else a.model_dump()
        scheme = d["product"] if d["mode"] in SCHEME_MODES else None
        what = f"the scheme {scheme}" if scheme else ("the total" if d["mode"] == "B" else f"the product {d['product']}")
        out.append(Edit(scheme, what, (_adj_key(period, d),)))
    return out


def layout_edits(layouts: dict, period: str) -> list[Edit]:
    out = []
    for key, layout in layouts.items():
        args = layout if isinstance(layout, dict) else layout.engine_args()
        scheme = key.split("::", 1)[0]
        out.append(Edit(scheme, f"the slab table of {key.replace('::', ' · ')}", (_layout_key(period, key, args),)))
    return out


def plan_edits(volume_growth_pct: float = 0.0, removed_schemes: Iterable[str] = ()) -> list[Edit]:
    out = []
    if volume_growth_pct:
        out.append(Edit(None, "next month's volume change (V)", (json.dumps(["V", _num(volume_growth_pct)]),)))
    out += [Edit(None, f"removing the scheme {k}", (json.dumps(["removed", k]),)) for k in removed_schemes]
    return out


def request_edits(req) -> list[Edit]:
    """The edits a request body carries (any of the API's request models)."""
    out: list[Edit] = []
    out += adjustment_edits(getattr(req, "adjustments", None) or [], "current")
    out += adjustment_edits(getattr(req, "next_adjustments", None) or [], "next")
    out += layout_edits(getattr(req, "layouts", None) or {}, "current")
    out += layout_edits(getattr(req, "next_layouts", None) or {}, "next")
    out += plan_edits(getattr(req, "volume_growth_pct", 0.0) or 0.0, getattr(req, "removed_schemes", None) or [])
    for period in ("current", "next"):   # the month table's product edits (/months/edited)
        edits = getattr(req, period, None)
        if isinstance(edits, dict):
            out += [Edit(None, f"the product {p}") for p in edits]
    return out


# ---- A saved version's own edits ------------------------------------------------------------------------------------

_versions: dict[int, tuple[float, frozenset[str]]] = {}
_versions_lock = threading.Lock()
VERSION_CACHE_SECONDS = 30


def version_keys(version_id: int) -> frozenset[str]:
    """The keys of everything a saved version stores (cached briefly; a version that is gone has none)."""
    now = time.monotonic()
    with _versions_lock:
        hit = _versions.get(version_id)
        if hit and now - hit[0] < VERSION_CACHE_SECONDS:
            return hit[1]
    from app import spi
    from app.spi import saved_versions as store

    keys: frozenset[str] = frozenset()
    if spi.configured() and store.get(version_id) is not None:
        d = store.definition(version_id)
        edits = (adjustment_edits(d["adjustments"], "current") + adjustment_edits(d["next_adjustments"], "next")
                 + layout_edits(d["layouts"], "current") + layout_edits(d["next_layouts"], "next")
                 + plan_edits(d["volume_growth_pct"], d["removed_schemes"]))
        keys = frozenset(k for e in edits for k in e.keys)
    with _versions_lock:
        if len(_versions) > 1000:
            _versions.clear()
        _versions[version_id] = (now, keys)
    return keys


def forget_version(version_id: int) -> None:
    with _versions_lock:
        _versions.pop(version_id, None)


def _opened_version(request: Request | None) -> int | None:
    raw = request.headers.get(VERSION_HEADER, "") if request is not None else ""
    return int(raw) if raw.isdigit() and len(raw) < 10 else None


# ---- The check ------------------------------------------------------------------------------------------------------

def refusal(user: Session, edit: Edit) -> str:
    if user.role == "VIEWER":
        return "Your login can view, but not edit. Ask an administrator."
    if edit.scheme is None:
        return f"Only an administrator can change {edit.what}."
    return f"Your login cannot edit {edit.what}: only its scheme manager or an administrator can."


def check(user: Session, edits: Iterable[Edit], request: Request | None = None, allow_version: bool = True) -> None:
    """Refuse (403) the first edit this login may not make. allow_version: a request naming a saved version
    (X-Version-Id) may carry that version's own edits unchanged (not when saving)."""
    if user.is_admin:
        return
    version_id = _opened_version(request) if allow_version else None
    allowed: frozenset[str] | None = None
    for e in edits:
        if e.scheme is not None and user.can_edit_scheme(e.scheme):
            continue
        if version_id is not None and e.keys:
            if allowed is None:
                allowed = version_keys(version_id)
            if any(k in allowed for k in e.keys):
                continue
        raise HTTPException(403, refusal(user, e))


def table_edit(scheme: str, component: str, layout: dict) -> Edit:
    """A slab table sent to be read (a dealer list): the current month's or next month's, whichever a version has."""
    key = f"{scheme}::{component}"
    return Edit(scheme, f"the slab table of {scheme} · {component}",
                (_layout_key("current", key, layout), _layout_key("next", key, layout)))


def check_request(user: Session, req, request: Request | None = None) -> None:
    check(user, request_edits(req), request)


def check_scheme(user: Session, scheme: str, what: str, request: Request | None = None) -> None:
    check(user, [Edit(scheme, what)], request)


def check_global(user: Session, what: str) -> None:
    check(user, [Edit(None, what)])
