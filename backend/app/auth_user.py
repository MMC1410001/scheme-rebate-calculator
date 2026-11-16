"""Users and their access, from backend/ (no admin screen yet; user's choice, 5 Nov 2026):

  python -m app.auth_user add <username> --role ADMIN|SCHEME_MANAGER|VIEWER [--schemes premium,primer]
  python -m app.auth_user assign <username> <scheme>[,<scheme>...]     a manager's schemes, by key or name
  python -m app.auth_user revoke <username> <scheme>[,<scheme>...]
  python -m app.auth_user role <username> ADMIN|SCHEME_MANAGER|VIEWER
  python -m app.auth_user reset-password <username>
  python -m app.auth_user deactivate|activate <username>
  python -m app.auth_user list

Users live in the database (spi.app_user, spi.user_scheme; SPI_OWNER_URL). A new or reset password is random and
printed once; only its hash is stored. Any change ends that user's sessions. Every change is in spi.audit_log.

The older form, `python -m app.auth_user <username> [ADMIN|VIEWER]`, still prints an entry for ADMIN_USERS in the env
file (or the hash for the built-in admin's ADMIN_PASSWORD).
"""
from __future__ import annotations

import argparse
import getpass
import json
import secrets
import sys

from psycopg.types.json import Jsonb

from app.auth import ENV_ROLES, ROLES, USERNAME_PATTERN, hash_password

COMMANDS = ("add", "assign", "revoke", "role", "reset-password", "deactivate", "activate", "list")


def _env_entry(argv: list[str]) -> int:
    username, role = argv[0], (argv[1].upper() if len(argv) == 2 else "VIEWER")
    if not USERNAME_PATTERN.match(username):
        print("A username is 1-64 letters, digits or . _ @ -")
        return 2
    if role not in ENV_ROLES:
        print("In the env file the role is ADMIN or VIEWER; a SCHEME_MANAGER is added with: add <username> --role "
              "SCHEME_MANAGER --schemes ...")
        return 2
    password = secrets.token_urlsafe(15)
    hashed = hash_password(password)
    print(f"Password for {username} (shown once): {password}")
    print("Add this entry to the ADMIN_USERS JSON object in the env file:")
    print(json.dumps({username: {"role": role, "password": hashed}})[1:-1])
    if role == "ADMIN":
        print(f"Or, for the built-in admin: ADMIN_USERNAME={username} and ADMIN_PASSWORD={hashed}")
    return 0


class Problem(Exception):
    pass


def _who() -> str:
    try:
        return f"cli:{getpass.getuser()}"
    except Exception:
        return "cli"


def _env_names() -> set[str]:
    from app.config import get_settings

    s = get_settings()
    names = {s.admin_username.lower()} if s.admin_username else set()
    try:
        names |= {n.lower() for n in json.loads(s.admin_users.get_secret_value() if s.admin_users else "{}")}
    except ValueError:
        pass
    return names


def _user(conn, username: str) -> tuple[int, str, str, bool]:
    row = conn.execute("SELECT user_id, username, role, active FROM spi.app_user WHERE lower(username) = lower(%s)",
                       (username,)).fetchone()
    if row is None:
        raise Problem(f"There is no user {username}")
    return row


def _schemes(conn, text: str) -> list[tuple[int, str]]:
    """Scheme ids and keys for "premium,Hue Basic & Glow Max": each by its key, else by its name (any case)."""
    out = []
    for part in [p.strip() for p in text.split(",") if p.strip()]:
        rows = conn.execute("SELECT scheme_id, code FROM spi.scheme WHERE code = %s", (part,)).fetchall() or \
            conn.execute("SELECT scheme_id, code FROM spi.scheme WHERE lower(label) = lower(%s) OR lower(code) = lower(%s)",
                         (part, part)).fetchall()
        if not rows:
            raise Problem(f"There is no scheme {part!r} (python -m app.auth_user list shows the keys in use)")
        if len(rows) > 1:
            raise Problem(f"{part!r} names several schemes ({', '.join(r[1] for r in rows)}); use one of these keys")
        out.append(rows[0])
    if not out:
        raise Problem("Name at least one scheme")
    return out


def _changed(conn, user_id: int, action: str, username: str, detail: dict | None = None) -> None:
    conn.execute("UPDATE spi.app_user SET access_version = access_version + 1, updated_at = now() WHERE user_id = %s",
                 (user_id,))
    conn.execute("INSERT INTO spi.audit_log (username, action, target, detail) VALUES (%s, %s, %s, %s)",
                 (_who(), action, username, Jsonb(detail) if detail else None))


