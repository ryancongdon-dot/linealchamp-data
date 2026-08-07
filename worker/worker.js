/* eslint-disable no-empty */
/**
 * linealchamp-api — Cloudflare Worker
 *
 * Architecture:
 *   - Historic lineage (every belt change from each league's seed date to
 *     `asOfDate`) is computed OFFLINE by the linealchamp-data Python tooling
 *     and written into KV `${league}:static` via /admin/upload-lineage.
 *   - This Worker only handles "today's games" — fetching games involving the
 *     current belt holder and walking lineage forward from `asOfDate`.
 *   - Full event logs (every game involving the holder) live in KV
 *     `${league}:events`, fetched on demand via /api/events.
 *
 * Bindings expected:
 *   KV — KV namespace (existing LINEALCHAMP namespace).
 *
 * Env vars / secrets:
 *   ADMIN_SECRET    — guards /admin/* endpoints
 *   BDL_API_KEY     — balldontlie (NBA, NFL, EPL)
 *   CFBD_API_KEY    — collegefootballdata (CFB)
 *   GPT_ENABLED     — "true" to enable /api/gpt OpenAI fallback
 *   OPENAI_API_KEY  — OpenAI key when GPT_ENABLED
 *   ALLOW_ORIGIN    — CORS allow-origin (default "*")
 *   PAUSE_LEAGUES   — comma-separated league keys to skip in cron
 *   PAUSE_ALL       — "true" to skip cron entirely
 */

export default {
  async fetch(request, env, ctx) {
    primeEnv(env);
    const url = new URL(request.url);

    if (url.pathname === "/iphone-for-jared") {
      return Response.redirect("https://downthestreetpeople.com/jared/", 301);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const NO_STORE = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(PUBLIC_HTML, { headers: NO_STORE });
    }
    if (url.pathname === "/admin") {
      return new Response(ADMIN_HTML, { headers: NO_STORE });
    }

    // ─── Site icons (favicon + iOS tile) ──────────────────────────────
    if (url.pathname === "/apple-touch-icon.png" ||
        url.pathname === "/apple-touch-icon-precomposed.png") {
      return pngResponse(ICON_180_B64);
    }
    if (url.pathname === "/favicon.png" || url.pathname === "/favicon.ico") {
      return pngResponse(ICON_32_B64);
    }

    const cors = makeCORS(env);
    try {
      // ─── Public read endpoints ─────────────────────────────────────────
      if (url.pathname === "/api/leagues") {
        return await cached(request, ctx, 3600, async () =>
          cors.cachedJson({ leagues: SUPPORTED_LEAGUES.map(l => l.key) }, 200, 3600)
        );
      }

      if (url.pathname === "/api/lineage") {
        const league = leagueFrom(url); guardLeague(league);
        return await cached(request, ctx, 300, async () => {
          const lineage = await readMergedLineage(league, env);
          if (!lineage.currentChamp && lineage.changes.length === 0) {
            return cors.json({ error: "No data yet. Run build_lineage.py and upload_to_worker.py." }, 404);
          }
          return cors.cachedJson(lineage);
        });
      }

      if (url.pathname === "/api/events") {
        const league = leagueFrom(url); guardLeague(league);
        return await cached(request, ctx, 3600, async () =>
          await streamEventsFromKV(league, env, cors)
        );
      }

      if (url.pathname === "/api/stats") {
        const league = leagueFrom(url); guardLeague(league);
        return await cached(request, ctx, 300, async () =>
          cors.cachedJson(await computeStatsFromLineage(league, env))
        );
      }

      // Counterfactual timeline: flip one real game and re-run the belt forward
      // through every actual result. ?league=X&flip=<gameId> (optional — with
      // no flip it just recomputes canon from the raw games, useful to verify
      // the stored chain). Returns { current, changes, flip, available }.
      if (url.pathname === "/api/whatif") {
        const league = leagueFrom(url); guardLeague(league);
        const flipId = url.searchParams.get("flip");
        // Cheap availability probe — reads only the tiny meta key.
        if (url.searchParams.get("check")) {
          const meta = await env.KV.get(`${league}:gamesMeta`, { type: "json" });
          return cors.json({ league, available: !!meta, count: meta ? meta.count : 0 }, 200);
        }
        const stat = await env.KV.get(`${league}:static`, { type: "json" });
        if (!stat) return cors.json({ error: `no lineage for ${league}` }, 404);
        // Read the game log — a single cell, or N chunks stitched back together
        // for leagues too big for KV's 25 MB per-value cap.
        const gmeta = await env.KV.get(`${league}:gamesMeta`, { type: "json" });
        let rows = null, asOfGames = null;
        if (gmeta && gmeta.chunks && gmeta.chunks > 1) {
          rows = [];
          for (let i = 0; i < gmeta.chunks; i++) {
            const part = await env.KV.get(`${league}:games:${i}`, { type: "json" });
            if (!part || !Array.isArray(part.games)) {
              return cors.json({ error: `game log chunk ${i}/${gmeta.chunks} missing for ${league}`, available: false }, 404);
            }
            for (const r of part.games) rows.push(r);
          }
          asOfGames = gmeta.asOfDate;
        } else {
          const raw = await env.KV.get(`${league}:games`, { type: "json" });
          if (raw && Array.isArray(raw.games)) { rows = raw.games; asOfGames = raw.asOfDate; }
        }
        if (!rows) {
          return cors.json({ error: `no game log stored for ${league}`, available: false }, 404);
        }
        const games = rows.map((r) => ({
          id: r[0], date: r[1], home: { id: r[2] }, away: { id: r[3] },
          homeScore: r[4], awayScore: r[5],
        }));
        let flip = null;
        if (flipId) {
          const g = games.find((x) => String(x.id) === String(flipId));
          if (!g) return cors.json({ error: `game ${flipId} not found`, available: true }, 404);
          const t = g.homeScore; g.homeScore = g.awayScore; g.awayScore = t; // reverse the result
          flip = { id: g.id, date: g.date, home: g.home.id, away: g.away.id };
        }
        const res = computeLineageLapse(games, stat.seedTeam, stat.seedDate);
        return cors.json({
          league, available: true, flip,
          seedTeam: stat.seedTeam, asOfDate: asOfGames,
          current: res.current, changes: res.changes,
        }, 200);
      }

      if (url.pathname === "/api/brand") {
        const league = leagueFrom(url); guardLeague(league);
        return await cached(request, ctx, 3600, async () =>
          cors.cachedJson(await loadBrand(env, league), 200, 3600)
        );
      }

      // ─── Admin: lineage upload / status ─────────────────────────────────
      if (url.pathname === "/admin/upload-lineage") {
        guardAdmin(request, env, cors);
        const league = leagueFrom(url); guardLeague(league);
        const body = await safeJSON(request);
        if (!body || !Array.isArray(body.changes) || !body.currentChamp) {
          return cors.json({ error: "Body must include {asOfDate, currentChamp, changes:[...]}" }, 400);
        }
        await env.KV.put(`${league}:static`, JSON.stringify({
          league,
          seedTeam: body.seedTeam || null,
          seedDate: body.seedDate || null,
          asOfDate: body.asOfDate || today(),
          currentChamp: body.currentChamp,
          changes: body.changes,
          uploadedAt: new Date().toISOString(),
        }));
        // Wipe any stale deltas (they're now embedded in the new static set).
        await env.KV.delete(`${league}:deltaChanges`);
        await invalidateLineageCache(url, league);
        return cors.json({ ok: true, league, changes: body.changes.length, currentChamp: body.currentChamp });
      }

      if (url.pathname === "/admin/upload-events") {
        guardAdmin(request, env, cors);
        const league = leagueFrom(url); guardLeague(league);
        const body = await safeJSON(request);
        if (!body || !Array.isArray(body.events)) {
          return cors.json({ error: "Body must include {asOfDate, events:[...]}" }, 400);
        }
        await env.KV.put(`${league}:events`, JSON.stringify({
          league,
          asOfDate: body.asOfDate || today(),
          events: body.events,
          uploadedAt: new Date().toISOString(),
        }));
        await invalidateLineageCache(url, league);
        return cors.json({ ok: true, league, eventCount: body.events.length });
      }

      if (url.pathname === "/admin/upload-games") {
        guardAdmin(request, env, cors);
        const league = leagueFrom(url); guardLeague(league);
        const body = await safeJSON(request);
        if (!body || !Array.isArray(body.games)) {
          return cors.json({ error: "Body must include {asOfDate, games:[[id,date,home,away,hs,as],...]}" }, 400);
        }
        const asOf = body.asOfDate || today();
        // Big leagues exceed KV's 25 MB per-value cap, so the uploader may split
        // the game log across N cells: /admin/upload-games?chunk=i&chunks=N&total=M.
        // gamesMeta records how many chunks to stitch back together at read time.
        const chunks = Math.max(1, parseInt(url.searchParams.get("chunks") || "1", 10));
        if (chunks <= 1) {
          await env.KV.put(`${league}:games`, JSON.stringify({
            league, asOfDate: asOf, games: body.games, uploadedAt: new Date().toISOString(),
          }));
          await env.KV.put(`${league}:gamesMeta`, JSON.stringify({
            count: body.games.length, chunks: 1, asOfDate: asOf,
          }));
          return cors.json({ ok: true, league, gameCount: body.games.length, chunks: 1 });
        }
        const chunk = Math.max(0, parseInt(url.searchParams.get("chunk") || "0", 10));
        const total = parseInt(url.searchParams.get("total") || String(body.games.length), 10);
        await env.KV.put(`${league}:games:${chunk}`, JSON.stringify({
          league, chunk, chunks, games: body.games,
        }));
        // Meta is written on every chunk (idempotent) so a resumed/retried
        // upload always leaves it consistent with the declared chunk count.
        await env.KV.put(`${league}:gamesMeta`, JSON.stringify({
          count: total, chunks, asOfDate: asOf,
        }));
        return cors.json({ ok: true, league, chunk, chunks, chunkGames: body.games.length });
      }

      if (url.pathname === "/admin/status") {
        guardAdmin(request, env, cors);
        const league = leagueFrom(url); guardLeague(league);
        const lineage = await readMergedLineage(league, env);
        // Per-league key is only written when the cron finds something new;
        // fall back to the global heartbeat so status never looks dead.
        const lastUpdate = (await env.KV.get(`${league}:lastUpdate`))
          || (await env.KV.get("cron:lastRun"));
        return cors.json({
          ok: true, league,
          currentChamp: lineage.currentChamp,
          asOfDate: lineage.asOfDate,
          changeCount: lineage.changes.length,
          deltaCount: lineage.deltaCount,
          lastUpdate,
        });
      }

      if (url.pathname === "/admin/setChamp") {
        guardAdmin(request, env, cors);
        const league = leagueFrom(url); guardLeague(league);
        const team = norm(url.searchParams.get("team") || "");
        const date = url.searchParams.get("date") || today();
        if (!team) return cors.json({ error: "Provide team" }, 400);
        const existing = (await env.KV.get(`${league}:deltaChanges`, { type: "json" })) || [];
        const change = { date: new Date(date).toISOString(), gameId: null, from: null, to: team, manual: true };
        await env.KV.put(`${league}:deltaChanges`, JSON.stringify(existing.concat([change])));
        return cors.json({ ok: true, message: `Manual override: ${team} as of ${date}` });
      }

      if (url.pathname === "/admin/probe") {
        // Returns the first raw item from an adapter's upstream — useful when a
        // source's response shape has drifted and EPL/NFL stop parsing.
        guardAdmin(request, env, cors);
        const league = leagueFrom(url); guardLeague(league);
        return cors.json(await probeAdapter(league, env));
      }

      // ─── Admin: branding ────────────────────────────────────────────────
      if (url.pathname === "/admin/brand/get") {
        guardAdmin(request, env, cors);
        const league = leagueFrom(url); guardLeague(league);
        return cors.json({ ok: true, league, map: await loadBrand(env, league) });
      }
      if (url.pathname === "/admin/brand/set") {
        guardAdmin(request, env, cors);
        const body = await safeJSON(request);
        const league = norm(body.league || ""); const code = norm(body.code || "");
        if (!SUPPORTED_LEAGUES.some(l => l.key === league)) return cors.json({ error: "Bad league" }, 400);
        if (!code) return cors.json({ error: "Missing code" }, 400);
        const curr = await loadBrand(env, league);
        curr[code] = {
          name: body.name || code,
          color: body.color || curr[code]?.color || "#333",
          alt:   body.alt   || curr[code]?.alt   || "#888",
          // Use Object.prototype.hasOwnProperty so an explicit empty-string
          // logo overwrites the stored value (clears stale/bad URLs);
          // omitting `logo` from the body preserves whatever is already there.
          logo:  Object.prototype.hasOwnProperty.call(body, "logo")
                   ? (body.logo || "")
                   : (curr[code]?.logo || ""),
        };
        await saveBrand(env, league, curr);
        // Purge edge cache for this league's brand response so the next reader
        // sees the new entry instead of a stale cached payload.
        await invalidateBrandCache(url, league);
        return cors.json({ ok: true, updated: curr[code] });
      }
      if (url.pathname === "/admin/brand/bulk") {
        // Merge a whole {code: {name, color?, alt?, logo?}} map in ONE KV write
        // (per-code /admin/brand/set would cost one write each — the boxing
        // divisions carry ~50 fighters apiece).
        guardAdmin(request, env, cors);
        const body = await safeJSON(request);
        const league = norm(body.league || "");
        if (!SUPPORTED_LEAGUES.some(l => l.key === league)) return cors.json({ error: "Bad league" }, 400);
        if (!body.map || typeof body.map !== "object") return cors.json({ error: "Missing map" }, 400);
        const curr = await loadBrand(env, league);
        let n = 0;
        for (const [rawCode, entry] of Object.entries(body.map)) {
          const code = norm(rawCode);
          if (!code || !entry) continue;
          curr[code] = {
            name: entry.name || curr[code]?.name || code,
            color: entry.color || curr[code]?.color || "#333",
            alt:   entry.alt   || curr[code]?.alt   || "#888",
            logo:  entry.logo != null ? entry.logo : (curr[code]?.logo || ""),
          };
          n++;
        }
        await saveBrand(env, league, curr);
        await invalidateBrandCache(url, league);
        return cors.json({ ok: true, league, merged: n });
      }
      if (url.pathname === "/admin/brand/delete") {
        guardAdmin(request, env, cors);
        const body = await safeJSON(request);
        const league = norm(body.league || ""); const code = norm(body.code || "");
        const curr = await loadBrand(env, league);
        if (curr && curr[code]) { delete curr[code]; await saveBrand(env, league, curr); }
        return cors.json({ ok: true });
      }

      // ─── Q&A ───────────────────────────────────────────────────────────
      if (url.pathname === "/api/gpt") {
        return await handleGptQuery(url, env, cors);
      }

      return cors.text("linealchamp worker ok");
    } catch (err) {
      if (err instanceof Response) return err;
      return new Response(String(err?.stack || err), { status: 500, headers: cors.headers() });
    }
  },

  async scheduled(event, env, ctx) {
    primeEnv(env);
    const paused = (env.PAUSE_LEAGUES || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const isPaused = k => paused.includes(k) || (env.PAUSE_ALL === "true");
    // One heartbeat write per run (instead of one per league per run — that
    // pattern alone was ~200 KV writes/day against the 1,000 free-tier cap).
    ctx.waitUntil(env.KV.put("cron:lastRun", new Date().toISOString()));
    for (const { key } of SUPPORTED_LEAGUES) {
      if (!isPaused(key)) ctx.waitUntil(updateLeagueIncremental(key, env));
    }
  },
};

/* ─── Config ────────────────────────────────────────────────────────────── */

const SUPPORTED_LEAGUES = [
  { key: "NBA" },
  { key: "NFL" },
  { key: "MLB" },
  { key: "NHL" },
  { key: "EPL" },
  { key: "CFB" },
  { key: "BOXHW" },
  { key: "BOXLHW" },
  { key: "BOXMW" },
  { key: "BOXWW" },
  { key: "BOXLW" },
  { key: "BOXFW" },
  { key: "BOXBW" },
  { key: "BOXFLW" },
];

function getLeagueCfg(league) {
  const cfg = SUPPORTED_LEAGUES.find(l => l.key === league);
  if (!cfg) throw new Error(`Unsupported league: ${league}`);
  return cfg;
}
function leagueFrom(url) { return (url.searchParams.get("league") || "NBA").toUpperCase(); }
function guardLeague(l) { if (!SUPPORTED_LEAGUES.some(x => x.key === l)) throw new Error(`Unsupported league: ${l}`); }
function guardAdmin(request, env, cors) {
  const expected = (env.ADMIN_SECRET || env.admin_secret || "").trim();
  const got = (request.headers.get("x-admin-secret") || "").trim();
  if (!expected) throw new Error("ADMIN_SECRET not configured.");
  if (got !== expected) throw new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors.headers() });
}
function primeEnv(env) {
  globalThis.BDL_API_KEY = env.BDL_API_KEY || "";
  globalThis.CFBD_API_KEY = env.CFBD_API_KEY || "";
}
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, d) { const x = new Date(iso + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); }
function year(iso) { return Number(iso.slice(0, 4)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function safeJSON(req) { try { return await req.json(); } catch { return {}; } }

/* ─── Merged lineage read ──────────────────────────────────────────────── */

async function readStaticLineage(league, env) {
  return await env.KV.get(`${league}:static`, { type: "json" });
}

async function readMergedLineage(league, env) {
  const stat = await readStaticLineage(league, env);
  const delta = (await env.KV.get(`${league}:deltaChanges`, { type: "json" })) || [];
  if (!stat) {
    return { league, currentChamp: null, asOfDate: null, changes: delta, deltaCount: delta.length };
  }
  const merged = (stat.changes || []).concat(delta);
  merged.sort((a, b) => new Date(a.date) - new Date(b.date));
  const currentChamp = delta.length ? delta[delta.length - 1].to : stat.currentChamp;
  return {
    league,
    seedTeam: stat.seedTeam,
    seedDate: stat.seedDate,
    asOfDate: stat.asOfDate,
    currentChamp,
    changes: merged,
    deltaCount: delta.length,
  };
}

/* ─── Events: read from KV ─────────────────────────────────────────────── */

async function streamEventsFromKV(league, env, cors) {
  const blob = await env.KV.get(`${league}:events`);
  if (!blob) return cors.json({ error: "No events uploaded for this league yet." }, 404);
  return new Response(blob, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600",
      ...corsHeaders(env),
    },
  });
}

/* ─── Stats: server-computed from lineage changes ──────────────────────── */

async function computeStatsFromLineage(league, env) {
  const { changes, currentChamp } = await readMergedLineage(league, env);
  if (!changes.length) return { table: [], totalReigns: 0 };

  const reigns = [];
  const sorted = changes.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i], next = sorted[i + 1];
    reigns.push({
      team: c.to,
      startISO: c.date.slice(0, 10),
      endISO: (next ? next.date : new Date().toISOString()).slice(0, 10),
    });
  }
  const byTeam = new Map();
  const ensure = t => { if (!byTeam.has(t)) byTeam.set(t, { team: t, days: 0, reigns: 0 }); return byTeam.get(t); };
  for (const r of reigns) {
    if (r.team === "VACANT") continue; // vacancy stretches aren't reigns
    const a = ensure(r.team);
    a.reigns += 1;
    const days = Math.max(0, Math.floor((new Date(r.endISO) - new Date(r.startISO)) / (24 * 3600 * 1000)));
    a.days += days;
  }
  const table = Array.from(byTeam.values()).sort((a, b) => b.days - a.days);
  return { table: table.slice(0, 25), totalReigns: reigns.length, currentChamp };
}

/* ─── Lineage core (matches Python port in linealchamp-data/lineage.py) ── */

