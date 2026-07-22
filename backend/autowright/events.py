"""In-process event hub feeding the §19 WebSocket. Thread-safe publish."""
from __future__ import annotations

import asyncio
import threading
from typing import Any


class EventHub:
    def __init__(self) -> None:
        self._subs: set[asyncio.Queue] = set()
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._subs.discard(q)

    def publish(self, ev: str, **payload: Any) -> None:
        """Callable from any thread (engine worker threads publish log lines)."""
        msg = {"ev": ev, **payload}
        loop = self._loop
        if loop is None:
            return
        loop.call_soon_threadsafe(self._fanout, msg)

    def _fanout(self, msg: dict) -> None:
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                pass


hub = EventHub()
