"use strict";
const assert = require("node:assert/strict");
const { collect } = require("../vendor/baseball_capture_collector");

const nowISO = "2026-10-22T17:00:00Z";
const tomorrow = "2026-10-23";
const candidatesAt = "2026-10-22T16:00:00Z";
const emptyGet = async () => [];

async function main() {
  const paths = [];
  const rows = {
    mlb_games: [{ game_pk: 849805, game_date: tomorrow, game_time: "2026-10-24T00:00:00Z", status: "Scheduled", season: 2026,
      scheduled_innings: 9, away_team_id: 139, away_team_name: "Rays", home_team_id: 158, home_team_name: "Brewers",
      away_pitcher_id: 111, home_pitcher_id: 694819 }],
    mlb_pitcher_advanced_stats: [{ player_id: 111, season: 2025 }, { player_id: 694819, season: 2026 }],
    mlb_candidates_history: [{ id: 1, game_id: "849805", market: "HC", pick_side: "AWAY +1.5", hc_value: 1.5,
      odds: 1.93, prob_estimated: 0.56, edge: 0.08, model_version: "autopicks_v2", created_at: candidatesAt,
      // Even self-asserted flags on a legacy row must not manufacture evidence.
      quote_verified: true, model_input_available: true, market_timestamp_verified: true,
      odds_captured_at: "2026-10-22T15:59:00Z", p_loss: null, p_push: null }],
    kbo_official_games: [{ game_pk: "k1", game_date: tomorrow, game_time_kst: "18:30", away_team: "LG", home_team: "KIA", season: 2026, status: "scheduled" }],
    npb_source_games: [{ game_pk: "n1", game_date: "2026-10-24", game_time_local: "18:30", away_team: "FS", home_team: "DB", season: 2026, status: "scheduled", scheduled_innings: 9,
      source: "spaia.jp", away_starter_id: "10", home_starter_id: "11" }],
    npb_player_stats: ["10", "11"].map((id, i) => ({ source: "spaia.jp", source_player_id: id, team_abbr: i ? "DB" : "FS", season: 2026,
      stats_type: "pitching", source_url: "https://spaia.jp/baseball/npb", source_as_of: "2026-09-30", source_checked_at: candidatesAt })),
    cpbl_source_games: [{ game_pk: "c1", game_date: "2026-10-24", game_time_local: "17:05", away_team: "BR", home_team: "DR", season: 2026, status: "scheduled", source: "stats.cpbl.com.tw", away_starter_id: "20", home_starter_id: "21" }],
    cpbl_player_stats: ["20", "21"].map((id,i)=>({season:2026,team_abbr:i?"DR":"BR",stats_type:"pitching",source:"stats.cpbl.com.tw",source_player_id:id,source_url:"https://stats.cpbl.com.tw",source_as_of:"2026-10-06",source_checked_at:candidatesAt})),
    cnbs_games: [{ game_pk: "cn1", game_date: tomorrow, game_time: "2026-10-23T18:00:00Z", status: "Scheduled", season: 2026,
      source: "gpo.wbsc.org", updated_at: candidatesAt, scheduled_innings: 7,
      away_team_abbr: "RIV", away_team: "Rivas", home_team_abbr: "GRA", home_team: "Granada",
      away_pitcher: "José Pérez", home_pitcher: "Juan Lopez" }],
    cnbs_player_stats: [
      { team_abbr: "RIV", player_name: "Jose Perez", season: 2026, stats_type: "pitching", source: "gpo.wbsc.org", source_player_id: "p1", source_url: "https://gpo.wbsc.org/api/v1/stats/example", source_as_of: "2026-10-21", updated_at: candidatesAt },
      { team_abbr: "GRA", player_name: "Juan Lopez", season: 2026, stats_type: "pitching", source: "gpo.wbsc.org", source_player_id: "p2", source_url: "https://gpo.wbsc.org/api/v1/stats/example", source_as_of: "2026-10-20", updated_at: candidatesAt },
    ],
    daily_games: [{ game_id: 10, game_date: "2026-10-23T01:05:00Z", sport_id: 11, scheduled_innings: 9,
      away_team_id: 1, home_team_id: 2, away_pitcher_id: null, home_pitcher_id: null }],
  };
  const get = async path => { paths.push(path);
    if (path.startsWith("bb_capture_health?") && ["NPB","CPBL","MILB"].some(l=>path.includes("league=eq."+l+"&"))) return ["calendar", "stats", "postgame"].map(component => ({ component, status: "healthy", checked_at: candidatesAt, last_success_at: candidatesAt }));
    return rows[path.split("?")[0]] || []; };
  const result = await collect({ get, nowISO });
  assert.equal(result.leagues.length, 9);
  assert.equal(new Set(result.leagues.map(l => l.league)).size, 9);
  const packet = league => result.packets.find(p => p.league === league);
  const mlb = packet("MLB");
  assert.equal(mlb.game_id, "849805");
  assert.equal(mlb.start_time_utc, "2026-10-24T00:00:00.000Z");
  assert.equal(mlb.stats.current_season, false, "Prior-season pitcher cannot count as current stats");
  assert.equal(mlb.stats.provenance_verified, false);
  assert.equal(mlb.source_health, "unknown");
  assert.equal(mlb.candidate.selection, "AWAY");
  assert.equal(mlb.candidate.line, 1.5);
  assert.equal(mlb.candidate.period, null, "Do not assume full-game market");
  assert.equal(mlb.candidate.quote_verified, false);
  assert.equal(mlb.candidate.market_timestamp_verified, false);
  assert.equal(mlb.candidate.model_input_available, false);
  assert.equal(mlb.candidate.model_version_verified, false);
  assert.equal(mlb.candidate.p_push, null, "Do not invent tie or push mass");
  assert.equal(mlb.candidate.p_loss, null, "Do not assume one minus displayed probability");
  assert.equal(packet("KBO").start_time_utc, "2026-10-23T09:30:00.000Z");
  assert.equal(packet("NPB").start_time_utc, "2026-10-24T09:30:00.000Z");
  assert.equal(packet("NPB").stats.provenance_verified, true);
  assert.equal(packet("NPB").source_health, "healthy", "Freshly checked regular-season stats remain valid during postseason");
  assert.equal(packet("NPB").scheduled_innings, 9);
  assert(paths.some(p => p.startsWith("npb_player_stats?") && p.includes("source=eq.spaia.jp")));
  assert.equal(packet("CPBL").start_time_utc, "2026-10-24T09:05:00.000Z");
  assert.equal(packet("CPBL").stats.provenance_verified,true);
  assert.equal(packet("CPBL").source_health,"healthy");
  assert(paths.some(p=>p.startsWith("cpbl_player_stats?")&&p.includes("source=eq.stats.cpbl.com.tw")));
  assert.equal(packet("CNBS").stats.current_season, true);
  assert.equal(packet("CNBS").stats.provenance_verified, true);
  assert.equal(packet("CNBS").stats.source_as_of, "2026-10-20", "Use older of both pitcher source dates");
  assert.equal(packet("CNBS").source_health, "healthy");
  assert.equal(packet("MILB").status, "unknown", "Schedule table lacks a confirmed game state");
  assert.equal(result.leagues.find(l => l.league === "LMB").status, "NO_GAMES");
  assert.equal(result.leagues.find(l => l.league === "NPB2").source_health, "blocked");
  assert.equal(result.leagues.find(l => l.league === "LCB").source_health, "blocked");
  for (const path of paths) {
    const query = new URLSearchParams(path.split("?")[1]);
    assert.ok(["10", "30", "1000"].includes(query.get("limit")), "Every request is bounded");
    if (path.startsWith("daily_games?")) assert.equal(query.has("status"), false, "MiLB has no status column");
  }

  const empty = await collect({ get: emptyGet, nowISO });
  assert.equal(empty.packets.length, 0);
  assert.equal(empty.leagues.filter(l => l.status === "NO_GAMES").length, 4);
  assert.equal(empty.leagues.find(l => l.league === "NPB").status, "BLOCKED", "Missing capture health must block NPB");
  assert.ok(empty.leagues.every(l => !l.errors.length));

  for (const stale of [false, true]) {
    const health = await collect({ nowISO, get: async path => {
      if (path.startsWith('bb_capture_health?')) return ['calendar','stats'].map(component => ({component, status:'healthy', checked_at:stale?'2026-10-19T00:00:00Z':candidatesAt, last_success_at:candidatesAt}));
      if (path.startsWith('lcb_games?')) return [{game_pk:'LCB_BEC_1',game_date:tomorrow,game_time_local:'13:30',season:2026,status:'Scheduled',away_team:'IJV',home_team:'IND'}];
      return [];
    }});
    assert.equal(health.leagues.find(x=>x.league==='LCB').source_health, stale?'blocked':'healthy');
    assert.equal(health.packets.find(x=>x.league==='LCB').stats.source_as_of,null,'Capture freshness cannot invent a statistics cutoff');
  }

  const failures = await collect({ get: async path => { if (path.startsWith("mlb_games?")) throw Error("secret=test"); return []; }, nowISO });
  assert.equal(failures.leagues.find(l => l.league === "MLB").status, "ERROR");
  assert.equal(JSON.stringify(failures).includes("secret"), false);

  const bounded = await collect({ nowISO, get: async path => {
    if (path.startsWith("mlb_games?")) return Array.from({ length: 12 }, (_, i) => ({ game_pk: i + 1, game_date: tomorrow, game_time: "2026-10-23T01:00:00Z", status: "Scheduled", season: 2026 }));
    if (path.startsWith("mlb_candidates_history?")) return [
      { id: "future", game_id: 1, created_at: "2026-10-23T00:00:00Z", market: "ML", pick_side: "home" },
      { id: "old", game_id: 1, created_at: "2026-10-19T00:00:00Z", market: "ML", pick_side: "away" },
      { id: "latest", game_id: 1, created_at: candidatesAt, market: "UNDER", pick_side: "under", total_line: 8.5, odds: 2 },
    ];
    return [];
  } });
  assert.equal(bounded.packets.length, 10);
  assert.equal(bounded.packets[0].candidate.id, "latest");
  assert.equal(bounded.packets[0].candidate.market, "OU");
  assert.equal(bounded.packets[0].candidate.selection, "UNDER");
  assert.equal(bounded.packets[0].candidate.line, 8.5);
  assert.ok(bounded.leagues[0].warnings.includes("GAME_LIMIT_REACHED"));

  const outside = await collect({ nowISO, get: async path => path.startsWith("mlb_games?") ? [
    { game_pk: "past", game_date: "2026-10-22", game_time: "2026-10-22T16:00:00Z", status: "Scheduled" },
    { game_pk: "late", game_date: "2026-10-30", game_time: "2026-10-30T00:00:00Z", status: "Scheduled" },
    { game_pk: "final", game_date: tomorrow, game_time: "2026-10-23T00:00:00Z", status: "Final" },
  ] : [] });
  assert.equal(outside.packets.length, 0);
  await assert.rejects(collect({ get: emptyGet, nowISO: "2026-10-22" }), /explicit timezone/);
  console.log("collector: fixtures passed (no external calls)");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
