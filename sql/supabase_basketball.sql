BEGIN;
CREATE TABLE IF NOT EXISTS public.bk_games (
 league text NOT NULL CHECK(league IN ('NBA','WNBA')),game_id text NOT NULL,
 season integer NOT NULL,season_type integer NOT NULL CHECK(season_type IN(2,3)),starts_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN('scheduled','live','final','postponed','suspended','cancelled')),
 neutral_site boolean NOT NULL DEFAULT false,home_team_id text NOT NULL,away_team_id text NOT NULL,home_team text NOT NULL,away_team text NOT NULL,
 home_score integer,away_score integer,periods integer,source text NOT NULL,source_url text NOT NULL,source_checked_at timestamptz NOT NULL DEFAULT now(),
 box_complete boolean NOT NULL DEFAULT false,box_captured_at timestamptz,receipt jsonb,
 PRIMARY KEY(league,game_id),CHECK(home_team_id<>away_team_id),CHECK(status<>'final' OR (home_score IS NOT NULL AND away_score IS NOT NULL AND home_score>=0 AND away_score>=0))
);
CREATE INDEX IF NOT EXISTS bk_games_time ON public.bk_games(league,starts_at);
CREATE TABLE IF NOT EXISTS public.bk_team_box (
 league text NOT NULL,game_id text NOT NULL,team_id text NOT NULL,opponent_id text NOT NULL,stats jsonb NOT NULL,source text NOT NULL,
 PRIMARY KEY(league,game_id,team_id),FOREIGN KEY(league,game_id) REFERENCES public.bk_games(league,game_id)
);
CREATE TABLE IF NOT EXISTS public.bk_player_box (
 league text NOT NULL,game_id text NOT NULL,team_id text NOT NULL,player_id text NOT NULL,player_name text NOT NULL,position text,
 starter boolean NOT NULL,did_not_play boolean NOT NULL,minutes numeric NOT NULL CHECK(minutes>=0 AND minutes<=90),stats jsonb,source text NOT NULL,
 PRIMARY KEY(league,game_id,player_id),FOREIGN KEY(league,game_id) REFERENCES public.bk_games(league,game_id),CHECK(did_not_play OR stats IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS bk_player_history ON public.bk_player_box(league,player_id,game_id);
CREATE TABLE IF NOT EXISTS public.bk_rosters (
 league text NOT NULL,game_id text NOT NULL,team_id text NOT NULL,players jsonb NOT NULL,confirmed boolean NOT NULL DEFAULT false,
 observed_at timestamptz NOT NULL,source text NOT NULL,PRIMARY KEY(league,game_id,team_id)
);
CREATE TABLE IF NOT EXISTS public.bk_state (
 league text NOT NULL,component text NOT NULL,checked_at timestamptz NOT NULL DEFAULT now(),status text NOT NULL,detail jsonb NOT NULL,
 PRIMARY KEY(league,component)
);
CREATE TABLE IF NOT EXISTS public.bk_box_attempts (
 league text NOT NULL,game_id text NOT NULL,checked_at timestamptz NOT NULL DEFAULT now(),retry_at timestamptz NOT NULL,error_code text NOT NULL,
 PRIMARY KEY(league,game_id)
);
CREATE TABLE IF NOT EXISTS public.bk_quotes (
 quote_id text PRIMARY KEY,league text NOT NULL,game_id text NOT NULL,player_id text,market text NOT NULL,line numeric,
 selection text NOT NULL,odds numeric NOT NULL CHECK(odds>1),opposite_odds numeric CHECK(opposite_odds>1),bookmaker text NOT NULL,
 period text NOT NULL,includes_overtime boolean NOT NULL,source text NOT NULL,source_url text NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT now(),price_updated_at timestamptz,expires_at timestamptz NOT NULL,detail jsonb NOT NULL DEFAULT '{}',
 FOREIGN KEY(league,game_id) REFERENCES public.bk_games(league,game_id)
);
CREATE INDEX IF NOT EXISTS bk_quotes_fresh ON public.bk_quotes(league,game_id,expires_at);
CREATE TABLE IF NOT EXISTS public.bk_forecasts (
 forecast_id text PRIMARY KEY,league text NOT NULL,game_id text NOT NULL,player_id text,model_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),as_of timestamptz NOT NULL,kind text NOT NULL,result jsonb NOT NULL,
 FOREIGN KEY(league,game_id) REFERENCES public.bk_games(league,game_id)
);
CREATE INDEX IF NOT EXISTS bk_forecasts_games ON public.bk_forecasts(league,game_id);
CREATE TABLE IF NOT EXISTS public.bk_candidates (
 candidate_id text PRIMARY KEY,league text NOT NULL,game_id text NOT NULL,player_id text,model_version text NOT NULL,quote_id text,
 created_at timestamptz NOT NULL DEFAULT now(),as_of timestamptz NOT NULL,market text NOT NULL,line numeric,selection text NOT NULL,
 odds numeric NOT NULL,p_win numeric NOT NULL,p_push numeric NOT NULL,p_loss numeric NOT NULL,ev numeric NOT NULL,
 verdict text NOT NULL,reasons jsonb NOT NULL,quote_snapshot jsonb NOT NULL,forecast jsonb NOT NULL,result text,outcome_value numeric,settled_at timestamptz,
 CHECK(p_win>=0 AND p_push>=0 AND p_loss>=0 AND abs(p_win+p_push+p_loss-1)<0.000001),
 FOREIGN KEY(league,game_id) REFERENCES public.bk_games(league,game_id)
);
CREATE INDEX IF NOT EXISTS bk_candidates_research ON public.bk_candidates(league,as_of);
CREATE TABLE IF NOT EXISTS public.bk_research (
 research_id text PRIMARY KEY,league text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),report jsonb NOT NULL,ai_review jsonb
);
CREATE TABLE IF NOT EXISTS public.bk_notifications (
 notification_id text PRIMARY KEY,league text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),payload jsonb NOT NULL,
 lease_owner text,lease_until timestamptz,sent_at timestamptz,message_id bigint,attempts integer NOT NULL DEFAULT 0,last_error text
);
CREATE TABLE IF NOT EXISTS public.bk_ai_budget (
 day date NOT NULL DEFAULT current_date,input_hash text NOT NULL,calls integer NOT NULL DEFAULT 4,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(day,input_hash)
);
CREATE TABLE IF NOT EXISTS public.bk_locks (name text PRIMARY KEY,owner text NOT NULL,expires_at timestamptz NOT NULL);
CREATE OR REPLACE FUNCTION public.bk_lock(p_name text,p_owner text,p_release boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_release THEN DELETE FROM bk_locks WHERE name=p_name AND owner=p_owner;RETURN FOUND;END IF;
 INSERT INTO bk_locks VALUES(p_name,p_owner,now()+interval '20 minutes') ON CONFLICT(name) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at WHERE bk_locks.expires_at<now();RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION public.bk_history(p_league text,p_team_ids text[]) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH g AS (SELECT * FROM bk_games WHERE league=p_league AND status='final' AND box_complete AND starts_at<now()-interval '4 hours' AND starts_at>now()-interval '560 days'),
 ranked AS (SELECT p.*,row_number() OVER(PARTITION BY p.player_id ORDER BY g.starts_at DESC) rn FROM bk_player_box p JOIN g USING(league,game_id) WHERE p.team_id=ANY(p_team_ids)),
 players AS (SELECT league,game_id,team_id,player_id,player_name,position,starter,did_not_play,minutes,stats,source FROM ranked WHERE rn<=30)
 SELECT jsonb_build_object('games',coalesce((SELECT jsonb_agg(to_jsonb(g)) FROM g),'[]'::jsonb),'teams',coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM bk_team_box t JOIN g USING(league,game_id)),'[]'::jsonb),'players',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM players p),'[]'::jsonb));
