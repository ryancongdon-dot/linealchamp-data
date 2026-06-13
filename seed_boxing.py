#!/usr/bin/env python3
"""
seed_boxing.py — hand-curated lineal heavyweight boxing chain + defenses.

Boxing's lineage isn't computed from game data; it's a curated historical
record. This script emits output/lineage-BOXHW.json + output/events-BOXHW.json
in the same schema as the other leagues so the worker + UI can consume it
unchanged.

Conventions:
  - Fighter "codes" are uppercase, no spaces for champions (SULLIVAN, ALI...).
  - Opponents who never became lineal champ are stored as their display name
    directly ("Carmen Basilio") so the UI can render them without a brand entry.
  - score encodes how the fight ended: KO/TKO+round, UD/SD/MD+rounds,
    DQ+round, RET (corner stoppage), ND (no-decision).
  - 4 vacancy gaps handled per the agreed rules (Marciano '56, Ali '67, Ali '79,
    Lewis '04 → unification).
  - Fury retains the belt through his 2016-2018 hiatus (no one beat him in the ring).
  - Briggs over Foreman 1997 included (official result, disputed decision).

Run:  python seed_boxing.py
"""

from __future__ import annotations

import json
from pathlib import Path
from datetime import date

ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "output"


# ─── Title changes (the lineal chain itself) ──────────────────────────────────
# (date, new_champ_code, score, from_champ_code_or_None, note)
HW_CHAIN: list[tuple[str, str, str, str | None, str]] = [
    ("1882-02-07", "SULLIVAN",       "SEED",  None,            "Seed: beat Paddy Ryan to become recognized champion; reign carries into the gloved era"),
    ("1892-09-07", "CORBETT",        "KO21",  "SULLIVAN",      "First gloved heavyweight title fight"),
    ("1897-03-17", "FITZSIMMONS",    "KO14",  "CORBETT",       "Carson City, Nevada"),
    ("1899-06-09", "JEFFRIES",       "KO11",  "FITZSIMMONS",   "Coney Island"),
    # Jeffries retired undefeated 1905 → vacant ~9 months
    ("1906-02-23", "BURNS",          "UD20",  "JEFFRIES",      "Won vacant title vs Marvin Hart"),
    ("1908-12-26", "JOHNSON",        "TKO14", "BURNS",         "First Black heavyweight champion; Sydney"),
    ("1915-04-05", "WILLARD",        "KO26",  "JOHNSON",       "Havana, Cuba"),
    ("1919-07-04", "DEMPSEY",        "TKO3",  "WILLARD",       "Toledo, Ohio"),
    ("1926-09-23", "TUNNEY",         "UD10",  "DEMPSEY",       "Philadelphia; 120,000+ in attendance"),
    # Tunney retired undefeated 1928 → vacant ~2 years
    ("1930-06-12", "SCHMELING",      "DQ4",   "TUNNEY",        "Won vacant title (Sharkey DQ'd for low blow)"),
    ("1932-06-21", "SHARKEY",        "SD15",  "SCHMELING",     "Long Island, NY"),
    ("1933-06-29", "CARNERA",        "TKO6",  "SHARKEY",       "Long Island, NY"),
    ("1934-06-14", "BAER",           "TKO11", "CARNERA",       "Long Island, NY"),
    ("1935-06-13", "BRADDOCK",       "UD15",  "BAER",          "Cinderella Man; Long Island, NY"),
    ("1937-06-22", "JOELOUIS",       "KO8",   "BRADDOCK",      "Chicago"),
    # Joe Louis retired 1949 → Ezzard Charles regained lineal by beating Louis 1950
    ("1950-09-27", "CHARLES",        "UD15",  "JOELOUIS",      "Beat Louis in his comeback (restores chain)"),
    ("1951-07-18", "WALCOTT",        "KO7",   "CHARLES",       "Oldest heavyweight champ at the time (37)"),
    ("1952-09-23", "MARCIANO",       "KO13",  "WALCOTT",       "Philadelphia"),
    # Marciano retired undefeated 1956 (49-0) → vacant ~6 months
    ("1956-11-30", "PATTERSON",      "KO5",   "MARCIANO",      "Won vacant title vs Archie Moore; youngest champ at 21"),
    ("1959-06-26", "JOHANSSON",      "TKO3",  "PATTERSON",     "Yankee Stadium"),
    ("1960-06-20", "PATTERSON",      "KO5",   "JOHANSSON",     "First man to regain heavyweight title"),
    ("1962-09-25", "LISTON",         "KO1",   "PATTERSON",     "Chicago"),
    ("1964-02-25", "MUHAMMADALI",    "RET7",  "LISTON",        "Miami Beach; \"Shook up the world\""),
    # Ali stripped of title 1967 for refusing Vietnam draft → vacant ~3 years
    ("1971-03-08", "FRAZIER",        "UD15",  "MUHAMMADALI",   "Fight of the Century; MSG (restores chain)"),
    ("1973-01-22", "FOREMAN",        "TKO2",  "FRAZIER",       "Sunshine Showdown; Kingston, Jamaica"),
    ("1974-10-30", "MUHAMMADALI",    "KO8",   "FOREMAN",       "Rumble in the Jungle; Kinshasa, Zaire"),
    ("1978-02-15", "SPINKSLEON",     "SD15",  "MUHAMMADALI",   "Las Vegas"),
    ("1978-09-15", "MUHAMMADALI",    "UD15",  "SPINKSLEON",    "New Orleans; first 3-time heavyweight champ"),
    # Ali retired 1979 → vacant ~17 months
    ("1980-10-02", "HOLMES",         "TKO11", "MUHAMMADALI",   "Beat Ali in his comeback (restores chain)"),
    ("1985-09-21", "SPINKSMICHAEL",  "UD15",  "HOLMES",        "Las Vegas; first light-heavyweight to win HW title"),
    ("1988-06-27", "TYSON",          "KO1",   "SPINKSMICHAEL", "Atlantic City; 91 seconds"),
    ("1990-02-11", "DOUGLAS",        "KO10",  "TYSON",         "Tokyo; one of the biggest upsets in sports history"),
    ("1990-10-25", "HOLYFIELD",      "KO3",   "DOUGLAS",       "Las Vegas"),
    ("1992-11-13", "BOWE",           "UD12",  "HOLYFIELD",     "Las Vegas"),
    ("1993-11-06", "HOLYFIELD",      "MD12",  "BOWE",          "Las Vegas (Fan Man fight)"),
    ("1994-04-22", "MOORER",         "MD12",  "HOLYFIELD",     "Las Vegas"),
    ("1994-11-05", "FOREMAN",        "KO10",  "MOORER",        "Las Vegas; oldest HW champ ever at 45"),
    ("1997-11-22", "BRIGGS",         "MD12",  "FOREMAN",       "Atlantic City; widely disputed decision"),
    ("1998-03-28", "LEWIS",          "TKO5",  "BRIGGS",        "Atlantic City"),
    ("2001-04-21", "RAHMAN",         "KO5",   "LEWIS",         "Johannesburg, South Africa"),
    ("2001-11-17", "LEWIS",          "KO4",   "RAHMAN",        "Las Vegas"),
    # Lennox Lewis retired 2004 → vacant ~7 years until W. Klitschko unifies
    ("2011-07-02", "KLITSCHKOWLAD",  "UD12",  "LEWIS",         "Beat David Haye to unify WBA/WBO/IBF (restores chain)"),
    ("2015-11-28", "FURY",           "UD12",  "KLITSCHKOWLAD", "Dusseldorf; ends Klitschko's 9.5-year reign"),
    # Fury vacated belts 2016-2018 but never lost in the ring; retains lineal status.
    ("2024-05-18", "USYK",           "SD12",  "FURY",          "Riyadh; first undisputed HW champ of 4-belt era"),
]


