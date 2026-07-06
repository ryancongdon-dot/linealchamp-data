# linealchamp-data

Offline backfill + nightly refresh tooling for the `linealchamp-api`
Cloudflare Worker.

Generates the complete lineal-champion history for six sports leagues
(NBA, NFL, MLB, NHL, EPL, CFB) and pushes it to the Worker's KV namespace.
No R2 / D1 / external storage required — KV alone is sufficient.

## Why this exists

The Worker itself can't walk 150+ years of game-by-game history — it would
blow through the 50-subrequest-per-invocation limit and the 25 MB KV value
cap. So we do the heavy lift here once, on a real machine with no platform
limits, and ship the result to the Worker as static data. The Worker only
ever has to handle "today's games for the current belt holder" going forward.

## Setup

```bash
git clone <this repo>
cd linealchamp-data
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Required env vars:

| var | used by | how to get |
| --- | --- | --- |
| `BDL_API_KEY` | NBA, EPL sources | https://app.balldontlie.io/ (same key the Worker uses) |
| `CFBD_API_KEY` | CFB source | https://collegefootballdata.com/key (free) |
| `ADMIN_SECRET` | upload_to_worker.py | the secret your Worker reads from `env.ADMIN_SECRET` |

NFL and NHL sources scrape pro-football-reference / hockey-reference. They
respect a 3-second crawl delay, so a full backfill takes a while:
- NFL (1920–today, ~105 years): ~5 min
- NHL (1917–today, ~108 years): ~5 min
- MLB (Retrosheet zip per year, 154 years): ~3 min
- NBA (BDL paginated, ~80 years): ~10 min on free tier
- EPL (BDL paginated, ~33 seasons): ~3 min
- CFB (CFBD paginated, 157 years): ~5 min

All sources cache their raw responses under `cache/<LEAGUE>/`, so re-runs
are nearly instant. A cached file is only reused when the season/window it
covers had already ended when it was fetched — still-open seasons are
refetched every run, so re-builds always pick up the latest games.

## Automated nightly refresh (GitHub Actions)

`.github/workflows/refresh-data.yml` rebuilds all six leagues every night at
09:17 UTC and uploads the results to the Worker's KV, so the site stays
current without anyone running scripts by hand. It can also be triggered
manually: repo → **Actions** → *Refresh lineal data* → **Run workflow**.

One-time setup — add three repository secrets under
**Settings → Secrets and variables → Actions → New repository secret**:

| secret | value |
| --- | --- |
| `BDL_API_KEY` | your balldontlie key (same one the Worker uses) |
| `CFBD_API_KEY` | your collegefootballdata.com key |
| `ADMIN_SECRET` | the Worker's `env.ADMIN_SECRET` |

## Usage

```bash
# Full backfill, all six leagues, as-of yesterday:
python build_lineage.py

# Just one league:
python build_lineage.py --leagues CFB --as-of 2026-05-17

# Probe a misbehaving source — dumps one game's parsed shape so you can
# see what came back from the upstream API:
python build_lineage.py --probe EPL --year 2023
```

Outputs land in `output/`:
- `lineage-<LEAGUE>.json` — small (belt changes only). Pushed to KV key
  `${league}:static`. Served by `GET /api/lineage`.
- `events-<LEAGUE>.json`  — larger but still well under KV's 25 MB cap
  (only games involving the holder are recorded, not every game ever played).
  Pushed to KV key `${league}:events`. Served by `GET /api/events`.

After `build_lineage.py` finishes, push everything to the Worker:

```bash
# Push lineage + events to Worker KV:
python upload_to_worker.py

# Or selectively:
python upload_to_worker.py --leagues NBA,NFL
python upload_to_worker.py --skip-events       # just changes
python upload_to_worker.py --only-events       # just full event logs
```

The Worker's `/admin/upload-lineage` and `/admin/upload-events` endpoints
accept the JSONs directly — auth via `x-admin-secret` header.

## Spot-checking the results

Before you trust the data, spot-check a few known belt changes against
Wikipedia or your sport of choice's reference site:

| league | known belt change | expected |
| --- | --- | --- |
| NBA | 2016-06-19, CLE over GSW (Finals Game 7) | `from: GSW, to: CLE` |
| NFL | 2024-02-11, KC over SF (Super Bowl LVIII) | `from: SF, to: KC` (if SF was holder) |
| MLB | 1986-10-27, NYM over BOS (WS Game 7) | `from: BOS, to: NYM` (if BOS was holder) |
| CFB | 2023-01-09, GA over TCU (CFP Championship) | `from: TCU, to: GA` (if TCU was holder) |

The lineal lineage is path-dependent, so the exact holder at any given
date depends on the chain of games before it. The script's job is to compute
that chain consistently — if a known belt change is missing, that points at
either a date/team-code mismatch in the source module or a wider data gap
worth investigating.

## When a source breaks

The most likely failures, in order of probability:

1. **EPL returns no games.** Probe the response shape:
   `python build_lineage.py --probe EPL --year 2023`. Then patch
   `sources/epl.py` to use the field names that actually showed up.
2. **NFL/NHL scrape returns no games.** Sports-Reference may have changed
   their HTML structure. The parsers look for `data-stat` attributes which
   are stable historically; check `sources/<league>.py` for the table id
   (`games`, `games_playoffs`) and re-test.
3. **MLB StatsAPI shape drift.** Seasons 2012+ (including the in-progress
   one, and all postseason games) come from the free statsapi.mlb.com
   schedule endpoint; Retrosheet only covers pre-2012 now. If StatsAPI
   changes shape, patch `sources/mlb.py::_statsapi_year`.
4. **CFB rate-limited.** CFBD's free tier limits monthly calls. If you hit
   it, drop `--as-of` to a single year and resume after the month rolls.

## KV size sanity check

KV caps a single value at 25 MB. Rough estimates of the largest league's
events payload (events only count games involving the current holder, not
every game ever played):

- MLB: ~25k events × 200 bytes ≈ 5 MB ✓
- NHL: ~9k × 200 ≈ 1.8 MB ✓
- NBA: ~8k × 200 ≈ 1.6 MB ✓
- NFL: ~2k × 200 ≈ 400 KB ✓
- EPL: ~1.3k × 200 ≈ 260 KB ✓
- CFB: ~2.5k × 200 ≈ 500 KB ✓

If a league's events ever crosses 24 MB, `upload_to_worker.py` will warn
and refuse to upload — at that point you'd shard by decade. We're nowhere
near that today.

## Files

```
linealchamp-data/
├── build_lineage.py      # orchestrator
├── lineage.py            # core algorithm (Python port of JS computeLineage)
├── sources/
│   ├── __init__.py
│   ├── nba.py
│   ├── nfl.py
│   ├── mlb.py
│   ├── nhl.py
│   ├── epl.py
│   └── cfb.py
├── upload_to_worker.py
├── requirements.txt
├── README.md
├── output/               (generated)
└── cache/                (generated, gitignored)
```
