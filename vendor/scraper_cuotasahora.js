// Vendorizado desde D:\Milb\odds_bet365\scraper_cuotasahora.js (sha256 original:
// f61bcf7b7ae4d06d8ad5dd45d350d2f8d93657ad248109c11e3be673b25b56a1), con UN cambio respecto
// al original: ensureBrowser() lee PROXY_SERVER/PROXY_USERNAME/PROXY_PASSWORD del entorno y
// los pasa a chromium.launch() si estan presentes -- el VPS de Francia donde corre este
// contenedor esta bloqueado por cuotasahora.com (confirmado 2026-07-08 con una peticion HTTP
// plana desde n8n, timeout), asi que hace falta salir por una IP residencial distinta (proxy
// IPRoyal, pais ES) para que el scraping funcione en absoluto. Sin proxy configurado, se
// comporta exactamente igual que el original (mismo bloqueo esperado).
const { chromium } = require("patchright");
const { parseBookmakerRows, pickBookmaker, parseAggregateLines, pickMainLine, parseMatchHeader } = require("./parser_cuotasahora");

const PREFERRED_BOOKMAKER = "bet365";

// El MiLB AAA real se reparte en dos ligas (International League / Pacific Coast League) --
// hay que combinar ambas para tener cobertura completa, a diferencia de bet365 donde era una
// sola competición por liga.
const LEAGUE_PATHS = {
  MLB: ["baseball/usa/mlb/"],
  MiLB: ["baseball/usa/il/", "baseball/usa/pcl/"],
  LMB: ["baseball/mexico/lmb/"],
};

const BASE = "https://www.cuotasahora.com/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let browser = null;
let context = null;
let cookiesAccepted = false;

function proxyFromEnv() {
  const server = process.env.PROXY_SERVER;
  if (!server) return undefined;
  const proxy = { server };
  if (process.env.PROXY_USERNAME) proxy.username = process.env.PROXY_USERNAME;
  if (process.env.PROXY_PASSWORD) proxy.password = process.env.PROXY_PASSWORD;
  return proxy;
}

async function ensureBrowser() {
  if (browser && browser.isConnected()) return;
  browser = await chromium.launch({
    headless: true, channel: "chrome",
    proxy: proxyFromEnv(),
    args: [
      "--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage",
      "--disable-extensions", "--disable-background-networking", "--disable-sync",
      "--disable-translate", "--disable-default-apps", "--mute-audio", "--no-first-run",
      "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints",
      "--js-flags=--max-old-space-size=256",
      "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    ],
  });
  context = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 1000 }, locale: "en-US" });
}

// El banner de cookies (OneTrust) solo aparece la primera vez en el contexto -- comprobarlo
// en cada página añade hasta 1.5s de espera muerta por partido sin necesidad (~40 partidos en
// una liga grande = más de un minuto perdido solo en esto).
async function dismissOverlays(page) {
  if (!cookiesAccepted) {
    try {
      const btn = page.locator("#onetrust-accept-btn-handler");
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) { await btn.click({ force: true }); await sleep(500); }
      cookiesAccepted = true;
    } catch (_) {}
  }
  await page.evaluate(() => document.querySelectorAll(".overlay-bookie-modal").forEach((el) => el.remove())).catch(() => {});
}

async function getLines(page) {
  const body = await page.innerText("body").catch(() => "");
  return body.split("\n").map((l) => l.trim()).filter(Boolean);
}

