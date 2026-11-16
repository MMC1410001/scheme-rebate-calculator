"""Saved what-if versions in spi (tables saved_version*).

A version stores what the user changed: its GSR / volume edits (current and next month) and slab edits, upserted
on their keys so an unchanged re-save writes nothing. Its results are the engine's (app/core/scenario.py), one per
month (the current month and next month):

- the live results: one 'live' snapshot per month and the dealers who moved slab, rewritten only when the version
  or the actual month's file changed;
- one 'save' snapshot per month and save, never rewritten: what was shown on that date.

A snapshot's per-scheme figures and slab rows are one jsonb document. Each login holds at most
MAX_VERSIONS_PER_USER versions that are not archived (a new save or a restore beyond it is refused). Retention
(prune, after each daily sync): versions saved in a month older than the live month and the
VERSION_RETENTION_MONTHS - 1 before it are deleted, saved or archived. A version can also be deleted by hand (delete).
"""
from __future__ import annotations

import json
from datetime import date

from psycopg.types.json import Jsonb

from app.config import get_settings
from app.spi import connect, connection

ADJ_KEYS = ["period", "scope_kind", "scope_value", "product", "metric", "mode"]
ADJ_COLS = [*ADJ_KEYS, "adjust_type", "value", "reason"]
# The table's key: scope_value through its md5 (a slab edit's dealer list is too long for a btree key).
ADJ_PK = ["period", "scope_kind", "scope_hash", "product", "metric", "mode"]
META_COLS = ["name", "note", "volume_growth_pct", "removed_schemes"]
SCHEME_COLS = ["scheme_key", "is_currency", "removed", "dealers", "dealers_moved", "actual_volume", "version_volume",
               "actual_gsr", "version_gsr", "actual_cn", "version_cn"]
SLAB_COLS = ["slab_mode", "formula", "pack_size", "slab_lower", "slab_upper", "rate", "dealers", "volume", "gsr", "cn"]
DEALER_COLS = ["customer_code", "scheme_key", "component", "actual_basis", "actual_lower", "actual_rate", "actual_cn",
               "version_basis", "version_lower", "version_rate", "version_cn"]
HEADER_COLS = ["source_file", "as_of", "month", "factor", "dealers", "dealers_moved", "actual_gsr", "version_gsr",
               "actual_cn", "version_cn", "warnings"]


class NameTaken(ValueError):
    """Another version already has this name."""


# Versions one login may hold that are not archived (user's rule, 6 Nov 2026; every role, ADMIN included).
MAX_VERSIONS_PER_USER = 10


class LimitReached(ValueError):
    """The owner already holds MAX_VERSIONS_PER_USER versions that are not archived."""

    def __init__(self, owner: str):
        super().__init__(owner)
        self.owner = owner


def open_count(conn, owner: str | None, exclude_id: int | None = None) -> int:
    """How many versions `owner` holds that are not archived (usernames compared ignoring case)."""
    if not owner:
        return 0
    return conn.execute(
        "SELECT count(*) FROM spi.saved_version WHERE lower(created_by) = lower(%s) AND status <> 'ARCHIVED' "
        "AND version_id IS DISTINCT FROM %s", (owner, exclude_id)).fetchone()[0]


def _check_limit(conn, owner: str | None, exclude_id: int | None = None) -> None:
    """Refuse one more open version for `owner`. The lock (per owner) holds until the transaction ends, so two saves
    at once cannot both take the last place. A version with no owner (login off) is not limited."""
    if not owner:
        return
    conn.execute("SELECT pg_advisory_xact_lock(hashtext('spi.saved_version.owner:' || lower(%s)))", (owner,))
    if open_count(conn, owner, exclude_id) >= MAX_VERSIONS_PER_USER:
        raise LimitReached(owner)


def _num(v):
    return None if v is None or v != v else float(v)


