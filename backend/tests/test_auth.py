"""Login and roles (app/auth.py, app/routers/auth.py). No month is built: every check runs before a route's work."""
import json

import pytest
from fastapi.testclient import TestClient

from app import auth
from app.config import Settings
from app.main import app

SECRET = "s" * 40
VIEWER_PASSWORD = "viewer-pass-123"


@pytest.fixture()
def login_on(monkeypatch):
    """Login set up: the built-in admin and one VIEWER, as on a server."""
    users = json.dumps({"vera": {"role": "VIEWER", "password": auth.hash_password(VIEWER_PASSWORD, 10_000)}})
    settings = Settings(admin_username="admin", admin_password="admin-pass-123", admin_users=users,
                        admin_session_secret=SECRET, session_cookie_secure=False)
    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    monkeypatch.setattr(auth, "APP_ENV", "dev")
    auth.LIMITER.reset("testclient")
    for name in ("admin", "vera"):
        auth.USER_LIMITER.reset(f"{name}|testclient")
    return settings


def _client() -> TestClient:
    return TestClient(app)


def _login(client, username, password):
    return client.post("/v1/auth/login", json={"username": username, "password": password})


# ---- Passwords and sessions -----------------------------------------------------------------------------------------

def test_password_hash_round_trip():
    stored = auth.hash_password("correct horse", 10_000)
    assert stored.startswith("pbkdf2-sha256:10000:")
    assert auth._check_hash("correct horse", stored)
    assert not auth._check_hash("wrong", stored)


def test_bad_user_entries_are_reported_without_secrets():
    users, problems = auth.parse_users(None, None, '{"bad name!": {}, "ok": {"role": "BOSS", "password": "x"}}')
    assert users == [] and len(problems) == 2
    assert not any("password\": \"x" in p for p in problems)


def test_session_cookie_round_trip_and_tampering(login_on):
    user = auth.authenticate("vera", VIEWER_PASSWORD)
    value = auth.session_cookie(user)
    assert auth.read_session(value) == auth.Session("vera", "VIEWER")
    part, sig = value.split(".")
    assert auth.read_session(part + "." + sig[:-2] + "AA") is None          # forged signature
    assert auth.read_session(value, now=10**10) is None                      # expired


def test_changing_a_password_ends_that_users_sessions(login_on, monkeypatch):
    value = auth.session_cookie(auth.authenticate("admin", "admin-pass-123"))
    changed = login_on.model_copy(update={"admin_password": login_on.admin_password.__class__("new-pass-456")})
    monkeypatch.setattr(auth, "get_settings", lambda: changed)
    assert auth.read_session(value) is None


def test_failed_logins_are_limited_per_address():
    limiter = auth.LoginLimiter(max_failures=3, window=60)
    for _ in range(3):
        assert limiter.allowed("1.2.3.4", now=100)
        limiter.failed("1.2.3.4", now=100)
    assert not limiter.allowed("1.2.3.4", now=120)
    assert limiter.allowed("5.6.7.8", now=120)
    assert limiter.allowed("1.2.3.4", now=200)      # the window has passed


# ---- Routes ---------------------------------------------------------------------------------------------------------

def test_business_routes_need_a_login(login_on):
    r = _client().get("/v1/schemes")
    assert r.status_code == 401 and r.json()["detail"] == auth.NOT_LOGGED_IN


def test_wrong_password_is_refused_in_plain_words(login_on):
    r = _login(_client(), "admin", "nope")
    assert r.status_code == 401 and r.json()["detail"] == auth.WRONG
    assert auth.COOKIE not in r.cookies


def test_login_sets_an_httponly_strict_cookie_and_me_answers(login_on):
    client = _client()
    r = _login(client, "admin", "admin-pass-123")
    assert r.status_code == 200 and r.json() == {"username": "admin", "role": "ADMIN", "login_required": True,
                                                 "edit_schemes": None, "can_save": True, "can_see_dealers": True}
    header = r.headers["set-cookie"].lower()
    assert "httponly" in header and "samesite=strict" in header
    assert client.get("/v1/auth/me").json()["role"] == "ADMIN"
    assert client.post("/v1/auth/logout", json={}).status_code == 204
    assert client.get("/v1/auth/me").status_code == 401


def test_too_many_failed_logins_answer_429(login_on):
    client = _client()
    for _ in range(auth.LOGIN_MAX_FAILURES):
        _login(client, "admin", "nope")
    r = _login(client, "admin", "admin-pass-123")
    assert r.status_code == 429 and "Too many attempts" in r.json()["detail"]


def test_a_viewer_cannot_list_dealers_or_save(login_on):
    client = _client()
    _login(client, "vera", VIEWER_PASSWORD)
    row = {"slab_mode": "slab", "cn_rate": 1.0}
    r = client.post("/v1/dealers", json={"scheme": "luxury", "component": "X", "row": row})
    assert r.status_code == 403 and r.json()["detail"] == auth.NOT_ALLOWED
    assert client.post("/v1/saved-versions", json={"name": "v"}).status_code == 403
    assert client.patch("/v1/saved-versions/1", json={"status": "ARCHIVED"}).status_code == 403
    assert client.get("/v1/saved-versions/1/dealers").status_code == 403


