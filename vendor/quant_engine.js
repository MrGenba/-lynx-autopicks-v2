"use strict";
"use strict";

// ??? CONFIGURACI�N POR LIGA ???????????????????????????????????????????????????
// Keyed por sport_id de MLB Stats API (1=MLB, 11=AAA, 12=AA, 13=A+, 14=A).
// calibration_factor: correcci�n emp�rica derivada de backtest.
//   MiLB AAA (n=61, abr-2025?abr-2026): 1.067 confirmado.
//   Resto de ligas en 1.0 hasta acumular muestra suficiente (objetivo ?50 partidos).
// nb_k: dispersi�n Negative Binomial. k=8 calibrado para MiLB AAA.
// Statcast means: punto neutro para los ajustes de calidad de bateo/pitcheo.
//   En ligas sin Statcast los campos llegan null ? el modelo usa el fallback de liga.
const LEAGUE_CONFIG = {
  1: {   // MLB
    league_name: 'MLB',
    runs_per_team: 4.50,   // 2023: 4.61, 2024: 4.38 ? promedio conservador
    calibration_factor: 1.0,
    nb_k: 9,
    // [PENDING v2 - activar con n?150] DOCX �8: mercado MLB muy eficiente ? blend 50/50
    // nb_k_v2: 9,          // sin cambio - K=9 ya testado para MLB
    // park_factor_years: 3, // DOCX �5: promediar 3 a�os (60/30/10%) - requiere schema
    model_blend_ml: 0.62,  // [PENDING v2: cambiar a 0.50 cuando n_MLB?150]
    xwoba_mean: 0.318,
    hard_hit_mean: 38,
    barrel_mean: 8,
    exit_velo_mean: 88.5,
    bb_pct_mean: 8.4,
    k_pct_mean: 23,
  },
  11: {  // MiLB AAA - calibrado con backtest real abr-2025?abr-2026 (n=61)
    league_name: 'MiLB AAA',
    runs_per_team: 4.55,
    calibration_factor: 1.11,
    nb_k: 3.7,  // 2026-07-04: recalibrado desde 7 con backtest de cola (backtest/backtest_nb_milb.js) -
    // metodo de momentos sobre 2868 partidos AAA reales (media=5.40, varianza=13.08) da k=3.7-4.5;
    // se probo tambien un modelo con shock comun (correlacion away-home=0.075) pero el P/L real en
    // candidatos edge>=8% fue peor que el simple k=3.7 (+0.96u vs -1.68u) - no se implemento el shock.
    lineup_adjust_enabled: true, // 2026-07-04 - Fase 2 lineup_factor
    model_blend_ml: 0.62,  // DOCX �8: mercado MiLB ineficiente ? 62/38 correcto
    xwoba_mean: 0.312,
    hard_hit_mean: 37,    // AAA < MLB (38) > AA (36)
    barrel_mean: 7,
    exit_velo_mean: 87.5, // AAA < MLB (88.5) > AA (87.0)
    bb_pct_mean: 8.5,
    k_pct_mean: 22,
  },
  12: {  // MiLB AA
    league_name: 'MiLB AA',
    runs_per_team: 4.30,
    calibration_factor: 1.0,
    nb_k: 8,
    model_blend_ml: 0.62,
    xwoba_mean: 0.308,
    hard_hit_mean: 36,
    barrel_mean: 6,
    exit_velo_mean: 87,
    bb_pct_mean: 9.0,
    k_pct_mean: 23,
  },
  13: {  // MiLB A+ (High-A)
    league_name: 'MiLB A+',
    runs_per_team: 4.25,  // A+ < AA en nivel de juego
    calibration_factor: 1.0,
    nb_k: 8,
    model_blend_ml: 0.62,
    xwoba_mean: 0.305,
    hard_hit_mean: 35,
    barrel_mean: 5,
    exit_velo_mean: 86,
    bb_pct_mean: 10.0,
    k_pct_mean: 24,
  },
  14: {  // MiLB A (Single-A)
    league_name: 'MiLB A',
    runs_per_team: 4.20,
    calibration_factor: 1.0,
    nb_k: 8,
    model_blend_ml: 0.62,
    xwoba_mean: 0.300,
    hard_hit_mean: 33,
    barrel_mean: 5,
    exit_velo_mean: 85,
    bb_pct_mean: 11.0,
    k_pct_mean: 25,
  },
};

const DEFAULT_LEAGUE_CONFIG = LEAGUE_CONFIG[11];

