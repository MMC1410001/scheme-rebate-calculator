"""Log in, log out, who am I (app/auth.py). The only business-version routes that need no session."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app import auth, users

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=200)


class MeOut(BaseModel):
    username: str
    role: auth.Role
    # False on a developer machine without users (APP_ENV=local): no login screen, no Log out.
    login_required: bool
    # The schemes this login may edit; None: every scheme (ADMIN). A VIEWER has none.
    edit_schemes: list[str] | None = None
    can_save: bool = False
    can_see_dealers: bool = False


def _me(user: auth.Session, login_required: bool) -> MeOut:
    return MeOut(username=user.username, role=user.role, login_required=login_required,
                 edit_schemes=None if user.is_admin else sorted(user.schemes) if user.role == "SCHEME_MANAGER" else [],
                 can_save=user.can_save, can_see_dealers=user.can_see_dealers)


def _json_only(request: Request) -> None:
    kind = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if kind != "application/json":
        raise HTTPException(415, "The request must be sent as JSON.")


@router.post("/login", response_model=MeOut, dependencies=[Depends(_json_only)])
def login(body: LoginIn, request: Request, response: Response) -> MeOut:
    state = auth.mode()
    if state == "off":
        return _me(auth.LOCAL, False)
    if state == "not_set_up":
        raise HTTPException(503, auth.NOT_SET_UP)
    ip = auth.client_ip(request)
    name = body.username.strip().lower()[:64]
    user_key = f"{name}|{ip}"
    # Each attempt is counted as it starts (begin), and forgiven on success, so parallel attempts cannot slip past.
    if not auth.LIMITER.begin(ip):
        too_many = True
    elif not auth.USER_LIMITER.begin(user_key):
        auth.LIMITER.undo(ip)
        too_many = True
    else:
        too_many = False
    if too_many:
        auth.audit.warning("login refused (too many failures): user=%r ip=%s", name, ip)
        raise HTTPException(429, "Too many attempts. Please try again in 15 minutes.")
    user = auth.authenticate(body.username, body.password)
    if user is None:
        auth.audit.info("login failed: user=%r ip=%s", name, ip)
        users.audit(name, "login.failed", None, {"ip": ip})
        raise HTTPException(401, auth.WRONG)
    auth.LIMITER.reset(ip)
    auth.USER_LIMITER.reset(user_key)
    auth.audit.info("login: user=%s role=%s ip=%s", user.username, user.role, ip)
    users.audit(user.username, "login", None, {"ip": ip, "role": user.role})
    if user.user_id is not None:
        users.record_login(user.user_id)
    response.set_cookie(auth.COOKIE, auth.session_cookie(user), max_age=auth.SESSION_TTL_SECONDS, path="/",
                        httponly=True, secure=auth.cookie_secure(), samesite="strict")
    response.headers["Cache-Control"] = "no-store"
    return _me(auth.session_of(user), True)


@router.post("/logout", status_code=204, dependencies=[Depends(_json_only)])
def logout(request: Request, response: Response) -> Response:
    # Revoked on the server too, so a copy of the cookie stops working (app/auth.py).
    who = auth.revoke_session(request.cookies.get(auth.COOKIE))
    if who:
        auth.audit.info("logout: user=%s", who)
        users.audit(who, "logout")
    response.delete_cookie(auth.COOKIE, path="/", httponly=True, secure=auth.cookie_secure(), samesite="strict")
    response.status_code = 204
    return response


@router.get("/me", response_model=MeOut)
def me(user: auth.Session = Depends(auth.current_user)) -> MeOut:
    return _me(user, auth.mode() == "on")
