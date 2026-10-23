CREATE TABLE IF NOT EXISTS public.bb_postgame_receipts (
 sport_id integer NOT NULL CHECK(sport_id IN (1,11,23)), game_id bigint NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT now(), collector_version text NOT NULL,
 source_url text NOT NULL, expected_pitcher_ids jsonb NOT NULL, pitcher_rows integer NOT NULL,
 team_outs jsonb NOT NULL, known_pregame boolean NOT NULL DEFAULT false CHECK(NOT known_pregame),
 PRIMARY KEY(sport_id,game_id));
ALTER TABLE public.bb_postgame_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bb_postgame_receipts FROM anon,authenticated;
GRANT SELECT ON public.bb_postgame_receipts TO service_role;
CREATE OR REPLACE FUNCTION public.bb_ingest_postgame(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE sport integer:=(p->>'sport_id')::integer; gid bigint:=(p->'game'->>'game_id')::bigint;
 g jsonb:=p->'game'; rows jsonb:=p->'rows'; n integer; distinct_n integer; expected_n integer; received integer;
BEGIN
 IF sport NOT IN (1,11,23) OR gid IS NULL OR p->>'collector_version'<>'postgame-complete-v1'
 OR coalesce((p->>'known_pregame')::boolean,true) THEN RAISE EXCEPTION 'Invalid postgame identity'; END IF;
 IF g->>'status' NOT IN ('Final','Game Over','Completed Early') OR (g->>'game_date')::timestamptz>now()
 OR (g->>'home_score')::integer IS NULL OR (g->>'away_score')::integer IS NULL THEN RAISE EXCEPTION 'Final scores required'; END IF;
 SELECT count(*),count(distinct x->>'player_id') INTO n,distinct_n FROM jsonb_array_elements(rows) x;
 expected_n:=jsonb_array_length(p->'expected_pitcher_ids');
 IF n<2 OR n<>expected_n OR n<>distinct_n OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(rows) x WHERE (x->>'game_id')::bigint<>gid OR
  (x->>'innings_pitched')::numeric<0 OR x->>'innings_pitched' IS NULL OR
  (x->>'team_id')::bigint NOT IN ((g->>'away_team_id')::bigint,(g->>'home_team_id')::bigint)
 ) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'expected_pitcher_ids') x
 WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rows) r WHERE r->>'player_id'=x))
 THEN RAISE EXCEPTION 'Incomplete/invalid pitcher set'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(rows) r WHERE (r->>'is_starter')::boolean)<>2
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(rows) r GROUP BY (r->>'is_home')::boolean
 HAVING abs(sum((r->>'innings_pitched')::numeric)*3-(p->'team_outs'->>CASE WHEN (r->>'is_home')::boolean THEN 'home' ELSE 'away' END)::numeric)>0.00001)
 THEN RAISE EXCEPTION 'Pitcher innings/starter mismatch'; END IF;
 IF sport=1 THEN
 INSERT INTO mlb_games(game_pk,game_date,away_team_id,away_team_name,home_team_id,home_team_name,venue_id,away_score,home_score,status,game_type,scheduled_innings,season,venue_name,game_time) VALUES(gid,(g->>'official_date')::date,(g->>'away_team_id')::integer,(g->>'away_team_name'),(g->>'home_team_id')::integer,(g->>'home_team_name'),(g->>'venue_id')::integer,(g->>'away_score')::integer,(g->>'home_score')::integer,(g->>'status'),(g->>'game_type'),(g->>'scheduled_innings')::integer,(g->>'season')::integer,(g->>'venue_name'),(g->>'game_date')::timestamptz)
 ON CONFLICT(game_pk) DO UPDATE SET game_date=EXCLUDED.game_date,away_team_id=EXCLUDED.away_team_id,away_team_name=EXCLUDED.away_team_name,home_team_id=EXCLUDED.home_team_id,home_team_name=EXCLUDED.home_team_name,venue_id=EXCLUDED.venue_id,away_score=EXCLUDED.away_score,home_score=EXCLUDED.home_score,status=EXCLUDED.status,game_type=EXCLUDED.game_type,scheduled_innings=EXCLUDED.scheduled_innings,season=EXCLUDED.season,venue_name=EXCLUDED.venue_name,game_time=EXCLUDED.game_time,updated_at=now();
 END IF;
 IF sport=11 THEN
 INSERT INTO daily_games(game_id,game_date,away_team_id,away_team_name,home_team_id,home_team_name,venue_id,away_score,home_score,status,game_type,scheduled_innings,sport_id) VALUES(gid,(g->>'game_date')::timestamptz,(g->>'away_team_id')::integer,(g->>'away_team_name'),(g->>'home_team_id')::integer,(g->>'home_team_name'),(g->>'venue_id')::integer,(g->>'away_score')::integer,(g->>'home_score')::integer,(g->>'status'),(g->>'game_type'),(g->>'scheduled_innings')::integer,sport)
 ON CONFLICT(game_id) DO UPDATE SET game_date=EXCLUDED.game_date,away_team_id=EXCLUDED.away_team_id,away_team_name=EXCLUDED.away_team_name,home_team_id=EXCLUDED.home_team_id,home_team_name=EXCLUDED.home_team_name,venue_id=EXCLUDED.venue_id,away_score=EXCLUDED.away_score,home_score=EXCLUDED.home_score,status=EXCLUDED.status,game_type=EXCLUDED.game_type,scheduled_innings=EXCLUDED.scheduled_innings,sport_id=EXCLUDED.sport_id,updated_at=now();
 END IF;
 IF sport=23 THEN
 INSERT INTO lmb_games(game_pk,game_date,away_team_id,away_team_name,home_team_id,home_team_name,venue_id,away_score,home_score,status,game_type,scheduled_innings,season,venue_name,game_time_utc) VALUES(gid,(g->>'official_date')::date,(g->>'away_team_id')::integer,(g->>'away_team_name'),(g->>'home_team_id')::integer,(g->>'home_team_name'),(g->>'venue_id')::integer,(g->>'away_score')::integer,(g->>'home_score')::integer,(g->>'status'),(g->>'game_type'),(g->>'scheduled_innings')::integer,(g->>'season')::integer,(g->>'venue_name'),(g->>'game_date')::timestamptz)
 ON CONFLICT(game_pk) DO UPDATE SET game_date=EXCLUDED.game_date,away_team_id=EXCLUDED.away_team_id,away_team_name=EXCLUDED.away_team_name,home_team_id=EXCLUDED.home_team_id,home_team_name=EXCLUDED.home_team_name,venue_id=EXCLUDED.venue_id,away_score=EXCLUDED.away_score,home_score=EXCLUDED.home_score,status=EXCLUDED.status,game_type=EXCLUDED.game_type,scheduled_innings=EXCLUDED.scheduled_innings,season=EXCLUDED.season,venue_name=EXCLUDED.venue_name,game_time_utc=EXCLUDED.game_time_utc,updated_at=now();
 END IF;
 IF sport=1 THEN
 INSERT INTO mlb_pitcher_gamelogs(game_pk,game_date,player_id,player_name,team_id,team_name,season,is_starter,innings_pitched,earned_runs,strikeouts,walks,hits,home_runs,batters_faced,pitches,strikes) SELECT game_pk,game_date,player_id,player_name,team_id,team_name,season,is_starter,innings_pitched,earned_runs,strikeouts,walks,hits,home_runs,batters_faced,pitches,strikes FROM jsonb_populate_recordset(NULL::mlb_pitcher_gamelogs,rows)
 ON CONFLICT(game_pk,player_id) DO UPDATE SET game_date=EXCLUDED.game_date,player_name=EXCLUDED.player_name,team_id=EXCLUDED.team_id,team_name=EXCLUDED.team_name,season=EXCLUDED.season,is_starter=EXCLUDED.is_starter,innings_pitched=EXCLUDED.innings_pitched,earned_runs=EXCLUDED.earned_runs,strikeouts=EXCLUDED.strikeouts,walks=EXCLUDED.walks,hits=EXCLUDED.hits,home_runs=EXCLUDED.home_runs,batters_faced=EXCLUDED.batters_faced,pitches=EXCLUDED.pitches,strikes=EXCLUDED.strikes;
 SELECT count(*) INTO received FROM mlb_pitcher_gamelogs WHERE game_pk=gid;
 END IF;
 IF sport=11 THEN
 INSERT INTO pitcher_gamelogs(player_id,game_id,game_date,pitches,innings_pitched,strikeouts,base_on_balls,home_runs,earned_runs,team_id,is_home,is_starter) SELECT player_id,game_id,game_date,pitches,innings_pitched,strikeouts,base_on_balls,home_runs,earned_runs,team_id,is_home,is_starter FROM jsonb_populate_recordset(NULL::pitcher_gamelogs,rows)
 ON CONFLICT(game_id,player_id) DO UPDATE SET game_date=EXCLUDED.game_date,pitches=EXCLUDED.pitches,innings_pitched=EXCLUDED.innings_pitched,strikeouts=EXCLUDED.strikeouts,base_on_balls=EXCLUDED.base_on_balls,home_runs=EXCLUDED.home_runs,earned_runs=EXCLUDED.earned_runs,team_id=EXCLUDED.team_id,is_home=EXCLUDED.is_home,is_starter=EXCLUDED.is_starter ,updated_at=now();
 SELECT count(*) INTO received FROM pitcher_gamelogs WHERE game_id=gid;
 END IF;
 IF sport=23 THEN
 INSERT INTO lmb_pitcher_gamelogs(game_pk,game_date,season,player_id,player_name,team_id,team_name,is_home,is_starter,innings_pitched,earned_runs,strikeouts,walks,hits,home_runs,batters_faced,pitches) SELECT game_pk,game_date,season,player_id,player_name,team_id,team_name,is_home,is_starter,innings_pitched,earned_runs,strikeouts,walks,hits,home_runs,batters_faced,pitches FROM jsonb_populate_recordset(NULL::lmb_pitcher_gamelogs,rows)
 ON CONFLICT(game_pk,player_id) DO UPDATE SET game_date=EXCLUDED.game_date,season=EXCLUDED.season,player_name=EXCLUDED.player_name,team_id=EXCLUDED.team_id,team_name=EXCLUDED.team_name,is_home=EXCLUDED.is_home,is_starter=EXCLUDED.is_starter,innings_pitched=EXCLUDED.innings_pitched,earned_runs=EXCLUDED.earned_runs,strikeouts=EXCLUDED.strikeouts,walks=EXCLUDED.walks,hits=EXCLUDED.hits,home_runs=EXCLUDED.home_runs,batters_faced=EXCLUDED.batters_faced,pitches=EXCLUDED.pitches;
 SELECT count(*) INTO received FROM lmb_pitcher_gamelogs WHERE game_pk=gid;
 END IF;
 IF received<>n THEN RAISE EXCEPTION 'Saved rows do not match official boxscore'; END IF;
 INSERT INTO bb_postgame_receipts(sport_id,game_id,collector_version,source_url,expected_pitcher_ids,pitcher_rows,team_outs)
 VALUES(sport,gid,p->>'collector_version',p->>'source_url',p->'expected_pitcher_ids',n,p->'team_outs')
 ON CONFLICT(sport_id,game_id) DO UPDATE SET captured_at=now(),collector_version=EXCLUDED.collector_version,
 source_url=EXCLUDED.source_url,expected_pitcher_ids=EXCLUDED.expected_pitcher_ids,pitcher_rows=EXCLUDED.pitcher_rows,team_outs=EXCLUDED.team_outs;
 RETURN jsonb_build_object('sport_id',sport,'game_id',gid,'pitcher_rows',n,'complete',true);
