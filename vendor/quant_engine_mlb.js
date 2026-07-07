"use strict";
"use strict";
/**
 * quant_engine_mlb.js
 * Motor cuantitativo para MLB - gemelo de quant_engine_lmb.js
 *
 * Diferencias vs LMB:
 *  - LEAGUE_RUNS_PER_TEAM = 4.6 (MLB promedio ~9.2 carreras/juego)
 *  - Park factor v�a mlb_park_factors (base 100 ? decimal en runtime)
 *  - calibrationModelWeight m�s alto que LMB (datos de pitcher MLB completos)
 *  - Sin Statcast todav�a ? data_score 0.35-0.65; se a�adir� cuando
 *    mlb_pitcher_statcast se pueble
 *
 * Entrada (matchup = row de vw_mlb_matchups_ready):
 *   away/home_p_era, away/home_p_ip_season, away/home_p_k_9, away/home_p_bb_9
 *   away/home_p_era_l5, away/home_p_ip_l5
 *   away/home_bullpen_era/k9/bb9/pitchers
 *   away/home_team_avg_runs, away/home_team_games
 *   park_factor_runs (base 100), altitude_m
 *   temperature_2m, wind_speed_10m, wind_tailwind
 *
 * Salida: { model_name, data_score, total_runs, candidates[], publicable_picks[], best_pick, best_lean }
 */

// ?? Constantes ???????????????????????????????????????????????????????????????

const LEAGUE_RUNS_PER_TEAM  = 4.6;
const RUN_CALIBRATION_FACTOR = 1.0; // 2026-07-05 - REVERTIDO: el 1.08 desplegado el 04-jul se basaba en un backtest con filtro de mercado erroneo (n=25-33, solo un resto de formato antiguo "OVER"/"UNDER" de mayo) - con el filtro corregido (n=440, mercado "OU" generico) subir el factor EMPEORA el P/L (-4.90u a -12.42u), no lo mejora. Ver docs/10_KNOWN_ISSUES.md.
const LINEUP_ADJUST_ENABLED = true; // 2026-07-04 - Fase 2 lineup_factor: flag para apagar el ajuste si en unas semanas no mejora nada
const LEAGUE_K9  = 8.5;
const LEAGUE_BB9 = 3.2;
const NB_K       = 8;
const GRID_MAX   = 15;
function marketEdgeThreshold(market) {
  if (market === "OVER") return 0.25; // OVER: 2W-8L MLB+MiLB, umbral subido 2026-05-28
  return 0.18;
}
const RUNLINE_MIN_DIFF = 0.80;

// ?? Negative Binomial ????????????????????????????????????????????????????????