def _upsert(conn, table: str, keys: list[str], cols: list[str], rows, delete_where: str, params: tuple) -> None:
    """Upsert `rows` into spi.<table> through a staging table; rows of the slice `delete_where` not sent are deleted.
    A row is updated only when a value differs, so an unchanged re-save leaves no dead rows."""
    stg = f"stg_{table}"
    conn.execute(f"DROP TABLE IF EXISTS pg_temp.{stg}")
    # INCLUDING INDEXES: the "no longer sent" delete probes the staging table by key; without its index a save of
    # ~40k dealer results ran a nested loop for minutes.
    conn.execute(f"CREATE TEMP TABLE {stg} (LIKE spi.{table} INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING INDEXES) "
                 "ON COMMIT DROP")
    with conn.cursor() as cur, cur.copy(f"COPY {stg} ({', '.join(cols)}) FROM STDIN") as cp:
        for row in rows:
            cp.write_row(row)
    conn.execute(f"ANALYZE {stg}")
    values = [c for c in cols if c not in keys]
    changed = f"({', '.join(f't.{c}' for c in values)}) IS DISTINCT FROM ({', '.join(f'EXCLUDED.{c}' for c in values)})"
    conn.execute(f"INSERT INTO spi.{table} AS t ({', '.join(cols)}) SELECT {', '.join(cols)} FROM {stg} "
                 f"ON CONFLICT ({', '.join(keys)}) DO UPDATE SET "
                 f"{', '.join(f'{c} = EXCLUDED.{c}' for c in values)} WHERE {changed}")
    match = " AND ".join(f"s.{k} = t.{k}" for k in keys)
    conn.execute(f"DELETE FROM spi.{table} t WHERE {delete_where} AND NOT EXISTS (SELECT 1 FROM {stg} s WHERE {match})",
                 params)


def _write_definition(conn, version_id: int, adjustments: list[dict], layouts: dict[str, dict],
                      next_layouts: dict[str, dict] | None = None) -> None:
    _upsert(conn, "saved_version_edit", ["version_id", *ADJ_PK], ["version_id", *ADJ_COLS],
            [(version_id, *(a.get(c) for c in ADJ_COLS)) for a in adjustments],
            "t.version_id = %s", (version_id,))
    rows = [(version_id, "current", *k.split("::", 1), Jsonb(v)) for k, v in sorted(layouts.items())]
    rows += [(version_id, "next", *k.split("::", 1), Jsonb(v)) for k, v in sorted((next_layouts or {}).items())]
    _upsert(conn, "saved_version_layout", ["version_id", "period", "scheme_key", "component"],
            ["version_id", "period", "scheme_key", "component", "layout"], rows,
            "t.version_id = %s", (version_id,))


def name_taken(conn, name: str, exclude_id: int | None = None) -> bool:
    """True when another version, archived ones included, has this name (case and outer spaces ignored)."""
    return conn.execute(
        "SELECT 1 FROM spi.saved_version WHERE lower(btrim(name)) = lower(btrim(%s)) AND version_id IS DISTINCT FROM %s",
        (name, exclude_id)).fetchone() is not None


def _claim_name(conn, name: str, exclude_id: int | None = None) -> None:
    """Names are unique (also a unique index). The lock holds until the transaction ends."""
    conn.execute("SELECT pg_advisory_xact_lock(hashtext('spi.saved_version.name'))")
    if name_taken(conn, name, exclude_id):
        raise NameTaken(f'A version named "{name.strip()}" already exists; choose another name')


def _act(conn, actor: dict | None) -> None:
    """Who is acting in this transaction, for spi's row-level security (migration 0002): role, username and the
    schemes a manager may edit. None: the server itself (recalculation, retention)."""
    if actor:
        conn.execute("SELECT set_config('spi.role', %s, true), set_config('spi.username', %s, true), "
                     "set_config('spi.schemes', %s, true)",
                     (actor["role"], actor["username"], ",".join(sorted(actor.get("schemes") or ()))))