# ─── Successful title defenses ────────────────────────────────────────────────
# Keyed by champion code; entries are (date, opponent_name, score, note).
# Only fights *between* the champion's title win and their loss/retirement count.
# Multi-reign champs (Ali, Patterson, Holyfield, Foreman, Lewis) have their
# defenses split into multiple sub-lists by reign date range.
HW_DEFENSES: dict[str, list[tuple[str, str, str, str]]] = {
    "SULLIVAN": [
        ("1889-07-08", "Jake Kilrain", "KO75", "Last bare-knuckle world heavyweight title fight"),
    ],
    "CORBETT": [
        ("1894-01-25", "Charley Mitchell", "KO3", "Jacksonville, FL"),
    ],
    "JEFFRIES": [
        ("1899-11-03", "Tom Sharkey", "UD25", "Coney Island"),
        ("1900-04-06", "Jack Finnegan", "KO1", "Detroit"),
        ("1900-05-11", "James J. Corbett", "KO23", "Coney Island; Corbett rematch"),
        ("1901-11-15", "Gus Ruhlin", "TKO5", "San Francisco"),
        ("1902-07-25", "Bob Fitzsimmons", "KO8", "San Francisco; Fitz rematch"),
        ("1903-08-14", "James J. Corbett", "KO10", "San Francisco"),
        ("1904-08-25", "Jack Munroe", "KO2", "San Francisco"),
    ],
    "BURNS": [
        ("1906-10-02", "Jim Flynn",       "KO15", "Los Angeles"),
        ("1906-11-28", "Marvin Hart",     "UD20", "Hart rematch (Burns had won vacant title from him)"),
        ("1907-05-08", "Jack O'Brien",    "UD20", "Los Angeles"),
        ("1907-07-04", "Bill Squires",    "KO1",  "Colma, CA"),
        ("1907-12-02", "Gunner Moir",     "KO10", "London"),
        ("1908-02-10", "Jack Palmer",     "KO4",  "London"),
        ("1908-03-17", "Jem Roche",       "KO1",  "Dublin"),
        ("1908-04-18", "Jewey Smith",     "KO5",  "Paris"),
        ("1908-06-13", "Bill Squires",    "KO8",  "Paris; Squires II"),
        ("1908-08-24", "Bill Squires",    "KO13", "Sydney; Squires III"),
        ("1908-09-02", "Bill Lang",       "KO6",  "Melbourne"),
    ],
    "JOHNSON": [
        ("1909-09-09", "Al Kaufman",       "ND10", "San Francisco (newspaper decision)"),
        ("1909-10-16", "Stanley Ketchel",  "KO12", "Colma, CA; middleweight champ challenges up"),
        ("1910-07-04", "James J. Jeffries","TKO15","\"Great White Hope\"; Reno"),
        ("1912-07-04", "Jim Flynn",        "TKO9", "Las Vegas, NM"),
        ("1914-06-27", "Frank Moran",      "UD20", "Paris"),
    ],
    "WILLARD": [
        ("1916-03-25", "Frank Moran", "ND10", "New York (newspaper decision)"),
    ],
    "DEMPSEY": [
        ("1920-09-06", "Billy Miske",       "KO3", "Benton Harbor, MI"),
        ("1920-12-14", "Bill Brennan",      "KO12","New York"),
        ("1921-07-02", "Georges Carpentier","KO4", "Jersey City; first million-dollar gate"),
        ("1923-07-04", "Tom Gibbons",       "UD15","Shelby, MT"),
        ("1923-09-14", "Luis Firpo",        "KO2", "Polo Grounds; Wild Bull of the Pampas"),
    ],
    "TUNNEY": [
        ("1927-09-22", "Jack Dempsey", "UD10", "\"Long Count\"; Soldier Field, Chicago"),
        ("1928-07-26", "Tom Heeney",   "TKO11","New York (last fight before retiring)"),
    ],
    "SCHMELING": [
        ("1931-07-03", "Young Stribling", "TKO15", "Cleveland"),
    ],
    "CARNERA": [
        ("1933-10-22", "Paulino Uzcudun", "UD15", "Rome"),
        ("1934-03-01", "Tommy Loughran",  "UD15", "Miami"),
    ],
    # JOELOUIS — the famed 25 defenses, including the "Bum of the Month Club"
    "JOELOUIS": [
        ("1937-08-30", "Tommy Farr",        "UD15", "Yankee Stadium"),
        ("1938-02-23", "Nathan Mann",       "KO3",  "New York"),
        ("1938-04-01", "Harry Thomas",      "KO5",  "Chicago"),
        ("1938-06-22", "Max Schmeling",     "KO1",  "124-second revenge; Yankee Stadium"),
        ("1939-01-25", "John Henry Lewis",  "KO1",  "Light-heavyweight champ moves up"),
        ("1939-04-17", "Jack Roper",        "KO1",  "Los Angeles"),
        ("1939-06-28", "Tony Galento",      "TKO4", "Yankee Stadium"),
        ("1939-09-20", "Bob Pastor",        "KO11", "Detroit"),
        ("1940-02-09", "Arturo Godoy",      "SD15", "Madison Square Garden"),
        ("1940-03-29", "Johnny Paychek",    "KO2",  "New York"),
        ("1940-06-20", "Arturo Godoy",      "TKO8", "Yankee Stadium; rematch"),
        ("1940-12-16", "Al McCoy",          "TKO6", "Boston"),
        ("1941-01-31", "Red Burman",        "KO5",  "New York"),
        ("1941-02-17", "Gus Dorazio",       "KO2",  "Philadelphia"),
        ("1941-03-21", "Abe Simon",         "TKO13","Detroit"),
        ("1941-04-08", "Tony Musto",        "TKO9", "St. Louis"),
        ("1941-05-23", "Buddy Baer",        "DQ7",  "Washington, D.C."),
        ("1941-06-18", "Billy Conn",        "KO13", "Polo Grounds; came from behind"),
        ("1941-09-29", "Lou Nova",          "TKO6", "Polo Grounds"),
        ("1942-01-09", "Buddy Baer",        "KO1",  "Madison Square Garden"),
        ("1942-03-27", "Abe Simon",         "KO6",  "Madison Square Garden"),
        ("1946-06-19", "Billy Conn",        "KO8",  "Yankee Stadium; Conn rematch (first post-war)"),
        ("1946-09-18", "Tami Mauriello",    "KO1",  "Yankee Stadium"),
        ("1947-12-05", "Jersey Joe Walcott","SD15", "Madison Square Garden; controversial"),
        ("1948-06-25", "Jersey Joe Walcott","KO11", "Yankee Stadium; Walcott rematch"),
    ],
    "CHARLES": [
        ("1950-12-05", "Nick Barone",        "KO11", "Cincinnati"),
        ("1951-01-12", "Lee Oma",            "TKO10","Madison Square Garden"),
        ("1951-03-07", "Jersey Joe Walcott", "UD15", "Detroit"),
        ("1951-05-30", "Joey Maxim",         "UD15", "Chicago"),
    ],
    "WALCOTT": [
        ("1952-06-05", "Ezzard Charles", "UD15", "Philadelphia; Charles rematch"),
    ],
    "MARCIANO": [
        ("1953-05-15", "Jersey Joe Walcott", "KO1",  "Chicago; Walcott rematch"),
        ("1953-09-24", "Roland LaStarza",    "TKO11","Polo Grounds"),
        ("1954-06-17", "Ezzard Charles",     "UD15", "Yankee Stadium"),
        ("1954-09-17", "Ezzard Charles",     "KO8",  "Yankee Stadium; Charles rematch"),
        ("1955-05-16", "Don Cockell",        "TKO9", "San Francisco"),
        ("1955-09-21", "Archie Moore",       "KO9",  "Yankee Stadium; Marciano's final fight"),
    ],
    # PATTERSON has two reigns; defenses go in date order — first reign first.
    "PATTERSON_R1": [
        ("1957-07-29", "Tommy Jackson",  "TKO10","Polo Grounds"),
        ("1957-08-22", "Pete Rademacher","KO6",  "Seattle; Rademacher's pro debut"),
        ("1958-08-18", "Roy Harris",     "TKO12","Los Angeles"),
        ("1959-05-01", "Brian London",   "KO11", "Indianapolis"),
    ],
    "PATTERSON_R2": [
        ("1961-03-13", "Ingemar Johansson","KO6","Miami Beach; Johansson III"),
        ("1961-12-04", "Tom McNeeley",     "KO4","Toronto"),
    ],
    "LISTON": [
        ("1963-07-22", "Floyd Patterson", "KO1", "Las Vegas; Patterson rematch (also 1st-round KO)"),
    ],
    # MUHAMMADALI has three reigns.
    "MUHAMMADALI_R1": [
        ("1965-05-25", "Sonny Liston",       "KO1",  "Lewiston, ME; \"phantom punch\""),
        ("1965-11-22", "Floyd Patterson",    "TKO12","Las Vegas"),
        ("1966-03-29", "George Chuvalo",     "UD15", "Toronto"),
        ("1966-05-21", "Henry Cooper",       "TKO6", "London"),
        ("1966-08-06", "Brian London",       "KO3",  "London"),
        ("1966-09-10", "Karl Mildenberger",  "TKO12","Frankfurt"),
        ("1966-11-14", "Cleveland Williams", "TKO3", "Houston Astrodome"),
        ("1967-02-06", "Ernie Terrell",      "UD15", "Houston; \"What's my name?\""),
        ("1967-03-22", "Zora Folley",        "KO7",  "Madison Square Garden; last fight before draft refusal"),
    ],
    "MUHAMMADALI_R2": [
        ("1975-03-24", "Chuck Wepner",          "TKO15","Richfield, OH; inspired Rocky"),
        ("1975-05-16", "Ron Lyle",              "TKO11","Las Vegas"),
        ("1975-06-30", "Joe Bugner",            "UD15", "Kuala Lumpur"),
        ("1975-10-01", "Joe Frazier",           "TKO14","Thrilla in Manila"),
        ("1976-02-20", "Jean-Pierre Coopman",   "KO5",  "San Juan"),
        ("1976-04-30", "Jimmy Young",           "UD15", "Landover, MD"),
        ("1976-05-24", "Richard Dunn",          "TKO5", "Munich"),
        ("1976-09-28", "Ken Norton",            "UD15", "Yankee Stadium; Norton III (controversial)"),
        ("1977-05-16", "Alfredo Evangelista",   "UD15", "Landover, MD"),
        ("1977-09-29", "Earnie Shavers",        "UD15", "Madison Square Garden"),
    ],
    # MUHAMMADALI_R3 (1978-09 → 1979 retired): 0 defenses
    "FRAZIER": [
        ("1972-01-15", "Terry Daniels", "TKO4", "New Orleans"),
        ("1972-05-25", "Ron Stander",   "TKO5", "Omaha"),
    ],
    "FOREMAN_R1": [
        ("1973-09-01", "Joe Roman",  "KO1",  "Tokyo"),
        ("1974-03-26", "Ken Norton", "TKO2", "Caracas"),
    ],
    # FOREMAN_R2 (1994 → vacated WBA mid-1995 / IBF in 1995): 1 defense
    "FOREMAN_R2": [
        ("1995-04-22", "Axel Schulz", "MD12", "Las Vegas (IBF retained; WBA stripped Foreman)"),
    ],
    "HOLMES": [
        # Holmes' lineal reign begins Oct 2 1980 (beat Ali). Earlier WBC defenses excluded.
        ("1981-04-11", "Trevor Berbick",   "UD15", "Las Vegas"),
        ("1981-06-12", "Leon Spinks",      "TKO3", "Detroit"),
        ("1981-11-06", "Renaldo Snipes",   "TKO11","Pittsburgh"),
        ("1982-06-11", "Gerry Cooney",     "TKO13","Las Vegas; \"Great White Hope\""),
        ("1982-11-26", "Randall Tex Cobb", "UD15", "Houston"),
        ("1983-03-27", "Lucien Rodriguez", "UD12", "Scranton, PA"),
        ("1983-05-20", "Tim Witherspoon",  "SD12", "Las Vegas"),
        ("1983-09-10", "Scott Frank",      "TKO5", "Atlantic City"),
        ("1983-11-25", "Marvis Frazier",   "TKO1", "Las Vegas; Joe Frazier's son"),
        ("1984-11-09", "James Tillis",     "UD12", "Reno"),
        ("1985-03-15", "David Bey",        "TKO10","Las Vegas"),
        ("1985-05-20", "Carl Williams",    "UD15", "Reno"),
    ],
    "SPINKSMICHAEL": [
        ("1986-04-19", "Larry Holmes", "SD15", "Las Vegas; Holmes rematch"),
    ],
    "TYSON": [
        ("1989-02-25", "Frank Bruno",   "TKO5", "Las Vegas"),
        ("1989-07-21", "Carl Williams", "TKO1", "Atlantic City"),
    ],
    "HOLYFIELD_R1": [
        ("1991-04-19", "George Foreman", "UD12", "Atlantic City; Foreman's comeback at 42"),
        ("1991-11-23", "Bert Cooper",    "TKO7", "Atlanta"),
        ("1992-06-19", "Larry Holmes",   "UD12", "Las Vegas"),
    ],
    "BOWE": [
        ("1993-02-06", "Michael Dokes",  "TKO1", "Madison Square Garden"),
        ("1993-05-22", "Jesse Ferguson", "TKO2", "Washington, D.C."),
    ],
    # HOLYFIELD_R2 (1993-11 → 1994-04): 0 defenses
    # MOORER (1994-04 → 1994-11): 0 defenses
    # BRIGGS (1997-11 → 1998-03): 0 defenses
    "LEWIS_R1": [
        ("1998-09-26", "Zeljko Mavrovic",  "UD12","Uncasville, CT"),
        ("1999-03-13", "Evander Holyfield","SD12","Madison Square Garden (controversial draw scored to Lewis on appeal — counted as defense)"),
        ("1999-11-13", "Evander Holyfield","UD12","Las Vegas; Holyfield rematch"),
        ("2000-04-29", "Michael Grant",    "KO2", "Madison Square Garden"),
        ("2000-07-15", "Frans Botha",      "TKO2","London"),
        ("2000-11-11", "David Tua",        "UD12","Las Vegas"),
    ],
    "LEWIS_R2": [
        ("2002-06-08", "Mike Tyson",       "KO8", "Memphis"),
        ("2003-06-21", "Vitali Klitschko", "TKO6","Los Angeles (doctor stoppage); Lewis' final fight"),
    ],
    "KLITSCHKOWLAD": [
        ("2011-09-10", "Tomasz Adamek",       "TKO10","Wroclaw"),
        ("2012-03-03", "Jean-Marc Mormeck",   "KO4",  "Düsseldorf"),
        ("2012-07-07", "Tony Thompson",       "KO6",  "Bern"),
        ("2012-11-10", "Mariusz Wach",        "UD12", "Hamburg"),
        ("2013-05-04", "Francesco Pianeta",   "KO6",  "Mannheim"),
        ("2013-10-05", "Alexander Povetkin",  "UD12", "Moscow"),
        ("2014-04-26", "Alex Leapai",         "TKO5", "Oberhausen"),
        ("2014-09-06", "Kubrat Pulev",        "KO5",  "Hamburg"),
        ("2015-04-25", "Bryant Jennings",     "UD12", "Madison Square Garden"),
    ],
    "FURY": [
        ("2020-02-22", "Deontay Wilder", "TKO7", "Las Vegas; Wilder II"),
        ("2021-10-09", "Deontay Wilder", "KO11", "Las Vegas; Wilder III"),
        ("2022-04-23", "Dillian Whyte",  "TKO6", "Wembley Stadium"),
        ("2022-12-03", "Derek Chisora",  "TKO10","London; Chisora III"),
    ],
    "USYK": [
        ("2024-12-21", "Tyson Fury", "UD12", "Riyadh; Fury rematch"),
    ],
}


