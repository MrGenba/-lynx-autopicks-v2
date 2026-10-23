"use strict";

// Read-only Supabase adapter. The caller supplies transport and credentials.
// It deliberately does not infer executable quotes, model inputs or book rules
// from historical candidate rows. Null means that evidence is unavailable.
const DAY = 86400000;
const ACTIVE = new Set(["scheduled", "preview", "pre-game", "warmup"]);
const CONFIG = [
  ["MLB", "mlb_games", "mlb_candidates_history", "mlb_pitcher_advanced_stats", 0],
  ["MILB", "daily_games", "candidates_history", "milb_pitcher_advanced_stats", 0],
  ["LMB", "lmb_games", "lmb_candidates_history", "lmb_pitcher_advanced_stats", 0],
  ["KBO", "kbo_official_games", "kbo_candidates_history", "kbo_player_stats", 9],
  ["NPB", "npb_source_games", "npb_candidates_history", "npb_player_stats", 9],
  ["CPBL", "cpbl_source_games", "cpbl_candidates_history", "cpbl_player_stats", 8],
  ["CNBS", "cnbs_games", "cnbs_candidates_history", "cnbs_player_stats", -6],
  ["NPB2", "npb2_games", "npb2_candidates_history", "npb2_player_stats", 9],
  ["LCB", "lcb_games", "lcb_candidates_history", "lcb_player_stats", -4],
].map(([league, games, candidates, stats, utcOffset]) => ({ league, games, candidates, stats, utcOffset }));