def _create(conn, meta: dict, base_month: date, adjustments: list[dict], layouts: dict[str, dict],
            next_layouts: dict[str, dict] | None = None, actor: dict | None = None) -> int:
    _claim_name(conn, meta["name"])
    who = actor or {}
    _check_limit(conn, who.get("username"))
    version_id, = conn.execute(
        "INSERT INTO spi.saved_version (name, note, volume_growth_pct, removed_schemes, base_month, created_by, "
        "created_by_id, updated_by, updated_by_id) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING version_id",
        (*(meta[c] for c in META_COLS), base_month, who.get("username"), who.get("user_id"), who.get("username"),
         who.get("user_id"))).fetchone()
    _write_definition(conn, version_id, adjustments, layouts, next_layouts)
    return version_id


def _update(conn, version_id: int, meta: dict, adjustments: list[dict], layouts: dict[str, dict],
            next_layouts: dict[str, dict] | None = None, actor: dict | None = None) -> None:
    cols = ", ".join(META_COLS)
    marks = ", ".join(["%s"] * len(META_COLS))
    _claim_name(conn, meta["name"], version_id)
    conn.execute(f"UPDATE spi.saved_version SET ({cols}) = ({marks}), updated_at = now() "
                 f"WHERE version_id = %s AND ({cols}) IS DISTINCT FROM ({marks})",
                 (*(meta[c] for c in META_COLS), version_id, *(meta[c] for c in META_COLS)))
    if actor:
        conn.execute("UPDATE spi.saved_version SET updated_by = %s, updated_by_id = %s WHERE version_id = %s",
                     (actor["username"], actor.get("user_id"), version_id))
    _write_definition(conn, version_id, adjustments, layouts, next_layouts)


def save(version_id: int | None, meta: dict, base_month: date, adjustments: list[dict], layouts: dict[str, dict],
         next_layouts: dict[str, dict], results: list[tuple[dict, dict]], actor: dict | None = None) -> int:
    """Create (version_id None) or update a version with its live results and a dated snapshot per month, all in
    ONE transaction. `results` holds (result, source) per month; `actor` is who saves (role, username, schemes,
    user_id). Raises NameTaken when another version has the name, LimitReached when a new one would pass the limit."""
    with connection() as conn:
        _act(conn, actor)
        if version_id is None:
            version_id = _create(conn, meta, base_month, adjustments, layouts, next_layouts, actor)
        else:
            _update(conn, version_id, meta, adjustments, layouts, next_layouts, actor)
        for result, source in results:
            _write_live(conn, version_id, result, source)
        for result, source in results:
            _insert_snapshot(conn, version_id, "save", result, source)
    return version_id


def _schemes_doc(result: dict) -> list[dict]:
    """Per scheme: its figures, and per component both sides' slab rows (as the snapshot view reads them)."""
    out = []
    for s in result["schemes"]:
        doc = {c: (s["scheme"] if c == "scheme_key" else s[c]) for c in SCHEME_COLS}
        doc["components"] = {
            component: {side: [{"slab_mode": r["slab_mode"], "formula": r["formula"], "pack_size": int(r["pack_size"]),
                                "slab_lower": _num(r["slab_lower"]), "slab_upper": _num(r["slab_upper"]),
                                "rate": float(r["rate"]), "dealers": int(r["dealers"]), "volume": float(r["volume"]),
                                "gsr": float(r["gsr"]), "cn": float(r["cn"])} for r in sides[side]]
                        for side in ("actual", "version")}
            for component, sides in s["components"].items()}
        out.append(doc)
    return out


def _header(result: dict, source: dict) -> tuple:
    t = result["totals"]
    return (source["file"], source["as_of"], source["month"], result["factor"], t["dealers"], t["dealers_moved"],
            t["actual_gsr"], t["version_gsr"], t["actual_cn"], t["version_cn"], result["warnings"])


def _insert_snapshot(conn, version_id: int, kind: str, result: dict, source: dict) -> int:
    snap, = conn.execute(
        f"INSERT INTO spi.saved_version_snapshot (version_id, kind, {', '.join(HEADER_COLS)}, schemes) "
        f"VALUES (%s, %s, {', '.join(['%s'] * len(HEADER_COLS))}, %s) RETURNING snapshot_id",
        (version_id, kind, *_header(result, source), Jsonb(_schemes_doc(result)))).fetchone()
    return snap


