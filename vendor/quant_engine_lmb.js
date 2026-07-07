"use strict";
"use strict";

// LMB (Liga Mexicana de B�isbol) - Motor cuantitativo
// Misma matem�tica que quant_engine.js (Negative Binomial + blend modelo/mercado)
// pero adaptado a los datos disponibles en LMB: ERA/K9/BB9/WHIP, sin Statcast.

// Promedio hist�rico LMB: ~5.97 RPG/equipo (vs 4.55 MiLB AAA).
// Fuente: 1,512 juegos 2024-2025 importados de MLB Stats API.
const LEAGUE_RUNS_PER_TEAM = 5.97;

// Sin backtest a�n ? calibraci�n neutra. Ajustar tras ?50 juegos resueltos.
const RUN_CALIBRATION_FACTOR = 1.0;

// Promedios de liga LMB estimados desde datos hist�ricos 2024-2025.
const LEAGUE_K9  = 7.5;
const LEAGUE_BB9 = 3.5;

// Negative Binomial k=7 (igualado con MiLB v2 - Severini �6.5: ligas menores tienen m�s varianza)
const NB_K = 7;

// Umbral m�nimo de diferencial de carreras para publicar HC
const RUNLINE_MIN_DIFF = 0.80;

// ?? helpers ??????????????????????????????????????????????????????????????????????????

