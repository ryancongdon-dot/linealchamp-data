"""
NFL supplemental games — hand-curated pre-merger NFL Championship Games
(1933-1969) that the Wikipedia per-team season-page scraper misses.

Why this exists:
    Verified during the 1934 backfill audit: the Wikipedia scrape pulled all 13
    Bears regular-season games but missed the Dec 9 1934 NFL Championship
    (Giants 30, Bears 13). Cause is most likely that pre-1970 team-season
    pages put the Championship game in a separately-formatted table or section
    that our schedule-shape detector doesn't catch. Same issue cascaded across
    all 37 championships of the pre-merger era; without these games the
    lineage chain is wrong from 1934 forward.

Strategy:
    Each entry below is a hand-verified championship game. The build pipeline
    merges these into the scraped Wikipedia data with `(date, {teams})`
    dedup, so any championship that DOES end up in the scrape gets collapsed
    with no double-counting.

    Super Bowls I-IV (1966-1969 seasons, inter-league with AFL) are not
    included here because they're a separate decision — including them would
    transfer the belt to AFL teams (Jets, Chiefs) we don't have in our 1969
    data. See BRANCH_POINTS.md `afl-nfl-merger-1970` for the eventual
    branch-toggle approach.

    Super Bowl V onward (1970+, intra-NFL) is normally caught by the per-team
    scraper, so it's not supplemented here.

Data format:
    (date, away_id, home_id, away_score, home_score, description)
"""

from __future__ import annotations

from lineage import Game


