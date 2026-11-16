"""Login: users, roles and the session cookie (user's choice, 5 Nov 2026: "same as an earlier internal app").

Users:

- the built-in admin, from the env file (app/config.py): ADMIN_USERNAME / ADMIN_PASSWORD, role ADMIN. ADMIN_PASSWORD
  may be the password itself (local and dev only) or its hash; uat and prod accept only the hash;
- the database's users (spi.app_user, app/users.py), made with `python -m app.auth_user add ...`: ADMIN,
  SCHEME_MANAGER (with the schemes it manages, spi.user_scheme) or VIEWER;
- still read, for servers set up before the database users: ADMIN_USERS in the env file, a JSON object
  {"<username>": {"role": "ADMIN" | "VIEWER", "password": "<hash>"}}.
A hash is "pbkdf2-sha256:<iterations>:<salt base64url>:<hash base64url>" (the format of an earlier internal app).

Roles (app/access.py has the rules for edits): ADMIN may do everything. SCHEME_MANAGER sees everything, dealer lists
included, edits only its own schemes and their components, and saves versions, changing only its own. VIEWER sees
every view, but not the dealer lists, and changes nothing.

The session is an HttpOnly, SameSite=Strict cookie, 8 hours: base64url(JSON {u, exp, v, c}) + "." +
base64url(HMAC-SHA256(that, ADMIN_SESSION_SECRET)). `c` binds it to the user's current password (or hash) and role,
so changing either ends that user's sessions; rotating ADMIN_SESSION_SECRET ends everyone's. `j` is the session's id:
Log out revokes it on the server, so a copy of the cookie stops working too (kept in memory: a restart of the API
forgets the revocations, and the 8 hours still end it). Failed logins are limited per address (LOGIN_MAX_FAILURES in
LOGIN_WINDOW_SECONDS) and per username (USER_MAX_FAILURES); the address is the connection's own, or the last
X-Forwarded-For entry only when the connection comes from a trusted proxy (TRUSTED_PROXIES: our nginx).

APP_ENV=local with no users set: login is off (a developer machine; everyone is ADMIN). Anywhere else without users
and a secret, every business route answers 503 "login is not set up" rather than serving client data to anyone.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import re
import secrets
import socket
import threading
import time
from dataclasses import dataclass
from typing import Literal

from fastapi import Depends, HTTPException, Request

from app.config import APP_ENV, get_settings

log = logging.getLogger("app.auth")
audit = logging.getLogger("app.audit")

Role = Literal["ADMIN", "SCHEME_MANAGER", "VIEWER"]
ROLES: tuple[Role, ...] = ("ADMIN", "SCHEME_MANAGER", "VIEWER")
# ADMIN_USERS in the env file has no schemes to give a manager.
ENV_ROLES: tuple[Role, ...] = ("ADMIN", "VIEWER")
COOKIE = "spc_session"
SESSION_TTL_SECONDS = 8 * 60 * 60
SESSION_VERSION = 2   # 2: with the session id `j`; older cookies ask for a new login
MIN_SECRET_LENGTH = 32
PBKDF2_ITERATIONS = 600_000
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9._@-]{1,64}$")
_HASH_PATTERN = re.compile(r"^pbkdf2-sha256:(\d{4,7}):([A-Za-z0-9_-]{16,}):([A-Za-z0-9_-]{43})$")
LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_SECONDS = 15 * 60
# Per username, from any address: slows down guessing one account from many addresses. Higher than the per-address
# limit, so a mistyped password never locks a user out before their own address would be.
USER_MAX_FAILURES = 10
# Where the built-in admin's password may be written as it is; elsewhere it must be a hash.
PLAIN_PASSWORD_ENVS = ("local", "dev")

NOT_LOGGED_IN = "Please log in to continue."
NOT_ALLOWED = "Your login can view, but not do this. Ask an administrator."
NOT_SET_UP = "Login is not set up on this server yet. Ask the administrator."
WRONG = "The username or password is not correct."


@dataclass(frozen=True)
class User:
    username: str
    role: Role
    secret: str          # a PBKDF2 hash, or (plain=True) the built-in admin's password as written
    plain: bool = False
    schemes: frozenset[str] = frozenset()   # SCHEME_MANAGER: the schemes it may edit
    user_id: int | None = None              # a database user's id
    access_version: int = 0


@dataclass(frozen=True)
class Session:
    username: str
    role: Role
    schemes: frozenset[str] = frozenset()
    user_id: int | None = None

    @property
    def is_admin(self) -> bool:
        return self.role == "ADMIN"

    @property
    def can_save(self) -> bool:
        return self.role in ("ADMIN", "SCHEME_MANAGER")

    @property
    def can_see_dealers(self) -> bool:
        return self.role in ("ADMIN", "SCHEME_MANAGER")

    def can_edit_scheme(self, key: str) -> bool:
        return self.is_admin or (self.role == "SCHEME_MANAGER" and key in self.schemes)


LOCAL = Session("local", "ADMIN")   # APP_ENV=local without users: login off


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def hash_password(password: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations, 32)
    return f"pbkdf2-sha256:{iterations}:{_b64(salt)}:{_b64(digest)}"


def _check_hash(password: str, stored: str) -> bool:
    m = _HASH_PATTERN.match(stored)
    if not m:
        return False
    iterations, salt, expected = int(m[1]), _unb64(m[2]), _unb64(m[3])
    return hmac.compare_digest(hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations, 32), expected)


def parse_users(username: str | None, password: str | None, users_json: str | None) -> tuple[list[User], list[str]]:
    """The built-in admin and the users of ADMIN_USERS, and why any entry was ignored (never a password or hash)."""
    users: list[User] = []
    problems: list[str] = []
    if username and password:
        if _HASH_PATTERN.match(password):
            users.append(User(username, "ADMIN", password))
        elif APP_ENV in PLAIN_PASSWORD_ENVS:
            users.append(User(username, "ADMIN", password, plain=True))
        else:
            problems.append(f"ADMIN_PASSWORD must be a password hash on {APP_ENV} "
                            "(python -m app.auth_user <username> ADMIN)")
    raw = (users_json or "").strip()
    if not raw:
        return users, problems
    try:
        value = json.loads(raw)
    except ValueError:
        return users, ["ADMIN_USERS is not valid JSON"]
    if not isinstance(value, dict):
        return users, ["ADMIN_USERS must be a JSON object of username -> {role, password}"]
    for name, entry in value.items():
        if not USERNAME_PATTERN.match(str(name)):
            problems.append(f"ADMIN_USERS: '{str(name)[:64]}' is not a valid username")
        elif any(u.username == name for u in users):
            problems.append(f"ADMIN_USERS: '{name}' is listed twice; the first entry is used")
        elif not isinstance(entry, dict) or entry.get("role") not in ENV_ROLES:
            problems.append(f"ADMIN_USERS: '{name}' needs a role, ADMIN or VIEWER")
        elif not _HASH_PATTERN.match(str(entry.get("password", ""))):
            problems.append(f"ADMIN_USERS: '{name}' has no valid password hash (python -m app.auth_user)")
        else:
            users.append(User(name, entry["role"], entry["password"]))
    return users, problems


def _config() -> tuple[list[User], str | None]:
    """The env file's users, then the database's (a name the env file already has is skipped), and the secret."""
    from app.users import active_users

    s = get_settings()
    users, _ = parse_users(s.admin_username, s.admin_password.get_secret_value() if s.admin_password else None,
                           s.admin_users.get_secret_value() if s.admin_users else None)
    taken = {u.username.lower() for u in users}
    users += [User(d.username, d.role, d.password_hash, schemes=d.schemes, user_id=d.user_id,
                   access_version=d.access_version)
              for d in active_users() if d.username.lower() not in taken and d.role in ROLES]
    secret = s.admin_session_secret.get_secret_value() if s.admin_session_secret else None
    return users, secret


def mode() -> Literal["on", "off", "not_set_up"]:
    """on: login required. off: APP_ENV=local with nothing set. not_set_up: anywhere else without users and secret."""
    users, secret = _config()
    if users and secret and len(secret) >= MIN_SECRET_LENGTH:
        return "on"
    if APP_ENV == "local" and not users and not secret:
        return "off"
    return "not_set_up"


def config_problems() -> list[str]:
    """Why login is not usable, for the start-up log (never a secret's value)."""
    s = get_settings()
    _, problems = parse_users(s.admin_username, s.admin_password.get_secret_value() if s.admin_password else None,
                              s.admin_users.get_secret_value() if s.admin_users else None)
    users, secret = _config()
    if bool(s.admin_username) != bool(s.admin_password):
        problems.append("ADMIN_USERNAME and ADMIN_PASSWORD are set together or not at all")
    if not users:
        problems.append("no user: set ADMIN_USERNAME / ADMIN_PASSWORD, or add users (python -m app.auth_user add)")
    if not secret:
        problems.append("ADMIN_SESSION_SECRET is not set")
    elif len(secret) < MIN_SECRET_LENGTH:
        problems.append(f"ADMIN_SESSION_SECRET must have at least {MIN_SECRET_LENGTH} characters")
    return problems


def _sign(secret: str, text: str) -> str:
    return _b64(hmac.new(secret.encode(), text.encode(), hashlib.sha256).digest())


def _credential_tag(secret: str, user: User) -> str:
    # A database user's schemes and access_version too: a change of role, schemes or password ends their sessions.
    access = f":{user.access_version}:{','.join(sorted(user.schemes))}" if user.user_id is not None else ""
    return _sign(secret, f"credential:{user.username}:{user.role}:{user.secret}{access}")[:22]


_DUMMY: list[str] = []


def _dummy_hash() -> str:
    if not _DUMMY:
        _DUMMY.append(hash_password(secrets.token_urlsafe(16)))
    return _DUMMY[0]


def authenticate(username: str, password: str) -> User | None:
    """The user for these credentials, or None. Exactly one full PBKDF2 check runs on every path (unknown name,
    built-in admin, other user), so the time taken does not tell which names exist."""
    users, _ = _config()
    # Env users by exact name; database users ignore case (their names are unique that way).
    found = next((u for u in users if u.username == username), None) or next(
        (u for u in users if u.user_id is not None and u.username.lower() == username.lower()), None)
    if found is None or found.plain:
        _check_hash(password, _dummy_hash())
        if found is None:
            return None
        ok = hmac.compare_digest(password.encode(), found.secret.encode())
    else:
        ok = _check_hash(password, found.secret)
    return found if ok else None


def session_cookie(user: User, now: float | None = None) -> str:
    _, secret = _config()
    if not secret:
        raise RuntimeError("ADMIN_SESSION_SECRET is not set")
    payload = {"u": user.username, "exp": int((now or time.time()) + SESSION_TTL_SECONDS), "v": SESSION_VERSION,
               "c": _credential_tag(secret, user), "j": secrets.token_urlsafe(12)}
    part = _b64(json.dumps(payload, separators=(",", ":")).encode())
    return f"{part}.{_sign(secret, part)}"


def _payload(value: str | None, now: float | None = None) -> dict | None:
    """The checked payload of a cookie value, or None when it is missing, forged, expired, revoked or its user
    changed."""
    if not value or value.count(".") != 1 or len(value) > 1024:
        return None
    users, secret = _config()
    if not secret:
        return None
    part, sig = value.split(".")
    # As bytes: compare_digest raises TypeError on text that is not ASCII (a made-up cookie was a 500).
    if not hmac.compare_digest(sig.encode(), _sign(secret, part).encode()):
        return None
    try:
        payload = json.loads(_unb64(part))
    except ValueError:
        return None
    now = now or time.time()
    exp = payload.get("exp")
    if payload.get("v") != SESSION_VERSION or not isinstance(exp, int) or exp <= now \
            or exp - now > SESSION_TTL_SECONDS + 60:
        return None
    user = next((u for u in users if u.username == payload.get("u")), None)
    if user is None or not hmac.compare_digest(str(payload.get("c", "")).encode(), _credential_tag(secret, user).encode()):
        return None
    if REVOKED.revoked(str(payload.get("j", "")), now):
        return None
    return {**payload, "role": user.role, "user": user}


def session_of(user: User) -> Session:
    return Session(user.username, user.role, user.schemes, user.user_id)


def read_session(value: str | None, now: float | None = None) -> Session | None:
    """The session of a cookie value, or None when it is missing, forged, expired, revoked or its user changed."""
    payload = _payload(value, now)
    return None if payload is None else session_of(payload["user"])


def revoke_session(value: str | None) -> str | None:
    """Log out on the server: this cookie (and any copy of it) stops working. Returns its user, if it was valid."""
    payload = _payload(value)
    if payload is None:
        return None
    REVOKED.add(str(payload["j"]), float(payload["exp"]))
    return payload["u"]


class _Revoked:
    """Session ids logged out before they expired, until they expire (in memory; bounded)."""

    def __init__(self, cap: int = 100_000):
        self.cap = cap
        self._ids: dict[str, float] = {}
        self._lock = threading.Lock()

    def add(self, session_id: str, exp: float) -> None:
        now = time.time()
        with self._lock:
            if len(self._ids) >= self.cap:
                for old in [k for k, e in self._ids.items() if e <= now] or list(self._ids)[: self.cap // 2]:
                    del self._ids[old]
            self._ids[session_id] = exp

    def revoked(self, session_id: str, now: float | None = None) -> bool:
        with self._lock:
            exp = self._ids.get(session_id)
        return exp is not None and exp > (now or time.time())


REVOKED = _Revoked()


def cookie_secure() -> bool:
    flag = get_settings().session_cookie_secure
    return APP_ENV != "local" if flag is None else flag


# ---- Failed logins, per address ------------------------------------------------------------------------------------

class LoginLimiter:
    def __init__(self, max_failures: int = LOGIN_MAX_FAILURES, window: float = LOGIN_WINDOW_SECONDS):
        self.max_failures, self.window = max_failures, window
        self._failures: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, ip: str, now: float) -> list[float]:
        kept = [t for t in self._failures.get(ip, []) if now - t < self.window]
        if kept:
            self._failures[ip] = kept
        else:
            self._failures.pop(ip, None)
        return kept

    def allowed(self, ip: str, now: float | None = None) -> bool:
        with self._lock:
            return len(self._recent(ip, now or time.time())) < self.max_failures

    def begin(self, ip: str, now: float | None = None) -> bool:
        """Check and count an attempt in one step, so parallel attempts cannot all pass before the first failure is
        counted. False when the limit is reached. A successful login then calls reset."""
        now = now or time.time()
        with self._lock:
            recent = self._recent(ip, now)
            if len(recent) >= self.max_failures:
                return False
            self._failures[ip] = [*recent, now]
            self._trim()
            return True

    def _trim(self) -> None:
        if len(self._failures) > 10_000:   # never grows without bound
            for old in list(self._failures)[:5_000]:
                del self._failures[old]

    def failed(self, ip: str, now: float | None = None) -> None:
        now = now or time.time()
        with self._lock:
            self._failures[ip] = [*self._recent(ip, now), now]
            self._trim()

    def undo(self, ip: str) -> None:
        """Take back the attempt begin just counted (the other limit refused the login before it was tried)."""
        with self._lock:
            kept = self._failures.get(ip, [])[:-1]
            if kept:
                self._failures[ip] = kept
            else:
                self._failures.pop(ip, None)

    def reset(self, ip: str) -> None:
        with self._lock:
            self._failures.pop(ip, None)


LIMITER = LoginLimiter()
# Per username AND address (user's choice, 5 Nov 2026): a per-username limit let anyone lock the real admin out by
# sending wrong passwords for "admin" from two addresses.
USER_LIMITER = LoginLimiter(max_failures=USER_MAX_FAILURES)

_TRUSTED: dict = {"at": -1e9, "addresses": frozenset()}
_TRUSTED_LOCK = threading.Lock()


def trusted_proxies() -> frozenset[str]:
    """The addresses of TRUSTED_PROXIES (IPs or host names, looked up again every 30 s: a restarted container gets a
    new address). A name that does not resolve here (scheme-performance-web outside Docker) is skipped."""
    now = time.monotonic()
    with _TRUSTED_LOCK:
        if now - _TRUSTED["at"] < 30:
            return _TRUSTED["addresses"]
    addresses: set[str] = set()
    for name in get_settings().trusted_proxy_list:
        try:
            addresses.add(str(ipaddress.ip_address(name)))
            continue
        except ValueError:
            pass
        try:
            addresses.update(str(info[4][0]) for info in socket.getaddrinfo(name, None))
        except OSError:
            pass
    with _TRUSTED_LOCK:
        _TRUSTED.update(at=now, addresses=frozenset(addresses))
    return frozenset(addresses)


def client_ip(request: Request) -> str:
    """The browser's address. The last X-Forwarded-For entry (the one nginx adds) only when the connection comes from
    a trusted proxy: anyone else could write that header themselves to dodge the login limit."""
    peer = request.client.host if request.client else "unknown"
    if peer in trusted_proxies():
        last = request.headers.get("x-forwarded-for", "").rsplit(",", 1)[-1].strip()
        if last:
            return last
    return peer


# ---- Route guards ---------------------------------------------------------------------------------------------------

_UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


def current_user(request: Request) -> Session:
    """Every business route: the logged-in user, else 401 (503 when login is not set up on this server).

    A request that changes or computes something must be JSON: with the SameSite=Strict cookie, this keeps another
    site's form from posting to the API in the user's name."""
    if request.method in _UNSAFE:
        kind = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if kind != "application/json":
            raise HTTPException(415, "The request must be sent as JSON.")
    state = mode()
    if state == "off":
        return LOCAL
    if state == "not_set_up":
        raise HTTPException(503, NOT_SET_UP)
    session = read_session(request.cookies.get(COOKIE))
    if session is None:
        raise HTTPException(401, NOT_LOGGED_IN)
    return session


def require_admin(user: Session = Depends(current_user)) -> Session:
    if not user.is_admin:
        raise HTTPException(403, NOT_ALLOWED)
    return user


def require_saver(user: Session = Depends(current_user)) -> Session:
    """ADMIN or SCHEME_MANAGER: may save versions (a manager only with its own schemes' edits, app/access.py)."""
    if not user.can_save:
        raise HTTPException(403, NOT_ALLOWED)
    return user
