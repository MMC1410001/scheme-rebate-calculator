"""Daily sync of the live month from GCS: `python -m app.ingest.gcs_sync [--year Y --month M]`.

The bucket holds one folder per year and month. Each extract lands there as two files -- with and
without condonation -- named `..._v<N>.xlsx` and `..._v<N>_no_condonation.xlsx`. Some are also
copied into a daily/ subfolder, but not all, so only the month folder itself is read. Only the
no-condonation file is read (GCS_FILE_PATTERN), and of those only the newest: the latest upload
date, then the highest version. Each file is month-to-date, so the newest one replaces everything
before it.

Since October 2026 the same folder and name pattern also carry a second series: the gift / contest
file (Shine On Gift, Wallpaper Roll, 5% Nova Prime ...), which has no business GSR and none of the
CN schemes. Its versions interleave with the main file's (Oct: main v20, v22; gifts v21, v23, v24).
So each file is classified by its header (`classify`: main = it has the business GSR columns), and
the newest file of EACH kind is kept: the main one in latest.json, the gift one in gifts.json. A gift
file never replaces the main one. Kinds are cached per GCS generation in kinds.json, so a file's
header is read once (a ranged read of a few MB, not a download).

The chosen file is downloaded into DATA_DIR/<YYYY>/<MM>/, parsed once here so its parquet cache is
built in this process rather than inside a request, and only then recorded in latest.json. The
API reads latest.json (app/core/months.py), so it never sees a half-downloaded or unparsed file.
Superseded downloads and their caches are removed; GCS keeps every file, so nothing is lost.

A file already synced (same GCS generation) is not downloaded again, so re-runs are cheap.
"""
from __future__ import annotations

import argparse
import calendar
import json
import logging
import re
import shutil
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import BinaryIO
from zoneinfo import ZoneInfo

from app.config import get_settings

log = logging.getLogger("app.ingest.gcs_sync")
MANIFEST = "latest.json"
GIFT_MANIFEST = "gifts.json"
KINDS = "kinds.json"
LOCK_FILE = ".sync.lock"
# Exit code when the files synced but a database load failed: the API swaps the files in, and the scheduler tries
# again (a month already loaded is skipped, so only the failed load is redone).
EXIT_DB_FAILED = 2
# (connect, read) seconds per request, and the most one download may take including retries.
DOWNLOAD_TIMEOUT = (10, 120)
DOWNLOAD_RETRY_SECONDS = 300


@dataclass(frozen=True)
class DailyFile:
    path: str            # object name in the bucket, or the path under LOCAL_DATA_DIR
    extract_date: date
    version: int
    generation: str      # changes whenever the file is re-uploaded
    read_to: Callable[[Path], None]
    open_: Callable[[], BinaryIO]  # a seekable read of the file, for its header only

    @property
    def name(self) -> str:
        return self.path.rsplit("/", 1)[-1]


def months_to_load(today: date, catch_up_days: int) -> list[tuple[int, int]]:
    """This month, plus the previous one during the first catch_up_days days of the month."""
    months = [(today.year, today.month)]
    if today.day <= catch_up_days:
        months.insert(0, (today.year - 1, 12) if today.month == 1 else (today.year, today.month - 1))
    return months


def list_daily_files(year: int, month: int) -> list[DailyFile]:
    """The month's no-condonation files; the other variant and unrelated files are skipped."""
    settings = get_settings()
    prefix = settings.gcs_prefix_template.format(year=year, month=month)
    pattern = re.compile(settings.gcs_file_pattern)
    raw = _list_local(Path(settings.local_data_dir), prefix) if settings.local_data_dir \
        else _list_gcs(settings.gcs_bucket, prefix)
    tz = ZoneInfo(settings.timezone)
    files = []
    for path, generation, uploaded, read_to, open_ in raw:
        match = pattern.search(path.rsplit("/", 1)[-1])
        if not match:
            continue
        if match.groupdict().get("date") is None:
            # The names carry no date; when the file was produced is when it was uploaded.
            extract_date = uploaded.astimezone(tz).date()
        else:
            try:
                extract_date = datetime.strptime(match["date"], "%Y%m%d").date()
            except ValueError:
                log.warning("Skipping %s: %s is not a date", path, match["date"])
                continue
        files.append(DailyFile(path, extract_date, int(match["version"]), generation, read_to, open_))
    return files


def pick_latest(files: list[DailyFile]) -> DailyFile | None:
    """The newest extract date, then the highest version of that date."""
    return max(files, key=lambda f: (f.extract_date, f.version), default=None)


def classify(file: DailyFile) -> str:
    """"main" when the header has the business GSR columns (the CN extract), else "gift"."""
    from app.ingest.discover_schemes import TOTAL_GSR_METRICS, read_headers

    with file.open_() as handle:
        cells = read_headers(handle)
    return "main" if any(c.metric in TOTAL_GSR_METRICS for c in cells) else "gift"


