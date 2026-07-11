"""Comandos de admin: /status (partidos de hoy + estado), /pending (confirmados sin cuotas),
/picks (picks de hoy), /tick (fuerza un ciclo del detector ahora mismo, para depurar sin
acceso a logs del contenedor), /clock (reloj real del contenedor, para descartar desfase)."""
import datetime as dt
import html
import logging
import traceback

from app.pipelines import PipelineContext, LEAGUE_LABEL

logger = logging.getLogger(__name__)


async def cmd_clock(ctx: PipelineContext) -> None:
    """Compara el reloj del contenedor (usado por el detector para el filtro de 3h) contra
    now() de Postgres -- si difieren de forma notable, hay desfase de reloj real."""
    now_py = dt.datetime.now(dt.timezone.utc)
    async with ctx.pool.acquire() as conn:
        now_pg = await conn.fetchval("SELECT now()")
    diff = (now_py - now_pg).total_seconds()
    await ctx.telegram.send_message(
        ctx.admin_chat_id,
        f"🕐 Reloj contenedor (Python, UTC): {now_py.isoformat()}\n"
        f"🕐 Reloj Postgres (now()): {now_pg.isoformat()}\n"
        f"Diferencia: {diff:.1f}s",
    )


def _esc(s: str) -> str:
    return html.escape(str(s), quote=False)


async def cmd_status(ctx: PipelineContext) -> None:
    async with ctx.pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT g.sport_id, g.game_pk, g.away_team_name, g.home_team_name, g.status,
                   g.pitchers_confirmed_at IS NOT NULL AS gate_a,
                   g.lineup_confirmed_at IS NOT NULL AS gate_b,
                   o.game_pk IS NOT NULL AS has_odds,
                   (SELECT count(*) FROM pipeline_runs p WHERE p.sport_id = g.sport_id AND p.game_pk = g.game_pk AND p.published) AS picks_publicados
            FROM games_gate_state g
            LEFT JOIN game_odds o ON o.sport_id = g.sport_id AND o.game_pk = g.game_pk
            WHERE g.game_datetime_utc > now() - interval '5 hours'
              AND g.game_datetime_utc < now() + interval '18 hours'
            ORDER BY g.sport_id, g.game_datetime_utc
            """
        )
    if not rows:
        await ctx.telegram.send_message(ctx.admin_chat_id, "📅 Sin partidos descubiertos hoy todavía.")
        return

    by_league: dict[int, list] = {}
    for r in rows:
        by_league.setdefault(r["sport_id"], []).append(r)

    blocks = [f"📅 <b>Estado de hoy</b> — {len(rows)} partido(s)"]
    for sport_id, games in by_league.items():
        blocks.append(f"\n⚾ <b>{_esc(LEAGUE_LABEL.get(sport_id, sport_id))}</b> ({len(games)})")
        for r in games:
            gate_a, gate_b, has_odds = r["gate_a"], r["gate_b"], r["has_odds"]
            if r["picks_publicados"]:
                dot = "🏆"
            elif gate_a and gate_b and has_odds:
                dot = "🟢"
            elif gate_a or gate_b:
                dot = "🟡"
            else:
                dot = "⚪"
            gates = ("Abridores✅" if gate_a else "Abridores⏳") + "  " + ("Lineup✅" if gate_b else "Lineup⏳")
            odds_txt = "Cuotas✅" if has_odds else "Cuotas❌"
            picks_txt = f"🏆 {r['picks_publicados']} pick(s)" if r["picks_publicados"] else "sin picks"
            blocks.append(
                f"{dot} <b>{_esc(r['away_team_name'])}</b> @ <b>{_esc(r['home_team_name'])}</b>\n"
                f"   {gates}  ·  {odds_txt}  ·  {picks_txt}"
            )

    await ctx.telegram.send_message(ctx.admin_chat_id, "\n".join(blocks), parse_mode="HTML")


async def cmd_pending(ctx: PipelineContext) -> None:
    async with ctx.pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT g.sport_id, g.away_team_name, g.home_team_name, g.pitchers_confirmed_at, g.lineup_confirmed_at
            FROM games_gate_state g
            LEFT JOIN game_odds o ON o.sport_id = g.sport_id AND o.game_pk = g.game_pk
            WHERE g.game_datetime_utc > now() - interval '5 hours'
              AND g.game_datetime_utc < now() + interval '18 hours'
              AND o.game_pk IS NULL
              AND (g.pitchers_confirmed_at IS NOT NULL OR g.lineup_confirmed_at IS NOT NULL)
            ORDER BY g.game_datetime_utc
            """
        )
    if not rows:
        await ctx.telegram.send_message(ctx.admin_chat_id, "Nada pendiente de cuotas ahora mismo.")
        return
    lines = ["📋 Confirmados sin cuotas:"]
    for r in rows:
        gate = "lineup completo" if r["lineup_confirmed_at"] else "abridores"
        lines.append(f"[{LEAGUE_LABEL.get(r['sport_id'], r['sport_id'])}] {r['away_team_name']} @ {r['home_team_name']} ({gate})")
    await ctx.telegram.send_message(ctx.admin_chat_id, "\n".join(lines))


