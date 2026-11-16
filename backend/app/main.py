"""Scheme Performance & Impact Calculator API: the app, its middleware, start-up and the routers.

The routes are in app/routers (slabs, months, versions), the request bodies in app/schemas.py, and what they
compute in app/service (the live month and its caches, saved versions, the trend).

Every business route is versioned: /v1/... (API_VERSION). A change a client would notice (a field renamed or removed,
a meaning changed) goes into a new /v2 router while /v1 keeps answering; adding a field is not such a change. /health
and the API docs describe the server, not one version, so they stay at the root.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from contextlib import asynccontextmanager, suppress

from fastapi import APIRouter, Depends, FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import auth, spi
from app.config import APP_ENV, get_settings
from app.core.cache import BuildBusy
from app.logs import setup_logging
from app.routers import auth as auth_routes
from app.routers import months, saved_versions, slabs
from app.scheduler import LoaderScheduler, log_schedule_off
from app.service import live
from app.service.saved_versions import recalculate_versions

setup_logging()
log = logging.getLogger("app.main")

# One request body at most. A slab edit names its dealers (up to ~40k codes, ~0.4 MB), so a session with many slab
# edits stays well under this; without a limit one request could carry ~0.5 GB of edits. nginx has the same limit.
MAX_BODY_BYTES = 16 * 1024 * 1024
# A login is a name and a password.
MAX_LOGIN_BODY_BYTES = 16 * 1024
# How often the API looks for files synced by another process (the loader container of docker-compose.yml, or a
# manual `python -m app.ingest.gcs_sync`). A look reads two small manifests; a new file is swapped in without a restart.
WATCH_SECONDS = 120
API_VERSION = "v1"


def _warm() -> None:
    """Build the slow caches on a daemon thread, before anyone asks for them (a cold /trend parses six monthly
    exports). /health says ready once the dealer frame and the All-India slab tables are built."""
    steps = (
        ("dealer frame", live.get_df),
        ("all-slabs (All India)", lambda: live.all_slabs_cached(None, None, None)),
        # The Simulator's month view: previous and current month, and next month at 0% with no edits.
        ("months (All India)", lambda: live.months_cached(None, None, None)),
        ("next month plan (All India)",
         lambda: live.plan_cached(live.plan_factor(0.0), "{}", "[]", "[]", None, None, None)),
        ("trend", live.trend_payload),
        # Saved versions of the live month, if its file changed since they were last computed.
        ("versions", recalculate_versions),
    )
    built = 0
    for i, (label, fn) in enumerate(steps):
        tokens = live.pin()   # each step on one live month, frame and slab edges together (a reload may come)
        try:
            t0 = time.time()
            fn()
            log.info("warm: %s in %.1fs", label, time.time() - t0)
            built += i < 2
        except Exception:  # never let warming break the server
            log.exception("warm: %s failed", label)
        finally:
            live.unpin(tokens)
        # Ready only when the dealer frame and the All-India slab tables were really built: a failed build must not
        # report ready (the next request builds them again).
        if i == 1 and built == 2:
            live.READY = True


def _log_login_mode() -> None:
    if APP_ENV == "unset":
        log.error("APP_ENV is not set: no env file was read and login is required (fail closed). "
                  "Set APP_ENV=local on a developer machine, or dev|uat|prod on a server")
    state = auth.mode()
    if state == "on":
        log.info("Login on")
    elif state == "off":
        log.warning("Login OFF (APP_ENV=local and no users set): every request acts as ADMIN")
    else:
        log.error("Login is not set up, so every business route answers 503: %s", "; ".join(auth.config_problems()))


async def _watch_files() -> None:
    """Swap in files another process synced (app/service/live.py reload_live; a no-op when nothing changed)."""
    while True:
        await asyncio.sleep(WATCH_SECONDS)
        try:
            await asyncio.to_thread(live.reload_live)
        except Exception:  # never let one bad look end the watch
            log.exception("file watch: reload failed")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _log_login_mode()
    threading.Thread(target=_warm, name="warm-caches", daemon=True).start()
    watcher = asyncio.create_task(_watch_files(), name="file-watch")
    # The daily GCS sync: inside the API as in an earlier internal service (app/scheduler.py), or in the loader container
    # (app/loader_main.py, docker-compose.yml), which keeps the database owner's login out of the API.
    settings = get_settings()
    scheduler = None
    if settings.loader_schedule_on:
        scheduler = LoaderScheduler(settings, on_loaded=live.reload_live)
        scheduler.start(sync_now=True)
    else:
        log_schedule_off(settings)
    try:
        yield
    finally:
        watcher.cancel()
        with suppress(asyncio.CancelledError):
            await watcher
        if scheduler is not None:
            await scheduler.stop()
        spi.close_pool()


# The API map (/docs, /openapi.json) only on a developer machine: it would show every route to anyone.
_local = APP_ENV == "local"
app = FastAPI(title="Scheme Performance & Impact Portal API", lifespan=lifespan,
              docs_url="/docs" if _local else None, redoc_url=None, openapi_url="/openapi.json" if _local else None)


class BodyLimit:
    """Refuse a request body over its limit with 413, by its Content-Length or, without one, while it streams.
    `small`: path prefixes with a smaller limit (path prefix -> bytes)."""

    def __init__(self, inner, limit: int, small: dict[str, int] | None = None):
        self.inner, self.default, self.small = inner, limit, small or {}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.inner(scope, receive, send)
        path = scope.get("path", "")
        limit = next((n for prefix, n in self.small.items() if path.startswith(prefix)), self.default)
        length = dict(scope["headers"]).get(b"content-length")
        if length is not None and (not length.isdigit() or int(length) > limit):
            return await self._refuse(send)
        seen, started, over = 0, False, False

        async def counted_receive():
            nonlocal seen, over
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    over = True
                    raise _TooLarge
            return message

        async def tracked_send(message):
            # FastAPI catches the _TooLarge raised while it reads the body and answers 400 "error parsing the body";
            # once the body was too large, that answer is replaced by the 413 in plain words.
            nonlocal started
            if over:
                if not started and message["type"] == "http.response.start":
                    started = True
                    await self._refuse(send)
                return
            started = started or message["type"] == "http.response.start"
            await send(message)

        try:
            await self.inner(scope, counted_receive, tracked_send)
        except _TooLarge:
            if not started:
                await self._refuse(send)

    @staticmethod
    async def _refuse(send):
        body = b'{"detail":"This request is too large for the server. Undo some edits and try again."}'
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


class _TooLarge(Exception):
    pass


class PinLiveMonth:
    """Each request keeps the live month it started on (app/service/live.py, pin): a reload of the live file during
    the request does not mix two months in one answer."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.inner(scope, receive, send)
        tokens = live.pin()
        try:
            await self.inner(scope, receive, send)
        finally:
            live.unpin(tokens)