# Reign-bracketed champions whose defenses are split across multiple reigns.
# The map below tells the emitter which DEFENSES bucket maps to which reign
# (by the title-winning fight date in CHAIN).
HW_REIGN_BRACKETS: dict[tuple[str, str], str] = {
    # (champ_code, reign_start_date): bucket_key in DEFENSES
    ("PATTERSON",    "1956-11-30"): "PATTERSON_R1",
    ("PATTERSON",    "1960-06-20"): "PATTERSON_R2",
    ("MUHAMMADALI",  "1964-02-25"): "MUHAMMADALI_R1",
    ("MUHAMMADALI",  "1974-10-30"): "MUHAMMADALI_R2",
    # MUHAMMADALI_R3 (1978-09-15) has no defenses; intentionally omitted.
    ("FOREMAN",      "1973-01-22"): "FOREMAN_R1",
    ("FOREMAN",      "1994-11-05"): "FOREMAN_R2",
    ("HOLYFIELD",    "1990-10-25"): "HOLYFIELD_R1",
    # HOLYFIELD_R2 (1993-11-06): 0 defenses; intentionally omitted.
    ("LEWIS",        "1998-03-28"): "LEWIS_R1",
    ("LEWIS",        "2001-11-17"): "LEWIS_R2",
}


# ═══════════════════════════════════════════════════════════════════════════════
# LIGHT HEAVYWEIGHT (175 lb)
# Created 1903. Long history — fewer dominant long reigns than HW except for
# Archie Moore (10 years) and Bob Foster (6 years). Several extended vacancies:
# 1905-1916 (early-era confusion), 1962-63 (Moore stripped/retired),
# 1985-1999 (Spinks moves to HW, division splinters under alphabet titles).
# Modern era restored when Roy Jones Jr unifies multiple major belts ~1999.
# ═══════════════════════════════════════════════════════════════════════════════

