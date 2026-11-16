"""Logging for the API's own messages (loggers under "app").

uvicorn leaves the root logger at WARNING, so without this the warm-up, reloads and scheduled syncs (INFO) would not
show in the server log. Called once at start-up; calling it again changes nothing.
"""
from __future__ import annotations

import logging


def setup_logging(level: int = logging.INFO) -> None:
    logger = logging.getLogger("app")
    if logger.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(level)
    logger.propagate = False
