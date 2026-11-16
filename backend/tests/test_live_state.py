"""app/service/live.py: a request keeps the live month it started on, through a reload (no month is built)."""
import asyncio

from starlette.concurrency import run_in_threadpool

from app.service import live


def test_a_pinned_request_keeps_its_month_when_the_live_month_is_replaced(monkeypatch):
    old = live._current()
    tokens = live.pin()
    try:
        monkeypatch.setattr(live, "_CURRENT", live.State(meta=old.meta, seq=old.seq + 1))
        assert live._state() is old and live.state_seq() == old.seq
    finally:
        live.unpin(tokens)
    assert live.state_seq() == old.seq + 1          # outside a request: the newest


def test_the_pin_reaches_the_worker_thread_of_a_sync_route():
    async def request():
        tokens = live.pin()
        try:
            return await run_in_threadpool(lambda: live._state())
        finally:
            live.unpin(tokens)

    assert asyncio.run(request()) is live._current()


def test_live_attribute_reads_the_requests_month():
    assert live.LIVE is live._state().meta
