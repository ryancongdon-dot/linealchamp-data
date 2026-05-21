/* eslint-disable no-empty */
/**
 * linealchamp-api — Cloudflare Worker
 *
 * Architecture:
 *   - Historic lineage (every belt change from each league's seed date to
 *     `asOfDate`) is computed OFFLINE by the linealchamp-data Python tooling
 *     and shipped here as `STATIC_LINEAGE` (inlined below) or written into
 *     KV `${league}:static` via /admin/upload-lineage.
 *   - This Worker only handles "today's games" — fetching games involving the
 *     current belt holder and walking lineage forward from `asOfDate`.
 *   - Full event logs (every game involving the holder) live in R2 binding
 *     EVENTS, fetched on demand via /api/events.
 *
 * Bindings expected:
 *   KV — KV namespace (existing LINEALCHAMP namespace). This Worker uses
 *        KV exclusively; no R2 needed. Events go to `${league}:events`.
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

    const cors = makeCORS(env);
    try {
      // ─── Public read endpoints ─────────────────────────────────────────
      if (url.pathname === "/api/leagues") {
        return cors.cachedJson({ leagues: SUPPORTED_LEAGUES.map(l => l.key) }, 200, 3600);
      }

      if (url.pathname === "/api/lineage") {
        const league = leagueFrom(url); guardLeague(league);
        const lineage = await readMergedLineage(league, env);
        if (!lineage.currentChamp && lineage.changes.length === 0) {
          return cors.json({ error: "No data yet. Run build_lineage.py and upload_to_worker.py." }, 404);
        }
        return cors.cachedJson(lineage);
      }

      if (url.pathname === "/api/events") {
        const league = leagueFrom(url); guardLeague(league);
        return await streamEventsFromKV(league, env, cors);
      }

      if (url.pathname === "/api/stats") {
        const league = leagueFrom(url); guardLeague(league);
        return cors.cachedJson(await computeStatsFromLineage(league, env));
      }

      if (url.pathname === "/api/brand") {
        const league = leagueFrom(url); guardLeague(league);
        return cors.cachedJson(await loadBrand(env, league), 200, 3600);
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
        return cors.json({ ok: true, league, eventCount: body.events.length });
      }

      if (url.pathname === "/admin/status") {
        guardAdmin(request, env, cors);
        const league = leagueFrom(url); guardLeague(league);
        const lineage = await readMergedLineage(league, env);
        const lastUpdate = await env.KV.get(`${league}:lastUpdate`);
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

      // ─── Admin: branding (unchanged from original Worker) ──────────────
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
          logo:  body.logo  || curr[code]?.logo  || "",
        };
        await saveBrand(env, league, curr);
        return cors.json({ ok: true, updated: curr[code] });
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
];

/**
 * Inline historic lineage — PASTE OUTPUT/lineage-<LEAGUE>.JSON CONTENTS HERE
 * after running build_lineage.py. Until you do, KV `${league}:static` (set via
 * /admin/upload-lineage) takes precedence. So you have two equivalent paths:
 *   1. Run build_lineage.py → upload via upload_to_worker.py → KV wins.
 *   2. Run build_lineage.py → paste each JSON into this constant → redeploy.
 * Path (1) is recommended because you don't need to redeploy to refresh data.
 */
const STATIC_LINEAGE = {
  // NBA: { league:"NBA", seedTeam:"...", seedDate:"...", asOfDate:"...", currentChamp:"...", changes:[...] },
  // NFL: {...},
  // MLB: {...},
  // NHL: {...},
  // EPL: {...},
  // CFB: {...},
};

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
  const kvBlob = await env.KV.get(`${league}:static`, { type: "json" });
  if (kvBlob) return kvBlob;
  return STATIC_LINEAGE[league] || null;
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

/* ─── Incremental update (cron) ────────────────────────────────────────── */

