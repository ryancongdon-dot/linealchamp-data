#!/usr/bin/env python3
"""
seed_boxing.py — hand-curated lineal heavyweight boxing chain.

Boxing's lineage isn't computed from game data; it's a curated historical
record. This script emits output/lineage-BOX.json + output/events-BOX.json
in the same schema as the other leagues so the worker + UI can consume it
unchanged.

Conventions:
  - Fighter "codes" are uppercase, no spaces (e.g. SULLIVAN, MUHAMMADALI).
  - score field encodes how the title transferred: "KO11", "TKO8", "UD15",
    "SD12", "DQ15", "RET" (corner retirement), "VACANT-{reason}".
  - 4 vacancy gaps handled per the agreed rules:
      Marciano 1956   → Patterson Nov 1956 (vacant ~6mo)
      Ali stripped 1967 → Frazier Feb 1970 (vacant ~3yr)
      Ali retired 1979 → Holmes Oct 1980 (vacant ~17mo)
      Lewis retired 2004 → W. Klitschko Apr 2011 (waiting for unification)
  - Fury retains the belt through his 2016-2018 hiatus (no one beat him).
  - Briggs over Foreman 1997 included (official result, disputed decision).

Run:  python seed_boxing.py
"""

from __future__ import annotations

import json
from pathlib import Path
from datetime import date

ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "output"

# (date, fighter_code, score_or_method, opponent_code_or_None, note)
# opponent_code_or_None is whose belt they took (None for seed / vacant titles).
CHAIN: list[tuple[str, str, str, str | None, str]] = [
    # date          to                  score        from              note
    ("1892-09-07", "SULLIVAN",         "SEED",      None,             "Seed: recognized champion entering Queensberry era"),
    ("1892-09-07", "CORBETT",          "KO21",      "SULLIVAN",       "First gloved heavyweight title fight"),
    ("1897-03-17", "FITZSIMMONS",      "KO14",      "CORBETT",        "Carson City, Nevada"),
    ("1899-06-09", "JEFFRIES",         "KO11",      "FITZSIMMONS",    "Coney Island"),
    # Jeffries retired undefeated 1905 → vacant ~9 months
    ("1906-02-23", "BURNS",            "UD20",      "JEFFRIES",       "Won vacant title vs Marvin Hart (Jeffries's chosen heir)"),
    ("1908-12-26", "JOHNSON",          "TKO14",     "BURNS",          "First Black heavyweight champion; Sydney, Australia"),
    ("1915-04-05", "WILLARD",          "KO26",      "JOHNSON",        "Havana, Cuba"),
    ("1919-07-04", "DEMPSEY",          "TKO3",      "WILLARD",        "Toledo, Ohio"),
    ("1926-09-23", "TUNNEY",           "UD10",      "DEMPSEY",        "Philadelphia, in front of 120,000+"),
    # Tunney retired undefeated 1928 → vacant ~2 years
    ("1930-06-12", "SCHMELING",        "DQ4",       "TUNNEY",         "Won vacant title (Sharkey DQ'd for low blow)"),
    ("1932-06-21", "SHARKEY",          "SD15",      "SCHMELING",      "Long Island, NY"),
    ("1933-06-29", "CARNERA",          "TKO6",      "SHARKEY",        "Long Island, NY"),
    ("1934-06-14", "BAER",             "TKO11",     "CARNERA",        "Long Island, NY"),
    ("1935-06-13", "BRADDOCK",         "UD15",      "BAER",           "Cinderella Man; Long Island, NY"),
    ("1937-06-22", "JOELOUIS",         "KO8",       "BRADDOCK",       "Chicago; held title 11+ years, 25 defenses"),
    # Joe Louis retired 1949 → Ezzard Charles regained lineal by beating Louis in his 1950 comeback
    ("1950-09-27", "CHARLES",          "UD15",      "JOELOUIS",       "Beat Louis in his comeback (restores lineal chain)"),
    ("1951-07-18", "WALCOTT",          "KO7",       "CHARLES",        "Oldest heavyweight champ at the time (37)"),
    ("1952-09-23", "MARCIANO",         "KO13",      "WALCOTT",        "Philadelphia"),
    # Marciano retired undefeated 1956 (49-0) → vacant ~6 months
    ("1956-11-30", "PATTERSON",        "KO5",       "MARCIANO",       "Won vacant title vs Archie Moore; youngest champ at 21"),
    ("1959-06-26", "JOHANSSON",        "TKO3",      "PATTERSON",      "Yankee Stadium"),
    ("1960-06-20", "PATTERSON",        "KO5",       "JOHANSSON",      "First man to regain heavyweight title"),
    ("1962-09-25", "LISTON",           "KO1",       "PATTERSON",      "Chicago"),
    ("1964-02-25", "MUHAMMADALI",      "RET7",      "LISTON",         "Miami Beach; \"Shook up the world\""),
    # Ali stripped of title 1967 for refusing Vietnam draft → vacant ~3 years
    ("1971-03-08", "FRAZIER",          "UD15",      "MUHAMMADALI",    "Fight of the Century; MSG (restores lineal chain by beating Ali)"),
    ("1973-01-22", "FOREMAN",          "TKO2",      "FRAZIER",        "Sunshine Showdown; Kingston, Jamaica"),
    ("1974-10-30", "MUHAMMADALI",      "KO8",       "FOREMAN",        "Rumble in the Jungle; Kinshasa, Zaire"),
    ("1978-02-15", "SPINKSLEON",       "SD15",      "MUHAMMADALI",    "Las Vegas"),
    ("1978-09-15", "MUHAMMADALI",      "UD15",      "SPINKSLEON",     "New Orleans; first 3-time heavyweight champ"),
    # Ali retired 1979 → vacant ~17 months
    ("1980-10-02", "HOLMES",           "TKO11",     "MUHAMMADALI",    "Beat Ali in his comeback (restores lineal chain)"),
    ("1985-09-21", "SPINKSMICHAEL",    "UD15",      "HOLMES",         "Las Vegas; first light-heavyweight to win HW title"),
    ("1988-06-27", "TYSON",            "KO1",       "SPINKSMICHAEL",  "Atlantic City; 91 seconds"),
    ("1990-02-11", "DOUGLAS",          "KO10",      "TYSON",          "Tokyo; one of biggest upsets in sports history"),
    ("1990-10-25", "HOLYFIELD",        "KO3",       "DOUGLAS",        "Las Vegas"),
    ("1992-11-13", "BOWE",             "UD12",      "HOLYFIELD",      "Las Vegas"),
    ("1993-11-06", "HOLYFIELD",        "MD12",      "BOWE",           "Las Vegas (Fan Man fight)"),
    ("1994-04-22", "MOORER",           "MD12",      "HOLYFIELD",      "Las Vegas"),
    ("1994-11-05", "FOREMAN",          "KO10",      "MOORER",         "Las Vegas; oldest HW champ ever at 45"),
    ("1997-11-22", "BRIGGS",           "MD12",      "FOREMAN",        "Atlantic City; widely disputed decision"),
    ("1998-03-28", "LEWIS",            "TKO5",      "BRIGGS",         "Atlantic City"),
    ("2001-04-21", "RAHMAN",           "KO5",       "LEWIS",          "Johannesburg, South Africa"),
    ("2001-11-17", "LEWIS",            "KO4",       "RAHMAN",         "Las Vegas"),
    # Lennox Lewis retired 2004 → vacant ~7 years; chain restored when W. Klitschko unifies major belts
    ("2011-07-02", "KLITSCHKOWLAD",    "UD12",      "LEWIS",          "Beat David Haye to unify WBA/WBO/IBF (restores lineal chain via unification)"),
    ("2015-11-28", "FURY",             "UD12",      "KLITSCHKOWLAD",  "Dusseldorf; ends Klitschko's 9.5-year reign"),
    # Fury vacated belts due to mental health hiatus 2016-2018 but never lost in the ring; retains lineal status through return.
    ("2024-05-18", "USYK",             "SD12",      "FURY",           "Riyadh; first undisputed HW champ of 4-belt era"),
]


