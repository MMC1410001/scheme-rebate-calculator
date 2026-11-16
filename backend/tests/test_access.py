"""Who may change what (app/access.py, app/auth.py roles, migration 0002's row-level security)."""
import uuid
from datetime import date

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import access, auth, spi, users
from app.config import Settings
from app.main import app
from app.schemas import AdjustmentIn, PlanRequest, SlabLayout

SECRET = "s" * 40
ADMIN = auth.Session("boss", "ADMIN")
MANAGER = auth.Session("mira", "SCHEME_MANAGER", frozenset({"premium"}), 7)
VIEWER = auth.Session("vera", "VIEWER")
LAYOUT = SlabLayout(edges=[100.0], rates=[0.0, 2.0])


def scheme_edit(scheme: str, value: float = 5.0) -> AdjustmentIn:
    return AdjustmentIn(scope_kind="all", product=scheme, metric="gsr", mode="S", value=value)


def refused(user, req, request=None) -> str | None:
    try:
        access.check_request(user, req, request)
    except HTTPException as exc:
        assert exc.status_code == 403
        return exc.detail
    return None


# ---- The rules ------------------------------------------------------------------------------------------------------

def test_a_manager_edits_its_own_schemes_only():
    assert refused(MANAGER, PlanRequest(adjustments=[scheme_edit("premium")])) is None
    assert refused(MANAGER, PlanRequest(layouts={"premium::PREMIUM 01": LAYOUT})) is None
    assert "luxury" in refused(MANAGER, PlanRequest(adjustments=[scheme_edit("luxury")]))
    assert "luxury" in refused(MANAGER, PlanRequest(next_layouts={"luxury::LUXURY": LAYOUT}))


def test_product_total_v_and_removing_are_admin_only():
    product = AdjustmentIn(scope_kind="all", product="Luxury", metric="gsr", mode="P", value=5)
    total = AdjustmentIn(scope_kind="all", product="*", metric="gsr", mode="B", value=5)
    for req in (PlanRequest(adjustments=[product]), PlanRequest(adjustments=[total]),
                PlanRequest(volume_growth_pct=10), PlanRequest(removed_schemes=["premium"])):
        assert refused(MANAGER, req).startswith("Only an administrator")
        assert refused(ADMIN, req) is None


def test_a_viewer_edits_nothing_but_may_look():
    assert refused(VIEWER, PlanRequest(adjustments=[scheme_edit("premium")])).startswith("Your login can view")
    assert refused(VIEWER, PlanRequest()) is None


class _Request:
    def __init__(self, version_id):
        self.headers = {access.VERSION_HEADER: str(version_id)}


def test_an_opened_version_passes_with_its_own_edits_unchanged(monkeypatch):
    stored = access.adjustment_edits([scheme_edit("luxury")], "current")[0].keys
    monkeypatch.setattr(access, "version_keys", lambda vid: frozenset(stored) if vid == 42 else frozenset())
    req = PlanRequest(adjustments=[scheme_edit("luxury")])
    assert refused(MANAGER, req, _Request(42)) is None
    assert refused(VIEWER, req, _Request(42)) is None
    assert refused(MANAGER, PlanRequest(adjustments=[scheme_edit("luxury", 6.0)]), _Request(42)) is not None
    assert refused(MANAGER, req, _Request(41)) is not None
    with pytest.raises(HTTPException):   # saving: the opened version is no exception
        access.check(MANAGER, access.request_edits(req), _Request(42), allow_version=False)


# ---- Logins from the database ---------------------------------------------------------------------------------------

@pytest.fixture()
def db_users(monkeypatch):
    """Login set up with database users only: an ADMIN and a SCHEME_MANAGER of Premium."""
    settings = Settings(admin_session_secret=SECRET, session_cookie_secure=False)
    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    monkeypatch.setattr(auth, "APP_ENV", "dev")
    state = {"schemes": frozenset({"premium"}), "version": 1}
    monkeypatch.setattr(users, "active_users", lambda: (
        users.DbUser(1, "boss", "ADMIN", auth.hash_password("boss-pass-123", 10_000), 1, frozenset()),
        users.DbUser(7, "Mira", "SCHEME_MANAGER", MIRA_HASH, state["version"], state["schemes"]),
    ))
    auth.LIMITER.reset("testclient")
    for name in ("boss", "mira"):
        auth.USER_LIMITER.reset(f"{name}|testclient")
    return state