async function updateLeagueIncremental(league, env) {
  try {
    const lineage = await readMergedLineage(league, env);
    if (!lineage.currentChamp) return; // no static data yet
    const since = lineage.changes.length
      ? lineage.changes[lineage.changes.length - 1].date.slice(0, 10)
      : lineage.asOfDate || addDays(today(), -7);
    const end = today();
    if (since >= end) return;
    // Fetch only games involving the current holder in [since, end].
    const games = await ADAPTERS[league].fetchRecentForTeam(lineage.currentChamp, since, end);
    if (!games.length) {
      await env.KV.put(`${league}:lastUpdate`, new Date().toISOString());
      return;
    }
    games.sort((a, b) => new Date(a.date) - new Date(b.date));
    const { current, changes, events } = computeLineage(games, lineage.currentChamp);
    const newChanges = changes.filter(c => !c.seed && c.from !== null);
    if (newChanges.length) {
      const existing = (await env.KV.get(`${league}:deltaChanges`, { type: "json" })) || [];
      const haveIds = new Set(existing.map(c => c.gameId).filter(Boolean));
      const fresh = newChanges.filter(c => c.gameId && !haveIds.has(c.gameId));
      if (fresh.length) {
        await env.KV.put(`${league}:deltaChanges`, JSON.stringify(existing.concat(fresh)));
      }
    }
    if (events.length) {
      await appendEventsToKV(league, events, env);
    }
    await env.KV.put(`${league}:lastUpdate`, new Date().toISOString());
  } catch (err) {
    console.log(`updateLeagueIncremental ${league} failed:`, err.message);
  }
}

async function appendEventsToKV(league, newEvents, env) {
  const existing = (await env.KV.get(`${league}:events`, { type: "json" })) || { league, asOfDate: today(), events: [] };
  const haveIds = new Set((existing.events || []).map(e => e.gameId).filter(Boolean));
  const fresh = newEvents.filter(e => e.gameId && !haveIds.has(e.gameId));
  if (!fresh.length) return;
  existing.events = (existing.events || []).concat(fresh);
  existing.asOfDate = today();
  await env.KV.put(`${league}:events`, JSON.stringify(existing));
}

/* ─── Probe (for debugging upstream API shape changes) ─────────────────── */

