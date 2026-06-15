#!/usr/bin/env python3
"""
seed_brands.py — bulk-upload team display names, colors, and logos to the Worker.

Reads every code that appears in output/lineage-<LEAGUE>.json and POSTs a brand
entry to /admin/brand/set for each. Historical / unmapped codes get a
prettified name and a neutral color but no logo.

Run:
    export ADMIN_SECRET=...   # same one the Worker has
    python seed_brands.py     # writes to KV via the live Worker
    python seed_brands.py --dry-run   # print what would be sent, don't post

ESPN CDN is used for logos where the team has a stable ESPN slug. URLs are
hot-linked at runtime by browsers, so they need to remain valid.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

import requests

WORKER_URL = "https://linealchamp-api.ryan-congdon.workers.dev"
ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "output"

ESPN = "https://a.espncdn.com/i/teamlogos/{sport}/500/{slug}.png"

# ─── NBA ────────────────────────────────────────────────────────────────────
# BDL NBA uses standard NBA abbreviations. ESPN slugs are lowercase.
NBA = {
    "ATL": ("Atlanta Hawks", "#E03A3E", "atl"),
    "BOS": ("Boston Celtics", "#007A33", "bos"),
    "BKN": ("Brooklyn Nets", "#000000", "bkn"),
    "CHA": ("Charlotte Hornets", "#1D1160", "cha"),
    "CHI": ("Chicago Bulls", "#CE1141", "chi"),
    "CLE": ("Cleveland Cavaliers", "#860038", "cle"),
    "DAL": ("Dallas Mavericks", "#00538C", "dal"),
    "DEN": ("Denver Nuggets", "#0E2240", "den"),
    "DET": ("Detroit Pistons", "#C8102E", "det"),
    "GSW": ("Golden State Warriors", "#1D428A", "gs"),
    "HOU": ("Houston Rockets", "#CE1141", "hou"),
    "IND": ("Indiana Pacers", "#002D62", "ind"),
    "LAC": ("LA Clippers", "#C8102E", "lac"),
    "LAL": ("Los Angeles Lakers", "#552583", "lal"),
    "MEM": ("Memphis Grizzlies", "#5D76A9", "mem"),
    "MIA": ("Miami Heat", "#98002E", "mia"),
    "MIL": ("Milwaukee Bucks", "#00471B", "mil"),
    "MIN": ("Minnesota Timberwolves", "#0C2340", "min"),
    "NOP": ("New Orleans Pelicans", "#0C2340", "no"),
    "NYK": ("New York Knicks", "#006BB6", "ny"),
    "OKC": ("Oklahoma City Thunder", "#007AC1", "okc"),
    "ORL": ("Orlando Magic", "#0077C0", "orl"),
    "PHI": ("Philadelphia 76ers", "#006BB6", "phi"),
    "PHX": ("Phoenix Suns", "#1D1160", "phx"),
    "POR": ("Portland Trail Blazers", "#E03A3E", "por"),
    "SAC": ("Sacramento Kings", "#5A2D81", "sac"),
    "SAS": ("San Antonio Spurs", "#C4CED4", "sa"),
    "TOR": ("Toronto Raptors", "#CE1141", "tor"),
    "UTA": ("Utah Jazz", "#002B5C", "utah"),
    "WAS": ("Washington Wizards", "#002B5C", "wsh"),
    # Historical / defunct
    "BAL": ("Baltimore Bullets (BAA)", "#444", None),
    "PHW": ("Philadelphia Warriors", "#444", None),
    "MNL": ("Minneapolis Lakers", "#444", None),
    "SYR": ("Syracuse Nationals", "#444", None),
    "FTW": ("Fort Wayne Pistons", "#444", None),
    "STL": ("St. Louis Hawks", "#444", None),
    "KCK": ("Kansas City Kings", "#444", None),
    "SDC": ("San Diego Clippers", "#444", None),
    "BUF": ("Buffalo Braves", "#444", None),
    "SEA": ("Seattle SuperSonics", "#444", None),
    "VAN": ("Vancouver Grizzlies", "#444", None),
    "NJN": ("New Jersey Nets", "#444", None),
    "NOH": ("New Orleans Hornets", "#444", None),
    "WSB": ("Washington Bullets", "#444", None),
    "CHH": ("Charlotte Hornets (1988-2002)", "#444", None),
    "TRI": ("Tri-Cities Blackhawks", "#444", None),
    "SHE": ("Sheboygan Red Skins", "#444", None),
    "AND": ("Anderson Packers", "#444", None),
    "WAT": ("Waterloo Hawks", "#444", None),
    "INO": ("Indianapolis Olympians", "#444", None),
    "DNN": ("Denver Nuggets (NBL)", "#444", None),
    "PRO": ("Providence Steamrollers", "#444", None),
    "TOR (HUSKIES)": ("Toronto Huskies", "#444", None),
    "STB": ("St. Louis Bombers", "#444", None),
    "CHS": ("Chicago Stags", "#444", None),
    "CLR": ("Cleveland Rebels", "#444", None),
    "PIT": ("Pittsburgh Ironmen", "#444", None),
    "DTF": ("Detroit Falcons", "#444", None),
}

# ─── NFL ────────────────────────────────────────────────────────────────────
NFL = {
    "ARI": ("Arizona Cardinals", "#97233F", "ari"),
    "ATL": ("Atlanta Falcons", "#A71930", "atl"),
    "BAL": ("Baltimore Ravens", "#241773", "bal"),
    "BUF": ("Buffalo Bills", "#00338D", "buf"),
    "CAR": ("Carolina Panthers", "#0085CA", "car"),
    "CHI": ("Chicago Bears", "#0B162A", "chi"),
    "CIN": ("Cincinnati Bengals", "#FB4F14", "cin"),
    "CLE": ("Cleveland Browns", "#311D00", "cle"),
    "DAL": ("Dallas Cowboys", "#003594", "dal"),
    "DEN": ("Denver Broncos", "#FB4F14", "den"),
    "DET": ("Detroit Lions", "#0076B6", "det"),
    "GB":  ("Green Bay Packers", "#203731", "gb"),
    "HOU": ("Houston Texans", "#03202F", "hou"),
    "IND": ("Indianapolis Colts", "#002C5F", "ind"),
    "JAX": ("Jacksonville Jaguars", "#101820", "jax"),
    "KC":  ("Kansas City Chiefs", "#E31837", "kc"),
    "LAC": ("Los Angeles Chargers", "#0080C6", "lac"),
    "LAR": ("Los Angeles Rams", "#003594", "lar"),
    "LV":  ("Las Vegas Raiders", "#000000", "lv"),
    "MIA": ("Miami Dolphins", "#008E97", "mia"),
    "MIN": ("Minnesota Vikings", "#4F2683", "min"),
    "NE":  ("New England Patriots", "#002244", "ne"),
    "NO":  ("New Orleans Saints", "#D3BC8D", "no"),
    "NYG": ("New York Giants", "#0B2265", "nyg"),
    "NYJ": ("New York Jets", "#125740", "nyj"),
    "PHI": ("Philadelphia Eagles", "#004C54", "phi"),
    "PIT": ("Pittsburgh Steelers", "#FFB612", "pit"),
    "SEA": ("Seattle Seahawks", "#002244", "sea"),
    "SF":  ("San Francisco 49ers", "#AA0000", "sf"),
    "TB":  ("Tampa Bay Buccaneers", "#D50A0A", "tb"),
    "TEN": ("Tennessee Titans", "#0C2340", "ten"),
    "WAS": ("Washington Commanders", "#5A1414", "wsh"),
    # Pre-2020 names that may appear
    "OAK": ("Oakland Raiders", "#444", None),
    "SD":  ("San Diego Chargers", "#444", None),
    "STL": ("St. Louis Rams", "#444", None),
    # Defunct 1933-era NFL franchises (real NFL teams that folded; distinct
    # from MLB teams of the same name that existed alongside them).
    "BKND": ("Brooklyn Dodgers (NFL)", "#1f3a93", None),
    "CINR": ("Cincinnati Reds (NFL)", "#C8102E", None),
}

# ─── MLB ────────────────────────────────────────────────────────────────────
# Retrosheet codes. The first letter pair is the city, third is league
# (A=American, N=National, etc.). Many codes belong to defunct franchises.
MLB = {
    # Current 30 — Retrosheet → ESPN slug
    "ANA": ("Los Angeles Angels", "#BA0021", "laa"),   # Anaheim
    "ARI": ("Arizona Diamondbacks", "#A71930", "ari"),
    "ATL": ("Atlanta Braves", "#CE1141", "atl"),
    "BAL": ("Baltimore Orioles", "#DF4601", "bal"),
    "BOS": ("Boston Red Sox", "#BD3039", "bos"),
    "CHA": ("Chicago White Sox", "#27251F", "chw"),
    "CHN": ("Chicago Cubs", "#0E3386", "chc"),
    "CIN": ("Cincinnati Reds", "#C6011F", "cin"),
    "CLE": ("Cleveland Guardians", "#00385D", "cle"),
    "COL": ("Colorado Rockies", "#333366", "col"),
    "DET": ("Detroit Tigers", "#0C2340", "det"),
    "HOU": ("Houston Astros", "#EB6E1F", "hou"),
    "KCA": ("Kansas City Royals", "#004687", "kc"),
    "LAN": ("Los Angeles Dodgers", "#005A9C", "lad"),
    "MIA": ("Miami Marlins", "#00A3E0", "mia"),
    "MIL": ("Milwaukee Brewers", "#12284B", "mil"),
    "MIN": ("Minnesota Twins", "#002B5C", "min"),
    "NYA": ("New York Yankees", "#003087", "nyy"),
    "NYN": ("New York Mets", "#002D72", "nym"),
    "OAK": ("Oakland Athletics", "#003831", "oak"),
    "PHI": ("Philadelphia Phillies", "#E81828", "phi"),
    "PIT": ("Pittsburgh Pirates", "#27251F", "pit"),
    "SDN": ("San Diego Padres", "#2F241D", "sd"),
    "SEA": ("Seattle Mariners", "#0C2C56", "sea"),
    "SFN": ("San Francisco Giants", "#FD5A1E", "sf"),
    "SLN": ("St. Louis Cardinals", "#C41E3A", "stl"),
    "TBA": ("Tampa Bay Rays", "#092C5C", "tb"),
    "TEX": ("Texas Rangers", "#003278", "tex"),
    "TOR": ("Toronto Blue Jays", "#134A8E", "tor"),
    "WAS": ("Washington Nationals", "#AB0003", "wsh"),
    # Defunct / pre-modern (no logos)
    "PH1": ("Philadelphia Athletics (NA)", "#444", None),
    "BS1": ("Boston Red Stockings", "#444", None),
    "WS3": ("Washington Olympics", "#444", None),
    "NY2": ("New York Mutuals", "#444", None),
    "FW1": ("Fort Wayne Kekiongas", "#444", None),
    "CH1": ("Chicago White Stockings (NA)", "#444", None),
    "CL1": ("Cleveland Forest Citys", "#444", None),
    "RC1": ("Rockford Forest Citys", "#444", None),
    "TRO": ("Troy Haymakers", "#444", None),
    "BR1": ("Brooklyn Eckfords", "#444", None),
    "BR2": ("Brooklyn Atlantics", "#444", None),
    "MID": ("Middletown Mansfields", "#444", None),
    "WS4": ("Washington Nationals (NA)", "#444", None),
    "WS5": ("Washington Blue Legs", "#444", None),
    "BSN": ("Boston Braves", "#444", None),
    "BSP": ("Boston Beaneaters", "#444", None),
    "BRO": ("Brooklyn Dodgers", "#444", None),
    "NY1": ("New York Giants", "#444", None),
    "PHA": ("Philadelphia Athletics (AL)", "#444", None),
    "SLA": ("St. Louis Browns", "#444", None),
    "WS1": ("Washington Senators (1901-60)", "#444", None),
    "WS2": ("Washington Senators (1961-71)", "#444", None),
    "WAS1": ("Washington Senators", "#444", None),
    "KC1": ("Kansas City Athletics", "#444", None),
    "ML1": ("Milwaukee Braves", "#444", None),
    "ML4": ("Milwaukee Brewers (1969+)", "#444", None),
    "MON": ("Montreal Expos", "#444", None),
    "CAL": ("California Angels", "#444", None),
    "FLA": ("Florida Marlins", "#444", None),
    "TBR": ("Tampa Bay Devil Rays", "#444", None),
    "ALT": ("Altoona Mountain Citys", "#444", None),
    "BL1": ("Baltimore Canaries", "#444", None),
    "BL2": ("Baltimore Lord Baltimores", "#444", None),
    "BL3": ("Baltimore Orioles (AA)", "#444", None),
    "BL4": ("Baltimore Monumentals", "#444", None),
    "BLU": ("Buffalo Bisons", "#444", None),
    "BR3": ("Brooklyn Grays", "#444", None),
    "BR4": ("Brooklyn Wonders", "#444", None),
    "BUF": ("Buffalo Bisons (NL)", "#444", None),
    "CIN1": ("Cincinnati Red Stockings", "#444", None),
    "CL2": ("Cleveland Blues", "#444", None),
    "CL3": ("Cleveland Spiders", "#444", None),
    "CL4": ("Cleveland Infants", "#444", None),
    "CL5": ("Cleveland Blues (PL)", "#444", None),
    "CN2": ("Cincinnati Kelly's Killers", "#444", None),
    "DTN": ("Detroit Wolverines", "#444", None),
    "ELI": ("Elizabeth Resolutes", "#444", None),
    "HAR": ("Hartford Dark Blues", "#444", None),
    "IN1": ("Indianapolis Blues", "#444", None),
    "IN2": ("Indianapolis Hoosiers (UA)", "#444", None),
    "IN3": ("Indianapolis Hoosiers (NL)", "#444", None),
    "KEO": ("Keokuk Westerns", "#444", None),
    "LS1": ("Louisville Grays", "#444", None),
    "LS2": ("Louisville Colonels (AA)", "#444", None),
    "LS3": ("Louisville Colonels (NL)", "#444", None),
    "MIL1": ("Milwaukee Cream Citys", "#444", None),
    "MLA": ("Milwaukee Brewers (AL)", "#444", None),
    "MLU": ("Milwaukee Brewers (UA)", "#444", None),
    "NEW": ("Newark Pepper", "#444", None),
    "NWK": ("Newark Domestics", "#444", None),
    "NH1": ("New Haven Elm Citys", "#444", None),
    "NYP": ("New York Metropolitans", "#444", None),
    "PH2": ("Philadelphia Whites", "#444", None),
    "PH3": ("Philadelphia Centennials", "#444", None),
    "PH4": ("Philadelphia Athletics (AA)", "#444", None),
    "PH5": ("Philadelphia Keystones", "#444", None),
    "PHI1": ("Philadelphia Quakers", "#444", None),
    "PHU": ("Philadelphia Keystones (UA)", "#444", None),
    "PHP": ("Philadelphia Athletics (PL)", "#444", None),
    "PIU": ("Pittsburgh Stogies", "#444", None),
    "PRO": ("Providence Grays", "#444", None),
    "RIC": ("Richmond Virginians", "#444", None),
    "SLU": ("St. Louis Maroons (UA)", "#444", None),
    "SR1": ("Syracuse Stars (NL)", "#444", None),
    "SR2": ("Syracuse Stars (AA)", "#444", None),
    "SE1": ("St. Paul White Caps", "#444", None),
    "TL1": ("Toledo Blue Stockings", "#444", None),
    "TL2": ("Toledo Maumees", "#444", None),
    "WIL": ("Wilmington Quicksteps", "#444", None),
    "WS6": ("Washington Statesmen", "#444", None),
    "WS7": ("Washington Senators (1891)", "#444", None),
    "WS8": ("Washington Senators (AA)", "#444", None),
    "WOR": ("Worcester Ruby Legs", "#444", None),
}

# ─── NHL ────────────────────────────────────────────────────────────────────
# hockey-reference normalizes to "BOSTONBRUINS" via norm() — uppercase + no spaces.
NHL = {
    "ANAHEIMDUCKS": ("Anaheim Ducks", "#F47A38", "ana"),
    "ARIZONACOYOTES": ("Arizona Coyotes", "#8C2633", "ari"),
    "BOSTONBRUINS": ("Boston Bruins", "#FFB81C", "bos"),
    "BUFFALOSABRES": ("Buffalo Sabres", "#002654", "buf"),
    "CALGARYFLAMES": ("Calgary Flames", "#C8102E", "cgy"),
    "CAROLINAHURRICANES": ("Carolina Hurricanes", "#CC0000", "car"),
    "CHICAGOBLACKHAWKS": ("Chicago Blackhawks", "#CF0A2C", "chi"),
    "COLORADOAVALANCHE": ("Colorado Avalanche", "#6F263D", "col"),
    "COLUMBUSBLUEJACKETS": ("Columbus Blue Jackets", "#002654", "cbj"),
    "DALLASSTARS": ("Dallas Stars", "#006847", "dal"),
    "DETROITREDWINGS": ("Detroit Red Wings", "#CE1126", "det"),
    "EDMONTONOILERS": ("Edmonton Oilers", "#041E42", "edm"),
    "FLORIDAPANTHERS": ("Florida Panthers", "#041E42", "fla"),
    "LOSANGELESKINGS": ("Los Angeles Kings", "#111111", "la"),
    "MINNESOTAWILD": ("Minnesota Wild", "#154734", "min"),
    "MONTREALCANADIENS": ("Montreal Canadiens", "#AF1E2D", "mtl"),
    "NASHVILLEPREDATORS": ("Nashville Predators", "#FFB81C", "nsh"),
    "NEWJERSEYDEVILS": ("New Jersey Devils", "#CE1126", "nj"),
    "NEWYORKISLANDERS": ("New York Islanders", "#00539B", "nyi"),
    "NEWYORKRANGERS": ("New York Rangers", "#0038A8", "nyr"),
    "OTTAWASENATORS": ("Ottawa Senators", "#C52032", "ott"),
    "PHILADELPHIAFLYERS": ("Philadelphia Flyers", "#F74902", "phi"),
    "PITTSBURGHPENGUINS": ("Pittsburgh Penguins", "#FCB514", "pit"),
    "SANJOSESHARKS": ("San Jose Sharks", "#006D75", "sj"),
    "SEATTLEKRAKEN": ("Seattle Kraken", "#001628", "sea"),
    "STLOUISBLUES": ("St. Louis Blues", "#002F87", "stl"),
    "TAMPABAYLIGHTNING": ("Tampa Bay Lightning", "#002868", "tb"),
    "TORONTOMAPLELEAFS": ("Toronto Maple Leafs", "#00205B", "tor"),
    "UTAHHOCKEYCLUB": ("Utah Hockey Club", "#71AFE5", "utah"),
    "UTAHMAMMOTH": ("Utah Mammoth", "#71AFE5", "utah"),
    "VANCOUVERCANUCKS": ("Vancouver Canucks", "#00205B", "van"),
    "VEGASGOLDENKNIGHTS": ("Vegas Golden Knights", "#B4975A", "vgk"),
    "WASHINGTONCAPITALS": ("Washington Capitals", "#041E42", "wsh"),
    "WINNIPEGJETS": ("Winnipeg Jets", "#041E42", "wpg"),
    # Famous defunct / former names
    "MONTREALWANDERERS": ("Montreal Wanderers", "#444", None),
    "OTTAWASENATORS(ORIGINAL)": ("Ottawa Senators (original)", "#444", None),
    "TORONTOARENAS": ("Toronto Arenas", "#444", None),
    "TORONTOST.PATRICKS": ("Toronto St. Patricks", "#444", None),
    "QUEBECBULLDOGS": ("Quebec Bulldogs", "#444", None),
    "QUEBECATHLETICCLUB/BULLDOGS": ("Quebec Athletic Club / Bulldogs", "#444", None),
    "HAMILTONTIGERS": ("Hamilton Tigers", "#444", None),
    "PITTSBURGHPIRATES": ("Pittsburgh Pirates (NHL)", "#444", None),
    "PHILADELPHIAQUAKERS": ("Philadelphia Quakers", "#444", None),
    "NEWYORKAMERICANS": ("New York Americans", "#444", None),
    "MONTREALMAROONS": ("Montreal Maroons", "#444", None),
    "STLOUISEAGLES": ("St. Louis Eagles", "#444", None),
    "OTTAWASENATORS(1917-1934)": ("Ottawa Senators (1917-1934)", "#444", None),
    "CLEVELANDBARONS": ("Cleveland Barons", "#444", None),
    "CALIFORNIAGOLDENSEALS": ("California Golden Seals", "#444", None),
    "OAKLANDSEALS": ("Oakland Seals", "#444", None),
    "KANSASCITYSCOUTS": ("Kansas City Scouts", "#444", None),
    "COLORADOROCKIES": ("Colorado Rockies (NHL)", "#444", None),
    "ATLANTAFLAMES": ("Atlanta Flames", "#444", None),
    "ATLANTATHRASHERS": ("Atlanta Thrashers", "#444", None),
    "MINNESOTANORTHSTARS": ("Minnesota North Stars", "#444", None),
    "QUEBECNORDIQUES": ("Quebec Nordiques", "#444", None),
    "WINNIPEGJETS(ORIGINAL)": ("Winnipeg Jets (original)", "#444", None),
    "HARTFORDWHALERS": ("Hartford Whalers", "#444", None),
    "PHOENIXCOYOTES": ("Phoenix Coyotes", "#444", None),
    "MIGHTYDUCKSOFANAHEIM": ("Mighty Ducks of Anaheim", "#444", None),
}

# ─── EPL ────────────────────────────────────────────────────────────────────
# BDL EPL uses team short_name / abbreviation — usually 3-letter codes.
# Logo IDs are ESPN's numeric soccer team IDs (used at
# https://a.espncdn.com/i/teamlogos/soccer/500/<id>.png).
EPL = {
    "ARS": ("Arsenal", "#EF0107", "359"),
    "AVL": ("Aston Villa", "#670E36", "362"),
    "BOU": ("Bournemouth", "#DA291C", "349"),
    "BRE": ("Brentford", "#E30613", "337"),
    "BHA": ("Brighton & Hove Albion", "#0057B8", "331"),
    "BUR": ("Burnley", "#6C1D45", "379"),
    "CHE": ("Chelsea", "#034694", "363"),
    "CRY": ("Crystal Palace", "#1B458F", "384"),
    "EVE": ("Everton", "#003399", "368"),
    "FUL": ("Fulham", "#000000", "370"),
    "IPS": ("Ipswich Town", "#3066BE", "373"),
    "LEE": ("Leeds United", "#1D428A", "357"),
    "LEI": ("Leicester City", "#003090", "375"),
    "LIV": ("Liverpool", "#C8102E", "364"),
    "LUT": ("Luton Town", "#F78F1E", "301"),
    "MCI": ("Manchester City", "#6CABDD", "382"),
    "MNC": ("Manchester City", "#6CABDD", "382"),
    "MUN": ("Manchester United", "#DA291C", "360"),
    "MAN": ("Manchester United", "#DA291C", "360"),
    "NEW": ("Newcastle United", "#241F20", "361"),
    "NOR": ("Norwich City", "#FFF200", "381"),
    "NFO": ("Nottingham Forest", "#DD0000", "393"),
    "SHU": ("Sheffield United", "#EE2737", "398"),
    "SOU": ("Southampton", "#D71920", "376"),
    "TOT": ("Tottenham Hotspur", "#132257", "367"),
    "WAT": ("Watford", "#FBEE23", "395"),
    "WHU": ("West Ham United", "#7A263A", "371"),
    "WBA": ("West Bromwich Albion", "#122F67", "383"),
    "WOL": ("Wolverhampton Wanderers", "#FDB913", "380"),
    # Common BDL norm() outputs (no abbreviation)
    "ARSENAL": ("Arsenal", "#EF0107", "359"),
    "ASTONVILLA": ("Aston Villa", "#670E36", "362"),
    "BOURNEMOUTH": ("Bournemouth", "#DA291C", "349"),
    "BRENTFORD": ("Brentford", "#E30613", "337"),
    "BRIGHTONANDHOVEALBION": ("Brighton & Hove Albion", "#0057B8", "331"),
    "BRIGHTON": ("Brighton & Hove Albion", "#0057B8", "331"),
    "BURNLEY": ("Burnley", "#6C1D45", "379"),
    "CHELSEA": ("Chelsea", "#034694", "363"),
    "CRYSTALPALACE": ("Crystal Palace", "#1B458F", "384"),
    "EVERTON": ("Everton", "#003399", "368"),
    "FULHAM": ("Fulham", "#000000", "370"),
    "IPSWICHTOWN": ("Ipswich Town", "#3066BE", "373"),
    "IPSWICH": ("Ipswich Town", "#3066BE", "373"),
    "LEEDSUNITED": ("Leeds United", "#1D428A", "357"),
    "LEEDS": ("Leeds United", "#1D428A", "357"),
    "LEICESTERCITY": ("Leicester City", "#003090", "375"),
    "LEICESTER": ("Leicester City", "#003090", "375"),
    "LIVERPOOL": ("Liverpool", "#C8102E", "364"),
    "LUTONTOWN": ("Luton Town", "#F78F1E", "301"),
    "LUTON": ("Luton Town", "#F78F1E", "301"),
    "MANCHESTERCITY": ("Manchester City", "#6CABDD", "382"),
    "MANCITY": ("Manchester City", "#6CABDD", "382"),
    "MANCHESTERUNITED": ("Manchester United", "#DA291C", "360"),
    "MANUNITED": ("Manchester United", "#DA291C", "360"),
    "NEWCASTLEUNITED": ("Newcastle United", "#241F20", "361"),
    "NEWCASTLE": ("Newcastle United", "#241F20", "361"),
    "NORWICHCITY": ("Norwich City", "#FFF200", "381"),
    "NORWICH": ("Norwich City", "#FFF200", "381"),
    "NOTTINGHAMFOREST": ("Nottingham Forest", "#DD0000", "393"),
    "SHEFFIELDUNITED": ("Sheffield United", "#EE2737", "398"),
    "SOUTHAMPTON": ("Southampton", "#D71920", "376"),
    "TOTTENHAMHOTSPUR": ("Tottenham Hotspur", "#132257", "367"),
    "TOTTENHAM": ("Tottenham Hotspur", "#132257", "367"),
    "WATFORD": ("Watford", "#FBEE23", "395"),
    "WESTHAMUNITED": ("West Ham United", "#7A263A", "371"),
    "WESTHAM": ("West Ham United", "#7A263A", "371"),
    "WESTBROMWICHALBION": ("West Bromwich Albion", "#122F67", "383"),
    "WOLVERHAMPTONWANDERERS": ("Wolverhampton Wanderers", "#FDB913", "380"),
    "WOLVES": ("Wolverhampton Wanderers", "#FDB913", "380"),
    # Historical relegated
    "WIMBLEDON": ("Wimbledon", "#444", None),
    "BLACKBURNROVERS": ("Blackburn Rovers", "#003088", "365"),
    "BLACKBURN": ("Blackburn Rovers", "#003088", "365"),
    "QUEENSPARKRANGERS": ("Queens Park Rangers", "#1D5BA4", "374"),
    "SUNDERLAND": ("Sunderland", "#EB172B", "366"),
    "MIDDLESBROUGH": ("Middlesbrough", "#E11B22", "369"),
    "PORTSMOUTH": ("Portsmouth", "#001489", "372"),
    "DERBYCOUNTY": ("Derby County", "#000000", "374"),
    "DERBY": ("Derby County", "#000000", "374"),
    "OLDHAMATHLETIC": ("Oldham Athletic", "#444", None),
    "COVENTRYCITY": ("Coventry City", "#87CEEB", "377"),
    "COVENTRY": ("Coventry City", "#87CEEB", "377"),
    "SHEFFIELDWEDNESDAY": ("Sheffield Wednesday", "#003090", "378"),
    "STOKECITY": ("Stoke City", "#E03A3E", "336"),
    "STOKE": ("Stoke City", "#E03A3E", "336"),
    "HULLCITY": ("Hull City", "#F18A01", "385"),
    "HULL": ("Hull City", "#F18A01", "385"),
    "CARDIFFCITY": ("Cardiff City", "#0070B5", "347"),
    "CARDIFF": ("Cardiff City", "#0070B5", "347"),
    "SWANSEACITY": ("Swansea City", "#000000", "318"),
    "SWANSEA": ("Swansea City", "#000000", "318"),
    "WIGANATHLETIC": ("Wigan Athletic", "#1D59AF", "388"),
    "WIGAN": ("Wigan Athletic", "#1D59AF", "388"),
    "BIRMINGHAMCITY": ("Birmingham City", "#0000A0", "335"),
    "BIRMINGHAM": ("Birmingham City", "#0000A0", "335"),
    "BOLTONWANDERERS": ("Bolton Wanderers", "#263C7E", "386"),
    "BOLTON": ("Bolton Wanderers", "#263C7E", "386"),
    "READING": ("Reading", "#004494", "391"),
    "CHARLTONATHLETIC": ("Charlton Athletic", "#E31B23", "387"),
    "CHARLTON": ("Charlton Athletic", "#E31B23", "387"),
    "BARNSLEY": ("Barnsley", "#E2231B", "390"),
    "BLACKPOOL": ("Blackpool", "#F68712", "396"),
    "BRADFORDCITY": ("Bradford City", "#444", None),
    "HUDDERSFIELDTOWN": ("Huddersfield Town", "#0E63AD", "335"),
    "HUDDERSFIELD": ("Huddersfield Town", "#0E63AD", "335"),
}

# ─── CFB ────────────────────────────────────────────────────────────────────
# CFBD uses full team names; norm() → "NOTREDAME". Logo IDs are ESPN team IDs.
# Source: https://a.espncdn.com/i/teamlogos/ncaa/500/{id}.png — these are the
# numeric IDs ESPN uses internally.
CFB = {
    "ALABAMA":            ("Alabama Crimson Tide", "#9E1B32", "333"),
    "AUBURN":             ("Auburn Tigers", "#0C2340", "2"),
    "GEORGIA":            ("Georgia Bulldogs", "#BA0C2F", "61"),
    "FLORIDA":            ("Florida Gators", "#0021A5", "57"),
    "TENNESSEE":          ("Tennessee Volunteers", "#FF8200", "2633"),
    "KENTUCKY":           ("Kentucky Wildcats", "#0033A0", "96"),
    "VANDERBILT":         ("Vanderbilt Commodores", "#000000", "238"),
    "MISSISSIPPI":        ("Ole Miss Rebels", "#CE1126", "145"),
    "MISSISSIPPISTATE":   ("Mississippi State Bulldogs", "#660000", "344"),
    "LSU":                ("LSU Tigers", "#461D7C", "99"),
    "ARKANSAS":           ("Arkansas Razorbacks", "#9D2235", "8"),
    "TEXASAANDM":         ("Texas A&M Aggies", "#500000", "245"),
    "TEXASA&M":           ("Texas A&M Aggies", "#500000", "245"),
    "SOUTHCAROLINA":      ("South Carolina Gamecocks", "#73000A", "2579"),
    "MISSOURI":           ("Missouri Tigers", "#000000", "142"),
    "OKLAHOMA":           ("Oklahoma Sooners", "#841617", "201"),
    "TEXAS":              ("Texas Longhorns", "#BF5700", "251"),
    "OHIOSTATE":          ("Ohio State Buckeyes", "#BB0000", "194"),
    "MICHIGAN":           ("Michigan Wolverines", "#00274C", "130"),
    "MICHIGANSTATE":      ("Michigan State Spartans", "#18453B", "127"),
    "PENNSTATE":          ("Penn State Nittany Lions", "#041E42", "213"),
    "WISCONSIN":          ("Wisconsin Badgers", "#C5050C", "275"),
    "IOWA":               ("Iowa Hawkeyes", "#000000", "2294"),
    "MINNESOTA":          ("Minnesota Golden Gophers", "#7A0019", "135"),
    "NEBRASKA":           ("Nebraska Cornhuskers", "#E41C38", "158"),
    "ILLINOIS":           ("Illinois Fighting Illini", "#13294B", "356"),
    "INDIANA":            ("Indiana Hoosiers", "#990000", "84"),
    "NORTHWESTERN":       ("Northwestern Wildcats", "#4E2A84", "77"),
    "PURDUE":             ("Purdue Boilermakers", "#CEB888", "2509"),
    "MARYLAND":           ("Maryland Terrapins", "#E03A3E", "120"),
    "RUTGERS":            ("Rutgers Scarlet Knights", "#CC0033", "164"),
    "OREGON":             ("Oregon Ducks", "#154733", "2483"),
    "WASHINGTON":         ("Washington Huskies", "#4B2E83", "264"),
    "USC":                ("USC Trojans", "#990000", "30"),
    "UCLA":               ("UCLA Bruins", "#2D68C4", "26"),
    "CLEMSON":            ("Clemson Tigers", "#F66733", "228"),
    "FLORIDASTATE":       ("Florida State Seminoles", "#782F40", "52"),
    "MIAMI":              ("Miami Hurricanes", "#F47321", "2390"),
    "VIRGINIATECH":       ("Virginia Tech Hokies", "#630031", "259"),
    "VIRGINIA":           ("Virginia Cavaliers", "#232D4B", "258"),
    "NORTHCAROLINA":      ("North Carolina Tar Heels", "#13294B", "153"),
    "DUKE":               ("Duke Blue Devils", "#003087", "150"),
    "NCSTATE":            ("NC State Wolfpack", "#CC0000", "152"),
    "WAKEFOREST":         ("Wake Forest Demon Deacons", "#9E7E38", "154"),
    "BOSTONCOLLEGE":      ("Boston College Eagles", "#8B0000", "103"),
    "SYRACUSE":           ("Syracuse Orange", "#F76900", "183"),
    "PITTSBURGH":         ("Pittsburgh Panthers", "#003594", "221"),
    "LOUISVILLE":         ("Louisville Cardinals", "#AD0000", "97"),
    "GEORGIATECH":        ("Georgia Tech Yellow Jackets", "#B3A369", "59"),
    "NOTREDAME":          ("Notre Dame Fighting Irish", "#0C2340", "87"),
    "STANFORD":           ("Stanford Cardinal", "#8C1515", "24"),
    "CALIFORNIA":         ("California Golden Bears", "#003262", "25"),
    "ARIZONA":            ("Arizona Wildcats", "#CC0033", "12"),
    "ARIZONASTATE":       ("Arizona State Sun Devils", "#8C1D40", "9"),
    "UTAH":               ("Utah Utes", "#CC0000", "254"),
    "COLORADO":           ("Colorado Buffaloes", "#CFB87C", "38"),
    "WASHINGTONSTATE":    ("Washington State Cougars", "#981E32", "265"),
    "OREGONSTATE":        ("Oregon State Beavers", "#DC4405", "204"),
    "OKLAHOMASTATE":      ("Oklahoma State Cowboys", "#FF7300", "197"),
    "KANSAS":             ("Kansas Jayhawks", "#0051BA", "2305"),
    "KANSASSTATE":        ("Kansas State Wildcats", "#512888", "2306"),
    "IOWASTATE":          ("Iowa State Cyclones", "#C8102E", "66"),
    "TEXASTECH":          ("Texas Tech Red Raiders", "#CC0000", "2641"),
    "TCU":                ("TCU Horned Frogs", "#4D1979", "2628"),
    "BAYLOR":             ("Baylor Bears", "#003015", "239"),
    "WESTVIRGINIA":       ("West Virginia Mountaineers", "#002855", "277"),
    "BYU":                ("BYU Cougars", "#002E5D", "252"),
    "HOUSTON":            ("Houston Cougars", "#C8102E", "248"),
    "CINCINNATI":         ("Cincinnati Bearcats", "#000000", "2132"),
    "UCF":                ("UCF Knights", "#000000", "2116"),
    # Independents / others
    "ARMY":               ("Army Black Knights", "#000000", "349"),
    "NAVY":               ("Navy Midshipmen", "#00205B", "2426"),
    "AIRFORCE":           ("Air Force Falcons", "#003087", "2005"),
    "PRINCETON":          ("Princeton Tigers", "#FF8F00", "163"),
    "HARVARD":            ("Harvard Crimson", "#A51C30", "108"),
    "YALE":               ("Yale Bulldogs", "#00356B", "43"),
    "PENN":               ("Penn Quakers", "#990000", "219"),
    "CORNELL":            ("Cornell Big Red", "#B31B1B", "172"),
    "COLUMBIA":           ("Columbia Lions", "#75AADB", "171"),
    "DARTMOUTH":          ("Dartmouth Big Green", "#00693E", "159"),
    "BROWN":              ("Brown Bears", "#4E3629", "225"),
}

BOXHW = {
    # Fighter codes from seed_boxing.py → (display name, accent color, Wikipedia page title)
    # The Wikipedia title is used at seed time to fetch a portrait via the
    # REST summary API; the resulting CDN URL is stored as the logo.
    "SULLIVAN":        ("John L. Sullivan", "#8B0000", "John L. Sullivan"),
    "CORBETT":         ("James J. Corbett", "#444", "James J. Corbett"),
    "FITZSIMMONS":     ("Bob Fitzsimmons", "#444", "Bob Fitzsimmons"),
    "JEFFRIES":        ("James J. Jeffries", "#444", "James J. Jeffries"),
    "BURNS":           ("Tommy Burns", "#444", "Tommy Burns (boxer)"),
    "JOHNSON":         ("Jack Johnson", "#222", "Jack Johnson (boxer)"),
    "WILLARD":         ("Jess Willard", "#444", "Jess Willard"),
    "DEMPSEY":         ("Jack Dempsey", "#8B0000", "Jack Dempsey"),
    "TUNNEY":          ("Gene Tunney", "#444", "Gene Tunney"),
    "SCHMELING":       ("Max Schmeling", "#000", "Max Schmeling"),
    "SHARKEY":         ("Jack Sharkey", "#444", "Jack Sharkey"),
    "CARNERA":         ("Primo Carnera", "#444", "Primo Carnera"),
    "BAER":            ("Max Baer", "#444", "Max Baer"),
    "BRADDOCK":        ("James J. Braddock", "#444", "James J. Braddock"),
    "JOELOUIS":        ("Joe Louis", "#8B0000", "Joe Louis"),
    "CHARLES":         ("Ezzard Charles", "#444", "Ezzard Charles"),
    "WALCOTT":         ("Jersey Joe Walcott", "#444", "Jersey Joe Walcott"),
    "MARCIANO":        ("Rocky Marciano", "#8B0000", "Rocky Marciano"),
    "PATTERSON":       ("Floyd Patterson", "#444", "Floyd Patterson"),
    "JOHANSSON":       ("Ingemar Johansson", "#005BBB", "Ingemar Johansson"),
    "LISTON":          ("Sonny Liston", "#444", "Sonny Liston"),
    "MUHAMMADALI":     ("Muhammad Ali", "#B8860B", "Muhammad Ali"),
    "FRAZIER":         ("Joe Frazier", "#444", "Joe Frazier"),
    "FOREMAN":         ("George Foreman", "#8B0000", "George Foreman"),
    "SPINKSLEON":      ("Leon Spinks", "#444", "Leon Spinks"),
    "HOLMES":          ("Larry Holmes", "#444", "Larry Holmes"),
    "SPINKSMICHAEL":   ("Michael Spinks", "#444", "Michael Spinks"),
    "TYSON":           ("Mike Tyson", "#000", "Mike Tyson"),
    "DOUGLAS":         ('James "Buster" Douglas', "#444", "Buster Douglas"),
    "HOLYFIELD":       ("Evander Holyfield", "#8B0000", "Evander Holyfield"),
    "BOWE":            ("Riddick Bowe", "#444", "Riddick Bowe"),
    "MOORER":          ("Michael Moorer", "#444", "Michael Moorer"),
    "BRIGGS":          ("Shannon Briggs", "#444", "Shannon Briggs"),
    "LEWIS":           ("Lennox Lewis", "#006B3C", "Lennox Lewis"),
    "RAHMAN":          ("Hasim Rahman", "#444", "Hasim Rahman"),
    "KLITSCHKOWLAD":   ("Wladimir Klitschko", "#005BBB", "Wladimir Klitschko"),
    "FURY":            ("Tyson Fury", "#006B3C", "Tyson Fury"),
    "USYK":            ("Oleksandr Usyk", "#FFD500", "Oleksandr Usyk"),
}

BOXLHW = {
    # Light heavyweight champions (1903–present). Wikipedia titles for portrait fetch.
    "ROOT":           ("Jack Root", "#444", "Jack Root"),
    "GARDNER":        ("George Gardner", "#444", "George Gardner (boxer)"),
    "FITZSIMMONSBOB": ("Bob Fitzsimmons", "#444", "Bob Fitzsimmons"),
    "OBRIENJACK":     ("Philadelphia Jack O'Brien", "#444", "Jack O'Brien (boxer)"),
    "LEVINSKY":       ("Battling Levinsky", "#444", "Battling Levinsky"),
    "CARPENTIER":     ("Georges Carpentier", "#0055A4", "Georges Carpentier"),  # French
    "SIKI":           ("Battling Siki", "#444", "Battling Siki"),
    "MCTIGUE":        ("Mike McTigue", "#009B48", "Mike McTigue"),  # Irish
    "BERLENBACH":     ("Paul Berlenbach", "#444", "Paul Berlenbach"),
    "DELANEY":        ("Jack Delaney", "#444", "Jack Delaney (boxer)"),
    "LOUGHRAN":       ("Tommy Loughran", "#444", "Tommy Loughran"),
    "ROSENBLOOM":     ("Maxie Rosenbloom", "#444", "Maxie Rosenbloom"),
    "OLIN":           ("Bob Olin", "#444", "Bob Olin"),
    "LEWISJOHNHENRY": ("John Henry Lewis", "#222", "John Henry Lewis"),
    "BETTINA":        ("Melio Bettina", "#444", "Melio Bettina"),
    "CONN":           ("Billy Conn", "#444", "Billy Conn"),
    "LESNEVICH":      ("Gus Lesnevich", "#444", "Gus Lesnevich"),
    "MILLS":          ("Freddie Mills", "#006B3C", "Freddie Mills"),  # British
    "MAXIM":          ("Joey Maxim", "#444", "Joey Maxim"),
    "MOORE":          ("Archie Moore", "#8B0000", "Archie Moore"),
    "JOHNSONHAROLD":  ("Harold Johnson", "#444", "Harold Johnson (boxer)"),
    "PASTRANO":       ("Willie Pastrano", "#444", "Willie Pastrano"),
    "TORRES":         ("José Torres", "#FCD116", "José Torres (boxer)"),  # PR
    "TIGER":          ("Dick Tiger", "#008751", "Dick Tiger"),  # Nigerian
    "FOSTER":         ("Bob Foster", "#8B0000", "Bob Foster (boxer)"),
    "CONTEH":         ("John Conteh", "#006B3C", "John Conteh"),
    "PARLOV":         ("Mate Parlov", "#171796", "Mate Parlov"),  # Yugoslav blue
    "JOHNSONMARVIN":  ("Marvin Johnson", "#444", "Marvin Johnson (boxer)"),
    "SAADMUHAMMAD":   ("Matthew Saad Muhammad", "#8B0000", "Matthew Saad Muhammad"),
    "QAWI":           ("Dwight Muhammad Qawi", "#444", "Dwight Muhammad Qawi"),
    # SPINKSMICHAEL — already in BOXHW dict (he also held HW lineal title later)
    "ROYJONESJR":     ("Roy Jones Jr.", "#B8860B", "Roy Jones Jr."),
    "TARVER":         ("Antonio Tarver", "#444", "Antonio Tarver"),
    "JOHNSONGLEN":    ("Glen Johnson", "#444", "Glen Johnson (boxer)"),
    "HOPKINS":        ("Bernard Hopkins", "#000", "Bernard Hopkins"),
    "CALZAGHE":       ("Joe Calzaghe", "#D52B1E", "Joe Calzaghe"),  # Welsh red
    "DAWSON":         ("Chad Dawson", "#444", "Chad Dawson"),
    "STEVENSON":      ("Adonis Stevenson", "#FF0000", "Adonis Stevenson"),  # Haiti red
    "GVOZDYK":        ("Oleksandr Gvozdyk", "#005BBB", "Oleksandr Gvozdyk"),  # Ukrainian
    "BETERBIEV":      ("Artur Beterbiev", "#444", "Artur Beterbiev"),
    "BIVOL":          ("Dmitry Bivol", "#444", "Dmitry Bivol"),
}

TABLES = {
    "NBA":    (NBA, "nba"),
    "NFL":    (NFL, "nfl"),
    "MLB":    (MLB, "mlb"),
    "NHL":    (NHL, "nhl"),
    "EPL":    (EPL, None),  # ESPN soccer uses different slug shape, handled below
    "CFB":    (CFB, "ncaa"),
    "BOXHW":  (BOXHW, None),  # No logo CDN for boxers; uses Wikipedia portraits.
    "BOXLHW": (BOXLHW, None),
}


def prettify(code: str) -> str:
    # NOTREDAME → "Notre Dame"; LEEDSUNITED → "Leeds United"
    if not any(c.islower() for c in code) and any(c.isalpha() for c in code):
        # Title-case but try to split camel boundaries for human readability.
        # We don't have camel info, so just title-case as one word group.
        return code.title().replace("And", "&")
    return code


_WIKI_CACHE: dict[str, str] = {}

def wiki_portrait(title: str) -> Optional[str]:
    """Return a stable CDN URL for the Wikipedia article's lead image, or None.

    Uses the MediaWiki Action API with prop=pageimages which (unlike the REST
    summary endpoint) returns thumbnails even when the page's lead image is
    licensed under fair use — covering most pre-1970s boxer photos.
    """
    if not title:
        return None
    if title in _WIKI_CACHE:
        return _WIKI_CACHE[title] or None
    try:
        r = requests.get(
            "https://en.wikipedia.org/w/api.php",
            params={
                "action": "query",
                "format": "json",
                "prop": "pageimages",
                "piprop": "thumbnail|original",
                "pithumbsize": "400",
                "redirects": "1",
                "titles": title,
            },
            headers={"User-Agent": "linealchamp-seed/1.0"},
            timeout=15,
        )
        if r.status_code != 200:
            _WIKI_CACHE[title] = ""
            return None
        j = r.json()
        pages = ((j.get("query") or {}).get("pages") or {})
        for _pid, page in pages.items():
            src = (page.get("thumbnail") or {}).get("source") or (page.get("original") or {}).get("source")
            if src:
                _WIKI_CACHE[title] = src
                return src
        _WIKI_CACHE[title] = ""
        return None
    except Exception:
        _WIKI_CACHE[title] = ""
        return None


def logo_for(sport: str, league: str, slug) -> Optional[str]:
    if not slug:
        return None
    if league.startswith("BOX"):
        # slug is a Wikipedia page title for boxers; resolve to portrait URL.
        return wiki_portrait(slug)
    if league == "EPL":
        # ESPN soccer: https://a.espncdn.com/i/teamlogos/soccer/500/<slug>.png
        return f"https://a.espncdn.com/i/teamlogos/soccer/500/{slug}.png"
    return ESPN.format(sport=sport, slug=slug)


def collect_codes(league: str) -> set[str]:
    f = OUTPUT_DIR / f"lineage-{league}.json"
    if not f.exists():
        return set()
    data = json.loads(f.read_text(encoding="utf-8"))
    codes: set[str] = set()
    for c in data.get("changes", []):
        for k in ("from", "to"):
            v = c.get(k)
            if v:
                codes.add(v)
    return codes


def build_brand(league: str, code: str) -> dict:
    table, sport = TABLES[league]
    entry = table.get(code)
    if entry:
        name, color, slug = entry
        return {
            "league": league,
            "code": code,
            "name": name,
            "color": color,
            "logo": logo_for(sport, league, slug) or "",
        }
    return {
        "league": league,
        "code": code,
        "name": prettify(code),
        "color": "#555",
        "logo": "",
    }


def post(brand: dict, admin_secret: str) -> str:
    r = requests.post(
        f"{WORKER_URL}/admin/brand/set",
        json=brand,
        headers={"x-admin-secret": admin_secret, "content-type": "application/json"},
        timeout=20,
    )
    return f"{r.status_code} {r.text[:120]}"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true", help="Print brands, don't POST")
    p.add_argument("--leagues", default="NBA,NFL,MLB,NHL,EPL,CFB,BOXHW,BOXLHW")
    args = p.parse_args()

    leagues = [L.strip().upper() for L in args.leagues.split(",") if L.strip()]
    secret = os.environ.get("ADMIN_SECRET")
    if not args.dry_run and not secret:
        print("ADMIN_SECRET env var required (or use --dry-run)", file=sys.stderr)
        return 2

    total = 0
    unmapped: list[tuple[str, str]] = []
    for L in leagues:
        codes = sorted(collect_codes(L))
        if not codes:
            print(f"  {L}: no output file or empty")
            continue
        table = TABLES[L][0]
        print(f"\n=== {L} ({len(codes)} codes) ===")
        for code in codes:
            brand = build_brand(L, code)
            if code not in table:
                unmapped.append((L, code))
            total += 1
            if args.dry_run:
                print(f"  {code:30s}  {brand['name']:40s}  logo={'yes' if brand['logo'] else 'no'}")
            else:
                result = post(brand, secret)
                ok = result.startswith("200")
                mark = "✓" if ok else "✗"
                print(f"  {mark} {code:30s}  {brand['name']:40s}  [{result}]")
                time.sleep(0.05)  # be gentle

    print(f"\nProcessed {total} brand entries across {len(leagues)} league(s).")
    if unmapped:
        print(f"  {len(unmapped)} codes used the prettify-fallback (no logo). Add to TABLES if you want logos:")
        for L, c in unmapped[:40]:
            print(f"    {L:4} {c}")
        if len(unmapped) > 40:
            print(f"    ... and {len(unmapped)-40} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())
