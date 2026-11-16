"""
Registry of the monthly files and, critically, whether each is complete.

The September export is a MID-MONTH snapshot: it holds roughly a third of the
payout of July and August, uniformly across every scheme. That is not a demand
collapse, and comparing it against a full month would read as one -- so
completeness is recorded here rather than left for a reader to infer.

Anything that trends or forecasts must use `complete_months()`; a partial month
is still useful for the live dashboard, just not for month-on-month maths.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class MonthFile:
    label: str          # "2026-07"
    path: Path
    source: str         # "automated" | "working" | "cn_working"
    complete: bool
    as_of: str | None = None   # date the snapshot was taken, when known
    elapsed_days: int | None = None
    month_days: int | None = None
    note: str = ""
    version: int | None = None   # the GCS file's v<N>, for a synced month
    in_db: bool = False          # held in the database (DATA_SOURCE=spi): read from there, the file need not be on disk

    @property
    def elapsed_share(self) -> float | None:
        if self.elapsed_days and self.month_days:
            return self.elapsed_days / self.month_days
        return None

    @property
    def sort_key(self) -> str:
        return self.label


DOWNLOADS = Path.home() / "Downloads"
PROJECT_DATA = Path(__file__).resolve().parent.parent.parent / "data" / "sample"

MONTHS: list[MonthFile] = [
    MonthFile(
        label="2026-04",
        path=DOWNLOADS / "cn_working_2026_04.xlsx",
        source="working_flat",
        complete=True,
        note="Flat headers ('Value Slab  CN Clear Cut'). Carries an embedded "
             "'Total' row that must be excluded or the month doubles. No slab columns.",
    ),
    MonthFile(
        label="2026-05",
        path=DOWNLOADS / "cn_working_2026_05_v2.xlsx",
        source="working_grouped",
        complete=True,
        note="Also ships a 'Slab Working' rate card, per-dealer EB date extensions "
             "and a parent/child dealer mapping. No slab columns in the data sheet.",
    ),
    MonthFile(
        label="2026-06",
        path=DOWNLOADS / "rebate_extract_2026_06_v2.xlsx",
        source="automated",
        complete=True,
        note="Uniform blocks, but five metrics per block rather than ten: no Next "
             "Slab and no geography.",
    ),
    MonthFile(
        label="2026-07",
        path=DOWNLOADS / "cn_working_2026_07.csv",
        source="cn_working",
        complete=True,
        note="Settled working file: carries full dealer geography. No slab columns.",
    ),
    MonthFile(
        label="2026-07-slabs",
        path=DOWNLOADS / "extract_2026_07_v9.xlsx",
        source="automated",
        complete=True,
        note="Uniform-block export: use for slab mechanics only. No geography.",
    ),
    MonthFile(
        label="2026-08",
        path=DOWNLOADS / "scheme_working_2026_08_v4.xlsx",
        source="working",
        complete=True,
    ),
    MonthFile(
        label="2026-09",
        path=DOWNLOADS / "cn_working_2026_09_final.xlsx",
        source="working_slabs",
        complete=True,
        note="Final settled working file, read with its slab structure -- 69 Next "
             "Slab columns across 63 slabbed components. Drives the whole app, so "
             "the Overview and the trend now report the same month.",
    ),
    MonthFile(
        label="2026-09-d25",
        path=PROJECT_DATA / "dealer_scheme_sep2026_d25.xlsx",
        source="automated",
        complete=False,
        as_of="2026-09-25",
        elapsed_days=25,
        month_days=30,
        note="Day-25 snapshot. Superseded for reporting by the final working file, "
             "but kept as the live Simulator source: it is the most recent September "
             "export carrying slab boundaries and Next Slab values.",
    ),
    MonthFile(
        label="2026-09-early",
        path=PROJECT_DATA / "dealer_scheme_raw_sep2026.xlsx",
        source="automated",
        complete=False,
        as_of="2026-09-18",
        elapsed_days=18,
        month_days=30,
        note="Day-18 snapshot. With day 25 and the final file it gives three points "
             "on one month's accrual curve -- the only such series held here, and "
             "what showed the payout rate does NOT climb linearly to close.",
    ),
]


def by_label(label: str) -> MonthFile | None:
    return next((m for m in MONTHS if m.label == label), None)


def has_data(m: MonthFile) -> bool:
    """The month can be read: held in the database, or its file is on this machine."""
    return m.in_db or m.path.is_file()


def _db_months(kind: str) -> list[MonthFile]:
    """Each month's newest file in the database (DATA_SOURCE=spi), oldest first: the database is the source."""
    import calendar

    from app.config import get_settings
    from app.spi.frames import live_files

    root = get_settings().data_path
    found = []
    for month, name, version, extract, complete in live_files(kind):
        month_days = calendar.monthrange(month.year, month.month)[1]
        found.append(MonthFile(
            label=f"{month:%Y-%m}", path=root / f"{month:%Y}" / f"{month:%m}" / name, source="automated",
            complete=complete, as_of=extract.isoformat(), elapsed_days=month_days if complete else extract.day,
            month_days=month_days, note=f"GCS file {name}, from the database.", version=version, in_db=True))
    return found