def norm_date(d: str) -> str:
    return f"{d}T00:00:00Z"


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    changes: list[dict] = []
    events: list[dict] = []

    seq = 0
    for d, to, score, frm, _note in CHAIN:
        seq += 1
        gid = f"BOX-HW-{seq:03d}"
        change: dict = {
            "date": norm_date(d),
            "gameId": gid,
            "from": frm,
            "to": to,
        }
        if score and score != "SEED":
            change["score"] = score
        if score == "SEED":
            change["seed"] = True
        changes.append(change)

        # Each title transfer is also an event from the previous champ's POV
        # (a Loss for them) and the new champ's POV (a Win). We emit one event
        # for the new champion's title-winning fight.
        if score != "SEED":
            events.append({
                "date": norm_date(d),
                "gameId": gid,
                "champ": frm or to,   # holder going into the fight
                "opponent": to if frm else (frm or ""),
                "champScore": 0,
                "oppScore": 0,
                "result": "L" if frm else "W",
                "change": True,
            })

    today = date.today().isoformat()
    current = changes[-1]["to"]
    seed = changes[0]
    lineage = {
        "league": "BOXHW",
        "seedTeam": seed["to"],
        "seedDate": seed["date"][:10],
        "asOfDate": today,
        "currentChamp": current,
        "changes": changes,
    }
    events_payload = {
        "league": "BOXHW",
        "asOfDate": today,
        "events": events,
    }

    (OUTPUT_DIR / "lineage-BOXHW.json").write_text(json.dumps(lineage, indent=2))
    (OUTPUT_DIR / "events-BOXHW.json").write_text(json.dumps(events_payload, indent=2))

    print(f"  BOXHW ✓ {len(changes)} reigns, {len(events)} title fights, current champ: {current}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
