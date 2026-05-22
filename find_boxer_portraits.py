#!/usr/bin/env python3
"""
find_boxer_portraits.py — query Wikipedia for actual canonical media URLs
for boxers whose Action API pageimages returned nothing.

Uses the REST media-list endpoint which returns ALL media on a page (including
fair-use lead images that the pageimages prop filters out). Picks the first
.jpg/.jpeg/.png that isn't an obvious icon/logo.

Run:  python find_boxer_portraits.py

Output: a dict you can paste into worker.js's STATIC_BRAND_PORTRAITS map.
"""

from __future__ import annotations
import json
import sys
import requests

# Boxer code → Wikipedia article title
TARGETS = {
    # BOXHW
    "MUHAMMADALI":    "Muhammad Ali",
    "LISTON":         "Sonny Liston",
    "JOELOUIS":       "Joe Louis",
    "MARCIANO":       "Rocky Marciano",
    "FOREMAN":        "George Foreman",
    "FRAZIER":        "Joe Frazier",
    "HOLYFIELD":      "Evander Holyfield",
    "HOLMES":         "Larry Holmes",
    "LEWIS":          "Lennox Lewis",
    "KLITSCHKOWLAD":  "Wladimir Klitschko",
    "FURY":           "Tyson Fury",
    "JOHANSSON":      "Ingemar Johansson",
    "PATTERSON":      "Floyd Patterson",
    "JOHNSON":        "Jack Johnson (boxer)",
    "JEFFRIES":       "James J. Jeffries",
    "FITZSIMMONS":    "Bob Fitzsimmons",
    "BURNS":          "Tommy Burns (boxer)",
    "SCHMELING":      "Max Schmeling",
    "SHARKEY":        "Jack Sharkey",
    "BAER":           "Max Baer",
    "RAHMAN":         "Hasim Rahman",
    "MOORER":         "Michael Moorer",
    # BOXLHW
    "ROOT":           "Jack Root",
    "GARDNER":        "George Gardner (boxer)",
    "OBRIENJACK":     "Jack O'Brien (boxer)",
    "LEVINSKY":       "Battling Levinsky",
    "CARPENTIER":     "Georges Carpentier",
    "SIKI":           "Battling Siki",
    "MCTIGUE":        "Mike McTigue",
    "BERLENBACH":     "Paul Berlenbach",
    "DELANEY":        "Jack Delaney (boxer)",
    "LOUGHRAN":       "Tommy Loughran",
    "ROSENBLOOM":     "Maxie Rosenbloom",
    "OLIN":           "Bob Olin",
    "LEWISJOHNHENRY": "John Henry Lewis",
    "BETTINA":        "Melio Bettina",
    "CONN":           "Billy Conn",
    "LESNEVICH":      "Gus Lesnevich",
    "MILLS":          "Freddie Mills",
    "MAXIM":          "Joey Maxim",
    "MOORE":          "Archie Moore",
    "JOHNSONHAROLD":  "Harold Johnson (boxer)",
    "PASTRANO":       "Willie Pastrano",
    "TORRES":         "José Torres (boxer)",
    "TIGER":          "Dick Tiger",
    "FOSTER":         "Bob Foster (boxer)",
    "CONTEH":         "John Conteh",
    "PARLOV":         "Mate Parlov",
    "JOHNSONMARVIN":  "Marvin Johnson (boxer)",
    "SAADMUHAMMAD":   "Matthew Saad Muhammad",
    "QAWI":           "Dwight Muhammad Qawi",
    "ROYJONESJR":     "Roy Jones Jr.",
    "TARVER":         "Antonio Tarver",
    "JOHNSONGLEN":    "Glen Johnson (boxer)",
    "HOPKINS":        "Bernard Hopkins",
    "CALZAGHE":       "Joe Calzaghe",
    "DAWSON":         "Chad Dawson",
    "STEVENSON":      "Adonis Stevenson",
    "GVOZDYK":        "Oleksandr Gvozdyk",
    "BETERBIEV":      "Artur Beterbiev",
    "BIVOL":          "Dmitry Bivol",
}

SKIP_FILE_PATTERNS = ("commons-logo", "wiki.png", "edit-icon", "signature",
                      "autograph", ".svg", ".ogg", ".webm", ".oga", ".ogv")


def find_portrait(title: str) -> str | None:
    url = "https://en.wikipedia.org/api/rest_v1/page/media-list/" + requests.utils.quote(title.replace(" ", "_"), safe="")
    try:
        r = requests.get(url, headers={"User-Agent": "linealchamp/1.0"}, timeout=15)
        if r.status_code != 200:
            return None
        j = r.json()
        # First pass: section 0 (the lead/infobox).
        # Second pass: anywhere on the page if no section-0 portrait exists.
        for required_section in (0, None):
            for item in j.get("items", []):
                if item.get("type") != "image":
                    continue
                if required_section is not None and item.get("section_id") != required_section:
                    continue
                title_lower = (item.get("title") or "").lower()
                if any(p in title_lower for p in SKIP_FILE_PATTERNS):
                    continue
                srcset = item.get("srcset") or []
                if not srcset:
                    continue
                best = srcset[-1].get("src") or srcset[0].get("src")
                if best and best.startswith("//"):
                    best = "https:" + best
                return best
        return None
    except Exception as e:
        print(f"  {title}: error {e}", file=sys.stderr)
        return None


def main() -> int:
    print("// Paste this map into worker.js (replaces STATIC_BRAND_PORTRAITS entries):\n")
    results: dict[str, str] = {}
    for code, title in TARGETS.items():
        u = find_portrait(title)
        if u:
            results[code] = u
            print(f"    {code+':':16s} '{u}',")
        else:
            print(f"    // {code}: no portrait found ({title})", file=sys.stderr)

    print(f"\n// Found portraits for {len(results)}/{len(TARGETS)} boxers", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
