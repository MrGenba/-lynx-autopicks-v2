"""Cliente minimo de Supabase REST -- SOLO LECTURA. Este sistema nunca escribe en las
tablas de produccion de Lynx Hunter."""
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
