"""Loader schedule inside the API, as in an earlier internal service: new GCS files reach the app without a cron job.

Once a day at LOADER_DAILY_AT (India time) the API runs `python -m app.ingest.gcs_sync` in a child
process, so a slow or crashing download or parse never blocks request handling. In the first
LOADER_CATCH_UP_DAYS days of a month it also syncs the previous month, so its last file is not
missed. When the sync succeeds the API swaps the new file in (app.service.live.reload_live) without a restart. In the
loader container (app/loader_main.py) there is no API in the process: on_loaded is None and the API's file watch
(app/main.py) swaps the file in within a couple of minutes.

If the run fails (GCS unreachable, a bad file, too slow) it is tried again up to LOADER_RETRIES
times, LOADER_RETRY_MINUTES apart; a file already synced is skipped, so nothing is fetched twice.
A run whose files synced but whose database load failed (exit EXIT_DB_FAILED) swaps the files in
and is tried again the same way, so the database does not wait a day to catch up.

With several workers on one server only one runs the sync: each tries an exclusive lock on a file
in DATA_DIR and the holder schedules. If that worker dies the lock is released and another takes
over the next day. The sync keeps its own lock too, so a manual run and a scheduled run never overlap.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from collections.abc import Callable
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.config import BACKEND_DIR, Settings
from app.ingest.gcs_sync import EXIT_DB_FAILED

log = logging.getLogger("app.scheduler")   # INFO reaches the server log (app/logs.py)
SCHEDULER_LOCK_FILE = ".scheduler.lock"


def log_schedule_off(settings: Settings) -> None:
    """Say at start-up that no sync will run, and why, so a server that forgets APP_ENV shows it in its log.
    A warning unless APP_ENV=local is set explicitly: only a developer machine is expected to run without it."""
    level = logging.INFO if os.environ.get("APP_ENV") == "local" else logging.WARNING
    log.log(level, "Loader schedule off (APP_ENV=%s, LOADER_SCHEDULE_ENABLED=%s): new GCS files are not synced. "
             "Set APP_ENV=dev|uat|prod or LOADER_SCHEDULE_ENABLED=true to turn it on",
             os.environ.get("APP_ENV", "(not set)"),
             "(not set)" if settings.loader_schedule_enabled is None else str(settings.loader_schedule_enabled).lower())


def next_run_at(now: datetime, daily_at: time) -> datetime:
    """The next daily_at strictly after now (now carries the schedule's timezone)."""
    run = now.replace(hour=daily_at.hour, minute=daily_at.minute, second=0, microsecond=0)
    return run if run > now else run + timedelta(days=1)


class LoaderScheduler:
    def __init__(self, settings: Settings, on_loaded: Callable[[], bool] | None):
        self.settings = settings
        self.zone = ZoneInfo(settings.timezone)
        self.on_loaded = on_loaded
        self._task: asyncio.Task | None = None
        self._leader_lock = None

    def start(self, sync_now: bool = False) -> None:
        """sync_now: also sync straight away, so a new server, or one that was down when a file
        landed, does not wait for tomorrow's run. A file already synced is skipped, so this is cheap."""
        self._task = asyncio.create_task(self._loop(sync_now), name="loader-scheduler")
        log.info("Loader schedule on: daily at %s %s", self.settings.loader_daily_at, self.settings.timezone)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._leader_lock is not None:
            self._leader_lock.close()
            self._leader_lock = None

    async def _loop(self, sync_now: bool) -> None:
        if sync_now:
            log.info("Start-up sync")
            await self.run_daily()
        daily_at = time.fromisoformat(self.settings.loader_daily_at)
        while True:
            now = datetime.now(self.zone)
            await asyncio.sleep((next_run_at(now, daily_at) - now).total_seconds())
            await self.run_daily()

    async def run_daily(self) -> None:
        """Today's sync, tried again on failure. Returns quietly if another worker runs it."""
        if not self._is_leader():
            return  # another worker runs the sync
        tries = 1 + self.settings.loader_retries
        for attempt in range(1, tries + 1):
            try:
                code = await self._run_sync()
                if code in (0, EXIT_DB_FAILED):
                    if self.on_loaded is None:
                        log.info("Scheduled sync finished%s", "" if code == 0 else "; the database load failed")
                    else:
                        changed = await asyncio.to_thread(self.on_loaded)
                        log.info("Scheduled sync finished; %s%s", "new file is live" if changed else "no new file",
                                 "" if code == 0 else "; the database load failed")
                    if code == 0:
                        return
            except asyncio.CancelledError:
                raise
            except Exception:  # never let one bad run end the schedule
                log.exception("Scheduled sync failed")
            if attempt < tries:
                log.warning("Scheduled sync: try %d of %d failed; trying again in %d min",
                            attempt, tries, self.settings.loader_retry_minutes)
                await asyncio.sleep(self.settings.loader_retry_minutes * 60)
        log.error("Scheduled sync failed %d times; next try at %s tomorrow. Run "
                  "`python -m app.ingest.gcs_sync` by hand to sync today's file sooner",
                  tries, self.settings.loader_daily_at)

    def _is_leader(self) -> bool:
        """Hold the scheduler lock for this process's lifetime; False while another worker holds it."""
        if self._leader_lock is not None:
            return True
        root = self.settings.data_path
        root.mkdir(parents=True, exist_ok=True)
        handle = open(root / SCHEDULER_LOCK_FILE, "w")
        try:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except ImportError:  # Windows: a single worker is assumed
            pass
        except BlockingIOError:
            handle.close()
            return False
        self._leader_lock = handle
        log.info("Loader schedule: this worker runs the scheduled syncs")
        return True

    async def _run_sync(self) -> int | None:
        args = [sys.executable, "-m", "app.ingest.gcs_sync"]
        log.info("Scheduled sync started")
        # cwd and PYTHONPATH so `app` resolves however the API itself was started (--app-dir backend).
        env = {**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [str(BACKEND_DIR), os.environ.get("PYTHONPATH")]))}
        process = await asyncio.create_subprocess_exec(*args, cwd=BACKEND_DIR, env=env)  # its log goes to the API's output
        try:
            code = await asyncio.wait_for(process.wait(), self.settings.loader_timeout_minutes * 60)
        except TimeoutError:
            process.kill()
            await process.wait()
            log.error("Scheduled sync took over %d min and was stopped", self.settings.loader_timeout_minutes)
            return None
        except asyncio.CancelledError:  # API shutting down: don't leave the child running
            process.kill()
            await process.wait()
            raise
        if code not in (0, EXIT_DB_FAILED):
            log.error("Scheduled sync exited with code %d (see the gcs_sync log lines above)", code)
        return code