LHW_CHAIN: list[tuple[str, str, str, str | None, str]] = [
    ("1903-04-22", "ROOT",              "SEED",  None,           "Won inaugural light heavyweight title fight vs Kid McCoy"),
    ("1903-07-04", "GARDNER",           "KO12",  "ROOT",         "Fort Erie, Ontario"),
    ("1903-11-25", "FITZSIMMONSBOB",    "UD20",  "GARDNER",      "Former HW lineal champ adds LHW title; San Francisco"),
    ("1905-12-20", "OBRIENJACK",        "RET13", "FITZSIMMONSBOB","\"Philadelphia Jack\" O'Brien"),
    # O'Brien moved up to heavyweight; title disputed/vacant for a decade
    ("1916-10-24", "LEVINSKY",          "UD12",  "OBRIENJACK",   "Won vacant title vs Jack Dillon"),
    ("1920-10-12", "CARPENTIER",        "KO4",   "LEVINSKY",     "Jersey City; Frenchman's apex moment"),
    ("1922-09-24", "SIKI",              "KO6",   "CARPENTIER",   "Paris; first African champion of any weight class"),
    ("1923-03-17", "MCTIGUE",           "UD20",  "SIKI",         "Dublin, St. Patrick's Day"),
    ("1925-05-30", "BERLENBACH",        "UD15",  "MCTIGUE",      "Yankee Stadium"),
    ("1926-07-16", "DELANEY",           "UD15",  "BERLENBACH",   "Brooklyn"),
    # Delaney vacated to fight heavyweight (1927)
    ("1927-12-12", "LOUGHRAN",          "UD15",  "DELANEY",      "Won vacant title vs Jimmy Slattery"),
    # Loughran vacated to fight HW (1929)
    ("1930-06-25", "ROSENBLOOM",        "UD15",  "LOUGHRAN",     "Won vacant title vs Jimmy Slattery"),
    ("1934-11-16", "OLIN",              "UD15",  "ROSENBLOOM",   "Madison Square Garden"),
    ("1935-10-31", "LEWISJOHNHENRY",    "UD15",  "OLIN",         "St. Louis"),
    # John Henry Lewis vacated to fight Joe Louis (1939); blindness ended career
    ("1939-02-03", "BETTINA",           "TKO9",  "LEWISJOHNHENRY","Won vacant title vs Tiger Jack Fox"),
    ("1939-07-13", "CONN",              "UD15",  "BETTINA",      "Pittsburgh"),
    # Billy Conn vacated to fight HW (1940; lost famously to Joe Louis 1941)
    ("1941-05-22", "LESNEVICH",         "UD15",  "CONN",         "Beat Anton Christoforidis for vacant title; New York"),
    ("1948-07-26", "MILLS",             "UD15",  "LESNEVICH",    "London; British champion"),
    ("1950-01-24", "MAXIM",             "KO10",  "MILLS",        "London"),
    ("1952-12-17", "MOORE",             "UD15",  "MAXIM",        "St. Louis; begins legendary 10-year reign"),
    # Archie Moore stripped 1962 for refusing to defend; chain restored by Johnson
    ("1962-06-23", "JOHNSONHAROLD",     "UD15",  "MOORE",        "Beat Doug Jones; consolidates lineal claim"),
    ("1963-06-01", "PASTRANO",          "UD15",  "JOHNSONHAROLD","Las Vegas"),
    ("1965-03-30", "TORRES",            "TKO9",  "PASTRANO",     "Madison Square Garden"),
    ("1966-12-16", "TIGER",             "UD15",  "TORRES",       "Nigerian-born; previously held middleweight"),
    ("1968-05-24", "FOSTER",            "KO4",   "TIGER",        "Madison Square Garden; iconic left hook"),
    # Bob Foster retired 1974
    ("1974-10-01", "CONTEH",            "UD15",  "FOSTER",       "Won vacant title vs Jorge Ahumada; British"),
    # Conteh vacated in 1977
    ("1978-01-07", "PARLOV",            "UD15",  "CONTEH",       "Won vacant title vs Miguel Cuello"),
    ("1978-12-02", "JOHNSONMARVIN",     "TKO10", "PARLOV",       "Marsala, Italy"),
    ("1979-04-22", "SAADMUHAMMAD",      "TKO8",  "JOHNSONMARVIN","Indianapolis"),
    ("1981-12-19", "QAWI",              "TKO10", "SAADMUHAMMAD", "Atlantic City"),
    ("1983-03-18", "SPINKSMICHAEL",     "UD15",  "QAWI",         "Atlantic City; unifies WBA + WBC titles"),
    # Spinks moves up to HW in 1985 → vacant ~14 years as the division splinters
    ("1999-06-05", "ROYJONESJR",        "UD12",  "SPINKSMICHAEL","Beat Reggie Johnson for unified WBA/WBC/IBF; restores lineal chain"),
    ("2004-05-15", "TARVER",            "KO2",   "ROYJONESJR",   "Las Vegas; ends Jones's pound-for-pound era"),
    ("2004-12-18", "JOHNSONGLEN",       "UD12",  "TARVER",       "Memphis"),
    ("2005-10-15", "TARVER",            "UD12",  "JOHNSONGLEN",  "Memphis; Tarver regains"),
    ("2006-06-10", "HOPKINS",           "UD12",  "TARVER",       "Atlantic City; B-Hop wins at 41"),
    ("2008-04-19", "CALZAGHE",          "SD12",  "HOPKINS",      "Las Vegas; Calzaghe's American debut"),
    # Calzaghe retires undefeated late 2008 → vacant ~3 years
    ("2011-05-21", "HOPKINS",           "UD12",  "CALZAGHE",     "Beat Jean Pascal for vacant title; oldest world champion ever at 46"),
    ("2012-04-28", "DAWSON",            "UD12",  "HOPKINS",      "Atlantic City"),
    ("2013-06-08", "STEVENSON",         "KO1",   "DAWSON",       "Montreal; 76-second KO"),
    ("2018-12-01", "GVOZDYK",           "TKO11", "STEVENSON",    "Quebec City; Stevenson hospitalized after"),
    ("2019-10-18", "BETERBIEV",         "TKO10", "GVOZDYK",      "Philadelphia"),
    ("2025-02-22", "BIVOL",             "MD12",  "BETERBIEV",    "Riyadh; rematch of Oct 2024 fight"),
]

