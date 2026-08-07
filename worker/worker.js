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

const PUBLIC_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>The Lineal Champ</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Lora:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
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
    var area = el('whatifArea');
    var banner = el('branchBanner');
    if (!area || !banner) return;
    if (!branches.length) {
      area.style.display = 'none';
      banner.style.display = 'none';
      return;
    }
    area.style.display = '';
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
      // Adopt any branches encoded in the URL that apply to this league.
      ACTIVE_BRANCHES = readBranchUrl().filter(function(bid){
        return BRANCH_POINTS.some(function(bp){ return bp.id === bid; });
      });
      applyActiveBranches();
      renderHero();
      renderStrip();
      renderWhatIfBadge();
      if (el('timeline').classList.contains('open')) renderTimeline();
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
  if (el('branchReset')) el('branchReset').addEventListener('click', resetBranches);
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
