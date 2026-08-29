// Vendorizado desde D:\Milb\odds_bet365\scraper_cuotasahora.js (sha256 original:
// f61bcf7b7ae4d06d8ad5dd45d350d2f8d93657ad248109c11e3be673b25b56a1), con UN cambio respecto
// al original: ensureBrowser() lee PROXY_SERVER del entorno y lo pasa a chromium.launch() si
// esta presente -- el VPS de Francia donde corre este contenedor esta bloqueado por
// cuotasahora.com (confirmado 2026-07-08 con una peticion HTTP plana desde n8n, timeout), asi
// que hace falta salir por Tor (SOCKS local) para que el scraping funcione. Sin proxy
// configurado, se comporta exactamente igual que el original (mismo bloqueo esperado).
const { chromium } = require("patchright");
const { parseBookmakerRows, pickBookmaker, parseAggregateLines, pickMainLine, parseMatchHeader } = require("./parser_cuotasahora");

// 2026-07-18: se soporta pedir una casa distinta de bet365 (ej. Winamax) via el parametro
// "bookmaker" de fetchLeagueOdds() -- comandos separados en Telegram ("cuotas mlb bet365" vs
// "cuotas mlb winamax"), nunca mezclados ni con fallback entre ellas (ver pickBookmaker() en
// parser_cuotasahora.js, ya no sustituye la casa pedida por otra si no la encuentra).
const DEFAULT_BOOKMAKER = "bet365";

// 2026-08-16: timeouts de navegacion configurables. Al restringir ExitNodes a un pais concreto el
// pool de rutas se reduce mucho y la primera carga tarda mas -- eso, y no la idea en si, es lo que
// hizo fracasar los intentos con {es} (2026-07-11) y {mx} (2026-08-03). El comentario del
// docker-entrypoint ya recomendaba subir este timeout antes que renunciar a fijar el pais.
const GOTO_MATCH_MS = parseInt(process.env.GOTO_MATCH_MS || "30000", 10);
const GOTO_INDEX_MS = parseInt(process.env.GOTO_INDEX_MS || "45000", 10);

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
  return { server };  // Tor SOCKS local, sin auth
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

// Diagnostico 2026-07-17: en LMB, varios partidos con enlace real daban "no_header" (la pagina
// solo mostraba el menu de navegacion, sin contenido del partido) o "no_bookmaker_rows" (header
// si, pero 0 casas listadas) -- un sleep(3000) fijo tras domcontentloaded puede no bastar si el
// contenido (menos popular que MLB, quizas menos cacheado) tarda mas en pintarse via XHR/JS.
// Se espera a una senal real -- "OBTENER BONO" es el texto ancla que ya usa parseBookmakerRows
// para cada fila de casa de apuestas -- en vez de alargar a ciegas el sleep fijo. Si no aparece
// en el plazo, se sigue igual (puede que de verdad no haya ninguna casa con cuotas todavia para
// ese partido, eso lo decide luego parseBookmakerRows/mlRowsFound, no esta funcion).
async function waitForBookmakerRows(page, timeout = 15000) {
  // Subido de 6s a 15s el 2026-07-20: confirmado en vivo que un dia de Tor mas lento de lo
  // habitual (mismo sintoma "no_header" al 100% de los partidos, en MiLB Y LMB el mismo dia,
  // asi que no era falta de datos reales) necesitaba mas margen que el 6s original.
  await page.locator("text=OBTENER BONO").first().waitFor({ timeout }).catch(() => {});
}

// Hándicap/Totales muestran una lista agregada de líneas cuando el mercado tiene varias
// (hay que elegir la principal, ver pickMainLine, y clicarla) -- pero cuando solo hay UNA línea
// ofrecida, el sitio se salta la lista y muestra el desglose por casa directamente tras clicar
// la pestaña.
// 2026-08-16: esta funcion tenia SIETE `return null` distintos, todos indistinguibles desde
// fuera. Resultado: un partido se guardaba con ML y sin total, y en ningun sitio quedaba
// constancia de por que -- llevabamos dias viendo "a todos los partidos les falta el total" sin
// poder atacarlo, porque el fallo era invisible por construccion (mismo problema que tenia la
// espera en cola antes de separarla de la duracion del scrape).
// Ahora cada salida devuelve { __failed: motivo }. El motivo mas importante es
// `casa_ausente`, que ademas lista QUE casas si aparecian: es la unica forma de distinguir
// "Bet365 no publica este mercado" de "el scraper no encuentra la pestaña".
function drillFail(reason, extra) {
  return { __failed: extra ? reason + " (" + extra + ")" : reason };
}

