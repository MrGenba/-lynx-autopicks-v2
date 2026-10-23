BEGIN;
CREATE TABLE IF NOT EXISTS public.bk_context_versions (
 snapshot_id text PRIMARY KEY,league text NOT NULL,game_id text NOT NULL,observed_at timestamptz NOT NULL,body jsonb NOT NULL,
 FOREIGN KEY(league,game_id) REFERENCES public.bk_games(league,game_id)
);
CREATE TABLE IF NOT EXISTS public.bk_context_latest (
 league text NOT NULL,game_id text NOT NULL,snapshot_id text NOT NULL REFERENCES public.bk_context_versions(snapshot_id),checked_at timestamptz NOT NULL,
 PRIMARY KEY(league,game_id)
);
CREATE OR REPLACE VIEW public.bk_context_current WITH(security_invoker=true) AS
 SELECT v.*,l.checked_at FROM public.bk_context_latest l JOIN public.bk_context_versions v USING(snapshot_id,league,game_id);
CREATE OR REPLACE FUNCTION public.bk_store_context(p_row jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.bk_context_versions;BEGIN
 r:=jsonb_populate_record(NULL::public.bk_context_versions,p_row);
 IF r.observed_at<now()-interval '5 minutes' OR r.observed_at>now()+interval '1 minute' OR r.body->>'game_id' IS DISTINCT FROM r.game_id OR r.body->>'league' IS DISTINCT FROM r.league OR r.body->>'policy' IS DISTINCT FROM 'bk-context-1' THEN RAISE EXCEPTION 'CONTEXT_INVALID';END IF;
 IF NOT EXISTS(SELECT 1 FROM bk_games WHERE league=r.league AND game_id=r.game_id AND status='scheduled' AND starts_at>now()) THEN RETURN false;END IF;
 INSERT INTO bk_context_versions SELECT r.* ON CONFLICT DO NOTHING;
 INSERT INTO bk_context_latest VALUES(r.league,r.game_id,r.snapshot_id,r.observed_at) ON CONFLICT(league,game_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,checked_at=EXCLUDED.checked_at WHERE bk_context_latest.checked_at<=EXCLUDED.checked_at;
 RETURN true;
END $$;
ALTER TABLE public.bk_context_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bk_context_latest ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bk_context_versions,public.bk_context_latest,public.bk_context_current FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.bk_context_versions,public.bk_context_latest,public.bk_context_current TO service_role;
REVOKE ALL ON FUNCTION public.bk_store_context(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bk_store_context(jsonb) TO service_role;
NOTIFY pgrst,'reload schema';COMMIT;
