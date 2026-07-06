"""
Shared helpers for source modules.

The bug these exist to fix: every source caches its raw downloads forever.
A season file fetched mid-season (say, May 2025) gets reused verbatim by a
build a year later, silently dropping every game played after the fetch.
That is exactly how the live site ended up with EPL frozen in April 2025
and CFB missing the entire CFP.

Rule: a cache file is only trustworthy if the window of games it covers
ended comfortably BEFORE the file was written — i.e. the window can no
longer grow. Anything covering dates near or after its own fetch time must
be refetched.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# Days of slack between a window's end and the cache write time before we
# trust the file. Covers timezone skew and sources that publish results late.
_MARGIN_DAYS = 2

# Games this close to the build's as-of date must carry an explicit "final"
# status to be counted — otherwise an in-progress game's partial score gets
# baked into the lineage (the 5-3 "NBA game" bug).
RECENT_DAYS = 10

_FINAL_TOKENS = ("final", "ft", "full")


def cache_is_complete(path: Path, window_end: str) -> bool:
    """True iff `path` exists and covers a window that ended at least
    _MARGIN_DAYS before the file was last written (so it cannot be stale)."""
    if not path.exists() or path.stat().st_size == 0:
        return False
    try:
        end = date.fromisoformat(window_end[:10])
    except ValueError:
        return False
    written = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).date()
    return end <= written - timedelta(days=_MARGIN_DAYS)


def looks_final(status: object) -> bool:
    """True if a source's status field says the game is finished."""
    s = str(status or "").lower()
    return any(t in s for t in _FINAL_TOKENS)


def is_recent(game_date: str, as_of: str, days: int = RECENT_DAYS) -> bool:
    """True if game_date falls within `days` of the build's as-of date —
    the zone where a game might still be in progress."""
    try:
        g = date.fromisoformat(game_date[:10])
        a = date.fromisoformat(as_of[:10])
    except ValueError:
        return True  # unparseable date: treat as recent, i.e. be strict
    return g >= a - timedelta(days=days)
