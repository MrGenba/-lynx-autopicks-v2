"""Cliente minimo de Supabase REST -- de LECTURA para las vistas enriquecidas de produccion
(vw_mlb_matchups_ready, lineup_watch, etc). Desde 2026-07-11, con aprobacion explicita del
usuario, tambien de ESCRITURA hacia *_candidates_history (mlb_candidates_history/
candidates_history/lmb_candidates_history), para que los candidatos evaluados por Auto-Picks v2
entren en el mismo pool de datos de calibracion que produccion (marcados con source='autopicks_v2'
para poder distinguirlos). Desde 2026-07-25, tambien hacia *_picks_history (mlb_picks_history/
picks_history/lmb_picks_history) para el pick PUBLICADO: hasta esa fecha Auto-Picks v2 publicaba
el pick en el canal pero NO lo escribia en la tabla de picks, dejando ~29% de picks publicados
huerfanos (sin aparecer en el dashboard ni resolverse). No escribe en ninguna otra tabla de
produccion (mlb_games, etc).

Desde 2026-09-16, tambien hacia *_candidates_lineup (mlb_candidates_lineup/candidates_lineup/
lmb_candidates_lineup): los candidatos de PIPELINE 2 (lineup confirmado). Van a tabla APARTE
porque la base tiene UNIQUE(game_id, market, pick_side) -- el INSERT de pipeline 2 chocaba con el
indice, PostgREST devolvia 409 y el try/except lo enterraba, tirando ~500 evaluaciones con lineup
en silencio. Ver deploy_candidates_lineup.js para por que no se mezclan."""
import httpx


class SupabaseClient:
    def __init__(self, base_url: str, key: str):
        self.base_url = base_url.rstrip("/")
        self.headers = {"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"}

    async def select(self, client: httpx.AsyncClient, table_or_view: str, params: dict) -> list[dict]:
        resp = await client.get(f"{self.base_url}/rest/v1/{table_or_view}", headers=self.headers, params=params, timeout=15.0)
        resp.raise_for_status()
        return resp.json()

    async def select_one(self, client: httpx.AsyncClient, table_or_view: str, params: dict) -> dict | None:
        rows = await self.select(client, table_or_view, {**params, "limit": "1"})
        return rows[0] if rows else None

    async def insert(self, client: httpx.AsyncClient, table: str, rows: list[dict]) -> None:
        if not rows:
            return
        resp = await client.post(
            f"{self.base_url}/rest/v1/{table}",
            headers={**self.headers, "Content-Type": "application/json", "Prefer": "return=minimal"},
            json=rows, timeout=15.0,
        )
        resp.raise_for_status()

    async def upsert(self, client: httpx.AsyncClient, table: str, rows: list[dict], on_conflict: str) -> None:
        """INSERT que actualiza en vez de chocar. `on_conflict` son las columnas del indice unico.

        OJO: `Prefer: resolution=merge-duplicates` NO BASTA -- sin `?on_conflict=` en la URL,
        PostgREST no sabe contra que restriccion resolver y devuelve 409 en vez de actualizar. Es
        el mismo fallo que ya mordio en app/odds_snapshots.py y en el nodo predictions_log de MLB,
        donde estuvo dos meses dandose por bueno."""
        if not rows:
            return
        resp = await client.post(
            f"{self.base_url}/rest/v1/{table}",
            headers={**self.headers, "Content-Type": "application/json",
                     "Prefer": "return=minimal,resolution=merge-duplicates"},
            params={"on_conflict": on_conflict},
            json=rows, timeout=15.0,
        )
        resp.raise_for_status()