function computeLineage(games, seedTeam = null) {
  let champ = seedTeam || null;
  const changes = [];
  const events = [];
  if (!champ) {
    for (const g of games) {
      const w = winner(g);
      if (w) {
        champ = w;
        changes.push({ date: iso(g.date), gameId: g.id, from: null, to: champ, score: scoreline(g) });
        break;
      }
    }
  }
  if (!champ) return { current: null, changes: [], events: [] };

  for (const g of games) {
    const w = winner(g); if (!w) continue;
    const hId = g.home?.id, aId = g.away?.id;
    if (hId !== champ && aId !== champ) continue;
    const opp = hId === champ ? aId : hId;
    const champScore = hId === champ ? g.homeScore : g.awayScore;
    const oppScore = hId === champ ? g.awayScore : g.homeScore;
    const champWon = w === champ;
    const change = !champWon;
    events.push({
      date: iso(g.date), gameId: g.id, champ, opponent: opp,
      champScore, oppScore, result: champWon ? "W" : "L", change,
    });
    if (change) {
      changes.push({ date: iso(g.date), gameId: g.id, from: champ, to: w, score: `${champScore}-${oppScore}` });
      champ = w;
    }
  }
  return { current: champ, changes, events };
}
function winner(g) {
  if (g.homeScore == null || g.awayScore == null) return null;
  if (g.homeScore === g.awayScore) return null;
  return g.homeScore > g.awayScore ? g.home.id : g.away.id;
}
function scoreline(g) { return (g.homeScore != null && g.awayScore != null) ? `${g.homeScore}-${g.awayScore}` : null; }
function iso(s) { try { return new Date(s).toISOString(); } catch { return s; } }
function norm(s) { return String(s || "").toUpperCase().replace(/\s+/g, ""); }

/* ─── Counterfactual recompute ("what if?") ─────────────────────────────────
 * A faithful port of linealchamp-data/lineage.py compute_lineage, INCLUDING
 * the inactivity-lapse rule (the plain computeLineage above omits it). Given
 * the full game log for a league and the canonical seed, it walks the belt
 * forward exactly as the offline builder did — so recomputing with no changes
 * reproduces the live chain, and recomputing after flipping ONE game's result
 * yields the true alternate timeline (the belt cascades through whoever really
 * won each subsequent game). Returns only { current, changes } — enough for
 * the client to re-render an alternate timeline; events aren't needed. */
const LAPSE_DAYS = 365;
function computeLineageLapse(games, seedTeam, seedDate) {
  const toDt = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? null : t; };
  games = games.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let champ = seedTeam || null;
  const changes = [];
  if (champ) {
    changes.push({ date: iso(seedDate || (games[0] && games[0].date)), gameId: null, from: null, to: champ, seed: true });
  } else {
    for (const g of games) {
      const w = winner(g);
      if (w) { champ = w; changes.push({ date: iso(g.date), gameId: g.id, from: null, to: champ, score: scoreline(g), seed: true }); break; }
    }
  }
  if (!champ) return { current: null, changes: [] };

  let champLast = toDt(seedDate) || toDt(games[0] && games[0].date);
  for (const g of games) {
    const w = winner(g);
    if (w === null) continue;
    const hId = g.home.id, aId = g.away.id;
    const champPlays = champ === hId || champ === aId;
    const gd = toDt(g.date);
    // Inactivity lapse: holder hasn't appeared in over a year and isn't in
    // this game — belt vacates to this game's winner (not a head-to-head loss).
    if (!champPlays && champLast != null && gd != null && (gd - champLast) / 86400000 > LAPSE_DAYS) {
      changes.push({ date: iso(g.date), gameId: g.id, from: champ, to: w, lapsed: true });
      champ = w; champLast = gd; continue;
    }
    if (!champPlays) continue;
    const champScore = champ === hId ? g.homeScore : g.awayScore;
    const oppScore = champ === hId ? g.awayScore : g.homeScore;
    champLast = gd;
    if (w !== champ) {
      changes.push({ date: iso(g.date), gameId: g.id, from: champ, to: w, score: `${champScore}-${oppScore}` });
      champ = w; champLast = gd;
    }
  }
  return { current: champ, changes };
}

/* ─── Incremental update (cron) ────────────────────────────────────────── */

async function updateLeagueIncremental(league, env) {
  try {
    // Skip leagues with no live-data adapter (e.g. hand-curated boxing).
    if (!ADAPTERS[league]) return;
    const lineage = await readMergedLineage(league, env);
    if (!lineage.currentChamp || lineage.currentChamp === "VACANT") return;
    let since = lineage.changes.length
      ? lineage.changes[lineage.changes.length - 1].date.slice(0, 10)
      : lineage.asOfDate || addDays(today(), -7);
    // Cap the lookback window. A long unbroken reign used to make the cron
    // re-fetch months of schedule data EVERY HOUR; the nightly offline
    // rebuild owns anything older than this window anyway.
    since = since > addDays(today(), -14) ? since : addDays(today(), -14);
    const end = today();
    if (since >= end) return;
    // Fetch only games involving the current holder in [since, end].
    const games = await ADAPTERS[league].fetchRecentForTeam(lineage.currentChamp, since, end);
    if (!games.length) return;
    games.sort((a, b) => new Date(a.date) - new Date(b.date));
    const { current, changes, events } = computeLineage(games, lineage.currentChamp);
    let wrote = false;
    const newChanges = changes.filter(c => !c.seed && c.from !== null);
    if (newChanges.length) {
      const existing = (await env.KV.get(`${league}:deltaChanges`, { type: "json" })) || [];
      const haveIds = new Set(existing.map(c => c.gameId).filter(Boolean));
      const fresh = newChanges.filter(c => c.gameId && !haveIds.has(c.gameId));
      if (fresh.length) {
        await env.KV.put(`${league}:deltaChanges`, JSON.stringify(existing.concat(fresh)));
        wrote = true;
      }
    }
    if (events.length) {
      wrote = (await appendEventsToKV(league, events, env)) || wrote;
    }
    // Only spend a KV write on the per-league timestamp when something
    // actually changed; /admin/status falls back to the global heartbeat.
    if (wrote) await env.KV.put(`${league}:lastUpdate`, new Date().toISOString());
  } catch (err) {
    console.log(`updateLeagueIncremental ${league} failed:`, err.message);
  }
}

async function appendEventsToKV(league, newEvents, env) {
  const existing = (await env.KV.get(`${league}:events`, { type: "json" })) || { league, asOfDate: today(), events: [] };
  const haveIds = new Set((existing.events || []).map(e => e.gameId).filter(Boolean));
  const fresh = newEvents.filter(e => e.gameId && !haveIds.has(e.gameId));
  if (!fresh.length) return false;
  existing.events = (existing.events || []).concat(fresh);
  existing.asOfDate = today();
  await env.KV.put(`${league}:events`, JSON.stringify(existing));
  return true;
}

/* ─── Probe (for debugging upstream API shape changes) ─────────────────── */

async function probeAdapter(league, env) {
  if (!ADAPTERS[league]) return { league, error: "No live adapter for this league (hand-curated data)." };
  const sinceDate = addDays(today(), -14);
  const games = await ADAPTERS[league].fetchRecentForTeam(null, sinceDate, today());
  return {
    league,
    window: { since: sinceDate, until: today() },
    gameCount: games.length,
    firstGame: games[0] || null,
  };
}

/* ─── Adapters: thin, current-window only ──────────────────────────────── */

const ADAPTERS = {
  NBA: { fetchRecentForTeam: fetchNBARecent },
  NFL: { fetchRecentForTeam: fetchNFLRecent },
  MLB: { fetchRecentForTeam: fetchMLBRecent },
  NHL: { fetchRecentForTeam: fetchNHLRecent },
  EPL: { fetchRecentForTeam: fetchEPLRecent },
  CFB: { fetchRecentForTeam: fetchCFBRecent },
};

// A game near "now" may still be in progress. Cron used to record partial
// scores as finals (the infamous 5-3 "NBA game") — every adapter must gate
// on an explicit final status.
function bdlFinal(status) {
  return /final/i.test(String(status || ""));
}

// NBA — balldontlie (verified field names: home_team, visitor_team)
async function fetchNBARecent(teamCode, start, end) {
  if (!globalThis.BDL_API_KEY) return [];
  const out = [];
  for (const postseason of ["false", "true"]) {
    let cursor = null, safety = 0;
    while (true) {
      const u = new URL("https://api.balldontlie.io/v1/games");
      u.searchParams.set("per_page", "100");
      u.searchParams.set("start_date", start);
      u.searchParams.set("end_date", end);
      u.searchParams.set("postseason", postseason);
      if (cursor != null) u.searchParams.set("cursor", String(cursor));
      const j = await getJSON(u.toString(), 5);
      for (const it of j?.data || []) {
        if (!bdlFinal(it.status)) continue;
        const game = {
          id: `BDL-NBA-${it.id}`,
          date: it.date,
          home: { id: norm(it.home_team?.abbreviation || it.home_team?.full_name) },
          away: { id: norm(it.visitor_team?.abbreviation || it.visitor_team?.full_name) },
          homeScore: it.home_team_score,
          awayScore: it.visitor_team_score,
        };
        if (!teamCode || game.home.id === teamCode || game.away.id === teamCode) out.push(game);
      }
      const next = j?.meta?.next_cursor;
      if (!next) break; cursor = next;
      if (++safety > 50) break;
      await sleep(150);
    }
  }
  return out;
}

// NFL — balldontlie /nfl/v1/games. Tries both away_team and visitor_team.
async function fetchNFLRecent(teamCode, start, end) {
  if (!globalThis.BDL_API_KEY) return [];
  const y0 = year(start), y1 = year(end);
  const out = [];
  for (let season = y0; season <= y1; season++) {
    for (const postseason of ["false", "true"]) {
      let cursor = null, safety = 0;
      while (true) {
        const u = new URL("https://api.balldontlie.io/nfl/v1/games");
        u.searchParams.set("per_page", "100");
        u.searchParams.set("seasons[]", String(season));
        u.searchParams.set("postseason", postseason);
        if (cursor != null) u.searchParams.set("cursor", String(cursor));
        const j = await getJSON(u.toString(), 5);
        for (const it of j?.data || []) {
          if (it.status != null && !bdlFinal(it.status)) continue;
          const homeTeam = it.home_team || {};
          const awayTeam = it.away_team || it.visitor_team || {};
          const date = it.date || it.start_time || it.kickoff;
          if (!date) continue;
          if (date.slice(0, 10) < start || date.slice(0, 10) > end) continue;
          const game = {
            id: `BDL-NFL-${it.id}`,
            date,
            home: { id: norm(homeTeam.abbreviation || homeTeam.full_name || homeTeam.name) },
            away: { id: norm(awayTeam.abbreviation || awayTeam.full_name || awayTeam.name) },
            homeScore: it.home_team_score ?? it.home_score,
            awayScore: it.visitor_team_score ?? it.away_team_score ?? it.away_score,
          };
          if (!teamCode || game.home.id === teamCode || game.away.id === teamCode) out.push(game);
        }
        const next = j?.meta?.next_cursor;
        if (!next) break; cursor = next;
        if (++safety > 50) break;
        await sleep(150);
      }
    }
  }
  return out;
}

// MLB — StatsAPI. The static chain uses RETROSHEET team codes (CHA, NYA,
// LAN…), so map StatsAPI team ids to those codes — matching on StatsAPI
// abbreviations (CWS, NYY, LAD…) never hits, which is why MLB live updates
// silently did nothing.
const MLB_TEAMID_TO_RS = {
  108: "ANA", 109: "ARI", 110: "BAL", 111: "BOS", 112: "CHN",
  113: "CIN", 114: "CLE", 115: "COL", 116: "DET", 117: "HOU",
  118: "KCA", 119: "LAN", 120: "WAS", 121: "NYN", 133: "OAK",
  134: "PIT", 135: "SDN", 136: "SEA", 137: "SFN", 138: "SLN",
  139: "TBA", 140: "TEX", 141: "TOR", 142: "MIN", 143: "PHI",
  144: "ATL", 145: "CHA", 146: "MIA", 147: "NYA", 158: "MIL",
};
function mlbTeamId(side) {
  const team = side?.team || {};
  return norm(MLB_TEAMID_TO_RS[team.id] || team.abbreviation || team.teamCode || team.name);
}
async function fetchMLBRecent(teamCode, start, end) {
  const u = new URL("https://statsapi.mlb.com/api/v1/schedule");
  u.searchParams.set("sportId", "1");
  u.searchParams.set("startDate", start);
  u.searchParams.set("endDate", end);
  u.searchParams.set("hydrate", "team");
  const j = await getJSON(u.toString(), 4);
  const out = [];
  for (const d of j?.dates || []) {
    for (const g of d?.games || []) {
      const state = (g?.status?.detailedState || "").toLowerCase();
      if (!state.includes("final")) continue;
      const t = g.teams || {};
      const game = {
        id: `MLB-${g.gamePk}`,
        date: g.gameDate,
        home: { id: mlbTeamId(t.home) },
        away: { id: mlbTeamId(t.away) },
        homeScore: t.home?.score,
        awayScore: t.away?.score,
      };
      if (!teamCode || game.home.id === teamCode || game.away.id === teamCode) out.push(game);
    }
  }
  return out;
}

// NHL — api-web.nhle.com /v1/schedule/<date> returns the WEEK containing the
// date. We step by 7 days, not 1, so we don't burn subrequests. ESPN fallback
// only for days with no data after the primary call.
// The static chain uses norm(FULL TEAM NAME) codes from hockey-reference
// (VEGASGOLDENKNIGHTS), while api-web returns tri-codes (VGK) — map them,
// otherwise live updates never match the holder.
const NHL_ABBREV_TO_NAME = {
  ANA: "Anaheim Ducks", BOS: "Boston Bruins", BUF: "Buffalo Sabres",
  CGY: "Calgary Flames", CAR: "Carolina Hurricanes", CHI: "Chicago Blackhawks",
  COL: "Colorado Avalanche", CBJ: "Columbus Blue Jackets", DAL: "Dallas Stars",
  DET: "Detroit Red Wings", EDM: "Edmonton Oilers", FLA: "Florida Panthers",
  LAK: "Los Angeles Kings", MIN: "Minnesota Wild", MTL: "Montreal Canadiens",
  NSH: "Nashville Predators", NJD: "New Jersey Devils", NYI: "New York Islanders",
  NYR: "New York Rangers", OTT: "Ottawa Senators", PHI: "Philadelphia Flyers",
  PIT: "Pittsburgh Penguins", SJS: "San Jose Sharks", SEA: "Seattle Kraken",
  STL: "St. Louis Blues", TBL: "Tampa Bay Lightning", TOR: "Toronto Maple Leafs",
  VAN: "Vancouver Canucks", VGK: "Vegas Golden Knights", WSH: "Washington Capitals",
  WPG: "Winnipeg Jets", UTA: "Utah Mammoth",
};
function nhlTeamId(t) {
  const ab = (t?.abbrev || t?.triCode || "").toUpperCase();
  return norm(NHL_ABBREV_TO_NAME[ab] || t?.name?.default || ab);
}
async function fetchNHLRecent(teamCode, start, end) {
  const out = [];
  let cur = start;
  const seen = new Set();
  while (cur <= end) {
    let dayHad = false;
    try {
      const j = await getJSON(`https://api-web.nhle.com/v1/schedule/${cur}`, 3);
      for (const d of (j?.gameWeek || [])) {
        for (const g of (d?.games || [])) {
          const state = String(g?.gameState || "").toUpperCase();
          if (state !== "OFF" && !state.includes("FINAL")) continue;
          const h = g.homeTeam || {}, a = g.awayTeam || {};
          if (h.score == null || a.score == null) continue;
          const id = `NHL-${g.id}`;
          if (seen.has(id)) continue; seen.add(id);
          const date = g.startTimeUTC || g.gameDate || (d?.date ? `${d.date}T00:00:00Z` : `${cur}T00:00:00Z`);
          if (date.slice(0, 10) < start || date.slice(0, 10) > end) continue;
          const game = {
            id, date,
            home: { id: nhlTeamId(h) },
            away: { id: nhlTeamId(a) },
            homeScore: h.score, awayScore: a.score,
          };
          if (!teamCode || game.home.id === teamCode || game.away.id === teamCode) out.push(game);
          dayHad = true;
        }
      }
    } catch {}
    if (!dayHad) {
      // ESPN fallback only for the current day
      try {
        const dates = cur.replaceAll("-", "");
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=${dates}`, { cf: { cacheTtl: 300 } });
        if (r.ok) {
          const data = await r.json();
          for (const ev of (data?.events || [])) {
            const comp = ev?.competitions?.[0]; if (!comp?.status?.type?.completed) continue;
            const teams = comp?.competitors || [];
            const h = teams.find(t => t.homeAway === "home"), a = teams.find(t => t.homeAway === "away");
            if (!h || !a) continue;
            const game = {
              id: `ESPN-NHL-${ev.id}`,
              date: comp.date || ev.date,
              home: { id: norm(h.team?.displayName || h.team?.shortDisplayName) },
              away: { id: norm(a.team?.displayName || a.team?.shortDisplayName) },
              homeScore: Number(h.score || 0),
              awayScore: Number(a.score || 0),
            };
            if (!teamCode || game.home.id === teamCode || game.away.id === teamCode) out.push(game);
          }
        }
      } catch {}
    }
    cur = addDays(cur, 7); // step by week — api-web returns the full week per call
  }
  return out;
}

// EPL — balldontlie /epl/v1/games, with field-name tolerance.
async function fetchEPLRecent(teamCode, start, end) {
  if (!globalThis.BDL_API_KEY) return [];
  const y0 = Math.max(1992, year(start)), y1 = year(end);
  const out = [];
  for (let season = y0; season <= y1; season++) {
    let cursor = null, safety = 0;
    while (true) {
      const u = new URL("https://api.balldontlie.io/epl/v1/games");
      u.searchParams.set("per_page", "100");
      u.searchParams.append("seasons[]", String(season));
      if (cursor != null) u.searchParams.set("cursor", String(cursor));
      const j = await getJSON(u.toString(), 5);
      for (const it of j?.data || []) {
        if (it.status != null && !bdlFinal(it.status)) continue;
        const home = it.home_team || {};
        const away = it.away_team || it.visitor_team || {};
        const date = it.date || it.start_time || it.start || it.kickoff;
        if (!date) continue;
        if (date.slice(0, 10) < start || date.slice(0, 10) > end) continue;
        const game = {
          id: `BDL-EPL-${it.id}`,
          date,
          home: { id: norm(home.abbreviation || home.short_code || home.full_name || home.name) },
          away: { id: norm(away.abbreviation || away.short_code || away.full_name || away.name) },
          homeScore: it.home_team_score ?? it.home_score ?? it.home_goals,
          awayScore: it.away_team_score ?? it.visitor_team_score ?? it.away_score ?? it.away_goals,
        };
        if (!teamCode || game.home.id === teamCode || game.away.id === teamCode) out.push(game);
      }
      const next = j?.meta?.next_cursor;
      if (!next) break; cursor = next;
      if (++safety > 50) break;
      await sleep(150);
    }
  }
  return out;
}

// CFB — collegefootballdata, FBS only.
async function fetchCFBRecent(teamCode, start, end) {
  if (!globalThis.CFBD_API_KEY) return [];
  const y0 = year(start), y1 = year(end);
  const out = [];
  for (let y = y0; y <= y1; y++) {
    for (const seasonType of ["regular", "postseason"]) {
      const u = new URL("https://api.collegefootballdata.com/games");
      u.searchParams.set("year", String(y));
      u.searchParams.set("seasonType", seasonType);
      u.searchParams.set("division", "fbs");
      const arr = await getJSON(u.toString(), 4);
      for (const it of arr || []) {
        if (it.completed === false) continue;
        const date = it.start_date || it.startDate || `${y}-09-01`;
        if (date.slice(0, 10) < start || date.slice(0, 10) > end) continue;
        if (it.home_points == null || it.away_points == null) continue;
        const game = {
          id: `CFBD-${it.id}`,
          date,
          home: { id: norm(it.home_team || it.homeTeam) },
          away: { id: norm(it.away_team || it.awayTeam) },
          homeScore: it.home_points ?? it.homePoints,
          awayScore: it.away_points ?? it.awayPoints,
        };
        if (!teamCode || game.home.id === teamCode || game.away.id === teamCode) out.push(game);
      }
      await sleep(200);
    }
  }
  return out;
}

async function invalidateBrandCache(reqUrl, league) {
  await invalidatePaths(reqUrl, ["/api/brand"], league);
}

async function invalidateLineageCache(reqUrl, league) {
  await invalidatePaths(reqUrl, ["/api/lineage", "/api/stats", "/api/events"], league);
}

async function invalidatePaths(reqUrl, paths, league) {
  try {
    const cache = caches.default;
    for (const p of paths) {
      const u = new URL(reqUrl.toString());
      u.pathname = p;
      u.search = "?league=" + league;
      await cache.delete(u.toString());
    }
  } catch (_) { /* best-effort */ }
}

// Edge-cache wrapper. Reads from caches.default (Cloudflare's per-colo edge
// cache) before invoking the builder. On miss, builds the response, stores
// it in the cache with the given TTL, and returns it. Only GET responses
// with status 200 are cached.
async function cached(request, ctx, ttlSeconds, builder) {
  if (request.method !== "GET") return await builder();
  const cache = caches.default;
  const cacheKey = request.url;
  const hit = await cache.match(cacheKey);
  if (hit) {
    const h = new Response(hit.body, hit);
    h.headers.set("x-cache", "HIT");
    return h;
  }
  const fresh = await builder();
  if (fresh.status === 200) {
    const toCache = new Response(fresh.body, fresh);
    toCache.headers.set("cache-control", `public, max-age=${ttlSeconds}`);
    toCache.headers.set("x-cache", "MISS");
    // Mirror to client and edge in parallel.
    const [client, edge] = [toCache.clone(), toCache.clone()];
    if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, edge));
    else await cache.put(cacheKey, edge);
    return client;
  }
  return fresh;
}

/* ─── Branding KV ──────────────────────────────────────────────────────── */

async function loadBrand(env, league) {
  return (await env.KV.get(`brand:${league}`, { type: "json" })) || {};
}
async function saveBrand(env, league, obj) {
  await env.KV.put(`brand:${league}`, JSON.stringify(obj));
}

/* ─── GPT Q&A ──────────────────────────────────────────────────────────── */

async function handleGptQuery(url, env, cors) {
  const league = (url.searchParams.get("league") || "NBA").toUpperCase();
  guardLeague(league);
  const q = (url.searchParams.get("q") || "").trim();

  const dateISO = extractDateISO(q);
  if (dateISO && /\bon\b/i.test(q) && /(who|which)\b.*\b(champ|title|lineal|belt)/i.test(q)) {
    const code = await championOnDate(league, dateISO, env);
    if (code) {
      const brand = await loadBrand(env, league);
      const name = brand[code]?.name || code;
      return cors.json({ answer: `${league} lineal champion on ${dateISO} was ${name} (${code}).`, league, date: dateISO, code });
    }
    return cors.json({ answer: `I couldn't determine the champ for ${league} on ${dateISO}.`, league, date: dateISO, code: null });
  }

  if (String(env.GPT_ENABLED || "false").toLowerCase() !== "true") {
    return cors.json({ error: "GPT disabled. Set GPT_ENABLED=true to enable." }, 400);
  }
  if (!env.OPENAI_API_KEY) return cors.json({ error: "Missing OPENAI_API_KEY secret." }, 400);

  const lineage = await readMergedLineage(league, env);
  const stats = await computeStatsFromLineage(league, env);

  const payload = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You answer questions about lineal sports championships using the provided context. Be concise; cite specific dates from the context when relevant." },
      { role: "user", content: JSON.stringify({
        question: q,
        league,
        context: {
          currentChamp: lineage.currentChamp,
          asOfDate: lineage.asOfDate,
          changeCount: lineage.changes.length,
          recentChanges: lineage.changes.slice(-10),
          topReigns: stats.table.slice(0, 10),
        },
      }) },
    ],
    temperature: 0.2,
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => r.statusText);
    return cors.json({ error: `OpenAI error ${r.status}`, detail: txt }, 502);
  }
  const j = await r.json();
  return cors.json({ answer: j?.choices?.[0]?.message?.content || "No answer." });
}