class SecurityHeaders:
    """On every response, the refusals of BodyLimit included. The API answers JSON only: no sniffing it as something
    else, no framing it, no referrer leaking a scope. Cache-Control no-store unless a route set its own: answers hold
    client data (dealer lists, versions) that must not stay in a browser's or a proxy's cache."""

    HEADERS = ((b"x-content-type-options", b"nosniff"), (b"x-frame-options", b"DENY"),
               (b"referrer-policy", b"no-referrer"))

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.inner(scope, receive, send)

        async def with_headers(message):
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() not in dict(self.HEADERS)]
                headers += list(self.HEADERS)
                if not any(k.lower() == b"cache-control" for k, _ in headers):
                    headers.append((b"cache-control", b"no-store"))
                message = {**message, "headers": headers}
            await send(message)

        await self.inner(scope, receive, with_headers)


# Outermost last: SecurityHeaders > CORS > BodyLimit > PinLiveMonth > the routes, so a 413 still carries the security
# and CORS headers. Behind nginx the web app and the API share one address (/api), so CORS is only for a dev setup
# that calls the API directly. CORS_ORIGINS lists those origins (empty: the local Vite server).
app.add_middleware(PinLiveMonth)
app.add_middleware(BodyLimit, limit=MAX_BODY_BYTES, small={"/v1/auth/": MAX_LOGIN_BODY_BYTES})
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origin_list,
    allow_credentials=True,                   # the session cookie, for an API at another address
    allow_methods=["GET", "POST", "PUT", "PATCH"],
    allow_headers=["Content-Type"],
    expose_headers=["Content-Disposition"],   # the export's file name
)
app.add_middleware(SecurityHeaders)


def _field(loc) -> str:
    return ".".join(str(p) for p in loc if p not in ("body", "query", "path"))


@app.exception_handler(RequestValidationError)
async def _invalid(_request, exc: RequestValidationError):
    """A refused request in plain words: what is wrong and where, as one sentence (the web app shows it as it is).
    The value sent is never echoed back: it may be NaN or Infinity, which JSON cannot carry (that was a 500)."""
    problems = []
    for err in exc.errors()[:5]:
        field, msg = _field(err.get("loc", ())), str(err.get("msg", "is not valid")).removeprefix("Value error, ")
        if err.get("type") == "missing":
            msg = "is required"
        elif err.get("type") == "json_invalid":
            field, msg = "", "The request is not valid JSON"
        problems.append(f"{field}: {msg}" if field else msg)
    detail = "This request was refused: " + "; ".join(problems or ["it is not valid"]) + "."
    return JSONResponse({"detail": detail}, status_code=422)


@app.exception_handler(BuildBusy)
async def _busy(_request, _exc):
    # app/core/cache.py BuildGate: every slot for a heavy build stayed taken. The web app shows this sentence.
    return JSONResponse({"detail": "The server is busy with other changes right now. Please try again in a moment."},
                        status_code=503, headers={"Retry-After": "30"})


# async: answered on the event loop, so it never waits behind busy worker threads (a heavy edit or a cold build).
@app.get("/health", tags=["system"])
async def health():
    """Liveness for Docker and the proxy: always 200 while the process runs; `ready` once the main views are warm
    (about a minute after a start). Says nothing about the data beyond the live month's label."""
    return {"status": "ok", "ready": live.READY, "live_month": live.month_label(), "api_version": API_VERSION}


v1 = APIRouter(prefix=f"/{API_VERSION}")
v1.include_router(auth_routes.router)
# Every business route needs a login (app/auth.py); some need the ADMIN role on top (dealer names, saving versions).
signed_in = [Depends(auth.current_user)]
v1.include_router(slabs.router, dependencies=signed_in)
v1.include_router(months.router, dependencies=signed_in)
v1.include_router(saved_versions.router, dependencies=signed_in)
app.include_router(v1)
