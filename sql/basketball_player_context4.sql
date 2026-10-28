-- Additive evidence: official boxscores, settlement and old forecasts stay intact.
CREATE TABLE IF NOT EXISTS public.bk_player_game_evidence (
 league text NOT NULL CHECK(league IN ('NBA','WNBA')),
 game_id text NOT NULL, player_id text NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(), evidence jsonb NOT NULL,
 PRIMARY KEY(league,game_id,player_id),
 FOREIGN KEY(league,game_id) REFERENCES public.bk_games(league,game_id),
 CHECK(evidence->>'policy'='bk-explicit-injury-exit-1'),
 CHECK(evidence->>'status'='EXITED_INJURY_NO_RETURN'),
 CHECK(evidence->>'player_id'=player_id AND evidence->>'game_id'=game_id),
 CHECK(evidence->>'source_url' ~ '^https://www[.]rotowire[.]com/(basketball|wnba)/'),
 CHECK(evidence ?& ARRAY['policy','status','player_id','game_id','source_url','published_at','observed_at','evidence'])
);
ALTER TABLE public.bk_player_game_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bk_player_game_evidence FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.bk_player_game_evidence TO service_role;
DROP POLICY IF EXISTS bk_evidence_service ON public.bk_player_game_evidence;
CREATE POLICY bk_evidence_service ON public.bk_player_game_evidence TO service_role USING(true) WITH CHECK(true);
CREATE OR REPLACE FUNCTION public.bk_history_context4(p_league text,p_team_ids text[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH original AS(SELECT bk_history(p_league,p_team_ids) body)
 SELECT body || jsonb_build_object('players',coalesce((SELECT jsonb_agg(p.value || CASE WHEN e.player_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('injury_exit',e.evidence) END)
 FROM jsonb_array_elements(body->'players') p LEFT JOIN bk_player_game_evidence e ON e.league=p_league AND e.game_id=p.value->>'game_id' AND e.player_id=p.value->>'player_id' AND e.observed_at<=now()),'[]'::jsonb)) FROM original;
$$;
REVOKE ALL ON FUNCTION public.bk_history_context4(text,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bk_history_context4(text,text[]) TO service_role;
NOTIFY pgrst,'reload schema';

CREATE OR REPLACE FUNCTION public.bk_seal_value_alert(p_row jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r public.bk_value_alerts;g public.bk_games;f public.bk_forecasts;q public.bk_quotes;n integer;c record;p jsonb;
BEGIN
 r:=jsonb_populate_record(NULL::public.bk_value_alerts,p_row);
 PERFORM pg_advisory_xact_lock(hashtext('value:'||r.league||':'||r.game_id));
 SELECT * INTO STRICT g FROM bk_games WHERE league=r.league AND game_id=r.game_id;
 SELECT * INTO STRICT f FROM bk_forecasts WHERE forecast_id=r.forecast_id;
 SELECT * INTO STRICT q FROM bk_quotes WHERE quote_id=r.quote_snapshot->>'quote_id';
 IF g.status<>'scheduled' OR now()>=g.starts_at OR r.as_of<now()-interval '2 minutes' OR r.as_of>now()+interval '1 minute' OR r.expires_at<=now() OR r.expires_at>g.starts_at THEN RAISE EXCEPTION 'VALUE_NOT_PREGAME';END IF;
 IF f.league<>g.league OR f.game_id<>g.game_id OR f.model_version NOT IN('bk-context-opportunity-1','bk-player-context-2','bk-player-context-3','bk-player-context-4') OR f.result->'advanced'->>'status' IS DISTINCT FROM 'APPLIED' OR coalesce(f.player_id,'game')<>r.subject THEN RAISE EXCEPTION 'VALUE_FORECAST_MISMATCH';END IF;
 IF f.model_version='bk-player-context-3' AND (f.result->'overtime'->>'status' IS DISTINCT FROM 'APPLIED' OR NOT EXISTS(SELECT 1 FROM bk_model_protocols WHERE protocol_id='bk-overtime-prospective-1' AND registered_at<=f.as_of)) THEN RAISE EXCEPTION 'VALUE_OVERTIME_NOT_READY';END IF;
 IF f.model_version='bk-player-context-4' AND (f.result->'overtime'->>'status' IS DISTINCT FROM 'APPLIED' OR NOT EXISTS(SELECT 1 FROM bk_model_protocols WHERE protocol_id='bk-player-context-prospective-4' AND registered_at<=f.as_of)) THEN RAISE EXCEPTION 'VALUE_PLAYER_CONTEXT4_NOT_READY';END IF;
 SELECT * INTO c FROM bk_context_current WHERE league=g.league AND game_id=g.game_id;
 IF NOT FOUND OR c.checked_at<now()-interval '10 minutes' OR c.body->>'model_revision' IS DISTINCT FROM f.result->'context'->>'revision' OR jsonb_array_length(coalesce(f.result->'context'->'blockers','["MISSING"]'::jsonb))>0 THEN RAISE EXCEPTION 'VALUE_CONTEXT_NOT_CURRENT';END IF;
 IF (c.body->>'report_published_at')::timestamptz IS NULL OR (c.body->>'report_published_at')::timestamptz<now()-interval '6 hours' OR (c.body->>'report_published_at')::timestamptz>now() OR c.body->'sources'->>'injuries' IS DISTINCT FROM 'OK' OR c.body->'sources'->>'lineups' IS DISTINCT FROM 'OK' OR c.body->'sources'->>'news' IS DISTINCT FROM 'OK' THEN RAISE EXCEPTION 'VALUE_CONTEXT_SOURCE_UNAVAILABLE';END IF;
 IF f.player_id IS NOT NULL THEN
  p:=c.body->'players'->f.player_id;
  IF p IS NULL OR coalesce(p->>'availability','UNVERIFIED') NOT IN('AVAILABLE','NOT_LISTED','PROBABLE') OR c.body->'teams'->(p->>'team_id')->>'lineup' IS DISTINCT FROM 'CONFIRMED' OR p->>'news_unresolved'='true' THEN RAISE EXCEPTION 'VALUE_PARTICIPATION_UNCONFIRMED';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM jsonb_each(c.body->'teams') t WHERE t.value->>'lineup' IS DISTINCT FROM 'CONFIRMED' OR t.value->>'injury_report_submitted' IS DISTINCT FROM 'true') THEN RAISE EXCEPTION 'VALUE_LINEUPS_UNCONFIRMED';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(c.body->'unmapped','[]'::jsonb)) u WHERE u->>'source'='injury' AND u->>'status' IS DISTINCT FROM 'AVAILABLE' AND (f.player_id IS NULL OR u->>'team_id'=f.result->>'team_id')) THEN RAISE EXCEPTION 'VALUE_INJURY_IDENTITY_UNRESOLVED';END IF;
 IF (f.result->'context'->>'observed_at')::timestamptz IS NULL OR q.captured_at<(f.result->'context'->>'observed_at')::timestamptz THEN RAISE EXCEPTION 'VALUE_PRICE_BEFORE_CONTEXT';END IF;
 IF f.result IS DISTINCT FROM r.decision->'forecast' OR q.league<>g.league OR q.game_id<>g.game_id OR coalesce(q.player_id,'game')<>r.subject OR q.odds IS DISTINCT FROM (r.quote_snapshot->>'odds')::numeric OR q.opposite_odds IS DISTINCT FROM (r.quote_snapshot->>'opposite_odds')::numeric OR q.period<>'full_game' OR NOT q.includes_overtime THEN RAISE EXCEPTION 'VALUE_SNAPSHOT_CHANGED';END IF;
 IF q.market IS DISTINCT FROM r.quote_snapshot->>'market' OR q.selection IS DISTINCT FROM r.quote_snapshot->>'selection' OR q.line IS DISTINCT FROM (r.quote_snapshot->>'line')::numeric OR q.source IS DISTINCT FROM r.quote_snapshot->>'source' THEN RAISE EXCEPTION 'VALUE_MARKET_CHANGED';END IF;
 IF r.policy IS DISTINCT FROM 'bk-value-estimate-2' OR coalesce((r.decision->>'ev')::numeric,-1)<0.10 OR coalesce((r.decision->>'edge')::numeric,-1)<0.04 OR coalesce((r.decision->>'stress_ev')::numeric,-1)<0.01 OR coalesce((r.decision->>'baseline_ev')::numeric,-1)<=0 THEN RAISE EXCEPTION 'VALUE_THRESHOLDS_FAILED';END IF;
 IF r.decision->>'qualifies' IS DISTINCT FROM 'true' OR r.quote_snapshot->'detail'->>'delayed'='true' OR r.quote_snapshot->'detail'->>'reference_only'='true' OR r.quote_snapshot->>'source'='ps3838_public_delayed' THEN RAISE EXCEPTION 'VALUE_PRICE_INVALID';END IF;
 IF (r.quote_snapshot->>'captured_at')::timestamptz<now()-interval '5 minutes' OR (r.quote_snapshot->>'expires_at')::timestamptz<=now() THEN RAISE EXCEPTION 'VALUE_PRICE_EXPIRED';END IF;
 IF q.captured_at<now()-interval '5 minutes' OR q.expires_at<=now() OR r.expires_at>(r.quote_snapshot->>'captured_at')::timestamptz+interval '5 minutes' THEN RAISE EXCEPTION 'VALUE_CURRENT_PRICE_EXPIRED';END IF;
 IF (SELECT count(*) FROM bk_value_alerts WHERE league=r.league AND game_id=r.game_id)>=3 THEN RETURN false;END IF;
 INSERT INTO bk_value_alerts SELECT r.* ON CONFLICT DO NOTHING;GET DIAGNOSTICS n=ROW_COUNT;RETURN n=1;
END $function$
