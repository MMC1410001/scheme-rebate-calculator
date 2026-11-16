"""Load GCS files into spi: `python -m app.spi.load [--year Y --month M] [--history] [--file NAME] [--force] [--prune]`
(run from backend/).

Each month keeps its KEEP_PER_MONTH (2) newest files of each kind: the CN extract ('main') and the gift file ('gift'),
the newest and the one before it as a backup (user's choice, 5 Nov 2026: the store shares dev's app_db; about 125 MB a
file). Loading a file deletes the month's older files of its kind beyond those two in the same transaction; a file
older than the two kept is skipped. GCS keeps every version. By default each synced month's files
(DATA_DIR/<YYYY>/<MM>/latest.json and gifts.json) are loaded; --history loads the month's newest versions of each kind
from GCS (--file: only the files named, still only when among the two newest). A main file: parse it (the engine's parser), add any new
geography / scheme / component, then in ONE transaction write its scheme definitions, components, dealers and its
own partition of dealer x component rows, checked against the parsed file (a difference rolls everything back). A
gift file: its dealer x gift-scheme rows, checked the same way. The month's live file is its newest (view live_file).
A file already loaded (same name and GCS generation) under the current loader and parser is skipped unless --force;
one loaded under older ones (loader_version, parser_version = CONFIG_VERSION) is reloaded. --prune drops the files of
months past LOADER_RETENTION_MONTHS.
"""
from __future__ import annotations

import argparse
import calendar
import dataclasses
import io
import json
import logging
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
from psycopg import sql
from psycopg.types.json import Jsonb

from app.config import get_settings
from app.core.categories import ORDER, OTHER, WHOLE_BOOK, category_of
from app.core.scheme_config import is_currency_scheme
from app.ingest.all_schemes import get_schemes
from app.ingest.gcs_sync import GIFT_MANIFEST, KINDS, MANIFEST, month_folder, read_manifest
from app.ingest.gifts import load_gifts
from app.ingest.load_month import load_month_file
from app.ingest.parse_raw import CONFIG_VERSION
from app.spi import connect

log = logging.getLogger("app.spi.load")

# What the loader itself does to a file; files loaded under an older one are reloaded.
LOADER_VERSION = 2
# Files kept per month and kind: the newest and the one before it, as a backup (user's choice, 5 Nov 2026).
KEEP_PER_MONTH = 2

FACT_COLUMNS = ["file_id", "dealer_code", "component_id", "row_no", "geo_id", "base_value", "cn_rate", "cn_units",
                "current_cn", "volume", "gsr", "gsr_src", "vol_src", "slab_basis", "next_slab", "condonation_amount",
                "scheme_cn", "settled_cn", "component_clear_cut", "clear_cut_total", "is_currency"]
GIFT_COLUMNS = ["file_id", "dealer_code", "scheme_id", "row_no", "geo_id", "volume", "gsr", "level", "clear_cut",
                "next_slab", "shortfall"]


def _copy(cur, table: str, frame: pd.DataFrame, columns: list[str]) -> None:
    """Bulk insert through COPY CSV; floats written in shortest round-trip form, NaN as NULL."""
    buf = io.StringIO()
    frame[columns].to_csv(buf, index=False, header=False, na_rep="")
    cols = sql.SQL(", ").join(sql.Identifier(c) for c in columns)
    with cur.copy(sql.SQL("COPY {} ({}) FROM STDIN WITH (FORMAT csv)").format(sql.SQL(table), cols)) as copy:
        copy.write(buf.getvalue())


def _geo_ids(cur, df: pd.DataFrame) -> dict:
    """Geography as the file gives it; returns geo ids by (zone, region, depot)."""
    for z, r, d in df[["zone", "region", "depot_code"]].drop_duplicates().itertuples(index=False):
        cur.execute("INSERT INTO spi.geo_unit (zone, region, depot_code) VALUES (%s, %s, %s) "
                    "ON CONFLICT (zone, region, depot_code) DO NOTHING", (z, r, int(d)))
    return {(z, r, d): g for z, r, d, g in cur.execute("SELECT zone, region, depot_code, geo_id FROM spi.geo_unit")}