$$;
CREATE OR REPLACE FUNCTION public.bk_store_game(p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g public.bk_games; n integer;
BEGIN
 g:=jsonb_populate_record(NULL::public.bk_games,p_payload->'game');
 IF g.league NOT IN('NBA','WNBA') OR g.game_id IS NULL THEN RAISE EXCEPTION 'GAME_REQUIRED';END IF;
 IF g.source='sportsdataverse_espn' AND EXISTS(SELECT 1 FROM bk_games WHERE league=g.league AND game_id=g.game_id AND source='espn_core' AND box_complete) THEN RETURN jsonb_build_object('skipped_live_source',true);END IF;
 INSERT INTO public.bk_games(league,game_id,season,season_type,starts_at,status,neutral_site,home_team_id,away_team_id,home_team,away_team,home_score,away_score,periods,source,source_url,source_checked_at)
 VALUES(g.league,g.game_id,g.season,g.season_type,g.starts_at,g.status,g.neutral_site,g.home_team_id,g.away_team_id,g.home_team,g.away_team,g.home_score,g.away_score,g.periods,g.source,g.source_url,coalesce(g.source_checked_at,now()))
 ON CONFLICT(league,game_id) DO UPDATE SET starts_at=EXCLUDED.starts_at,status=EXCLUDED.status,home_score=EXCLUDED.home_score,away_score=EXCLUDED.away_score,periods=EXCLUDED.periods,
 home_team=EXCLUDED.home_team,away_team=EXCLUDED.away_team,neutral_site=EXCLUDED.neutral_site,source=EXCLUDED.source,source_url=EXCLUDED.source_url,source_checked_at=EXCLUDED.source_checked_at,
 box_complete=CASE WHEN EXCLUDED.status<>'final' OR bk_games.home_score IS DISTINCT FROM EXCLUDED.home_score OR bk_games.away_score IS DISTINCT FROM EXCLUDED.away_score THEN false ELSE bk_games.box_complete END
 WHERE bk_games.home_team_id=EXCLUDED.home_team_id AND bk_games.away_team_id=EXCLUDED.away_team_id AND bk_games.season=EXCLUDED.season;
 GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION 'GAME_IDENTITY_CONFLICT';END IF;
 IF jsonb_array_length(coalesce(p_payload->'rosters','[]'::jsonb))>0 THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'rosters') r WHERE r->>'league'<>g.league OR r->>'game_id'<>g.game_id OR r->>'team_id' NOT IN(g.home_team_id,g.away_team_id)) THEN RAISE EXCEPTION 'ROSTER_IDENTITY';END IF;
  INSERT INTO bk_rosters SELECT * FROM jsonb_populate_recordset(NULL::bk_rosters,p_payload->'rosters') ON CONFLICT(league,game_id,team_id) DO UPDATE SET players=EXCLUDED.players,confirmed=EXCLUDED.confirmed,observed_at=EXCLUDED.observed_at,source=EXCLUDED.source;
 END IF;
 IF coalesce((p_payload->'receipt'->>'complete')::boolean,false) THEN
  IF g.status<>'final' OR jsonb_array_length(p_payload->'teams')<>2 OR jsonb_array_length(p_payload->'players')<10 THEN RAISE EXCEPTION 'INCOMPLETE_BOXSCORE';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'players') r WHERE r->>'league'<>g.league OR r->>'game_id'<>g.game_id OR r->>'team_id' NOT IN(g.home_team_id,g.away_team_id)) THEN RAISE EXCEPTION 'PLAYER_GAME_IDENTITY';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'teams') r WHERE r->>'league'<>g.league OR r->>'game_id'<>g.game_id OR r->>'team_id' NOT IN(g.home_team_id,g.away_team_id)
    OR (r->'stats'->>'points')::integer<>CASE WHEN r->>'team_id'=g.home_team_id THEN g.home_score ELSE g.away_score END) THEN RAISE EXCEPTION 'TEAM_GAME_IDENTITY';END IF;
  DELETE FROM public.bk_player_box WHERE league=g.league AND game_id=g.game_id;
  DELETE FROM public.bk_team_box WHERE league=g.league AND game_id=g.game_id;
  INSERT INTO public.bk_team_box SELECT * FROM jsonb_populate_recordset(NULL::public.bk_team_box,p_payload->'teams');
  INSERT INTO public.bk_player_box SELECT * FROM jsonb_populate_recordset(NULL::public.bk_player_box,p_payload->'players');
  IF EXISTS(SELECT 1 FROM bk_team_box t WHERE t.league=g.league AND t.game_id=g.game_id AND
   (SELECT sum((p.stats->>'points')::integer) FROM bk_player_box p WHERE p.league=t.league AND p.game_id=t.game_id AND p.team_id=t.team_id AND NOT p.did_not_play) IS DISTINCT FROM (t.stats->>'points')::integer)
   THEN RAISE EXCEPTION 'PLAYER_TEAM_SCORE_MISMATCH';END IF;
  UPDATE public.bk_games SET box_complete=true,box_captured_at=now(),receipt=p_payload->'receipt' WHERE league=g.league AND game_id=g.game_id;
  DELETE FROM bk_box_attempts WHERE league=g.league AND game_id=g.game_id;
 END IF;
 RETURN jsonb_build_object('league',g.league,'game_id',g.game_id,'box_complete',coalesce((p_payload->'receipt'->>'complete')::boolean,false));
