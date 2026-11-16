"""The loader on its own: `python -m app.loader_main` (run from backend/; the `loader` service of docker-compose.yml).

It creates or updates the tables (when SPI_OWNER_URL is set), then runs the daily GCS sync on the schedule of
app/scheduler.py: a sync at start, then daily at LOADER_DAILY_AT, with retries. It writes the synced files to
DATA_DIR, a volume it shares with the API; the API swaps a new file in by itself (its file watch, app/main.py).

Why a separate process: migrations and loads need the database OWNER's login (they create tables and partitions).
Kept here, that login never reaches the API, which answers users and needs only SPI_DATABASE_URL. Parsing a new
workbook also no longer takes memory from the API's container.
"""
from __future__ import annotations

import asyncio
import logging
import signal
import sys

from app.config import get_settings
from app.logs import setup_logging
from app.scheduler import LoaderScheduler

log = logging.getLogger("app.loader")


async def _run() -> None:
    settings = get_settings()
    if settings.spi_owner_url is not None:
        from app.spi.migrate import migrate

        done = await asyncio.to_thread(migrate)
        log.info("database: %s", "applied " + ", ".join(done) if done else "schema up to date")
    else:
        log.warning("SPI_OWNER_URL is not set: no migrations, and synced files are not loaded into the database")
    scheduler = LoaderScheduler(settings, on_loaded=None)
    scheduler.start(sync_now=True)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()
    log.info("loader stopping")
    await scheduler.stop()


def main() -> int:
    setup_logging()
    asyncio.run(_run())
    return 0


if __name__ == "__main__":
    sys.exit(main())
