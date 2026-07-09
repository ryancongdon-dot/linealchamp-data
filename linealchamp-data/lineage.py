"""
Lineage computation — Python port of the JS computeLineage in the existing Worker.

Boxing-style rules:
- A team starts holding the belt (the "seed").
- The belt only transfers when the holder LOSES a game. The winner of that game
  becomes the new belt holder.
- Ties / draws are skipped (holder retains the belt).
- Games that don't involve the current belt holder are skipped entirely — they
  do not produce events.

This is the single source of truth for the algorithm; both the offline backfill
and the Worker import this logic (the Worker has a JS copy; keep them in sync).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Optional


@dataclass(frozen=True)
class Game:
    id: str
    date: str          # ISO 8601 string; sort key
    home_id: str
    away_id: str
    home_score: Optional[int]
    away_score: Optional[int]


@dataclass
class Change:
    date: str
    gameId: Optional[str]
    from_team: Optional[str]
    to_team: str
    score: Optional[str] = None
    seed: bool = False
    lapsed: bool = False  # belt moved via inactivity rule, not a head-to-head loss

    def to_json(self) -> dict:
        out = {
            "date": self.date,
            "gameId": self.gameId,
            "from": self.from_team,
            "to": self.to_team,
        }
        if self.score is not None:
            out["score"] = self.score
        if self.seed:
            out["seed"] = True
        if self.lapsed:
            out["lapsed"] = True
        return out


@dataclass
class Event:
    date: str
    gameId: str
    champ: str
    opponent: str
    champScore: int
    oppScore: int
    result: str  # 'W' or 'L'
    change: bool

    def to_json(self) -> dict:
        return {
            "date": self.date,
            "gameId": self.gameId,
            "champ": self.champ,
            "opponent": self.opponent,
            "champScore": self.champScore,
            "oppScore": self.oppScore,
            "result": self.result,
            "change": self.change,
        }


# Belt auto-transfers to the next active winner when the holder has been
# inactive longer than this. One year cleanly separates a between-seasons gap
# (months) from a franchise that has genuinely stopped playing.
LAPSE_DAYS = 365


def _to_dt(s: Optional[str]) -> Optional["datetime"]:
    """Parse an ISO date/datetime (with or without time/Z) to a naive UTC
    datetime for day-gap math. Returns None if unparseable."""
    if not s:
        return None
    try:
        txt = str(s).replace("Z", "+00:00")
        dt = datetime.fromisoformat(txt if "T" in txt else txt + "T00:00:00+00:00")
        return dt.replace(tzinfo=None)
    except Exception:
        try:
            return datetime.fromisoformat(str(s)[:10])
        except Exception:
            return None


def norm(s: Optional[str]) -> str:
    """Match the JS norm(): uppercase, strip whitespace."""
    if not s:
        return ""
    return "".join(str(s).upper().split())


def winner(g: Game) -> Optional[str]:
    if g.home_score is None or g.away_score is None:
        return None
    if g.home_score == g.away_score:
        return None
    return g.home_id if g.home_score > g.away_score else g.away_id


def _iso(s: str) -> str:
    """Normalize various date inputs to ISO 8601 UTC string."""
    try:
        if "T" in s:
            return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return s


def compute_lineage(
    games: Iterable[Game],
    seed_team: Optional[str] = None,
    seed_date: Optional[str] = None,
) -> tuple[Optional[str], list[Change], list[Event]]:
    """
    Returns (current_champ, changes, events).

    If seed_team is None, the first game's winner becomes the seed.
    If seed_team is given, a synthetic seed Change is emitted (date = seed_date
    or first game's date) marking the start of the lineage.
    """
    games = sorted(games, key=lambda g: g.date)
    champ: Optional[str] = seed_team
    changes: list[Change] = []
    events: list[Event] = []

    if champ is None:
        for g in games:
            w = winner(g)
            if w:
                champ = w
                changes.append(
                    Change(
                        date=_iso(g.date),
                        gameId=g.id,
                        from_team=None,
                        to_team=champ,
                        score=_score(g),
                        seed=True,
                    )
                )
                break
    else:
        # Emit a synthetic seed change so consumers know when the lineage starts.
        d = seed_date or (games[0].date if games else datetime.utcnow().isoformat())
        changes.append(
            Change(
                date=_iso(d),
                gameId=None,
                from_team=None,
                to_team=champ,
                seed=True,
            )
        )

    if champ is None:
        return None, [], []

    # Track when the holder last actually played. If the belt sits with a team
    # that stops playing (a folded franchise, a pre-modern seed whose era's
    # data is missing), it must eventually pass to whoever is still active —
    # otherwise the whole chain freezes on a ghost like the 1920s Quebec
    # Bulldogs. This mirrors the Worker's JS rule; without it the offline
    # rebuild produced ~31 NHL changes ending on a defunct team.
    champ_last = _to_dt(seed_date) or _to_dt(games[0].date if games else None)

    for g in games:
        w = winner(g)
        if w is None:
            continue
        h_id, a_id = g.home_id, g.away_id
        champ_plays = champ == h_id or champ == a_id
        gd = _to_dt(g.date)

        # Inactivity lapse: the holder hasn't appeared in over a year and is
        # not in this game, so the belt vacates to this game's winner. Not a
        # head-to-head title loss, so it's flagged lapsed and records no event.
        if (
            not champ_plays
            and champ_last is not None
            and gd is not None
            and (gd - champ_last).days > LAPSE_DAYS
        ):
            changes.append(
                Change(
                    date=_iso(g.date),
                    gameId=g.id,
                    from_team=champ,
                    to_team=w,
                    lapsed=True,
                )
            )
            champ = w
            champ_last = gd
            continue

        if not champ_plays:
            continue

        opp = a_id if champ == h_id else h_id
        champ_score = g.home_score if champ == h_id else g.away_score
        opp_score = g.away_score if champ == h_id else g.home_score
        champ_won = w == champ
        change = not champ_won
        champ_last = gd  # the holder just played

        events.append(
            Event(
                date=_iso(g.date),
                gameId=g.id,
                champ=champ,
                opponent=opp,
                champScore=champ_score,
                oppScore=opp_score,
                result="W" if champ_won else "L",
                change=change,
            )
        )

        if change:
            changes.append(
                Change(
                    date=_iso(g.date),
                    gameId=g.id,
                    from_team=champ,
                    to_team=w,
                    score=f"{champ_score}-{opp_score}",
                )
            )
            champ = w
            champ_last = gd  # the new holder's clock starts at this game

    return champ, changes, events


def _score(g: Game) -> Optional[str]:
    if g.home_score is None or g.away_score is None:
        return None
    return f"{g.home_score}-{g.away_score}"