def write_live(version_id: int, results: list[tuple[dict, dict]]) -> None:
    """A recalculation's live results (result, source per month), in one transaction."""
    with connection() as conn:
        for result, source in results:
            _write_live(conn, version_id, result, source)


def _write_live(conn, version_id: int, result: dict, source: dict) -> None:
    """One month's live result: rewritten only when a figure changed."""
    cols = ", ".join([*HEADER_COLS, "schemes"])
    assign = ", ".join(f"{c} = EXCLUDED.{c}" for c in [*HEADER_COLS, "schemes"])
    changed = (f"({', '.join(f's.{c}' for c in [*HEADER_COLS, 'schemes'])}) IS DISTINCT FROM "
               f"({', '.join(f'EXCLUDED.{c}' for c in [*HEADER_COLS, 'schemes'])})")
    conn.execute(
        f"INSERT INTO spi.saved_version_snapshot AS s (version_id, kind, {cols}) "
        f"VALUES (%s, 'live', {', '.join(['%s'] * (len(HEADER_COLS) + 1))}) "
        f"ON CONFLICT (version_id, month) WHERE kind = 'live' DO UPDATE SET {assign}, taken_at = now() "
        f"WHERE {changed}", (version_id, *_header(result, source), Jsonb(_schemes_doc(result))))
    moved = result["moved"]
    # The month's dealer list is replaced whole (a delete and one COPY): ~100k rows a month, where comparing them
    # row by row against the stored list took minutes per save.
    conn.execute("DELETE FROM spi.saved_version_dealer_result WHERE version_id = %s AND month = %s",
                 (version_id, source["month"]))
    if len(moved):
        with conn.cursor() as cur, cur.copy("COPY spi.saved_version_dealer_result (version_id, month, "
                                            f"{', '.join(DEALER_COLS)}) FROM STDIN") as cp:
            for r in moved.itertuples(index=False):
                cp.write_row((version_id, source["month"], int(r.customer_code), r.scheme_key, r.component,
                              float(r.slab_basis_a), _num(r.slab_lower_a), float(r.simulated_rate_a),
                              float(r.simulated_cn_a), float(r.slab_basis_s), _num(r.slab_lower_s),
                              float(r.simulated_rate_s), float(r.simulated_cn_s)))
    conn.execute("UPDATE spi.saved_version SET computed_source = %s, computed_at = now() WHERE version_id = %s",
                 (source["file"], version_id))


def _rows(cur) -> list[dict]:
    names = [d.name for d in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]


def list_all() -> list[dict]:
    with connection() as conn:
        return _rows(conn.execute(
            "SELECT s.version_id, s.name, s.note, s.base_month, s.volume_growth_pct, s.status, "
            "s.created_by, s.updated_by, s.created_at, s.updated_at, s.computed_source, s.computed_at, "
            "(SELECT count(*) FROM spi.saved_version_edit a WHERE a.version_id = s.version_id) AS adjustments, "
            "(SELECT count(*) FROM spi.saved_version_layout l WHERE l.version_id = s.version_id) AS slab_edits, "
            "(SELECT count(*) FROM spi.saved_version_snapshot n WHERE n.version_id = s.version_id AND n.kind = 'save') "
            "AS saves, (SELECT coalesce(json_agg(json_build_object('month', to_char(v.month, 'YYYY-MM'), "
            "'dealers_moved', v.dealers_moved, 'actual_cn', v.actual_cn, 'version_cn', v.version_cn, "
            "'actual_gsr', v.actual_gsr, 'version_gsr', v.version_gsr) ORDER BY v.month), '[]') "
            "FROM spi.saved_version_snapshot v WHERE v.version_id = s.version_id AND v.kind = 'live') AS months "
            "FROM spi.saved_version s ORDER BY s.updated_at DESC"))