LHW_DEFENSES: dict[str, list[tuple[str, str, str, str]]] = {
    # Selected major defenses; not exhaustive for the early era. Focused on
    # the 10-year reigns (Moore, Foster) and the modern champions.
    "MOORE": [
        ("1954-06-22", "Harold Johnson",  "TKO14","New York"),
        ("1955-06-22", "Bobo Olson",      "KO3",  "New York"),
        ("1956-06-05", "Yolande Pompey",  "TKO10","London"),
        ("1958-09-20", "Yvon Durelle",    "KO11", "Montreal; Durelle dropped Moore four times before the KO"),
        ("1959-08-12", "Yvon Durelle",    "KO3",  "Montreal; rematch"),
        ("1961-06-10", "Giulio Rinaldi",  "UD15", "New York; Moore's final lineal defense"),
    ],
    "FOSTER": [
        ("1969-01-22", "Frank DePaula",   "KO1",  "Madison Square Garden"),
        ("1969-05-24", "Andy Kendall",    "TKO4", "Springfield, MA"),
        ("1970-04-04", "Roger Rouse",     "TKO4", "Missoula, MT"),
        ("1970-06-27", "Mark Tessman",    "KO10", "Baltimore"),
        ("1972-04-07", "Vicente Rondón",  "KO2",  "Miami Beach; unified WBA"),
        ("1972-06-27", "Mike Quarry",     "KO4",  "Las Vegas"),
        ("1972-09-26", "Chris Finnegan",  "TKO14","London"),
        ("1973-08-21", "Pierre Fourie",   "UD15", "Albuquerque"),
        ("1973-12-01", "Pierre Fourie",   "UD15", "Johannesburg"),
    ],
    "SPINKSMICHAEL": [
        ("1983-09-18", "Oscar Rivadeneyra","TKO10","Vancouver"),
        ("1984-02-25", "Eddie Davis",     "UD15", "Atlantic City"),
        ("1985-06-06", "Jim MacDonald",   "TKO8", "Las Vegas; Spinks's last LHW defense before moving up"),
    ],
    "ROYJONESJR": [
        ("2000-01-15", "David Telesco",   "UD12", "Madison Square Garden"),
        ("2000-05-13", "Richard Hall",    "TKO11","Indianapolis"),
        ("2000-09-09", "Eric Harding",    "RET10","Tampa"),
        ("2001-02-24", "Derrick Harmon",  "TKO10","Tampa"),
        ("2001-07-28", "Julio González",  "UD12", "Los Angeles"),
        ("2002-02-02", "Glen Kelly",      "KO7",  "Miami"),
        ("2003-03-01", "Clinton Woods",   "TKO6", "Portland, OR"),
        ("2003-11-08", "Antonio Tarver",  "MD12", "Las Vegas; Tarver I"),
    ],
    "HOPKINS_R1": [
        ("2007-07-21", "Winky Wright",    "UD12", "Las Vegas (catchweight 170)"),
    ],
    "HOPKINS_R2": [
        ("2012-03-03", "Chad Dawson",     "TKO2", "Los Angeles (no-contest; later reversed to Dawson win — controversial)"),
        # Note: above bout was originally NC; on appeal reversed to Dawson TKO2.
        # The next entry (proper Dawson rematch loss) is the actual chain transfer.
    ],
    "BETERBIEV": [
        ("2020-03-14", "Meng Fanlong",    "TKO8", "Quebec City"),
        ("2022-01-22", "Marcus Browne",   "TKO9", "Montreal"),
        ("2022-06-18", "Joe Smith Jr.",   "TKO2", "Madison Square Garden; unifies IBF+WBC+WBO"),
        ("2023-01-28", "Anthony Yarde",   "TKO8", "London"),
        ("2024-01-13", "Callum Smith",    "TKO7", "Quebec City"),
        ("2024-10-12", "Dmitry Bivol",    "MD12", "Riyadh; undisputed unification, all 4 belts"),
    ],
    "BIVOL": [
        # Bivol's lineal reign begins 2025-02-22 (rematch win). No defenses yet.
    ],
}