function toNumber(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getLeagueConfig(game) {
  const sportId = toNumber(game?.sport_id);
  return (sportId != null && LEAGUE_CONFIG[sportId]) || DEFAULT_LEAGUE_CONFIG;
}

function round3(value) {
  const num = toNumber(value);
  return num == null ? null : Number(num.toFixed(3));
}

function round2(value) {
  const num = toNumber(value);
  return num == null ? null : Number(num.toFixed(2));
}

function clamp(value, min, max) {
  const num = toNumber(value);
  if (num == null) return null;
  return Math.min(Math.max(num, min), max);
}

function average(values) {
  const valid = values.map(toNumber).filter(value => value != null);
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function weightedAverage(pairs, fallback) {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const pair of pairs) {
    const value = toNumber(pair?.value);
    const weight = toNumber(pair?.weight);
    if (value == null || weight == null || weight <= 0) continue;
    weightedSum += value * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return fallback;
  return weightedSum / totalWeight;
}

function safeRatio(numerator, denominator) {
  const num = toNumber(numerator);
  const den = toNumber(denominator);
  if (num == null || den == null || den === 0) return null;
  return num / den;
}

function inningsScale(game) {
  const innings = toNumber(game?.scheduled_innings) || 9;
  return clamp(innings / 9, 0.65, 1);
}

// OVER reactivado abr-19-2026. Muestra previa: 6W-7L -1.53u (17 picks abr-4/10). Monitorear.
const DISABLED_MARKETS = new Set([]);

// ????? HC / RUNLINE RULES ???????????????????????????????????????????????????????????
// No apostar HC si el modelo no pronostica suficiente diferencial de carreras.
// Umbral configurable: aumentar cuando tengamos m�s muestra calibrada.
const RUNLINE_MIN_DIFF = 0.80; // carreras de diferencial m�nimo para publicar HC

// ??? BUCKET CALIBRATION TABLE ?????????????????????????????????????????????????
// Framework listo para recibir correcciones hist�ricas.
// Estructura: [market][implied_bucket][data_bucket] = ajuste aditivo sobre prob_calibrada
// Todos los ajustes en 0.0 hasta tener muestra suficiente (objetivo: ?150 picks resueltos).
// Reemplazar� los boosts manuales de calibrationModelWeight cuando tengamos datos.
//
// implied_bucket:  "strong_fav"  implied >0.62  (odds <1.61)
//                  "fav"         implied  0.55-0.62
//                  "neutral"     implied  0.48-0.55
//                  "dog"         implied  0.38-0.48
//                  "heavy_dog"   implied <0.38  (odds >2.63)
// data_bucket:     "high"  dataScore ?0.70
//                  "med"   dataScore  0.55-0.70
//                  "low"   dataScore <0.55
const BUCKET_CAL = {
  ML: {
    strong_fav: { high: 0.0, med: 0.0, low: 0.0 },
    fav:        { high: 0.0, med: 0.0, low: 0.0 },
    neutral:    { high: 0.0, med: 0.0, low: 0.0 },
    dog:        { high: 0.0, med: 0.0, low: 0.0 },
    heavy_dog:  { high: 0.0, med: 0.0, low: 0.0 },
  },
  HC: {
    strong_fav: { high: 0.0, med: 0.0, low: 0.0 },
    fav:        { high: 0.0, med: 0.0, low: 0.0 },
    neutral:    { high: 0.0, med: 0.0, low: 0.0 },
    dog:        { high: 0.0, med: 0.0, low: 0.0 },
    heavy_dog:  { high: 0.0, med: 0.0, low: 0.0 },
  },
  OU: {
    over:  { high: 0.0, med: 0.0, low: 0.0 },
    under: { high: 0.0, med: 0.0, low: 0.0 },
  },
};

function impliedBucket(implied) {
  if (implied > 0.62) return "strong_fav";
  if (implied > 0.55) return "fav";
  if (implied > 0.48) return "neutral";
  if (implied > 0.38) return "dog";
  return "heavy_dog";
}

function dataBucket(dataScore) {
  if (dataScore >= 0.70) return "high";
  if (dataScore >= 0.55) return "med";
  return "low";
}

function applyBucketCalibration(prob, market, impliedProb, dataScore, pickSide) {
  const mkt  = String(market || "");
  const imp  = toNumber(impliedProb) || 0.5;
  const ds   = toNumber(dataScore)   || 0;
  const iBkt = impliedBucket(imp);
  const dBkt = dataBucket(ds);

  let adj = 0;
  if (mkt === "ML" || mkt === "HC_AWAY" || mkt === "HC_HOME") {
    const table = BUCKET_CAL[mkt === "ML" ? "ML" : "HC"];
    adj = (table[iBkt] && table[iBkt][dBkt]) || 0;
  } else if (mkt === "OVER" || mkt === "UNDER") {
    const side = mkt === "OVER" ? "over" : "under";
    adj = (BUCKET_CAL.OU[side] && BUCKET_CAL.OU[side][dBkt]) || 0;
  }

  if (adj === 0) return toNumber(prob);
  return round3(clamp((toNumber(prob) || 0) + adj, 0.08, 0.92));
}

function marketEdgeThreshold(market, impliedProb) {
  if (DISABLED_MARKETS.has(market)) return 999;
  if (market === "OVER") return 0.25; // OVER: 2W-8L MLB+MiLB, umbral subido 2026-05-28
  return 0.18;
}

function computeFairOdds(probability) {
  const prob = toNumber(probability);
  if (prob == null || prob <= 0 || prob >= 1) return null;
  return round3(1 / prob);
}

function computeExpectedValue(winProbability, odds, pushProbability) {
  const winProb = toNumber(winProbability);
  const decOdds = toNumber(odds);
  const pushProb = toNumber(pushProbability) || 0;
  if (winProb == null || decOdds == null || decOdds <= 0) return null;
  return round3((winProb * decOdds) + pushProb - 1);
}

function computeFairPair(firstOdds, secondOdds) {
  const first = toNumber(firstOdds);
  const second = toNumber(secondOdds);
  // Cuotas decimales deben ser >= 1.01 ????????????? valores menores indican error de formato
  if (first == null || second == null || first < 1.01 || second < 1.01) return null;
  const firstRaw = 1 / first;
  const secondRaw = 1 / second;
  const overround = firstRaw + secondRaw;
  if (!Number.isFinite(overround) || overround <= 0) return null;
  return {
    first: round3(firstRaw / overround),
    second: round3(secondRaw / overround),
    overround: round3(overround),
  };
}

function normalizeConfidence(score, edge, threshold) {
  const dataScore = toNumber(score) || 0;
  const edgeValue = toNumber(edge) || 0;
  const minEdge = toNumber(threshold) || 0;
  // HIGH: exige data fiable Y edge generoso (+10pp sobre umbral)
  if (dataScore >= 0.75 && edgeValue >= minEdge + 0.10) return "HIGH";
  // MEDIUM: data razonable Y edge con algo de margen
  if (dataScore >= 0.55 && edgeValue >= minEdge + 0.03) return "MEDIUM";
  return "LOW";
}

function sampleReliabilityFromIp(ip, fullSampleIp) {
  const innings = toNumber(ip);
  if (innings == null || innings <= 0) return 0;
  return clamp(innings / fullSampleIp, 0, 1);
}

function sampleReliabilityFromGames(games, fullSampleGames) {
  const totalGames = toNumber(games);
  if (totalGames == null || totalGames <= 0) return 0;
  return clamp(totalGames / fullSampleGames, 0, 1);
}

function sampleReliabilityFromCount(count, fullSampleCount) {
  const total = toNumber(count);
  if (total == null || total <= 0) return 0;
  return clamp(total / fullSampleCount, 0, 1);
}

function metricCount(values) {
  return values.map(toNumber).filter(value => value != null).length;
}

function edgeSurplus(candidate) {
  if (!candidate) return -Infinity;
  const edge = toNumber(candidate.edge) || 0;
  const threshold = toNumber(candidate.edge_threshold) || marketEdgeThreshold(candidate.market);
  return edge - threshold;
}

function teamPrefix(side) {
  return side === "away" ? "away_team" : "home_team";
}

function pitcherPrefix(side) {
  return side === "away" ? "away_p" : "home_p";
}

function bullpenPrefix(side) {
  return side === "away" ? "away_bullpen" : "home_bullpen";
}

function currentSeason(game) {
  const direct = toNumber(game?.game_season ?? game?.season);
  if (direct != null) return direct;
  const rawDate = game?.game_date || game?.game_datetime_utc;
  if (!rawDate) return new Date().getUTCFullYear();
  const parsed = new Date(rawDate);
  return Number.isFinite(parsed.getTime()) ? parsed.getUTCFullYear() : new Date().getUTCFullYear();
}

function seasonRecencyWeight(dataSeason, targetSeason, previousSeasonWeight = 0.35) {
  const season = toNumber(dataSeason);
  const target = toNumber(targetSeason);
  if (season == null || target == null) return 0;
  if (season === target) return 1;
  if (season === target - 1) return previousSeasonWeight;
  return 0;
}

function battingSignalWeight(game, side) {
  const prefix = teamPrefix(side);
  const seasonWeight = seasonRecencyWeight(
    game[prefix + "_batting_season"],
    currentSeason(game),
    0.35
  );
  const sampleWeight = sampleReliabilityFromCount(game[prefix + "_batting_num_batters"], 9);
  return clamp(seasonWeight * sampleWeight, 0, 1) || 0;
}

function bullpenSignalWeight(game, side) {
  const prefix = bullpenPrefix(side);
  const seasonWeight = seasonRecencyWeight(
    game[prefix + "_season"],
    currentSeason(game),
    0.45
  );
  const sampleWeight = sampleReliabilityFromCount(game[prefix + "_num_pitchers"], 8);
  return clamp(seasonWeight * sampleWeight, 0, 1) || 0;
}

function starterStatsSeasonWeight(game, side) {
  const prefix = pitcherPrefix(side);
  return seasonRecencyWeight(game[prefix + "_stats_season"], currentSeason(game), 0.45) || 0;
}

function starterStatcastSeasonWeight(game, side) {
  const prefix = pitcherPrefix(side);
  return seasonRecencyWeight(game[prefix + "_statcast_season"], currentSeason(game), 0.35) || 0;
}

function starterSampleScore(game, side) {
  const prefix = pitcherPrefix(side);
  const statsSeasonWeight = starterStatsSeasonWeight(game, side);
  const statcastSeasonWeight = starterStatcastSeasonWeight(game, side);
  // Severini �8.4: shrinkage threshold 45?90 IP (at 20 IP ? reliability=0.22, weight 78% league mean)
  const ipSeason = sampleReliabilityFromIp(game[prefix + "_ip_season"], 90) * statsSeasonWeight;
  const ipRecent = sampleReliabilityFromIp(game[prefix + "_ip_l5"], 25);
  const statcastCount = metricCount([
    game[prefix + "_xwoba"],
    game[prefix + "_k_pct"],
    game[prefix + "_bb_pct"],
    game[prefix + "_hard_hit"],
    game[prefix + "_barrel"],
  ]);
  const statcastScore = (clamp(statcastCount / 5, 0, 1) || 0) * statcastSeasonWeight;
  // M�s peso a Statcast y forma reciente (m�s predictivos en MiLB con muestras cortas)
  return clamp((ipSeason * 0.40) + (ipRecent * 0.30) + (statcastScore * 0.30), 0, 1);
}

function estimateDataScore(game) {
  let score = 0.15;
  // Pitcher = n�cleo del modelo: ponderaci�n elevada de 0.22 ? 0.27 por lado.
  // Sin datos de pitcher el data_score cae claramente por debajo de 0.55 (LIMITADA).
  score += starterSampleScore(game, "away") * 0.27;
  score += starterSampleScore(game, "home") * 0.27;
  score += sampleReliabilityFromGames(game.away_team_games_played, 30) * 0.08;
  score += sampleReliabilityFromGames(game.home_team_games_played, 30) * 0.08;
  score += (metricCount([game.away_bullpen_fip, game.away_bullpen_era, game.away_bullpen_xwoba]) >= 2 ? 0.07 : 0)
    * Math.max(0.35, bullpenSignalWeight(game, "away"));
  score += (metricCount([game.home_bullpen_fip, game.home_bullpen_era, game.home_bullpen_xwoba]) >= 2 ? 0.07 : 0)
    * Math.max(0.35, bullpenSignalWeight(game, "home"));
  score += (metricCount([game.away_team_xwoba, game.away_team_woba, game.away_team_hard_hit]) >= 2 ? 0.04 : 0)
    * battingSignalWeight(game, "away");
  score += (metricCount([game.home_team_xwoba, game.home_team_woba, game.home_team_hard_hit]) >= 2 ? 0.04 : 0)
    * battingSignalWeight(game, "home");
  score += toNumber(game.park_factor_runs) != null ? 0.04 : 0;
  score += (toNumber(game.temperature_2m) != null || toNumber(game.wind_speed_10m) != null) ? 0.05 : 0;
  // Fase 2 (2026-07-04): +0.04 si el lineup real de ambos equipos ya esta confirmado
  score += (game.lineup_factor_away != null && game.lineup_factor_home != null) ? 0.04 : 0;
  return clamp(score, 0.2, 0.98);
}

function battingReliabilityScore(game) {
  return average([
    battingSignalWeight(game, "away"),
    battingSignalWeight(game, "home"),
  ]) || 0;
}

function sideReliabilityScore(game) {
  return average([
    starterSampleScore(game, "away"),
    starterSampleScore(game, "home"),
    Math.max(0.15, bullpenSignalWeight(game, "away")),
    Math.max(0.15, bullpenSignalWeight(game, "home")),
    sampleReliabilityFromGames(game.away_team_games_played, 24),
    sampleReliabilityFromGames(game.home_team_games_played, 24),
  ]) || 0;
}

function estimateAttackPer9(game, side, cfg) {
  const prefix = teamPrefix(side);
  const seasonRpg = toNumber(game[prefix + "_rpg_season"]);
  const recentRpg = toNumber(game[prefix + "_l10_rpg"]);
  const gamesPlayed = toNumber(game[prefix + "_games_played"]);

  // Severini �8.4: stronger shrinkage for small samples - full reliability at 60 games (was 40)
  const seasonWeight = seasonRpg == null ? 0 : clamp((gamesPlayed || 0) / 60, 0.12, 0.60);
  const recentWeight = recentRpg == null ? 0 : 0.28;
  const baseWeight = Math.max(0.15, 1 - seasonWeight - recentWeight);

  let attack = weightedAverage([
    { value: seasonRpg, weight: seasonWeight },
    { value: recentRpg, weight: recentWeight },
    { value: cfg.runs_per_team, weight: baseWeight },
  ], cfg.runs_per_team);

  const xwoba = toNumber(game[prefix + "_xwoba"]);
  const woba = toNumber(game[prefix + "_woba"]);
  const hardHit = toNumber(game[prefix + "_hard_hit"]);
  const barrel = toNumber(game[prefix + "_barrel"]);
  const exitVelo = toNumber(game[prefix + "_exit_velo"]);

  // FIX: usar media de liga como fallback en lugar de 0.
  // Con fallback=0, un xwOBA nulo fing�a ser un lineup muy malo (-1.5 clamp).
  // Ahora nulo ? sin ajuste (se�al=0, como corresponde a dato desconocido).
  const xm = cfg.xwoba_mean;
  const signal =
    ((clamp(safeRatio((xwoba ?? xm) - xm, 0.03), -1.5, 1.5) || 0) * 0.18) +
    ((clamp(safeRatio((woba  ?? xm) - xm, 0.03), -1.5, 1.5) || 0) * 0.09) +
    ((clamp(safeRatio((hardHit ?? cfg.hard_hit_mean) - cfg.hard_hit_mean, 10), -1.5, 1.5) || 0) * 0.06) +
    ((clamp(safeRatio((barrel  ?? cfg.barrel_mean)   - cfg.barrel_mean,   4), -1.5, 1.5) || 0) * 0.05) +
    ((clamp(safeRatio((exitVelo ?? cfg.exit_velo_mean) - cfg.exit_velo_mean, 4), -1.5, 1.5) || 0) * 0.04);

  const metricsSeen = metricCount([xwoba, woba, hardHit, barrel, exitVelo]);
  const qualityWeight = clamp((metricsSeen / 5) * 0.25 * battingSignalWeight(game, side), 0, 0.25) || 0;
  attack *= 1 + (signal * qualityWeight);

  return clamp(attack, 2.5, 7.4);
}

function estimateStarterShare(game, side) {
  const prefix = pitcherPrefix(side);
  const ipSeason = toNumber(game[prefix + "_ip_season"]);
  const gamesL5 = toNumber(game[prefix + "_games_l5"]);
  const ipL5 = toNumber(game[prefix + "_ip_l5"]);
  let share = 0.56;

  if (ipSeason != null) {
    if (ipSeason < 10) share -= 0.1;
    else if (ipSeason < 20) share -= 0.06;
    else if (ipSeason > 45) share += 0.03;
  }

  const avgIpL5 = safeRatio(ipL5, gamesL5);
  if (avgIpL5 != null) {
    if (avgIpL5 < 4.0) share -= 0.06;
    else if (avgIpL5 < 4.8) share -= 0.03;
    else if (avgIpL5 > 5.8) share += 0.04;
  }

  if (game[prefix + "_short_rest"] === true) share -= 0.03;
  if (game[prefix + "_high_pitch"] === true) share -= 0.02;

  return clamp(share, 0.42, 0.68);
}

function estimateStarterRaPer9(game, side, cfg) {
  const prefix = pitcherPrefix(side);
  const seasonFip = toNumber(game[prefix + "_fip_season"]);
  const seasonEra = toNumber(game[prefix + "_era_season"]);
  const recentEra = toNumber(game[prefix + "_era_l5"]);
  const splitEra = side === "away"
    ? toNumber(game.away_p_split_away_era)
    : toNumber(game.home_p_split_home_era);
  const xwoba = toNumber(game[prefix + "_xwoba"]);
  const kPct = toNumber(game[prefix + "_k_pct"]);
  const bbPct = toNumber(game[prefix + "_bb_pct"]);
  const hardHit = toNumber(game[prefix + "_hard_hit"]);
  const barrel = toNumber(game[prefix + "_barrel"]);
  const oppQuality = toNumber(game[prefix + "_opp_xwoba"]);
  const lastPitches = toNumber(game[prefix + "_last_pitches"]);
  const daysRest = toNumber(game[prefix + "_days_rest"]);
  const siera = toNumber(game[prefix + "_siera"]);

  // Severini �8.4: threshold 45?90 IP for pitcher shrinkage (consistent with starterSampleScore)
  const seasonReliability = sampleReliabilityFromIp(game[prefix + "_ip_season"], 90) * starterStatsSeasonWeight(game, side);
  const recentReliability = sampleReliabilityFromIp(game[prefix + "_ip_l5"], 25) * 0.5;
  const statcastSeasonWeight = starterStatcastSeasonWeight(game, side);

  // Blend FIP with SIERA when available (SIERA captures batted ball profile better than FIP)
  const fipOrBlend = (seasonFip != null && siera != null)
    ? (0.6 * seasonFip + 0.4 * siera)
    : (seasonFip ?? siera);

  // Winston (Mathletics p.3164): FIP predice mejor que ERA incluso con muestra completa.
  // Blend din�mico por IP: m�s FIP en muestras peque�as donde ERA tiene m�s ruido.
  // v2 activado: +5-8pp FIP sobre v1 - Peta �21: ERA observado tiene componente BABIP alto en MiLB.
  // 176 picks reales: -30% ROI en OVER sugiere ERA sobrevalora pitchers con BABIP bajo ? FIP corrige.
  const ipForBlend = toNumber(game[prefix + "_ip_season"]) || 0;
  const fipW = ipForBlend < 30 ? 0.85 : ipForBlend < 60 ? 0.75 : ipForBlend < 90 ? 0.65 : 0.60;
  const seasonComposite = weightedAverage([
    { value: fipOrBlend, weight: fipOrBlend != null ? fipW : 0 },
    { value: seasonEra,  weight: seasonEra  != null ? (1 - fipW) : 0 },
    { value: cfg.runs_per_team, weight: 0.2 },
  ], cfg.runs_per_team);

  // Severini �8.4: floor from 0.30?0.22 (allow more league mean weight for low-IP pitchers)
  let ra = weightedAverage([
    { value: seasonComposite, weight: Math.max(0.22, seasonReliability) },
    { value: cfg.runs_per_team, weight: Math.max(0.52, 1 - seasonReliability) },
  ], cfg.runs_per_team);

  if (recentEra != null) {
    ra = weightedAverage([
      { value: ra, weight: 1 - recentReliability },
      { value: recentEra, weight: recentReliability },
    ], ra);
  }

  // FIX: xwOBA nulo usaba fallback=0 ? el pitcher parec�a �lite sin datos.
  // Ahora nulo ? se�al neutra (xwOBA = media de liga).
  const xm = cfg.xwoba_mean;
  const rawSignal =
    ((clamp(safeRatio((xwoba  ?? xm)                   - xm,                   0.035), -1.6, 1.6) || 0) * 0.18) +
    ((clamp(safeRatio((bbPct  ?? cfg.bb_pct_mean)       - cfg.bb_pct_mean,       4.5),  -1.5, 1.5) || 0) * 0.08) +
    ((clamp(safeRatio(cfg.k_pct_mean - (kPct ?? cfg.k_pct_mean),                 6),   -1.5, 1.5) || 0) * 0.08) +
    ((clamp(safeRatio((hardHit ?? cfg.hard_hit_mean)    - cfg.hard_hit_mean,      10),  -1.5, 1.5) || 0) * 0.07) +
    ((clamp(safeRatio((barrel  ?? cfg.barrel_mean)      - cfg.barrel_mean,        4),   -1.5, 1.5) || 0) * 0.05);

  const statcastReliability = clamp(
    (metricCount([xwoba, kPct, bbPct, hardHit, barrel]) / 5)
      * Math.max(0.2, seasonReliability)
      * statcastSeasonWeight,
    0,
    0.42
  ) || 0;
  ra *= 1 + (rawSignal * statcastReliability);

  if (splitEra != null && seasonComposite != null) {
    const splitDelta = clamp(safeRatio(splitEra - seasonComposite, 2.0), -1.2, 1.2) || 0;
    ra *= 1 + (splitDelta * 0.08);
  }

  if (oppQuality != null && xwoba != null) {
    const scheduleAdj = clamp(safeRatio(cfg.xwoba_mean - oppQuality, 0.02), -1, 1) || 0;
    ra *= 1 + (scheduleAdj * 0.03);
  }

  // Tango/The Book: starter lanzando con poco descanso ? rol de relevo ? -27pp wOBA ? +0.80 ERA
  if (game[prefix + "_short_rest"] === true) ra *= 1.12;
  if (game[prefix + "_high_pitch"] === true) ra *= 1.04;
  if (lastPitches != null && lastPitches > 95) ra *= 1.03;

  // Tango/The Book tabla de descanso: 4 d�as = �ptimo (.352 wOBA), 5 d�as = levemente mejor (.346),
  // 6+ d�as = levemente peor (.355) - BUG ANTERIOR: 6+ d�as premiaba al pitcher (� 0.985), incorrecto.
  if (daysRest != null) {
    if (daysRest === 5) ra *= 0.983;          // +6pp mejor que 4 d�as ? reduce RA
    else if (daysRest >= 6) ra *= 1.008;      // +3pp peor que 4 d�as ? aumenta RA (fix bug anterior)
  }

  // Tango/The Book �7: times-through-order effect - RA del starter sube con cada vuelta al lineup.
  // wOBA: 1� vuelta .345, 2� .354, 3� .362 (+5% de 1� a 3�).
  // Estimamos vueltas completadas usando avg IP �ltimas 5 salidas.
  const ipL5   = toNumber(game[prefix + "_ip_l5"]);
  const gamesL5 = toNumber(game[prefix + "_games_l5"]);
  const avgIpL5 = safeRatio(ipL5, gamesL5);
  if (avgIpL5 != null) {
    if (avgIpL5 >= 5.8) ra *= 1.032;   // llega a 3� vuelta completa ? +3.2% RA
    else if (avgIpL5 >= 5.0) ra *= 1.016; // entra en 3� vuelta ? +1.6%
    else if (avgIpL5 <= 4.0) ra *= 0.975; // sale antes de 2� vuelta ? bateadores ven menos ? -2.5%
  }

  return clamp(ra, 2.6, 8.6);
}

function estimateBullpenRaPer9(game, side, cfg) {
  const prefix = bullpenPrefix(side);
  const era = toNumber(game[prefix + "_era"]);
  const fip = toNumber(game[prefix + "_fip"]);
  const xwoba = toNumber(game[prefix + "_xwoba"]);
  const pitchesL3 = toNumber(game[side + "_bullpen_pitches_l3"]);
  const appsL3 = toNumber(game[side + "_bullpen_apps_l3"]);
  const armsL3 = toNumber(game[side + "_bullpen_pitchers_l3"]);
  const signalWeight = bullpenSignalWeight(game, side);

  let ra = weightedAverage([
    { value: fip, weight: fip != null ? 0.65 : 0 },
    { value: era, weight: era != null ? 0.35 : 0 },
    { value: cfg.runs_per_team, weight: 0.40 },
  ], cfg.runs_per_team);

  ra = weightedAverage([
    { value: ra, weight: Math.max(0.2, signalWeight) },
    { value: cfg.runs_per_team, weight: Math.max(0.40, 1 - signalWeight) },
  ], cfg.runs_per_team);

  if (xwoba != null) {
    const xwobaAdj = clamp(safeRatio(xwoba - cfg.xwoba_mean, 0.03), -1.5, 1.5) || 0;
    ra *= 1 + (xwobaAdj * 0.1 * signalWeight);
  }

  if (pitchesL3 != null) {
    if (pitchesL3 > 300) ra *= 1.12;
    else if (pitchesL3 > 240) ra *= 1.08;
    else if (pitchesL3 > 180) ra *= 1.04;
    else if (pitchesL3 < 100) ra *= 0.97;
  }

  if (appsL3 != null && appsL3 > 10) ra *= 1.03;
  if (armsL3 != null && armsL3 <= 3 && pitchesL3 != null && pitchesL3 > 180) ra *= 1.03;

  return clamp(ra, 3.0, 7.2);
}

function normalizeParkFactor(raw) {
  // DB almacena como entero base-100 (100 = neutral, 115 = +15%, 85 = -15%).
  // El motor necesita decimal (1.0 = neutral, 1.15 = +15%).
  const v = toNumber(raw);
  if (v == null) return null;
  return v > 10 ? v / 100 : v;  // >10 ? base-100; <=10 ? ya es decimal
}

// parkFactorWeight: ML/HC usan 0.60 (evita doble conteo con m�tricas individuales).
// OU usa 0.90: en totales el parque afecta a ambos equipos por igual y el efecto
// no est� capturado por las m�tricas individuales de ataque/pitcheo ? aplicar casi completo.
// Rudnitsky p.74: park factor es mejor predictor de totales que de ML win%.
function environmentMultiplier(game, parkFactorWeight = 0.60) {
  let multiplier = 1;

  const parkRuns = normalizeParkFactor(game.park_factor_runs);
  if (parkRuns != null) multiplier *= 1 + ((parkRuns - 1) * parkFactorWeight);

  const parkHr = normalizeParkFactor(game.park_factor_hr);
  if (parkHr != null) multiplier *= 1 + ((parkHr - 1) * 0.08);

  const altitude = toNumber(game.altitude_m);
  if (altitude != null) multiplier *= 1 + (clamp(altitude / 1000, 0, 2.5) * 0.03);

  const temperature = toNumber(game.temperature_2m);
  // Albert/Baumer 2026 p.10067: HR_Rate = 4.65% + 0.041/�F ? efecto total ~0.004/�C en run scoring.
  // Alineado con motores LMB/KBO/NPB/CPBL que ya usaban 0.004/�C.
  if (temperature != null) multiplier *= 1 + (clamp((temperature - 20) * 0.004, -0.05, 0.06) || 0);

  const tailwind = toNumber(game.wind_tailwind);
  if (tailwind != null) multiplier *= 1 + (clamp(tailwind * 0.005, -0.07, 0.07) || 0);

  return clamp(multiplier, 0.82, 1.22);
}

function expectedRuns(game, cfg) {
  const awayAttack = estimateAttackPer9(game, "away", cfg);
  const homeAttack = estimateAttackPer9(game, "home", cfg);
  const awayStarterRa = estimateStarterRaPer9(game, "away", cfg);
  const homeStarterRa = estimateStarterRaPer9(game, "home", cfg);
  const awayBullpenRa = estimateBullpenRaPer9(game, "away", cfg);
  const homeBullpenRa = estimateBullpenRaPer9(game, "home", cfg);
  const awayStarterShare = estimateStarterShare(game, "away");
  const homeStarterShare = estimateStarterShare(game, "home");

  const awayDefense = (awayStarterRa * awayStarterShare) + (awayBullpenRa * (1 - awayStarterShare));
  const homeDefense = (homeStarterRa * homeStarterShare) + (homeBullpenRa * (1 - homeStarterShare));
  const parkMult   = environmentMultiplier(game, 0.60); // ML/HC
  const parkMultOU = environmentMultiplier(game, 0.90); // OU: parque afecta total completo
  const inningMult = inningsScale(game);

  let awayRuns = Math.sqrt(Math.max(1.25, awayAttack) * Math.max(1.25, homeDefense));
  let homeRuns = Math.sqrt(Math.max(1.25, homeAttack) * Math.max(1.25, awayDefense));

  awayRuns *= parkMult * inningMult * cfg.calibration_factor;
  homeRuns *= parkMult * inningMult * cfg.calibration_factor;

  const awayRunsPreLineup = awayRuns;
  const homeRunsPreLineup = homeRuns;

  // Ajuste opcional por calidad de lineup real confirmado (Fase 2, 2026-07-04).
  // Si el watcher aun no detecto el lineup, game.lineup_factor_* es null y las carreras quedan igual que antes.
  const lineupAdjustEnabled = cfg.lineup_adjust_enabled !== false;
  const lineupFactorAway = lineupAdjustEnabled && game.lineup_factor_away != null
    ? clamp(Number(game.lineup_factor_away), 0.90, 1.10) : null;
  const lineupFactorHome = lineupAdjustEnabled && game.lineup_factor_home != null
    ? clamp(Number(game.lineup_factor_home), 0.90, 1.10) : null;
  if (lineupFactorAway != null) awayRuns *= lineupFactorAway;
  if (lineupFactorHome != null) homeRuns *= lineupFactorHome;

  // Ventaja local �2.5% (calibrado contra backtest real).
  awayRuns *= 0.975;
  homeRuns *= 1.025;

  awayRuns = clamp(awayRuns, 1.6, 8.8);
  homeRuns = clamp(homeRuns, 1.6, 8.8);

  // Runs espec�ficos para mercado OU: park factor al 90% (ambos equipos lo sufren igual)
  const ouParkCorr = parkMult > 0 ? parkMultOU / parkMult : 1;
  const awayRunsOU = clamp(awayRuns * ouParkCorr, 1.6, 8.8);
  const homeRunsOU = clamp(homeRuns * ouParkCorr, 1.6, 8.8);

  return {
    away_runs: round3(awayRuns),
    home_runs: round3(homeRuns),
    away_runs_ou: round3(awayRunsOU),
    home_runs_ou: round3(homeRunsOU),
    away_runs_pre_lineup: round3(awayRunsPreLineup),
    home_runs_pre_lineup: round3(homeRunsPreLineup),
    lineup_factor_away: lineupFactorAway,
    lineup_factor_home: lineupFactorHome,
    total_runs: round3((awayRuns || 0) + (homeRuns || 0)),
    away_attack: round3(awayAttack),
    home_attack: round3(homeAttack),
    away_starter_ra: round3(awayStarterRa),
    home_starter_ra: round3(homeStarterRa),
    away_bullpen_ra: round3(awayBullpenRa),
    home_bullpen_ra: round3(homeBullpenRa),
    away_starter_share: round3(awayStarterShare),
    home_starter_share: round3(homeStarterShare),
    environment_mult: round3(parkMult),
  };
}

// Par�metro de dispersi�n para Negative Binomial.
// Poisson asume Var = Media. En b�isbol real Var > Media (overdispersi�n):
// hay m�s juegos de 0 carreras Y m�s de 12+ de lo que Poisson predice.
// NB modela esto con: Var = ? + ?�/k  - k viene de LEAGUE_CONFIG por liga.
// k?? converge a Poisson. MiLB AAA calibrado en k=8; MLB en k=9.

function runDistribution(mu, maxRuns, cfg) {
  const mean = Math.max(0.01, toNumber(mu) || 0.01);
  const k = cfg.nb_k;
  const maxBucket = Math.max(14, Math.ceil(maxRuns || (mean + 9 * Math.sqrt(mean))));
  const distribution = new Array(maxBucket + 1).fill(0);

  // Negative Binomial: P(0) = (k/(k+?))^k
  // Recursi�n: P(n) = P(n-1) * (n-1+k)/n * ?/(k+?)
  const p = k / (k + mean);   // prob base
  const q = mean / (k + mean); // prob de cada carrera extra
  distribution[0] = Math.pow(p, k);
  let sum = distribution[0];
  for (let run = 1; run < maxBucket; run += 1) {
    distribution[run] = distribution[run - 1] * ((run - 1 + k) / run) * q;
    sum += distribution[run];
  }
  distribution[maxBucket] = Math.max(0, 1 - sum);
  return distribution;
}

function compareLine(awayRuns, homeRuns, line, side) {
  const numericLine = toNumber(line);
  if (numericLine == null) return null;
  let adjusted;
  let other;
  if (side === "away") {
    adjusted = awayRuns + numericLine;
    other = homeRuns;
  } else if (side === "home") {
    adjusted = homeRuns + numericLine;
    other = awayRuns;
  } else if (side === "over") {
    adjusted = awayRuns + homeRuns;
    other = numericLine;
  } else if (side === "under") {
    adjusted = awayRuns + homeRuns;
    other = numericLine;
  } else {
    return null;
  }

  if (side === "under") {
    if (adjusted < other) return "win";
    if (adjusted > other) return "loss";
    return "push";
  }

  if (adjusted > other) return "win";
  if (adjusted < other) return "loss";
  return "push";
}

// Severini �5.3: Pythagorean win probability using exponent 1.83
// Used as supplementary signal (20%) blended with Poisson (80%) for ML market only.
// Provides an independent, simpler baseline from actual team scoring ratios.
function pythagoreanWinProb(rpgScored, rpgAllowed) {
  const rs = toNumber(rpgScored);
  const ra = toNumber(rpgAllowed);
  if (!rs || !ra || rs <= 0 || ra <= 0) return null;
  const exp = 1.83;
  return Math.pow(rs, exp) / (Math.pow(rs, exp) + Math.pow(ra, exp));
}

function marketProbabilities(game, cfg) {
  const runExpectations = expectedRuns(game, cfg);
  const maxRuns = Math.max(16, Math.ceil(Math.max(runExpectations.total_runs || 10, runExpectations.away_runs_ou + runExpectations.home_runs_ou || 10) + 15)); // +15 (era +10): con nb_k mas bajo (mas dispersion) hace falta mas margen para no truncar la cola
  const awayDist = runDistribution(runExpectations.away_runs, maxRuns, cfg);
  const homeDist = runDistribution(runExpectations.home_runs, maxRuns, cfg);
  // OU usa distribuciones con park factor al 90%
  const awayDistOU = runDistribution(runExpectations.away_runs_ou, maxRuns, cfg);
  const homeDistOU = runDistribution(runExpectations.home_runs_ou, maxRuns, cfg);

  let awayMlWin = 0;
  let homeMlWin = 0;
  let tieProb = 0;
  let awayHcWin = 0;
  let awayHcPush = 0;
  let homeHcWin = 0;
  let homeHcPush = 0;
  let overWin = 0;
  let overPush = 0;
  let underWin = 0;
  let underPush = 0;

  // ML/HC: distribuciones con park factor 60%
  for (let awayRuns = 0; awayRuns < awayDist.length; awayRuns += 1) {
    const awayProb = awayDist[awayRuns];
    if (!awayProb) continue;
    for (let homeRuns = 0; homeRuns < homeDist.length; homeRuns += 1) {
      const jointProb = awayProb * homeDist[homeRuns];
      if (!jointProb) continue;

      if (awayRuns > homeRuns) awayMlWin += jointProb;
      else if (homeRuns > awayRuns) homeMlWin += jointProb;
      else tieProb += jointProb;

      const awayHcResult = compareLine(awayRuns, homeRuns, game.away_hc_val, "away");
      if (awayHcResult === "win") awayHcWin += jointProb;
      if (awayHcResult === "push") awayHcPush += jointProb;

      const homeHcResult = compareLine(awayRuns, homeRuns, game.home_hc_val, "home");
      if (homeHcResult === "win") homeHcWin += jointProb;
      if (homeHcResult === "push") homeHcPush += jointProb;
    }
  }

  // OU: distribuciones con park factor 90% (parque afecta total completo - Rudnitsky p.74)
  if (toNumber(game.total_line) != null) {
    for (let awayRuns = 0; awayRuns < awayDistOU.length; awayRuns += 1) {
      const awayProb = awayDistOU[awayRuns];
      if (!awayProb) continue;
      for (let homeRuns = 0; homeRuns < homeDistOU.length; homeRuns += 1) {
        const jointProb = awayProb * homeDistOU[homeRuns];
        if (!jointProb) continue;

        const overResult = compareLine(awayRuns, homeRuns, game.total_line, "over");
        if (overResult === "win") overWin += jointProb;
        if (overResult === "push") overPush += jointProb;

        const underResult = compareLine(awayRuns, homeRuns, game.total_line, "under");
        if (underResult === "win") underWin += jointProb;
        if (underResult === "push") underPush += jointProb;
      }
    }
  }

  const homeTieBias = 0.52;
  awayMlWin += tieProb * (1 - homeTieBias);
  homeMlWin += tieProb * homeTieBias;

  // Severini �5.3 + lectura completa: correlaci�n Pythagorean (0.458) NO supera W% real (0.472).
  // El blend 80/20 NB/Pythagorean a�ade ruido. Se elimina - solo NB determina ML win prob.

  return {
    ...runExpectations,
    away_ml_win: round3(awayMlWin),
    home_ml_win: round3(homeMlWin),
    tie_regulation: round3(tieProb),
    away_hc_win: round3(awayHcWin),
    away_hc_push: round3(awayHcPush),
    home_hc_win: round3(homeHcWin),
    home_hc_push: round3(homeHcPush),
    over_win: round3(overWin),
    over_push: round3(overPush),
    under_win: round3(underWin),
    under_push: round3(underPush),
  };
}

function buildCandidate(details) {
  const odds = toNumber(details.odds);
  const winProb = toNumber(details.prob_estimated);
  const implied = toNumber(details.prob_implied);
  const pushProb = toNumber(details.push_prob) || 0;
  if (odds == null || winProb == null || implied == null) return null;

  const edge = computeExpectedValue(winProb, odds, pushProb);
  if (edge == null) return null;

  return {
    market: details.market,
    pick_side: details.pick_side,
    pick_team: details.pick_team || null,
    odds: round3(odds),
    prob_estimated: round3(winProb),
    prob_implied: round3(implied),
    prob_edge: round3(winProb - implied),
    fair_odds: computeFairOdds(winProb),
    edge,
    push_prob: round3(pushProb),
    edge_threshold: marketEdgeThreshold(details.market),
  };
}

function calibrationModelWeight(market, dataScore, game, impliedProb) {
  // Peso del modelo cuantitativo vs probabilidad impl�cita del mercado.
  // Ajustado por mercado, calidad de dato, y bucket de cuota para reducir
  // sesgo hacia underdogs y suppression de favoritos fuertes.
  // [PENDING v2 - activar con n?150] DOCX �8: blend por eficiencia de mercado:
  //   MLB (sport_id=1): ML ? 0.50 (mercado muy eficiente)
  //   MiLB: ML ? 0.62 (actual, correcto seg�n DOCX)
  //   Implementar: const cfg = getLeagueConfig(game); const mlBase = cfg.model_blend_ml ?? 0.62;
  const marketName = String(market || "");
  let weight = 0.5;

  if (marketName === "ML") weight = 0.62;
  else if (marketName === "HC_AWAY" || marketName === "HC_HOME") weight = 0.58; // 54?58: HC tiene menos liquidez, m�s margen
  else if (marketName === "OVER" || marketName === "UNDER") weight = 0.50;

  // Ajuste por calidad de datos
  if (dataScore >= 0.72) weight += 0.07;
  else if (dataScore >= 0.62) weight += 0.03;
  else if (dataScore < 0.46) weight -= 0.10;
  else if (dataScore < 0.54) weight -= 0.07;

  // Favorite-aware boost: cuando el mercado implica favorito claro Y datos son s�lidos,
  // el modelo tiene m�s edge que la l�nea base - confiamos m�s en �l.
  if (marketName === "ML" && dataScore >= 0.60) {
    const imp = toNumber(impliedProb) || 0.5;
    if (imp > 0.62) weight += 0.08;       // favorito fuerte (odds < 1.61)
    else if (imp > 0.55) weight += 0.04;  // favorito moderado (odds < 1.82)
  }

  // HC boost adicional cuando datos son s�lidos
  if ((marketName === "HC_AWAY" || marketName === "HC_HOME") && dataScore >= 0.62) {
    weight += 0.04;
  }

  // 7 innings: m�s varianza en totales
  if (toNumber(game?.scheduled_innings) === 7 && (marketName === "OVER" || marketName === "UNDER")) {
    weight -= 0.05;
  }

  return clamp(weight, 0.25, 0.85) || 0.5;
}

function calibrateProbability(rawProb, impliedProb, market, dataScore, game) {
  const raw = toNumber(rawProb);
  const implied = toNumber(impliedProb);
  if (raw == null) return null;

  const anchor = implied != null ? implied : 0.5;
  const W = calibrationModelWeight(market, dataScore, game, impliedProb);

  // Blend �nico. W ya encoda toda la confianza en el modelo vs mercado.
  // Sin ajuste diferencial por consenso: los underdogs son no-consenso por definici�n
  // y penalizarlos aqu� suprime exactamente las apuestas de valor que buscamos.
  return round3(clamp(raw * W + anchor * (1 - W), 0.08, 0.92));
}

function marketPreferenceScore(candidate) {
  const market = String(candidate?.market || "");
  if (market === "ML") return 3;
  if (market === "UNDER" || market === "OVER") return 2;
  if (market === "HC_AWAY" || market === "HC_HOME") return 3;
  return 0;
}

function candidateSort(left, right) {
  const surplusDiff = edgeSurplus(right) - edgeSurplus(left);
  if (Math.abs(surplusDiff) > 0.025) return surplusDiff;
  const preferenceDiff = marketPreferenceScore(right) - marketPreferenceScore(left);
  if (preferenceDiff !== 0) return preferenceDiff;
  return (right.edge || 0) - (left.edge || 0);
}

function candidatesConflict(left, right) {
  if (!left || !right) return false;
  const leftMarket = String(left.market || "");
  const rightMarket = String(right.market || "");

  if ((leftMarket === "OVER" || leftMarket === "UNDER") && (rightMarket === "OVER" || rightMarket === "UNDER")) {
    return leftMarket !== rightMarket;
  }

  if (leftMarket === "ML" && rightMarket === "ML") {
    return left.pick_side !== right.pick_side;
  }

  if ((leftMarket === "HC_AWAY" || leftMarket === "HC_HOME") && (rightMarket === "HC_AWAY" || rightMarket === "HC_HOME")) {
    return leftMarket !== rightMarket;
  }

  const leftSide =
    leftMarket === "ML" ? left.pick_side :
    leftMarket === "HC_AWAY" ? "away" :
    leftMarket === "HC_HOME" ? "home" :
    null;
  const rightSide =
    rightMarket === "ML" ? right.pick_side :
    rightMarket === "HC_AWAY" ? "away" :
    rightMarket === "HC_HOME" ? "home" :
    null;

  const leftIsSideMarket = leftMarket === "ML" || leftMarket === "HC_AWAY" || leftMarket === "HC_HOME";
  const rightIsSideMarket = rightMarket === "ML" || rightMarket === "HC_AWAY" || rightMarket === "HC_HOME";

  // ML + HC del mismo equipo son picks complementarios (diferentes perfiles de riesgo),
  // no conflicto. Solo bloquear ML vs ML opuestos y HC vs HC opuestos (ya cubiertos arriba).
  // S� bloquear ML/HC de lados OPUESTOS (apostar a ambos equipos a la vez).
  if (leftIsSideMarket && rightIsSideMarket && leftSide && rightSide && leftSide !== rightSide) {
    const oneIsML = leftMarket === "ML" || rightMarket === "ML";
    const oneIsHC = leftMarket === "HC_AWAY" || leftMarket === "HC_HOME" || rightMarket === "HC_AWAY" || rightMarket === "HC_HOME";
    if (oneIsML && oneIsHC) return true; // ML de un equipo + HC del equipo contrario
  }

  // Bloquear: lado (ML/HC) + OVER ??? correlaci�n positiva alta.
  // Si el equipo apostado anota mucho, ambas apuestas ganan juntas ? riesgo concentrado.
  // Combinaciones v�lidas: ML/HC + UNDER (gana equipo en partido de pocos runs).
  const isOver = m => m === "OVER";
  if ((leftIsSideMarket && isOver(rightMarket)) || (isOver(leftMarket) && rightIsSideMarket)) {
    return true;
  }

  return false;
}

function projectionMargin(game, model, candidate) {
  if (!candidate) return 0;
  const awayRuns = toNumber(model?.away_runs) || 0;
  const homeRuns = toNumber(model?.home_runs) || 0;
  const totalRuns = toNumber(model?.total_runs) || 0;

  if (candidate.market === "ML") {
    return Math.abs(homeRuns - awayRuns);
  }
  if (candidate.market === "HC_AWAY") {
    return (awayRuns + (toNumber(game.away_hc_val) || 0)) - homeRuns;
  }
  if (candidate.market === "HC_HOME") {
    return (homeRuns + (toNumber(game.home_hc_val) || 0)) - awayRuns;
  }
  if (candidate.market === "OVER") {
    return totalRuns - (toNumber(game.total_line) || 0);
  }
  if (candidate.market === "UNDER") {
    return (toNumber(game.total_line) || 0) - totalRuns;
  }
  return 0;
}

function dynamicEdgeThreshold(game, model, candidate, dataScore) {
  // Umbral fijo 15%. Las penalizaciones din�micas previas bloqueaban todos los picks
  // de inicio de temporada (data_score ~0.375 ? +9pp ? umbral 24%) siendo innecesariamente
  // conservadoras. La confianza y el data_score ya se muestran en el pick como contexto.
  return marketEdgeThreshold(candidate?.market);
}

function maxPublicablePicks(dataScore, requestedMaxPicks) {
  // El umbral de edge (18%) ya act�a como filtro de calidad.
  // Publicar todos los mercados que superen el umbral, hasta el m���ximo solicitado.
  return toNumber(requestedMaxPicks) || 1;
}

function selectPublicableCandidates(candidates, maxPicks, dataScore) {
  const limit = maxPublicablePicks(dataScore, maxPicks);
  const sorted = (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => {
      const edge = candidate?.edge || 0;
      const threshold = candidate?.edge_threshold || marketEdgeThreshold(candidate?.market);
      if (edge < threshold) return false;
      // HC: prob < 52% es zona gris - el modelo no ve diferencial real, solo ruido.
      const mkt = candidate?.market || "";
      if ((mkt === "HC_HOME" || mkt === "HC_AWAY") && (candidate?.prob_estimated || 0) < 0.52) return false;
      return true;
    })
    .sort(candidateSort);

  const chosen = [];
  for (const candidate of sorted) {
    if (chosen.some(existing => candidatesConflict(existing, candidate))) continue;
    chosen.push(candidate);
    if (chosen.length >= limit) break;
  }

  return chosen;
}

function impliedMapFromLines(lines) {
  const map = {};
  const ml = computeFairPair(lines.away_ml, lines.home_ml);
  if (ml) map.ML = { away: ml.first, home: ml.second };
  const hc = computeFairPair(lines.away_hc_odds, lines.home_hc_odds);
  if (hc) map.HC = { away: hc.first, home: hc.second };
  const total = computeFairPair(lines.over_odds, lines.under_odds);
  if (total) map.TOTAL = { over: total.first, under: total.second };
  return map;
}

function metricsSummary(game, model) {
  const parts = [];

  if (model.away_runs != null && model.home_runs != null) {
    parts.push("score exp " + model.away_runs.toFixed(2) + "-" + model.home_runs.toFixed(2));
  }

  const awayXwoba = toNumber(game.away_p_xwoba);
  const homeXwoba = toNumber(game.home_p_xwoba);
  if (awayXwoba != null && homeXwoba != null) {
    parts.push("SP xwOBA " + awayXwoba.toFixed(3) + " vs " + homeXwoba.toFixed(3));
  }

  const awayBullpen = toNumber(game.away_bullpen_fip);
  const homeBullpen = toNumber(game.home_bullpen_fip);
  if (awayBullpen != null && homeBullpen != null) {
    parts.push("bullpen FIP " + awayBullpen.toFixed(2) + " vs " + homeBullpen.toFixed(2));
  }

  const awayOffense = toNumber(game.away_team_xwoba);
  const homeOffense = toNumber(game.home_team_xwoba);
  if (awayOffense != null && homeOffense != null && battingSignalWeight(game, "away") >= 0.12 && battingSignalWeight(game, "home") >= 0.12) {
    parts.push("lineup xwOBA " + awayOffense.toFixed(3) + " vs " + homeOffense.toFixed(3));
  }

  const temp = toNumber(game.temperature_2m);
  const tail = toNumber(game.wind_tailwind);
  if (temp != null || tail != null) {
    const tempLabel = temp != null ? temp.toFixed(0) + "C" : "N/A";
    const tailLabel = tail != null ? tail.toFixed(1) + "kmh" : "N/A";
    parts.push("env " + tempLabel + " / tail " + tailLabel);
  }

  return parts.join(" | ").slice(0, 250);
}

function reasoningSummary(game, model, candidate, dataScore) {
  const awayTeam = String(game.away_team_name || "Visitante");
  const homeTeam = String(game.home_team_name || "Local");
  const bestTeam = candidate?.pick_team || (candidate?.pick_side === "away" ? awayTeam : candidate?.pick_side === "home" ? homeTeam : null);
  const scoreText = model.away_runs != null && model.home_runs != null
    ? "Marcador esperado " + model.away_runs.toFixed(2) + "-" + model.home_runs.toFixed(2) + "."
    : "Sin marcador esperado claro.";
  const totalText = model.total_runs != null ? "Total esperado " + model.total_runs.toFixed(2) + "." : null;

  const supportBits = [];
  if (model.home_starter_ra != null && model.away_starter_ra != null) {
    supportBits.push("SP " + model.away_starter_ra.toFixed(2) + " RA vs " + model.home_starter_ra.toFixed(2) + " RA");
  }
  if (model.home_bullpen_ra != null && model.away_bullpen_ra != null) {
    supportBits.push("bullpen " + model.away_bullpen_ra.toFixed(2) + " vs " + model.home_bullpen_ra.toFixed(2));
  }
  if (model.environment_mult != null && Math.abs(model.environment_mult - 1) >= 0.03) {
    supportBits.push("entorno x" + model.environment_mult.toFixed(2));
  }

  const confidenceText = dataScore >= 0.7 ? "Muestras relativamente aceptables." : "Muestras limitadas, prudencia alta.";

  if (!candidate) {
    return (scoreText + " " + supportBits.join(", ") + ". " + confidenceText).trim();
  }

  if (candidate.market === "OVER" || candidate.market === "UNDER") {
    return (
      "El modelo proyecta un ritmo de carrera favorable al " +
      (candidate.market === "OVER" ? "Over" : "Under") +
      ". " +
      (totalText || scoreText) + " " +
      supportBits.join(", ") + ". " +
      confidenceText
    ).replace(/\s+/g, " ").trim().slice(0, 500);
  }

  if (candidate.market === "HC_AWAY" || candidate.market === "HC_HOME") {
    const hcText = game[candidate.market === "HC_AWAY" ? "away_hc_val" : "home_hc_val"];
    return (
      "El modelo ve valor en el handicap de " +
      (bestTeam || "ese lado") +
      (hcText != null ? " " + hcText : "") +
      ". " +
      scoreText + " " +
      supportBits.join(", ") + ". " +
      confidenceText
    ).replace(/\s+/g, " ").trim().slice(0, 500);
  }

  const odds = toNumber(candidate?.odds) || 2.0;
  const isUnderdog = odds >= 2.00;
  const prefixML = bestTeam
    ? isUnderdog
      ? "El modelo ve valor en " + bestTeam + " como underdog - la cuota del mercado sobreestima al rival. "
      : "El modelo confirma a " + bestTeam + " como favorito real. "
    : "";
  return (
    prefixML +
    scoreText + " " +
    supportBits.join(", ") + ". " +
    confidenceText
  ).replace(/\s+/g, " ").trim().slice(0, 500);
}

function plainReasoningSummary(game, model, candidate, dataScore) {
  const awayTeam = String(game.away_team_name || "Visitante");
  const homeTeam = String(game.home_team_name || "Local");
  const pickedTeam = candidate?.pick_team || (candidate?.pick_side === "away" ? awayTeam : candidate?.pick_side === "home" ? homeTeam : null);

  const starterEdge = (toNumber(model.away_starter_ra) || 0) - (toNumber(model.home_starter_ra) || 0);
  const bullpenEdge = (toNumber(model.away_bullpen_ra) || 0) - (toNumber(model.home_bullpen_ra) || 0);
  const environment = toNumber(model.environment_mult) || 1;
  const inningFactor = inningsScale(game);

  const starterLeader = starterEdge > 0.35 ? homeTeam : starterEdge < -0.35 ? awayTeam : null;
  const bullpenLeader = bullpenEdge > 0.25 ? homeTeam : bullpenEdge < -0.25 ? awayTeam : null;

  const overText = [];
  if ((toNumber(model.away_starter_ra) || 0) + (toNumber(model.home_starter_ra) || 0) >= 9.6) {
    overText.push("hay opciones de da�o ya contra los lanzadores iniciales");
  }
  if ((toNumber(model.away_bullpen_ra) || 0) + (toNumber(model.home_bullpen_ra) || 0) >= 9.4) {
    overText.push("el relevo puede dejar m�s huecos al final");
  }
  if (environment >= 1.03) {
    overText.push("el entorno acompa�a algo al bateo");
  }

  const underText = [];
  if ((toNumber(model.away_starter_ra) || 9) + (toNumber(model.home_starter_ra) || 9) <= 8.5) {
    underText.push("los abridores deber�an sostener el partido");
  }
  if ((toNumber(model.away_bullpen_ra) || 9) + (toNumber(model.home_bullpen_ra) || 9) <= 8.7) {
    underText.push("no se espera un final especialmente descontrolado");
  }
  if (environment <= 0.98) {
    underText.push("el contexto no empuja demasiado las carreras");
  }

  let text;

  if (!candidate) {
    text = "Lectura simple: el partido no deja una ventaja lo bastante limpia como para atacar con confianza.";
  } else if (candidate.market === "OVER") {
    text = "Lectura simple: este partido tiene pinta de abrirse";
    if (overText.length) text += ", porque " + overText.join(" y ");
    text += ".";
  } else if (candidate.market === "UNDER") {
    text = "Lectura simple: cuesta ver un intercambio continuo de carreras";
    if (underText.length) text += ", porque " + underText.join(" y ");
    text += ".";
  } else if (candidate.market === "HC_AWAY" || candidate.market === "HC_HOME") {
    const team = pickedTeam || "ese lado";
    const hcVal = toNumber(candidate.market === "HC_HOME" ? game.home_hc_val : game.away_hc_val);
    const isHcUnderdog = hcVal != null && hcVal > 0;
    if (isHcUnderdog) {
      text = "Lectura simple: " + team + " llega como el perdedor esperado pero tiene runs de colch�n - el modelo cree que el mercado no les da suficiente cr�dito";
      if (bullpenLeader === team) text += ", y el relevo aguanta bien al final";
    } else {
      text = "Lectura simple: " + team + " deber�a tener margen para ganar con algo de holgura";
      if (starterLeader === team) text += ", especialmente si el lanzador inicial lo controla desde el principio";
      else if (bullpenLeader === team) text += ", con un bullpen que sujeta mejor el partido";
    }
    text += ".";
  } else {
    const team = pickedTeam || "ese lado";
    const odds = toNumber(candidate.odds) || 2.0;
    const isUnderdog = odds >= 2.00;
    if (isUnderdog) {
      text = "Lectura simple: " + team + " llega como el equipo menos esperado, pero el modelo ve la cuota demasiado generosa para lo que dicen los n�meros";
      if (starterLeader === team && bullpenLeader === team) {
        text += " - llega mejor en el mont�culo y en el relevo";
      } else if (starterLeader === team) {
        text += " - su lanzador inicial suma a favor";
      } else if (bullpenLeader === team) {
        text += " - el bullpen puede ser la diferencia en los �ltimos turnos";
      }
    } else {
      text = "Lectura simple: " + team + " es el equipo del partido y los n�meros lo respaldan";
      if (starterLeader === team && bullpenLeader === team) {
        text += ", con ventaja tanto en el inicio como en el relevo";
      } else if (starterLeader === team) {
        text += ", sobre todo desde el mont�culo";
      } else if (bullpenLeader === team) {
        text += ", especialmente en los �ltimos turnos";
      }
    }
    text += ".";
  }

  if (inningFactor < 0.9 && (candidate?.market === "OVER" || candidate?.market === "UNDER")) {
    text += " Al ser duelo a 7 innings, conviene mantener disciplina con el precio.";
  }

  if (dataScore < 0.56) {
    text += " Es una ventaja interesante, pero sin subir el riesgo porque la muestra de inicio de temporada sigue corta.";
  }

  return text.replace(/\s+/g, " ").trim().slice(0, 320);
}

function analyzeMatchup(input) {
  const game = { ...(input?.game || {}) };
  const lines = {
    away_ml: toNumber(input?.away_ml),
    home_ml: toNumber(input?.home_ml),
    away_hc_odds: toNumber(input?.away_hc_odds),
    home_hc_odds: toNumber(input?.home_hc_odds),
    over_odds: toNumber(input?.over_odds),
    under_odds: toNumber(input?.under_odds),
  };

  game.away_hc_val = toNumber(input?.away_hc_val);
  game.home_hc_val = toNumber(input?.home_hc_val);
  game.total_line = toNumber(input?.total_line);

  const cfg = getLeagueConfig(game);
  const probabilities = marketProbabilities(game, cfg);
  const fairMap = impliedMapFromLines(lines);
  const dataScore = estimateDataScore(game);
  const candidates = [];
  const awayTeam = String(game.away_team_name || "Visitante");
  const homeTeam = String(game.home_team_name || "Local");

  if (lines.away_ml != null && fairMap.ML?.away != null) {
    candidates.push(buildCandidate({
      market: "ML",
      pick_side: "away",
      pick_team: awayTeam,
      odds: lines.away_ml,
      prob_estimated: probabilities.away_ml_win,
      prob_implied: fairMap.ML.away,
    }));
  }

  if (lines.home_ml != null && fairMap.ML?.home != null) {
    candidates.push(buildCandidate({
      market: "ML",
      pick_side: "home",
      pick_team: homeTeam,
      odds: lines.home_ml,
      prob_estimated: probabilities.home_ml_win,
      prob_implied: fairMap.ML.home,
    }));
  }

  // HC: solo a�adir candidato si el diferencial de carreras esperado supera el umbral m�nimo.
  // margin_model_weak = true cuando runDiff < 0.5 (flag diagn�stico ya propagado).
  // RUNLINE_MIN_DIFF (0.80) es un filtro m�s estricto: partidos muy igualados
  // tienen alta varianza en el resultado de HC independientemente del edge calculado.
  const runDiff = Math.abs(
    (toNumber(probabilities.away_runs) || 0) - (toNumber(probabilities.home_runs) || 0)
  );
  const hcAllowed = runDiff >= RUNLINE_MIN_DIFF;

  if (hcAllowed && lines.away_hc_odds != null && fairMap.HC?.away != null && game.away_hc_val != null) {
    candidates.push(buildCandidate({
      market: "HC_AWAY",
      pick_side: "away",
      pick_team: awayTeam,
      odds: lines.away_hc_odds,
      prob_estimated: probabilities.away_hc_win,
      prob_implied: fairMap.HC.away,
      push_prob: probabilities.away_hc_push,
    }));
  }

  if (hcAllowed && lines.home_hc_odds != null && fairMap.HC?.home != null && game.home_hc_val != null) {
    candidates.push(buildCandidate({
      market: "HC_HOME",
      pick_side: "home",
      pick_team: homeTeam,
      odds: lines.home_hc_odds,
      prob_estimated: probabilities.home_hc_win,
      prob_implied: fairMap.HC.home,
      push_prob: probabilities.home_hc_push,
    }));
  }

  if (lines.over_odds != null && fairMap.TOTAL?.over != null && game.total_line != null) {
    candidates.push(buildCandidate({
      market: "OVER",
      pick_side: "over",
      pick_team: null,
      odds: lines.over_odds,
      prob_estimated: probabilities.over_win,
      prob_implied: fairMap.TOTAL.over,
      push_prob: probabilities.over_push,
    }));
  }

  if (lines.under_odds != null && fairMap.TOTAL?.under != null && game.total_line != null) {
    candidates.push(buildCandidate({
      market: "UNDER",
      pick_side: "under",
      pick_team: null,
      odds: lines.under_odds,
      prob_estimated: probabilities.under_win,
      prob_implied: fairMap.TOTAL.under,
      push_prob: probabilities.under_push,
    }));
  }

  const validCandidates = candidates.filter(Boolean).map(candidate => {
    const baseCalibrated = calibrateProbability(
      candidate.prob_estimated,
      candidate.prob_implied,
      candidate.market,
      dataScore,
      game
    ) ?? candidate.prob_estimated;
    const calibratedProb = applyBucketCalibration(
      baseCalibrated,
      candidate.market,
      candidate.prob_implied,
      dataScore,
      candidate.pick_side
    ) ?? baseCalibrated;
    const calibratedEdge = computeExpectedValue(calibratedProb, candidate.odds, candidate.push_prob) ?? candidate.edge;
    // Vaughan Williams p.1214; Buchdahl p.735: favorite-longshot bias - bookmakers cargan
    // mayor margen en cuotas largas. El edge calculado en esas cuotas est� inflado.
    const oddsVal = toNumber(candidate.odds) || 0;
    const longshotFactor = oddsVal >= 3.50 ? 0.75 : oddsVal >= 2.50 ? 0.85 : 1.0;
    const effectiveEdge = round3((calibratedEdge || 0) * longshotFactor);
    const edgeThreshold = dynamicEdgeThreshold(game, probabilities, candidate, dataScore);

    // Flags de diagn�stico - no afectan el c�lculo, sirven para auditor�a
    const rawImp = candidate.prob_implied || 0.5;
    const probDiff = calibratedProb - rawImp;
    const diagFlags = [];

    if (rawImp > 0.52 && calibratedProb < rawImp - 0.02)
      diagFlags.push("favorite_suppression");         // calibraci�n empuja por debajo del mercado en favorito

    if (rawImp < 0.48 && probDiff > 0.12)
      diagFlags.push("dog_inflation");                // modelo infla prob de underdog >12pp sobre el mercado

    const awayR = toNumber(probabilities?.away_runs);
    const homeR  = toNumber(probabilities?.home_runs);
    if (awayR != null && homeR != null && Math.abs(awayR - homeR) < 0.5)
      diagFlags.push("margin_model_weak");            // partido muy igualado seg�n el modelo

    if ((candidate.market === "HC_HOME" || candidate.market === "HC_AWAY")
        && calibratedProb > 0.45 && calibratedProb < 0.55)
      diagFlags.push("runline_confidence_low");       // prob HC en zona gris (45-55%)

    return {
      ...candidate,
      raw_prob_estimated: candidate.prob_estimated,
      raw_edge: candidate.edge,
      prob_estimated: round3(calibratedProb),
      prob_edge: round3(calibratedProb - candidate.prob_implied),
      fair_odds: computeFairOdds(calibratedProb),
      edge: effectiveEdge,
      edge_raw: round3(calibratedEdge),
      longshot_factor: longshotFactor,
      edge_threshold: edgeThreshold,
      confidence: normalizeConfidence(dataScore, effectiveEdge, edgeThreshold),
      diag_flags: diagFlags,
      metrics_summary: metricsSummary(game, probabilities),
      reasoning: reasoningSummary(game, probabilities, candidate, dataScore),
      plain_reasoning: plainReasoningSummary(game, probabilities, candidate, dataScore),
    };
  });

  const publicablePicks = selectPublicableCandidates(validCandidates, 3, dataScore);

  const bestLean = validCandidates
    .slice()
    .sort(candidateSort)[0] || null;

  const bestPick = publicablePicks[0] || null;

  // Picks bloqueados: mercados en DISABLED_MARKETS que tendr�an edge real ? 15%
  const blockedPicks = validCandidates.filter(
    c => DISABLED_MARKETS.has(c.market) && (c.raw_edge ?? c.edge) >= 0.15
  );

  return {
    model_name: "poisson_quant_v3",
    data_score: round3(dataScore),
    ...probabilities,
    candidates: validCandidates,
    publicable_picks: publicablePicks,
    publicable_count: publicablePicks.length,
    best_pick: bestPick,
    best_lean: bestLean,
    blocked_picks: blockedPicks,
    metrics_summary: metricsSummary(game, probabilities),
    reasoning: reasoningSummary(game, probabilities, bestPick || bestLean, dataScore),
    plain_reasoning: plainReasoningSummary(game, probabilities, bestPick || bestLean, dataScore),
  };
}

module.exports = {
  analyzeMatchup,
  compareLine,
  computeExpectedValue,
  computeFairOdds,
  computeFairPair,
  environmentMultiplier,
  estimateAttackPer9,
  estimateBullpenRaPer9,
  estimateDataScore,
  estimateStarterRaPer9,
  estimateStarterShare,
  expectedRuns,
  impliedMapFromLines,
  inningsScale,
  marketProbabilities,
  marketEdgeThreshold,
  reasoningSummary,
  round2,
  round3,
  toNumber,
};
