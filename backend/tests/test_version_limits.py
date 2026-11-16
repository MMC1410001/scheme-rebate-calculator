"""Saved versions: 10 per login (not archived), delete by hand, and retention of the live month and the two before
it (user's rules, 6 Nov 2026; app/spi/saved_versions.py, app/routers/saved_versions.py)."""
import uuid
from contextlib import contextmanager
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app import auth, spi, users
from app.config import Settings
from app.main import app
from app.service import saved_versions as service
from app.spi import saved_versions as store

# Fixed hashes: a session is tied to its user's hash, so a hash made again on each lookup would end it.
BOSS_HASH = auth.hash_password("boss-pass-123", 10_000)
MIRA_HASH = auth.hash_password("mira-pass-123", 10_000)


@pytest.fixture()
def db_users(monkeypatch):
    """Login with database users only: an ADMIN "boss" and a SCHEME_MANAGER "Mira" of Premium."""
    settings = Settings(admin_session_secret="s" * 40, session_cookie_secure=False)
    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    monkeypatch.setattr(auth, "APP_ENV", "dev")
    monkeypatch.setattr(users, "active_users", lambda: (
        users.DbUser(1, "boss", "ADMIN", BOSS_HASH, 1, frozenset()),
        users.DbUser(7, "Mira", "SCHEME_MANAGER", MIRA_HASH, 1, frozenset({"premium"})),
    ))
    auth.LIMITER.reset("testclient")
    for name in ("boss", "mira"):
        auth.USER_LIMITER.reset(f"{name}|testclient")


def login(client: TestClient, name: str) -> None:
    assert client.post("/v1/auth/login", json={"username": name, "password": f"{name}-pass-123"}).status_code == 200


@contextmanager
def _no_conn():
    yield object()


# ---- Retention window -------------------------------------------------------------------------------------------------

def test_the_live_month_and_the_two_before_it_are_kept():
    assert store.retention_cutoff(date(2026, 11, 1), 3) == date(2026, 9, 1)
    assert store.retention_cutoff(date(2027, 1, 1), 3) == date(2026, 11, 1)
    assert store.retention_cutoff(date(2026, 11, 1), 1) == date(2026, 11, 1)


# ---- The limit of 10 --------------------------------------------------------------------------------------------------

def test_an_eleventh_version_is_refused_in_plain_words(db_users, monkeypatch):
    monkeypatch.setattr(spi, "configured", lambda: True)
    monkeypatch.setattr(spi, "connection", _no_conn)
    monkeypatch.setattr(store, "name_taken", lambda conn, name, vid=None: False)
    counted = []
    monkeypatch.setattr(store, "open_count", lambda conn, owner, vid=None: counted.append(owner) or 10)
    client = TestClient(app)
    login(client, "mira")
    r = client.post("/v1/saved-versions", json={"name": "one more"})
    assert r.status_code == 409
    assert r.json()["detail"].startswith("You already have 10 saved versions")
    assert counted == ["Mira"]


def test_a_restore_past_the_owners_limit_is_refused(db_users, monkeypatch):
    monkeypatch.setattr(spi, "configured", lambda: True)
    found = {"version_id": 5, "name": "v", "created_by": "Mira", "status": "ARCHIVED", "base_month": date(2026, 11, 1)}
    monkeypatch.setattr(store, "get", lambda vid: found if vid == 5 else None)

    def full(vid, status, actor=None):
        raise store.LimitReached("Mira")
    monkeypatch.setattr(store, "set_status", full)
    client = TestClient(app)
    login(client, "boss")
    r = client.patch("/v1/saved-versions/5", json={"status": "SAVED"})
    assert r.status_code == 409 and r.json()["detail"].startswith("Mira already has 10 saved versions")


def test_limit_text_names_the_owner_only_for_someone_else():
    assert service.limit_text("mira", "MIRA").startswith("You already have")
    assert service.limit_text("mira", "boss").startswith("mira already has")


# ---- Delete -----------------------------------------------------------------------------------------------------------

def test_delete_is_for_the_owner_or_an_admin(db_users, monkeypatch):
    monkeypatch.setattr(spi, "configured", lambda: True)
    versions = {5: {"version_id": 5, "name": "theirs", "created_by": "someone", "status": "SAVED",
                    "base_month": date(2026, 11, 1)},
                6: {"version_id": 6, "name": "mine", "created_by": "Mira", "status": "ARCHIVED",
                    "base_month": date(2026, 11, 1)}}
    deleted = []
    monkeypatch.setattr(store, "get", lambda vid: versions.get(vid))
    monkeypatch.setattr(store, "delete", lambda vid, actor=None: deleted.append(vid) or True)
    client = TestClient(app)
    login(client, "mira")
    assert client.request("DELETE", "/v1/saved-versions/5", json={}).status_code == 403
    r = client.request("DELETE", "/v1/saved-versions/6", json={})
    assert r.status_code == 200 and r.json() == {"version_id": 6, "deleted": True}
    assert client.request("DELETE", "/v1/saved-versions/99", json={}).status_code == 404
    assert client.request("DELETE", "/v1/saved-versions/6").status_code == 415   # unsafe methods must be JSON
    login(client, "boss")
    assert client.request("DELETE", "/v1/saved-versions/5", json={}).status_code == 200
    assert deleted == [6, 5]


# ---- In the database (rolled back or removed afterwards) -----------------------------------------------------------

@pytest.mark.skipif(not spi.configured(), reason="no database")
def test_the_database_holds_ten_open_versions_per_login():
    owner = f"limit-{uuid.uuid4().hex[:8]}"
    with spi.connect() as conn:
        try:
            ids = [conn.execute("INSERT INTO spi.saved_version (name, base_month, created_by) VALUES (%s, %s, %s) "
                                "RETURNING version_id", (f"{owner}-{i}", date(2026, 11, 1), owner)).fetchone()[0]
                   for i in range(store.MAX_VERSIONS_PER_USER)]
            with pytest.raises(store.LimitReached):
                store._check_limit(conn, owner.upper())        # case ignored
            store._check_limit(conn, owner, exclude_id=ids[0])  # a re-check of one of the ten passes
            conn.execute("UPDATE spi.saved_version SET status = 'ARCHIVED' WHERE version_id = %s", (ids[0],))
            store._check_limit(conn, owner)                     # archived ones do not count
        finally:
            conn.rollback()


@pytest.mark.skipif(not spi.configured(), reason="no database")
def test_prune_deletes_versions_before_the_window_saved_or_archived():
    tag = f"prune-{uuid.uuid4().hex[:8]}"
    rows = [("aug", date(2026, 8, 1), "SAVED"), ("aug-archived", date(2026, 8, 1), "ARCHIVED"),
            ("sep", date(2026, 9, 1), "SAVED")]
    with spi.connect() as conn:
        ids = {n: conn.execute("INSERT INTO spi.saved_version (name, base_month, status, created_by) "
                               "VALUES (%s, %s, %s, %s) RETURNING version_id",
                               (f"{tag}-{n}", m, s, tag)).fetchone()[0] for n, m, s in rows}
    try:
        out = store.prune(date(2026, 11, 1), dry_run=True)   # rolled back: nothing is deleted
        gone = {d["version_id"] for d in out["deleted"]}
        assert out["keep_from"] == "2026-09-01"
        assert {ids["aug"], ids["aug-archived"]} <= gone and ids["sep"] not in gone
    finally:
        with spi.connect() as conn:
            conn.execute("DELETE FROM spi.saved_version WHERE created_by = %s", (tag,))