LHW_REIGN_BRACKETS: dict[tuple[str, str], str] = {
    ("HOPKINS", "2006-06-10"): "HOPKINS_R1",
    ("HOPKINS", "2011-05-21"): "HOPKINS_R2",
    # TARVER R1 (2004-05-15 → 2004-12-18) and TARVER R2 (2005-10-15 → 2006-06-10)
    # have no defenses curated yet.
}


# ═══════════════════════════════════════════════════════════════════════════════
# WEIGHT CLASS REGISTRY
# Add new classes here; the builder iterates this dict.
# ═══════════════════════════════════════════════════════════════════════════════

CLASSES: dict[str, dict] = {
    "BOXHW": {
        "label": "Heavyweight",
        "short": "HW",
        "chain": HW_CHAIN,
        "defenses": HW_DEFENSES,
        "reign_brackets": HW_REIGN_BRACKETS,
    },
    "BOXLHW": {
        "label": "Light Heavyweight",
        "short": "LHW",
        "chain": LHW_CHAIN,
        "defenses": LHW_DEFENSES,
        "reign_brackets": LHW_REIGN_BRACKETS,
    },
}


def norm_date(d: str) -> str:
    return f"{d}T00:00:00Z"


def build_class(code: str, short: str, chain, defenses, reign_brackets) -> dict:
    """Run the chain → lineage + events emit for a single weight class."""
    changes: list[dict] = []
    events: list[dict] = []
    seq = 0
    for d, to, score, frm, _note in chain:
        seq += 1
        gid = f"BOX-{short}-{seq:03d}"
        change: dict = {"date": norm_date(d), "gameId": gid, "from": frm, "to": to}
        if score and score != "SEED":
            change["score"] = score
        if score == "SEED":
            change["seed"] = True
        changes.append(change)

        # Title-change event from the previous champion's POV (a loss).
        if frm and score != "SEED":
            events.append({
                "date": norm_date(d), "gameId": gid,
                "champ": frm, "opponent": to,
                "champScore": 0, "oppScore": 0,
                "result": "L", "score": score, "change": True,
            })

        bucket = reign_brackets.get((to, d)) or to
        defs = defenses.get(bucket, [])
        for i, (ddate, opp_name, dscore, _dnote) in enumerate(defs, start=1):
            events.append({
                "date": norm_date(ddate),
                "gameId": f"{gid}-D{i:02d}",
                "champ": to, "opponent": opp_name,
                "champScore": 0, "oppScore": 0,
                "result": "W", "score": dscore, "change": False,
            })

    today = date.today().isoformat()
    current = changes[-1]["to"]
    seed = changes[0]
    lineage = {
        "league": code,
        "seedTeam": seed["to"], "seedDate": seed["date"][:10],
        "asOfDate": today, "currentChamp": current,
        "changes": changes,
    }
    events_payload = {"league": code, "asOfDate": today, "events": events}

    (OUTPUT_DIR / f"lineage-{code}.json").write_text(json.dumps(lineage, indent=2))
    (OUTPUT_DIR / f"events-{code}.json").write_text(json.dumps(events_payload, indent=2))

    defenses_total = sum(len(v) for v in defenses.values())
    print(
        f"  {code:7} ✓ {len(changes):3} reigns, {len(events):4} title fights "
        f"({defenses_total} defenses + title changes), current champ: {current}"
    )
    return {"code": code, "reigns": len(changes), "events": len(events), "current": current}


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for code, cfg in CLASSES.items():
        build_class(
            code=code,
            short=cfg["short"],
            chain=cfg["chain"],
            defenses=cfg["defenses"],
            reign_brackets=cfg["reign_brackets"],
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