END $$;
CREATE OR REPLACE FUNCTION public.bk_seal_forecasts(p_rows jsonb) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.bk_forecasts;n integer;total integer:=0;g public.bk_games;BEGIN
 IF jsonb_array_length(p_rows)>500 THEN RAISE EXCEPTION 'BATCH_TOO_LARGE';END IF;
 FOR r IN SELECT * FROM jsonb_populate_recordset(NULL::public.bk_forecasts,p_rows) LOOP
  SELECT * INTO STRICT g FROM bk_games WHERE league=r.league AND game_id=r.game_id FOR SHARE;
  IF g.status<>'scheduled' OR now()>=g.starts_at OR r.as_of>now()+interval '1 minute' OR r.as_of<now()-interval '10 minutes' OR r.as_of>=g.starts_at THEN RAISE EXCEPTION 'FORECAST_NOT_PREGAME';END IF;
  IF r.kind NOT IN('team','player') OR r.result->>'status'<>'OK' OR r.result->>'model_version'<>r.model_version THEN RAISE EXCEPTION 'FORECAST_INVALID';END IF;
  INSERT INTO bk_forecasts(forecast_id,league,game_id,player_id,model_version,as_of,kind,result) VALUES(r.forecast_id,r.league,r.game_id,r.player_id,r.model_version,r.as_of,r.kind,r.result) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 END LOOP;RETURN total;END $$;