def test_posts_must_be_json(login_on):
    client = _client()
    _login(client, "admin", "admin-pass-123")
    r = client.post("/v1/months", content=b"adjustments=1", headers={"content-type": "application/x-www-form-urlencoded"})
    assert r.status_code == 415


def test_login_not_set_up_on_a_server_refuses_everything(monkeypatch):
    monkeypatch.setattr(auth, "get_settings", lambda: Settings())
    monkeypatch.setattr(auth, "APP_ENV", "dev")
    r = _client().get("/v1/schemes")
    assert r.status_code == 503 and r.json()["detail"] == auth.NOT_SET_UP
    assert "ADMIN_SESSION_SECRET is not set" in auth.config_problems()


def test_login_body_limit_is_small(login_on):
    r = _client().post("/v1/auth/login", content=b"x" * 20_000, headers={"content-type": "application/json"})
    assert r.status_code == 413


# ---- Hardening (review of 5 Nov 2026) -------------------------------------------------------------------------------

def test_plain_admin_password_is_refused_on_uat_and_prod(monkeypatch):
    monkeypatch.setattr(auth, "APP_ENV", "prod")
    users, problems = auth.parse_users("admin", "plain-text-password", None)
    assert users == [] and any("hash" in p for p in problems)
    hashed = auth.hash_password("right-password", 10_000)
    users, problems = auth.parse_users("admin", hashed, None)
    assert [u.username for u in users] == ["admin"] and not problems


def test_hashed_admin_password_logs_in(monkeypatch):
    settings = Settings(admin_username="admin", admin_password=auth.hash_password("right-password", 10_000),
                        admin_session_secret=SECRET, session_cookie_secure=False)
    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    monkeypatch.setattr(auth, "APP_ENV", "prod")
    assert auth.authenticate("admin", "right-password") is not None
    assert auth.authenticate("admin", "wrong") is None


def test_logout_revokes_the_cookie_on_the_server(login_on):
    client = _client()
    assert _login(client, "admin", "admin-pass-123").status_code == 200
    cookie = client.cookies.get(auth.COOKIE)
    assert client.post("/v1/auth/logout", json={}).status_code == 204
    copy = _client()
    copy.cookies.set(auth.COOKIE, cookie)
    assert copy.get("/v1/auth/me").status_code == 401


def test_forwarded_for_is_ignored_unless_the_caller_is_a_trusted_proxy(monkeypatch):
    class Req:
        def __init__(self, peer):
            self.client = type("C", (), {"host": peer})()
            self.headers = {"x-forwarded-for": "1.2.3.4, 10.0.0.9"}

    monkeypatch.setattr(auth, "trusted_proxies", lambda: frozenset({"172.18.0.5"}))
    assert auth.client_ip(Req("172.18.0.5")) == "10.0.0.9"     # nginx: its own entry is believed
    assert auth.client_ip(Req("172.18.0.7")) == "172.18.0.7"   # anyone else: the connection's address


def test_wrong_passwords_from_elsewhere_do_not_lock_the_real_user_out(login_on, monkeypatch):
    """Per username and address (user's choice, 5 Nov 2026): failures for "admin" from many addresses do not refuse
    the admin's right password from their own address."""
    addresses = iter(f"10.0.0.{i}" for i in range(100))
    monkeypatch.setattr(auth, "client_ip", lambda _request: next(addresses))
    client = _client()
    for _ in range(auth.USER_MAX_FAILURES * 2):
        assert _login(client, "admin", "wrong").status_code == 401
    monkeypatch.setattr(auth, "client_ip", lambda _request: "10.9.9.9")
    assert _login(client, "admin", "admin-pass-123").status_code == 200
    for ip in [f"10.0.0.{i}" for i in range(100)] + ["10.9.9.9"]:
        auth.LIMITER.reset(ip)
        auth.USER_LIMITER.reset(f"admin|{ip}")


def test_failed_logins_from_one_address_are_limited(login_on, monkeypatch):
    monkeypatch.setattr(auth, "client_ip", lambda _request: "10.8.8.8")
    client = _client()
    for _ in range(auth.LOGIN_MAX_FAILURES):
        assert _login(client, "admin", "wrong").status_code == 401
    assert _login(client, "admin", "admin-pass-123").status_code == 429
    auth.LIMITER.reset("10.8.8.8")
    auth.USER_LIMITER.reset("admin|10.8.8.8")


def test_parallel_attempts_are_counted_as_they_start():
    limiter = auth.LoginLimiter(max_failures=3)
    assert [limiter.begin("x") for _ in range(5)] == [True, True, True, False, False]
    limiter.reset("x")
    assert limiter.begin("x")


def test_a_cookie_that_is_not_ascii_is_refused_not_a_500(login_on):
    assert auth.read_session("abc.\u00e9\u00e9") is None
    client = _client()
    client.cookies.set(auth.COOKIE, "abc.ee")
    assert client.get("/v1/auth/me").status_code == 401


def test_no_app_env_fails_closed(monkeypatch):
    """APP_ENV not set (user's choice, 5 Nov 2026): no users means "not set up" (503), never login off."""
    monkeypatch.setattr(auth, "APP_ENV", "unset")
    monkeypatch.setattr(auth, "get_settings", lambda: Settings(admin_username=None, admin_password=None,
                                                               admin_users=None, admin_session_secret=None))
    assert auth.mode() == "not_set_up"
    assert auth.cookie_secure()