// Localiza la pestaña de un mercado probando VARIAS etiquetas y VARIOS selectores.
// 2026-08-16: cuotasahora cambio las dos cosas a la vez y por eso Totales/Handicap llevaban
// semanas sin llegar (el ML no se entero: sale de la pagina principal, sin clicar nada).
//   - Las etiquetas pasaron de español a INGLES: "Más/Menos de" -> "Over/Under",
//     "Hándicap asiático" -> "Asian Handicap". Volcado real de la pagina:
//     [..., "1X2", "Home/Away", "Over/Under", "Asian Handicap", "Both Teams to Score", ...]
//   - Y el marcado tambien: `li.odds-item` ya no encuentra NADA (market_tabs volvio vacio).
// Se aceptan los nombres viejos ademas de los nuevos a proposito: el sitio mezcla idiomas segun
// la seccion (el bloque de casas seguia en español), asi que no hay garantia de que esto sea
// definitivo, y probar ambos no cuesta nada.
async function findMarketTab(page, labels) {
  for (const label of labels) {
    const porClase = page.locator('li.odds-item:has-text("' + label + '")').first();
    if (await porClase.isVisible({ timeout: 1500 }).catch(() => false)) return { el: porClase, label };
    // Respaldo sin depender de la clase CSS: el texto exacto sigue estando aunque cambie el DOM.
    const porTexto = page.getByText(label, { exact: true }).first();
    if (await porTexto.isVisible({ timeout: 1500 }).catch(() => false)) return { el: porTexto, label };
  }
  return null;
}

// Cabecera del bloque de casas: tambien cambio de "Casas de apuestas" a "Bookmakers". Se aceptan
// las dos -- de no hacerlo, arreglar solo la pestaña habria chocado con el siguiente return null.
const CABECERA_CASAS = ["Casas de apuestas", "Bookmakers"];