function lgamma(z) {
  const c = [76.18009172947146,-86.50532032941677,24.01409824083091,
    -1.231739572450155,0.001208650973866179,-5.395239384953e-6];
  let y = z, x = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const ci of c) { y++; ser += ci / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function nbPMF(k, mu, kappa) {
  const p = kappa / (kappa + mu);
  const lp = Math.log(p), l1mp = Math.log(1 - p);
  return Math.exp(
    lgamma(k + kappa) - lgamma(kappa) - lgamma(k + 1) +
    kappa * lp + k * l1mp
  );
}

function buildDist(mu, kappa) {
  const dist = [];
  let cumul = 0;
  for (let r = 0; r <= GRID_MAX; r++) {
    const p = r < GRID_MAX ? nbPMF(r, mu, kappa) : Math.max(0, 1 - cumul);
    dist.push(p);
    cumul += p;
  }
  return dist;
}

// ?? Helpers ??????????????????????????????????????????????????????????????????

function round2(n) { return Math.round(n * 100) / 100; }

function sampleReliabilityFromIp(ip, threshold) {
  if (!ip || ip <= 0) return 0;
  return Math.min(1, ip / threshold);
}

function shrinkToLeague(val, leagueVal, reliability) {
  if (val == null || isNaN(val)) return leagueVal;
  return val * reliability + leagueVal * (1 - reliability);
}

function inningsScale(g) {
  const n = g?.scheduled_innings;
  const v = (n == null || n === "") ? 9 : Number(n);
  return Math.min(1, Math.max(0.65, (Number.isFinite(v) ? v : 9) / 9));
}

function americanToDecimal(odds) {
  if (odds == null) return null;
  // Auto-detect: 1.01-15 = already decimal (covers all realistic MLB market odds)
  if (odds >= 1.01 && odds <= 15) return odds;
  // American format (e.g. +150, -170)
  return odds > 0 ? (odds / 100) + 1 : (100 / Math.abs(odds)) + 1;
}

function decimalToImplied(dec) {
  if (!dec || dec <= 1) return null;
  return 1 / dec;
}

function oddsToImplied(odds) {
  return decimalToImplied(americanToDecimal(odds));
}

function computeFairPair(pA, pB) {
  const total = pA + pB;
  if (!total) return null;
  const over = 1 / total;
  return { first: pA / total, second: pB / total, overround: round2(over) };
}

// ?? Estimaci�n de carreras permitidas por 9 innings ??????????????????????????

function estimateStarterRaPer9(era, eraL5, ipSeason, ipL5, k9, bb9, season, currentSeason, siera) {
  const IP_THRESHOLD = 120;

  const relSeason = sampleReliabilityFromIp(ipSeason, IP_THRESHOLD);
  const relL5     = sampleReliabilityFromIp(ipL5, 20);
  const crossSeason = (season != null && currentSeason != null && season < currentSeason) ? 0.5 : 1.0;

  let ra = LEAGUE_RUNS_PER_TEAM;

  if (era != null && !isNaN(era)) {
    const eraAdj = shrinkToLeague(era, 4.20, relSeason * crossSeason);
    ra = eraAdj;

    if (eraL5 != null && relL5 > 0) {
      ra = ra * (1 - relL5 * 0.25) + eraL5 * relL5 * 0.25;
    }

    // K/9 y BB/9 ajustan suavemente
    if (k9 != null) {
      const kAdj  = shrinkToLeague(k9, LEAGUE_K9, relSeason);
      const kDiff = (kAdj - LEAGUE_K9) / LEAGUE_K9;
      ra *= (1 - kDiff * 0.12);
    }
    if (bb9 != null) {
      const bAdj  = shrinkToLeague(bb9, LEAGUE_BB9, relSeason);
      const bDiff = (bAdj - LEAGUE_BB9) / LEAGUE_BB9;
      ra *= (1 + bDiff * 0.10);
    }
  }

  // SIERA blend: segunda opini�n independiente de ERA (40% m�x a muestra completa)
  if (siera != null && !isNaN(siera)) {
    const sieraW = Math.min(0.40, relSeason * crossSeason * 0.45);
    ra = ra * (1 - sieraW) + siera * sieraW;
  }

  return Math.max(0.5, Math.min(ra, 9.0));
}

function estimateBullpenRaPer9(bpEra, bpK9, bpBb9, bpIp, season, currentSeason) {
  const IP_THRESHOLD = 300;
  const LEAGUE_BP_ERA = 4.30;

  if (bpEra == null) return LEAGUE_BP_ERA;
  const rel = sampleReliabilityFromIp(bpIp, IP_THRESHOLD);
  const crossSeason = (season != null && currentSeason != null && season < currentSeason) ? 0.6 : 1.0;

  let ra = shrinkToLeague(bpEra, LEAGUE_BP_ERA, rel * crossSeason);

  if (bpK9 != null) {
    const kAdj = shrinkToLeague(bpK9, LEAGUE_K9, rel);
    ra *= (1 - (kAdj - LEAGUE_K9) / LEAGUE_K9 * 0.10);
  }
  if (bpBb9 != null) {
    const bAdj = shrinkToLeague(bpBb9, LEAGUE_BB9, rel);
    ra *= (1 + (bAdj - LEAGUE_BB9) / LEAGUE_BB9 * 0.08);
  }
  return Math.max(1.5, Math.min(ra, 8.0));
}

// Combina starter (~5.5 inn) + bullpen (~3.5 inn) ? RA/9 del juego completo
function blendGameRa(starterRa, bullpenRa) {
  const STARTER_INN = 5.5, TOTAL_INN = 9.0;
  return (starterRa * STARTER_INN + bullpenRa * (TOTAL_INN - STARTER_INN)) / TOTAL_INN;
}

// ?? Ofensiva del equipo ??????????????????????????????????????????????????????

function estimateAttackPer9(avgRunsGame, teamGames) {
  if (!avgRunsGame || !teamGames) return LEAGUE_RUNS_PER_TEAM;
  const rel = Math.min(1, teamGames / 40);
  return shrinkToLeague(avgRunsGame, LEAGUE_RUNS_PER_TEAM, rel);
}

// ?? Entorno ??????????????????????????????????????????????????????????????????

function environmentMultiplier(parkFactorRuns, altitudeM, tempC, tailwind) {
  let mult = 1.0;

  // Park factor: base 100 en DB ? decimal
  if (parkFactorRuns != null) {
    // 60% shrinkage - mismo criterio que MiLB/LMB (evita sobreplantear park effects)
    mult *= 1 + (parkFactorRuns / 100 - 1) * 0.60;
  } else if (altitudeM != null) {
    // Fallback: altitud moderada (MLB tiene menos extremos que LMB)
    const altFactor = 1 + (altitudeM / 1000) * 0.025;
    mult *= Math.min(altFactor, 1.20);
  }

  // Temperatura
  if (tempC != null) {
    const tempF = tempC * 9/5 + 32;
    if (tempF < 50)       mult *= 0.96;
    else if (tempF > 85)  mult *= 1.04;
  }

  // Viento de cola
  if (tailwind != null) {
    if (tailwind > 4)       mult *= 1.04;
    else if (tailwind > 2)  mult *= 1.02;
    else if (tailwind < -4) mult *= 0.96;
    else if (tailwind < -2) mult *= 0.98;
  }

  return Math.max(0.80, Math.min(mult, 1.30));
}

// ?? Data score ???????????????????????????????????????????????????????????????

function computeDataScore(g) {
  let score = 0.10;

  // Starter visitante
  if (g.away_p_era != null && g.away_p_ip_season > 30)  score += 0.12;
  if (g.away_p_era_l5 != null)                           score += 0.06;
  if (g.away_p_k_9 != null)                              score += 0.04;

  // Starter local
  if (g.home_p_era != null && g.home_p_ip_season > 30)  score += 0.12;
  if (g.home_p_era_l5 != null)                           score += 0.06;
  if (g.home_p_k_9 != null)                              score += 0.04;

  // Bullpen
  if (g.away_bullpen_era != null)                        score += 0.06;
  if (g.home_bullpen_era != null)                        score += 0.06;

  // Ofensiva
  if (g.away_team_games >= 10)                           score += 0.08;
  if (g.home_team_games >= 10)                           score += 0.08;

  // Park factor
  if (g.park_factor_runs != null)                        score += 0.06;

  // Clima
  if (g.temperature_2m != null)                          score += 0.04;

  // Fase 2 (2026-07-04): +0.04 si el lineup real de ambos equipos ya esta confirmado
  if (g.lineup_factor_away != null && g.lineup_factor_home != null) score += 0.04;

  return Math.min(1.0, round2(score));
}

// ?? Calibration blend model/mercado ?????????????????????????????????????????

function calibrationModelWeight(market, dataScore) {
  const BASE = { ML: 0.50, HC: 0.46, OU: 0.50 }; // recalibrado 2026-05-28: ML 33% hitrate, HC 25% hitrate
  const base = BASE[market] ?? 0.55;
  // Bonus si data_score alto
  const bonus = dataScore >= 0.72 ? 0.07 : (dataScore >= 0.55 ? 0.03 : 0);
  return Math.min(0.75, base + bonus);
}

// ?? Candidatos de apuesta ????????????????????????????????????????????????????

function evalCandidate(probModel, probImplied, market, dataScore, odds, extra = {}) {
  if (probModel == null || probImplied == null) return null;
  const W = calibrationModelWeight(market, dataScore);
  const probBlended = probModel * W + probImplied * (1 - W);
  const decOdds = americanToDecimal(odds) ?? (probImplied > 0 ? 1 / probImplied : null);
  // EV est�ndar: (prob � odds) ? 1, igual que MiLB/LMB
  const edge = decOdds != null ? round2(probBlended * decOdds - 1) : round2(probBlended - probImplied);
  const threshold = marketEdgeThreshold(market);
  const confidence = edge >= 0.20 ? "Alta" : (edge >= threshold ? "Media" : "Lean");

  return {
    market, odds, edge, prob_model: round2(probModel),
    prob_implied: round2(probImplied), prob_blended: round2(probBlended),
    data_score: dataScore, edge_threshold: threshold, confidence, ...extra,
  };
}

// ?? An�lisis de matchup ??????????????????????????????????????????????????????

function analyzeMatchup(input = {}) {
  const g = input?.game ? input.game : input;
  const currentSeason = g.season ?? new Date().getFullYear();

  // Starter RA/9
  const awayStarterRa = estimateStarterRaPer9(
    g.away_p_era, g.away_p_era_l5, g.away_p_ip_season, g.away_p_ip_l5,
    g.away_p_k_9, g.away_p_bb_9, g.away_p_stats_season, currentSeason, g.away_p_siera
  );
  const homeStarterRa = estimateStarterRaPer9(
    g.home_p_era, g.home_p_era_l5, g.home_p_ip_season, g.home_p_ip_l5,
    g.home_p_k_9, g.home_p_bb_9, g.home_p_stats_season, currentSeason, g.home_p_siera
  );

  // Bullpen RA/9
  const awayBpRa = estimateBullpenRaPer9(
    g.away_bullpen_era, g.away_bullpen_k9, g.away_bullpen_bb9,
    g.away_bullpen_ip, g.away_bullpen_season, currentSeason
  );
  const homeBpRa = estimateBullpenRaPer9(
    g.home_bullpen_era, g.home_bullpen_k9, g.home_bullpen_bb9,
    g.home_bullpen_ip, g.home_bullpen_season, currentSeason
  );

  // RA total del juego
  const awayGameRa = blendGameRa(awayStarterRa, awayBpRa);
  const homeGameRa = blendGameRa(homeStarterRa, homeBpRa);

  // Ataque del equipo
  const awayAttack = estimateAttackPer9(g.away_team_avg_runs, g.away_team_games);
  const homeAttack = estimateAttackPer9(g.home_team_avg_runs, g.home_team_games);

  // Carreras esperadas por equipo
  const envMult = environmentMultiplier(
    g.park_factor_runs, g.altitude_m, g.temperature_2m, g.wind_tailwind
  );

  const inningMult = inningsScale(g);

  const awayRunsRaw = ((awayAttack + homeGameRa) / 2) * envMult * inningMult;
  const homeRunsRaw = ((homeAttack + awayGameRa) / 2) * envMult * inningMult;

  const awayMuPreLineup = Math.max(0.3, awayRunsRaw * RUN_CALIBRATION_FACTOR);
  const homeMuPreLineup = Math.max(0.3, homeRunsRaw * RUN_CALIBRATION_FACTOR);

  // Ajuste opcional por calidad de lineup real confirmado (Fase 2, 2026-07-04).
  // Si el watcher aun no detecto el lineup, g.lineup_factor_* es null y mu queda igual que antes.
  const lineupFactorAway = LINEUP_ADJUST_ENABLED && g.lineup_factor_away != null
    ? Math.max(0.90, Math.min(1.10, Number(g.lineup_factor_away))) : null;
  const lineupFactorHome = LINEUP_ADJUST_ENABLED && g.lineup_factor_home != null
    ? Math.max(0.90, Math.min(1.10, Number(g.lineup_factor_home))) : null;
  const awayMu = lineupFactorAway != null ? awayMuPreLineup * lineupFactorAway : awayMuPreLineup;
  const homeMu = lineupFactorHome != null ? homeMuPreLineup * lineupFactorHome : homeMuPreLineup;
  const totalMu = round2(awayMu + homeMu);

  // Distribuciones
  const awayDist = buildDist(awayMu, NB_K);
  const homeDist = buildDist(homeMu, NB_K);

  // P(away wins), P(home wins), P(tie)
  let pAwayWin = 0, pHomeWin = 0, pTie = 0;
  for (let a = 0; a <= GRID_MAX; a++) {
    for (let h = 0; h <= GRID_MAX; h++) {
      const p = awayDist[a] * homeDist[h];
      if (a > h) pAwayWin += p;
      else if (h > a) pHomeWin += p;
      else pTie += p;
    }
  }

  // Ajuste ML (empates asignados proporcionalmente en b�isbol no existe
  // como en f�tbol - en b�isbol siempre hay ganador en innings extra)
  // Repartimos el residuo de ties por probabilidad relativa
  const total = pAwayWin + pHomeWin + pTie;
  if (total < 0.99) { pAwayWin += pTie * 0.5; pHomeWin += pTie * 0.5; }
  else {
    const ratio = pAwayWin / (pAwayWin + pHomeWin);
    pAwayWin += pTie * ratio;
    pHomeWin += pTie * (1 - ratio);
  }

  // Probabilidades O/U para distintas l�neas
  function pOver(line) {
    let p = 0;
    for (let a = 0; a <= GRID_MAX; a++) {
      for (let h = 0; h <= GRID_MAX; h++) {
        if (a + h > line) p += awayDist[a] * homeDist[h];
      }
    }
    return p;
  }
  function pUnder(line) {
    let p = 0;
    for (let a = 0; a <= GRID_MAX; a++) {
      for (let h = 0; h <= GRID_MAX; h++) {
        if (a + h < line) p += awayDist[a] * homeDist[h];
      }
    }
    return p;
  }

  const dataScore = computeDataScore(g);

  // ?? Evaluar cuotas de mercado ??????????????????????????????????????????????

  const awayHcLineInput =
    input.away_hc_val ?? input.away_hc_line ?? g.away_hc_val ?? g.away_hc_line ?? null;
  const homeHcLineInput =
    input.home_hc_val ?? input.home_hc_line ?? g.home_hc_val ?? g.home_hc_line ?? null;
  const legacyHc = input.hc_value ?? g.hc_value ?? null;

  const lines = {
    away_ml: input.away_ml ?? g.away_ml ?? null,
    home_ml: input.home_ml ?? g.home_ml ?? null,
    away_hc_val: awayHcLineInput != null ? awayHcLineInput : legacyHc,
    home_hc_val: homeHcLineInput != null ? homeHcLineInput : (legacyHc != null ? -legacyHc : null),
    away_hc: input.away_hc_odds ?? input.away_hc ?? g.away_hc_odds ?? g.away_hc ?? null,
    home_hc: input.home_hc_odds ?? input.home_hc ?? g.home_hc_odds ?? g.home_hc ?? null,
    total_line: input.total_line ?? g.total_line ?? null,
    over_odds: input.over_odds ?? g.over_odds ?? null,
    under_odds: input.under_odds ?? g.under_odds ?? null,
  };

  const candidates = [];

  // ML
  const mlFair = computeFairPair(pAwayWin, pHomeWin);
  if (mlFair) {
    if (lines.away_ml != null) {
      const c = evalCandidate(mlFair.first, oddsToImplied(lines.away_ml),
        "ML", dataScore, lines.away_ml,
        { pick_side: "AWAY", away_team: g.away_team_name, home_team: g.home_team_name }
      );
      if (c) candidates.push(c);
    }
    if (lines.home_ml != null) {
      const c = evalCandidate(mlFair.second, oddsToImplied(lines.home_ml),
        "ML", dataScore, lines.home_ml,
        { pick_side: "HOME", away_team: g.away_team_name, home_team: g.home_team_name }
      );
      if (c) candidates.push(c);
    }
  }

  // HC (run line �1.5 en MLB)
  // Convenci�n: hc_value = lo que recibe el visitante en el mercado (+1.5 = dog, -1.5 = fav)
  const hasAwayHc = lines.away_hc != null && lines.away_hc_val != null;
  const hasHomeHc = lines.home_hc != null && lines.home_hc_val != null;
  if (hasAwayHc || hasHomeHc) {
    if (hasAwayHc) {
      const awayLine = lines.away_hc_val;
      let pAwayCover = 0;
      for (let a = 0; a <= GRID_MAX; a++) {
        for (let h = 0; h <= GRID_MAX; h++) {
          if (a + awayLine > h) pAwayCover += awayDist[a] * homeDist[h];
        }
      }
      const c = evalCandidate(pAwayCover, oddsToImplied(lines.away_hc),
        "HC", dataScore, lines.away_hc,
        { pick_side: `AWAY ${awayLine >= 0 ? "+" : ""}${awayLine}`, hc_value: awayLine,
          away_team: g.away_team_name, home_team: g.home_team_name }
      );
      if (c) candidates.push(c);
    }
    if (hasHomeHc) {
      const homeLine = lines.home_hc_val;
      let pHomeCover = 0;
      for (let a = 0; a <= GRID_MAX; a++) {
        for (let h = 0; h <= GRID_MAX; h++) {
          if (h + homeLine > a) pHomeCover += awayDist[a] * homeDist[h];
        }
      }
      const c = evalCandidate(pHomeCover, oddsToImplied(lines.home_hc),
        "HC", dataScore, lines.home_hc,
        { pick_side: `HOME ${homeLine >= 0 ? "+" : ""}${homeLine}`, hc_value: homeLine,
          away_team: g.away_team_name, home_team: g.home_team_name }
      );
      if (c) candidates.push(c);
    }
  }

  // O/U
  if (lines.total_line != null) {
    const line = lines.total_line;
    const poF = pOver(line), puF = pUnder(line);
    const ouFair = computeFairPair(poF, puF);

    if (ouFair && lines.over_odds != null) {
      const c = evalCandidate(ouFair.first, oddsToImplied(lines.over_odds),
        "OU", dataScore, lines.over_odds,
        { pick_side: `OVER ${line}`, total_line: line,
          away_team: g.away_team_name, home_team: g.home_team_name }
      );
      if (c) candidates.push(c);
    }
    if (ouFair && lines.under_odds != null) {
      const c = evalCandidate(ouFair.second, oddsToImplied(lines.under_odds),
        "OU", dataScore, lines.under_odds,
        { pick_side: `UNDER ${line}`, total_line: line,
          away_team: g.away_team_name, home_team: g.home_team_name }
      );
      if (c) candidates.push(c);
    }
  }

  const publicable_picks = candidates
    .filter(c => {
      if ((c?.edge ?? -999) < (c?.edge_threshold ?? marketEdgeThreshold(c?.market))) return false;
      // HC: requiere al menos 52% de probabilidad (igual que MiLB/LMB)
      if ((c?.market === "HC_AWAY" || c?.market === "HC_HOME") && (c?.prob_blended ?? 0) < 0.52) return false;
      return true;
    })
    .sort((a, b) => b.edge - a.edge);
  const best_pick = publicable_picks[0] ?? null;

  // Lean (direcci�n sin cuotas)
  const best_lean = {
    away_win_prob: round2(pAwayWin),
    home_win_prob: round2(pHomeWin),
    away_mu: round2(awayMu),
    home_mu: round2(homeMu),
    total_runs: totalMu,
    env_mult: round2(envMult),
    data_score: dataScore,
  };

  return {
    model_name: "MLB_QUANT_V1",
    data_score: dataScore,
    total_runs: totalMu,
    away_mu: round2(awayMu),
    home_mu: round2(homeMu),
    away_mu_pre_lineup: round2(awayMuPreLineup),
    home_mu_pre_lineup: round2(homeMuPreLineup),
    lineup_factor_away: lineupFactorAway,
    lineup_factor_home: lineupFactorHome,
    env_mult: round2(envMult),
    candidates,
    publicable_picks,
    best_pick,
    best_lean,
  };
}

module.exports = { analyzeMatchup };
