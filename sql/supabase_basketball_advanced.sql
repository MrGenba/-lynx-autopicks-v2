BEGIN;
CREATE TABLE IF NOT EXISTS public.bk_stat_sources (
 league text NOT NULL CHECK(league IN('NBA','WNBA')),season integer NOT NULL,dataset text NOT NULL,
 checked_at timestamptz NOT NULL,source_published_at timestamptz,source_url text,content_sha256 text,
 last_success_at timestamptz,status text NOT NULL,detail jsonb NOT NULL,PRIMARY KEY(league,season,dataset)
);
CREATE TABLE IF NOT EXISTS public.bk_player_stat_versions (
 version_id text PRIMARY KEY,entity_key text NOT NULL,content_hash text NOT NULL,
 league text NOT NULL CHECK(league IN('NBA','WNBA')),season integer NOT NULL,dataset text NOT NULL,
 season_type text NOT NULL,per_mode text NOT NULL,provider_player_id text NOT NULL,provider_team_id text,
 player_id text,player_name text NOT NULL,team_abbreviation text,stats jsonb NOT NULL,mapping jsonb NOT NULL,quality jsonb NOT NULL,
 source_url text NOT NULL,source_published_at timestamptz NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),data_through timestamptz
);
CREATE INDEX IF NOT EXISTS bk_stat_player_history ON public.bk_player_stat_versions(league,player_id,observed_at);
CREATE TABLE IF NOT EXISTS public.bk_player_stat_latest (
 entity_key text PRIMARY KEY,version_id text NOT NULL REFERENCES public.bk_player_stat_versions(version_id),
 source_published_at timestamptz NOT NULL,last_seen_at timestamptz NOT NULL
);
CREATE OR REPLACE VIEW public.bk_player_advanced_current WITH(security_invoker=true) AS
 SELECT v.*,l.source_published_at AS latest_publication_at,l.last_seen_at,s.checked_at AS source_checked_at,s.status AS source_status
 FROM public.bk_player_stat_latest l JOIN public.bk_player_stat_versions v USING(version_id)
 JOIN public.bk_stat_sources s ON s.league=v.league AND s.season=v.season AND s.dataset=v.dataset
 WHERE l.source_published_at=s.source_published_at;
CREATE OR REPLACE FUNCTION public.bk_player_identity_catalog() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM (
  SELECT DISTINCT ON(b.league,b.player_id) b.league,b.player_id,b.player_name,b.team_id,g.season
  FROM bk_player_box b JOIN bk_games g USING(league,game_id) ORDER BY b.league,b.player_id,g.starts_at DESC
 ) p;
$$;
CREATE OR REPLACE FUNCTION public.bk_store_advanced_stats(p_rows jsonb) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.bk_player_stat_versions;old public.bk_player_stat_versions;old_published timestamptz;chosen text;n integer:=0;
BEGIN
 IF jsonb_array_length(p_rows)>200 THEN RAISE EXCEPTION 'BATCH_TOO_LARGE';END IF;
 FOR r IN SELECT * FROM jsonb_populate_recordset(NULL::public.bk_player_stat_versions,p_rows) LOOP
  IF r.observed_at>now()+interval '1 minute' OR r.observed_at<now()-interval '1 hour' OR r.source_published_at>now()+interval '1 minute' THEN RAISE EXCEPTION 'INVALID_OBSERVATION_TIME';END IF;
  IF r.data_through IS NOT NULL OR r.quality->>'eligible_for_model' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'UNVERIFIED_SOURCE_SCOPE';END IF;
  SELECT v.* INTO old FROM bk_player_stat_latest l JOIN bk_player_stat_versions v USING(version_id) WHERE l.entity_key=r.entity_key;
  SELECT source_published_at INTO old_published FROM bk_player_stat_latest WHERE entity_key=r.entity_key;
  IF old_published IS NOT NULL AND old_published>r.source_published_at THEN CONTINUE;END IF;
  IF old.content_hash IS NOT DISTINCT FROM r.content_hash AND old.version_id IS NOT NULL THEN chosen:=old.version_id;
  ELSE
   INSERT INTO bk_player_stat_versions SELECT r.* ON CONFLICT(version_id) DO NOTHING;
   chosen:=r.version_id;n:=n+1;
  END IF;
  INSERT INTO bk_player_stat_latest VALUES(r.entity_key,chosen,r.source_published_at,r.observed_at)
  ON CONFLICT(entity_key) DO UPDATE SET version_id=EXCLUDED.version_id,source_published_at=EXCLUDED.source_published_at,last_seen_at=EXCLUDED.last_seen_at;
 END LOOP;
 RETURN n;
END $$;
CREATE OR REPLACE FUNCTION public.bk_player_season_box_totals(p_league text,p_season integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY player_id,season_type),'[]'::jsonb) FROM (
  SELECT p.player_id,CASE g.season_type WHEN 2 THEN 'Regular Season' WHEN 3 THEN 'Playoffs' END AS season_type,
   count(*) FILTER(WHERE NOT p.did_not_play AND p.minutes>0) AS gp,sum((p.stats->>'points')::numeric) AS pts,max(g.starts_at) AS last_game
  FROM bk_player_box p JOIN bk_games g USING(league,game_id)
  WHERE g.league=p_league AND g.season=p_season AND g.box_complete AND g.status='final'
  GROUP BY p.player_id,g.season_type
 ) b;
$$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['bk_stat_sources','bk_player_stat_versions','bk_player_stat_latest'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('GRANT SELECT ON public.%I TO service_role',t);
 END LOOP;
END $$;
GRANT INSERT,UPDATE ON public.bk_stat_sources TO service_role;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.bk_player_stat_versions,public.bk_player_stat_latest FROM service_role;
REVOKE ALL ON public.bk_player_advanced_current FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.bk_player_advanced_current TO service_role;
REVOKE ALL ON FUNCTION public.bk_player_identity_catalog(),public.bk_store_advanced_stats(jsonb),public.bk_player_season_box_totals(text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bk_player_identity_catalog(),public.bk_store_advanced_stats(jsonb),public.bk_player_season_box_totals(text,integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