def _scheme_lookups(cur, df: pd.DataFrame) -> dict:
    """Products, schemes and components of a main file. Returns component ids by (scheme, component)."""
    for i, name in enumerate(n for n in ORDER if n not in (OTHER, WHOLE_BOOK)):
        cur.execute("INSERT INTO spi.product (name, sort_order) VALUES (%s, %s) ON CONFLICT (name) DO NOTHING",
                    (name, i + 1))
    products = dict(cur.execute("SELECT name, product_id FROM spi.product").fetchall())
    # The label here is the latest; each file keeps its own in file_component.
    for code, label in df[["scheme", "scheme_label"]].drop_duplicates("scheme").itertuples(index=False):
        cat, counts = category_of(code)
        role = "base" if counts else "whole_book" if cat == WHOLE_BOOK else "other" if cat == OTHER else "addon"
        cur.execute(
            "INSERT INTO spi.scheme (code, label, product_id, role, pays_in) VALUES (%s, %s, %s, %s, %s) "
            "ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, product_id = EXCLUDED.product_id, "
            "role = EXCLUDED.role, pays_in = EXCLUDED.pays_in",
            (code, label, products.get(cat), role, "rupees" if is_currency_scheme(label) else "gifts"))
    scheme_ids = dict(cur.execute("SELECT code, scheme_id FROM spi.scheme").fetchall())
    for code, comp in df[["scheme", "component"]].drop_duplicates().itertuples(index=False):
        cur.execute("INSERT INTO spi.component (scheme_id, name) VALUES (%s, %s) "
                    "ON CONFLICT (scheme_id, name) DO NOTHING", (scheme_ids[code], comp))
    return {(s, c): i for s, c, i in cur.execute(
        "SELECT s.code, c.name, c.component_id FROM spi.component c JOIN spi.scheme s USING (scheme_id)")}


@dataclass(frozen=True)
class FileInfo:
    """One file version as GCS lists it."""
    path: Path            # the local copy
    month: date
    gcs_path: str
    generation: str
    version: int | None
    extract_date: date
    kind: str = "main"    # 'main' (the CN extract) or 'gift'


def _drop_file(cur, file_id: int) -> None:
    """A loaded file's rows: its partition goes at once, the rest by cascade."""
    part = f"file_dealer_component_f{file_id}"
    if cur.execute("SELECT 1 FROM pg_tables WHERE schemaname = 'spi' AND tablename = %s", (part,)).fetchone():
        cur.execute(sql.SQL("ALTER TABLE spi.file_dealer_component DETACH PARTITION spi.{}").format(sql.Identifier(part)))
        cur.execute(sql.SQL("DROP TABLE spi.{}").format(sql.Identifier(part)))
    cur.execute("DELETE FROM spi.source_file WHERE file_id = %s", (file_id,))


# Newer = later extract date, then higher version (the order of view spi.live_file).
_NEWER_KEPT = ("SELECT file_name FROM spi.source_file WHERE month = %s AND kind = %s "
               "AND (extract_date, coalesce(version, -1)) > (%s, %s) ORDER BY extract_date DESC, version DESC")
_BEYOND_KEPT = ("SELECT file_id, file_name FROM spi.source_file WHERE month = %s AND kind = %s "
                "ORDER BY extract_date DESC, version DESC NULLS LAST, file_id DESC OFFSET %s")


def newer_kept(conn, month: date, kind: str, extract_date: date, version: int | None) -> list[str]:
    """The kept files of this month and kind that are newer than (extract_date, version), newest first."""
    return [r[0] for r in conn.execute(_NEWER_KEPT, (month, kind, extract_date, -1 if version is None else version))]


def _check(expected: dict, got: tuple) -> None:
    actual = dict(zip(expected, (float(x) for x in got)))
    if any(abs(actual[k] - expected[k]) > 0.01 for k in expected):
        raise ValueError(f"totals differ from the parsed file: file {expected}, loaded {actual}")


def _insert_file(cur, f: FileInfo, dealers: int, rows: int, payout: float, configs=None) -> int:
    last_day = f.month.replace(day=calendar.monthrange(f.month.year, f.month.month)[1])
    file_id, = cur.execute(
        "INSERT INTO spi.source_file (month, kind, file_name, gcs_path, gcs_generation, version, extract_date, "
        "complete, dealer_rows, component_rows, file_payout, loader_version, parser_version, scheme_configs) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING file_id",
        (f.month, f.kind, f.path.name, f.gcs_path, f.generation, f.version, f.extract_date, f.extract_date > last_day,
         dealers, rows, payout, LOADER_VERSION, CONFIG_VERSION,
         None if configs is None else Jsonb(configs))).fetchone()
    return file_id