NFL_CHAMPIONSHIPS: list[tuple[str, str, str, int, int, str]] = [
    # 1930s
    ("1933-12-17", "NYG", "CHI", 21, 23, "1933 NFL Championship — Bears 23, Giants 21 (Wrigley Field) — first formal NFL Championship Game"),
    ("1934-12-09", "CHI", "NYG", 13, 30, "1934 NFL Championship — Giants 30, Bears 13 (Polo Grounds, 'Sneakers Game')"),
    ("1935-12-15", "NYG", "DET",  7, 26, "1935 NFL Championship — Lions 26, Giants 7 (U of Detroit Stadium)"),
    ("1936-12-13", "GB",  "WAS", 21,  6, "1936 NFL Championship — Packers 21, Boston Redskins 6 (Polo Grounds, neutral)"),
    ("1937-12-12", "WAS", "CHI", 28, 21, "1937 NFL Championship — Washington 28, Bears 21 (Wrigley Field)"),
    ("1938-12-11", "GB",  "NYG", 17, 23, "1938 NFL Championship — Giants 23, Packers 17 (Polo Grounds)"),
    ("1939-12-10", "NYG", "GB",   0, 27, "1939 NFL Championship — Packers 27, Giants 0 (State Fair Park, Milwaukee)"),
    # 1940s
    ("1940-12-08", "CHI", "WAS", 73,  0, "1940 NFL Championship — Bears 73, Washington 0 (Griffith Stadium) — largest margin of victory ever"),
    ("1941-12-21", "NYG", "CHI",  9, 37, "1941 NFL Championship — Bears 37, Giants 9 (Wrigley Field)"),
    ("1942-12-13", "CHI", "WAS",  6, 14, "1942 NFL Championship — Washington 14, Bears 6 (Griffith Stadium)"),
    ("1943-12-26", "WAS", "CHI", 21, 41, "1943 NFL Championship — Bears 41, Washington 21 (Wrigley Field)"),
    ("1944-12-17", "GB",  "NYG", 14,  7, "1944 NFL Championship — Packers 14, Giants 7 (Polo Grounds)"),
    ("1945-12-16", "WAS", "LAR", 14, 15, "1945 NFL Championship — Cleveland Rams 15, Washington 14 (Cleveland Stadium)"),
    ("1946-12-15", "CHI", "NYG", 24, 14, "1946 NFL Championship — Bears 24, Giants 14 (Polo Grounds)"),
    ("1947-12-28", "PHI", "ARI", 21, 28, "1947 NFL Championship — Chicago Cardinals 28, Eagles 21 (Comiskey Park)"),
    ("1948-12-19", "ARI", "PHI",  0,  7, "1948 NFL Championship — Eagles 7, Chicago Cardinals 0 (Shibe Park, blizzard)"),
    ("1949-12-18", "PHI", "LAR", 14,  0, "1949 NFL Championship — Eagles 14, LA Rams 0 (LA Coliseum)"),
    # 1950s
    ("1950-12-24", "LAR", "CLE", 28, 30, "1950 NFL Championship — Browns 30, LA Rams 28 (Cleveland Stadium) — Browns' first NFL title"),
    ("1951-12-23", "CLE", "LAR", 17, 24, "1951 NFL Championship — LA Rams 24, Browns 17 (LA Coliseum)"),
    ("1952-12-28", "DET", "CLE", 17,  7, "1952 NFL Championship — Lions 17, Browns 7 (Cleveland Stadium)"),
    ("1953-12-27", "CLE", "DET", 16, 17, "1953 NFL Championship — Lions 17, Browns 16 (Briggs Stadium)"),
    ("1954-12-26", "DET", "CLE", 10, 56, "1954 NFL Championship — Browns 56, Lions 10 (Cleveland Stadium)"),
    ("1955-12-26", "CLE", "LAR", 38, 14, "1955 NFL Championship — Browns 38, LA Rams 14 (LA Coliseum)"),
    ("1956-12-30", "CHI", "NYG",  7, 47, "1956 NFL Championship — Giants 47, Bears 7 (Yankee Stadium)"),
    ("1957-12-29", "CLE", "DET", 14, 59, "1957 NFL Championship — Lions 59, Browns 14 (Briggs Stadium)"),
    ("1958-12-28", "IND", "NYG", 23, 17, "1958 NFL Championship — Baltimore Colts 23, Giants 17 OT (Yankee Stadium) — 'Greatest Game Ever Played'"),
    ("1959-12-27", "NYG", "IND", 16, 31, "1959 NFL Championship — Baltimore Colts 31, Giants 16 (Memorial Stadium)"),
    # 1960s
    ("1960-12-26", "GB",  "PHI", 13, 17, "1960 NFL Championship — Eagles 17, Packers 13 (Franklin Field) — only playoff loss of Lombardi's career"),
    ("1961-12-31", "NYG", "GB",   0, 37, "1961 NFL Championship — Packers 37, Giants 0 (City Stadium, Green Bay)"),
    ("1962-12-30", "GB",  "NYG", 16,  7, "1962 NFL Championship — Packers 16, Giants 7 (Yankee Stadium)"),
    ("1963-12-29", "NYG", "CHI", 10, 14, "1963 NFL Championship — Bears 14, Giants 10 (Wrigley Field)"),
    ("1964-12-27", "IND", "CLE",  0, 27, "1964 NFL Championship — Browns 27, Baltimore Colts 0 (Cleveland Stadium) — Cleveland's last major sports title until 2016"),
    ("1966-01-02", "CLE", "GB",  12, 23, "1965 NFL Championship — Packers 23, Browns 12 (Lambeau Field)"),
    ("1967-01-01", "GB",  "DAL", 34, 27, "1966 NFL Championship — Packers 34, Cowboys 27 (Cotton Bowl)"),
    ("1967-12-31", "DAL", "GB",  17, 21, "1967 NFL Championship — Packers 21, Cowboys 17 (Lambeau Field, 'Ice Bowl', -13°F)"),
    ("1968-12-29", "IND", "CLE", 34,  0, "1968 NFL Championship — Baltimore Colts 34, Browns 0 (Cleveland Stadium)"),
    ("1970-01-04", "CLE", "MIN",  7, 27, "1969 NFL Championship — Vikings 27, Browns 7 (Met Stadium) — last pre-merger NFL Championship Game"),
]


def supplemental_games() -> list[Game]:
    """Build Game objects for the hand-curated NFL Championships."""
    return [
        Game(
            id=f"NFL-CHAMP-{date}",
            date=f"{date}T00:00:00Z",
            home_id=home,
            away_id=away,
            home_score=hs,
            away_score=as_,
        )
        for date, away, home, as_, hs, _note in NFL_CHAMPIONSHIPS
    ]
