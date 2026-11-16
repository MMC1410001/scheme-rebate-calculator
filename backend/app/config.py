"""Settings from environment variables or the APP_ENV's file, as in an earlier internal service.

Which file is read: backend/.env.local, .env.dev, .env.uat or .env.prod, by APP_ENV. APP_ENV not set reads no file and
fails closed (user's choice, 5 Nov 2026): login required (so every business route answers 503 until users are set),
no /docs, secure cookie, no scheduled sync. A developer machine sets APP_ENV=local.
Environment variables always win over the file, so a platform can also set everything directly.
"""
from __future__ import annotations

import base64
import binascii
import json
import os
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
APP_ENV = os.environ.get("APP_ENV") or "unset"
ENV_FILE = BACKEND_DIR / f".env.{APP_ENV}"


class Settings(BaseSettings):
    # hide_input_in_errors: a bad GCS_CREDENTIALS_JSON must not be printed in the start-up error.
    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore", hide_input_in_errors=True)

    # "verified" exposes only schemes whose computed CN reconciles against the file's own totals.
    scheme_mode: str = "all"
    # Pin the live month to a registered label (e.g. "2026-09-d25") instead of the newest synced
    # GCS file. Empty: the newest synced file, else the registry's "2026-09".
    live_month: str | None = None

    gcs_bucket: str = "example-scheme-files"
    # Optional Google Cloud project ID for the GCS client (not needed just to read the bucket).
    gcs_project: str | None = None
    # The service-account key itself, as in an earlier internal service: the key's JSON file as base64 on one
    # line (`base64 -i key.json` on macOS), or the JSON on one line. Wins over
    # GOOGLE_APPLICATION_CREDENTIALS (a key file path). Empty: the key file, else the server's own
    # service account.
    gcs_credentials_json: SecretStr | None = None
    # One month's folder. Only files directly in it are read, never its daily/ subfolder: not every
    # extract is copied into daily/, so the month folder is the complete set.
    gcs_prefix_template: str = "scheme-extracts/output/{year}/{month:02d}/"
    # Only the no-condonation file of each pair is read; the highest version wins. Named group
    # `version` is required. An optional `date` group (YYYYMMDD) is used as the extract date when a
    # name carries one; otherwise the upload date is.
    gcs_file_pattern: str = r"_v(?P<version>\d+)_no_condonation\.xlsx$"
    # Read the daily files from this local folder (same layout as the bucket) instead of GCS.
    # Development only.
    local_data_dir: str | None = None
    # Where synced files and their parquet caches are kept. Empty: backend/data/gcs.
    data_dir: str | None = None
    # "Today" for the loader is a day in this timezone, not the server's.
    timezone: str = "Asia/Kolkata"

    # Web app origins allowed to call the API (CORS), comma-separated, e.g. https://dev.example.com.
    # Empty: the local Vite dev server (http://localhost:5173 and http://127.0.0.1:5173).
    cors_origins: str | None = None
    # The data store: schema spi, in an existing database (dev: the shared app_db; local: spc-pg) or its own
    # (backend/db/scheme_performance_calculator/README.md). One login may be both URLs. Empty:
    # no database; the API runs from the synced files alone and versions cannot be saved.
    # spi_database_url is the app's login (reads and writes data); spi_owner_url the owner's (migrations and loads,
    # which create partitions).
    spi_database_url: SecretStr | None = None
    spi_owner_url: SecretStr | None = None
    # Where month data comes from: "files" (the parsed extracts, as before) or "spi" (the database, falling back
    # to the files for a month it does not hold).
    data_source: Literal["files", "spi"] = "files"

    # The API runs the loader on a schedule (app/scheduler.py), so no separate cron job is needed.
    # Unset: on everywhere except APP_ENV=local. Set false where a cron job runs the loader instead.
    loader_schedule_enabled: bool | None = None
    # Daily run time, HH:MM in TIMEZONE. The daily files land around 13:00-13:15 India time.
    loader_daily_at: str = "14:00"
    # A failed run is tried again this many times, this many minutes apart.
    loader_retries: int = 3
    loader_retry_minutes: int = 30
    # A run taking longer is stopped (and counts as failed).
    loader_timeout_minutes: int = 60
    # In the first days of a month the previous month is synced too: its final files arrive in the
    # first days of the next month (September's were dated 1, 3 and 4 October).
    loader_catch_up_days: int = 10
    # Months of data kept, the current one included: the current month plus the last 3 (agreed with
    # the user, 29 Oct 2026). Applies to the synced files on disk and to the Postgres data store. GCS
    # keeps every file, so only local copies are removed. 0 keeps everything.
    loader_retention_months: int = 4
    # Saved what-if versions (app/spi/saved_versions.py): the months of versions kept, the live month included. 3 keeps
    # the live month's versions and the two months' before it (Nov live: Sep, Oct, Nov); a version saved in an older
    # month is deleted, saved or archived, with its edits and snapshots (user's rule, 6 Nov 2026). 0 keeps everything.
    # SCENARIO_RETENTION_MONTHS, its name before versions, is still read.
    version_retention_months: int = Field(3, validation_alias=AliasChoices(
        "version_retention_months", "scenario_retention_months"))

    # Login (app/auth.py, as in an earlier internal app). The built-in admin, role ADMIN: ADMIN_USERNAME / ADMIN_PASSWORD.
    admin_username: str | None = None
    admin_password: SecretStr | None = None
    # More users: a JSON object {"<username>": {"role": "ADMIN" | "VIEWER", "password": "<pbkdf2 hash>"}} on one line;
    # `python -m app.auth_user <username> [ADMIN|VIEWER]` makes an entry.
    admin_users: SecretStr | None = None
    # Signs the session cookie: at least 32 random characters (`python -c "import secrets; print(secrets.token_urlsafe(48))"`).
    # Changing it logs everyone out.
    admin_session_secret: SecretStr | None = None
    # The session cookie only over HTTPS. Empty: on everywhere except APP_ENV=local. Set false only for a server
    # reached over plain HTTP (the browser would otherwise never send the cookie back).
    session_cookie_secure: bool | None = None
    # Proxies whose X-Forwarded-For is believed for the login limit (app/auth.py), comma-separated IPs or host names.
    # Empty: this machine and the web container of docker-compose.yml (scheme-performance-web). Any other caller,
    # such as another container on the shared network, is limited by its own address.
    trusted_proxies: str | None = None

    @property
    def loader_schedule_on(self) -> bool:
        if self.loader_schedule_enabled is None:
            return APP_ENV not in ("local", "unset")
        return self.loader_schedule_enabled

    @property
    def cors_origin_list(self) -> list[str]:
        origins = [o.strip().rstrip("/") for o in (self.cors_origins or "").split(",") if o.strip()]
        return origins or ["http://localhost:5173", "http://127.0.0.1:5173"]

    @property
    def trusted_proxy_list(self) -> list[str]:
        names = [n.strip() for n in (self.trusted_proxies or "").split(",") if n.strip()]
        return names or ["127.0.0.1", "::1", "scheme-performance-web"]

    @property
    def data_path(self) -> Path:
        return Path(self.data_dir) if self.data_dir else BACKEND_DIR / "data" / "gcs"

    @property
    def gcs_credentials_info(self) -> dict | None:
        """GCS_CREDENTIALS_JSON as the key's JSON object, or None when it is not set."""
        return None if self.gcs_credentials_json is None else _service_account_info(
            self.gcs_credentials_json.get_secret_value())

    @field_validator("loader_schedule_enabled", "live_month", "gcs_project", "local_data_dir",
                     "data_dir", "cors_origins", "admin_username", "session_cookie_secure", "trusted_proxies",
                     mode="before")
    @classmethod
    def _empty_is_default(cls, value):
        """KEY= (as in .env.example) means the default, not an invalid or empty value."""
        return None if isinstance(value, str) and not value.strip() else value

    @field_validator("loader_daily_at")
    @classmethod
    def _parse_daily_at(cls, value: str) -> str:
        """HH:MM, checked at start-up so a typo stops the API instead of silently never loading."""
        parsed = datetime.strptime(value.strip(), "%H:%M").time()
        return f"{parsed.hour:02d}:{parsed.minute:02d}"

    @field_validator("gcs_credentials_json", "spi_database_url", "spi_owner_url", "admin_password", "admin_users",
                     "admin_session_secret", mode="before")
    @classmethod
    def _empty_secret_is_unset(cls, value):
        return None if isinstance(value, str) and not value.strip() else value

    @field_validator("gcs_credentials_json")
    @classmethod
    def _check_gcs_credentials(cls, value: SecretStr | None) -> SecretStr | None:
        """Checked at start-up so a bad key stops the API, not the scheduled load."""
        if value is not None:
            _service_account_info(value.get_secret_value())
        return value


def _service_account_info(text: str) -> dict:
    """The key's JSON object from base64 or plain JSON; ValueError (without the key) if it is neither."""
    text = text.strip()
    try:
        info = json.loads(text if text.startswith("{") else base64.b64decode(text, validate=True))
    except (ValueError, binascii.Error):
        raise ValueError("GCS_CREDENTIALS_JSON is neither base64 of the key file nor its JSON") from None
    if not isinstance(info, dict) or not {"client_email", "private_key"} <= info.keys():
        raise ValueError("GCS_CREDENTIALS_JSON is not a service-account key (client_email, private_key missing)")
    return info


@lru_cache
def get_settings() -> Settings:
    return Settings()