async function drillIntoMarket(page, tabLabels, opts, bookmaker) {
  const etiquetas = Array.isArray(tabLabels) ? tabLabels : [tabLabels];
  const encontrada = await findMarketTab(page, etiquetas);
  if (!encontrada) return drillFail("pestaña_no_visible", etiquetas.join(" / "));
  const tabLabel = encontrada.label;
  await encontrada.el.click({ force: true, timeout: 8000 });
  await sleep(2500);
  await dismissOverlays(page);

  let lines = await getLines(page);
  const tabIdx = lines.findIndex((l) => l === tabLabel);
  if (tabIdx === -1) return drillFail("etiqueta_no_en_texto", tabLabel);

  const agg = parseAggregateLines(lines, tabLabel, tabIdx, lines.length);
  if (agg.length) {
    const main = pickMainLine(agg, opts);
    if (!main) return drillFail("sin_linea_principal", agg.length + " lineas ofrecidas");
    const lineText = tabLabel + " " + (main.line > 0 ? "+" : "") + main.line;
    const lineEl = page.locator("text=" + lineText).first();
    if (!(await lineEl.isVisible({ timeout: 2000 }).catch(() => false))) return drillFail("linea_no_clicable", lineText);
    await lineEl.click({ force: true, timeout: 8000 });
    await sleep(2500);
    await dismissOverlays(page);
    lines = await getLines(page);
  }

  const drillIdx = lines.findIndex((l) => CABECERA_CASAS.includes(l));
  if (drillIdx === -1) return drillFail("sin_bloque_casas", "ni " + CABECERA_CASAS.join(" ni "));
  const rows = parseBookmakerRows(lines, drillIdx, Math.min(lines.length, drillIdx + 60));
  const picked = pickBookmaker(rows, bookmaker);
  if (!picked) {
    // El dato decisivo: si Bet365 no esta pero SI hay otras casas, el scraper funciona y es
    // cuotasahora quien no ofrece esa casa en ese mercado. Se listan para poder afirmarlo.
    return drillFail("casa_ausente", bookmaker + " no esta entre " + rows.length + ": " +
      rows.map((r) => r.bookmaker).slice(0, 8).join("/"));
  }
  if (picked.line == null) return drillFail("casa_sin_linea", picked.bookmaker);
  // 2026-08-29: incidente real -- un LMB con solo UNA linea ofrecida (camino rapido de arriba,
  // que se salta pickMainLine/preferAbs por completo) devolvio hc_value=0 (pick'em, no el run
  // line +-1.5 esperado) y total_line=1.5 (absurdo para beisbol) sin que nada lo marcara como
  // fallo -- son numeros sintacticamente validos, el regex los parsea bien, pero no tienen
  // sentido para el deporte. Se publico un pick real con edge 123% sobre ese dato. Este check
  // aplica DESPUES de picked.line, asi que cubre tanto el camino con lista agregada como el de
  // linea unica -- antes preferAbs solo protegia al primero.
  if (opts.validateLine && !opts.validateLine(picked.line)) {
    return drillFail("linea_no_plausible", "valor=" + picked.line);
  }
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

async function scrapeMatch(league, url, shouldDrill, bookmaker) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_MATCH_MS });
    await sleep(1500);
    await dismissOverlays(page);
    // 2026-07-26: espera de contenido MAYOR para MiLB/LMB. Sus páginas están menos cacheadas en
    // cuotasahora y tardan más en pintar las cuotas via XHR -> con Tor lento superaban los 15s y
    // devolvían no_header al 100%. MLB (más popular/cacheada) sigue con 15s (waitFor sale en
    // cuanto aparece el contenido, así que el margen extra solo se usa cuando de verdad tarda).
    await waitForBookmakerRows(page, league === "LMB" ? 40000 : (league === "MiLB" ? 30000 : 15000));

    let lines = await getLines(page);
    const header = parseMatchHeader(lines);
    // Diagnostico 2026-07-17 -- investigando por que MiLB/LMB devuelven games=[] sin errores
    // pese a haber partidos reales: antes esto era "return null" silencioso en los 3 casos
    // (sin cabecera, en vivo, sin fila de bet365), indistinguible de "url no era un partido de
    // verdad". Ahora se marca el motivo (__skipped) para poder verlo en errors[] igual que ya
    // se hacia con "sin ningun enlace de partido en la pagina".
    if (!header) return { __skipped: "no_header", url, linesSample: lines.slice(0, 12) };
    if (header.isLive) return { __skipped: "is_live", url, home: header.home_team, away: header.away_team };

    const mlRows = parseBookmakerRows(lines, header.tabIdx, Math.min(lines.length, header.tabIdx + 80));
    const ml = pickBookmaker(mlRows, bookmaker);
    if (!ml) {
      const casas = mlRows.map((r) => r.bookmaker);
      // 2026-08-16: distinguir "catalogo del pais equivocado" de "no hay casas". cuotasahora
      // geolocaliza por IP de salida: desde Alemania la casa se llama "Bet365.de" -- la cuota
      // ESTA ahi, solo que bajo otro nombre, y ademas ese catalogo ofrece menos mercados (por eso
      // el total no llegaba nunca). Es un fallo con remedio concreto: rotar circuito y reintentar
      // hasta caer en un pais de catalogo internacional. Se marca aparte para que Python pueda
      // tratarlo asi en vez de confundirlo con un partido sin cuotas.
      const variante = casas.find((c) => c.toLowerCase().startsWith(bookmaker.toLowerCase() + "."));
      const base = { url, home: header.home_team, away: header.away_team,
                     mlRowsFound: mlRows.length, bookmakersFound: casas.slice(0, 8) };
      if (variante) return { __skipped: "wrong_catalog", variant: variante, ...base };
      return { __skipped: "no_bookmaker_rows", ...base };
    }

    const game = {
      league, status: "scheduled", time: header.time,
      away_team: header.away_team, home_team: header.home_team,
      moneyline: { home: ml.odds1, away: ml.odds2 },
      bookmaker: ml.bookmaker,
    };

    if (shouldDrill(header.away_team, header.home_team)) {
      // Rangos plausibles para beisbol -- ver comentario del incidente 2026-08-29 en
      // drillIntoMarket(). Total: 3.5-15.5 carreras. Hándicap: siempre acaba en .5 (run line,
      // nunca empate), abs entre 0.5 y 3.5 -- rechaza el "+0" (pick'em) que causó el incidente.
      const total = await drillIntoMarket(page, ["Over/Under", "Más/Menos de"],
        { validateLine: (l) => l >= 3.5 && l <= 15.5 }, bookmaker);
      const hc = await drillIntoMarket(page, ["Asian Handicap", "Hándicap asiático"],
        { preferAbs: 1.5, validateLine: (l) => Math.abs(l) >= 0.5 && Math.abs(l) <= 3.5 && Math.abs(l % 1) === 0.5 },
        bookmaker);
      // drill_notes viaja con el partido para que "tiene ML pero no total" deje de ser un
      // agujero mudo: ahora dice cual de los siete motivos fue.
      const notes = [];
      if (total && !total.__failed) game.total = { line: Math.abs(total.line), over_odds: total.odds1, under_odds: total.odds2 };
      else notes.push("total: " + ((total && total.__failed) || "sin_resultado"));
      if (hc && !hc.__failed) game.run_line = { home: { line: hc.line, odds: hc.odds1 }, away: { line: -hc.line, odds: hc.odds2 } };
      else notes.push("handicap: " + ((hc && hc.__failed) || "sin_resultado"));
      if (notes.length) game.drill_notes = notes;

      // 2026-08-16: si alguna perforacion fallo por "pestaña_no_visible", volcar QUE pestañas hay
      // realmente. El scraper busca el texto exacto "Más/Menos de" / "Hándicap asiático"; si
      // cuotasahora las renombro o cambio el marcado, el ML sigue funcionando (sale de la pagina
      // principal) pero Totales y Handicap dejan de llegar SIEMPRE -- que es exactamente el
      // sintoma. Dos vertientes, y hay que distinguirlas:
      //   market_tabs vacio   -> el selector li.odds-item ya no encuentra las pestañas (marcado)
      //   market_tabs con otros nombres -> solo hay que apuntar al texto nuevo
      if (notes.some((n) => n.includes("pestaña_no_visible"))) {
        game.market_tabs = await page.locator("li.odds-item").allInnerTexts()
          .then((t) => t.map((x) => String(x).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 25))
          .catch(() => null);
        // Respaldo por si el selector es el que cambio: el texto crudo alrededor de la zona de
        // mercados enseña los nombres aunque la clase CSS ya no sea li.odds-item.
        game.lines_around_tabs = lines.slice(Math.max(0, header.tabIdx - 4), header.tabIdx + 26);
      }
    } else {
      // Tambien se anota: un shouldDrill en falso explica por si solo un partido sin total, y
      // hasta ahora era indistinguible de un fallo de perforacion.
      game.drill_notes = ["no perforado (shouldDrill=false para " + header.away_team + " @ " + header.home_team + ")"];
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

async function fetchLeagueOdds(league, candidateNames, bookmaker) {
  bookmaker = bookmaker || DEFAULT_BOOKMAKER;
  const paths = LEAGUE_PATHS[league];
  if (!paths) throw new Error("Liga desconocida: " + league);
  await ensureBrowser();
  const shouldDrill = makeShouldDrill(candidateNames);
  const exitGeo = await getExitGeo();
  const browserTz = await getBrowserTimezone();

  const games = [];
  const errors = [];
  // Variantes de la casa pedida encontradas bajo nombre de otro pais (ej. "Bet365.de"). Se
  // acumula a nivel de LIGA porque `results` es local a cada path (MiLB tiene dos).
  const wrongCatalogVariants = new Set();
  const debugCounts = [];
  for (const path of paths) {
    let matchLinks = [];
    // Reintento 2026-07-17: un timeout de 30s navegando a la pagina de calendario (visto en
    // vivo para International League) puede ser solo lentitud puntual del circuito Tor, no un
    // bloqueo real -- un segundo intento con un circuito ya "caliente" (mismo browser/context,
    // TCP/TLS de Tor ya establecido) es barato y evita perder la liga entera por una sola
    // navegacion lenta.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const page = await context.newPage();
      try {
        await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: GOTO_INDEX_MS });
        await sleep(1500);
        await dismissOverlays(page);
        // Diagnostico 2026-07-17: PCL devolvia 0 enlaces /baseball/h2h/ con la pagina cargada
        // (title correcto, 108 links totales) -- posible lista de partidos pintada via XHR
        // despues de domcontentloaded. Se espera a que aparezca al menos un enlace real antes
        // de leerlos, en vez de fiarse de un sleep fijo. Subido de 6s a 15s el 2026-07-20 (ver
        // waitForBookmakerRows) por el mismo motivo: un dia de Tor lento necesita mas margen.
        // 2026-08-03: espera de enlaces league-aware. LMB/MiLB estan menos cacheadas y su lista de
        // partidos (pintada via XHR) tarda mas en aparecer con Tor lento -> 15s daba "sin NINGUN
        // enlace" en LMB. Se sube a 30s para esas dos; MLB (mas cacheada) sigue en 15s. La espera
        // sale en cuanto aparece el 1er enlace, asi que el margen extra solo se gasta si de verdad tarda.
        const linkWait = (league === "MiLB" || league === "LMB") ? 30000 : 15000;
        await page.locator('a[href*="/baseball/h2h/"]').first().waitFor({ timeout: linkWait }).catch(() => {});
        const allLinks = await page.evaluate(() =>
          Array.from(document.querySelectorAll("a")).map((a) => a.href)
        );
        const rawH2hLinks = [...new Set(allLinks.filter((h) => h.includes("/baseball/h2h/")))];
        matchLinks = rawH2hLinks.filter((link) => matchesUrlSlug(link, candidateNames));
        debugCounts.push({ path, attempt, totalLinks: allLinks.length, rawH2hLinks: rawH2hLinks.length, matchLinks: matchLinks.length });
        // 2026-08-03: si NO aparecio ningun enlace de partido y aun queda intento, reintentar (la
        // lista XHR puede no haberse pintado todavia) en vez de darla por vacia -- antes solo se
        // reintentaba ante excepcion, asi que un "0 enlaces" transitorio (tipico en LMB) se perdia.
        if (rawH2hLinks.length === 0 && attempt < 2) {
          continue;  // el finally cierra esta page; se reintenta con una nueva
        }
        // Diagnostico -- encontrado en vivo 2026-07-10: un scrape entero de MLB (sin filtro de
        // candidateNames) devolvio 0 partidos SIN ningun error (la pagina cargo bien, pero
        // querySelectorAll no encontro ni un enlace de partido). Sin esto no habia forma de saber
        // si fue un bloqueo/CAPTCHA del nodo de salida de Tor o un fallo real de extraccion. Se
        // mira rawH2hLinks (ANTES del filtro de candidateNames), no matchLinks -- 0 tras filtrar
        // por candidatos es el caso normal en el uso interno de Auto-Picks v2, no un fallo.
        if (rawH2hLinks.length === 0) {
          const title = await page.title().catch(() => "?");
          const bodySnippet = (await page.innerText("body").catch(() => "")).slice(0, 300);
          errors.push(`sin NINGUN enlace de partido en la pagina (${path}, title="${title}", totalLinksEnPagina=${allLinks.length}): ${bodySnippet}`);
        }
        break; // exito (con o sin enlaces) -- no reintentar
      } catch (e) {
        if (attempt === 2) errors.push(`${path}: ${String(e && e.message || e)}`);
      } finally {
        await page.close().catch(() => {});
      }
    }

    const results = await runWithConcurrency(matchLinks, CONCURRENCY, (link) => scrapeMatch(league, link, shouldDrill, bookmaker));
    for (const result of results) {
      if (!result) continue;
      if (result.error) { errors.push(result.error); continue; }
      if (result.__skipped) {
        if (result.__skipped === "wrong_catalog" && result.variant) wrongCatalogVariants.add(result.variant);
        const who = result.away && result.home ? ` ${result.away} @ ${result.home}` : "";
        errors.push(`descartado (${result.__skipped})${who} url=${result.url}`
          + (result.mlRowsFound != null ? ` mlRowsFound=${result.mlRowsFound}` : "")
          + (result.bookmakersFound ? ` casas=${JSON.stringify(result.bookmakersFound)}` : "")
          + (result.linesSample ? ` linesSample=${JSON.stringify(result.linesSample)}` : ""));
        continue;
      }
      games.push(result);
    }
  }

  // Señal estructurada (no parsear cadenas de error desde Python): al menos un partido tenia la
  // casa pedida pero bajo el nombre de otro pais -> el circuito actual cae en un catalogo que no
  // sirve, y rotar tiene sentido.
  return { league, bookmaker, games, errors, wrong_catalog: wrongCatalogVariants.size > 0,
    wrong_catalog_variants: [...wrongCatalogVariants],
    fetched_at: new Date().toISOString(), exit_geo: exitGeo, browser_timezone: browserTz, debug_counts: debugCounts };
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