function extractDateISO(text) {
  if (!text) return null;
  const iso = text.match(/\b(19|20)\d{2}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const mdy = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
  if (mdy) { const mm = String(mdy[1]).padStart(2, "0"); const dd = String(mdy[2]).padStart(2, "0"); return `${mdy[3]}-${mm}-${dd}`; }
  const mon = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})\b/);
  if (mon) {
    const map = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
    const m = map[mon[1].toLowerCase().slice(0, 3)];
    if (m) return `${mon[3]}-${String(m).padStart(2, "0")}-${String(mon[2]).padStart(2, "0")}`;
  }
  return null;
}

async function championOnDate(league, dateISO, env) {
  const { changes } = await readMergedLineage(league, env);
  if (!changes.length) return null;
  const target = new Date(dateISO + "T23:59:59Z");
  let champ = null;
  for (const ch of changes) {
    if (new Date(ch.date) <= target) champ = ch.to; else break;
  }
  return champ;
}

/* ─── HTTP helpers ─────────────────────────────────────────────────────── */

async function getJSON(url, tries = 6) {
  let last, attempt = 0;
  while (tries--) {
    attempt++;
    const headers = { accept: "application/json" };
    if (url.startsWith("https://api.balldontlie.io/") && globalThis.BDL_API_KEY) {
      headers["Authorization"] = `Bearer ${globalThis.BDL_API_KEY}`;
    }
    if (url.startsWith("https://api.collegefootballdata.com") && globalThis.CFBD_API_KEY) {
      headers["Authorization"] = `Bearer ${globalThis.CFBD_API_KEY}`;
    }
    let res;
    try {
      res = await fetch(url, { headers, cf: { cacheTtl: 300 } });
    } catch (e) {
      await sleep(400);
      last = String(e);
      continue;
    }
    if (res.ok) return await res.json();
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after") || "0");
      await sleep(ra > 0 ? ra * 1000 : Math.min(6000, 600 * attempt));
      continue;
    }
    last = await safeText(res);
    await sleep(300 + Math.floor(Math.random() * 400));
  }
  throw new Error(`Fetch failed: ${url} :: ${last || "Too many retries"}`);
}
async function safeText(r) { try { return await r.text(); } catch { return r.statusText; } }

function corsHeaders(env) {
  return {
    "access-control-allow-origin": (env.ALLOW_ORIGIN || "*").split(",")[0] || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-admin-secret",
  };
}
function makeCORS(env) {
  const headers = (extra = {}) => ({
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(env),
    ...extra,
  });
  return {
    json: (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: headers() }),
    cachedJson: (obj, status = 200, maxAge = 300) => new Response(JSON.stringify(obj), {
      status,
      headers: headers({ "cache-control": `public, max-age=${maxAge}` }),
    }),
    text: (t, status = 200) => new Response(t, { status, headers: headers({ "content-type": "text/plain; charset=utf-8" }) }),
    headers,
  };
}

/* ─── PUBLIC + ADMIN HTML ──────────────────────────────────────────────── */

// Site icons (favicon + iOS home-screen tile). Generated offline (Lora-Bold
// "LC" monogram on the warm ground inside the gold medallion ring) and
// embedded as base64 PNGs so the Worker can serve them with no extra assets.
const ICON_180_B64 = "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";
const ICON_32_B64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAHSElEQVR42sWXbYxcVRnHf+ec+7YzOzvdl+7stKVbaInKy/KiEAhUqkQIBhokakzEYEz4RDCkwRdijPEjkShokJigJhpikBgsiAZMpFgKShHJQqShQNlStrt0d3Znd17uveeec/xwZ2a3uywJn/okk8w9Oef8n9f/8xxBLgowW4eGtjlP3gnc5GAX4AGCNbJuoSNu4+VMwFvAkyKzv3i/VjvRxRTdP9XR4ZtBPCiF2OIA59w6UAdY53Au/xYiV8U5hwOEAClEb+9p5zvr1rlpcHec/GD+z4ASAJXK8E0K+UTnsqyjlOgCW8Bah+9JIl/iqRyiq6Po7MyMI9YWnVmkFMjTFXGAEUJ4AAa7d3Z2/kmxfWSkmgompWTEOUwHvCfGOkJf0h8pMmPJjCP0FYXIJ/Dzrak2tGJNog2eEnhK0ogNibYouS5gRgiUtcwFjglPS/ZJIUacc+vArXMM9vs4a4lTy/jYANsr/QSeopVkaGMB8JWkEHqkmeH4bIOpmSX6fEEh9FlsaqQ4TQnlHEZKMaKd2yeqo8NHQezsuEjmYcjdOlTyqTdTxitlLjhniNmFNkdPLDJfT0i0wdrcwVIKQl8xXA45d9smKoN9vP5OjanZOuViQG1Z9+7s2pZH170tqqMjpgu8WoZLPrXllKsmthD5igOvTlNvJoS+wlMyt0qsRNc6R2YsiTaUiyF7Lt5CrA2HJqcZKgXML+sPqxArqqMjpyWstY6RcsDCcsp1l48zU2tycHKGUp+HUrJn9UYipcAYy3I7Y/fEGGNDRZ55aYrBUsBcPUWuyYmeAgLIbB7zZqy58oItNFqa5187yWApxNg869eW51rwbmkKYLGRcPVElf4+nxdfn6YY+Sw0NJ4UveqQKwkHoS+x1rK9UiYKFAdefZ/AEzRaKa22Jk70hsAAS42EU7UGcwtN2okm8ATPvnKCvkCxvVLGWptjuDUe6Fo/XPKJteW6y8b5y4vHCH2f8eog7USjlMQYw7vTCz0rAZQUNNopoae44qJxzt85RqOV8Ozht6kOlzhxqs7iUpu9V53N04eniHzJ/PKKF7wuQ/iexBjLeGWAuXqb2VqL66/YxUM//DLD/RFBIeCR/f/hrvueoFgIsNahpGC5lXLxuVUe+MEtnDe+mWcPvwXA3d+4hmp1E7fd8wh/eHqSU/WY8coA06eW8L2VXJJd9/cFEm0cZ1X6OXJ8geFygYP/fZe77t1PYbjEkaMzfO/nfyWKPKx1SCFoJxk7qoM8dv9tfOLsUW6442FuvPM33HDHw3z3/qfwQp9EG8LA4+iJRc6q9KONoy9YCYMUHS5XEsJAEfqK+XqM70mcy6sCkedBZmyPVIQUtBPNvlt3s3nnGD/79T848PLbbK2U2TpaZv9z/+Ofzx8h9D08KZirx4S+IgwUSuaYohuCbkQLkU8rzkhSi++pVTzfzfCVxqK1oTpS4trLd+FqDQ69NkV/IURnOUFtKkV888ePYYxloBjSjjNacUYh8mm20x6m7F7oHARezvfWOYTYuNaFAG0slaESI4NFTDulvhzn1bAqw1vtlFRnCCl6RBV4qsOK4vQy/DgiEOjMkHaslZ4iCr2cI1Yp7nsSKT8aQnb7uRCQZqZHs10tuzUuRN7lQt+j3oj50e3XsqM6yBvHPoBygU/tGCVOM3xPoWSnI7bSHnfIzvk0MwixQmhy9STTijWFyCMMcq2TVLPUSDDOESeamfkG783WkVLwtRsuIc0Mv3/qFWTkc9vez9DfF3BybpnF5Zj3Ti5w8+fP54Hv7KXZTolCRSHyaMX6tOnJcx3rjAVjDIk2jGzqY/pUg51nDfP9b30OFflcuGuMh+75EtY5rrxwO1vP20boK371p39xzaVnc/NXruTvD93Og4++gLGO66/+JHsu28m+e/eTGcdIOSLRhiQ1KCXzvFvdC6QUFAPBls0DDA1EPPnCMfZcuoNv3/pZ6gtN/MCjVAwRQJxkJMbwy0dfYPLNk/i+4qtfmODrN36abZsHWG4mvHzkfX76u+d458Q8SnnsuaTK4nLK9KklmqnrEdEGVLydv/37OM22ptFOUFLinMN02auTG8W+oJPVjnozRgpBXxSgM0OzlVIqhkSBh5TwxSvGeebw8XVU3POAc+B7gsgXjA71c051gMcPHmO4HPWA1zVza3tzoVIrSkoBUkqEgNpSzC27z+Gdk0t8UGsQa4fOVsq8VyNSQKItUkqmZurE2nD1xBhzi21wDmPsut/qzmyMxdqc3cjHamr1mN0TVWJtmJqpI6XMMcSaMuyeUVKw2NCUiwGHJqcZGyqy+6IqC40U59y6YWKj1mydY6GRsvuiKmNDRQ5NTlMuBiw2NGrVLNDNgTM9kp35ofQnQoi7NxrLNxXzsVwbPtZY7isQUn7YWN55GwjlnLvvjD9MzvzT7Ew/TlW3AhvN9hvlMPqjkyIDhoBNnaQUay9SQuRAYgU0/xYf9Tx/E/itzOzt03O1l7qG/x8R6zFQxDg7owAAAABJRU5ErkJggg==";
function pngResponse(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: {
    "content-type": "image/png",
    "cache-control": "public, max-age=604800, immutable",
  }});
}