def _write_main(cur, f: FileInfo, df: pd.DataFrame) -> tuple[int, str]:
    """A CN extract's rows; returns its file id and partition."""
    expected = {"rows": len(df), "dealers": df["customer_code"].nunique(), "payout": round(float(df["current_cn"].sum()), 2),
                "gsr": round(float(df["gsr"].sum()), 2)}
    geo_ids = _geo_ids(cur, df)
    comp_ids = _scheme_lookups(cur, df)
    configs = [dataclasses.asdict(c) for c in get_schemes(f.path).values()]
    file_id = _insert_file(cur, f, expected["dealers"], expected["rows"], expected["payout"], configs)

    comps = df[["scheme", "component", "scheme_label", "formula", "pack_size"]].drop_duplicates(["scheme", "component"])
    with cur.copy("COPY spi.file_component (file_id, component_id, scheme_label, formula, pack_size) FROM STDIN") as cp:
        for scheme, comp, label, formula, pack in comps.itertuples(index=False):
            cp.write_row((file_id, comp_ids[(scheme, comp)], label, str(formula), int(pack)))
    rows = df.assign(file_id=file_id, dealer_code=df["customer_code"], row_no=df.index,
                     geo_id=[geo_ids[(z, r, int(d))] for z, r, d in zip(df["zone"], df["region"], df["depot_code"])],
                     component_id=[comp_ids[(s, c)] for s, c in zip(df["scheme"], df["component"])])
    _copy(cur, "spi.file_dealer", rows.drop_duplicates("dealer_code"),
          ["file_id", "dealer_code", "geo_id", "customer_name", "total_gsr", "od_blocked"])

    # The file's own partition: filled and checked as a plain table, then attached.
    part = f"file_dealer_component_f{file_id}"
    cur.execute(sql.SQL("CREATE TABLE spi.{} (LIKE spi.file_dealer_component INCLUDING DEFAULTS)")
                .format(sql.Identifier(part)))
    _copy(cur, f"spi.{part}", rows, FACT_COLUMNS)
    cur.execute(sql.SQL("ALTER TABLE spi.{} ADD CHECK (file_id = {})").format(sql.Identifier(part), sql.Literal(file_id)))
    _check(expected, cur.execute(sql.SQL(
        "SELECT count(*), count(DISTINCT dealer_code), round(sum(current_cn)::numeric, 2), round(sum(gsr)::numeric, 2) "
        "FROM spi.{}").format(sql.Identifier(part))).fetchone())
    cur.execute(sql.SQL("ALTER TABLE spi.file_dealer_component ATTACH PARTITION spi.{} FOR VALUES IN ({})")
                .format(sql.Identifier(part), sql.Literal(file_id)))
    return file_id, part


def _write_gift(cur, f: FileInfo, df: pd.DataFrame) -> int:
    """A gift file's rows (one per dealer and gift scheme); returns its file id."""
    expected = {"rows": len(df), "dealers": df["customer_code"].nunique(),
                "earned": round(float(df["clear_cut"].fillna(0).sum()), 2)}
    geo_ids = _geo_ids(cur, df)
    for name in df["scheme"].drop_duplicates():
        cur.execute("INSERT INTO spi.scheme (code, label, product_id, role, pays_in) VALUES (%s, %s, NULL, 'gift', %s) "
                    "ON CONFLICT (code) DO NOTHING", (name, name, "rupees" if is_currency_scheme(name) else "gifts"))
    scheme_ids = dict(cur.execute("SELECT code, scheme_id FROM spi.scheme").fetchall())
    file_id = _insert_file(cur, f, expected["dealers"], expected["rows"], expected["earned"])
    rows = df.assign(file_id=file_id, dealer_code=df["customer_code"], row_no=df.index,
                     scheme_id=df["scheme"].map(scheme_ids),
                     geo_id=[geo_ids[(z, r, int(d))] for z, r, d in zip(df["zone"], df["region"], df["depot_code"])])
    _copy(cur, "spi.file_dealer_gift", rows, GIFT_COLUMNS)
    _check(expected, cur.execute(
        "SELECT count(*), count(DISTINCT dealer_code), round(coalesce(sum(clear_cut), 0)::numeric, 2) "
        "FROM spi.file_dealer_gift WHERE file_id = %s", (file_id,)).fetchone())
    return file_id