const normalize = value => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const text = value => value == null || value === "" ? null : String(value);
const number = value => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const probability = value => { const n = number(value); return n !== null && n >= 0 && n <= 1 ? n : null; };
const iso = value => {
  if (typeof value !== "string" || !/T\d\d:\d\d/.test(value) || !/(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const day = time => new Date(time).toISOString().slice(0, 10);
const gameId = row => text(row.game_pk ?? row.game_id);

function startTime(row, config) {
  const explicit = iso(row.game_time) || iso(row.start_time_utc);
  if (explicit) return explicit;
  if (config.league === "MILB") return iso(row.game_date);
  const date = String(row.game_date || "").slice(0, 10);
  const time = row.game_time_kst ?? row.game_time_local;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(String(time || ""))) return null;
  const [hours, minutes, seconds = 0] = String(time).split(":").map(Number);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const midnight = Date.parse(date + "T00:00:00Z");
  if (!Number.isFinite(midnight) || day(midnight) !== date) return null;
  return new Date(midnight + ((hours - config.utcOffset) * 3600 + minutes * 60 + seconds) * 1000).toISOString();
}

function team(row, side) {
  return {
    id: text(row[side + "_team_id"] ?? row[side + "_team_abbr"] ?? row[side + "_team"]),
    name: text(row[side + "_team_name"] ?? row[side + "_team_full"] ?? row[side + "_team_en"] ?? row[side + "_team"]),
  };
}

function starter(row, side) {
  const id = text(row[side + "_pitcher_id"] ?? row[side + "_starter_id"]);
  const rawName = row[side + "_pitcher_name"] ?? row[side + "_pitcher"] ?? row[side + "_starter"];
  const name = text(rawName);
  const knownName = name && !/^(tbd|por confirmar|unknown|pendiente|[-—?]+)$/i.test(name.trim());
  return { id, name: knownName ? name : null, confirmed: Boolean(id || knownName) };
}

function candidate(row) {
  if (!row) return null;
  const originalMarket = String(row.market || "").toUpperCase();
  const originalSide = String(row.pick_side ?? row.side ?? "").toUpperCase().trim();
  let market = null, selection = null;
  if (["ML", "MONEYLINE"].includes(originalMarket)) market = "ML";
  if (["OU", "OVER", "UNDER", "TOTAL"].includes(originalMarket)) market = "OU";
  if (["HC", "HC_AWAY", "HC_HOME", "RUN_LINE"].includes(originalMarket)) market = "HC";
  const sideMatch = originalSide.match(/^(AWAY|HOME|OVER|UNDER)(?:\s|$)/);
  if (sideMatch) selection = sideMatch[1];
  if (!selection && ["OVER", "UNDER"].includes(originalMarket)) selection = originalMarket;
  if (!selection && originalMarket === "HC_AWAY") selection = "AWAY";
  if (!selection && originalMarket === "HC_HOME") selection = "HOME";
  const expected = market === "OU" ? ["OVER", "UNDER"] : ["AWAY", "HOME"];
  if (!expected.includes(selection)) selection = null;
  const explicitVersion = text(row.model_version);
  return {
    id: text(row.id), market, selection,
    line: market === "OU" ? number(row.total_line) : market === "HC" ? number(row.hc_value) : null,
    odds: number(row.odds), opposite_odds: null, bookmaker: null,
    captured_at: iso(row.odds_captured_at), market_timestamp_verified: false,
    period: row.period === "FULL_GAME" ? "FULL_GAME" : null,
    p_win: probability(row.p_win ?? row.prob_estimated),
    p_push: probability(row.p_push), p_loss: probability(row.p_loss),
    model_version: explicitVersion, model_input_available: false, model_version_verified: false,
    engine_edge_score: number(row.edge), lineup_observed_at: null,
    rules_verified: false, quote_verified: false, opposite_same_market_verified: false,
  };
}

function matchingStat(rows, packet, side) {
  const pitcher = packet.starters[side];
  if (!pitcher.confirmed) return null;
  const valid = rows.filter(row => Number(row.season) === packet.season && (!row.stats_type || row.stats_type === "pitching"));
  const found = pitcher.id
    ? valid.filter(row => text(row.player_id ?? row.source_player_id) === pitcher.id)
    : valid.filter(row => normalize(row.player_name ?? row.name) === normalize(pitcher.name)
      && normalize(row.team_abbr ?? row.team_id) === normalize(packet[side].id));
  return found.length === 1 ? found[0] : null;
}

function statsFor(rows, packet, game, now) {
  const a = matchingStat(rows, packet, "away"), h = matchingStat(rows, packet, "home");
  const currentSeason = Boolean(a && h);
  if (["NPB", "CPBL"].includes(packet.league)) {
    const source=packet.league==='NPB'?'spaia.jp':'stats.cpbl.com.tw';
    const verified = Boolean(currentSeason && game.source === source && [a, h].every(row => row.source === source
      && row.source_player_id && (row.source_url==='https://'+source||String(row.source_url||'').startsWith('https://'+source+'/'))
      && /^\d{4}-\d{2}-\d{2}$/.test(row.source_as_of || "") && Date.parse(row.source_as_of) <= now));
    const fresh = verified && [a, h].every(row => iso(row.source_checked_at) && now-Date.parse(row.source_checked_at)>=0 && now-Date.parse(row.source_checked_at)<=48*3600000);
    return { current_season:currentSeason,provenance_verified:verified,source_as_of:verified?[a.source_as_of,h.source_as_of].sort()[0]:null,fresh:Boolean(fresh) };
  }
  // Only CNBS presently carries independently identifiable source records and
  // a source cutoff date. A timestamp on our database is not source provenance.
  const verified = Boolean(currentSeason && packet.league === "CNBS" && [a, h].every(row =>
    row.source === "gpo.wbsc.org" && row.source_player_id && row.source_url
    && /^https:\/\/gpo\.wbsc\.org\//.test(row.source_url)
    && /^\d{4}-\d{2}-\d{2}$/.test(row.source_as_of || "")));
  const dates = [a, h].filter(Boolean).map(row => row.source_as_of).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value || ""));
  const asOf = dates.length === 2 ? dates.sort()[0] : null;
  const fresh = verified && game.source === "gpo.wbsc.org"
    && iso(game.updated_at) && now - Date.parse(game.updated_at) >= 0 && now - Date.parse(game.updated_at) <= 36 * 3600000
    && [a, h].every(row => iso(row.updated_at) && now - Date.parse(row.updated_at) >= 0 && now - Date.parse(row.updated_at) <= 8 * DAY)
    && Date.parse(asOf + "T00:00:00Z") <= now && now - Date.parse(asOf + "T00:00:00Z") <= 8 * DAY;
  return { current_season: currentSeason, provenance_verified: verified, source_as_of: asOf, fresh: Boolean(fresh) };
}