END $fn$;
REVOKE ALL ON FUNCTION public.bb_ingest_postgame(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bb_ingest_postgame(jsonb) TO service_role;
CREATE OR REPLACE VIEW public.bb_postgame_missing WITH (security_invoker=true) AS
WITH games AS (
 SELECT 1 sport_id,game_pk game_id,game_date::timestamptz date FROM mlb_games WHERE home_score IS NOT NULL AND away_score IS NOT NULL AND status IN ('Final','Game Over','Completed Early') AND coalesce(game_type,'R') NOT IN ('S','E')
 UNION ALL SELECT 11,game_id,game_date FROM daily_games WHERE sport_id=11 AND home_score IS NOT NULL AND away_score IS NOT NULL AND status IN ('Final','Game Over','Completed Early') AND coalesce(game_type,'R') NOT IN ('S','E')
 UNION ALL SELECT 23,game_pk,game_date::timestamptz FROM lmb_games WHERE home_score IS NOT NULL AND away_score IS NOT NULL AND status IN ('Final','Game Over','Completed Early') AND coalesce(game_type,'R') NOT IN ('S','E')
) SELECT g.* FROM games g LEFT JOIN bb_postgame_receipts r USING(sport_id,game_id)
WHERE r.game_id IS NULL AND g.date>=date_trunc('year',now()) AND g.date<now();
REVOKE ALL ON public.bb_postgame_missing FROM anon,authenticated;
GRANT SELECT ON public.bb_postgame_missing TO service_role;
CREATE OR REPLACE FUNCTION public.bb_refresh_milb_park_factors(p_season integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE n integer;
BEGIN
 WITH eligible AS (
 SELECT venue_id,home_score+away_score runs FROM daily_games
 WHERE sport_id=11 AND extract(year from game_date)=p_season AND game_date<now()
 AND status IN ('Final','Game Over','Completed Early') AND scheduled_innings=9 AND home_score IS NOT NULL AND away_score IS NOT NULL
 ), league AS(SELECT avg(runs) runs FROM eligible), factors AS (
 SELECT venue_id,round(avg(e.runs)/nullif(l.runs,0)*100)::integer factor FROM eligible e CROSS JOIN league l
 WHERE venue_id IS NOT NULL GROUP BY venue_id,l.runs HAVING count(*)>=15)
 UPDATE park_factors p SET park_factor_runs=f.factor,updated_at=now() FROM factors f WHERE p.venue_id=f.venue_id AND f.factor IS NOT NULL;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN jsonb_build_object('updated_venues',n,'season',p_season,'nine_inning_final_games_only',true);
END $fn$;
REVOKE ALL ON FUNCTION public.bb_refresh_milb_park_factors(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bb_refresh_milb_park_factors(integer) TO service_role;
NOTIFY pgrst,'reload schema';