def load_file(f: FileInfo, force: bool = False) -> dict:
    """Load one file version (main or gift), checked against the parsed file, in one transaction."""
    with connect(owner=True) as conn:
        run_id, = conn.execute("INSERT INTO spi.load_run (month, file_name, status) VALUES (%s, %s, 'running') "
                               "RETURNING run_id", (f.month, f.path.name)).fetchone()
        conn.commit()
        try:
            old = conn.execute("SELECT file_id, loader_version, parser_version FROM spi.source_file "
                               "WHERE file_name = %s AND gcs_generation = %s", (f.path.name, f.generation)).fetchone()
            if old and (old[1], old[2]) == (LOADER_VERSION, CONFIG_VERSION) and not force:
                conn.execute("UPDATE spi.load_run SET status = 'skipped', finished_at = clock_timestamp() "
                             "WHERE run_id = %s", (run_id,))
                return {"file": f.path.name, "status": "skipped (already loaded)"}
            newer = newer_kept(conn, f.month, f.kind, f.extract_date, f.version)
            if len(newer) >= KEEP_PER_MONTH:
                conn.execute("UPDATE spi.load_run SET status = 'skipped', finished_at = clock_timestamp(), "
                             "message = %s WHERE run_id = %s", (f"older than the files kept: {', '.join(newer)}", run_id))
                return {"file": f.path.name, "status": f"skipped (the month keeps the newer {', '.join(newer)})"}

            if f.kind == "main":
                df = load_month_file(f.path, source_kind="automated").reset_index(drop=True)
                if "is_currency" not in df:
                    df["is_currency"] = None   # the parser adds it only with "Other (unattributed)" rows
            else:
                df = load_gifts(f.path).reset_index(drop=True)
            part = None
            with conn.transaction(), conn.cursor() as cur:
                if old:
                    _drop_file(cur, old[0])
                if f.kind == "main":
                    file_id, part = _write_main(cur, f, df)
                else:
                    file_id = _write_gift(cur, f, df)
                # The month keeps its KEEP_PER_MONTH newest files of this kind; older ones go in the same transaction.
                replaced = cur.execute(_BEYOND_KEPT, (f.month, f.kind, KEEP_PER_MONTH)).fetchall()
                for old_id, _ in replaced:
                    _drop_file(cur, old_id)
                cur.execute("UPDATE spi.load_run SET status = 'loaded', finished_at = clock_timestamp(), rows = %s "
                            "WHERE run_id = %s", (len(df), run_id))
            conn.execute(sql.SQL("ANALYZE spi.{}").format(sql.Identifier(part or "file_dealer_gift")))
            conn.commit()
            if replaced:
                # Big deletes leave dead rows in shared tables (file_dealer, file_component): reclaim and re-plan.
                conn.autocommit = True
                for table in ("file_dealer", "file_component", "file_dealer_gift", "source_file"):
                    conn.execute(sql.SQL("VACUUM (ANALYZE) spi.{}").format(sql.Identifier(table)))
            return {"file": f.path.name, "kind": f.kind, "file_id": file_id, "status": "loaded", "rows": len(df),
                    "replaced": [name for _, name in replaced]}
        except Exception as exc:
            conn.rollback()
            conn.execute("UPDATE spi.load_run SET status = 'failed', finished_at = clock_timestamp(), message = %s "
                         "WHERE run_id = %s", (str(exc)[:500], run_id))
            conn.commit()
            raise