function gamesPath(config, now, end) {
  if (config.league === "MILB") return config.games + "?select=*&game_date=gte." + encodeURIComponent(new Date(now).toISOString())
    + "&game_date=lte." + encodeURIComponent(new Date(end).toISOString()) + "&order=game_date.asc&limit=10";
  const localDay = day(now + config.utcOffset * 3600000);
  const endDay = day(end + config.utcOffset * 3600000);
  return config.games + "?select=*&game_date=gte." + localDay + "&game_date=lte." + endDay
    + "&status=in.(Scheduled,scheduled,Preview,Pre-Game,Warmup)&order=game_date.asc&limit=10";
}

function statsPath(config, packets) {
  const season = packets[0].season;
  if (["MLB", "MILB", "LMB"].includes(config.league)) {
    const ids = [...new Set(packets.flatMap(p => [p.starters.away.id, p.starters.home.id]).filter(id => /^\d+$/.test(id || "")))];
    if (!ids.length) return null;
    return config.stats + "?select=*&season=eq." + season + "&player_id=in.(" + ids.join(",") + ")&limit=1000";
  }
  const codes = [...new Set(packets.flatMap(p => [p.away.id, p.home.id]).filter(id => /^[A-Z0-9_]+$/.test(id || "")))];
  if (!codes.length) return null;
  return config.stats + "?select=*&season=eq." + season + "&stats_type=eq.pitching&team_abbr=in.(" + codes.join(",") + ")"
    + (config.league === "CPBL" ? "&source=eq.stats.cpbl.com.tw" : config.league === "NPB" ? "&source=eq.spaia.jp" : config.league === "KBO" ? "&source=eq.kbo_gamecenter" : config.league === "CNBS" ? "&source=eq.gpo.wbsc.org" : config.league === "NPB2" ? "&source=eq.farm-stats.com" : config.league === "LCB" ? "&source=eq.beisbolencuba.com" : "") + "&limit=1000";
}

