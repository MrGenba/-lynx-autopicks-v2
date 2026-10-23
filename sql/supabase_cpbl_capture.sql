-- Official CPBL boxscores and public Trackman observations.
ALTER TABLE cpbl_games ADD COLUMN IF NOT EXISTS game_id text, ADD COLUMN IF NOT EXISTS game_time timestamptz;
ALTER TABLE cpbl_player_stats ADD COLUMN IF NOT EXISTS obp numeric,ADD COLUMN IF NOT EXISTS slg numeric,ADD COLUMN IF NOT EXISTS ops numeric;
CREATE TABLE IF NOT EXISTS public.cpbl_source_games (
 game_id text PRIMARY KEY,game_pk text UNIQUE NOT NULL,game_date date NOT NULL,season integer NOT NULL,game_kind text NOT NULL,
 away_team text NOT NULL,home_team text NOT NULL,away_score integer,home_score integer,status text NOT NULL,
 game_time_local text,game_time timestamptz,venue_name text,away_starter text,home_starter text,away_starter_id text,home_starter_id text,
 source text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE cpbl_source_games ADD COLUMN IF NOT EXISTS scheduled_innings integer NOT NULL DEFAULT 9 CHECK(scheduled_innings=9);
CREATE TABLE IF NOT EXISTS public.cpbl_pitcher_gamelogs (
 game_id text REFERENCES cpbl_source_games,player_id text,team_abbr text,player_name text NOT NULL,game_date date NOT NULL,season integer NOT NULL,game_kind text NOT NULL,
 appearance_no integer NOT NULL,is_starter boolean NOT NULL,outs integer NOT NULL CHECK(outs>=0),ip numeric NOT NULL,bf integer NOT NULL,pitches integer NOT NULL,
 h integer NOT NULL,hr integer NOT NULL,so integer NOT NULL,bb integer NOT NULL,hbp integer NOT NULL,runs integer NOT NULL,er integer NOT NULL,source text NOT NULL,
 PRIMARY KEY(game_id,team_abbr,player_id));
CREATE INDEX IF NOT EXISTS cpbl_pitcher_recent ON cpbl_pitcher_gamelogs(season,team_abbr,player_id,game_date DESC);
CREATE TABLE IF NOT EXISTS public.cpbl_batter_gamelogs (
 game_id text REFERENCES cpbl_source_games,player_id text,team_abbr text,player_name text NOT NULL,game_date date NOT NULL,season integer NOT NULL,game_kind text NOT NULL,
 appearance_no integer NOT NULL,pa integer NOT NULL,ab integer NOT NULL,h integer NOT NULL,h2b integer NOT NULL,h3b integer NOT NULL,hr integer NOT NULL,so integer NOT NULL,
 bb integer NOT NULL,hbp integer NOT NULL,sac integer NOT NULL,sf integer NOT NULL,runs integer NOT NULL,rbi integer NOT NULL,sb integer NOT NULL,source text NOT NULL,
 PRIMARY KEY(game_id,team_abbr,player_id));
CREATE TABLE IF NOT EXISTS public.cpbl_postgame_ingestion (
 game_id text PRIMARY KEY REFERENCES cpbl_source_games,version text NOT NULL,pitcher_count integer NOT NULL,batter_count integer NOT NULL,pitch_count integer NOT NULL,
 expected_pitch_count integer NOT NULL,tracking_status text NOT NULL,source text NOT NULL,source_url text NOT NULL,pitches jsonb NOT NULL,captured_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.cpbl_capture_state(scope text PRIMARY KEY,checked_at timestamptz NOT NULL,status text NOT NULL,report jsonb NOT NULL);
ALTER TABLE cpbl_postgame_ingestion ADD COLUMN IF NOT EXISTS quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb,ADD COLUMN IF NOT EXISTS velocity_count integer NOT NULL DEFAULT 0,ADD COLUMN IF NOT EXISTS spin_count integer NOT NULL DEFAULT 0,ADD COLUMN IF NOT EXISTS batted_ball_count integer NOT NULL DEFAULT 0;
DO $block$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['cpbl_source_games','cpbl_pitcher_gamelogs','cpbl_batter_gamelogs','cpbl_postgame_ingestion','cpbl_capture_state'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT SELECT ON public.%I TO service_role',t);END LOOP;END $block$;
GRANT INSERT,UPDATE ON cpbl_capture_state TO service_role;
CREATE OR REPLACE FUNCTION public.cpbl_store_schedule(p_games jsonb) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE g cpbl_source_games;n integer:=0;BEGIN
 FOR g IN SELECT * FROM jsonb_populate_recordset(null::cpbl_source_games,p_games) LOOP
  IF g.game_id !~ '^20\d{2}-[ACE]-\d+$' OR g.source IS DISTINCT FROM 'stats.cpbl.com.tw' OR g.game_kind NOT IN('A','C','E') OR g.away_team=g.home_team THEN RAISE EXCEPTION 'Invalid CPBL schedule';END IF;
  g.updated_at:=now();g.scheduled_innings:=9;INSERT INTO cpbl_source_games SELECT g.* ON CONFLICT(game_id) DO UPDATE SET
   game_date=EXCLUDED.game_date,status=EXCLUDED.status,away_score=EXCLUDED.away_score,home_score=EXCLUDED.home_score,game_time_local=EXCLUDED.game_time_local,game_time=EXCLUDED.game_time,
   venue_name=coalesce(EXCLUDED.venue_name,cpbl_source_games.venue_name),away_starter=coalesce(EXCLUDED.away_starter,cpbl_source_games.away_starter),home_starter=coalesce(EXCLUDED.home_starter,cpbl_source_games.home_starter),
   away_starter_id=coalesce(EXCLUDED.away_starter_id,cpbl_source_games.away_starter_id),home_starter_id=coalesce(EXCLUDED.home_starter_id,cpbl_source_games.home_starter_id),updated_at=now()
   WHERE cpbl_source_games.status<>'final' OR EXCLUDED.status IN('final','cancelled');
  INSERT INTO cpbl_games(game_pk,game_id,game_date,season,away_team,home_team,away_score,home_score,status,game_time_local,game_time,away_starter,home_starter,venue_name)
   VALUES(g.game_pk,g.game_id,g.game_date,g.season,g.away_team,g.home_team,g.away_score,g.home_score,g.status,g.game_time_local,g.game_time,g.away_starter,g.home_starter,g.venue_name)
   ON CONFLICT(game_pk) DO UPDATE SET game_date=EXCLUDED.game_date,game_id=EXCLUDED.game_id,status=EXCLUDED.status,away_score=EXCLUDED.away_score,home_score=EXCLUDED.home_score,game_time_local=EXCLUDED.game_time_local,game_time=EXCLUDED.game_time,
    away_starter=coalesce(EXCLUDED.away_starter,cpbl_games.away_starter),home_starter=coalesce(EXCLUDED.home_starter,cpbl_games.home_starter),venue_name=coalesce(EXCLUDED.venue_name,cpbl_games.venue_name),updated_at=now()
   WHERE cpbl_games.status<>'final' OR EXCLUDED.status IN('final','cancelled');n:=n+1;
 END LOOP;RETURN n;END $fn$;
CREATE OR REPLACE FUNCTION public.cpbl_ingest_boxscore(p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE gid text:=p_payload->'game'->>'game_id';p jsonb;n integer;m integer;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(gid,104));
 IF p_payload->'game'->>'status' IS DISTINCT FROM 'final' OR jsonb_array_length(p_payload->'pitchers')<2 OR jsonb_array_length(p_payload->'batters')<18 THEN RAISE EXCEPTION 'Complete final required';END IF;
 PERFORM cpbl_store_schedule(jsonb_build_array(p_payload->'game'));
 DELETE FROM cpbl_pitcher_gamelogs WHERE game_id=gid;DELETE FROM cpbl_batter_gamelogs WHERE game_id=gid;
 FOR p IN SELECT value FROM jsonb_array_elements(p_payload->'pitchers') LOOP
  IF p->>'game_id' IS DISTINCT FROM gid OR p->>'source' IS DISTINCT FROM 'stats.cpbl.com.tw' OR abs((p->>'ip')::numeric-(p->>'outs')::numeric/3)>0.00001 THEN RAISE EXCEPTION 'Invalid pitcher row';END IF;
  INSERT INTO cpbl_pitcher_gamelogs SELECT r.* FROM jsonb_populate_record(null::cpbl_pitcher_gamelogs,p)r;
 END LOOP;
 FOR p IN SELECT value FROM jsonb_array_elements(p_payload->'batters') LOOP
  IF p->>'game_id' IS DISTINCT FROM gid OR p->>'source' IS DISTINCT FROM 'stats.cpbl.com.tw' OR (p->>'h')::int>(p->>'ab')::int THEN RAISE EXCEPTION 'Invalid batter row';END IF;
  INSERT INTO cpbl_batter_gamelogs SELECT r.* FROM jsonb_populate_record(null::cpbl_batter_gamelogs,p)r;
 END LOOP;
 SELECT count(*) INTO n FROM cpbl_pitcher_gamelogs WHERE game_id=gid;SELECT count(*) INTO m FROM cpbl_batter_gamelogs WHERE game_id=gid;
 IF n IS DISTINCT FROM (p_payload->'receipt'->>'pitcher_count')::int OR m IS DISTINCT FROM (p_payload->'receipt'->>'batter_count')::int OR jsonb_array_length(p_payload->'pitches') IS DISTINCT FROM (p_payload->'receipt'->>'pitch_count')::int THEN RAISE EXCEPTION 'Receipt mismatch';END IF;
 INSERT INTO cpbl_postgame_ingestion SELECT r.* FROM jsonb_populate_record(null::cpbl_postgame_ingestion,p_payload->'receipt'||jsonb_build_object('game_id',gid,'pitches',p_payload->'pitches','captured_at',now()))r
 ON CONFLICT(game_id) DO UPDATE SET version=EXCLUDED.version,pitcher_count=EXCLUDED.pitcher_count,batter_count=EXCLUDED.batter_count,pitch_count=EXCLUDED.pitch_count,expected_pitch_count=EXCLUDED.expected_pitch_count,
  tracking_status=EXCLUDED.tracking_status,velocity_count=EXCLUDED.velocity_count,spin_count=EXCLUDED.spin_count,batted_ball_count=EXCLUDED.batted_ball_count,pitches=EXCLUDED.pitches,quality_flags=EXCLUDED.quality_flags,captured_at=now();
 RETURN jsonb_build_object('game_id',gid,'pitchers',n,'batters',m);END $fn$;
CREATE OR REPLACE VIEW cpbl_pitcher_season_current WITH(security_invoker=true) AS
WITH p AS(SELECT p.* FROM cpbl_pitcher_gamelogs p JOIN cpbl_source_games g USING(game_id) WHERE g.status='final' AND g.game_kind ='A'),
 league AS(SELECT season,(sum(er)*9-13*sum(hr)-3*(sum(bb)+sum(hbp))+2*sum(so))*3.0/nullif(sum(outs),0) fip_constant FROM p GROUP BY season)
SELECT p.season,p.team_abbr,p.player_id,max(player_name) player_name,count(*) games,count(*) FILTER(WHERE is_starter) starts,sum(outs) outs,sum(outs)/3.0 pa_or_ip,
 sum(er)*27.0/nullif(sum(outs),0) era,(13*sum(hr)+3*(sum(bb)+sum(hbp))-2*sum(so))*3.0/nullif(sum(outs),0)+max(fip_constant) fip,
 (sum(h)+sum(bb))*3.0/nullif(sum(outs),0) whip,sum(so)*27.0/nullif(sum(outs),0) k_9,sum(bb)*27.0/nullif(sum(outs),0) bb_9,
 sum(so)::numeric/nullif(sum(bf),0) k_pct,sum(bb)::numeric/nullif(sum(bf),0) bb_pct,sum(h) h,sum(hr) hr,sum(bb) bb,sum(hbp) hbp,sum(so) so,sum(er) er,max(game_date) data_through
FROM p JOIN league USING(season) GROUP BY p.season,p.team_abbr,p.player_id;
CREATE OR REPLACE VIEW cpbl_batter_season_current WITH(security_invoker=true) AS
SELECT b.season,b.team_abbr,b.player_id,max(player_name) player_name,count(*) games,sum(pa) pa_or_ip,sum(h)::numeric/nullif(sum(ab),0) avg,
 (sum(h)+sum(bb)+sum(hbp))::numeric/nullif(sum(ab)+sum(bb)+sum(hbp)+sum(sf),0) obp,
 (sum(h)+sum(h2b)+2*sum(h3b)+3*sum(hr))::numeric/nullif(sum(ab),0) slg,sum(h) h,sum(hr) hr,sum(bb) bb,sum(so) so,max(b.game_date) data_through
FROM cpbl_batter_gamelogs b JOIN cpbl_source_games g USING(game_id) WHERE g.status='final' AND g.game_kind ='A' GROUP BY b.season,b.team_abbr,b.player_id;
CREATE OR REPLACE VIEW cpbl_capture_health WITH(security_invoker=true) AS
SELECT g.season,count(*) FILTER(WHERE status='final') final_games,count(r.game_id) receipts,count(*) FILTER(WHERE status='final' AND r.game_id IS NULL) pending_games,
 max(g.game_date) FILTER(WHERE status='final') latest_final,max(g.game_date) FILTER(WHERE r.game_id IS NOT NULL) latest_ingested,
 sum(r.velocity_count) velocity_observations,sum(r.spin_count) spin_observations,sum(r.batted_ball_count) batted_ball_observations,sum(r.pitcher_count) pitcher_rows,sum(r.batter_count) batter_rows,sum(r.pitch_count) pitch_rows,count(*) FILTER(WHERE r.tracking_status='PARTIAL') tracking_partial_games
FROM cpbl_source_games g LEFT JOIN cpbl_postgame_ingestion r USING(game_id) GROUP BY g.season;
-- Zero speed is unmeasured, not a physical zero-speed pitch.
UPDATE cpbl_postgame_ingestion r SET pitches=(SELECT jsonb_agg(CASE WHEN (p->>'velocity_kmh')::numeric=0 THEN jsonb_set(p,'{velocity_kmh}','null') ELSE p END ORDER BY n) FROM jsonb_array_elements(r.pitches) WITH ORDINALITY a(p,n))
 WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(r.pitches)p WHERE (p->>'velocity_kmh')::numeric=0);
CREATE OR REPLACE VIEW cpbl_pitch_profiles WITH(security_invoker=true) AS
SELECT g.season,p->>'pitcher_id' player_id,p->>'kind' pitch_type_code,count(*) pitches,count(p->>'velocity_kmh') velocity_observations,
 avg((p->>'velocity_kmh')::numeric) velocity_kmh,max((p->>'velocity_kmh')::numeric) max_velocity_kmh,count(p->>'spin_rate') spin_observations,avg((p->>'spin_rate')::numeric) spin_rate,max(g.game_date) data_through
FROM cpbl_postgame_ingestion r JOIN cpbl_source_games g USING(game_id),LATERAL jsonb_array_elements(r.pitches)p
WHERE g.status='final' AND p->>'kind' IS NOT NULL GROUP BY g.season,p->>'pitcher_id',p->>'kind';
ALTER TABLE cpbl_player_stats ADD COLUMN IF NOT EXISTS source text DEFAULT 'legacy_unverified',ADD COLUMN IF NOT EXISTS source_player_id text,
 ADD COLUMN IF NOT EXISTS source_url text,ADD COLUMN IF NOT EXISTS source_as_of date,ADD COLUMN IF NOT EXISTS source_checked_at timestamptz;
CREATE OR REPLACE FUNCTION cpbl_refresh_player_stats(p_season integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE pit integer;bat integer;BEGIN
 IF NOT EXISTS(SELECT 1 FROM cpbl_capture_health WHERE season=p_season AND final_games>0 AND pending_games=0) THEN RAISE EXCEPTION 'CPBL capture incomplete';END IF;
 UPDATE cpbl_player_stats SET source='legacy_unverified' WHERE season=p_season;
 INSERT INTO cpbl_player_stats(player_name,team_abbr,season,stats_type,games,starts,pa_or_ip,era,fip,siera,whip,k_pct,bb_pct,k_9,bb_9,hr9,h_raw,hr_raw,bb_raw,k_raw,er_raw,is_reliever,updated_at,source,source_player_id,source_url,source_as_of,source_checked_at)
 SELECT player_name,team_abbr,season,'pitching',games,starts,pa_or_ip,era,fip,null,whip,k_pct,bb_pct,k_9,bb_9,hr*27.0/nullif(outs,0),h,hr,bb,so,er,starts=0,now(),'stats.cpbl.com.tw',player_id,'https://stats.cpbl.com.tw',data_through,now()
 FROM cpbl_pitcher_season_current p WHERE season=p_season AND NOT EXISTS(SELECT 1 FROM cpbl_pitcher_season_current q WHERE q.season=p.season AND q.team_abbr=p.team_abbr AND q.player_name=p.player_name AND q.player_id<>p.player_id)
 ON CONFLICT(player_name,team_abbr,season,stats_type) DO UPDATE SET games=EXCLUDED.games,starts=EXCLUDED.starts,pa_or_ip=EXCLUDED.pa_or_ip,era=EXCLUDED.era,fip=EXCLUDED.fip,siera=null,whip=EXCLUDED.whip,k_pct=EXCLUDED.k_pct,bb_pct=EXCLUDED.bb_pct,k_9=EXCLUDED.k_9,bb_9=EXCLUDED.bb_9,hr9=EXCLUDED.hr9,h_raw=EXCLUDED.h_raw,hr_raw=EXCLUDED.hr_raw,bb_raw=EXCLUDED.bb_raw,k_raw=EXCLUDED.k_raw,er_raw=EXCLUDED.er_raw,is_reliever=EXCLUDED.is_reliever,babip=null,lob_pct=null,updated_at=now(),source=EXCLUDED.source,source_player_id=EXCLUDED.source_player_id,source_url=EXCLUDED.source_url,source_as_of=EXCLUDED.source_as_of,source_checked_at=now();GET DIAGNOSTICS pit=ROW_COUNT;
 INSERT INTO cpbl_player_stats(player_name,team_abbr,season,stats_type,games,pa_or_ip,avg,obp,slg,ops,woba,hr,h_raw,hr_raw,bb_raw,k_raw,updated_at,source,source_player_id,source_url,source_as_of,source_checked_at)
 SELECT player_name,team_abbr,season,'batting',games,pa_or_ip,avg,obp,slg,obp+slg,null,hr,h,hr,bb,so,now(),'stats.cpbl.com.tw',player_id,'https://stats.cpbl.com.tw',data_through,now()
 FROM cpbl_batter_season_current b WHERE season=p_season AND NOT EXISTS(SELECT 1 FROM cpbl_batter_season_current q WHERE q.season=b.season AND q.team_abbr=b.team_abbr AND q.player_name=b.player_name AND q.player_id<>b.player_id)
 ON CONFLICT(player_name,team_abbr,season,stats_type) DO UPDATE SET games=EXCLUDED.games,pa_or_ip=EXCLUDED.pa_or_ip,avg=EXCLUDED.avg,obp=EXCLUDED.obp,slg=EXCLUDED.slg,ops=EXCLUDED.ops,woba=null,hr=EXCLUDED.hr,h_raw=EXCLUDED.h_raw,hr_raw=EXCLUDED.hr_raw,bb_raw=EXCLUDED.bb_raw,k_raw=EXCLUDED.k_raw,updated_at=now(),source=EXCLUDED.source,source_player_id=EXCLUDED.source_player_id,source_url=EXCLUDED.source_url,source_as_of=EXCLUDED.source_as_of,source_checked_at=now();GET DIAGNOSTICS bat=ROW_COUNT;
 RETURN jsonb_build_object('pitching',pit,'batting',bat);END $fn$;
REVOKE ALL ON FUNCTION cpbl_store_schedule(jsonb),cpbl_ingest_boxscore(jsonb),cpbl_refresh_player_stats(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION cpbl_store_schedule(jsonb),cpbl_ingest_boxscore(jsonb),cpbl_refresh_player_stats(integer) TO service_role;
REVOKE ALL ON cpbl_pitcher_season_current,cpbl_batter_season_current,cpbl_capture_health,cpbl_pitch_profiles FROM PUBLIC,anon,authenticated;
GRANT SELECT ON cpbl_pitcher_season_current,cpbl_batter_season_current,cpbl_capture_health,cpbl_pitch_profiles TO service_role;
NOTIFY pgrst,'reload schema';
