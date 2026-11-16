"""Local set-up of the spi database: `python -m app.spi.setup_local` (run from backend/; development only).

Asks for a Postgres superuser login (postgresql://user:password@host:port/db, typed in hidden, or SPI_SUPERUSER_URL
in the shell's environment for a script; never read from or written to an env file) and uses it only to create two
logins and a new database:
spi_owner (owns the database; runs migrations and loads) and spi_app (the API: reads and writes data). Passwords are
generated and written to backend/.env.<APP_ENV> as SPI_OWNER_URL and SPI_DATABASE_URL; nothing is printed. The
existing database and its schema are not touched. Running it again keeps existing logins and passwords.
"""
from __future__ import annotations

import getpass
import os
import re
import secrets
import sys
from urllib.parse import quote, urlsplit, urlunsplit

import psycopg
from psycopg import sql

from app.config import ENV_FILE, get_settings

DATABASE = "scheme_performance_calculator"
ROLES = ("spi_owner", "spi_app")


def _set_env(key: str, value: str) -> None:
    text = ENV_FILE.read_text(encoding="utf-8")
    line = f"{key}={value}"
    if re.search(rf"(?m)^{key}=", text):
        text = re.sub(rf"(?m)^{key}=.*$", lambda _: line, text)
    else:
        text = text.rstrip("\n") + "\n" + line + "\n"
    ENV_FILE.write_text(text, encoding="utf-8", newline="")


def main() -> int:
    settings = get_settings()
    url = os.environ.get("SPI_SUPERUSER_URL") or getpass.getpass("Postgres superuser URL (hidden): ").strip()
    if not url:
        print("A superuser login is needed to create the spi logins and database")
        return 1
    admin = urlsplit(url)
    server = urlunsplit((admin.scheme, admin.netloc, "/postgres", "", ""))
    created = []
    with psycopg.connect(server, autocommit=True) as conn:
        for role in ROLES:
            key = "SPI_OWNER_URL" if role == "spi_owner" else "SPI_DATABASE_URL"
            exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,)).fetchone()
            if exists and (getattr(settings, key.lower()) is not None):
                continue
            password = secrets.token_urlsafe(24)
            verb = "ALTER" if exists else "CREATE"
            conn.execute(sql.SQL(verb + " ROLE {} LOGIN PASSWORD {}").format(sql.Identifier(role), sql.Literal(password)))
            netloc = f"{role}:{quote(password, safe='')}@{admin.hostname}:{admin.port or 5432}"
            _set_env(key, urlunsplit(("postgresql", netloc, f"/{DATABASE}", "", "")))
            created.append(role)
        if not conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (DATABASE,)).fetchone():
            conn.execute(sql.SQL("CREATE DATABASE {} OWNER spi_owner").format(sql.Identifier(DATABASE)))
            created.append(DATABASE)
        conn.execute(sql.SQL("REVOKE CONNECT ON DATABASE {} FROM PUBLIC").format(sql.Identifier(DATABASE)))
        conn.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO spi_owner, spi_app").format(sql.Identifier(DATABASE)))
    if "DATA_SOURCE=" not in ENV_FILE.read_text(encoding="utf-8"):
        _set_env("DATA_SOURCE", "files")
    print("created / reset: " + (", ".join(created) or "nothing (already set up)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