def pick_latest_by_kind(files: list[DailyFile], folder: Path) -> dict[str, DailyFile]:
    """The newest file of each kind, newest first; stops once both are found. Kinds are cached in kinds.json."""
    path = folder / KINDS
    try:
        known = json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        known = {}
    found: dict[str, DailyFile] = {}
    for f in sorted(files, key=lambda f: (f.extract_date, f.version), reverse=True):
        if f.generation not in known:
            known[f.generation] = classify(f)
            log.info("%s is a %s file", f.name, known[f.generation])
        found.setdefault(known[f.generation], f)
        if len(found) == 2:
            break
    folder.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(known, indent=2))
    return found


def _list_local(root: Path, prefix: str):
    folder = root / prefix
    if not folder.is_dir():
        return []
    return [
        (p.relative_to(root).as_posix(), str(p.stat().st_mtime_ns),
         datetime.fromtimestamp(p.stat().st_mtime, UTC),
         lambda dest, src=p: shutil.copyfile(src, dest),
         lambda src=p: open(src, "rb"))
        for p in sorted(folder.iterdir()) if p.is_file()
    ]


def _list_gcs(bucket_name: str, prefix: str):
    # The delimiter keeps the listing to files directly in the folder, so daily/ is not read.
    return [
        (blob.name, str(blob.generation), blob.updated,
         lambda dest, name=blob.name, gen=blob.generation: _download(bucket_name, name, gen, dest),
         lambda name=blob.name, gen=blob.generation: _open(bucket_name, name, gen))
        for blob in _gcs_client().list_blobs(bucket_name, prefix=prefix, delimiter="/")
    ]


_clients = threading.local()


def _gcs_client():
    # Imported here so local development works without GCS credentials.
    from google.cloud import storage

    if not hasattr(_clients, "client"):
        settings = get_settings()
        if info := settings.gcs_credentials_info:
            # The service-account key from GCS_CREDENTIALS_JSON; the project defaults to the key's own.
            project = {"project": settings.gcs_project} if settings.gcs_project else {}
            _clients.client = storage.Client.from_service_account_info(info, **project)
        else:
            # The key file (GOOGLE_APPLICATION_CREDENTIALS) or the server's own service account.
            _clients.client = storage.Client(project=settings.gcs_project or "<none>")
    return _clients.client


def _download(bucket_name: str, name: str, generation: int, dest: Path) -> None:
    # Pinned to the listed generation, so the bytes match what latest.json records even if the
    # file is re-uploaded meanwhile (the next run then picks up the new one).
    from google.cloud.storage.retry import DEFAULT_RETRY

    blob = _gcs_client().bucket(bucket_name).blob(name, generation=generation)
    blob.download_to_filename(str(dest), timeout=DOWNLOAD_TIMEOUT,
                              retry=DEFAULT_RETRY.with_timeout(DOWNLOAD_RETRY_SECONDS))


def _open(bucket_name: str, name: str, generation: int) -> BinaryIO:
    # Ranged reads in 1 MB chunks: reading the header touches a few MB of a 70 MB workbook.
    return _gcs_client().bucket(bucket_name).blob(name, generation=generation).open("rb", chunk_size=1 << 20)


def month_folder(year: int, month: int) -> Path:
    return get_settings().data_path / f"{year:04d}" / f"{month:02d}"


def read_manifest(folder: Path, name: str = MANIFEST) -> dict | None:
    try:
        return json.loads((folder / name).read_text())
    except (FileNotFoundError, ValueError):
        return None


def sync_month(year: int, month: int) -> bool:
    """Bring one month's folder up to its newest main and gift files. True when the folder changed."""
    files = list_daily_files(year, month)
    if not files:
        # Normal on the first morning of a month, before its first file lands.
        log.warning("%d-%02d: no no-condonation file found", year, month)
        return False
    folder = month_folder(year, month)
    latest = pick_latest_by_kind(files, folder)
    if "main" not in latest:
        log.warning("%d-%02d: only gift files so far; the main CN extract has not landed", year, month)
    changed = False
    for kind, manifest_name in (("main", MANIFEST), ("gift", GIFT_MANIFEST)):
        if kind in latest:
            changed |= _sync_file(year, month, folder, latest[kind], manifest_name, kind)
    _remove_superseded(folder)
    return changed


