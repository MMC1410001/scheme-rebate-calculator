"""An in-memory LRU cache that builds each entry once, for the API's slow, pure computations.

functools.lru_cache does not stop two threads from computing the same key: at start-up every /all-slabs request
began its own ~47 s build next to the warm-up thread, and they all fought for the GIL. Here the first caller builds
and the others with the same key wait for its result (other keys run in parallel; there is no global lock).

cache_clear() also starts a new generation: a build that began before the clear (on the old month's frame) still
answers its own callers but is not stored, so a reload of the live file cannot leave old figures in the cache.

key_extra: a function whose value joins every key (the live month's State in app/service/live.py), so a request that
started on one live month never reads an entry built on another.

keep: a function of the call's arguments; an entry it returns True for is never evicted (the All-India view, which
takes ~47 s to build, must not be pushed out by other scopes).

BuildGate caps how many memory-heavy builds run at the same time (each edited frame is ~0.11 GB plus working
copies). The cache builds different keys in parallel, so without it ten users with ten different edits would build
ten frames at once and could exceed the container's memory.
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable
from concurrent.futures import Future
from functools import update_wrapper
from typing import Any


class BuildBusy(Exception):
    """No build slot came free in time: the server is busy with other heavy builds."""


class BuildGate:
    """At most `slots` heavy builds at once; a caller waits up to `wait` seconds for a slot, then BuildBusy.

    Re-entrant per thread: a build that runs another gated build inside it does not take a second slot (it would
    otherwise wait for itself when every slot is taken)."""

    def __init__(self, slots: int, wait: float):
        self._sem = threading.BoundedSemaphore(slots)
        self._wait = wait
        self._local = threading.local()

    def __enter__(self):
        depth = getattr(self._local, "depth", 0)
        if depth == 0 and not self._sem.acquire(timeout=self._wait):
            raise BuildBusy
        self._local.depth = depth + 1
        return self

    def __exit__(self, *exc):
        self._local.depth -= 1
        if self._local.depth == 0:
            self._sem.release()
        return False


class _Memo:
    def __init__(self, fn: Callable, maxsize: int, key_extra: Callable[[], Any] | None = None,
                 keep: Callable[..., bool] | None = None):
        self._fn = fn
        self._maxsize = maxsize
        self._key_extra = key_extra
        self._keep = keep
        self._kept: set = set()
        self._lock = threading.Lock()
        self._data: OrderedDict[Any, Any] = OrderedDict()
        self._building: dict[Any, Future] = {}
        self._generation = 0
        update_wrapper(self, fn)

    def __call__(self, *args, **kwargs):
        key = (args, tuple(sorted(kwargs.items()))) if kwargs else args
        if self._key_extra is not None:
            key = (self._key_extra(), key)
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
                return self._data[key]
            future = self._building.get(key)
            owner = future is None
            if owner:
                future = self._building[key] = Future()
                generation = self._generation
        if not owner:
            return future.result()   # re-raises the builder's exception
        try:
            value = self._fn(*args, **kwargs)
        except BaseException as exc:
            with self._lock:
                if self._building.get(key) is future:
                    del self._building[key]
            future.set_exception(exc)
            raise
        with self._lock:
            if self._building.get(key) is future:
                del self._building[key]
            if generation == self._generation:
                self._data[key] = value
                if self._keep is not None and self._keep(*args, **kwargs):
                    self._kept.add(key)
                self._evict()
        future.set_result(value)
        return value

    def _evict(self) -> None:
        """Drop the least recently used entries over maxsize, never a kept one."""
        excess = len(self._data) - self._maxsize
        if excess <= 0:
            return
        for old in [k for k in self._data if k not in self._kept][:excess]:
            del self._data[old]

    def cache_clear(self) -> None:
        with self._lock:
            self._data.clear()
            self._kept.clear()
            self._building.clear()
            self._generation += 1

    def cache_len(self) -> int:
        return len(self._data)


def memo(maxsize: int = 128, key_extra: Callable[[], Any] | None = None,
         keep: Callable[..., bool] | None = None) -> Callable[[Callable], _Memo]:
    """Decorator: @memo(maxsize=N). Arguments must be hashable, as for lru_cache."""
    return lambda fn: _Memo(fn, maxsize, key_extra, keep)
