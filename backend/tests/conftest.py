"""Tests run from backend/ (`python -m pytest`). APP_ENV=local unless set: no scheduled GCS sync, /docs on."""
import os
import sys
from pathlib import Path

os.environ.setdefault("APP_ENV", "local")
# The login comes from each test, never from the developer's env file (.env.local may turn login on): an empty value
# here wins over the file and means "not set" (app/config.py). The login tests set their own Settings.
for _key in ("ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_USERS", "ADMIN_SESSION_SECRET", "SESSION_COOKIE_SECURE"):
    os.environ[_key] = ""
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _no_database_users(monkeypatch):
    """No test reads the database's users or writes login and audit events into it: those tests set their own."""
    from app import users

    monkeypatch.setattr(users, "active_users", lambda: ())
    monkeypatch.setattr(users, "audit", lambda *a, **k: None)
    monkeypatch.setattr(users, "record_login", lambda *a, **k: None)