MIRA_HASH = auth.hash_password("mira-pass-123", 10_000)


def test_a_manager_logs_in_with_its_schemes_and_a_change_ends_the_session(db_users):
    client = TestClient(app)
    r = client.post("/v1/auth/login", json={"username": "mira", "password": "mira-pass-123"})
    assert r.status_code == 200
    assert r.json() == {"username": "Mira", "role": "SCHEME_MANAGER", "login_required": True,
                        "edit_schemes": ["premium"], "can_save": True, "can_see_dealers": True}
    assert client.get("/v1/auth/me").status_code == 200
    db_users["schemes"] = frozenset({"premium", "luxury"})
    db_users["version"] = 2
    assert client.get("/v1/auth/me").status_code == 401


def test_a_manager_cannot_calculate_another_schemes_edit(db_users):
    client = TestClient(app)
    client.post("/v1/auth/login", json={"username": "mira", "password": "mira-pass-123"})
    edit = {"scope_kind": "all", "product": "luxury", "metric": "gsr", "mode": "S", "value": 5}
    r = client.post("/v1/months", json={"adjustments": [edit]})
    assert r.status_code == 403 and "luxury" in r.json()["detail"]


def test_a_manager_changes_only_its_own_versions(db_users, monkeypatch):
    from app.spi import saved_versions as store

    monkeypatch.setattr(spi, "configured", lambda: True)
    found = {"version_id": 5, "created_by": "someone", "status": "SAVED", "base_month": date(2026, 11, 1)}
    monkeypatch.setattr(store, "get", lambda vid: found if vid == 5 else None)
    client = TestClient(app)
    client.post("/v1/auth/login", json={"username": "mira", "password": "mira-pass-123"})
    assert client.put("/v1/saved-versions/5", json={"name": "x"}).status_code == 403
    assert client.patch("/v1/saved-versions/5", json={"status": "ARCHIVED"}).status_code == 403


# ---- Row-level security in the database ---------------------------------------------------------------------------

def _bypasses_rls() -> bool:
    """A superuser (or BYPASSRLS) login skips row-level security, so it cannot show the policies at work."""
    with spi.connect() as conn:
        return conn.execute("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user").fetchone()[0]


@pytest.mark.skipif(not spi.configured(), reason="no database")
def test_the_database_refuses_a_managers_edit_of_another_scheme():
    import psycopg

    if _bypasses_rls():
        pytest.skip("SPI_DATABASE_URL logs in as a superuser, which bypasses row-level security; use the app's login")
    with spi.connect() as conn:   # one transaction, rolled back: nothing is kept
        try:
            conn.execute("SELECT set_config('spi.role', 'SCHEME_MANAGER', true), "
                         "set_config('spi.username', 'mira-test', true), set_config('spi.schemes', 'premium', true)")
            vid, = conn.execute("INSERT INTO spi.saved_version (name, base_month, created_by) VALUES (%s, %s, %s) "
                                "RETURNING version_id", (f"rls-{uuid.uuid4()}", date(2026, 11, 1),
                                                         "mira-test")).fetchone()
            conn.execute("INSERT INTO spi.saved_version_layout (version_id, period, scheme_key, component, layout) "
                         "VALUES (%s, 'current', 'premium', 'PREMIUM 01', '{}')", (vid,))
            conn.execute("SAVEPOINT s")
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute("INSERT INTO spi.saved_version_layout (version_id, period, scheme_key, component, "
                             "layout) VALUES (%s, 'current', 'luxury', 'LUXURY', '{}')", (vid,))
            conn.execute("ROLLBACK TO SAVEPOINT s")
            changed = conn.execute("UPDATE spi.saved_version SET note = 'x' WHERE created_by IS DISTINCT FROM "
                                   "'mira-test'").rowcount
            assert changed == 0
        finally:
            conn.rollback()