function toNumber(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round3(v) { const n = toNumber(v); return n == null ? null : Number(n.toFixed(3)); }
function round2(v) { const n = toNumber(v); return n == null ? null : Number(n.toFixed(2)); }

function clamp(v, lo, hi) {
  const n = toNumber(v);
  if (n == null) return null;
  return Math.min(Math.max(n, lo), hi);
}

function average(arr) {
  const valid = arr.map(toNumber).filter(v => v != null);
  if (!valid.length) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

function weightedAverage(pairs, fallback) {
  let ws = 0, wt = 0;
  for (const p of pairs) {
    const v = toNumber(p?.value), w = toNumber(p?.weight);
    if (v == null || w == null || w <= 0) continue;
    ws += v * w; wt += w;
  }
  return wt <= 0 ? fallback : ws / wt;
}

function safeRatio(num, den) {
  const n = toNumber(num), d = toNumber(den);
  if (n == null || d == null || d === 0) return null;
  return n / d;
}

function sanitizeEra(value, sampleHint) {
  const era = toNumber(value);
  if (era == null) return null;
  const sample = toNumber(sampleHint);
  // En varios feeds LMB, ERA=0 aparece como placeholder cuando faltan datos.
  if (era <= 0) return null;
  if (era > 30) return null;
  if (sample != null && sample <= 0) return null;
  return era;
}

function sampleReliabilityFromIp(ip, full) {
  const v = toNumber(ip);
  if (v == null || v <= 0) return 0;
  return clamp(v / full, 0, 1);
}

function sampleReliabilityFromGames(games, full) {
  const v = toNumber(games);
  if (v == null || v <= 0) return 0;
  return clamp(v / full, 0, 1);
}

function teamPrefix(side)    { return side === "away" ? "away_team"   : "home_team";   }
function pitcherPrefix(side) { return side === "away" ? "away_p"      : "home_p";      }
function bullpenPrefix(side) { return side === "away" ? "away_bullpen" : "home_bullpen"; }

function inningsScale(game) {
  const innings = toNumber(game?.scheduled_innings) || 9;
  return clamp(innings / 9, 0.65, 1);
}

function currentSeason(game) {
  const direct = toNumber(game?.season);
  if (direct != null) return direct;
  const raw = game?.game_date;
  if (!raw) return new Date().getUTCFullYear();
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.getUTCFullYear() : new Date().getUTCFullYear();
}

function seasonRecencyWeight(dataSeason, target, prevW = 0.40) {
  const s = toNumber(dataSeason), t = toNumber(target);
  if (s == null || t == null) return 0;
  if (s === t)     return 1;
  if (s === t - 1) return prevW;
  return 0;
}

// ?? pesos de se�ales ?????????????????????????????????????????????????????????

function starterStatsSeasonWeight(game, side) {
  const prefix = pitcherPrefix(side);
  return seasonRecencyWeight(game[prefix + "_stats_season"], currentSeason(game), 0.45) || 0;
}

function starterSampleScore(game, side) {
  const prefix = pitcherPrefix(side);
  const sw = starterStatsSeasonWeight(game, side);
  const ipSeason = sampleReliabilityFromIp(game[prefix + "_ip_season"], 90) * sw;
  const ipRecent = sampleReliabilityFromIp(game[prefix + "_ip_l5"], 25);
  return clamp(ipSeason * 0.65 + ipRecent * 0.35, 0, 1);
}

function bullpenSignalWeight(game, side) {
  const prefix = bullpenPrefix(side);
  const sw = seasonRecencyWeight(game[prefix + "_season"], currentSeason(game), 0.45);
  const pw = sampleReliabilityFromGames(game[prefix + "_pitchers"], 8);
  return clamp(sw * pw, 0, 1) || 0;
}

// ?? data score ???????????????????????????????????????????????????????????????

function estimateDataScore(game) {
  let score = 0.15;
  score += starterSampleScore(game, "away") * 0.25;
  score += starterSampleScore(game, "home") * 0.25;
  score += sampleReliabilityFromGames(game.away_team_games, 40) * 0.12;
  score += sampleReliabilityFromGames(game.home_team_games, 40) * 0.12;
  score += (sanitizeEra(game.away_bullpen_era, game.away_bullpen_pitchers) != null ? 0.04 : 0) * Math.max(0.35, bullpenSignalWeight(game, "away"));
  score += (sanitizeEra(game.home_bullpen_era, game.home_bullpen_pitchers) != null ? 0.04 : 0) * Math.max(0.35, bullpenSignalWeight(game, "home"));
  score += game.park_factor != null ? 0.04 : 0;
  score += (game.temperature_2m != null || game.wind_speed_10m != null) ? 0.03 : 0;
  return clamp(score, 0.15, 0.90);
}

// ?? estimadores principales ??????????????????????????????????????????????????

function estimateAttackPer9(game, side) {
  const prefix = teamPrefix(side);
  const avgRuns = toNumber(game[prefix + "_avg_runs"]);
  const games   = toNumber(game[prefix + "_games"]);

  const sampleW = avgRuns == null ? 0 : clamp((games || 0) / 60, 0.10, 0.55);
  const baseW   = Math.max(0.45, 1 - sampleW);

  return clamp(
    weightedAverage(
      [{ value: avgRuns, weight: sampleW }, { value: LEAGUE_RUNS_PER_TEAM, weight: baseW }],
      LEAGUE_RUNS_PER_TEAM
    ),
    3.0, 9.5
  );
}

function estimateStarterRaPer9(game, side) {
  const prefix = pitcherPrefix(side);
  const ipSeason  = toNumber(game[prefix + "_ip_season"]);
  const ipL5      = toNumber(game[prefix + "_ip_l5"]);
  const seasonEra = sanitizeEra(game[prefix + "_era"], ipSeason);
  const recentEra = sanitizeEra(game[prefix + "_era_l5"], ipL5);
  const k9        = toNumber(game[prefix + "_k_9"]);
  const bb9       = toNumber(game[prefix + "_bb_9"]);
  const sw        = starterStatsSeasonWeight(game, side);

  // Shrinkage: confianza plena a 90 IP
  const seasonRel = sampleReliabilityFromIp(ipSeason, 90) * sw;
  const recentRel = sampleReliabilityFromIp(ipL5, 25) * 0.5;

  // Blend ERA temporada + media de liga (shrinkage bayesiano)
  let ra = weightedAverage([
    { value: seasonEra, weight: Math.max(0.22, seasonRel) },
    { value: LEAGUE_RUNS_PER_TEAM, weight: Math.max(0.52, 1 - seasonRel) },
  ], LEAGUE_RUNS_PER_TEAM);

  // Forma reciente
  if (recentEra != null) {
    ra = weightedAverage([
      { value: ra, weight: 1 - recentRel },
      { value: recentEra, weight: recentRel },
    ], ra);
  }

  // K/9 y BB/9 como se�ales de calidad (normalizado vs media de liga)
  // k9Signal positivo ? RA m�s alta (pocos ponches = m�s contacto)
  // bb9Signal positivo ? RA m�s alta (m�s bases por bolas)
  const k9Signal  = k9  != null ? clamp((LEAGUE_K9 - k9)  / 3.0, -1.5, 1.5) : 0;
  const bb9Signal = bb9 != null ? clamp((bb9 - LEAGUE_BB9) / 2.0, -1.5, 1.5) : 0;
  const qualitySignal = k9Signal * 0.12 + bb9Signal * 0.10;
  const signalRel = clamp(seasonRel * 0.6, 0, 0.45);
  ra *= 1 + qualitySignal * signalRel;

  // SIERA blend: cuando disponible, usa como segunda opini�n (40% weight m�x a muestra completa)
  const siera = toNumber(game[prefix + "_siera"]);
  if (siera != null) {
    const sieraW = clamp(seasonRel * 0.4, 0.05, 0.40);
    ra = ra * (1 - sieraW) + siera * sieraW;
  }

  return clamp(ra, 2.8, 9.0);
}

function estimateBullpenRaPer9(game, side) {
  const prefix = bullpenPrefix(side);
  const era    = sanitizeEra(game[prefix + "_era"], game[prefix + "_pitchers"]);
  const k9     = toNumber(game[prefix + "_k9"]);
  const bb9    = toNumber(game[prefix + "_bb9"]);
  const sw     = bullpenSignalWeight(game, side);

  let ra = weightedAverage([
    { value: era, weight: era != null ? 0.70 : 0 },
    { value: LEAGUE_RUNS_PER_TEAM, weight: 0.40 },
  ], LEAGUE_RUNS_PER_TEAM);

  ra = weightedAverage([
    { value: ra, weight: Math.max(0.2, sw) },
    { value: LEAGUE_RUNS_PER_TEAM, weight: Math.max(0.40, 1 - sw) },
  ], LEAGUE_RUNS_PER_TEAM);

  if (k9 != null || bb9 != null) {
    const k9s  = k9  != null ? clamp((LEAGUE_K9 - k9)  / 3.0, -1.5, 1.5) : 0;
    const bb9s = bb9 != null ? clamp((bb9 - LEAGUE_BB9) / 2.0, -1.5, 1.5) : 0;
    ra *= 1 + (k9s * 0.10 + bb9s * 0.08) * sw * 0.5;
  }

  return clamp(ra, 3.2, 8.5);
}

function estimateStarterShare(game, side) {
  const prefix = pitcherPrefix(side);
  const ipSeason = toNumber(game[prefix + "_ip_season"]);
  const ipL5     = toNumber(game[prefix + "_ip_l5"]);

  let share = 0.56;
  if (ipSeason != null) {
    if (ipSeason < 10)  share -= 0.10;
    else if (ipSeason < 25) share -= 0.05;
    else if (ipSeason > 60) share += 0.03;
  }
  if (ipL5 != null) {
    const avgIp = ipL5 / 5;
    if (avgIp < 4.0) share -= 0.06;
    else if (avgIp < 5.0) share -= 0.03;
    else if (avgIp > 6.0) share += 0.04;
  }
  return clamp(share, 0.42, 0.68);
}

function normalizeParkFactor(raw) {
  const v = toNumber(raw);
  if (v == null) return null;
  return v > 10 ? v / 100 : v;  // base-100 ? decimal, o ya es decimal
}

function environmentMultiplier(game, parkFactorWeight = 0.60) {
  let m = 1;

  const pf = normalizeParkFactor(game.park_factor);
  if (pf != null) {
    m *= 1 + (pf - 1) * parkFactorWeight;
  } else {
    // Sin park factor ? altitud como proxy (estadios nuevos o con <15 juegos hist�ricos)
    const alt = toNumber(game.altitude_m);
    if (alt != null) m *= 1 + clamp(alt / 1000, 0, 2.5) * 0.03;
  }

  const temp = toNumber(game.temperature_2m);
  if (temp != null) m *= 1 + clamp((temp - 20) * 0.004, -0.05, 0.06);

  const tail = toNumber(game.wind_tailwind);
  if (tail != null) m *= 1 + clamp(tail * 0.005, -0.07, 0.07);

  return clamp(m, 0.80, 1.30);
}

// ?? distribuci�n y probabilidades ????????????????????????????????????????????

function runDistribution(mu, maxRuns) {
  const mean = Math.max(0.01, toNumber(mu) || 0.01);
  const k = NB_K;
  const maxB = Math.max(16, Math.ceil(maxRuns || mean + 9 * Math.sqrt(mean)));
  const dist = new Array(maxB + 1).fill(0);
  const p = k / (k + mean), q = mean / (k + mean);
  dist[0] = Math.pow(p, k);
  let sum = dist[0];
  for (let r = 1; r < maxB; r++) {
    dist[r] = dist[r - 1] * ((r - 1 + k) / r) * q;
    sum += dist[r];
  }
  dist[maxB] = Math.max(0, 1 - sum);
  return dist;
}

function expectedRuns(game) {
  const awayAtk  = estimateAttackPer9(game, "away");
  const homeAtk  = estimateAttackPer9(game, "home");
  const awaySpRa = estimateStarterRaPer9(game, "away");
  const homeSpRa = estimateStarterRaPer9(game, "home");
  const awayBpRa = estimateBullpenRaPer9(game, "away");
  const homeBpRa = estimateBullpenRaPer9(game, "home");
  const awaySh   = estimateStarterShare(game, "away");
  const homeSh   = estimateStarterShare(game, "home");

  const awayDef = awaySpRa * awaySh + awayBpRa * (1 - awaySh);
  const homeDef = homeSpRa * homeSh + homeBpRa * (1 - homeSh);
  const envMult   = environmentMultiplier(game, 0.60); // ML/HC
  const envMultOU = environmentMultiplier(game, 0.90); // OU: parque afecta ambos equipos por igual
  const inningMult = inningsScale(game);

  // Ra�z Pythagorean: media geom�trica de ataque propio y defensa rival
  let awayR = Math.sqrt(Math.max(1.5, awayAtk) * Math.max(1.5, homeDef));
  let homeR = Math.sqrt(Math.max(1.5, homeAtk) * Math.max(1.5, awayDef));

  // �2.5% home advantage + calibraci�n + escala por innings
  awayR *= envMult * inningMult * 0.975 * RUN_CALIBRATION_FACTOR;
  homeR *= envMult * inningMult * 1.025 * RUN_CALIBRATION_FACTOR;

  awayR = clamp(awayR, 1.5, 10.5);
  homeR = clamp(homeR, 1.5, 10.5);

  // Correcci�n OU: ajusta runs con el peso 90% del parque
  const ouCorr  = envMult > 0 ? envMultOU / envMult : 1;
  const awayROU = clamp(awayR * ouCorr, 1.5, 10.5);
  const homeROU = clamp(homeR * ouCorr, 1.5, 10.5);

  return {
    away_runs:          round3(awayR),
    home_runs:          round3(homeR),
    total_runs:         round3(awayR + homeR),
    away_runs_ou:       round3(awayROU),
    home_runs_ou:       round3(homeROU),
    away_attack:        round3(awayAtk),
    home_attack:        round3(homeAtk),
    away_starter_ra:    round3(awaySpRa),
    home_starter_ra:    round3(homeSpRa),
    away_bullpen_ra:    round3(awayBpRa),
    home_bullpen_ra:    round3(homeBpRa),
    away_starter_share: round3(awaySh),
    home_starter_share: round3(homeSh),
    environment_mult:   round3(envMult),
  };
}

function compareLine(awayR, homeR, line, side) {
  const l = toNumber(line);
  if (l == null) return null;
  if (side === "away")  { return awayR + l > homeR ? "win" : awayR + l < homeR ? "loss" : "push"; }
  if (side === "home")  { return homeR + l > awayR ? "win" : homeR + l < awayR ? "loss" : "push"; }
  if (side === "over")  { return awayR + homeR > l  ? "win" : awayR + homeR < l  ? "loss" : "push"; }
  if (side === "under") { return awayR + homeR < l  ? "win" : awayR + homeR > l  ? "loss" : "push"; }
  return null;
}

function pythagoreanWinProb(rs, ra) {
  const s = toNumber(rs), a = toNumber(ra);
  if (!s || !a || s <= 0 || a <= 0) return null;
  const e = 1.83;
  return Math.pow(s, e) / (Math.pow(s, e) + Math.pow(a, e));
}

function marketProbabilities(game) {
  const re = expectedRuns(game);
  const maxR = Math.max(18, Math.ceil((re.total_runs || 12) + 10));
  const adist   = runDistribution(re.away_runs, maxR);
  const hdist   = runDistribution(re.home_runs, maxR);
  // OU usa distribuciones con park factor 90% (ambos equipos sienten el parque por igual)
  const adistOU = runDistribution(re.away_runs_ou ?? re.away_runs, maxR);
  const hdistOU = runDistribution(re.home_runs_ou ?? re.home_runs, maxR);

  let aMl = 0, hMl = 0, tie = 0;
  let aHcW = 0, aHcPush = 0, hHcW = 0, hHcPush = 0;
  let ovW = 0, ovPush = 0, unW = 0, unPush = 0;

  for (let a = 0; a < adist.length; a++) {
    if (!adist[a]) continue;
    for (let h = 0; h < hdist.length; h++) {
      const jp = adist[a] * hdist[h];
      if (!jp) continue;
      if (a > h) aMl += jp; else if (h > a) hMl += jp; else tie += jp;

      const aHc = compareLine(a, h, game.away_hc_val, "away");
      if (aHc === "win") aHcW += jp; if (aHc === "push") aHcPush += jp;
      const hHc = compareLine(a, h, game.home_hc_val, "home");
      if (hHc === "win") hHcW += jp; if (hHc === "push") hHcPush += jp;
    }
  }
  // OU con distribuciones ajustadas al 90% del parque
  for (let a = 0; a < adistOU.length; a++) {
    if (!adistOU[a]) continue;
    for (let h = 0; h < hdistOU.length; h++) {
      const jp = adistOU[a] * hdistOU[h];
      if (!jp) continue;
      const ov = compareLine(a, h, game.total_line, "over");
      if (ov === "win") ovW += jp; if (ov === "push") ovPush += jp;
      const un = compareLine(a, h, game.total_line, "under");
      if (un === "win") unW += jp; if (un === "push") unPush += jp;
    }
  }

  const hBias = 0.52;
  aMl += tie * (1 - hBias); hMl += tie * hBias;

  // Blend 80% NB + 20% Pythagorean cuando hay suficiente muestra de equipo
  const aGames = toNumber(game.away_team_games) || 0;
  const hGames = toNumber(game.home_team_games) || 0;
  const pythA = pythagoreanWinProb(game.away_team_avg_runs, game.home_team_avg_runs);
  const pythH = pythagoreanWinProb(game.home_team_avg_runs, game.away_team_avg_runs);
  if (pythA != null && pythH != null && aGames >= 10 && hGames >= 10) {
    aMl = aMl * 0.80 + pythA * 0.20;
    hMl = hMl * 0.80 + pythH * 0.20;
  }

  return {
    ...re,
    away_ml_win:   round3(aMl),
    home_ml_win:   round3(hMl),
    tie_regulation: round3(tie),
    away_hc_win:   round3(aHcW),
    away_hc_push:  round3(aHcPush),
    home_hc_win:   round3(hHcW),
    home_hc_push:  round3(hHcPush),
    over_win:      round3(ovW),
    over_push:     round3(ovPush),
    under_win:     round3(unW),
    under_push:    round3(unPush),
  };
}

// ?? calibraci�n y mercado ??????????????????????????????????????????????????????

function computeFairPair(a, b) {
  const fa = toNumber(a), fb = toNumber(b);
  if (fa == null || fb == null || fa < 1.01 || fb < 1.01) return null;
  const ra = 1 / fa, rb = 1 / fb, ov = ra + rb;
  if (!Number.isFinite(ov) || ov <= 0) return null;
  return { first: round3(ra / ov), second: round3(rb / ov), overround: round3(ov) };
}

function computeFairOdds(prob) {
  const p = toNumber(prob);
  if (p == null || p <= 0 || p >= 1) return null;
  return round3(1 / p);
}

function computeEV(winProb, odds, pushProb) {
  const wp = toNumber(winProb), od = toNumber(odds), pp = toNumber(pushProb) || 0;
  if (wp == null || od == null || od <= 0) return null;
  return round3(wp * od + pp - 1);
}

function marketEdgeThreshold(market) {
  return 0.18;
}

function calibrationModelWeight(market, dataScore) {
  // Buchdahl/Rudnitsky: LMB tiene menor eficiencia que MLB ? blend 65/35 ML, 62/38 OU
  // OU subi� de 0.50 a 0.62: 10 picks reales muestran -47% ROI en OU con 50/50 (igual que MiLB antes)
  let w = market === "ML" ? 0.65
        : (market === "HC_AWAY" || market === "HC_HOME") ? 0.60
        : 0.62;  // OU - igualado con MiLB

  if (dataScore >= 0.72)      w += 0.07;
  else if (dataScore >= 0.60) w += 0.03;
  else if (dataScore < 0.45)  w -= 0.08;
  else if (dataScore < 0.55)  w -= 0.05;

  // Suelo: nunca dejar que el mercado domine completamente (evita EV estructuralmente negativo)
  return clamp(w, 0.48, 0.85) || 0.52;
}

function calibrateProbability(rawProb, impliedProb, market, dataScore) {
  const raw = toNumber(rawProb), imp = toNumber(impliedProb);
  if (raw == null) return null;
  const anchor = imp ?? 0.5;
  const W = calibrationModelWeight(market, dataScore);
  return round3(clamp(raw * W + anchor * (1 - W), 0.08, 0.92));
}

function normalizeConfidence(score, edge, threshold) {
  if (score >= 0.72 && edge >= threshold + 0.10) return "HIGH";
  if (score >= 0.55 && edge >= threshold + 0.03) return "MEDIUM";
  return "LOW";
}

function impliedBucket(imp) {
  if (imp > 0.62) return "strong_fav";
  if (imp > 0.55) return "fav";
  if (imp > 0.48) return "neutral";
  if (imp > 0.38) return "dog";
  return "heavy_dog";
}

function edgeSurplus(c) {
  if (!c) return -Infinity;
  return (c.edge || 0) - (c.edge_threshold || marketEdgeThreshold(c.market));
}

function candidatesConflict(a, b) {
  if (!a || !b) return false;
  const am = String(a.market || ""), bm = String(b.market || "");
  if ((am === "OVER" || am === "UNDER") && (bm === "OVER" || bm === "UNDER")) return am !== bm;
  if (am === "ML" && bm === "ML") return a.pick_side !== b.pick_side;
  if ((am === "HC_AWAY" || am === "HC_HOME") && (bm === "HC_AWAY" || bm === "HC_HOME")) return am !== bm;
  const aSide = am === "ML" ? a.pick_side : am === "HC_AWAY" ? "away" : am === "HC_HOME" ? "home" : null;
  const bSide = bm === "ML" ? b.pick_side : bm === "HC_AWAY" ? "away" : bm === "HC_HOME" ? "home" : null;
  const aIsSide = am === "ML" || am === "HC_AWAY" || am === "HC_HOME";
  const bIsSide = bm === "ML" || bm === "HC_AWAY" || bm === "HC_HOME";
  if (aIsSide && bIsSide && aSide && bSide && aSide !== bSide) {
    if ((am === "ML" || bm === "ML") && (am.startsWith("HC") || bm.startsWith("HC"))) return true;
  }
  if ((aIsSide && bm === "OVER") || (am === "OVER" && bIsSide)) return true;
  return false;
}

function candidateSort(a, b) {
  const diff = edgeSurplus(b) - edgeSurplus(a);
  if (Math.abs(diff) > 0.025) return diff;
  return (b.edge || 0) - (a.edge || 0);
}

function buildCandidate(d) {
  const odds = toNumber(d.odds), wp = toNumber(d.prob_estimated), imp = toNumber(d.prob_implied);
  if (odds == null || wp == null || imp == null) return null;
  const push = toNumber(d.push_prob) || 0;
  const edge = computeEV(wp, odds, push);
  if (edge == null) return null;
  return {
    market: d.market, pick_side: d.pick_side, pick_team: d.pick_team || null,
    odds: round3(odds), prob_estimated: round3(wp), prob_implied: round3(imp),
    prob_edge: round3(wp - imp), fair_odds: computeFairOdds(wp),
    edge, push_prob: round3(push), edge_threshold: marketEdgeThreshold(d.market),
  };
}

function selectPublicableCandidates(candidates, maxPicks, dataScore) {
  const limit = dataScore >= 0.60 ? Math.min(maxPicks, 2) : 1;
  const sorted = (Array.isArray(candidates) ? candidates : []).filter(c => {
    if ((c.edge || 0) < (c.edge_threshold || marketEdgeThreshold(c.market))) return false;
    const mkt = c.market || "";
    if ((mkt === "HC_HOME" || mkt === "HC_AWAY") && (c.prob_estimated || 0) < 0.52) return false;
    return true;
  }).sort(candidateSort);
  const chosen = [];
  for (const c of sorted) {
    if (chosen.some(x => candidatesConflict(x, c))) continue;
    chosen.push(c);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

// ?? res�menes ????????????????????????????????????????????????????????????????

function metricsSummary(game, model) {
  const parts = [];
  if (model.away_runs != null && model.home_runs != null) {
    parts.push("exp " + model.away_runs.toFixed(2) + "-" + model.home_runs.toFixed(2));
  }
  const aEra = sanitizeEra(game.away_p_era, game.away_p_ip_season);
  const hEra = sanitizeEra(game.home_p_era, game.home_p_ip_season);
  if (aEra != null && hEra != null) parts.push("SP ERA " + aEra.toFixed(2) + " vs " + hEra.toFixed(2));
  const aBp = sanitizeEra(game.away_bullpen_era, game.away_bullpen_pitchers);
  const hBp = sanitizeEra(game.home_bullpen_era, game.home_bullpen_pitchers);
  if (aBp != null && hBp != null) parts.push("pen ERA " + aBp.toFixed(2) + " vs " + hBp.toFixed(2));
  const aRpg = toNumber(game.away_team_avg_runs), hRpg = toNumber(game.home_team_avg_runs);
  if (aRpg != null && hRpg != null) parts.push("R/G " + aRpg.toFixed(2) + " vs " + hRpg.toFixed(2));
  const pf = toNumber(game.park_factor);
  if (pf != null) parts.push("PF " + pf.toFixed(3));
  const temp = toNumber(game.temperature_2m), tail = toNumber(game.wind_tailwind);
  if (temp != null || tail != null) {
    parts.push("clima " + (temp != null ? temp.toFixed(0) + "�C" : "?") + " / " + (tail != null ? tail.toFixed(1) + "km/h" : "?"));
  }
  return parts.join(" | ").slice(0, 250);
}

function reasoningSummary(game, model, candidate, dataScore) {
  const away = String(game.away_team_name || "Visitante");
  const home  = String(game.home_team_name || "Local");
  const score = model.away_runs != null
    ? "Marcador esperado " + model.away_runs.toFixed(2) + "-" + model.home_runs.toFixed(2) + "."
    : "Sin marcador esperado claro.";
  const total = model.total_runs != null ? "Total esperado " + model.total_runs.toFixed(2) + "." : null;
  const bits = [];
  if (model.away_starter_ra != null && model.home_starter_ra != null) {
    bits.push("SP " + model.away_starter_ra.toFixed(2) + " vs " + model.home_starter_ra.toFixed(2) + " RA");
  }
  if (model.away_bullpen_ra != null && model.home_bullpen_ra != null) {
    bits.push("bullpen " + model.away_bullpen_ra.toFixed(2) + " vs " + model.home_bullpen_ra.toFixed(2));
  }
  if (model.environment_mult != null && Math.abs(model.environment_mult - 1) >= 0.03) {
    bits.push("entorno x" + model.environment_mult.toFixed(2));
  }
  const conf = dataScore >= 0.7 ? "Datos aceptables." : "Muestra limitada - prudencia alta.";
  if (!candidate) return (score + " " + bits.join(", ") + ". " + conf).trim().slice(0, 500);
  if (candidate.market === "OVER" || candidate.market === "UNDER") {
    return ("Ritmo favorable al " + (candidate.market === "OVER" ? "Over" : "Under") + ". " + (total || score) + " " + bits.join(", ") + ". " + conf).replace(/\s+/g, " ").trim().slice(0, 500);
  }
  const team = candidate.pick_team || (candidate.pick_side === "away" ? away : home);
  return (score + " " + bits.join(", ") + ". " + conf).replace(/\s+/g, " ").trim().slice(0, 500);
}

// ?? funci�n principal ????????????????????????????????????????????????????????

function analyzeMatchup(input) {
  const game = { ...(input?.game || {}) };
  const lines = {
    away_ml:       toNumber(input?.away_ml),
    home_ml:       toNumber(input?.home_ml),
    away_hc_odds:  toNumber(input?.away_hc_odds),
    home_hc_odds:  toNumber(input?.home_hc_odds),
    over_odds:     toNumber(input?.over_odds),
    under_odds:    toNumber(input?.under_odds),
  };
  game.away_hc_val  = toNumber(input?.away_hc_val);
  game.home_hc_val  = toNumber(input?.home_hc_val);
  game.total_line   = toNumber(input?.total_line);

  const probs     = marketProbabilities(game);
  const dataScore = estimateDataScore(game);
  const away      = String(game.away_team_name || "Visitante");
  const home      = String(game.home_team_name || "Local");

  const mlFair  = computeFairPair(lines.away_ml, lines.home_ml);
  const hcFair  = computeFairPair(lines.away_hc_odds, lines.home_hc_odds);
  const totFair = computeFairPair(lines.over_odds, lines.under_odds);

  const rawCandidates = [];

  if (lines.away_ml != null && mlFair?.first != null) {
    rawCandidates.push(buildCandidate({ market: "ML", pick_side: "away", pick_team: away, odds: lines.away_ml, prob_estimated: probs.away_ml_win, prob_implied: mlFair.first }));
  }
  if (lines.home_ml != null && mlFair?.second != null) {
    rawCandidates.push(buildCandidate({ market: "ML", pick_side: "home", pick_team: home, odds: lines.home_ml, prob_estimated: probs.home_ml_win, prob_implied: mlFair.second }));
  }

  const runDiff = Math.abs((toNumber(probs.away_runs) || 0) - (toNumber(probs.home_runs) || 0));
  // 2026-07-04: se quita el gate "runDiff >= RUNLINE_MIN_DIFF" que impedia CREAR el candidato HC
  // (y por tanto guardarlo en lmb_candidates_history para calibracion) cuando el partido estaba parejo.
  // La proteccion real para no PUBLICAR picks HC de bajo margen ya existe en selectPublicableCandidates()
  // (rechaza HC si prob_estimated < 0.52), asi que este gate adicional solo perdia datos de calibracion.
  if (lines.away_hc_odds != null && hcFair?.first != null && game.away_hc_val != null) {
    rawCandidates.push(buildCandidate({ market: "HC_AWAY", pick_side: "away", pick_team: away, odds: lines.away_hc_odds, prob_estimated: probs.away_hc_win, prob_implied: hcFair.first, push_prob: probs.away_hc_push }));
  }
  if (lines.home_hc_odds != null && hcFair?.second != null && game.home_hc_val != null) {
    rawCandidates.push(buildCandidate({ market: "HC_HOME", pick_side: "home", pick_team: home, odds: lines.home_hc_odds, prob_estimated: probs.home_hc_win, prob_implied: hcFair.second, push_prob: probs.home_hc_push }));
  }

  if (lines.over_odds != null && totFair?.first != null && game.total_line != null) {
    rawCandidates.push(buildCandidate({ market: "OVER", pick_side: "over", odds: lines.over_odds, prob_estimated: probs.over_win, prob_implied: totFair.first, push_prob: probs.over_push }));
  }
  if (lines.under_odds != null && totFair?.second != null && game.total_line != null) {
    rawCandidates.push(buildCandidate({ market: "UNDER", pick_side: "under", odds: lines.under_odds, prob_estimated: probs.under_win, prob_implied: totFair.second, push_prob: probs.under_push }));
  }

  const candidates = rawCandidates.filter(Boolean).map(c => {
    const cal = calibrateProbability(c.prob_estimated, c.prob_implied, c.market, dataScore) ?? c.prob_estimated;
    const calEdge = computeEV(cal, c.odds, c.push_prob) ?? c.edge;
    const thresh = marketEdgeThreshold(c.market);

    const imp = c.prob_implied || 0.5;
    const diagFlags = [];
    if (imp > 0.52 && cal < imp - 0.02)  diagFlags.push("favorite_suppression");
    if (imp < 0.48 && cal - imp > 0.12)  diagFlags.push("dog_inflation");
    if (runDiff < 0.5)                    diagFlags.push("margin_model_weak");
    if ((c.market === "HC_HOME" || c.market === "HC_AWAY") && cal > 0.45 && cal < 0.55) {
      diagFlags.push("runline_confidence_low");
    }

    return {
      ...c,
      raw_prob_estimated: c.prob_estimated,
      raw_edge: c.edge,
      prob_estimated: round3(cal),
      prob_edge: round3(cal - imp),
      fair_odds: computeFairOdds(cal),
      edge: round3(calEdge),
      edge_threshold: thresh,
      confidence: normalizeConfidence(dataScore, calEdge, thresh),
      diag_flags: diagFlags,
      metrics_summary: metricsSummary(game, probs),
      reasoning: reasoningSummary(game, probs, c, dataScore),
    };
  });

  const publicable = selectPublicableCandidates(candidates, 3, dataScore);
  const bestPick   = publicable[0] || null;
  const bestLean   = candidates.slice().sort(candidateSort)[0] || null;

  return {
    model_name:       "lmb_quant_v1",
    data_score:       round3(dataScore),
    ...probs,
    candidates,
    publicable_picks:  publicable,
    publicable_count:  publicable.length,
    best_pick:         bestPick,
    best_lean:         bestLean,
    blocked_picks:     [],
    metrics_summary:   metricsSummary(game, probs),
    reasoning:         reasoningSummary(game, probs, bestPick || bestLean, dataScore),
  };
}

module.exports = {
  LEAGUE_RUNS_PER_TEAM,
  analyzeMatchup,
  compareLine,
  computeEV,
  computeFairOdds,
  computeFairPair,
  environmentMultiplier,
  estimateAttackPer9,
  estimateBullpenRaPer9,
  estimateDataScore,
  estimateStarterRaPer9,
  estimateStarterShare,
  expectedRuns,
  marketEdgeThreshold,
  marketProbabilities,
  reasoningSummary,
  round2,
  round3,
  toNumber,
};