CREATE OR REPLACE FUNCTION public.bk_seal_candidates(p_rows jsonb) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.bk_candidates;n integer;total integer:=0;g public.bk_games;BEGIN
 IF jsonb_array_length(p_rows)>500 THEN RAISE EXCEPTION 'BATCH_TOO_LARGE';END IF;
 FOR r IN SELECT * FROM jsonb_populate_recordset(NULL::public.bk_candidates,p_rows) LOOP
  SELECT * INTO STRICT g FROM bk_games WHERE league=r.league AND game_id=r.game_id FOR SHARE;
  IF g.status<>'scheduled' OR now()>=g.starts_at OR r.as_of>now()+interval '1 minute' OR r.as_of<now()-interval '10 minutes' OR r.as_of>=g.starts_at THEN RAISE EXCEPTION 'CANDIDATE_NOT_PREGAME';END IF;
  IF r.result IS NOT NULL OR r.settled_at IS NOT NULL OR r.odds<=1 OR r.quote_snapshot->>'period'<>'full_game' OR (r.quote_snapshot->>'includes_overtime')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'CANDIDATE_INVALID';END IF;
  r.created_at:=now();INSERT INTO bk_candidates SELECT r.* ON CONFLICT DO NOTHING;GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 END LOOP;RETURN total;END $$;
CREATE OR REPLACE FUNCTION public.bk_settle_candidates() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.bk_candidates;g public.bk_games;p public.bk_player_box;v numeric;diff numeric;outcome text;n integer:=0;BEGIN
 FOR c IN SELECT * FROM bk_candidates WHERE settled_at IS NULL FOR UPDATE SKIP LOCKED LOOP
  SELECT * INTO g FROM bk_games WHERE league=c.league AND game_id=c.game_id;
  IF g.status='cancelled' THEN outcome:='VOID';v:=NULL;
  ELSIF g.status='final' AND g.box_complete THEN
   IF c.player_id IS NOT NULL THEN
    SELECT * INTO p FROM bk_player_box WHERE league=c.league AND game_id=c.game_id AND player_id=c.player_id;
    IF NOT FOUND THEN CONTINUE;END IF;
    IF p.did_not_play OR p.minutes=0 THEN outcome:='VOID';v:=NULL;
    ELSE
     v:=CASE c.market WHEN 'points' THEN (p.stats->>'points')::numeric WHEN 'rebounds' THEN (p.stats->>'rebounds')::numeric WHEN 'assists' THEN (p.stats->>'assists')::numeric WHEN 'threes' THEN (p.stats->>'fg3m')::numeric
       WHEN 'pra' THEN (p.stats->>'points')::numeric+(p.stats->>'rebounds')::numeric+(p.stats->>'assists')::numeric
       WHEN 'pr' THEN (p.stats->>'points')::numeric+(p.stats->>'rebounds')::numeric WHEN 'pa' THEN (p.stats->>'points')::numeric+(p.stats->>'assists')::numeric WHEN 'ra' THEN (p.stats->>'rebounds')::numeric+(p.stats->>'assists')::numeric END;
     diff:=CASE WHEN c.selection='over' THEN v-c.line ELSE c.line-v END;outcome:=CASE WHEN diff>0 THEN 'WIN' WHEN diff<0 THEN 'LOSS' WHEN diff=0 THEN 'PUSH' END;
    END IF;
   ELSE
    v:=CASE c.market WHEN 'total' THEN g.home_score+g.away_score ELSE g.home_score-g.away_score END;
    diff:=CASE c.market WHEN 'total' THEN CASE WHEN c.selection='over' THEN v-c.line ELSE c.line-v END WHEN 'spread' THEN (CASE WHEN c.selection='home' THEN v ELSE -v END)+c.line WHEN 'moneyline' THEN CASE WHEN c.selection='home' THEN v ELSE -v END END;
    outcome:=CASE WHEN diff>0 THEN 'WIN' WHEN diff<0 THEN 'LOSS' WHEN diff=0 THEN 'PUSH' END;
   END IF;
  ELSE CONTINUE;END IF;
  IF outcome IS NOT NULL THEN UPDATE bk_candidates SET result=outcome,outcome_value=v,settled_at=now() WHERE candidate_id=c.candidate_id;n:=n+1;END IF;
 END LOOP;RETURN n;END $$;
