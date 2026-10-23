BEGIN;
CREATE TABLE IF NOT EXISTS public.bk_model_validations (
 validation_id text PRIMARY KEY,league text NOT NULL,player_id text NOT NULL,policy text NOT NULL,as_of timestamptz NOT NULL,result jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.bk_model_protocols (
 protocol_id text PRIMARY KEY,registered_at timestamptz NOT NULL DEFAULT now(),specification jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.bk_model_test_results (
 protocol_id text NOT NULL REFERENCES public.bk_model_protocols(protocol_id),league text NOT NULL,
 evaluated_at timestamptz NOT NULL DEFAULT now(),report jsonb NOT NULL,PRIMARY KEY(protocol_id,league)
);
CREATE TABLE IF NOT EXISTS public.bk_value_alerts (
 alert_id text PRIMARY KEY,league text NOT NULL,game_id text NOT NULL,subject text NOT NULL,forecast_id text NOT NULL REFERENCES public.bk_forecasts(forecast_id),
 as_of timestamptz NOT NULL,expires_at timestamptz NOT NULL,policy text NOT NULL,decision jsonb NOT NULL,quote_snapshot jsonb NOT NULL,text text NOT NULL,
 UNIQUE(league,game_id,subject),FOREIGN KEY(league,game_id) REFERENCES public.bk_games(league,game_id)
);
CREATE OR REPLACE FUNCTION public.bk_seal_value_alert(p_row jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.bk_value_alerts;g public.bk_games;f public.bk_forecasts;q public.bk_quotes;n integer;
BEGIN
 r:=jsonb_populate_record(NULL::public.bk_value_alerts,p_row);
 PERFORM pg_advisory_xact_lock(hashtext('value:'||r.league||':'||r.game_id));
 SELECT * INTO STRICT g FROM bk_games WHERE league=r.league AND game_id=r.game_id;
 SELECT * INTO STRICT f FROM bk_forecasts WHERE forecast_id=r.forecast_id;
 SELECT * INTO STRICT q FROM bk_quotes WHERE quote_id=r.quote_snapshot->>'quote_id';
 IF g.status<>'scheduled' OR now()>=g.starts_at OR r.as_of<now()-interval '2 minutes' OR r.as_of>now()+interval '1 minute' OR r.expires_at<=now() OR r.expires_at>g.starts_at THEN RAISE EXCEPTION 'VALUE_NOT_PREGAME';END IF;
 IF f.league<>g.league OR f.game_id<>g.game_id OR f.model_version<>'bk-advanced-opportunity-1' OR f.result->'advanced'->>'status' IS DISTINCT FROM 'APPLIED' OR coalesce(f.player_id,'game')<>r.subject THEN RAISE EXCEPTION 'VALUE_FORECAST_MISMATCH';END IF;
 IF f.result IS DISTINCT FROM r.decision->'forecast' OR q.league<>g.league OR q.game_id<>g.game_id OR coalesce(q.player_id,'game')<>r.subject OR q.odds IS DISTINCT FROM (r.quote_snapshot->>'odds')::numeric OR q.opposite_odds IS DISTINCT FROM (r.quote_snapshot->>'opposite_odds')::numeric OR q.period<>'full_game' OR NOT q.includes_overtime THEN RAISE EXCEPTION 'VALUE_SNAPSHOT_CHANGED';END IF;
 IF q.market IS DISTINCT FROM r.quote_snapshot->>'market' OR q.selection IS DISTINCT FROM r.quote_snapshot->>'selection' OR q.line IS DISTINCT FROM (r.quote_snapshot->>'line')::numeric OR q.source IS DISTINCT FROM r.quote_snapshot->>'source' THEN RAISE EXCEPTION 'VALUE_MARKET_CHANGED';END IF;
 IF r.policy IS DISTINCT FROM 'bk-value-estimate-2' OR coalesce((r.decision->>'ev')::numeric,-1)<0.10 OR coalesce((r.decision->>'edge')::numeric,-1)<0.04 OR coalesce((r.decision->>'stress_ev')::numeric,-1)<0.01 OR coalesce((r.decision->>'baseline_ev')::numeric,-1)<=0 THEN RAISE EXCEPTION 'VALUE_THRESHOLDS_FAILED';END IF;
 IF r.decision->>'qualifies' IS DISTINCT FROM 'true' OR r.quote_snapshot->'detail'->>'delayed'='true' OR r.quote_snapshot->'detail'->>'reference_only'='true' OR r.quote_snapshot->>'source'='ps3838_public_delayed' THEN RAISE EXCEPTION 'VALUE_PRICE_INVALID';END IF;
 IF (r.quote_snapshot->>'captured_at')::timestamptz<now()-interval '5 minutes' OR (r.quote_snapshot->>'expires_at')::timestamptz<=now() THEN RAISE EXCEPTION 'VALUE_PRICE_EXPIRED';END IF;
 IF q.captured_at<now()-interval '5 minutes' OR q.expires_at<=now() OR r.expires_at>(r.quote_snapshot->>'captured_at')::timestamptz+interval '5 minutes' THEN RAISE EXCEPTION 'VALUE_CURRENT_PRICE_EXPIRED';END IF;
 IF (SELECT count(*) FROM bk_value_alerts WHERE league=r.league AND game_id=r.game_id)>=3 THEN RETURN false;END IF;
 INSERT INTO bk_value_alerts SELECT r.* ON CONFLICT DO NOTHING;GET DIAGNOSTICS n=ROW_COUNT;RETURN n=1;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['bk_model_validations','bk_model_protocols','bk_model_test_results','bk_value_alerts'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM service_role',t);
  EXECUTE format('GRANT SELECT ON public.%I TO service_role',t);
 END LOOP;
END $$;
GRANT INSERT ON public.bk_model_validations,public.bk_model_protocols,public.bk_model_test_results TO service_role;
REVOKE ALL ON FUNCTION public.bk_seal_value_alert(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bk_seal_value_alert(jsonb) TO service_role;
NOTIFY pgrst,'reload schema';COMMIT;