def get(version_id: int) -> dict | None:
    with connection() as conn:
        found = _rows(conn.execute("SELECT * FROM spi.saved_version WHERE version_id = %s", (version_id,)))
        if not found:
            return None
        out = found[0]
        out["adjustments"] = _rows(conn.execute(
            f"SELECT {', '.join(ADJ_COLS)} FROM spi.saved_version_edit WHERE version_id = %s "
            "ORDER BY period, CASE scope_kind WHEN 'all' THEN 0 WHEN 'zone' THEN 1 WHEN 'region' THEN 2 ELSE 3 END, "
            "scope_value, product, metric, mode", (version_id,)))
        tables = conn.execute("SELECT period, scheme_key, component, layout FROM spi.saved_version_layout "
                              "WHERE version_id = %s", (version_id,)).fetchall()
        out["layouts"] = {f"{k}::{c}": v for p, k, c, v in tables if p == "current"}
        out["next_layouts"] = {f"{k}::{c}": v for p, k, c, v in tables if p == "next"}
        out["snapshots"] = _rows(conn.execute(
            "SELECT snapshot_id, kind, taken_at, source_file, as_of, to_char(month, 'YYYY-MM') AS month, "
            "dealers_moved, actual_cn, version_cn FROM spi.saved_version_snapshot WHERE version_id = %s "
            "ORDER BY month, kind = 'live' DESC, taken_at DESC", (version_id,)))
    return out


def snapshot(version_id: int, snapshot_id: int) -> dict | None:
    with connection() as conn:
        head = _rows(conn.execute("SELECT * FROM spi.saved_version_snapshot WHERE version_id = %s AND snapshot_id = %s",
                                  (version_id, snapshot_id)))
    if not head:
        return None
    out = head[0]
    out["schemes"] = sorted(out["schemes"], key=lambda s: s["scheme_key"])
    return out