CREATE OR REPLACE FUNCTION public.bk_import_batch(p_payloads jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p jsonb;n integer:=0;BEGIN
 IF jsonb_array_length(p_payloads)>50 THEN RAISE EXCEPTION 'BATCH_TOO_LARGE';END IF;
 FOR p IN SELECT * FROM jsonb_array_elements(p_payloads) LOOP PERFORM public.bk_store_game(p);n:=n+1;END LOOP;
 RETURN jsonb_build_object('stored',n);
END $$;
CREATE OR REPLACE FUNCTION public.bk_reserve_ai(p_input_hash text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('basketball_ai_budget'));
 IF EXISTS(SELECT 1 FROM bk_ai_budget WHERE day=current_date AND input_hash=p_input_hash) OR (SELECT coalesce(sum(calls),0) FROM bk_ai_budget WHERE day=current_date)>=16 THEN RETURN false;END IF;
 INSERT INTO bk_ai_budget(input_hash) VALUES(p_input_hash);RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.bk_claim_notification(p_id text,p_league text,p_payload jsonb,p_owner text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO bk_notifications(notification_id,league,payload) VALUES(p_id,p_league,p_payload) ON CONFLICT DO NOTHING;
 UPDATE bk_notifications SET lease_owner=p_owner,lease_until=now()+interval '5 minutes',attempts=attempts+1 WHERE notification_id=p_id AND sent_at IS NULL AND (lease_until IS NULL OR lease_until<now());RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION public.bk_finish_notification(p_id text,p_owner text,p_message_id bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE bk_notifications SET sent_at=CASE WHEN p_message_id>0 THEN now() END,message_id=p_message_id,lease_owner=NULL,lease_until=NULL,
 last_error=CASE WHEN p_message_id IS NULL THEN 'DELIVERY_FAILED' END WHERE notification_id=p_id AND lease_owner=p_owner AND sent_at IS NULL;RETURN FOUND;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['bk_games','bk_team_box','bk_player_box','bk_rosters','bk_state','bk_box_attempts','bk_quotes','bk_forecasts','bk_candidates','bk_research','bk_notifications','bk_ai_budget','bk_locks'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
 END LOOP;END $$;
-- Forecasts and pregame decisions can only be appended through the sealing RPCs.
-- Settlement may update outcome fields through its SECURITY DEFINER function.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.bk_forecasts,public.bk_candidates FROM service_role;
REVOKE ALL ON FUNCTION public.bk_store_game(jsonb),public.bk_import_batch(jsonb),public.bk_reserve_ai(text),public.bk_claim_notification(text,text,jsonb,text),public.bk_finish_notification(text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bk_store_game(jsonb),public.bk_import_batch(jsonb),public.bk_reserve_ai(text),public.bk_claim_notification(text,text,jsonb,text),public.bk_finish_notification(text,text,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.bk_seal_forecasts(jsonb),public.bk_seal_candidates(jsonb),public.bk_settle_candidates() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bk_seal_forecasts(jsonb),public.bk_seal_candidates(jsonb),public.bk_settle_candidates() TO service_role;
REVOKE ALL ON FUNCTION public.bk_lock(text,text,boolean),public.bk_history(text,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bk_lock(text,text,boolean),public.bk_history(text,text[]) TO service_role;
NOTIFY pgrst,'reload schema';COMMIT;