def prune(today: date | None = None) -> list[str]:
    """Drop every file of the months before the retention window (LOADER_RETENTION_MONTHS, current month included;
    0 keeps all). GCS keeps every file. Returns the files dropped."""
    settings = get_settings()
    keep = settings.loader_retention_months
    if keep <= 0:
        return []
    today = today or datetime.now(ZoneInfo(settings.timezone)).date()
    index = today.year * 12 + today.month - 1 - (keep - 1)
    oldest = date(index // 12, index % 12 + 1, 1)
    dropped = []
    with connect(owner=True) as conn, conn.transaction(), conn.cursor() as cur:
        for file_id, name in cur.execute("SELECT file_id, file_name FROM spi.source_file WHERE month < %s",
                                         (oldest,)).fetchall():
            _drop_file(cur, file_id)
            dropped.append(name)
    return dropped


def synced_files(year: int, month: int) -> list[FileInfo]:
    """The month's files as synced by app.ingest.gcs_sync (latest.json, gifts.json), when on disk."""
    folder = month_folder(year, month)
    out = []
    for name, kind in ((MANIFEST, "main"), (GIFT_MANIFEST, "gift")):
        info = read_manifest(folder, name)
        if info and (folder / info["file"]).is_file():
            out.append(FileInfo(folder / info["file"], date(year, month, 1), info.get("source", ""),
                                str(info.get("generation", "")), info.get("version"),
                                date.fromisoformat(info["extract_date"]), kind))
    return out


def load_history(year: int, month: int, force: bool = False, only: set[str] | None = None) -> list[dict]:
    """The month's KEEP_PER_MONTH newest files of each kind in GCS (main and gift), or only the files named; a file
    older than those kept is skipped before it is downloaded. Each is downloaded to a scratch folder, loaded, and removed again unless it
    is one of the month's synced files."""
    from app.ingest.gcs_sync import classify, list_daily_files

    folder = month_folder(year, month)
    kinds_path = folder / KINDS
    try:
        kinds = json.loads(kinds_path.read_text())
    except (FileNotFoundError, ValueError):
        kinds = {}
    with connect() as conn:
        loaded = {(n, g) for n, g in conn.execute(
            "SELECT file_name, gcs_generation FROM spi.source_file WHERE loader_version = %s AND parser_version = %s",
            (LOADER_VERSION, CONFIG_VERSION)).fetchall()}
    scratch = folder / "versions"
    out = []
    # Newest first: once a kind's KEEP_PER_MONTH newest files are kept, the older ones are skipped before any download.
    done_kinds: set[str] = set()
    loaded_now: dict[str, int] = {}
    for f in sorted(list_daily_files(year, month), key=lambda f: (f.extract_date, f.version), reverse=True):
        if (only and f.name not in only) or ((f.name, f.generation) in loaded and not force):
            continue
        if f.generation not in kinds:
            kinds[f.generation] = classify(f)
            folder.mkdir(parents=True, exist_ok=True)
            kinds_path.write_text(json.dumps(kinds, indent=2))
        if kinds[f.generation] in done_kinds:
            continue
        with connect() as conn:
            if len(newer_kept(conn, date(year, month, 1), kinds[f.generation], f.extract_date, f.version)) \
                    >= KEEP_PER_MONTH:
                done_kinds.add(kinds[f.generation])
                continue
        synced = folder / f.name
        path = synced if synced.is_file() else scratch / f.name
        if not path.is_file():
            scratch.mkdir(parents=True, exist_ok=True)
            log.info("downloading %s", f.path)
            f.read_to(path)
        try:
            out.append(load_file(FileInfo(path, date(year, month, 1), f.path, f.generation, f.version, f.extract_date,
                                          kinds[f.generation]), force=force))
        finally:
            if path.parent == scratch:
                for p in scratch.glob(path.stem + "*"):
                    p.unlink()
        log.info("%s", out[-1])
        if out[-1].get("status") == "loaded":
            kind = kinds[f.generation]
            loaded_now[kind] = loaded_now.get(kind, 0) + 1
            if loaded_now[kind] >= KEEP_PER_MONTH:
                done_kinds.add(kind)
    return out


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--year", type=int)
    parser.add_argument("--month", type=int)
    parser.add_argument("--history", action="store_true",
                        help="the month's two newest versions of each kind in GCS, not only the synced ones")
    parser.add_argument("--file", action="append", help="with --history: only this file, if among the two newest")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--prune", action="store_true", help="drop the files of months past the retention window")
    args = parser.parse_args(argv)
    if args.prune:
        print({"dropped": prune()})
        return 0
    root = get_settings().data_path
    months = [(args.year, args.month)] if args.year and args.month else sorted(
        (int(p.parent.name), int(p.name)) for p in root.glob("[0-9][0-9][0-9][0-9]/[0-9][0-9]") if p.is_dir())
    for y, m in months:
        if args.history:
            load_history(y, m, force=args.force, only=set(args.file) if args.file else None)
        else:
            for f in synced_files(y, m):
                print(load_file(f, force=args.force))
    return 0


if __name__ == "__main__":
    sys.exit(main())
