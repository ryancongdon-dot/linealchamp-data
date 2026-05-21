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
    vacancy_days: Optional[int] = None,
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

    last_seen: Optional[datetime] = None
    for g in games:
        w = winner(g)
        if w is None:
            continue
        h_id, a_id = g.home_id, g.away_id

        # Vacancy handling: if the current champ has been silent for vacancy_days,
        # treat the next game as a re-seed. Used for MLB to escape stranding on
        # defunct 19th-century franchises (Fort Wayne, etc.).
        if vacancy_days is not None and last_seen is not None and champ not in (h_id, a_id):
            try:
                g_date = datetime.fromisoformat(g.date.replace("Z", "+00:00"))
            except Exception:
                g_date = None
            if g_date and (g_date - last_seen).days > vacancy_days:
                changes.append(
                    Change(
                        date=_iso(g.date),
                        gameId=g.id,
                        from_team=champ,
                        to_team=w,
                        score=_score(g),
                    )
                )
                champ = w
                try:
                    last_seen = datetime.fromisoformat(g.date.replace("Z", "+00:00"))
                except Exception:
                    pass
                continue

        if champ != h_id and champ != a_id:
            continue

        try:
            last_seen = datetime.fromisoformat(g.date.replace("Z", "+00:00"))
        except Exception:
            pass

        opp = a_id if champ == h_id else h_id
        champ_score = g.home_score if champ == h_id else g.away_score
        opp_score = g.away_score if champ == h_id else g.home_score
        champ_won = w == champ
        change = not champ_won

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

    return champ, changes, events


def _score(g: Game) -> Optional[str]:
    if g.home_score is None or g.away_score is None:
        return None
    return f"{g.home_score}-{g.away_score}"