async def cmd_picks(ctx: PipelineContext) -> None:
    async with ctx.pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT p.sport_id, p.game_pk, p.pipeline, p.best_pick, p.published_at
            FROM pipeline_runs p
            WHERE p.published AND p.published_at::date = current_date
            ORDER BY p.published_at
            """
        )
    if not rows:
        await ctx.telegram.send_message(ctx.admin_chat_id, "Sin picks publicados hoy todavía.")
        return
    lines = ["🎯 Picks de hoy:"]
    for r in rows:
        pick = r["best_pick"]
        lines.append(f"[{LEAGUE_LABEL.get(r['sport_id'], r['sport_id'])}] game_pk={r['game_pk']} pipeline={r['pipeline']}: {pick}")
    await ctx.telegram.send_message(ctx.admin_chat_id, "\n".join(lines))


async def cmd_tick(ctx: PipelineContext) -> None:
    """Fuerza un ciclo del detector ahora mismo y reporta el resultado (o el error exacto)
    por Telegram -- sin acceso a logs del contenedor, este es el unico canal para depurar
    en vivo por que no se descubren partidos."""
    from app.detector import detector_tick  # import diferido: evita import circular en frio

    await ctx.telegram.send_message(ctx.admin_chat_id, "⏳ Ejecutando ciclo del detector...")
    try:
        await detector_tick(ctx)
    except Exception as e:
        tb = traceback.format_exc()
        logger.exception("cmd_tick fallo")
        await ctx.telegram.send_message(ctx.admin_chat_id, f"❌ El detector lanzo una excepcion:\n{str(e)[:300]}\n\n{tb[-800:]}")
        return

    async with ctx.pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT sport_id, count(*) as n FROM games_gate_state
            WHERE game_datetime_utc > now() - interval '5 hours'
              AND game_datetime_utc < now() + interval '18 hours'
            GROUP BY sport_id
            """
        )
    if not rows:
        await ctx.telegram.send_message(ctx.admin_chat_id, "✅ Ciclo terminado sin excepciones, pero 0 partidos vigentes (-5h/+18h) en ninguna liga ahora mismo.")
        return
    lines = ["✅ Ciclo terminado:"]
    for r in rows:
        lines.append(f"[{LEAGUE_LABEL.get(r['sport_id'], r['sport_id'])}] {r['n']} partido(s) descubiertos")
    await ctx.telegram.send_message(ctx.admin_chat_id, "\n".join(lines))


async def cmd_fetchodds(ctx: PipelineContext) -> None:
    """Fuerza un ciclo de scraping automatico de cuotas ahora mismo (normalmente corre solo
    cada ODDS_AUTOFETCH_INTERVAL_SECONDS) -- util para probar el proxy/scraper sin esperar."""
    from app.odds_autofetch import autofetch_tick  # import diferido, mismo motivo que cmd_tick

    await ctx.telegram.send_message(ctx.admin_chat_id, "⏳ Buscando cuotas automáticamente (cuotasahora.com)...")
    try:
        await autofetch_tick(ctx)
    except Exception as e:
        tb = traceback.format_exc()
        logger.exception("cmd_fetchodds fallo")
        await ctx.telegram.send_message(ctx.admin_chat_id, f"❌ El autofetch lanzo una excepcion:\n{str(e)[:300]}\n\n{tb[-800:]}")
        return
    await ctx.telegram.send_message(ctx.admin_chat_id, "✅ Ciclo de autofetch terminado (ver /status para el detalle).")
