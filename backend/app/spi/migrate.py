"""Apply the numbered migrations in order: `python -m app.spi.migrate` (run from backend/; uses SPI_OWNER_URL).

Each file in backend/db/scheme_performance_calculator/migrations/ runs once, in its own transaction, and is recorded in spi.schema_migration with a checksum.
A recorded file whose content has changed stops the run: a migration is never edited after it is applied; a new one
is added instead.
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

from app.spi import connect

MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "scheme_performance_calculator" / "migrations"


def migrate() -> list[str]:
    applied: list[str] = []
    with connect(owner=True) as conn:
        conn.execute("CREATE SCHEMA IF NOT EXISTS spi")
        conn.execute("CREATE TABLE IF NOT EXISTS spi.schema_migration ("
                     " version text PRIMARY KEY, checksum text NOT NULL,"
                     " applied_at timestamptz NOT NULL DEFAULT now())")
        conn.commit()
        done = dict(conn.execute("SELECT version, checksum FROM spi.schema_migration").fetchall())
        for path in sorted(MIGRATIONS.glob("*.sql")):
            sql = path.read_text(encoding="utf-8")
            checksum = hashlib.sha256(sql.encode()).hexdigest()
            if path.stem in done:
                if done[path.stem] != checksum:
                    raise RuntimeError(f"{path.name} changed after it was applied; add a new migration instead")
                continue
            with conn.transaction():
                conn.execute(sql)
                conn.execute("INSERT INTO spi.schema_migration (version, checksum) VALUES (%s, %s)",
                             (path.stem, checksum))
            applied.append(path.stem)
    return applied


if __name__ == "__main__":
    done = migrate()
    print("applied: " + ", ".join(done) if done else "schema up to date")
    sys.exit(0)
