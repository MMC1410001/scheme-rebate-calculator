"""
Scheme configs for one monthly export.

Everything is discovered from the file's own 2-row header, including the
name-based overrides in scheme_config.OVERRIDES. Nothing is keyed to a column
position, because positions move between months (September is 673 columns wide,
August 910).
"""
from __future__ import annotations

from pathlib import Path

from app.core.scheme_config import SchemeConfig
from app.ingest.discover_schemes import discover

_cache: dict[str, dict[str, SchemeConfig]] = {}


def get_schemes(source: Path, force: bool = False, sheet_name: str = "Output") -> dict[str, SchemeConfig]:
    key = str(Path(source).resolve())
    if key in _cache and not force:
        return _cache[key]
    _cache[key] = discover(source, sheet_name)
    return _cache[key]
