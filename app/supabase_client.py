"""Cliente minimo de Supabase REST -- de LECTURA para las vistas enriquecidas de produccion
(vw_mlb_matchups_ready, lineup_watch, etc). Desde 2026-07-11, con aprobacion explicita del
usuario, tambien de ESCRITURA pero UNICAMENTE hacia *_candidates_history (mlb_candidates_history/
candidates_history/lmb_candidates_history), para que los candidatos evaluados por Auto-Picks v2
entren en el mismo pool de datos de calibracion que produccion (marcados con source='autopicks_v2'
para poder distinguirlos). No escribe en ninguna otra tabla de produccion (picks_history,
mlb_games, etc)."""
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
