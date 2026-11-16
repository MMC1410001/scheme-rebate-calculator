"""Users kept in the database (spi.app_user, spi.user_scheme): roles and the schemes each scheme manager may edit.

Read by the API (app/auth.py) through a short cache; changed only with `python -m app.auth_user` (the owner's login).
Without a database, or when it cannot be reached, there are no database users and the env file's users still work.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

from psycopg.types.json import Jsonb

log = logging.getLogger("app.users")

CACHE_SECONDS = 15


@dataclass(frozen=True)
class DbUser:
    user_id: int
    username: str
    role: str
    password_hash: str
    access_version: int
    schemes: frozenset[str]


_cache: dict = {"at": -1e9, "users": ()}
_lock = threading.Lock()
_warned = {"down": False}

_SELECT = ("SELECT u.user_id, u.username, u.role, u.password_hash, u.access_version, "
           "coalesce(array_agg(s.code ORDER BY s.code) FILTER (WHERE s.code IS NOT NULL), '{}') "
           "FROM spi.app_user u LEFT JOIN spi.user_scheme us USING (user_id) LEFT JOIN spi.scheme s USING (scheme_id) "
           "WHERE u.active GROUP BY u.user_id")


def active_users() -> tuple[DbUser, ...]:
    """The active database users (cached CACHE_SECONDS); none without a database or when it cannot be reached."""
    from app import spi

    if not spi.configured():
        return ()
    now = time.monotonic()
    with _lock:
        if now - _cache["at"] < CACHE_SECONDS:
            return _cache["users"]
    try:
        with spi.connection() as conn:
            rows = conn.execute(_SELECT).fetchall()
        users = tuple(DbUser(i, n, r, h, v, frozenset(s)) for i, n, r, h, v, s in rows)
        _warned["down"] = False
    except Exception as exc:  # the env file's users still log in; the reason is logged once
        if not _warned["down"]:
            log.warning("database users unavailable: %s", type(exc).__name__)
            _warned["down"] = True
        with _lock:
            return _cache["users"]
    with _lock:
        _cache.update(at=now, users=users)
    return users


def forget() -> None:
    """Drop the cache (tests, and right after a change made in this process)."""
    with _lock:
        _cache.update(at=-1e9, users=())


def record_login(user_id: int) -> None:
    from app import spi

    try:
        with spi.connection() as conn:
            conn.execute("UPDATE spi.app_user SET last_login_at = now() WHERE user_id = %s", (user_id,))
    except Exception:
        log.warning("could not record the login of user %s", user_id)


def audit(username: str | None, action: str, target: str | None = None, detail: dict | None = None) -> None:
    """One event in spi.audit_log; never fails the request that caused it."""
    from app import spi

    if not spi.configured():
        return
    try:
        with spi.connection() as conn:
            conn.execute("INSERT INTO spi.audit_log (username, action, target, detail) VALUES (%s, %s, %s, %s)",
                         (username, action, target, Jsonb(detail) if detail is not None else None))
    except Exception:
        log.warning("could not write the audit event %s", action)