async function probeAdapter(league, env) {
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

// MLB — StatsAPI with hydrate=team so abbreviations are always present.
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
      const home = t.home?.team || {}, away = t.away?.team || {};
      const game = {
        id: `MLB-${g.gamePk}`,
        date: g.gameDate,
        home: { id: norm(home.abbreviation || home.teamCode || home.name) },
        away: { id: norm(away.abbreviation || away.teamCode || away.name) },
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
            home: { id: norm(h.abbrev || h.triCode || h.name?.default) },
            away: { id: norm(a.abbrev || a.triCode || a.name?.default) },
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
              home: { id: norm(h.team?.abbreviation || h.team?.shortDisplayName) },
              away: { id: norm(a.team?.abbreviation || a.team?.shortDisplayName) },
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

const PUBLIC_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>The Lineal Champ</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  :root {
    --bg: #0b0d12;
    --bg-elev: #14171f;
    --bg-card: #1a1e28;
    --text: #e6e7eb;
    --text-dim: #9aa0ad;
    --border: #262b38;
    --accent: #4f6cf7;
    --win: #2dd4bf;
    --loss: #f87171;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--text); margin: 0; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; min-height: 100vh; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 16px 80px; }
  h1 { margin: 0 0 16px; font-size: 28px; letter-spacing: -0.02em; }
  .tabs { display: flex; gap: 6px; margin-bottom: 20px; flex-wrap: wrap; }
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

  /* Landing page */
  .landing { display: none; }
  .landing.on { display: block; }
  .tracker { display: none; }
  .tracker.on { display: block; }
  .land-hero { padding: 72px 24px 48px; text-align: center; }
  .land-hero .eyebrow { font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase;
    color: var(--text-dim); margin-bottom: 12px; }
  .land-hero h1 { margin: 0 0 18px; font-size: 64px; line-height: 1.02;
    letter-spacing: -0.04em; font-weight: 800; }
  .land-hero h1 .accent { background: linear-gradient(135deg, #facc15, #f59e0b);
    -webkit-background-clip: text; background-clip: text; color: transparent; }
  .land-hero .tagline { color: var(--text-dim); font-size: 18px; max-width: 640px;
    margin: 0 auto 28px; line-height: 1.55; }
  .land-pick { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 8px; }
  .land-pick a { display: inline-flex; align-items: center; gap: 8px;
    padding: 12px 20px; background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: 999px; color: var(--text); text-decoration: none; font-weight: 600;
    font-size: 15px; transition: border-color 0.15s, transform 0.05s; }
  .land-pick a:hover { border-color: var(--accent); }
  .land-pick a:active { transform: scale(0.97); }
  .land-section { max-width: 720px; margin: 60px auto; padding: 0 8px; }
  .land-section h2 { font-size: 28px; margin: 0 0 14px; letter-spacing: -0.02em; }
  .land-section p { line-height: 1.7; font-size: 16px; color: var(--text); margin: 0 0 16px; }
  .land-section p.dim { color: var(--text-dim); }
  .land-quote { border-left: 3px solid #f59e0b; padding: 4px 0 4px 18px;
    margin: 24px 0; font-style: italic; color: var(--text); }
  .land-quote .who { display: block; margin-top: 8px; font-style: normal;
    font-size: 13px; color: var(--text-dim); letter-spacing: 0.04em; }
  .land-chain { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0 8px; align-items: center; }
  .land-chain span.name { background: var(--bg-elev); border: 1px solid var(--border);
    padding: 6px 12px; border-radius: 8px; font-weight: 600; font-size: 14px; }
  .land-chain span.arrow { color: var(--text-dim); }
  .land-coverage { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px; margin-top: 14px; }
  .land-coverage .row { background: var(--bg-elev); border: 1px solid var(--border);
    padding: 12px 14px; border-radius: 10px; }
  .land-coverage .row b { display: block; font-size: 15px; margin-bottom: 2px; }
  .land-coverage .row span { color: var(--text-dim); font-size: 12px; }
  .land-cta { text-align: center; margin: 56px 0 24px; }
  .land-cta .land-pick { margin-top: 18px; }
  @media (max-width: 600px) {
    .land-hero { padding: 48px 16px 32px; }
    .land-hero h1 { font-size: 42px; }
    .land-hero .tagline { font-size: 16px; }
    .land-section { margin: 40px auto; }
    .land-section h2 { font-size: 22px; }
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
  <div class="landing" id="landing">
    <div class="land-hero">
      <div class="eyebrow">The man who beat the man</div>
      <h1>The <span class="accent">Lineal</span> Champ</h1>
      <div class="tagline">A boxing-style championship belt for every major league. The belt only changes hands when the holder loses — never by committee, never by tournament seed, never by sanctioning body. Just the ring.</div>
      <div class="land-pick" id="landPick"></div>
    </div>

    <div class="land-section">
      <h2>What is a lineal champion?</h2>
      <p>In boxing, the <b>lineal</b> championship is the one passed down in an unbroken chain from "the man who beat the man." A title only changes hands when the reigning champion is defeated — not when they're stripped, not when they vacate, not when an alphabet organization votes a new champion into existence.</p>
      <p>If you want to be the lineal champ, you don't win a tournament. You go beat the guy who beat the guy.</p>
      <div class="land-quote">
        "To be the man, you've got to beat the man."
        <span class="who">— Ric Flair, paraphrasing roughly a hundred years of boxing tradition</span>
      </div>
    </div>

    <div class="land-section">
      <h2>The origin of the term</h2>
      <p>The concept goes back to bareknuckle boxing in the 1880s, when there were no sanctioning bodies at all. The heavyweight title was traced as a direct chain of champions:</p>
      <div class="land-chain">
        <span class="name">John L. Sullivan</span>
        <span class="arrow">→</span>
        <span class="name">Corbett</span>
        <span class="arrow">→</span>
        <span class="name">Fitzsimmons</span>
        <span class="arrow">→</span>
        <span class="name">Jeffries</span>
        <span class="arrow">→</span>
        <span class="name">Burns</span>
        <span class="arrow">→</span>
        <span class="name">Johnson</span>
        <span class="arrow">→</span>
        <span class="name">…</span>
      </div>
      <p>Each man held the title until the next one defeated him. There was no ambiguity. As the 20th century brought competing sanctioning bodies — the WBC, WBA, IBF, WBO, each with their own belt and their own politics — "lineal" became the championship that couldn't be voted into existence or stripped on a technicality.</p>
      <p>The Ring magazine has tracked lineal title rankings for decades. When a champion retires undefeated, the line is sometimes considered "vacated" and reconstructed from the most recent transfer of the belt. The history is contested in places, which is part of the appeal.</p>
    </div>

    <div class="land-section">
      <h2>Applied to team sports</h2>
      <p>This site asks a simple thought experiment: <i>who would currently hold the lineal belt</i> if a single championship had been on the line every game?</p>
      <p>We start from a seed team in each league's first season and walk forward through every game ever played. Belt holder wins → they keep it. Belt holder loses → the winner takes it. Ties don't change anything. The current champion is whoever happens to hold the belt when the music stops.</p>
      <p class="dim">It's not a serious claim that the lineal champ is "the best" team. Lineage is path-dependent — a team can hold the belt for years without ever winning a real championship, or a dynasty can lose the belt early and never get it back. That's part of the charm.</p>
    </div>

    <div class="land-section">
      <h2>What we cover</h2>
      <p class="dim">The lineage for each league is computed from a complete game-by-game record going back to:</p>
      <div class="land-coverage">
        <div class="row"><b>NBA</b><span>1947 — BAA inaugural season</span></div>
        <div class="row"><b>NFL</b><span>2002 — earliest available data</span></div>
        <div class="row"><b>MLB</b><span>1871 — National Association</span></div>
        <div class="row"><b>NHL</b><span>1917 — league founding</span></div>
        <div class="row"><b>EPL</b><span>1992 — Premier League formation</span></div>
        <div class="row"><b>CFB</b><span>1869 — first college football game</span></div>
      </div>
    </div>

    <div class="land-section">
      <h2>The fine print</h2>
      <p>Where teams have changed cities or names (Brooklyn Dodgers → Los Angeles Dodgers, St. Louis Rams → Los Angeles Rams), our underlying data sometimes uses different codes for what fans think of as the same franchise. The lineage is "city-faithful," not "fan-faithful" — a relocation usually counts as a new entity.</p>
      <p>For early-era leagues with many short-lived franchises, the belt automatically transfers to the next game's winner if the current holder hasn't played in over a year. This stops the title from getting permanently stranded on defunct teams like the Fort Wayne Kekiongas (1871) or the Quebec Bulldogs (1920s).</p>
    </div>

    <div class="land-cta">
      <h2>Pick a sport.</h2>
      <p class="dim">Tap any league to see the current belt holder and the entire chain of fights that got them there.</p>
      <div class="land-pick" id="landPick2"></div>
    </div>
  </div>

  <div class="tracker" id="tracker">
  <h1>The Lineal Champ <button id="aboutBtn" class="about-link" title="About">?</button></h1>
  <div class="tabs" id="tabs"></div>
  <div class="hero" id="hero">
    <div class="accent-bg"></div>
    <div class="label">Current Lineal Champion</div>
    <div class="champ-row">
      <img id="champLogo" class="champ-logo no-logo" alt=""/>
      <div class="champ-text">
        <h2 id="champName">—</h2>
        <div class="sub" id="champSub">Loading…</div>
      </div>
    </div>
    <div class="stats" id="statsGrid"></div>
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
  var PALETTE = ['#4f6cf7','#2dd4bf','#fb923c','#f472b6','#a78bfa','#facc15','#34d399'];
  function colorFor(s){ var h=0; for(var i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))|0; return PALETTE[Math.abs(h)%PALETTE.length]; }

  var LEAGUES = ['NBA','NFL','MLB','NHL','EPL','CFB'];
  var SHOW_LANDING = !new URLSearchParams(location.search).get('l');
  var league = (new URLSearchParams(location.search).get('l') || 'NBA').toUpperCase();
  if (LEAGUES.indexOf(league) < 0) league = 'NBA';

  var BRAND = {}, DATA = null, EVENTS = null;

  function el(id){ return document.getElementById(id); }
  function pct(){ return Math.random(); }

  function renderTabs(){
    el('tabs').innerHTML = LEAGUES.map(function(L){
      return '<button data-l="'+L+'" '+(L===league?'class="active"':'')+'>'+L+'</button>';
    }).join('');
    Array.prototype.forEach.call(el('tabs').children, function(b){
      b.addEventListener('click', function(){
        league = b.getAttribute('data-l');
        history.replaceState(null, '', '?l='+league);
        renderTabs(); EVENTS = null; load();
      });
    });
  }

  function fmtDate(s){
    if (!s) return '';
    try { return new Date(s).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}); }
    catch(e){ return s.slice(0,10); }
  }
  function daysBetween(a, b){
    return Math.max(0, Math.floor((new Date(b) - new Date(a)) / (24*3600*1000)));
  }
  function brandFor(code){
    var b = BRAND[code];
    return {
      name: (b && b.name) || code,
      color: (b && b.color) || colorFor(code || ''),
      logo: (b && b.logo) || '',
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
      renderHero();
      renderStrip();
      if (el('timeline').classList.contains('open')) renderTimeline();
    } catch (e) {
      el('champName').textContent = 'Error';
      el('champSub').textContent = e.message;
    }
  }

  function renderHero(){
    var b = brandFor(DATA.currentChamp);
    el('hero').style.setProperty('--champ-color', b.color);
    el('champName').textContent = b.name;
    if (b.logo) {
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
    var days = reignStart ? daysBetween(reignStart, new Date().toISOString()) : 0;
    var prev = null;
    for (var i = changes.length-1; i >= 0; i--) {
      if (changes[i].from && changes[i].from !== DATA.currentChamp) { prev = changes[i]; break; }
    }
    el('champSub').innerHTML = prev
      ? 'Won the belt on '+fmtDate(prev.date)+' vs '+escapeHTML(brandFor(prev.from).name)
      : (DATA.asOfDate ? 'Holds the lineal title (data as of '+fmtDate(DATA.asOfDate)+')' : '');

    var reigns = computeAllReigns(changes);
    var totalChanges = (DATA.changes||[]).filter(function(c){ return c.from; }).length;
    var reignNum = countReignsFor(changes, DATA.currentChamp);
    var rankInfo = longevityRank(reigns, DATA.currentChamp);
    var stats = [
      { k: 'Days held', v: days.toLocaleString(), action: 'reign', hint: 'click for games' },
      { k: 'Total belt changes', v: totalChanges.toLocaleString(), action: 'history', hint: 'click for history' },
      { k: 'Reign #', v: reignNum, action: 'reign', hint: 'click for games' },
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

  function countReignsFor(changes, team){
    var n = 0;
    for (var i = 0; i < changes.length; i++) if (changes[i].to === team) n++;
    return String(n);
  }

  // All historical reigns as { team, startDate, endDate, days }.
  // The active reign uses today as endDate.
  function computeAllReigns(changes){
    var sorted = changes.slice().sort(function(a,b){ return new Date(a.date) - new Date(b.date); });
    var out = [];
    var todayIso = new Date().toISOString();
    for (var i = 0; i < sorted.length; i++) {
      var c = sorted[i];
      var endIso = (i+1 < sorted.length) ? sorted[i+1].date : todayIso;
      out.push({ team: c.to, startDate: c.date, endDate: endIso, days: daysBetween(c.date, endIso) });
    }
    return out;
  }

  function longevityRank(reigns, team){
    var sorted = reigns.slice().sort(function(a,b){ return b.days - a.days; });
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
    var games = (EVENTS||[]).filter(function(ev){
      return ev.champ === DATA.currentChamp && (!start || new Date(ev.date) >= new Date(start));
    }).sort(function(a,b){ return new Date(b.date) - new Date(a.date); });
    var sub = b.name + ' — current reign began ' + (start ? fmtDate(start) : '—');
    var body = games.length
      ? games.map(function(ev){
          var opp = brandFor(ev.opponent);
          var cls = ev.result === 'W' ? 'win' : 'loss';
          var verb = ev.result === 'W' ? 'beat' : 'lost to';
          return '<div class="modal-row '+cls+'">'
            + '<span class="when">'+fmtDate(ev.date)+'</span>'
            + '<span class="what">'+verb+' '+escapeHTML(opp.name)+'</span>'
            + '<span class="score">'+escapeHTML(ev.champScore+'-'+ev.oppScore)+'</span>'
            + '</div>';
        }).join('')
      : '<div style="color:var(--text-dim);padding:10px 0">No games recorded during this reign yet.</div>';
    showModal('Current reign — ' + games.length + ' game' + (games.length===1?'':'s'), sub, body);
  }

  function openHistoryModal(){
    var changes = (DATA.changes||[]).filter(function(c){ return c.from; })
      .slice().sort(function(a,b){ return new Date(b.date) - new Date(a.date); });
    var body = changes.map(function(c){
      var from = brandFor(c.from), to = brandFor(c.to);
      return '<div class="modal-row loss">'
        + '<span class="when">'+fmtDate(c.date)+'</span>'
        + '<span class="what"><b style="color:'+to.color+'">'+escapeHTML(to.name)+'</b> took belt from '+escapeHTML(from.name)+'</span>'
        + (c.score ? '<span class="score">'+escapeHTML(c.score)+'</span>' : '')
        + '</div>';
    }).join('');
    showModal('Belt change history', changes.length + ' total transfers, newest first', body || '<div style="padding:10px 0;color:var(--text-dim)">No changes recorded.</div>');
  }

  function openRankModal(){
    var changes = (DATA.changes||[]).slice();
    var reigns = computeAllReigns(changes).sort(function(a,b){ return b.days - a.days; });
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
    var sub = brandFor(meTeam).name + "'s current reign ranks " + myEntry.label + ' out of ' + myEntry.total + ' all-time reigns';
    showModal('Longest reigns — top 20', sub, body);
  }

  function openAsOfModal(){
    var sources = {
      NBA: 'balldontlie.io /v1/games (1947+)',
      NFL: 'balldontlie.io /nfl/v1/games (2002+)',
      MLB: 'Retrosheet game logs (1871+)',
      NHL: 'hockey-reference.com (1917+)',
      EPL: 'balldontlie.io /epl/v1/games (1992+)',
      CFB: 'collegefootballdata.com (1869+, FBS)'
    };
    var src = sources[league] || '—';
    var body = '<div style="line-height:1.7;font-size:14px">'
      + '<div><b>Snapshot date:</b> '+(DATA.asOfDate ? fmtDate(DATA.asOfDate) : '—')+'</div>'
      + '<div><b>Source:</b> '+escapeHTML(src)+'</div>'
      + '<div><b>Live updates since snapshot:</b> '+(DATA.deltaCount || 0)+'</div>'
      + '<div style="margin-top:14px;color:var(--text-dim);font-size:13px">'
      + "Static lineage was computed offline and uploaded to KV. Daily cron fetches the current champion's upcoming games and appends any belt changes since the snapshot."
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
        + (c.score ? '<div class="score">'+escapeHTML(c.score)+'</div>' : '')
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
    t.innerHTML = list.slice(0, 500).map(function(ev){
      var champ = brandFor(ev.champ), opp = brandFor(ev.opponent);
      var cls = 'ev ' + (ev.change ? 'loss change' : (ev.result === 'W' ? 'win' : 'loss'));
      var pill = ev.change ? 'NEW CHAMP' : (ev.result === 'W' ? 'DEFENDED' : 'LOST');
      var desc = ev.change
        ? nameSpan(ev.opponent) + ' beat ' + nameSpan(ev.champ) + ' (' + escapeHTML(ev.champScore+'-'+ev.oppScore) + ')'
        : nameSpan(ev.champ) + (ev.result === 'W' ? ' beat ' : ' lost to ') + nameSpan(ev.opponent) + ' (' + escapeHTML(ev.champScore+'-'+ev.oppScore) + ')';
      return '<div class="'+cls+'">'
        + '<span class="date">'+fmtDate(ev.date)+'</span>'
        + '<span class="pill">'+pill+'</span>'
        + '<span class="desc">'+desc+'</span>'
        + '</div>';
    }).join('') || '<div style="padding:14px;color:var(--text-dim)">No events available yet — make sure upload_to_r2.py ran.</div>';
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
      return '<a href="?l='+L+'">'+L+'</a>';
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
    <select id="bL"><option>NBA</option><option>NFL</option><option>MLB</option><option>NHL</option><option>EPL</option><option>CFB</option></select>
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

  var LEAGUES = ["NBA","NFL","MLB","NHL","EPL","CFB"];
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
