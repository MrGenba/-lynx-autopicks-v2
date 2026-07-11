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

  // El proxy es residencial y se paga por GB -- imagenes/fuentes/video son la parte mas pesada
  // de una pagina llena de anuncios como esta y no aportan nada (solo hace falta el texto y
  // poder clicar pestañas). Se deja "stylesheet" sin bloquear a proposito: isVisible() depende
  // del layout real calculado con CSS, bloquearlo rompe los clics en pestañas/lineas.
  const BLOCKED_TYPES = new Set(["image", "media", "font"]);
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (BLOCKED_TYPES.has(type)) return route.abort();
    return route.continue();
  });
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

// Filtro barato (no es el matching autoritativo -- eso lo hace Python con aliases.score()
// despues) para decidir si vale la pena perforar Totales/Handicap de un partido: cada
// perforacion son 2 clics + esperas de red (~10-20s cada una, mas aun pasando por un proxy
// residencial), y la mayoria de partidos de una liga no son ninguno de los que estamos
// esperando cuotas -- perforar solo los candidatos de verdad corta el tiempo total de
// scrapeo de "toda la liga x2 mercados" a "toda la liga x1 pagina + los pocos que hacen falta".
function normLoose(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function looseMatch(a, b) {
  const na = normLoose(a), nb = normLoose(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const wordsA = na.split(" ").filter((w) => w.length >= 4);
  return wordsA.some((w) => nb.includes(w));
}

function makeShouldDrill(candidateNames) {
  const names = (candidateNames || []).filter(Boolean);
  if (!names.length) return () => true; // sin lista -- comportamiento original (perforar todo)
  return (awayTeam, homeTeam) => names.some((n) => looseMatch(n, awayTeam) || looseMatch(n, homeTeam));
}

// Los slugs de las URLs de cuotasahora.com ya traen el nombre del equipo en texto legible
// (ej. ".../h2h/los-angeles-angels-Mg9H0Flh/texas-rangers-f3GcHO7j/...") -- se puede filtrar
// que partidos vale la pena VISITAR (no solo perforar) sin cargar ni una sola pagina de mas.
// Esto es lo que de verdad ahorra datos del proxy: MLB tiene 15+ partidos por dia y solo
// hacen falta 1-2, cargar la pagina completa de cada uno (aunque no se perfore nada) ya era
// suficiente para agotar el timeout de 300s.
function matchesUrlSlug(url, candidateNames) {
  const names = (candidateNames || []).filter(Boolean);
  if (!names.length) return true; // sin lista -- comportamiento original (visitar todo)
  const afterH2h = url.split("/baseball/h2h/")[1] || "";
  const slugText = afterH2h.replace(/[-/]/g, " ");
  return names.some((n) => looseMatch(n, slugText));
}

async function scrapeMatch(league, url, shouldDrill) {
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

    const game = {
      league, status: "scheduled", time: header.time,
      away_team: header.away_team, home_team: header.home_team,
      moneyline: { home: ml.odds1, away: ml.odds2 },
      bookmaker: ml.bookmaker,
    };

    if (shouldDrill(header.away_team, header.home_team)) {
      const total = await drillIntoMarket(page, "Más/Menos de", {});
      const hc = await drillIntoMarket(page, "Hándicap asiático", { preferAbs: 1.5 });
      if (total) game.total = { line: Math.abs(total.line), over_odds: total.odds1, under_odds: total.odds2 };
      if (hc) game.run_line = { home: { line: hc.line, odds: hc.odds1 }, away: { line: -hc.line, odds: hc.odds2 } };
    }
    return game;
  } catch (e) {
    return { league, error: String(e && e.message || e), url };
  } finally {
    await page.close().catch(() => {});
  }
}

// Diagnostico -- investigando en vivo 2026-07-11 el desfase de 1h en la hora que muestra
// cuotasahora.com. Dato clave que descarta la hipotesis de "depende del pais de salida de
// Tor": el mismo partido (Houston Astros @ Texas Rangers) mostro SIEMPRE "00:05" en varios
// scrapes distintos a lo largo de varias horas, con Tor eligiendo un pais de salida distinto
// al azar cada vez -- si dependiera de la IP, deberia variar. Nueva hipotesis: la pagina
// calcula la hora local con el reloj/timezone del propio NAVEGADOR (Intl.DateTimeFormat /
// Date del sistema), no con la IP -- y el contenedor podria estar en horario de invierno fijo
// (UTC+1, CET) en vez de verano (UTC+2, CEST en julio), lo que encajaria exacto con el desfase
// de 1h visto. browserTz comprueba esto directamente; exitGeo (ipapi.co) se mantiene como
// diagnostico secundario aunque a veces falle (Tor puede ser bloqueado por el propio ipapi.co).
async function getBrowserTimezone() {
  const page = await context.newPage();
  try {
    const info = await page.evaluate(() => ({
      resolvedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dateString: new Date().toString(),
      isoString: new Date().toISOString(),
      timezoneOffsetMin: new Date().getTimezoneOffset(),
    }));
    return info;
  } catch (e) {
    return { error: String(e && e.message || e) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function getExitGeo() {
  const page = await context.newPage();
  try {
    await page.goto("https://ipapi.co/json/", { waitUntil: "domcontentloaded", timeout: 15000 });
    const text = await page.innerText("body").catch(() => "");
    const data = JSON.parse(text);
    return { ip: data.ip, country: data.country_name, country_code: data.country_code, timezone: data.timezone, utc_offset: data.utc_offset };
  } catch (e) {
    return { error: String(e && e.message || e) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchLeagueOdds(league, candidateNames) {
  const paths = LEAGUE_PATHS[league];
  if (!paths) throw new Error("Liga desconocida: " + league);
  await ensureBrowser();
  const shouldDrill = makeShouldDrill(candidateNames);
  const exitGeo = await getExitGeo();
  const browserTz = await getBrowserTimezone();

  const games = [];
  const errors = [];
  for (const path of paths) {
    const page = await context.newPage();
    let matchLinks = [];
    try {
      await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(3000);
      await dismissOverlays(page);
      const allLinks = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a")).map((a) => a.href)
      );
      const rawH2hLinks = [...new Set(allLinks.filter((h) => h.includes("/baseball/h2h/")))];
      matchLinks = rawH2hLinks.filter((link) => matchesUrlSlug(link, candidateNames));
      // Diagnostico -- encontrado en vivo 2026-07-10: un scrape entero de MLB (sin filtro de
      // candidateNames) devolvio 0 partidos SIN ningun error (la pagina cargo bien, pero
      // querySelectorAll no encontro ni un enlace de partido). Sin esto no habia forma de saber
      // si fue un bloqueo/CAPTCHA del nodo de salida de Tor o un fallo real de extraccion. Se
      // mira rawH2hLinks (ANTES del filtro de candidateNames), no matchLinks -- 0 tras filtrar
      // por candidatos es el caso normal en el uso interno de Auto-Picks v2, no un fallo.
      if (rawH2hLinks.length === 0) {
        const title = await page.title().catch(() => "?");
        const bodySnippet = (await page.innerText("body").catch(() => "")).slice(0, 300);
        errors.push(`sin NINGUN enlace de partido en la pagina (title="${title}", totalLinksEnPagina=${allLinks.length}): ${bodySnippet}`);
      }
    } catch (e) {
      errors.push(String(e && e.message || e));
    } finally {
      await page.close().catch(() => {});
    }

    const results = await runWithConcurrency(matchLinks, CONCURRENCY, (link) => scrapeMatch(league, link, shouldDrill));
    for (const result of results) {
      if (!result) continue;
      if (result.error) errors.push(result.error);
      else games.push(result);
    }
  }

  return { league, games, errors, fetched_at: new Date().toISOString(), exit_geo: exitGeo, browser_timezone: browserTz };
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