def synced_months(manifest_name: str = "latest.json") -> list[MonthFile]:
    """Months brought down from GCS by app/ingest/gcs_sync.py, oldest first.

    With DATA_SOURCE=spi they come from the database (each month's newest file there); otherwise from the sync's
    manifests on disk, as below.

    Read from each month's latest.json, which the sync writes only once the file is
    downloaded and parsed. A daily file is month-to-date. Its extract date is when it
    was produced, not the last day it covers: September's final files are dated 1-4
    October. So a file extracted after its month ended is the complete month, and one
    extracted within it counts its extract day as elapsed.
    """
    import json
    from datetime import date

    from app import spi
    from app.config import get_settings

    if spi.enabled():
        return _db_months("gift" if manifest_name == "gifts.json" else "main")
    root = get_settings().data_path
    found = []
    for manifest in sorted(root.glob(f"[0-9][0-9][0-9][0-9]/[0-9][0-9]/{manifest_name}")):
        try:
            info = json.loads(manifest.read_text())
        except ValueError:
            continue
        path = manifest.parent / info["file"]
        if not path.is_file():
            continue
        year, month, month_days = int(manifest.parent.parent.name), int(manifest.parent.name), info["month_days"]
        extract = date.fromisoformat(info["extract_date"])
        complete = extract > date(year, month, month_days)
        elapsed = month_days if complete else extract.day
        found.append(MonthFile(
            label=f"{year:04d}-{month:02d}",
            path=path,
            source="automated",
            complete=complete,
            as_of=info["extract_date"],
            elapsed_days=elapsed,
            month_days=info["month_days"],
            note=f"GCS file {info['file']}, synced {info['synced_at']}.",
            version=info.get("version"),
        ))
    return found


def gift_months() -> list[MonthFile]:
    """The gift / contest file of each synced month that has one (gifts.json; app/ingest/gifts.py), oldest first."""
    return synced_months("gifts.json")


def data_signature() -> tuple:
    """Which file each synced month is on, main and gift: changes whenever a sync brings a new file."""
    return tuple((m.label, m.path.name) for m in [*synced_months(), *gift_months()])


def live_month() -> MonthFile | None:
    """The month the dashboard and simulator run on.

    LIVE_MONTH pins a registered label; otherwise the newest synced GCS month, falling
    back to the registry's settled September for a machine that has synced nothing yet.
    """
    from app.config import get_settings

    pinned = get_settings().live_month
    if pinned:
        return by_label(pinned)
    synced = synced_months()
    return synced[-1] if synced else by_label("2026-09")


def complete_months() -> list[MonthFile]:
    """Only months safe to compare against each other, oldest first.

    A registered settled file wins where it is present (it carries condonation and
    the settled figures); a complete month synced from GCS fills the gap where it
    is not. A registered file missing on this machine is left out, not reported as
    a failed month -- see unavailable_months().
    """
    by_label = {m.label: m for m in synced_months() if m.complete}
    for m in MONTHS:
        if m.complete and not m.label.endswith("-slabs") and m.path.is_file():
            by_label[m.label] = m
    return [by_label[k] for k in sorted(by_label)]


def partial_months() -> list[MonthFile]:
    """Incomplete months worth SHOWING -- one row per calendar month.

    Earlier snapshots of a month already represented by a later one are held
    back: they exist for measuring how payout accrues through a month, not for
    the dashboard, which would otherwise list September twice. A synced month
    still in progress (the live one) is shown unless a settled file covers it.
    """
    settled = {m.label for m in complete_months()}
    by_label = {m.label: m for m in synced_months() if not m.complete and m.label not in settled}
    for m in MONTHS:
        if not m.complete and not any(m.label.endswith(x) for x in ("-early", "-d25")) and m.path.is_file():
            by_label[m.label] = m
    return [by_label[k] for k in sorted(by_label)]


def unavailable_months() -> list[str]:
    """Registered months whose source file is not on this machine and that no synced month replaces."""
    have = {m.label for m in complete_months()} | {m.label for m in partial_months()}
    return sorted({m.label for m in MONTHS
                   if m.complete and not m.label.endswith("-slabs")
                   and not m.path.is_file() and m.label not in have})


def snapshots_of(month: str) -> list[MonthFile]:
    """Every snapshot of one calendar month, oldest first.

    Two readings of the same month are what make the accrual curve measurable,
    so they are addressable as a set rather than only as the latest one.
    """
    return sorted(
        (m for m in MONTHS if m.label.startswith(month) and m.elapsed_days),
        key=lambda m: m.elapsed_days or 0,
    )