// Hándicap/Totales muestran una lista agregada de líneas cuando el mercado tiene varias
// (hay que elegir la principal, ver pickMainLine, y clicarla) -- pero cuando solo hay UNA línea
// ofrecida, el sitio se salta la lista y muestra el desglose por casa directamente tras clicar
// la pestaña.
async function drillIntoMarket(page, tabLabel, opts) {
  const tabLi = page.locator('li.odds-item:has-text("' + tabLabel + '")').first();
  if (!(await tabLi.isVisible({ timeout: 2000 }).catch(() => false))) return null;
  await tabLi.click({ force: true, timeout: 8000 });
  await sleep(2500);
  await dismissOverlays(page);

  let lines = await getLines(page);
  const tabIdx = lines.findIndex((l) => l === tabLabel);
  if (tabIdx === -1) return null;

  const agg = parseAggregateLines(lines, tabLabel, tabIdx, lines.length);
  if (agg.length) {
    const main = pickMainLine(agg, opts);
    if (!main) return null;
    const lineText = tabLabel + " " + (main.line > 0 ? "+" : "") + main.line;
    const lineEl = page.locator("text=" + lineText).first();
    if (!(await lineEl.isVisible({ timeout: 2000 }).catch(() => false))) return null;
    await lineEl.click({ force: true, timeout: 8000 });
    await sleep(2500);
    await dismissOverlays(page);
    lines = await getLines(page);
  }

  const drillIdx = lines.findIndex((l) => l === "Casas de apuestas");
  if (drillIdx === -1) return null;
  const rows = parseBookmakerRows(lines, drillIdx, Math.min(lines.length, drillIdx + 60));
  const picked = pickBookmaker(rows, PREFERRED_BOOKMAKER);
  if (!picked || picked.line == null) return null;
  return { line: picked.line, odds1: picked.odds1, odds2: picked.odds2, bookmaker: picked.bookmaker };
}

async function scrapeMatch(league, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(3000);
    await dismissOverlays(page);

    let lines = await getLines(page);
    const header = parseMatchHeader(lines);
    if (!header || header.isLive) return null;

    const mlRows = parseBookmakerRows(lines, header.tabIdx, Math.min(lines.length, header.tabIdx + 80));
    const ml = pickBookmaker(mlRows, PREFERRED_BOOKMAKER);
    if (!ml) return null;

    const total = await drillIntoMarket(page, "Más/Menos de", {});
    const hc = await drillIntoMarket(page, "Hándicap asiático", { preferAbs: 1.5 });

    const game = {
      league, status: "scheduled", time: header.time,
      away_team: header.away_team, home_team: header.home_team,
      moneyline: { home: ml.odds1, away: ml.odds2 },
      bookmaker: ml.bookmaker,
    };
    if (total) game.total = { line: Math.abs(total.line), over_odds: total.odds1, under_odds: total.odds2 };
    if (hc) game.run_line = { home: { line: hc.line, odds: hc.odds1 }, away: { line: -hc.line, odds: hc.odds2 } };
    return game;
  } catch (e) {
    return { league, error: String(e && e.message || e), url };
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchLeagueOdds(league) {
  const paths = LEAGUE_PATHS[league];
  if (!paths) throw new Error("Liga desconocida: " + league);
  await ensureBrowser();

  const games = [];
  const errors = [];
  for (const path of paths) {
    const page = await context.newPage();
    let matchLinks = [];
    try {
      await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(3000);
      await dismissOverlays(page);
      matchLinks = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a")).map((a) => a.href).filter((h) => h.includes("/baseball/h2h/"))
      );
      matchLinks = [...new Set(matchLinks)];
    } catch (e) {
      errors.push(String(e && e.message || e));
    } finally {
      await page.close().catch(() => {});
    }

    const results = await runWithConcurrency(matchLinks, CONCURRENCY, (link) => scrapeMatch(league, link));
    for (const result of results) {
      if (!result) continue;
      if (result.error) errors.push(result.error);
      else games.push(result);
    }
  }

  return { league, games, errors, fetched_at: new Date().toISOString() };
}

// Concurrencia baja a proposito -- este contenedor no es una maquina potente y comparte
// recursos con el resto del stack (Postgres, deteccion cada 180s, etc).
const CONCURRENCY = 1;

async function runWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function shutdown() {
  if (browser) await browser.close().catch(() => {});
  browser = null; context = null; cookiesAccepted = false;
}

module.exports = { fetchLeagueOdds, LEAGUE_PATHS, shutdown };