def _sync_file(year: int, month: int, folder: Path, latest: DailyFile, manifest_name: str, kind: str) -> bool:
    current = read_manifest(folder, manifest_name)
    if current and current["source"] == latest.path and current["generation"] == latest.generation \
            and (folder / current["file"]).is_file():
        log.info("%d-%02d: %s already synced", year, month, latest.name)
        return False

    target = folder / latest.name
    partial = folder / f".{latest.name}.part"
    log.info("%d-%02d: downloading %s", year, month, latest.path)
    latest.read_to(partial)
    partial.replace(target)

    # Parse now, so the API swaps in a ready parquet cache instead of re-reading the workbook.
    if kind == "main":
        from app.ingest.load_month import load_month
        frame = load_month(target, source_kind="automated", force=True)
    else:
        from app.ingest.gifts import load_gifts
        frame = load_gifts(target, force=True)
    log.info("%d-%02d: parsed %s %s (%d rows)", year, month, kind, latest.name, len(frame))

    manifest = {
        "file": latest.name,
        "source": latest.path,
        "generation": latest.generation,
        "extract_date": latest.extract_date.isoformat(),
        "version": latest.version,
        "month_days": calendar.monthrange(year, month)[1],
        "synced_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    tmp = folder / f".{manifest_name}.part"
    tmp.write_text(json.dumps(manifest, indent=2))
    tmp.replace(folder / manifest_name)
    return True


def _remove_superseded(folder: Path) -> None:
    """Downloads no manifest points at, and their parquet caches (named <stem>.<hash>.v<N>...parquet)."""
    keep = [Path(m["file"]) for name in (MANIFEST, GIFT_MANIFEST) if (m := read_manifest(folder, name))]
    for path in folder.iterdir():
        if path.name in (MANIFEST, GIFT_MANIFEST, KINDS) or path.name.startswith("."):
            continue
        if any(path.name == k.name or path.name.startswith(k.stem + ".") for k in keep):
            continue
        if path.is_file():
            path.unlink()
            log.info("Removed superseded %s", path.name)


def prune_old_months(today: date) -> None:
    """Local copies of months before the retention window. GCS keeps every file."""
    keep = get_settings().loader_retention_months
    root = get_settings().data_path
    if keep <= 0 or not root.is_dir():
        return
    index = today.year * 12 + today.month - 1
    oldest = index - keep + 1
    for year_dir in root.iterdir():
        if not (year_dir.is_dir() and year_dir.name.isdigit()):
            continue
        for month_dir in year_dir.iterdir():
            if month_dir.is_dir() and month_dir.name.isdigit() \
                    and int(year_dir.name) * 12 + int(month_dir.name) - 1 < oldest:
                shutil.rmtree(month_dir)
                log.info("Removed local copy of %s-%s (older than %d months)", year_dir.name, month_dir.name, keep)


def _load_into_db(year: int, month: int) -> bool:
    """Load the synced month's main and gift files into the database (app/spi/load.py) when it is set up.

    Runs after every sync, not only after a download: a file already loaded is skipped, and a database added later
    catches up on the next run. A failed load is logged, not raised -- the API still runs from the files -- and
    returns False, so the run exits with EXIT_DB_FAILED and is tried again. Gift files follow with their tables.
    """
    from app import spi

    if not spi.configured():
        return True
    from app.spi.load import load_file, synced_files

    ok = True
    for f in synced_files(year, month):   # the CN extract and the gift file
        try:
            log.info("%d-%02d: database %s", year, month, load_file(f))
        except Exception:
            log.exception("%d-%02d: loading %s into the database failed", year, month, f.path.name)
            ok = False
    return ok


def _prune_db(today: date) -> None:
    """The database keeps the same months as the disk (LOADER_RETENTION_MONTHS), and saved versions of the live month
    and the VERSION_RETENTION_MONTHS - 1 before it. Logged, not raised, as above."""
    from app import spi

    if not spi.configured():
        return
    try:
        from app.spi.load import prune

        log.info("database retention: dropped %s", prune(today))
    except Exception:
        log.exception("database retention failed")
    try:
        from app.core.months import live_month
        from app.spi import saved_versions

        live = live_month()
        if live is not None:
            label = live.label
            out = saved_versions.prune(date(int(label[:4]), int(label[5:7]), 1))
            log.info("saved versions retention: %s", out)
    except Exception:
        log.exception("saved versions retention failed")


def _hold_lock(root: Path):
    """So a manual run and a scheduled run never overlap. None when another run holds it."""
    root.mkdir(parents=True, exist_ok=True)
    handle = open(root / LOCK_FILE, "w")
    try:
        import fcntl
    except ImportError:  # Windows: one process at a time is up to the operator
        return handle
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    return handle


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--year", type=int)
    parser.add_argument("--month", type=int)
    args = parser.parse_args(argv)
    settings = get_settings()
    today = datetime.now(ZoneInfo(settings.timezone)).date()
    months = [(args.year, args.month)] if args.year and args.month \
        else months_to_load(today, settings.loader_catch_up_days)

    lock = _hold_lock(settings.data_path)
    if lock is None:
        log.warning("Another sync is running; nothing to do")
        return 0
    db_ok = True
    try:
        for year, month in months:
            sync_month(year, month)
            db_ok &= _load_into_db(year, month)
        prune_old_months(today)
        _prune_db(today)
    finally:
        lock.close()
    return 0 if db_ok else EXIT_DB_FAILED


if __name__ == "__main__":
    sys.exit(main())