const PUBLIC_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>The Lineal Champ</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Lora:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<meta name="theme-color" content="#191614">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Lineal Champ">
<style>
  :root {
    /* Classical "Fight Night" design system — shared with the landing page so
       the whole site reads as one publication. Warm dark ground, gold accent
       ramp, hairline rules, serif display + serif body. */
    --font-display: "Cormorant Garamond", Georgia, serif;
    --font-body: "Lora", Georgia, serif;
    --bg: #191614;          /* ground */
    --bg-elev: #201b18;     /* lifted tile */
    --bg-card: #1f1a17;     /* card */
    --band: #120f0e;        /* deepest band (hero) */
    --text: #eae7e7;
    --text-dim: #9b9797;
    --border: rgba(230,225,215,0.16);   /* hairline */
    --accent: #e1ad66;      /* gold */
    --accent-soft: #facb8d;
    --accent-bright: #fff3e4;
    --accent-deep: #c28d41;
    --display: #faf6ef;
    --win: #7fb08a;
    --loss: #d98a6a;
    --r: 4px;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--text); margin: 0; }
  body { font: 16px/1.6 var(--font-body); min-height: 100vh; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 28px 20px 80px; }
  h1 { margin: 0 0 20px; font-family: var(--font-display); font-weight: 400;
       font-size: 40px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--display); }
  .tabs { display: flex; flex-direction: column; gap: 14px; margin-bottom: 20px; }
  .tabs-main { display: flex; gap: 6px; flex-wrap: wrap; }
  .tabs-sub  { display: flex; flex-direction: column; gap: 10px;
               padding: 14px 14px 12px; background: rgba(255,255,255,0.025);
               border: 1px solid var(--border); border-radius: 14px; }
  .wc-group { display: flex; flex-direction: column; gap: 6px; }
  .wc-heading { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
                color: var(--text-dim); }
  .wc-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .wc-row button { position: relative; }
  .wc-row button.soon { opacity: 0.55; }
  .wc-row .soon-tag { display: inline-block; margin-left: 6px; padding: 1px 6px;
                      font-size: 10px; letter-spacing: 0.06em; border-radius: 4px;
                      background: rgba(255,255,255,0.08); color: var(--text-dim); }
  .wc-lore { margin-top: 4px; }
  .lore-btn { width: 100%; padding: 10px 14px; font-size: 13px; cursor: pointer;
              background: linear-gradient(135deg, rgba(184,134,11,0.15), rgba(255,215,0,0.05));
              border: 1px solid rgba(184,134,11,0.35); border-radius: 10px;
              color: #f0d77a; letter-spacing: 0.02em; transition: all 0.15s; }
  .lore-btn:hover { border-color: #f0d77a; background: linear-gradient(135deg, rgba(184,134,11,0.25), rgba(255,215,0,0.1)); }
  /* "What if?" branch toggles — same gold accent as lore for visual family */
  .whatif-area { margin-top: 14px; margin-bottom: 4px; }
  .whatif-btn  { width: 100%; padding: 10px 14px; font-size: 13px; cursor: pointer;
                 background: linear-gradient(135deg, rgba(184,134,11,0.12), rgba(255,215,0,0.04));
                 border: 1px solid rgba(184,134,11,0.3); border-radius: 10px;
                 color: #f0d77a; letter-spacing: 0.02em; transition: all 0.15s; }
  .whatif-btn:hover { border-color: #f0d77a;
                      background: linear-gradient(135deg, rgba(184,134,11,0.22), rgba(255,215,0,0.08)); }
  .branch-banner { display: flex; align-items: center; gap: 10px;
                   padding: 10px 14px; margin: 12px 0;
                   background: linear-gradient(90deg, rgba(184,134,11,0.18), rgba(184,134,11,0.04));
                   border: 1px solid rgba(184,134,11,0.45);
                   border-radius: 10px; font-size: 13px; color: #f0d77a; }
  .branch-banner .banner-icon { font-size: 16px; flex-shrink: 0; }
  .branch-banner .banner-text { flex: 1; }
  .branch-banner .banner-reset {
    background: rgba(184,134,11,0.18); border: 1px solid rgba(184,134,11,0.5);
    color: #f0d77a; padding: 4px 10px; border-radius: 6px;
    cursor: pointer; font-size: 12px; }
  .branch-banner .banner-reset:hover { background: rgba(184,134,11,0.3); }
  .whatif-intro { margin-bottom: 18px; font-size: 14px; line-height: 1.55; color: var(--text); }
  .whatif-intro p { margin: 0 0 8px; }
  .whatif-list { display: flex; flex-direction: column; gap: 10px; }
  .whatif-row {
    display: flex; gap: 12px; padding: 12px;
    border: 1px solid var(--border); border-radius: 8px;
    align-items: flex-start; cursor: pointer; transition: background 0.1s; }
  .whatif-row:hover { background: rgba(255,255,255,0.025); }
  .whatif-row input { margin-top: 4px; flex-shrink: 0; cursor: pointer; }
  .whatif-text { flex: 1; min-width: 0; }
  .whatif-name { font-weight: 600; margin-bottom: 2px; }
  .whatif-summary { font-size: 11px; color: var(--text-dim);
                    margin-bottom: 6px; text-transform: uppercase;
                    letter-spacing: 0.06em; }
  .whatif-text p { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-dim); }
  .whatif-outcome { margin-top: 6px; font-size: 12px; color: #f0d77a; }
  .lore-intro { margin-bottom: 22px; font-size: 14px; line-height: 1.6; color: var(--text); }
  .lore-intro p { margin: 0 0 10px; }
  .lore-list { display: flex; flex-direction: column; gap: 22px; }
  .lore-moment { display: grid; grid-template-columns: auto 1fr; gap: 16px;
                 padding: 14px; border: 1px solid var(--border); border-radius: 10px;
                 background: rgba(255,255,255,0.02); }
  .lore-photos { display: flex; flex-direction: column; gap: 6px; }
  .lore-portrait { width: 64px; height: 64px; border-radius: 8px; object-fit: cover;
                   background: #2a2f3d; }
  .lore-portrait.fallback { display: flex; align-items: center; justify-content: center;
                            font-size: 11px; color: var(--text-dim); padding: 4px;
                            text-align: center; }
  .lore-text { min-width: 0; }
  .lore-year { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
               color: #f0d77a; margin-bottom: 2px; }
  .lore-title { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
  .lore-text p { margin: 0; line-height: 1.55; color: var(--text-dim); }
  @media (max-width: 600px) {
    .lore-moment { grid-template-columns: 1fr; }
    .lore-photos { flex-direction: row; }
  }
  .tabs button {
    padding: 8px 14px; border: 1px solid var(--border); background: var(--bg-elev);
    color: var(--text-dim); border-radius: 999px; cursor: pointer; font-weight: 600;
    font-size: 13px; letter-spacing: 0.02em; transition: all .15s;
  }
  .tabs button:hover { color: var(--text); border-color: #3a4252; }
  .tabs button.active { background: var(--accent); color: white; border-color: var(--accent); }
  .hero {
    border-radius: 20px; background: var(--bg-card); padding: 32px; margin-bottom: 16px;
    border: 1px solid var(--border); position: relative; overflow: hidden;
  }
  .hero .accent-bg {
    position: absolute; inset: 0; opacity: 0.18; pointer-events: none;
    background: linear-gradient(135deg, var(--champ-color, #4f6cf7) 0%, transparent 60%);
  }
  .hero .label { color: var(--text-dim); font-size: 12px; text-transform: uppercase;
    letter-spacing: 0.12em; font-weight: 600; margin-bottom: 8px; position: relative; }
  .hero .champ-row { display: flex; align-items: center; gap: 24px; position: relative; flex-wrap: wrap; }
  .hero .champ-logo { width: 120px; height: 120px; border-radius: 24px; background: var(--bg-elev);
    object-fit: contain; padding: 8px; border: 1px solid var(--border); flex-shrink: 0; }
  .hero .champ-logo.no-logo { display: none; }
  .hero .champ-text h2 { margin: 0; font-size: 44px; font-weight: 800; letter-spacing: -0.03em; line-height: 1; }
  .hero .champ-text .sub { color: var(--text-dim); margin-top: 6px; font-size: 14px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px; margin-top: 24px; position: relative; }
  .stat { background: var(--bg-elev); border: 1px solid var(--border); padding: 14px 16px; border-radius: 12px; }
  .stat.clickable { cursor: pointer; transition: border-color 0.15s, transform 0.05s; }
  .stat.clickable:hover { border-color: var(--accent); }
  .stat.clickable:active { transform: scale(0.98); }
  .stat .v { font-size: 22px; font-weight: 700; }
  .stat .k { color: var(--text-dim); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.08em; margin-top: 4px; }
  .stat .hint { color: var(--text-dim); font-size: 10px; margin-top: 6px; opacity: 0.5; }
  .about-link { display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border-radius: 999px; background: var(--bg-elev);
    border: 1px solid var(--border); color: var(--text-dim); font-size: 14px;
    font-weight: 700; cursor: pointer; margin-left: 12px; vertical-align: middle; padding: 0; }
  .about-link:hover { color: var(--text); border-color: var(--accent); }
  .about-body p { line-height: 1.65; margin: 0 0 12px; font-size: 14px; }
  .about-body h4 { margin: 18px 0 6px; font-size: 14px; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--text-dim); }
  .about-body ul { margin: 0 0 12px; padding-left: 20px; line-height: 1.65; font-size: 14px; }
  .modal-back { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 50;
    display: none; align-items: flex-start; justify-content: center; padding: 60px 16px;
    overflow-y: auto; }
  .modal-back.on { display: flex; }
  .modal { background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px;
    max-width: 720px; width: 100%; padding: 24px; }
  .modal h3 { margin: 0 0 4px; font-size: 20px; }
  .modal .modal-sub { color: var(--text-dim); font-size: 13px; margin-bottom: 16px; }
  .modal .close { float: right; background: none; border: none; color: var(--text-dim);
    font-size: 22px; cursor: pointer; line-height: 1; }
  .modal .close:hover { color: var(--text); }
  .modal-row { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border);
    font-size: 14px; }
  .modal-row:last-child { border-bottom: none; }
  .modal-row .when { color: var(--text-dim); min-width: 110px; font-size: 12px; }
  .modal-row .what { flex: 1; }
  .modal-row .score { color: var(--text-dim); font-size: 13px; }
  .modal-row.win .score { color: var(--win); }
  .modal-row.loss .score { color: var(--loss); }
  .rank-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .rank-table td, .rank-table th { padding: 8px 6px; border-bottom: 1px solid var(--border);
    text-align: left; }
  .rank-table th { color: var(--text-dim); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.08em; font-weight: 500; }
  .rank-table tr.me { background: rgba(45, 212, 191, 0.08); }
  .rank-table td.num { text-align: right; color: var(--text-dim); font-variant-numeric: tabular-nums; }
  .strip { margin-top: 8px; }
  .strip h3 { margin: 16px 0 8px; font-size: 13px; color: var(--text-dim);
    text-transform: uppercase; letter-spacing: 0.1em; }
  .strip-scroll { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 8px;
    scrollbar-width: thin; }
  .mini { flex: 0 0 auto; min-width: 220px; background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 12px; padding: 12px 14px; }
  .mini .when { color: var(--text-dim); font-size: 11px; margin-bottom: 6px; }
  .mini .who { font-weight: 700; }
  .mini .vs { color: var(--text-dim); }
  .mini .score { color: var(--loss); font-weight: 700; margin-top: 4px; font-size: 13px; }
  .controls { display: flex; align-items: center; gap: 12px; margin: 16px 0;
    flex-wrap: wrap; color: var(--text-dim); font-size: 13px; }
  .controls button { background: var(--bg-elev); border: 1px solid var(--border);
    color: var(--text); padding: 8px 14px; border-radius: 8px; cursor: pointer; }
  .controls button:hover { background: var(--bg-card); }
  .controls label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .timeline { display: none; }
  .timeline.open { display: block; margin-top: 16px; }
  .ev { display: flex; align-items: center; gap: 12px; padding: 10px 14px;
    border-bottom: 1px solid var(--border); }
  .ev:last-child { border-bottom: none; }
  .ev .pill { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .ev.win .pill { background: rgba(45, 212, 191, 0.15); color: var(--win); }
  .ev.loss .pill { background: rgba(248, 113, 113, 0.15); color: var(--loss); }
  .ev.change { background: rgba(248, 113, 113, 0.07); }
  .ev .date { color: var(--text-dim); font-size: 12px; min-width: 90px; }
  .ev .desc { flex: 1; }
  .ev .desc b { font-weight: 700; }
  .ask { margin-top: 24px; padding: 20px; background: var(--bg-card);
    border: 1px solid var(--border); border-radius: 16px; display: none; }
  .ask.on { display: block; }
  .ask input { width: 100%; padding: 12px 14px; background: var(--bg-elev);
    border: 1px solid var(--border); color: var(--text); border-radius: 10px;
    font-size: 14px; outline: none; }
  .ask input:focus { border-color: var(--accent); }
  .ask .answer { margin-top: 12px; padding: 14px; background: var(--bg-elev);
    border-radius: 10px; min-height: 20px; line-height: 1.6; }
  footer { margin-top: 32px; color: var(--text-dim); font-size: 12px; text-align: center; }
  footer a { color: var(--text-dim); }

  /* ── Classical "Fight Night" skin — makes the tracker match the landing.
     Palette/borders already cascade from the remapped :root tokens above;
     these rules add the serif display type, editorial pills, and plate/hairline
     treatments that give the tracker the same publication feel. ── */
  .tracker { position: relative; }
  .home-link { color: inherit; text-decoration: none; }
  .home-link:hover { color: var(--accent-soft); }
  .about-link { background: transparent; border: 1px solid var(--border); color: var(--text-dim); }
  .about-link:hover { color: var(--accent-soft); border-color: var(--accent); }

  /* Section tabs → editorial pills */
  .tabs button { background: transparent; border: 1px solid var(--border); color: var(--text-dim);
    border-radius: var(--r); text-transform: uppercase; letter-spacing: 0.1em;
    font-size: 12px; font-weight: 500; }
  .tabs button:hover { color: var(--accent-soft); border-color: rgba(225,173,102,0.5); }
  .tabs button.active { background: rgba(194,141,65,0.16); border-color: var(--accent);
    color: var(--accent-bright); }
  .tabs-sub { background: rgba(255,255,255,0.02); border-radius: var(--r); }
  .wc-heading { color: var(--text-dim); }
  .lore-btn, .whatif-btn { border-radius: var(--r); color: var(--accent-soft);
    border-color: rgba(225,173,102,0.35);
    background: linear-gradient(135deg, rgba(194,141,65,0.14), rgba(225,173,102,0.04)); }
  .lore-btn:hover, .whatif-btn:hover { border-color: var(--accent-soft);
    background: linear-gradient(135deg, rgba(194,141,65,0.24), rgba(225,173,102,0.08)); }

  /* Hero — current champion */
  .hero { background: var(--band); border: 1px solid var(--border); border-radius: var(--r); }
  .hero .accent-bg { opacity: 0.13; }
  .hero .label { color: var(--accent-soft); letter-spacing: 0.2em; }
  .hero .champ-text h2 { font-family: var(--font-display); font-weight: 500;
    font-size: 58px; letter-spacing: -0.01em; color: var(--display); }
  .hero .champ-logo { border-radius: var(--r); border: 1px solid var(--border);
    background: var(--bg-elev); }

  /* Stat tiles */
  .stat { background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--r); }
  .stat .v { font-family: var(--font-display); font-weight: 500; font-size: 30px; color: var(--display); }
  .stat.clickable:hover { border-color: var(--accent); }

  /* Recent belt changes strip */
  .strip h3 { color: var(--accent-soft); letter-spacing: 0.16em; }
  .mini { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--r); }
  .mini .who { font-family: var(--font-display); font-weight: 500; font-size: 19px; color: var(--display); }
  .mini .score { color: var(--loss); }

  /* Controls */
  .controls button { background: transparent; border: 1px solid var(--border); color: var(--text);
    border-radius: var(--r); text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; }
  .controls button:hover { background: transparent; border-color: var(--accent); color: var(--accent-soft); }

  /* Timeline of title fights */
  .ev .desc b { color: var(--display); }
  .ev.change { background: rgba(194,141,65,0.06); }
  .ev.win .pill { background: rgba(127,176,138,0.15); color: var(--win); }
  .ev.loss .pill { background: rgba(217,138,106,0.15); color: var(--loss); }

  /* Modals / rank tables */
  .modal { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--r); }
  .modal h3 { font-family: var(--font-display); font-weight: 500; font-size: 27px; color: var(--display); }
  .modal-row.win .score { color: var(--win); }
  .modal-row.loss .score { color: var(--loss); }
  .rank-table tr.me { background: rgba(225,173,102,0.09); }
  .lore-year, .whatif-outcome { color: var(--accent-soft); }
  .lore-title, .whatif-name { font-family: var(--font-display); font-weight: 500; color: var(--display); }
  .branch-banner, .branch-banner .banner-reset { color: var(--accent-soft); }

  /* Ask panel */
  .ask { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--r); }
  .ask input:focus { border-color: var(--accent); }

  /* Site footer */
  footer { color: var(--text-dim); }
  footer a { color: var(--accent-soft); }

  /* Landing / tracker show-hide */
  .landing { display: none; }
  .landing.on { display: block; }
  .tracker { display: none; }
  .tracker.on { display: block; }
  /* The redesigned landing (below) runs full-bleed: neutralize the wrap's
     max-width/padding and hide the shared footer while it is showing. */
  .wrap:has(.landing.on) { max-width: none; padding: 0; }
  .landing.on ~ footer { display: none; }
  body:has(.landing.on) { background: #191614; }

  /* ── Landing page — "Fight Night" (Classical design system) ── */
  .lc {
    --font-heading: "Cormorant Garamond", Georgia, serif;
    --font-body: "Lora", Georgia, serif;
    --accent-100:#fff3e4; --accent-200:#ffe3bf; --accent-300:#facb8d;
    --accent-400:#e1ad66; --accent-500:#c28d41; --accent-600:#a06f24; --accent-700:#7d5411;
    --n-100:#f8f4f4; --n-200:#eae7e7; --n-300:#d7d3d3; --n-400:#bab6b6;
    --n-500:#9b9797; --n-600:#7d7979;
    --ground:#191614; --band:#120f0e; --display:#faf6ef;
    --hair:rgba(230,225,215,0.16);
    --surface:#eae9e9; --surface-hair:rgba(32,31,29,0.16);
    --sp3:13.8px; --sp4:18.4px; --sp6:27.6px; --sp8:36.8px; --r:4px;
    max-width:1280px; margin:0 auto; background:var(--ground); color:var(--n-200);
    font-family:var(--font-body); -webkit-font-smoothing:antialiased;
  }
  .lc * { box-sizing:border-box; }
  .lc a { text-decoration:none; color:inherit; }
  .lc :focus-visible { outline:2px solid var(--accent-400); outline-offset:2px; }
  .lc-header { display:flex; align-items:center; justify-content:space-between;
    padding:18px 56px; border-bottom:1px solid var(--hair); }
  .lc-brand { display:flex; align-items:center; gap:12px; }
  .lc-mark { width:20px; height:20px; border:1px solid var(--accent-400); border-radius:50%;
    box-shadow:inset 0 0 0 3px var(--ground), inset 0 0 0 4px rgba(225,173,102,.55); }
  .lc-wordmark { font-family:var(--font-heading); font-size:19px; letter-spacing:.14em;
    text-transform:uppercase; color:var(--n-100); }
  .lc-nav { display:flex; gap:28px; font-size:13px; letter-spacing:.09em; text-transform:uppercase; }
  .lc-nav a { color:var(--n-400); transition:color .15s ease; }
  .lc-nav a:hover { color:var(--accent-300); }
  .lc-nav a.lc-nav-cta { color:var(--accent-300); }
  .lc-nav a.lc-nav-cta:hover { color:var(--accent-100); }
  .lc-hero { padding:76px 56px 60px; text-align:center; position:relative; overflow:hidden; }
  .lc-glow { position:absolute; top:-140px; left:50%; transform:translateX(-50%);
    width:820px; height:420px; pointer-events:none;
    background:radial-gradient(ellipse at center, rgba(194,141,65,.16), transparent 62%); }
  .lc-hero-inner { position:relative; display:flex; flex-direction:column; align-items:center; gap:var(--sp6); }
  .lc-medallion { width:86px; height:86px; border:1px solid var(--accent-500); border-radius:50%;
    display:flex; align-items:center; justify-content:center;
    box-shadow:inset 0 0 0 1px rgba(225,173,102,.25), inset 0 0 0 7px var(--ground), inset 0 0 0 8px rgba(225,173,102,.45); }
  .lc-medallion span { font-family:var(--font-heading); font-size:26px; color:var(--accent-300); letter-spacing:.02em; font-feature-settings:'tnum'; }
  .lc-kicker { font-size:12px; letter-spacing:.26em; text-transform:uppercase; color:var(--accent-300); }
  .lc-h1 { margin:0; font-family:var(--font-heading); font-weight:400; font-size:104px;
    line-height:.98; letter-spacing:-.015em; color:var(--display); max-width:15ch; text-wrap:balance; }
  .lc-lede { margin:0; max-width:62ch; font-size:19px; line-height:1.7; color:var(--n-300); text-wrap:pretty; }
  .lc-picklabel { display:flex; align-items:center; gap:var(--sp3); margin-top:9px; }
  .lc-picklabel span:first-child, .lc-picklabel span:last-child { width:60px; height:1px; background:rgba(225,173,102,.5); }
  .lc-picklabel .t { font-size:12px; letter-spacing:.2em; text-transform:uppercase; color:var(--n-500); }
  .lc-pick { display:flex; gap:10px; flex-wrap:wrap; justify-content:center; max-width:900px; }
  .lc-btn { padding:11px 26px; border:1px solid rgba(225,173,102,.55); border-radius:var(--r);
    color:var(--accent-200); font-size:14px; letter-spacing:.13em; text-transform:uppercase;
    transition:background-color .15s ease, border-color .15s ease, color .15s ease; }
  .lc-btn:hover { background:rgba(194,141,65,.14); border-color:var(--accent-300); color:var(--accent-100); }
  .lc-btn--boxing { border-color:var(--accent-400); background:rgba(194,141,65,.16); color:var(--accent-100); }
  .lc-btn--boxing:hover { background:rgba(194,141,65,.26); border-color:var(--accent-300); }
  .lc-rule { height:1px; background:var(--hair); }
  .lc-explainer { display:grid; grid-template-columns:1fr 1fr 1fr; padding:56px 56px 52px; }
  .lc-col { padding-right:40px; }
  .lc-col + .lc-col { padding:0 40px; border-left:1px solid var(--hair); }
  .lc-col + .lc-col + .lc-col { padding:0 0 0 40px; }
  .lc-numeral { font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:var(--accent-300); margin-bottom:14px; font-feature-settings:'tnum'; }
  .lc-h3 { margin:0 0 12px; font-family:var(--font-heading); font-weight:500; font-size:30px; line-height:1.15; color:var(--display); }
  .lc-body { margin:0; font-size:15px; line-height:1.75; color:var(--n-400); text-align:justify; hyphens:auto; }
  .lc-line { padding:56px; }
  .lc-line-head { display:flex; align-items:baseline; justify-content:space-between; margin-bottom:var(--sp6); }
  .lc-line-head h2 { margin:0; font-family:var(--font-heading); font-weight:400; font-size:44px; color:var(--display); }
  .lc-line-meta { font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:var(--n-500); font-feature-settings:'tnum'; }
  .lc-portraits { display:grid; grid-template-columns:repeat(7,1fr); gap:18px; }
  .lc-fig { display:flex; flex-direction:column; gap:10px; }
  .lc-plate { padding:6px; filter:sepia(.22) saturate(.82) contrast(1.05);
    border:6px solid var(--surface); outline:1px solid var(--surface-hair); background:var(--surface); }
  .lc-plate img { display:block; width:100%; aspect-ratio:3/4; object-fit:cover; object-position:top; }
  .lc-fig .nm { font-family:var(--font-heading); font-size:17px; color:var(--display); line-height:1.2; }
  .lc-fig .yr { font-size:12px; letter-spacing:.12em; color:var(--accent-300); font-feature-settings:'tnum'; }
  .lc-line-foot { display:flex; align-items:center; margin-top:22px; }
  .lc-line-foot span:first-child { flex:1; height:1px; background:linear-gradient(90deg, rgba(225,173,102,.15), rgba(225,173,102,.6)); }
  .lc-line-foot .note { padding-left:14px; font-size:13px; color:var(--n-500); font-style:italic; }
  .lc-quotewrap { padding:0 56px 56px; }
  .lc-quote { border-top:1px solid var(--hair); border-bottom:1px solid var(--hair); padding:44px 0; text-align:center; }
  .lc-quote p { margin:0 auto; max-width:24ch; font-family:var(--font-heading); font-weight:300; font-style:italic; font-size:48px; line-height:1.2; color:var(--display); }
  .lc-quote .attr { margin-top:18px; font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:var(--accent-300); }
  .lc-cover { padding:0 56px 56px; }
  .lc-cover h2 { margin:0 0 var(--sp4); font-family:var(--font-heading); font-weight:400; font-size:44px; color:var(--display); }
  .lc-cover-grid { display:grid; grid-template-columns:repeat(2,1fr); column-gap:56px; }
  .lc-cover-row { display:flex; justify-content:space-between; align-items:baseline; padding:14px 0; border-bottom:1px solid var(--hair); }
  .lc-cover-row .lg { font-family:var(--font-heading); font-size:22px; color:var(--display); }
  .lc-cover-row .since { font-size:13px; color:var(--n-500); font-feature-settings:'tnum'; }
  .lc-cover-row .vac { font-size:14px; color:var(--n-500); font-style:italic; }
  .lc-cover-row .why { font-size:13px; letter-spacing:.12em; text-transform:uppercase; color:var(--accent-300); }
  .lc-band { background:var(--band); padding:52px 56px 60px; border-top:1px solid var(--hair);
    display:flex; align-items:center; justify-content:space-between; gap:var(--sp8); }
  .lc-band .txt { max-width:52ch; }
  .lc-band h2 { margin:0 0 10px; font-family:var(--font-heading); font-weight:400; font-size:40px; color:var(--display); }
  .lc-band p { margin:0; font-size:16px; line-height:1.7; color:var(--n-400); }
  .lc-cta { flex-shrink:0; padding:16px 34px; border:1px solid var(--accent-400); border-radius:var(--r);
    color:var(--accent-100); font-size:15px; letter-spacing:.14em; text-transform:uppercase;
    transition:background-color .15s ease, border-color .15s ease; }
  .lc-cta:hover { background:rgba(194,141,65,.2); border-color:var(--accent-300); }
  .lc-footer { padding:22px 56px; border-top:1px solid var(--hair); display:flex; justify-content:space-between; font-size:12px; color:var(--n-600); letter-spacing:.08em; }
  .lc-footer a { color:var(--n-600); }
  .lc-footer .r { display:flex; gap:20px; }
  @media (max-width:600px) {
    .lc-header { padding:14px 20px; }
    .lc-nav { display:none; }
    .lc-hero { padding:40px 20px 36px; }
    .lc-hero-inner { gap:20px; }
    .lc-medallion { width:66px; height:66px; box-shadow:inset 0 0 0 1px rgba(225,173,102,.25), inset 0 0 0 5px var(--ground), inset 0 0 0 6px rgba(225,173,102,.45); }
    .lc-medallion span { font-size:21px; }
    .lc-h1 { font-size:50px; line-height:1; }
    .lc-lede { font-size:16px; line-height:1.65; }
    .lc-pick { display:grid; grid-template-columns:1fr 1fr; gap:8px; width:100%; }
    .lc-btn { padding:14px 0; text-align:center; font-size:13px; letter-spacing:.12em; }
    .lc-btn--boxing { grid-column:1 / -1; }
    .lc-explainer { grid-template-columns:1fr; padding:36px 20px; gap:32px; }
    .lc-col, .lc-col + .lc-col, .lc-col + .lc-col + .lc-col { padding:0; border-left:0; }
    .lc-line { padding:36px 20px; }
    .lc-portraits { grid-template-columns:repeat(3,1fr); gap:12px; }
    .lc-line-head { flex-direction:column; align-items:flex-start; gap:8px; }
    .lc-line-head h2 { font-size:32px; }
    .lc-quotewrap { padding:0 20px 36px; }
    .lc-quote p { font-size:30px; }
    .lc-cover { padding:0 20px 36px; }
    .lc-cover-grid { grid-template-columns:1fr; column-gap:0; }
    .lc-cover h2, .lc-band h2 { font-size:30px; }
    .lc-band { flex-direction:column; align-items:flex-start; padding:36px 20px 44px; gap:24px; }
    .lc-footer { padding:18px 20px; flex-direction:column; gap:10px; }
  }

  @media (max-width: 600px) {
    .hero { padding: 20px; }
    .hero .champ-text h2 { font-size: 32px; }
    .hero .champ-logo { width: 80px; height: 80px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="landing" id="landing"><div class="lc">

    <header class="lc-header">
      <a class="lc-brand" href="/"><span class="lc-mark"></span><span class="lc-wordmark">The Lineal Champ</span></a>
      <nav class="lc-nav">
        <a href="#story">The Rule</a>
        <a href="#line">The Line</a>
        <a href="#cover">Coverage</a>
        <a class="lc-nav-cta" href="?l=BOXHW">Boxing &rarr;</a>
      </nav>
    </header>

    <section class="lc-hero">
      <div class="lc-glow"></div>
      <div class="lc-hero-inner">
        <div class="lc-medallion"><span>1882</span></div>
        <div class="lc-kicker">The man who beat the man</div>
        <h1 class="lc-h1">One belt. Every game. No committee.</h1>
        <p class="lc-lede">In boxing, the lineal title only moves when the champion is beaten. We took that rule and ran it through every game ever played in six leagues — first game to last night. Whoever is holding the belt when the music stops is the champion, and nobody voted for them.</p>
        <div class="lc-picklabel"><span></span><span class="t">Pick a sport</span><span></span></div>
        <div class="lc-pick" id="pick">
          <a class="lc-btn" href="?l=NBA">NBA</a>
          <a class="lc-btn" href="?l=NFL">NFL</a>
          <a class="lc-btn" href="?l=MLB">MLB</a>
          <a class="lc-btn" href="?l=NHL">NHL</a>
          <a class="lc-btn" href="?l=EPL">EPL</a>
          <a class="lc-btn" href="?l=CFB">CFB</a>
          <a class="lc-btn lc-btn--boxing" href="?l=BOXHW">Boxing &middot; 8 divisions</a>
        </div>
      </div>
    </section>

    <div class="lc-rule"></div>

    <section class="lc-explainer" id="story">
      <div class="lc-col">
        <div class="lc-numeral">I. The rule</div>
        <h3 class="lc-h3">A title changes hands one way.</h3>
        <p class="lc-body">The reigning champion has to lose it in the ring. Not stripped. Not vacated. Not voted into existence by an alphabet body. If you want the belt, you go and beat the man who beat the man — and if he never loses, nobody else ever holds it.</p>
      </div>
      <div class="lc-col">
        <div class="lc-numeral">II. The origin</div>
        <h3 class="lc-h3">Bare knuckles, 1880s.</h3>
        <p class="lc-body">Before sanctioning bodies existed, the heavyweight championship was simply a list of names in order. Sullivan, then Corbett, then Fitzsimmons. When the WBC, WBA, IBF and WBO splintered the official title, the lineal championship became the one that could not be manufactured on paper.</p>
      </div>
      <div class="lc-col">
        <div class="lc-numeral">III. The experiment</div>
        <h3 class="lc-h3">Now do it to the NBA.</h3>
        <p class="lc-body">We seed a team in each league's first season and walk forward, game by game. Holder wins, holder keeps. Holder loses, the winner takes it. Ties change nothing. It is not a claim about who is best — lineage is path-dependent, and that is the whole charm of it.</p>
      </div>
    </section>

    <div class="lc-rule"></div>

    <section class="lc-line" id="line">
      <div class="lc-line-head">
        <h2>The line, unbroken</h2>
        <span class="lc-line-meta">Heavyweight &middot; 1891 &rarr; today</span>
      </div>
      <div class="lc-portraits">
        <div class="lc-fig"><div class="lc-plate"><img src="https://upload.wikimedia.org/wikipedia/commons/thumb/3/30/Robert_Fitzsimmons.jpg/500px-Robert_Fitzsimmons.jpg" alt="Bob Fitzsimmons"/></div><div class="nm">Fitzsimmons</div><div class="yr">1897</div></div>
        <div class="lc-fig"><div class="lc-plate"><img src="https://upload.wikimedia.org/wikipedia/commons/thumb/3/37/James_J_Jeffries.jpg/500px-James_J_Jeffries.jpg" alt="James J. Jeffries"/></div><div class="nm">Jeffries</div><div class="yr">1899</div></div>
        <div class="lc-fig"><div class="lc-plate"><img src="https://upload.wikimedia.org/wikipedia/commons/thumb/b/b1/Jack_Johnson%2C_1915_%28edit%29.jpg/500px-Jack_Johnson%2C_1915_%28edit%29.jpg" alt="Jack Johnson"/></div><div class="nm">Johnson</div><div class="yr">1908</div></div>
        <div class="lc-fig"><div class="lc-plate"><img src="https://upload.wikimedia.org/wikipedia/commons/thumb/3/30/Joe_Louis_by_van_Vechten.jpg/500px-Joe_Louis_by_van_Vechten.jpg" alt="Joe Louis"/></div><div class="nm">Louis</div><div class="yr">1937</div></div>
        <div class="lc-fig"><div class="lc-plate"><img src="https://upload.wikimedia.org/wikipedia/commons/thumb/e/e7/Rocky_Marciano_%28cropped%29.jpg/500px-Rocky_Marciano_%28cropped%29.jpg" alt="Rocky Marciano"/></div><div class="nm">Marciano</div><div class="yr">1952</div></div>
        <div class="lc-fig"><div class="lc-plate"><img src="https://upload.wikimedia.org/wikipedia/commons/thumb/8/89/Muhammad_Ali_NYWTS.jpg/500px-Muhammad_Ali_NYWTS.jpg" alt="Muhammad Ali"/></div><div class="nm">Ali</div><div class="yr">1964</div></div>
        <div class="lc-fig"><div class="lc-plate"><img src="https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Tyson_Fury_at_Place_Bell%2C_Laval_Quebec%2C_Canada_-_Dec_16_2017_%28cropped%29.jpg/500px-Tyson_Fury_at_Place_Bell%2C_Laval_Quebec%2C_Canada_-_Dec_16_2017_%28cropped%29.jpg" alt="Tyson Fury"/></div><div class="nm">Fury</div><div class="yr">2015</div></div>
      </div>
      <div class="lc-line-foot"><span></span><span class="note">…and 30 more names between them. Every transfer is on the record.</span></div>
    </section>

    <div class="lc-quotewrap">
      <div class="lc-quote">
        <p>&ldquo;To be the man, you've got to beat the man.&rdquo;</p>
        <div class="attr">Ric Flair, paraphrasing a century of boxing</div>
      </div>
    </div>

    <section class="lc-cover" id="cover">
      <h2>What we cover</h2>
      <div class="lc-cover-grid">
        <div>
          <div class="lc-cover-row"><span class="lg">NBA</span><span class="since">1947 &mdash; BAA inaugural season</span></div>
          <div class="lc-cover-row"><span class="lg">NFL</span><span class="since">1933 &mdash; first Championship Game</span></div>
          <div class="lc-cover-row"><span class="lg">MLB</span><span class="since">1871 &mdash; National Association</span></div>
          <div class="lc-cover-row"><span class="lg">NHL</span><span class="since">1917 &mdash; league founding</span></div>
        </div>
        <div>
          <div class="lc-cover-row"><span class="lg">EPL</span><span class="since">1992 &mdash; Premier League formation</span></div>
          <div class="lc-cover-row"><span class="lg">CFB</span><span class="since">1869 &mdash; first college football game</span></div>
          <div class="lc-cover-row"><span class="lg">Boxing</span><span class="since">1882 &mdash; the classic eight divisions</span></div>
          <div class="lc-cover-row"><span class="vac">Some divisions currently read vacant — honestly.</span><a class="why" href="?l=BOXWW">Why &rarr;</a></div>
        </div>
      </div>
    </section>

    <section class="lc-band">
      <div class="txt">
        <h2>Start with boxing.</h2>
        <p>It is where the idea comes from — eight divisions, the lore of every famous night, and a &ldquo;what if?&rdquo; switch that lets you break the chain at Marciano's retirement and watch the lineage rewrite itself.</p>
      </div>
      <a class="lc-cta" href="?l=BOXHW">Enter the tracker</a>
    </section>

    <footer class="lc-footer">
      <span>The Lineal Champ &middot; thelinealchamp.com</span>
      <span class="r"><a href="?l=NBA">Sources</a><a href="#story">About</a></span>
    </footer>

  </div></div>

  <div class="tracker" id="tracker">
  <h1><a href="/" class="home-link" title="Back to home">The Lineal Champ</a> <button id="aboutBtn" class="about-link" title="About">?</button></h1>
  <div class="tabs" id="tabs"></div>
  <div class="branch-banner" id="branchBanner" style="display:none">
    <span class="banner-icon">🔀</span>
    <span class="banner-text" id="branchBannerText">Alternate timeline active</span>
    <button class="banner-reset" id="branchReset" type="button">Reset to canonical</button>
  </div>
  <div class="hero" id="hero">
    <div class="accent-bg"></div>
    <div class="label" id="heroLabel">Current Lineal Champion</div>
    <div class="champ-row">
      <img id="champLogo" class="champ-logo no-logo" alt=""/>
      <div class="champ-text">
        <h2 id="champName">—</h2>
        <div class="sub" id="champSub">Loading…</div>
      </div>
    </div>
    <div class="stats" id="statsGrid"></div>
  </div>

  <div class="whatif-area" id="whatifArea" style="display:none">
    <button class="whatif-btn" id="whatifBtn" type="button">🤔 What if? — explore alternate timelines</button>
  </div>

  <div class="strip">
    <h3>Recent Belt Changes</h3>
    <div class="strip-scroll" id="strip"></div>
  </div>

  <div class="controls">
    <button id="toggleTimeline">Show all title fights</button>
    <label><input type="checkbox" id="onlyChanges"/> Only belt changes</label>
    <button id="toggleAsk">Ask</button>
    <span id="meta" style="margin-left:auto"></span>
  </div>

  <div class="timeline" id="timeline"></div>

  <div class="ask" id="askPanel">
    <input id="askInput" placeholder="Ask anything about this league…"/>
    <div class="answer" id="askAnswer"></div>
  </div>

  <div class="modal-back" id="modalBack">
    <div class="modal" id="modal">
      <button class="close" id="modalClose" aria-label="Close">×</button>
      <h3 id="modalTitle">—</h3>
      <div class="modal-sub" id="modalSub"></div>
      <div id="modalBody"></div>
    </div>
  </div>

  </div><!-- /tracker -->
  <footer><a href="/" id="aboutLink">about</a> · <a href="/admin">admin</a></footer>
</div>

<script>
(function(){
  var PALETTE = ['#c28d41','#a06f24','#b5793a','#caa25e','#9c6b2e','#d9a441','#8a6a3b'];
  function colorFor(s){ var h=0; for(var i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))|0; return PALETTE[Math.abs(h)%PALETTE.length]; }

  var LEAGUES = ['NBA','NFL','MLB','NHL','EPL','CFB','BOX'];
  var LEAGUE_LABELS = { BOX: 'Boxing' };

  // Boxing weight-class registry. ready:true means we have lineage data
  // in KV; ready:false renders a "Coming soon" placeholder.
  // The classic eight divisions — the only ones we carry complete lineages
  // for. (Super/tweener divisions and women's divisions were placeholders with
  // no data and were removed rather than shown as permanent "coming soon".)
  var WEIGHT_CLASSES = [
    { code: 'BOXHW',   label: 'Heavyweight',       ready: true, group: "men's" },
    { code: 'BOXLHW',  label: 'Light Heavyweight', ready: true, group: "men's" },
    { code: 'BOXMW',   label: 'Middleweight',      ready: true, group: "men's" },
    { code: 'BOXWW',   label: 'Welterweight',      ready: true, group: "men's" },
    { code: 'BOXLW',   label: 'Lightweight',       ready: true, group: "men's" },
    { code: 'BOXFW',   label: 'Featherweight',     ready: true, group: "men's" },
    { code: 'BOXBW',   label: 'Bantamweight',      ready: true, group: "men's" },
    { code: 'BOXFLW',  label: 'Flyweight',         ready: true, group: "men's" },
  ];
  var WC_BY_CODE = {}; WEIGHT_CLASSES.forEach(function(w){ WC_BY_CODE[w.code] = w; });
  function isBoxingCode(c){ return !!WC_BY_CODE[c]; }
  function isBoxingActive(){ return league === 'BOX' || isBoxingCode(league); }
  function activeWeightClass(){
    if (isBoxingCode(league)) return league;
    return 'BOXHW'; // default when "BOX" hub is selected
  }

  var SHOW_LANDING = !new URLSearchParams(location.search).get('l');
  var league = (new URLSearchParams(location.search).get('l') || 'NBA').toUpperCase();
  // Map old BOXHW-direct links to the new "BOX" hub view defaulting to HW.
  if (league === 'BOX') league = 'BOXHW';
  var KNOWN = LEAGUES.concat(WEIGHT_CLASSES.map(function(w){ return w.code; }));
  if (KNOWN.indexOf(league) < 0) league = 'NBA';
  // Direct link to a not-yet-curated weight class → fall back to HW so the
  // tracker still loads. The sub-tab row will surface "Coming soon" hints.
  if (WC_BY_CODE[league] && !WC_BY_CODE[league].ready) league = 'BOXHW';

  var BRAND = {}, DATA = null, EVENTS = null;

  function el(id){ return document.getElementById(id); }

  function renderTabs(){
    // Main row: 6 sports + a single "Boxing" pill.
    var mainHtml = LEAGUES.map(function(L){
      var label = LEAGUE_LABELS[L] || L;
      var isActive = (L === 'BOX') ? isBoxingActive() : (L === league);
      // Boxing's click target is BOXHW (default weight class).
      var dataL = (L === 'BOX') ? 'BOXHW' : L;
      return '<button data-l="'+dataL+'" '+(isActive?'class="active"':'')+'>'+label+'</button>';
    }).join('');
    // Weight-class sub-row (boxing-only).
    var subHtml = '';
    if (isBoxingActive()) {
      var active = activeWeightClass();
      var pills = WEIGHT_CLASSES.map(function(w){
        var cls = [];
        if (w.code === active) cls.push('active');
        if (!w.ready) cls.push('soon');
        return '<button class="'+cls.join(' ')+'" data-l="'+w.code+'">'+w.label
          + (w.ready ? '' : '<span class="soon-tag">soon</span>')
          + '</button>';
      }).join('');
      subHtml =
        '<div class="wc-group"><div class="wc-heading">Divisions</div>'
        + '<div class="wc-row">' + pills + '</div></div>'
        + '<div class="wc-lore">'
        + '<button id="boxingLoreBtn" class="lore-btn">📜 The Lore of the Lineal Championship</button>'
        + '</div>';
    }
    el('tabs').innerHTML = '<div class="tabs-main">' + mainHtml + '</div>'
      + (subHtml ? '<div class="tabs-sub">' + subHtml + '</div>' : '');

    // Wire clicks for both rows.
    el('tabs').querySelectorAll('button[data-l]').forEach(function(b){
      b.addEventListener('click', function(){
        var L = b.getAttribute('data-l');
        var wc = WC_BY_CODE[L];
        if (wc && !wc.ready) {
          showComingSoon(wc);
          return;
        }
        league = L;
        history.replaceState(null, '', '?l='+league);
        renderTabs(); EVENTS = null; load();
      });
    });
    var loreBtn = el('boxingLoreBtn');
    if (loreBtn) loreBtn.addEventListener('click', openBoxingLore);
  }

  // Famous moments in the heavyweight lineal chain. Champion codes link to
  // entries in BRAND so their portraits render without extra network calls.
  var LORE_MOMENTS = [
    {
      year: 1882, date: 'Feb 7, 1882', title: 'The first king',
      who: ['SULLIVAN'],
      text: 'John L. Sullivan defeats Paddy Ryan under London Prize Ring rules. He is the last great bare-knuckle champion and the first heavyweight whose reign carries forward into the modern, gloved era — the seed of every lineal heavyweight title that follows.',
    },
    {
      year: 1889, date: 'Jul 8, 1889', title: 'The end of bare-knuckle',
      who: ['SULLIVAN'],
      text: 'Sullivan beats Jake Kilrain in the 75th round under a Mississippi sun. It is the last bare-knuckle world heavyweight title fight. From here on, the championship is contested with gloves under the Marquess of Queensberry Rules.',
    },
    {
      year: 1892, date: 'Sep 7, 1892', title: 'A new era',
      who: ['CORBETT', 'SULLIVAN'],
      text: '"Gentleman Jim" Corbett knocks out Sullivan in the 21st round in New Orleans — the first gloved world heavyweight title fight. A scientific boxer dethrones a slugger, and the modern heavyweight era begins.',
    },
    {
      year: 1908, date: 'Dec 26, 1908', title: 'The world changes',
      who: ['JOHNSON', 'BURNS'],
      text: 'Jack Johnson chases Tommy Burns to Sydney, Australia, and stops him in the 14th to become the first Black world heavyweight champion. The fight is so racially charged that promoters cut the film just before the knockout.',
    },
    {
      year: 1910, date: 'Jul 4, 1910', title: 'The Great White Hope',
      who: ['JOHNSON'],
      text: 'James J. Jeffries comes out of retirement to "regain the title for the white race." Johnson dismantles him in 15 rounds in Reno. The aftermath sets off race riots across the United States.',
    },
    {
      year: 1921, date: 'Jul 2, 1921', title: 'The first million-dollar gate',
      who: ['DEMPSEY'],
      text: 'Jack Dempsey vs Georges Carpentier in Jersey City draws boxing’s first $1M+ live gate. Radio broadcasts the fight for the first time. The Roaring Twenties have a heavyweight champion.',
    },
    {
      year: 1938, date: 'Jun 22, 1938', title: 'A nation’s revenge',
      who: ['JOELOUIS', 'SCHMELING'],
      text: 'Joe Louis avenges his 1936 loss to Max Schmeling — the Nazi regime’s symbol — in 124 seconds at Yankee Stadium. The fight is broadcast in four languages to a global audience. Louis is treated as an American hero overnight.',
    },
    {
      year: 1956, date: 'Apr 27, 1956', title: 'Marciano walks away',
      who: ['MARCIANO'],
      text: 'Rocky Marciano retires at 49-0 — the only heavyweight champion ever to leave undefeated. For strict lineal purists, this breaks the chain forever. The Ring magazine restarts it later that year with Floyd Patterson.',
    },
    {
      year: 1964, date: 'Feb 25, 1964', title: '"Shook up the world"',
      who: ['MUHAMMADALI', 'LISTON'],
      text: '22-year-old Cassius Clay, a 7-1 underdog, retires Sonny Liston on his stool after the 6th round in Miami Beach. The next morning, he announces his conversion to Islam and his new name: Muhammad Ali.',
    },
    {
      year: 1971, date: 'Mar 8, 1971', title: 'Fight of the Century',
      who: ['FRAZIER', 'MUHAMMADALI'],
      text: 'Two undefeated heavyweight champions — Ali returning from his draft-related exile, Frazier holding the title in his absence — meet at Madison Square Garden. Frazier drops Ali in the 15th. He hands Ali his first professional loss and settles who is the lineal champion.',
    },
    {
      year: 1974, date: 'Oct 30, 1974', title: 'Rumble in the Jungle',
      who: ['MUHAMMADALI', 'FOREMAN'],
      text: 'Ali, 32 and a heavy underdog, reclaims the lineal title from George Foreman in Kinshasa, Zaire, at 4am local time. He absorbs everything Foreman has for seven rounds on the ropes, then knocks him out in the 8th. The "rope-a-dope" is born.',
    },
    {
      year: 1975, date: 'Oct 1, 1975', title: 'Thrilla in Manila',
      who: ['MUHAMMADALI', 'FRAZIER'],
      text: 'Ali vs Frazier III: 14 rounds of brutal trench warfare in 100-degree heat. Frazier’s corner stops the fight before the 15th. Both fighters say later that they nearly died in the ring. Neither is the same again.',
    },
    {
      year: 1990, date: 'Feb 11, 1990', title: 'The Tokyo Upset',
      who: ['DOUGLAS', 'TYSON'],
      text: '42-1 underdog James "Buster" Douglas knocks out the seemingly invincible Mike Tyson in the 10th round. Tyson’s trainers had no ice for the swelling under his eye between rounds. Considered by many the biggest upset in sports history.',
    },
    {
      year: 1997, date: 'Jun 28, 1997', title: 'The Bite Fight',
      who: ['HOLYFIELD', 'TYSON'],
      text: 'Tyson is disqualified for biting both of Evander Holyfield’s ears. Holyfield retains his WBA crown and, by extension, keeps his place in the lineal conversation. Tyson never regains the stature he had before this night.',
    },
    {
      year: 2011, date: 'Jul 2, 2011', title: 'A unifier at last',
      who: ['KLITSCHKOWLAD'],
      text: 'Seven years after Lennox Lewis retires undefeated, the heavyweight division finally has a consensus champion again: Wladimir Klitschko beats David Haye to hold WBA, WBO, and IBF simultaneously. His reign will run 9.5 years and include 18 successful defenses.',
    },
    {
      year: 2015, date: 'Nov 28, 2015', title: 'The Gypsy King',
      who: ['FURY', 'KLITSCHKOWLAD'],
      text: 'Tyson Fury, 6’9", outpoints Wladimir Klitschko in Düsseldorf, ending Klitschko’s decade at the top. Within a year, Fury vacates the belts during a public battle with mental illness and addiction. He doesn’t lose in the ring — the lineal title goes with him.',
    },
    {
      year: 2020, date: 'Feb 22, 2020', title: 'The comeback',
      who: ['FURY'],
      text: 'After three years away from boxing, Fury stops Deontay Wilder in the 7th round in Las Vegas. The hiatus is over. The lineal heavyweight champion is back where he never officially left.',
    },
    {
      year: 2024, date: 'May 18, 2024', title: 'Undisputed',
      who: ['USYK', 'FURY'],
      text: 'Oleksandr Usyk edges Fury by split decision in Riyadh to become the first undisputed heavyweight champion of the four-belt era — holding WBA, WBC, IBF, and WBO simultaneously, a unification that hasn’t happened in 24 years.',
    },
  ];

  function openBoxingLore(){
    var moments = LORE_MOMENTS.slice().reverse(); // newest first
    var body =
      '<div class="lore-intro">'
      + '<p><strong>"The man who beat the man."</strong> The phrase predates this website by a century — it’s how boxing historians talked about a championship that wasn’t handed out by a sanctioning body but earned in the ring against the previous holder.</p>'
      + '<p>When the alphabet titles (WBA, WBC, IBF, WBO) splintered the official championship across the 1960s, 70s, and 80s, the <em>lineal</em> title became the consensus belt — the one whose holder could draw an unbroken line back to John L. Sullivan in 1882. This is that line. Every fight that mattered. Every name that mattered.</p>'
      + '</div>'
      + '<div class="lore-list">'
      + moments.map(function(m){
          var portraits = m.who.map(function(code){
            var b = brandFor(code);
            return b.logo
              ? '<img class="lore-portrait" src="'+b.logo+'" alt="'+escapeHTML(b.name)+'" title="'+escapeHTML(b.name)+'"/>'
              : '<div class="lore-portrait fallback">'+escapeHTML(b.name.split(' ').slice(-1)[0])+'</div>';
          }).join('');
          return '<div class="lore-moment">'
            + '<div class="lore-photos">'+portraits+'</div>'
            + '<div class="lore-text">'
            +   '<div class="lore-year">'+escapeHTML(m.date)+'</div>'
            +   '<div class="lore-title">'+escapeHTML(m.title)+'</div>'
            +   '<p>'+escapeHTML(m.text)+'</p>'
            + '</div>'
            + '</div>';
        }).join('')
      + '</div>';
    showModal('The Lore of the Lineal Championship', 'Boxing 1882 → present', body);
  }

  /* ─── Branch points — "what if" alternate timelines ─────────────────── */
  /* Two edit primitives:
       truncate_after_reign — strict-purist retirement: cut the chain at the
         champion's ACTUAL retirement date (not at their next canonical
         loss), and present it as "chain broken", not as a living champ.
       splice — replace a slice of the canonical chain with a hand-curated
         alternate, optionally rejoining canonical later. This is what makes
         branches genuinely different timelines instead of all collapsing to
         "retiree keeps a fictional belt forever".
     The chain is re-walked client-side whenever a branch is toggled; the
     canonical chain stays untouched. */

  var BRANCH_POINTS = [
    {
      id: 'marciano-1956', league: 'BOXHW',
      name: 'Marciano retires the chain',
      summary: 'Strict-purist view',
      description: 'When Rocky Marciano retired undefeated in April 1956, no one ever beat him. By the strict "the man who beat the man" rule, the chain is broken permanently.',
      outcome: 'Chain ends Apr 27, 1956 — no lineal champion since.',
      edit: { type: 'truncate_after_reign', champ: 'MARCIANO', retireDate: '1956-04-27', undefeated: true },
    },
    {
      id: 'tunney-1928', league: 'BOXHW',
      name: 'Tunney retires the chain',
      summary: 'Strict-purist view (earlier era)',
      description: 'Gene Tunney retired as undefeated heavyweight champion in 1928. Under strict purist rules his retirement permanently broke the chain — Schmeling winning the vacant title in 1930 does not inherit from Tunney.',
      outcome: 'Chain ends Jul 31, 1928 — no lineal champion since.',
      edit: { type: 'truncate_after_reign', champ: 'TUNNEY', retireDate: '1928-07-31', undefeated: true },
    },
    {
      id: 'jeffries-1905', league: 'BOXHW',
      name: 'Jeffries retires the chain',
      summary: 'Strict-purist view (earliest break)',
      description: 'James J. Jeffries retired undefeated in May 1905. Under strict purist rules no lineal heavyweight champion exists after Jeffries — Burns winning the vacant title in 1906 does not inherit the line.',
      outcome: 'Chain ends May 13, 1905 — no lineal champion since.',
      edit: { type: 'truncate_after_reign', champ: 'JEFFRIES', retireDate: '1905-05-13', undefeated: true },
    },
    {
      id: 'hart-1905', league: 'BOXHW',
      name: 'Marvin Hart bridges the gap',
      summary: 'Chain-repair view — rejoins canonical',
      description: 'The forgotten fix for the Jeffries retirement: Marvin Hart beat Jack Root for the vacant title in July 1905 (Jeffries himself refereed), and Tommy Burns beat Hart in February 1906. Count those two fights and the chain never breaks at all — it runs unbroken from Sullivan to today.',
      outcome: 'Chain never breaks — same champion today, one extra name in the lineage.',
      edit: {
        type: 'splice',
        afterDate: '1905-05-13',
        untilDate: '1906-02-24',
        insert: [
          { date: '1905-07-03T00:00:00Z', gameId: null, from: null, to: 'MARVINHART', score: 'TKO 12', note: 'Beat Jack Root for the vacant title; Jeffries refereed.' },
          { date: '1906-02-23T00:00:00Z', gameId: null, from: 'MARVINHART', to: 'BURNS', score: 'W 20' },
        ],
      },
    },
    {
      id: 'ali-retired-1979', league: 'BOXHW',
      name: 'Ali retires the chain',
      summary: 'No comeback — Holmes is just a WBC titleholder',
      description: 'Muhammad Ali retired as the lineal champion in June 1979. In this timeline he stays retired: no Larry Holmes comeback fight in 1980, no Berbick fight in 1981 — the chain ends the day he walked away.',
      outcome: 'Chain ends Jun 27, 1979 — no lineal champion since.',
      edit: { type: 'truncate_after_reign', champ: 'MUHAMMADALI', retireDate: '1979-06-27', undefeated: false },
    },
    {
      id: 'lewis-klitschko-2003', league: 'BOXHW',
      name: 'Vitali gets the decision',
      summary: 'Result flip — a different two decades',
      description: 'June 21, 2003: Vitali Klitschko is AHEAD on all three scorecards (58-56) when the doctor stops the fight on cuts after round 6, handing Lennox Lewis the TKO. Flip it — the cut is ruled from a headbutt and Vitali wins a technical decision. He then never loses again, retiring as champion in December 2013 to enter Ukrainian politics.',
      outcome: 'Vitali Klitschko is the final champion; no Wladimir era, no Fury, no Usyk.',
      edit: {
        type: 'splice',
        afterDate: '2003-06-20',
        untilDate: null,
        insert: [
          { date: '2003-06-21T00:00:00Z', gameId: null, from: 'LEWIS', to: 'KLITSCHKOVITALI', score: 'TD 6 (alt result)' },
        ],
        breaks: {
          champ: 'KLITSCHKOVITALI',
          breakDate: '2013-12-16',
          undefeated: false,
          note: 'Vitali Klitschko never lost again — he retired as champion in December 2013 to enter Ukrainian politics, and under this timeline the chain breaks there.',
        },
      },
    },
    {
      id: 'calzaghe-2008', league: 'BOXLHW',
      name: 'Calzaghe retires the chain',
      summary: 'Strict-purist view',
      description: 'Joe Calzaghe retired undefeated in February 2009 after beating Roy Jones Jr. By the strict "man who beat the man" rule, Hopkins’s 2011 win over Pascal does not restore the chain — there has been no lineal light-heavyweight champion since.',
      outcome: 'Chain ends Feb 5, 2009 — no lineal champion since.',
      edit: { type: 'truncate_after_reign', champ: 'CALZAGHE', retireDate: '2009-02-05', undefeated: true },
    },
  ];

  var ACTIVE_BRANCHES = [];
  var CANONICAL_CHANGES = null;
  var CANONICAL_CHAMP = null;
  // When an active branch ends the chain, this records the context so the UI
  // shows "Chain broken" instead of treating the last holder as a current
  // champion with a decades-long fictional reign.
  var BRANCH_TRUNCATION = null;  // null | { champ, breakDate, reignStart, undefeated, note }
  // Dynamic "flip a real game" cascade (team sports). null when canonical.
  var CASCADE = null;            // null | { label, flip, current }
  var CASCADE_AVAILABLE = false; // whether this league has a game log uploaded

  function branchesForLeague(L) {
    return BRANCH_POINTS.filter(function(bp){ return bp.league === L; });
  }

  function applyEdit(changes, edit) {
    if (edit.type === 'truncate_after_reign') {
      // Cut at the champion's ACTUAL retirement date. (The old behavior cut
      // at their next canonical loss, which produced nonsense like the chain
      // "breaking" at a comeback fight years after the retirement.)
      var cutoff = new Date(edit.retireDate);
      var working = changes.filter(function(c){ return new Date(c.date) <= cutoff; });
      if (!working.length) return changes;
      var last = working[working.length - 1];
      if (last.to !== edit.champ) return changes; // data mismatch → no-op
      BRANCH_TRUNCATION = {
        champ: edit.champ,
        breakDate: edit.retireDate,
        reignStart: last.date,
        undefeated: !!edit.undefeated,
        note: edit.note || null,
      };
      return working;
    }
    if (edit.type === 'splice') {
      // Remove canonical changes in (afterDate, untilDate) and insert the
      // hand-curated alternate. untilDate null = replace everything after.
      var after = new Date(edit.afterDate);
      var until = edit.untilDate ? new Date(edit.untilDate) : null;
      var kept = changes.filter(function(c){
        var d = new Date(c.date);
        if (d <= after) return true;
        if (until && d >= until) return true;
        return false;
      });
      var working2 = kept.concat(edit.insert || []);
      working2.sort(function(a,b){ return new Date(a.date) - new Date(b.date); });
      if (edit.breaks) {
        var rs = null;
        for (var i = working2.length - 1; i >= 0; i--) {
          if (working2[i].to === edit.breaks.champ) { rs = working2[i].date; break; }
        }
        BRANCH_TRUNCATION = {
          champ: edit.breaks.champ,
          breakDate: edit.breaks.breakDate,
          reignStart: rs,
          undefeated: !!edit.breaks.undefeated,
          note: edit.breaks.note || null,
        };
      }
      return working2;
    }
    return changes;
  }

  function applyActiveBranches() {
    if (!CANONICAL_CHANGES) return;
    BRANCH_TRUNCATION = null;  // each rebuild starts clean; edits set it
    var working = CANONICAL_CHANGES.slice();
    ACTIVE_BRANCHES.forEach(function(bid){
      var bp = BRANCH_POINTS.find(function(x){ return x.id === bid; });
      if (bp && bp.league === league) working = applyEdit(working, bp.edit);
    });
    DATA.changes = working;
    DATA.currentChamp = working.length
      ? working[working.length - 1].to
      : null;
  }

  function toggleBranch(bid) {
    var idx = ACTIVE_BRANCHES.indexOf(bid);
    if (idx >= 0) ACTIVE_BRANCHES.splice(idx, 1);
    else ACTIVE_BRANCHES.push(bid);
    applyActiveBranches();
    rerenderForBranchChange();
  }

  function resetBranches() {
    ACTIVE_BRANCHES = ACTIVE_BRANCHES.filter(function(bid){
      var bp = BRANCH_POINTS.find(function(x){ return x.id === bid; });
      return !bp || bp.league !== league;
    });
    applyActiveBranches();
    rerenderForBranchChange();
  }

  function rerenderForBranchChange() {
    renderHero();
    renderStrip();
    if (el('timeline').classList.contains('open')) renderTimeline();
    renderWhatIfBadge();
    updateBranchUrl();
  }

  function renderWhatIfBadge() {
    var branches = branchesForLeague(league);
    var teamSport = !isBoxingActive();
    var area = el('whatifArea');
    var banner = el('branchBanner');
    if (!area || !banner) return;
    // Show the what-if entry point when there are curated branches (boxing) or
    // this is a team sport with a game log uploaded (dynamic flip-and-cascade).
    var showButton = branches.length || (teamSport && CASCADE_AVAILABLE);
    if (!showButton) {
      area.style.display = 'none';
      banner.style.display = 'none';
      return;
    }
    area.style.display = '';
    var btn = el('whatifBtn');
    if (btn) btn.textContent = (teamSport && CASCADE_AVAILABLE)
      ? '🔀 What if? — flip a game and watch the belt cascade'
      : '🤔 What if? — explore alternate timelines';
    // A live cascade takes precedence over curated branches in the banner.
    if (CASCADE) {
      banner.style.display = 'flex';
      el('branchBannerText').textContent = 'Alternate timeline: ' + CASCADE.label;
      return;
    }
    var activeForLeague = ACTIVE_BRANCHES.filter(function(bid){
      var bp = BRANCH_POINTS.find(function(x){ return x.id === bid; });
      return bp && bp.league === league;
    });
    if (activeForLeague.length) {
      banner.style.display = 'flex';
      var names = activeForLeague.map(function(bid){
        var bp = BRANCH_POINTS.find(function(x){ return x.id === bid; });
        return bp ? bp.name : bid;
      }).join(' · ');
      el('branchBannerText').textContent = 'Alternate timeline: ' + names;
    } else {
      banner.style.display = 'none';
    }
  }

  function openWhatIfModal() {
    // Team sports get the dynamic flip-and-cascade picker; boxing keeps the
    // curated branch list.
    if (!isBoxingActive() && CASCADE_AVAILABLE) { openCascadeModal(); return; }
    var branches = branchesForLeague(league);
    if (!branches.length) return;
    var body =
      '<div class="whatif-intro">'
      + '<p>At certain historical inflection points the lineal chain could '
      + 'defensibly have gone differently. Toggle alternates below and the '
      + 'chain rewrites itself in real time — some branches end the line, '
      + 'others splice in a different history and rejoin it.</p>'
      + '<p style="font-size:12px;color:var(--text-dim)">Your selection persists in the URL so you can share an alternate timeline. Reset any time from the banner above the tracker.</p>'
      + '</div>'
      + '<div class="whatif-list">'
      + branches.map(function(bp){
          var active = ACTIVE_BRANCHES.indexOf(bp.id) >= 0;
          return '<label class="whatif-row">'
            + '<input type="checkbox" data-bid="' + bp.id + '" ' + (active ? 'checked' : '') + '/>'
            + '<div class="whatif-text">'
            + '<div class="whatif-name">' + escapeHTML(bp.name) + '</div>'
            + '<div class="whatif-summary">' + escapeHTML(bp.summary) + '</div>'
            + '<p>' + escapeHTML(bp.description) + '</p>'
            + (bp.outcome ? '<div class="whatif-outcome">→ ' + escapeHTML(bp.outcome) + '</div>' : '')
            + '</div>'
            + '</label>';
        }).join('')
      + '</div>';
    showModal('What if? — alternate timelines',
              branches.length + ' branch' + (branches.length === 1 ? '' : 'es') + ' available for this league',
              body);
    setTimeout(function(){
      document.querySelectorAll('.whatif-row input[data-bid]').forEach(function(input){
        input.addEventListener('change', function(){
          toggleBranch(input.getAttribute('data-bid'));
        });
      });
    }, 0);
  }

  // ─── Dynamic "flip a real game" cascade (team sports) ───────────────────
  async function checkCascadeAvailable(){
    CASCADE_AVAILABLE = false;
    if (isBoxingActive()) return;
    try {
      var r = await fetch('/api/whatif?league='+league+'&check=1');
      if (r.ok) { var j = await r.json(); CASCADE_AVAILABLE = !!j.available; }
    } catch(e) { CASCADE_AVAILABLE = false; }
  }

  async function openCascadeModal(){
    showModal('What if? — rewrite a real game',
      'Flip a game the champion actually won; the belt then follows what really happened next.',
      '<div class="whatif-intro"><p>Loading games…</p></div>');
    await loadEventsIfNeeded();
    var champName = brandFor(CANONICAL_CHAMP).name;
    // Current reign start = last canonical belt change TO the current champ.
    var canon = CANONICAL_CHANGES || [];
    var reignStart = null;
    for (var i = canon.length - 1; i >= 0; i--) {
      if (canon[i].to === CANONICAL_CHAMP) { reignStart = canon[i].date; break; }
    }
    var defenses = (EVENTS || []).filter(function(ev){
      return ev.champ === CANONICAL_CHAMP && ev.result === 'W' && (!reignStart || ev.date >= reignStart);
    }).sort(function(a, b){ return new Date(b.date) - new Date(a.date); });

    var intro = '<div class="whatif-intro">'
      + '<p>The current lineal champion is <strong>' + escapeHTML(champName) + '</strong>. '
      + 'Pick one of their real wins and we’ll flip it — that opponent takes the belt, and from '
      + 'there the title follows <em>actual results</em>: whoever really beat them next takes it, and so '
      + 'on, right up to today.</p>'
      + (CASCADE ? '<p style="font-size:12px;color:var(--text-dim)">An alternate timeline is active. Pick another game to replace it, or Reset from the banner above the tracker.</p>' : '')
      + '</div>';
    if (!defenses.length) {
      showModal('What if? — rewrite a real game', '',
        intro + '<p style="color:var(--text-dim)">No flippable wins found in this champion’s current reign.</p>');
      return;
    }
    var rows = defenses.slice(0, 60).map(function(ev){
      var opp = brandFor(ev.opponent);
      var sc = (ev.champScore != null && ev.oppScore != null) ? ' · ' + ev.champScore + '–' + ev.oppScore : '';
      return '<label class="whatif-row" data-game="' + escapeHTML(String(ev.gameId)) + '" data-opp="' + escapeHTML(opp.name) + '" data-date="' + ev.date + '">'
        + '<div class="whatif-text">'
        + '<div class="whatif-name">' + escapeHTML(champName) + ' def. ' + escapeHTML(opp.name) + '</div>'
        + '<div class="whatif-summary">' + fmtDate(ev.date) + sc + '</div>'
        + '<p>Flip it → ' + escapeHTML(opp.name) + ' win and take the belt.</p>'
        + '</div></label>';
    }).join('');
    showModal('What if? — rewrite a real game',
      defenses.length + ' win' + (defenses.length === 1 ? '' : 's') + ' in ' + champName + '’s current reign',
      intro + '<div class="whatif-list">' + rows + '</div>');
    setTimeout(function(){
      document.querySelectorAll('.whatif-row[data-game]').forEach(function(row){
        row.addEventListener('click', function(){
          doCascade(row.getAttribute('data-game'), row.getAttribute('data-opp'),
                    row.getAttribute('data-date'), champName);
        });
      });
    }, 0);
  }

  async function doCascade(gameId, oppName, date, champName){
    showModal('Rewriting history…', '',
      '<div class="whatif-intro"><p>Re-running the belt through every game since '
      + fmtDate(date) + '…</p></div>');
    try {
      var r = await fetch('/api/whatif?league=' + league + '&flip=' + encodeURIComponent(gameId));
      var j = await r.json();
      if (!r.ok || j.available === false) {
        showModal('Not available yet', '',
          '<p style="color:var(--text-dim)">' + escapeHTML((j && j.error) || 'The game log for this league hasn’t been generated yet.') + '</p>');
        return;
      }
      CASCADE = { label: oppName + ' beat ' + champName + ', ' + fmtDate(date), flip: j.flip, current: j.current };
      BRANCH_TRUNCATION = null;
      DATA.changes = j.changes || [];
      DATA.currentChamp = j.current;
      closeModal();
      renderHero(); renderStrip(); renderWhatIfBadge();
      if (el('timeline').classList.contains('open')) renderTimeline();
    } catch (e) {
      showModal('Error', '', '<p style="color:var(--text-dim)">' + escapeHTML(e.message) + '</p>');
    }
  }

  function resetWhatIf(){
    if (CASCADE) {
      CASCADE = null;
      applyActiveBranches();   // restores DATA.changes from CANONICAL_CHANGES
      rerenderForBranchChange();
      return;
    }
    resetBranches();
  }

  function readBranchUrl() {
    var p = new URLSearchParams(location.search);
    var b = p.get('branch');
    return b ? b.split(',').filter(Boolean) : [];
  }

  function updateBranchUrl() {
    var p = new URLSearchParams(location.search);
    if (ACTIVE_BRANCHES.length) p.set('branch', ACTIVE_BRANCHES.join(','));
    else p.delete('branch');
    history.replaceState(null, '', '?' + p.toString());
  }

  function showComingSoon(wc){
    var html =
      '<div style="text-align:center;padding:18px 0">'
      + '<div style="font-size:1.05em;margin-bottom:6px">Lineage for '
      + escapeHTML((wc.group === "women's" ? "Women's " : '') + wc.label)
      + ' is being curated.</div>'
      + '<div style="color:var(--text-dim);font-size:0.92em">'
      + 'Boxing has 25+ weight classes spanning 130+ years. The classic eight men’s divisions are live — the rest are being curated outward from there. Check back soon.'
      + '</div></div>';
    showModal('Coming soon', '', html);
  }

  function fmtDate(s){
    if (!s) return '';
    try { return new Date(s).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}); }
    catch(e){ return s.slice(0,10); }
  }
  function daysBetween(a, b){
    return Math.max(0, Math.floor((new Date(b) - new Date(a)) / (24*3600*1000)));
  }
  // Fallback boxer portraits — for fighters whose Wikipedia article lacks the
  // structured pageimage tag (so the brand-seed Action API couldn't auto-find
  // a thumbnail). Verified URLs from the REST media-list endpoint.
  var STATIC_BRAND_PORTRAITS = {
    MUHAMMADALI:    'https://upload.wikimedia.org/wikipedia/commons/thumb/8/89/Muhammad_Ali_NYWTS.jpg/1280px-Muhammad_Ali_NYWTS.jpg',
    LISTON:         'https://upload.wikimedia.org/wikipedia/commons/thumb/8/87/Sonny_Liston_portrait_on_March_1978_cover_Big_Book_Of_Boxing_Magazine.jpg/1280px-Sonny_Liston_portrait_on_March_1978_cover_Big_Book_Of_Boxing_Magazine.jpg',
    JOELOUIS:       'https://upload.wikimedia.org/wikipedia/commons/thumb/3/30/Joe_Louis_by_van_Vechten.jpg/1280px-Joe_Louis_by_van_Vechten.jpg',
    MARCIANO:       'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e7/Rocky_Marciano_%28cropped%29.jpg/1280px-Rocky_Marciano_%28cropped%29.jpg',
    FOREMAN:        'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cb/George_Foreman_%281973%29.jpg/1280px-George_Foreman_%281973%29.jpg',
    FRAZIER:        'https://upload.wikimedia.org/wikipedia/commons/thumb/5/50/Joe_Frazier_reading_newspaper_cropped.jpg/1280px-Joe_Frazier_reading_newspaper_cropped.jpg',
    HOLYFIELD:      'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Evander_Holyfield_LA_2011.jpg/500px-Evander_Holyfield_LA_2011.jpg',
    HOLMES:         'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ad/Larry_Holmes_1996.jpg/1280px-Larry_Holmes_1996.jpg',
    LEWIS:          'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/Lenox_Lewis_2010_cropped.jpg/1280px-Lenox_Lewis_2010_cropped.jpg',
    KLITSCHKOWLAD:  'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Volodymyr_Klychko_%28Vladimir_Klitschko%29_of_Ukraine_at_the_59th_Munich_Security_Conference_in_Munich_on_17_February_2023_-_%28cropped%29.jpg/1280px-Volodymyr_Klychko_%28Vladimir_Klitschko%29_of_Ukraine_at_the_59th_Munich_Security_Conference_in_Munich_on_17_February_2023_-_%28cropped%29.jpg',
    FURY:           'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Tyson_Fury_at_Place_Bell%2C_Laval_Quebec%2C_Canada_-_Dec_16_2017_%28cropped%29.jpg/500px-Tyson_Fury_at_Place_Bell%2C_Laval_Quebec%2C_Canada_-_Dec_16_2017_%28cropped%29.jpg',
    JOHANSSON:      'https://upload.wikimedia.org/wikipedia/commons/thumb/2/20/IngemarJohansson_2.jpg/1280px-IngemarJohansson_2.jpg',
    PATTERSON:      'https://upload.wikimedia.org/wikipedia/commons/thumb/8/86/Floyd_Patterson_2_%28cropped%29.jpg/500px-Floyd_Patterson_2_%28cropped%29.jpg',
    JOHNSON:        'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b1/Jack_Johnson%2C_1915_%28edit%29.jpg/500px-Jack_Johnson%2C_1915_%28edit%29.jpg',
    JEFFRIES:       'https://upload.wikimedia.org/wikipedia/commons/thumb/3/37/James_J_Jeffries.jpg/500px-James_J_Jeffries.jpg',
    FITZSIMMONS:    'https://upload.wikimedia.org/wikipedia/commons/thumb/3/30/Robert_Fitzsimmons.jpg/500px-Robert_Fitzsimmons.jpg',
    SCHMELING:      'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d5/Bundesarchiv_Bild_102-09348%2C_Max_Schmeling.jpg/500px-Bundesarchiv_Bild_102-09348%2C_Max_Schmeling.jpg',
    SHARKEY:        'https://upload.wikimedia.org/wikipedia/commons/thumb/d/db/Jack_Sharkey_01_%28cropped%29.tif/lossy-page1-1280px-Jack_Sharkey_01_%28cropped%29.tif.jpg',
    BURNS:          'https://upload.wikimedia.org/wikipedia/commons/thumb/9/92/Tommy_Burns_1912.jpg/500px-Tommy_Burns_1912.jpg',
    MOORER:         'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/Michael_Moorer_in_2009.jpg/500px-Michael_Moorer_in_2009.jpg',
    // BOXLHW portraits verified via REST media-list endpoint
    MOORE:          'https://upload.wikimedia.org/wikipedia/commons/thumb/e/eb/Archie_Moore_1955.jpg/500px-Archie_Moore_1955.jpg',
    JOHNSONHAROLD:  'https://upload.wikimedia.org/wikipedia/commons/thumb/9/92/Harold_Johnson_1954b.jpg/330px-Harold_Johnson_1954b.jpg',
    TORRES:         'https://upload.wikimedia.org/wikipedia/en/c/ce/Jose_Torres1.jpg',
    TIGER:          'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/Dick_Tiger_vs_Nino_Benvenuti_1969.jpg/330px-Dick_Tiger_vs_Nino_Benvenuti_1969.jpg',
    FOSTER:         'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1f/Bob_Foster_1972.jpg/500px-Bob_Foster_1972.jpg',
    CONTEH:         'https://upload.wikimedia.org/wikipedia/commons/thumb/d/da/John_Conteh_c1973.jpg/330px-John_Conteh_c1973.jpg',
    PARLOV:         'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/Mate_Parlov_1972.jpg/500px-Mate_Parlov_1972.jpg',
    JOHNSONMARVIN:  'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/Marvin_Johnson_in_KO_Magazine.jpg/500px-Marvin_Johnson_in_KO_Magazine.jpg',
    SAADMUHAMMAD:   'https://upload.wikimedia.org/wikipedia/commons/thumb/3/37/Matthew_Saad_Muhammad_by_Bill_Apter.jpg/500px-Matthew_Saad_Muhammad_by_Bill_Apter.jpg',
  };

  // Name fallbacks for codes that exist only in What-If alternate timelines
  // (never lineal in canon, so the KV brand map may not know them) and for
  // the explicit vacancy marker.
  var STATIC_BRAND_NAMES = {
    VACANT: 'Vacant',
    MARVINHART: 'Marvin Hart',
    KLITSCHKOVITALI: 'Vitali Klitschko',
  };

  function brandFor(code){
    var b = BRAND[code];
    return {
      name: (b && b.name) || STATIC_BRAND_NAMES[code] || code,
      color: code === 'VACANT' ? '#9aa0ad' : ((b && b.color) || colorFor(code || '')),
      logo: (b && b.logo) || STATIC_BRAND_PORTRAITS[code] || '',
    };
  }
  function nameSpan(code){
    var b = brandFor(code);
    return '<b style="color:'+b.color+'">'+escapeHTML(b.name)+'</b>';
  }
  function escapeHTML(s){
    return String(s||'').replace(/[&<>\"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  // change.score is stored "old-champ-score - winner-score" (the loser's
  // number first). Flip numeric scores so the WINNER's score leads, matching
  // the "X over Y" phrasing next to it. Boxing methods ("KO 6") pass through.
  function displayScore(score){
    var m = /^(\d+)-(\d+)$/.exec(String(score || ''));
    return m ? (m[2] + '-' + m[1]) : (score || '');
  }

  async function load(){
    el('champName').textContent = 'Loading…';
    el('champSub').textContent = '';
    el('strip').innerHTML = '';
    el('timeline').innerHTML = '';
    el('statsGrid').innerHTML = '';

    try {
      var bm = await fetch('/api/brand?league='+league);
      BRAND = bm.ok ? await bm.json() : {};
    } catch (e) { BRAND = {}; }

    try {
      var r = await fetch('/api/lineage?league='+league);
      if (!r.ok) { el('champName').textContent='No data yet'; el('champSub').textContent='Run build_lineage.py + upload_to_worker.py first.'; return; }
      DATA = await r.json();
      // Snapshot the canonical chain so branch toggles can recompute from it
      // without re-fetching, and so "Reset to canonical" always restores it.
      CANONICAL_CHANGES = (DATA.changes || []).slice();
      CANONICAL_CHAMP = DATA.currentChamp;
      CASCADE = null;  // clear any alternate timeline when switching leagues
      // Adopt any branches encoded in the URL that apply to this league.
      ACTIVE_BRANCHES = readBranchUrl().filter(function(bid){
        return BRANCH_POINTS.some(function(bp){ return bp.id === bid; });
      });
      applyActiveBranches();
      renderHero();
      renderStrip();
      renderWhatIfBadge();
      if (el('timeline').classList.contains('open')) renderTimeline();
      // Reveal the flip-and-cascade button once we confirm this league has a
      // game log uploaded (cheap meta check; non-blocking so render isn't held).
      checkCascadeAvailable().then(renderWhatIfBadge);
    } catch (e) {
      el('champName').textContent = 'Error';
      el('champSub').textContent = e.message;
    }
  }

  function renderHero(){
    var isVacant = DATA.currentChamp === 'VACANT';
    var b = brandFor(DATA.currentChamp);
    el('hero').style.setProperty('--champ-color', b.color);
    el('champName').textContent = b.name;
    if (b.logo && !isVacant) {
      el('champLogo').src = b.logo;
      el('champLogo').classList.remove('no-logo');
      el('champLogo').alt = b.name + ' logo';
    } else {
      el('champLogo').classList.add('no-logo');
    }

    // Find the last belt change to learn when the current reign started
    var changes = (DATA.changes || []).slice().sort(function(a,b){ return new Date(a.date)-new Date(b.date); });
    var last = changes[changes.length-1];
    var reignStart = last ? last.date : null;
    // When a truncate branch is active, "days held" is the actual reign
    // length up to the break (when the holder retired), not days until
    // today — otherwise Marciano shows ~26,000 days, which misrepresents
    // an alternate timeline where he's been dead since 1969.
    var reignEnd = BRANCH_TRUNCATION ? BRANCH_TRUNCATION.breakDate : new Date().toISOString();
    var days = reignStart ? daysBetween(reignStart, reignEnd) : 0;
    var prev = null;
    for (var i = changes.length-1; i >= 0; i--) {
      if (changes[i].from && changes[i].from !== DATA.currentChamp) { prev = changes[i]; break; }
    }
    // Swap framing when the chain is truncated by a branch or the title is
    // vacant in canon (a champion moved up in weight or retired).
    var heroLabel = el('heroLabel');
    if (heroLabel) {
      heroLabel.textContent = isVacant ? 'Lineal Title Vacant'
        : (BRANCH_TRUNCATION ? 'Final Lineal Champion' : 'Current Lineal Champion');
    }
    if (isVacant) {
      var lastReal = null;
      for (var v = changes.length-1; v >= 0; v--) {
        if (changes[v].to && changes[v].to !== 'VACANT') { lastReal = changes[v]; break; }
      }
      var vacNote = (last && last.note) ? escapeHTML(last.note) + ' ' : '';
      el('champSub').innerHTML = vacNote
        + 'Vacant since ' + fmtDate(last ? last.date : null)
        + (lastReal ? ' — last held by ' + escapeHTML(brandFor(lastReal.to).name) : '') + '.'
        + ' The lineal title only changes hands in the ring, so when a champion '
        + 'retires or moves up in weight it stays vacant until a fight settles it '
        + '— we don’t hand it to the next man by decree.';
    } else if (BRANCH_TRUNCATION) {
      var howEnded = BRANCH_TRUNCATION.undefeated ? 'retired undefeated' : 'retired as champion';
      el('champSub').innerHTML =
        '<span style="color:#f0d77a">Chain broken on ' + fmtDate(BRANCH_TRUNCATION.breakDate) + '</span>'
        + ' — ' + (BRANCH_TRUNCATION.note
            ? escapeHTML(BRANCH_TRUNCATION.note)
            : escapeHTML(b.name) + ' ' + howEnded + '. Under this alternate timeline, there has been no lineal champion since.');
    } else {
      el('champSub').innerHTML = prev
        ? 'Won the belt on '+fmtDate(prev.date)+' vs '+escapeHTML(brandFor(prev.from).name)
        : (DATA.asOfDate ? 'Holds the lineal title (data as of '+fmtDate(DATA.asOfDate)+')' : '');
    }

    var reigns = computeAllReigns(changes);
    var totalChanges = (DATA.changes||[]).filter(function(c){ return c.from; }).length;
    var reignNum = countReignsFor(changes, DATA.currentChamp);
    var rankInfo = longevityRank(reigns, DATA.currentChamp);
    var isBoxing = isBoxingCode(league);
    var fightsLabel = isBoxing ? 'click for title fights' : 'click for games';
    var stats = isVacant
      ? [
          { k: 'Days vacant', v: days.toLocaleString(), action: 'history', hint: 'click for history' },
          { k: 'Total belt changes', v: totalChanges.toLocaleString(), action: 'history', hint: 'click for history' },
          { k: 'Longest reign', v: rankTopLabel(reigns), action: 'rank', hint: 'click for top 20' },
          { k: 'As of', v: DATA.asOfDate ? fmtDate(DATA.asOfDate) : '—', action: 'asof', hint: 'click for sources' },
        ]
      : [
          { k: 'Days held', v: days.toLocaleString(), action: 'reign', hint: fightsLabel },
          { k: 'Total belt changes', v: totalChanges.toLocaleString(), action: 'history', hint: 'click for history' },
          { k: 'Reign #', v: reignNum, action: 'reign', hint: fightsLabel },
          { k: 'Longevity rank', v: rankInfo.label, action: 'rank', hint: 'click for top 20' },
          { k: 'As of', v: DATA.asOfDate ? fmtDate(DATA.asOfDate) : '—', action: 'asof', hint: 'click for sources' },
        ];
    el('statsGrid').innerHTML = stats.map(function(s){
      return '<div class="stat clickable" data-action="'+s.action+'">'
        + '<div class="v">'+escapeHTML(s.v)+'</div>'
        + '<div class="k">'+escapeHTML(s.k)+'</div>'
        + '<div class="hint">'+escapeHTML(s.hint)+'</div>'
        + '</div>';
    }).join('');
    var grid = el('statsGrid');
    grid.querySelectorAll('.stat.clickable').forEach(function(node){
      node.addEventListener('click', function(){ openStat(node.getAttribute('data-action')); });
    });
    el('meta').textContent = DATA.deltaCount ? (DATA.deltaCount + ' live update(s) since static snapshot') : '';
  }

  function rankTopLabel(reigns){
    var best = reigns.filter(function(r){ return r.team !== 'VACANT'; })
      .sort(function(a,b){ return b.days - a.days; })[0];
    return best ? brandFor(best.team).name : '—';
  }

  function countReignsFor(changes, team){
    var n = 0;
    for (var i = 0; i < changes.length; i++) if (changes[i].to === team) n++;
    return String(n);
  }

  // All historical reigns as { team, startDate, endDate, days }.
  // The active (last) reign normally uses today as endDate; when a
  // truncate branch is active, it instead ends at the canonical break
  // date so historical longevity comparisons stay honest.
  function computeAllReigns(changes){
    var sorted = changes.slice().sort(function(a,b){ return new Date(a.date) - new Date(b.date); });
    var out = [];
    var todayIso = new Date().toISOString();
    var activeEnd = BRANCH_TRUNCATION ? BRANCH_TRUNCATION.breakDate : todayIso;
    for (var i = 0; i < sorted.length; i++) {
      var c = sorted[i];
      var endIso = (i+1 < sorted.length) ? sorted[i+1].date : activeEnd;
      out.push({ team: c.to, startDate: c.date, endDate: endIso, days: daysBetween(c.date, endIso) });
    }
    return out;
  }

  function longevityRank(reigns, team){
    var sorted = reigns.filter(function(r){ return r.team !== 'VACANT'; })
      .sort(function(a,b){ return b.days - a.days; });
    var idx = -1;
    var bestDays = 0;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].team === team && sorted[i].days >= bestDays) {
        // Find this team's longest reign and use its rank.
        bestDays = sorted[i].days;
        if (idx === -1) idx = i;
      }
    }
    if (idx === -1) return { label: '—', rank: null, total: sorted.length };
    return { label: ordinal(idx+1), rank: idx+1, total: sorted.length, days: bestDays };
  }

  function ordinal(n){
    var s = ['th','st','nd','rd'];
    var v = n % 100;
    return n + (s[(v-20)%10] || s[v] || s[0]);
  }

  function openStat(action){
    if (action === 'reign') return openReignModal();
    if (action === 'history') return openHistoryModal();
    if (action === 'rank') return openRankModal();
    if (action === 'asof') return openAsOfModal();
  }

  function showModal(title, sub, bodyHtml){
    el('modalTitle').textContent = title;
    el('modalSub').textContent = sub || '';
    el('modalBody').innerHTML = bodyHtml || '';
    el('modalBack').classList.add('on');
  }

  function closeModal(){ el('modalBack').classList.remove('on'); }

  async function openReignModal(){
    await loadEventsIfNeeded();
    var changes = (DATA.changes||[]).slice().sort(function(a,b){ return new Date(a.date) - new Date(b.date); });
    var last = changes[changes.length-1];
    var start = last ? last.date : null;
    var b = brandFor(DATA.currentChamp);
    // When a truncate branch is active, only show fights up to the chain break.
    var endCutoff = BRANCH_TRUNCATION ? new Date(BRANCH_TRUNCATION.breakDate) : null;
    var games = (EVENTS||[]).filter(function(ev){
      if (ev.champ !== DATA.currentChamp) return false;
      if (start && new Date(ev.date) < new Date(start)) return false;
      if (endCutoff && new Date(ev.date) >= endCutoff) return false;
      return true;
    }).sort(function(a,b){ return new Date(b.date) - new Date(a.date); });
    var isBoxing = isBoxingCode(league);
    var unitLabel = isBoxing ? 'title fight' : 'game';
    var sub;
    if (BRANCH_TRUNCATION) {
      sub = b.name + ' — reigned ' + (start ? fmtDate(start) : '—')
            + ' to ' + fmtDate(BRANCH_TRUNCATION.breakDate)
            + ' (chain broken under active alternate timeline)';
    } else {
      sub = b.name + ' — current reign began ' + (start ? fmtDate(start) : '—');
    }
    var body = games.length
      ? games.map(function(ev){
          var opp = brandFor(ev.opponent);
          var cls = ev.result === 'W' ? 'win' : 'loss';
          var verb = ev.result === 'W' ? 'beat' : 'lost to';
          var scoreText = isBoxing
            ? (ev.score || '')
            : (ev.champScore + '-' + ev.oppScore);
          return '<div class="modal-row '+cls+'">'
            + '<span class="when">'+fmtDate(ev.date)+'</span>'
            + '<span class="what">'+verb+' '+escapeHTML(opp.name)+'</span>'
            + '<span class="score">'+escapeHTML(scoreText)+'</span>'
            + '</div>';
        }).join('')
      : '<div style="color:var(--text-dim);padding:10px 0">No '+unitLabel+'s recorded during this reign yet.</div>';
    var title = BRANCH_TRUNCATION ? 'Final reign' : 'Current reign';
    showModal(title + ' — ' + games.length + ' ' + unitLabel + (games.length===1?'':'s'), sub, body);
  }

  function openHistoryModal(){
    var changes = (DATA.changes||[]).filter(function(c){ return c.from; })
      .slice().sort(function(a,b){ return new Date(b.date) - new Date(a.date); });
    var body = changes.map(function(c){
      var from = brandFor(c.from), to = brandFor(c.to);
      return '<div class="modal-row loss">'
        + '<span class="when">'+fmtDate(c.date)+'</span>'
        + '<span class="what"><b style="color:'+to.color+'">'+escapeHTML(to.name)+'</b> took belt from '+escapeHTML(from.name)+'</span>'
        + (c.score ? '<span class="score">'+escapeHTML(displayScore(c.score))+'</span>' : '')
        + '</div>';
    }).join('');
    showModal('Belt change history', changes.length + ' total transfers, newest first', body || '<div style="padding:10px 0;color:var(--text-dim)">No changes recorded.</div>');
  }

  function openRankModal(){
    var changes = (DATA.changes||[]).slice();
    var reigns = computeAllReigns(changes)
      .filter(function(r){ return r.team !== 'VACANT'; })
      .sort(function(a,b){ return b.days - a.days; });
    var top = reigns.slice(0, 20);
    var meTeam = DATA.currentChamp;
    var myEntry = longevityRank(computeAllReigns(changes), meTeam);
    var rows = top.map(function(r, i){
      var b = brandFor(r.team);
      var isMe = r.team === meTeam && (i+1) === myEntry.rank;
      return '<tr class="'+(isMe?'me':'')+'">'
        + '<td class="num">'+(i+1)+'</td>'
        + '<td><b style="color:'+b.color+'">'+escapeHTML(b.name)+'</b></td>'
        + '<td>'+fmtDate(r.startDate)+' → '+fmtDate(r.endDate)+'</td>'
        + '<td class="num">'+r.days.toLocaleString()+' d</td>'
        + '</tr>';
    }).join('');
    var body = '<table class="rank-table">'
      + '<thead><tr><th class="num">#</th><th>Team</th><th>Reign</th><th class="num">Length</th></tr></thead>'
      + '<tbody>'+rows+'</tbody></table>';
    var sub = (meTeam === 'VACANT')
      ? 'Longest reigns in this division, all-time'
      : brandFor(meTeam).name + "'s current reign ranks " + myEntry.label + ' out of ' + myEntry.total + ' all-time reigns';
    showModal('Longest reigns — top 20', sub, body);
  }

  function openAsOfModal(){
    var sources = {
      NBA: 'balldontlie.io /v1/games (1947+)',
      NFL: 'Wikipedia season archives (1933+), balldontlie live updates',
      MLB: 'Retrosheet game logs (1871–2011) + MLB StatsAPI (2012+)',
      NHL: 'hockey-reference.com (1917+), NHL API live updates',
      EPL: 'balldontlie.io /epl/v1/games (1992+)',
      CFB: 'collegefootballdata.com (1869+, FBS)'
    };
    var src = isBoxingCode(league)
      ? 'Hand-curated lineal records (Ring magazine tradition)'
      : (sources[league] || '—');
    var updateNote = isBoxingCode(league)
      ? 'Boxing lineages are hand-curated in the linealchamp-data repo and re-uploaded when edited — there is no live cron for boxing.'
      : "Static lineage was computed offline and uploaded to KV. Hourly cron fetches the current champion's recent games and appends any belt changes since the snapshot.";
    var body = '<div style="line-height:1.7;font-size:14px">'
      + '<div><b>Snapshot date:</b> '+(DATA.asOfDate ? fmtDate(DATA.asOfDate) : '—')+'</div>'
      + '<div><b>Source:</b> '+escapeHTML(src)+'</div>'
      + '<div><b>Live updates since snapshot:</b> '+(DATA.deltaCount || 0)+'</div>'
      + '<div style="margin-top:14px;color:var(--text-dim);font-size:13px">'
      + escapeHTML(updateNote)
      + '</div></div>';
    showModal('Data freshness', league + ' — data sources & update info', body);
  }

  function renderStrip(){
    var changes = (DATA.changes||[]).filter(function(c){ return c.from; }).slice(-10).reverse();
    el('strip').innerHTML = changes.map(function(c){
      var from = brandFor(c.from), to = brandFor(c.to);
      return '<div class="mini">'
        + '<div class="when">'+fmtDate(c.date)+'</div>'
        + '<div class="who"><span style="color:'+to.color+'">'+escapeHTML(to.name)+'</span></div>'
        + '<div class="vs">over '+escapeHTML(from.name)+'</div>'
        + (c.score ? '<div class="score">'+escapeHTML(displayScore(c.score))+'</div>' : '')
        + '</div>';
    }).join('');
  }

  async function loadEventsIfNeeded(){
    if (EVENTS) return;
    try {
      var r = await fetch('/api/events?league='+league);
      if (r.ok) {
        var j = await r.json();
        EVENTS = j.events || [];
      } else {
        EVENTS = [];
      }
    } catch(e) { EVENTS = []; }
  }

  async function renderTimeline(){
    var t = el('timeline');
    t.innerHTML = 'Loading title fights…';
    await loadEventsIfNeeded();
    var only = el('onlyChanges').checked;
    var list = EVENTS.slice().reverse();
    if (only) list = list.filter(function(e){ return e.change; });
    // Under a truncating branch, don't show canonical fights from after the break.
    if (BRANCH_TRUNCATION) {
      var cut = new Date(BRANCH_TRUNCATION.breakDate);
      list = list.filter(function(e){ return new Date(e.date) <= cut; });
    }
    var isBoxing = isBoxingCode(league);
    t.innerHTML = list.slice(0, 500).map(function(ev){
      var cls = 'ev ' + (ev.change ? 'loss change' : (ev.result === 'W' ? 'win' : 'loss'));
      var pill = ev.change ? 'NEW CHAMP' : (ev.result === 'W' ? 'DEFENDED' : 'LOST');
      var scoreTxt = isBoxing
        ? (ev.score || '')
        : (ev.champScore + '-' + ev.oppScore);
      var scoreHtml = scoreTxt ? ' (' + escapeHTML(scoreTxt) + ')' : '';
      var desc = ev.change
        ? nameSpan(ev.opponent) + ' beat ' + nameSpan(ev.champ) + scoreHtml
        : nameSpan(ev.champ) + (ev.result === 'W' ? ' beat ' : ' lost to ') + nameSpan(ev.opponent) + scoreHtml;
      return '<div class="'+cls+'">'
        + '<span class="date">'+fmtDate(ev.date)+'</span>'
        + '<span class="pill">'+pill+'</span>'
        + '<span class="desc">'+desc+'</span>'
        + '</div>';
    }).join('') || '<div style="padding:14px;color:var(--text-dim)">No events available yet for this league.</div>';
  }

  el('toggleTimeline').addEventListener('click', function(){
    var t = el('timeline');
    if (t.classList.contains('open')) {
      t.classList.remove('open');
      this.textContent = 'Show all title fights';
    } else {
      t.classList.add('open');
      this.textContent = 'Hide title fights';
      renderTimeline();
    }
  });
  el('onlyChanges').addEventListener('change', function(){
    if (el('timeline').classList.contains('open')) renderTimeline();
  });
  el('toggleAsk').addEventListener('click', function(){
    el('askPanel').classList.toggle('on');
    if (el('askPanel').classList.contains('on')) el('askInput').focus();
  });
  if (el('aboutBtn')) el('aboutBtn').addEventListener('click', function(){ location.href = '/'; });
  if (el('whatifBtn')) el('whatifBtn').addEventListener('click', openWhatIfModal);
  if (el('branchReset')) el('branchReset').addEventListener('click', resetWhatIf);
  el('modalClose').addEventListener('click', closeModal);
  el('modalBack').addEventListener('click', function(e){
    if (e.target === el('modalBack')) closeModal();
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && el('modalBack').classList.contains('on')) closeModal();
  });
  el('askInput').addEventListener('keydown', async function(e){
    if (e.key !== 'Enter') return;
    var q = e.target.value.trim(); if (!q) return;
    el('askAnswer').textContent = 'Thinking…';
    try {
      var r = await fetch('/api/gpt?league='+league+'&q='+encodeURIComponent(q));
      var j = await r.json();
      el('askAnswer').textContent = j.answer || j.error || 'No answer.';
    } catch (err) {
      el('askAnswer').textContent = 'Error: ' + err.message;
    }
  });

  function renderLandingPicks(){
    var html = LEAGUES.map(function(L){
      var label = LEAGUE_LABELS[L] || L;
      // Boxing's landing link goes straight to the Heavyweight tracker; the
      // tracker then exposes all weight classes via the sub-tab row.
      var href = (L === 'BOX') ? '?l=BOXHW' : '?l=' + L;
      return '<a href="'+href+'">'+label+'</a>';
    }).join('');
    var a = el('landPick'), b = el('landPick2');
    if (a) a.innerHTML = html;
    if (b) b.innerHTML = html;
  }

  if (SHOW_LANDING) {
    el('landing').classList.add('on');
    renderLandingPicks();
  } else {
    el('tracker').classList.add('on');
    renderTabs(); load();
  }
})();
</script>
</body>
</html>`;

const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>LinealChamp Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  :root { --bg: #0b0d12; --text: #e6e7eb; --text-dim: #9aa0ad; --border: #262b38; --card: #1a1e28; --accent: #4f6cf7; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, sans-serif; margin: 0; padding: 24px; }
  h1, h2 { margin: 0 0 12px; }
  .top { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 20px; }
  input, select, button {
    padding: 8px 12px; border: 1px solid var(--border); background: #14171f;
    color: var(--text); border-radius: 8px; font-size: 13px;
  }
  button { cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: white; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
  .kv { display: grid; grid-template-columns: 130px 1fr; gap: 4px 12px; margin-top: 10px; font-size: 13px; }
  .kv .k { color: var(--text-dim); }
  .kv code { background: #0b0d12; padding: 2px 6px; border-radius: 4px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
</style>
</head>
<body>
<h1>LinealChamp Admin</h1>
<div class="top">
  <label>Admin Secret: <input id="sec" type="password"/></label>
  <button id="save">Save</button>
  <span style="color:var(--text-dim)">stored only in this browser</span>
</div>

<h2>League Status</h2>
<div class="grid" id="cards"></div>

<h2 style="margin-top:24px">Branding</h2>
<div class="card">
  <div class="row">
    <select id="bL"><option>NBA</option><option>NFL</option><option>MLB</option><option>NHL</option><option>EPL</option><option>CFB</option><option>BOXHW</option><option>BOXLHW</option><option>BOXMW</option><option>BOXWW</option><option>BOXLW</option><option>BOXFW</option><option>BOXBW</option><option>BOXFLW</option></select>
    <button id="bLoad">Load brands</button>
  </div>
  <div class="row">
    <input id="bCode"  placeholder="Team code (e.g. NE)"/>
    <input id="bName"  placeholder="Display name"/>
    <input id="bColor" placeholder="Color (#hex)"/>
    <input id="bAlt"   placeholder="Alt color"/>
    <input id="bLogo"  placeholder="Logo URL"/>
    <button id="bSave" class="primary">Save</button>
    <button id="bDel">Delete</button>
  </div>
  <div id="bTable" style="margin-top:12px"></div>
</div>

<script>
(function(){
  var sec = document.getElementById('sec');
  sec.value = localStorage.getItem('lc_admin') || '';
  document.getElementById('save').onclick = function(){ localStorage.setItem('lc_admin', sec.value.trim()); alert('saved'); };

  var LEAGUES = ["NBA","NFL","MLB","NHL","EPL","CFB","BOXHW","BOXLHW","BOXMW","BOXWW","BOXLW","BOXFW","BOXBW","BOXFLW"];
  var grid = document.getElementById('cards');
  grid.innerHTML = LEAGUES.map(function(L){
    return '<div class="card" data-league="'+L+'">'
      + '<div style="display:flex;justify-content:space-between;align-items:center">'
      +   '<h2 style="margin:0">'+L+'</h2>'
      +   '<button class="refresh">↻</button>'
      + '</div>'
      + '<div class="kv">'
      +   '<div class="k">Current champ</div><div><code class="champ">—</code></div>'
      +   '<div class="k">As-of date</div><div><code class="asof">—</code></div>'
      +   '<div class="k">Total changes</div><div><code class="ct">—</code></div>'
      +   '<div class="k">Live updates</div><div><code class="dt">—</code></div>'
      +   '<div class="k">Last cron run</div><div><code class="lu">—</code></div>'
      + '</div>'
      + '<div class="row" style="margin-top:12px">'
      +   '<button class="probe">Probe upstream</button>'
      + '</div>'
    + '</div>';
  }).join('');

  Array.prototype.forEach.call(grid.querySelectorAll('.card'), function(card){
    var L = card.getAttribute('data-league');
    card.querySelector('.refresh').onclick = function(){ refresh(card); };
    card.querySelector('.probe').onclick = async function(){
      var d = await admin('/admin/probe?league='+L);
      alert(JSON.stringify(d, null, 2));
    };
    refresh(card);
  });

  async function refresh(card){
    var L = card.getAttribute('data-league');
    var data = await admin('/admin/status?league='+L);
    if (!data || !data.ok) return;
    set(card, '.champ', data.currentChamp || '—');
    set(card, '.asof', data.asOfDate || '—');
    set(card, '.ct', String(data.changeCount));
    set(card, '.dt', String(data.deltaCount));
    set(card, '.lu', data.lastUpdate ? new Date(data.lastUpdate).toLocaleString() : '—');
  }
  function set(card, sel, t){ var el = card.querySelector(sel); if(el) el.textContent = t; }

  async function admin(path, opts){
    opts = opts || {};
    var s = (sec.value||'').trim();
    if (!s) { alert('Enter ADMIN_SECRET'); throw new Error('no secret'); }
    var r = await fetch(path, Object.assign({}, opts, {
      headers: Object.assign({'x-admin-secret': s, 'content-type':'application/json'}, opts.headers||{})
    }));
    try { return await r.json(); } catch { return null; }
  }

  var bL = document.getElementById('bL'),
      bCode = document.getElementById('bCode'), bName = document.getElementById('bName'),
      bColor = document.getElementById('bColor'), bAlt = document.getElementById('bAlt'),
      bLogo = document.getElementById('bLogo'), bTable = document.getElementById('bTable');
  document.getElementById('bLoad').onclick = loadBrand;
  document.getElementById('bSave').onclick = async function(){
    var p = { league: bL.value, code: bCode.value.trim().toUpperCase().replace(/\\s+/g,''),
              name: bName.value.trim(), color: bColor.value.trim(),
              alt: bAlt.value.trim(), logo: bLogo.value.trim() };
    if (!p.code) { alert('enter code'); return; }
    var r = await admin('/admin/brand/set', { method:'POST', body: JSON.stringify(p) });
    if (r && r.ok) { await loadBrand(); bCode.value=bName.value=bColor.value=bAlt.value=bLogo.value=''; }
  };
  document.getElementById('bDel').onclick = async function(){
    var p = { league: bL.value, code: bCode.value.trim().toUpperCase().replace(/\\s+/g,'') };
    if (!p.code) { alert('enter code'); return; }
    await admin('/admin/brand/delete', { method:'POST', body: JSON.stringify(p) });
    loadBrand();
  };
  async function loadBrand(){
    var d = await admin('/admin/brand/get?league='+bL.value);
    var map = (d && d.map) || {};
    bTable.innerHTML = '<div style="display:grid;grid-template-columns:80px 1fr 80px 80px 1fr 40px;gap:8px;font-size:12px">'
      + '<div style="color:var(--text-dim)">Code</div><div style="color:var(--text-dim)">Name</div>'
      + '<div style="color:var(--text-dim)">Color</div><div style="color:var(--text-dim)">Alt</div>'
      + '<div style="color:var(--text-dim)">Logo</div><div></div>'
      + Object.keys(map).sort().map(function(c){
          return '<div>'+c+'</div><div>'+(map[c].name||'')+'</div>'
               + '<div>'+(map[c].color||'')+'</div><div>'+(map[c].alt||'')+'</div>'
               + '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(map[c].logo||'')+'</div>'
               + '<div>'+(map[c].logo?'<img src="'+map[c].logo+'" style="width:24px;height:24px;border-radius:4px"/>':'')+'</div>';
        }).join('')
      + '</div>';
  }
  loadBrand();
})();
</script>
</body>
</html>`;