async function collect({ get, nowISO } = {}) {
  if (typeof get !== "function") throw new TypeError("collect requires a read-only get(path) function");
  const normalizedNow = iso(nowISO);
  if (!normalizedNow) throw new TypeError("nowISO must include a valid time and explicit timezone");
  const now = Date.parse(normalizedNow), end = now + 7 * DAY, oldest = now - 2 * DAY;
  async function read(path, errors, stage) {
    try {
      const rows = await get(path);
      if (!Array.isArray(rows)) throw new TypeError("Expected rows");
      return rows;
    } catch (_) {
      // Never expose arbitrary transport error bodies (which can contain secrets).
      errors.push({ stage, table: path.split("?")[0], code: "READ_FAILED" });
      return null;
    }
  }
  const results = await Promise.all(CONFIG.map(async config => {
    const errors = [], warnings = [];
    const monitored = ["MILB", "CPBL", "NPB", "NPB2", "LCB"].includes(config.league);
    const captureRows = monitored ? await read("bb_capture_health?select=*&league=eq." + config.league + "&limit=10", errors, "capture_health") : [];
    const required = config.league === "MILB" ? ["calendar", "stats", "postgame"] : ["calendar", "stats"];
    const captureHealthy = monitored && required.every(component => {
      const record = (captureRows || []).find(row => row.component === component);
      const checked = iso(record?.checked_at), success = iso(record?.last_success_at);
      const maxAge = (config.league === "LCB" ? 12 : 48) * 3600000;
      return record?.status === "healthy" && checked && success && Date.parse(checked) <= now
        && Date.parse(success) <= now && now - Date.parse(checked) <= maxAge && now - Date.parse(success) <= maxAge;
    });
    const forced = monitored && !captureHealthy ? "blocked" : null;
    if ((captureRows || []).some(row => row.detail?.lookback_complete === false)) warnings.push("PREVIOUS_MONTH_SOURCE_UNAVAILABLE");
    if ((captureRows || []).some(row => row.detail?.excluded?.length)) warnings.push("INCONSISTENT_SOURCE_ROWS_EXCLUDED");
    const [rawGames, rawCandidates] = await Promise.all([
      read(gamesPath(config, now, end), errors, "games"),
      read(config.candidates + "?select=*&created_at=gte." + encodeURIComponent(new Date(oldest).toISOString())
        + "&created_at=lte." + encodeURIComponent(normalizedNow) + "&order=created_at.desc&limit=30", errors, "candidates"),
    ]);
    const candidates = (rawCandidates || []).slice(0, 30).filter(row => {
      const timestamp = iso(row.created_at);
      return timestamp && Date.parse(timestamp) >= oldest && Date.parse(timestamp) <= now;
    }).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const seen = new Set(), sourceGames = [];
    for (const row of (rawGames || []).slice(0, 10)) {
      const id = gameId(row), start = startTime(row, config);
      const status = String(row.status || "unknown").toLowerCase();
      if (!id || seen.has(id)) { warnings.push("MISSING_OR_DUPLICATE_GAME_ID"); continue; }
      if (config.league !== "MILB" && !ACTIVE.has(status)) continue;
      if (start && (Date.parse(start) <= now || Date.parse(start) > end)) continue;
      if (config.league === "MILB" && (row.away_score != null || row.home_score != null)) continue;
      if (!start) warnings.push("START_TIME_UNKNOWN");
      seen.add(id);
      sourceGames.push({ row, packet: {
        league: config.league, season: number(row.season) ?? (Number(String(row.game_date || "").slice(0, 4)) || new Date(now).getUTCFullYear()),
        game_id: id, start_time_utc: start, status,
        scheduled_innings: number(row.scheduled_innings), away: team(row, "away"), home: team(row, "home"),
        starters: { away: starter(row, "away"), home: starter(row, "home") },
        source_health: forced || "unknown", stats: { current_season: false, provenance_verified: false, source_as_of: null },
        candidate: candidate(candidates.find(c => gameId(c) === id)),
      } });
    }
    const packets = sourceGames.map(item => item.packet);
    // A seven-day window can cross seasons. Do not silently use one year's
    // statistics for all packets in that case.
    for (const season of new Set(packets.map(p => p.season))) {
      const seasonPackets = packets.filter(p => p.season === season);
      const path = statsPath(config, seasonPackets);
      const stats = path ? await read(path, errors, "stats") : [];
      for (const item of sourceGames.filter(item => item.packet.season === season)) {
        const assessed = statsFor(stats || [], item.packet, item.row, now);
        item.packet.stats = { current_season: assessed.current_season, provenance_verified: assessed.provenance_verified, source_as_of: assessed.source_as_of };
        item.packet.source_health = forced || (errors.length ? "error" : captureHealthy || assessed.fresh ? "healthy" : "unknown");
      }
    }
    if ((rawGames || []).length >= 10) warnings.push("GAME_LIMIT_REACHED");
    if ((rawCandidates || []).length >= 30) warnings.push("CANDIDATE_LIMIT_REACHED");
    const sourceHealth = forced || (errors.length ? "error" : captureHealthy || packets.length && packets.every(p => p.source_health === "healthy") ? "healthy" : "unknown");
    const status = forced === "blocked" ? "BLOCKED" : forced === "disabled" ? "DISABLED"
      : rawGames === null ? "ERROR" : !packets.length ? "NO_GAMES" : errors.length ? "DEGRADED" : "AWAITING_VALIDATION";
    return { packets, summary: {
      league: config.league, status, source_health: sourceHealth,
      games: packets.length, candidates: candidates.length, errors, warnings: [...new Set(warnings)],
      capture_health: monitored ? (captureRows || []).map(row => ({ component: row.component, status: row.status, checked_at: row.checked_at, last_success_at: row.last_success_at })) : undefined,
      reason: forced === "blocked" ? "Automatic capture is failing, stale, or has not completed successfully."
          : status === "NO_GAMES" ? "No upcoming games found in the seven-day calendar window; this alone is not a source failure." : null,
    } };
  }));
  return { packets: results.flatMap(result => result.packets), leagues: results.map(result => result.summary) };
}

module.exports = { collect };