def _run(args) -> str:
    from app.spi import connect

    with connect(owner=True) as conn:
        if args.command == "list":
            rows = conn.execute(
                "SELECT u.username, u.role, u.active, u.last_login_at, "
                "coalesce(string_agg(s.code, ', ' ORDER BY s.code), '') FROM spi.app_user u "
                "LEFT JOIN spi.user_scheme us USING (user_id) LEFT JOIN spi.scheme s USING (scheme_id) "
                "GROUP BY u.user_id ORDER BY lower(u.username)").fetchall()
            if not rows:
                return "No database users yet."
            lines = []
            for name, role, active, seen, schemes in rows:
                when = f"last login {seen:%Y-%m-%d %H:%M}" if seen else "never logged in"
                lines.append(f"{name:24} {role:15} {'active' if active else 'inactive':9} {when}"
                             + (f"  schemes: {schemes or '-'}" if role == "SCHEME_MANAGER" else ""))
            return "\n".join(lines)

        if args.command == "add":
            role = args.role.upper()
            if not USERNAME_PATTERN.match(args.username):
                raise Problem("A username is 1-64 letters, digits or . _ @ -")
            if role not in ROLES:
                raise Problem("The role is ADMIN, SCHEME_MANAGER or VIEWER")
            if args.username.lower() in _env_names():
                raise Problem(f"{args.username} is already a user of the env file; choose another name")
            if conn.execute("SELECT 1 FROM spi.app_user WHERE lower(username) = lower(%s)",
                            (args.username,)).fetchone():
                raise Problem(f"There is already a user {args.username}")
            if role == "SCHEME_MANAGER" and not args.schemes:
                raise Problem("A SCHEME_MANAGER needs --schemes")
            if role != "SCHEME_MANAGER" and args.schemes:
                raise Problem("Only a SCHEME_MANAGER has schemes")
            schemes = _schemes(conn, args.schemes) if args.schemes else []
            password = secrets.token_urlsafe(15)
            user_id, = conn.execute("INSERT INTO spi.app_user (username, password_hash, role) VALUES (%s, %s, %s) "
                                    "RETURNING user_id", (args.username, hash_password(password), role)).fetchone()
            for scheme_id, _ in schemes:
                conn.execute("INSERT INTO spi.user_scheme (user_id, scheme_id, granted_by) VALUES (%s, %s, %s)",
                             (user_id, scheme_id, _who()))
            _changed(conn, user_id, "user.add", args.username, {"role": role, "schemes": [c for _, c in schemes]})
            return (f"Added {args.username} ({role}{': ' + ', '.join(c for _, c in schemes) if schemes else ''}).\n"
                    f"Password (shown once): {password}")

        user_id, username, role, active = _user(conn, args.username)
        if args.command in ("assign", "revoke"):
            if role != "SCHEME_MANAGER":
                raise Problem(f"{username} is {role}; only a SCHEME_MANAGER has schemes")
            schemes = _schemes(conn, args.schemes)
            for scheme_id, _ in schemes:
                if args.command == "assign":
                    conn.execute("INSERT INTO spi.user_scheme (user_id, scheme_id, granted_by) VALUES (%s, %s, %s) "
                                 "ON CONFLICT DO NOTHING", (user_id, scheme_id, _who()))
                else:
                    conn.execute("DELETE FROM spi.user_scheme WHERE user_id = %s AND scheme_id = %s",
                                 (user_id, scheme_id))
            _changed(conn, user_id, f"user.{args.command}", username, {"schemes": [c for _, c in schemes]})
            left = [c for (c,) in conn.execute("SELECT s.code FROM spi.user_scheme JOIN spi.scheme s USING (scheme_id) "
                                               "WHERE user_id = %s ORDER BY 1", (user_id,))]
            return f"{username} manages: {', '.join(left) or 'no scheme'}"
        if args.command == "role":
            new = args.role.upper()
            if new not in ROLES:
                raise Problem("The role is ADMIN, SCHEME_MANAGER or VIEWER")
            conn.execute("UPDATE spi.app_user SET role = %s WHERE user_id = %s", (new, user_id))
            if new != "SCHEME_MANAGER":
                conn.execute("DELETE FROM spi.user_scheme WHERE user_id = %s", (user_id,))
            _changed(conn, user_id, "user.role", username, {"from": role, "to": new})
            extra = " Give it schemes with: assign." if new == "SCHEME_MANAGER" else ""
            return f"{username} is now {new}.{extra}"
        if args.command == "reset-password":
            password = secrets.token_urlsafe(15)
            conn.execute("UPDATE spi.app_user SET password_hash = %s WHERE user_id = %s",
                         (hash_password(password), user_id))
            _changed(conn, user_id, "user.reset_password", username)
            return f"New password for {username} (shown once): {password}"
        conn.execute("UPDATE spi.app_user SET active = %s WHERE user_id = %s", (args.command == "activate", user_id))
        _changed(conn, user_id, f"user.{args.command}", username)
        return f"{username} is {'active' if args.command == 'activate' else 'deactivated: it can no longer log in'}."


def main(argv: list[str]) -> int:
    if argv and argv[0] not in COMMANDS and not argv[0].startswith("-"):
        if len(argv) > 2:
            print(__doc__.strip())
            return 2
        return _env_entry(argv)
    parser = argparse.ArgumentParser(prog="python -m app.auth_user", description="Users and their access")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("add")
    p.add_argument("username")
    p.add_argument("--role", required=True)
    p.add_argument("--schemes", default="")
    for name in ("assign", "revoke"):
        p = sub.add_parser(name)
        p.add_argument("username")
        p.add_argument("schemes")
    p = sub.add_parser("role")
    p.add_argument("username")
    p.add_argument("role")
    for name in ("reset-password", "deactivate", "activate"):
        sub.add_parser(name).add_argument("username")
    sub.add_parser("list")
    args = parser.parse_args(argv)
    try:
        print(_run(args))
    except Problem as exc:
        print(exc)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
