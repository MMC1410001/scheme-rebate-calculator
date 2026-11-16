"""app/core/cache.py: one build per key, no stale entry after a clear, errors not cached."""
import threading
import time

import pytest

from app.core.cache import memo


def test_concurrent_callers_share_one_build():
    calls = []

    @memo(maxsize=4)
    def slow(x):
        calls.append(x)
        time.sleep(0.2)
        return x * 2

    out = []
    threads = [threading.Thread(target=lambda: out.append(slow(3))) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert out == [6] * 8
    assert calls == [3]


def test_other_keys_build_in_parallel():
    @memo(maxsize=4)
    def slow(x):
        time.sleep(0.3)
        return x

    t0 = time.time()
    threads = [threading.Thread(target=slow, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert time.time() - t0 < 0.9   # not 4 x 0.3 s one after another


def test_build_started_before_clear_is_not_stored():
    started, release = threading.Event(), threading.Event()
    version = ["old"]

    @memo(maxsize=4)
    def frame():
        value = version[0]
        started.set()
        release.wait(2)
        return value

    result = []
    t = threading.Thread(target=lambda: result.append(frame()))
    t.start()
    started.wait(2)
    version[0] = "new"
    frame.cache_clear()          # a reload while the old build runs
    release.set()
    t.join()
    assert result == ["old"]     # its own caller gets what it built ...
    assert frame() == "new"      # ... but the cache does not keep it


def test_errors_reach_waiters_and_are_not_cached():
    calls = []

    @memo(maxsize=4)
    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise ValueError("first try fails")
        return "ok"

    with pytest.raises(ValueError):
        flaky()
    assert flaky() == "ok"
    assert len(calls) == 2


def test_least_recently_used_entry_goes_first():
    @memo(maxsize=2)
    def ident(x):
        return object()

    a, b = ident(1), ident(2)
    assert ident(1) is a         # 1 is now the most recent
    ident(3)                     # evicts 2
    assert ident(1) is a
    assert ident(2) is not b


def test_key_extra_keeps_entries_of_another_live_month_apart():
    month = ["Oct"]

    @memo(maxsize=4, key_extra=lambda: month[0])
    def label(x):
        return f"{month[0]}-{x}"

    assert label(1) == "Oct-1"
    month[0] = "Nov"               # a reload: the same arguments, another live month
    assert label(1) == "Nov-1"
    month[0] = "Oct"               # a request still on October reads October's entry
    assert label(1) == "Oct-1"


def test_a_kept_entry_is_never_evicted():
    from app.core.cache import memo

    calls = []

    @memo(maxsize=2, keep=lambda k: k == "all")
    def build(k):
        calls.append(k)
        return k

    for k in ("all", "a", "b", "c", "d"):
        build(k)
    build("all")
    assert calls.count("all") == 1 and build.cache_len() == 2   # the kept one + the newest (maxsize counts both)


def test_the_build_gate_caps_parallel_builds_and_is_reentrant():
    import threading

    from app.core.cache import BuildBusy, BuildGate

    gate = BuildGate(slots=1, wait=0.05)
    with gate:
        with gate:              # the same thread: no second slot needed
            pass
        refused = []

        def other():
            try:
                with gate:
                    pass
            except BuildBusy:
                refused.append(True)

        t = threading.Thread(target=other)
        t.start()
        t.join()
        assert refused == [True]
    with gate:                  # the slot is free again
        pass