def moved_dealers(version_id: int, month: date | None, scheme: str | None, q: str, page: int,
                  page_size: int) -> dict:
    """Dealers whose slab or rate moved in a live result, with names and geography from the file the results were
    computed on (client data), one page at a time."""
    where, params = ["r.version_id = %s"], [version_id]
    if month:
        where.append("r.month = %s")
        params.append(month)
    if scheme:
        where.append("r.scheme_key = %s")
        params.append(scheme)
    if q.strip():
        # % and _ are literal characters in a search, not wildcards (backslash is LIKE's escape character).
        text = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        where.append("(r.customer_code::text LIKE %s OR lower(d.customer_name) LIKE %s)")
        params += [f"%{text}%", f"%{text.lower()}%"]
    sql = (" FROM spi.saved_version_dealer_result r JOIN spi.saved_version s USING (version_id) "
           "LEFT JOIN spi.file_dealer d ON d.dealer_code = r.customer_code AND d.file_id = "
           "(SELECT max(file_id) FROM spi.source_file f WHERE f.file_name = s.computed_source) "
           "LEFT JOIN spi.geo_unit g ON g.geo_id = d.geo_id WHERE " + " AND ".join(where))
    with connection() as conn:
        total, = conn.execute("SELECT count(*)" + sql, params).fetchone()
        pages = max(1, -(-total // page_size))
        page = min(page, pages)
        rows = _rows(conn.execute(
            "SELECT to_char(r.month, 'YYYY-MM') AS month, r.customer_code::text AS customer_code, d.customer_name, "
            "g.zone, g.region, r.scheme_key, "
            "r.component, r.actual_basis, r.actual_lower, r.actual_rate, r.actual_cn, r.version_basis, "
            "r.version_lower, r.version_rate, r.version_cn" + sql
            + " ORDER BY abs(r.version_cn - r.actual_cn) DESC, r.customer_code, r.scheme_key, r.component "
            "LIMIT %s OFFSET %s", [*params, page_size, (page - 1) * page_size]))
    return {"total": total, "page": page, "pages": pages, "page_size": page_size, "rows": rows}


def set_status(version_id: int, status: str, actor: dict | None = None) -> bool:
    """False when there is no such version. An unchanged status writes nothing. Restoring an archived version counts
    towards its owner's limit (LimitReached)."""
    who = actor or {}
    with connection() as conn:
        _act(conn, actor)
        found = conn.execute("SELECT status, created_by FROM spi.saved_version WHERE version_id = %s",
                             (version_id,)).fetchone()
        if not found:
            return False
        if status != "ARCHIVED" and found[0] == "ARCHIVED":
            _check_limit(conn, found[1], version_id)
        conn.execute("UPDATE spi.saved_version SET status = %s, updated_at = now(), "
                     "updated_by = coalesce(%s, updated_by), updated_by_id = coalesce(%s, updated_by_id) "
                     "WHERE version_id = %s AND status IS DISTINCT FROM %s",
                     (status, who.get("username"), who.get("user_id"), version_id, status))
    return True


def stale(base_month: date, source_file: str) -> list[int]:
    """Versions of the live month not yet computed on its current file (archived ones are left as they are)."""
    with connection() as conn:
        return [i for (i,) in conn.execute(
            "SELECT version_id FROM spi.saved_version WHERE base_month = %s AND status <> 'ARCHIVED' "
            "AND computed_source IS DISTINCT FROM %s ORDER BY version_id", (base_month, source_file))]


def definition(version_id: int) -> dict:
    """What compute() needs, as saved."""
    s = get(version_id)
    return {"volume_growth_pct": s["volume_growth_pct"], "removed_schemes": list(s["removed_schemes"] or []),
            "adjustments": [a for a in s["adjustments"] if a["period"] == "current"],
            "next_adjustments": [a for a in s["adjustments"] if a["period"] == "next"],
            "layouts": {k: v if isinstance(v, dict) else json.loads(v) for k, v in s["layouts"].items()},
            "next_layouts": {k: v if isinstance(v, dict) else json.loads(v) for k, v in s["next_layouts"].items()}}


def delete(version_id: int, actor: dict | None = None) -> bool:
    """Delete a version for good, with its edits, results and snapshots (ON DELETE CASCADE). False when there is no
    such version (or row-level security hides it from this login)."""
    with connection() as conn:
        _act(conn, actor)
        return conn.execute("DELETE FROM spi.saved_version WHERE version_id = %s",
                            (version_id,)).rowcount > 0


def retention_cutoff(live_month: date, keep: int) -> date:
    """The first month whose versions are kept: `keep` months, the live month included (3, Nov live: 1 Sep)."""
    index = live_month.year * 12 + live_month.month - 1 - (keep - 1)
    return date(index // 12, index % 12 + 1, 1)


def prune(live_month: date, dry_run: bool = False) -> dict:
    """Delete every version (saved or archived) saved in a month before the kept window: the live month and the
    VERSION_RETENTION_MONTHS - 1 before it (0 keeps all). Edits, results and snapshots go with them (cascade)."""
    keep = get_settings().version_retention_months
    if keep <= 0:
        return {"kept_months": None}
    cutoff = retention_cutoff(live_month, keep)
    # The owner's login where there is one (the loader): only a table's owner may VACUUM it.
    with connect(owner=get_settings().spi_owner_url is not None) as conn:
        gone = conn.execute("DELETE FROM spi.saved_version WHERE base_month < %s RETURNING version_id, name, "
                            "created_by, base_month", (cutoff,)).fetchall()
        if dry_run:
            conn.rollback()
        elif gone:
            conn.commit()
            conn.autocommit = True  # reclaim the dead rows of the cascaded tables and re-plan
            for table in ("saved_version", "saved_version_edit", "saved_version_layout", "saved_version_dealer_result",
                          "saved_version_snapshot"):
                conn.execute(f"VACUUM (ANALYZE) spi.{table}")
    return {"keep_from": str(cutoff), "versions": len(gone), "dry_run": dry_run,
            "deleted": [{"version_id": i, "name": n, "created_by": c, "month": str(m)[:7]} for i, n, c, m in gone]}
