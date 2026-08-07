"""Tiny in-process TTL cache for expensive read endpoints.

The GIS analytics (Gi* hotspots, KDE grid, summary) recompute from the full
database on every request. Results only change when establishment or WCO data
changes, so we cache them and invalidate on any write.
"""
from __future__ import annotations

import time
from typing import Any

_TTL_SECONDS = 300  # safety net; writes invalidate explicitly

_store: dict[str, tuple[float, Any]] = {}


def cache_get(key: str) -> Any | None:
    entry = _store.get(key)
    if entry is None:
        return None
    ts, value = entry
    if time.monotonic() - ts > _TTL_SECONDS:
        _store.pop(key, None)
        return None
    return value


def cache_set(key: str, value: Any) -> None:
    _store[key] = (time.monotonic(), value)


def invalidate_gis_cache() -> None:
    """Drop all cached GIS results. Call after any establishment/WCO write."""
    for key in list(_store):
        if key.startswith("gis:"):
            _store.pop(key, None)
