# Boxing lineage curation notes

Six divisions were added to complete the classic eight (Heavyweight and
Light Heavyweight were already curated in an earlier session):
Middleweight, Welterweight, Lightweight, Featherweight, Bantamweight,
Flyweight.

## Methodology

Each chain follows the **Ring-magazine / lineal tradition**: the belt only
moves when the champion loses in the ring. When a champion retired, died,
or permanently outgrew the division, the chain records a **reconstruction
point** — an entry with `"from": null` and a `note` explaining how
recognition was re-established (vacant-title fight, unification, or
consensus). These are exactly the points the site's "What if?" feature can
challenge.

Five of the six chains currently end **VACANT**, which is the honest lineal
reading: Álvarez (MW), Crawford (WW), Haney (LW), Santa Cruz (FW), and
Inoue (BW) all left their divisions as champions rather than losing, and
Chocolatito did the same at flyweight in 2016. The site renders these with
a "Lineal Title Vacant" hero rather than pretending someone holds the belt.
If you'd rather adopt the looser "Ring championship policy" (crown the top
two ranked fighters' winner after a vacancy), say so and the tails can be
extended to name current champions.

## Verification status — READ THIS

These chains were drafted from historical knowledge, **not scraped from a
database**, with a knowledge cutoff of January 2026. The championship
spine of each division (the famous reigns) is solid, but before trusting
them fully:

1. **Spot-check dates and methods** against BoxRec/Wikipedia for a handful
   of transfers per division, the way `VERIFICATION.md` did for HW/LHW.
2. **Low-confidence stretches**, where sources genuinely disagree and the
   chain uses a coarse reconstruction:
   - MW 1931–1941 (Walker's vacancy through Zale's unification)
   - WW 1907–1915 (Sullivan's vacancy to the Britton–Lewis era)
   - LW 1979–2008 (post-Durán: Argüello/Whitaker/Pacquiao anchor points)
   - FW 1926–1937 and 1974–1997 (splintered-title eras)
   - BW 1900–1914 and 1988–2019 (long consensus gaps)
   - FLW 1925–1935 and 1971–1975 (post-Villa chaos; WBC/WBA split)
3. **Anything after Jan 2026** (e.g. a 2026 title change) is absent — add
   it here and re-run the upload.

## Updating

Edit the JSON, then either push to `main` (the upload-boxing workflow
ships it) or run locally:

    ADMIN_SECRET=... python boxing/upload_boxing.py --leagues BOXMW
