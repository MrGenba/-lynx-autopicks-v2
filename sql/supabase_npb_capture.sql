CREATE TABLE IF NOT EXISTS public.npb_source_games (
 game_id text PRIMARY KEY,game_pk text UNIQUE NOT NULL,game_date date NOT NULL,season integer NOT NULL,game_kind integer NOT NULL,
 away_team text NOT NULL,home_team text NOT NULL,away_score integer,home_score integer,status text NOT NULL,
 game_time_local text,game_time timestamptz,venue_name text,away_starter text,home_starter text,away_starter_id text,home_starter_id text,
 source text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE npb_source_games ADD COLUMN IF NOT EXISTS scheduled_innings integer NOT NULL DEFAULT 9 CHECK(scheduled_innings=9);
CREATE TABLE IF NOT EXISTS public.npb_pitcher_gamelogs (
 game_id text REFERENCES npb_source_games,player_id text,team_abbr text,player_name text NOT NULL,game_date date NOT NULL,season integer NOT NULL,game_kind integer NOT NULL,
 appearance_no integer NOT NULL,is_starter boolean NOT NULL,outs integer NOT NULL CHECK(outs>=0),ip numeric NOT NULL,bf integer NOT NULL,pitches integer NOT NULL,
 h integer NOT NULL,hr integer NOT NULL,so integer NOT NULL,bb integer NOT NULL,hbp integer NOT NULL,runs integer NOT NULL,er integer NOT NULL,source text NOT NULL,
 PRIMARY KEY(game_id,team_abbr,player_id));
CREATE INDEX IF NOT EXISTS npb_pitcher_recent ON npb_pitcher_gamelogs(season,team_abbr,player_id,game_date DESC);
CREATE TABLE IF NOT EXISTS public.npb_batter_gamelogs (
 game_id text REFERENCES npb_source_games,player_id text,team_abbr text,player_name text NOT NULL,game_date date NOT NULL,season integer NOT NULL,game_kind integer NOT NULL,
 appearance_no integer NOT NULL,pa integer NOT NULL,ab integer NOT NULL,h integer NOT NULL,h2b integer NOT NULL,h3b integer NOT NULL,hr integer NOT NULL,so integer NOT NULL,
 bb integer NOT NULL,hbp integer NOT NULL,sac integer NOT NULL,sf integer NOT NULL,runs integer NOT NULL,rbi integer NOT NULL,sb integer NOT NULL,source text NOT NULL,
 PRIMARY KEY(game_id,team_abbr,player_id));
CREATE TABLE IF NOT EXISTS public.npb_postgame_ingestion (
 game_id text PRIMARY KEY REFERENCES npb_source_games,version text NOT NULL,pitcher_count integer NOT NULL,batter_count integer NOT NULL,pitch_count integer NOT NULL,
 expected_pitch_count integer NOT NULL,tracking_status text NOT NULL,source text NOT NULL,source_url text NOT NULL,pitches jsonb NOT NULL,captured_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.npb_capture_state(scope text PRIMARY KEY,checked_at timestamptz NOT NULL,status text NOT NULL,report jsonb NOT NULL);
ALTER TABLE npb_postgame_ingestion ADD COLUMN IF NOT EXISTS quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $block$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['npb_source_games','npb_pitcher_gamelogs','npb_batter_gamelogs','npb_postgame_ingestion','npb_capture_state'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT SELECT ON public.%I TO service_role',t);END LOOP;END $block$;
GRANT INSERT,UPDATE ON npb_capture_state TO service_role;
CREATE OR REPLACE FUNCTION public.npb_store_schedule(p_games jsonb) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE g npb_source_games;n integer:=0;BEGIN
 FOR g IN SELECT * FROM jsonb_populate_recordset(null::npb_source_games,p_games) LOOP
  IF g.game_id !~ '^\d{10}$' OR g.source IS DISTINCT FROM 'spaia.jp' OR g.game_kind NOT IN(1,2,3,26,35,36,37,38) OR g.away_team=g.home_team THEN RAISE EXCEPTION 'Invalid NPB schedule';END IF;
  g.updated_at:=now();g.scheduled_innings:=9;INSERT INTO npb_source_games SELECT g.* ON CONFLICT(game_id) DO UPDATE SET
   game_date=EXCLUDED.game_date,status=EXCLUDED.status,away_score=EXCLUDED.away_score,home_score=EXCLUDED.home_score,game_time_local=EXCLUDED.game_time_local,game_time=EXCLUDED.game_time,
   venue_name=coalesce(EXCLUDED.venue_name,npb_source_games.venue_name),away_starter=coalesce(EXCLUDED.away_starter,npb_source_games.away_starter),home_starter=coalesce(EXCLUDED.home_starter,npb_source_games.home_starter),
   away_starter_id=coalesce(EXCLUDED.away_starter_id,npb_source_games.away_starter_id),home_starter_id=coalesce(EXCLUDED.home_starter_id,npb_source_games.home_starter_id),updated_at=now()
   WHERE npb_source_games.status<>'final' OR EXCLUDED.status IN('final','cancelled');
  INSERT INTO npb_games(game_pk,game_id,game_date,season,away_team,home_team,away_score,home_score,status,game_time_local,game_time,away_starter,home_starter,venue_name)
   VALUES(g.game_pk,g.game_id,g.game_date,g.season,g.away_team,g.home_team,g.away_score,g.home_score,g.status,g.game_time_local,g.game_time,g.away_starter,g.home_starter,g.venue_name)
   ON CONFLICT(game_pk) DO UPDATE SET status=EXCLUDED.status,away_score=EXCLUDED.away_score,home_score=EXCLUDED.home_score,game_time_local=EXCLUDED.game_time_local,game_time=EXCLUDED.game_time,
    away_starter=coalesce(EXCLUDED.away_starter,npb_games.away_starter),home_starter=coalesce(EXCLUDED.home_starter,npb_games.home_starter),venue_name=coalesce(EXCLUDED.venue_name,npb_games.venue_name),updated_at=now()
   WHERE npb_games.status<>'final' OR EXCLUDED.status IN('final','cancelled');n:=n+1;
 END LOOP;RETURN n;END $fn$;
CREATE OR REPLACE FUNCTION public.npb_ingest_boxscore(p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE gid text:=p_payload->'game'->>'game_id';p jsonb;n integer;m integer;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(gid,104));
 IF p_payload->'game'->>'status' IS DISTINCT FROM 'final' OR jsonb_array_length(p_payload->'pitchers')<2 OR jsonb_array_length(p_payload->'batters')<18 THEN RAISE EXCEPTION 'Complete final required';END IF;
 PERFORM npb_store_schedule(jsonb_build_array(p_payload->'game'));
 DELETE FROM npb_pitcher_gamelogs WHERE game_id=gid;DELETE FROM npb_batter_gamelogs WHERE game_id=gid;
 FOR p IN SELECT value FROM jsonb_array_elements(p_payload->'pitchers') LOOP
  IF p->>'game_id' IS DISTINCT FROM gid OR p->>'source' IS DISTINCT FROM 'spaia.jp' OR abs((p->>'ip')::numeric-(p->>'outs')::numeric/3)>0.00001 THEN RAISE EXCEPTION 'Invalid pitcher row';END IF;
  INSERT INTO npb_pitcher_gamelogs SELECT r.* FROM jsonb_populate_record(null::npb_pitcher_gamelogs,p)r;
 END LOOP;
 FOR p IN SELECT value FROM jsonb_array_elements(p_payload->'batters') LOOP
  IF p->>'game_id' IS DISTINCT FROM gid OR p->>'source' IS DISTINCT FROM 'spaia.jp' OR (p->>'h')::int>(p->>'ab')::int THEN RAISE EXCEPTION 'Invalid batter row';END IF;
  INSERT INTO npb_batter_gamelogs SELECT r.* FROM jsonb_populate_record(null::npb_batter_gamelogs,p)r;
 END LOOP;
 SELECT count(*) INTO n FROM npb_pitcher_gamelogs WHERE game_id=gid;SELECT count(*) INTO m FROM npb_batter_gamelogs WHERE game_id=gid;
 IF n IS DISTINCT FROM (p_payload->'receipt'->>'pitcher_count')::int OR m IS DISTINCT FROM (p_payload->'receipt'->>'batter_count')::int OR jsonb_array_length(p_payload->'pitches') IS DISTINCT FROM (p_payload->'receipt'->>'pitch_count')::int THEN RAISE EXCEPTION 'Receipt mismatch';END IF;
 INSERT INTO npb_postgame_ingestion SELECT r.* FROM jsonb_populate_record(null::npb_postgame_ingestion,p_payload->'receipt'||jsonb_build_object('game_id',gid,'pitches',p_payload->'pitches','captured_at',now()))r
 ON CONFLICT(game_id) DO UPDATE SET version=EXCLUDED.version,pitcher_count=EXCLUDED.pitcher_count,batter_count=EXCLUDED.batter_count,pitch_count=EXCLUDED.pitch_count,expected_pitch_count=EXCLUDED.expected_pitch_count,
  tracking_status=EXCLUDED.tracking_status,pitches=EXCLUDED.pitches,quality_flags=EXCLUDED.quality_flags,captured_at=now();
 RETURN jsonb_build_object('game_id',gid,'pitchers',n,'batters',m);END $fn$;
CREATE OR REPLACE VIEW npb_pitcher_season_current WITH(security_invoker=true) AS
WITH p AS(SELECT p.* FROM npb_pitcher_gamelogs p JOIN npb_source_games g USING(game_id) WHERE g.status='final' AND g.game_kind IN(1,2,26)),
 league AS(SELECT season,(sum(er)*9-13*sum(hr)-3*(sum(bb)+sum(hbp))+2*sum(so))*3.0/nullif(sum(outs),0) fip_constant FROM p GROUP BY season)
SELECT p.season,p.team_abbr,p.player_id,max(player_name) player_name,count(*) games,count(*) FILTER(WHERE is_starter) starts,sum(outs) outs,sum(outs)/3.0 pa_or_ip,
 sum(er)*27.0/nullif(sum(outs),0) era,(13*sum(hr)+3*(sum(bb)+sum(hbp))-2*sum(so))*3.0/nullif(sum(outs),0)+max(fip_constant) fip,
 (sum(h)+sum(bb))*3.0/nullif(sum(outs),0) whip,sum(so)*27.0/nullif(sum(outs),0) k_9,sum(bb)*27.0/nullif(sum(outs),0) bb_9,
 sum(so)::numeric/nullif(sum(bf),0) k_pct,sum(bb)::numeric/nullif(sum(bf),0) bb_pct,sum(h) h,sum(hr) hr,sum(bb) bb,sum(hbp) hbp,sum(so) so,sum(er) er,max(game_date) data_through
FROM p JOIN league USING(season) GROUP BY p.season,p.team_abbr,p.player_id;
CREATE OR REPLACE VIEW npb_batter_season_current WITH(security_invoker=true) AS
SELECT b.season,b.team_abbr,b.player_id,max(player_name) player_name,count(*) games,sum(pa) pa_or_ip,sum(h)::numeric/nullif(sum(ab),0) avg,
 (sum(h)+sum(bb)+sum(hbp))::numeric/nullif(sum(ab)+sum(bb)+sum(hbp)+sum(sf),0) obp,
 (sum(h)+sum(h2b)+2*sum(h3b)+3*sum(hr))::numeric/nullif(sum(ab),0) slg,sum(h) h,sum(hr) hr,sum(bb) bb,sum(so) so,max(b.game_date) data_through
FROM npb_batter_gamelogs b JOIN npb_source_games g USING(game_id) WHERE g.status='final' AND g.game_kind IN(1,2,26) GROUP BY b.season,b.team_abbr,b.player_id;
CREATE OR REPLACE VIEW npb_capture_health WITH(security_invoker=true) AS
SELECT g.season,count(*) FILTER(WHERE status='final') final_games,count(r.game_id) receipts,count(*) FILTER(WHERE status='final' AND r.game_id IS NULL) pending_games,
 max(g.game_date) FILTER(WHERE status='final') latest_final,max(g.game_date) FILTER(WHERE r.game_id IS NOT NULL) latest_ingested,
 sum(r.pitcher_count) pitcher_rows,sum(r.batter_count) batter_rows,sum(r.pitch_count) pitch_rows,count(*) FILTER(WHERE r.tracking_status='PARTIAL') tracking_partial_games
FROM npb_source_games g LEFT JOIN npb_postgame_ingestion r USING(game_id) GROUP BY g.season;
-- SPAIA zero speed means unmeasured, not a 0 km/h pitch. Keep the observation.
UPDATE npb_postgame_ingestion r SET pitches=(SELECT jsonb_agg(CASE WHEN (p->>'velocity_kmh')::numeric=0 THEN jsonb_set(p,'{velocity_kmh}','null') ELSE p END ORDER BY n) FROM jsonb_array_elements(r.pitches) WITH ORDINALITY a(p,n))
 WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(r.pitches)p WHERE (p->>'velocity_kmh')::numeric=0);
CREATE OR REPLACE VIEW npb_pitch_profiles WITH(security_invoker=true) AS
SELECT g.season,p->>'pitcher_id' player_id,(p->>'kind')::int pitch_type_code,count(*) pitches,count(p->>'velocity_kmh') velocity_observations,
 avg((p->>'velocity_kmh')::numeric) velocity_kmh,max((p->>'velocity_kmh')::numeric) max_velocity_kmh,max(g.game_date) data_through
FROM npb_postgame_ingestion r JOIN npb_source_games g USING(game_id),LATERAL jsonb_array_elements(r.pitches)p
WHERE g.status='final' AND p->>'kind' IS NOT NULL GROUP BY g.season,p->>'pitcher_id',p->>'kind';
ALTER TABLE npb_player_stats ADD COLUMN IF NOT EXISTS source text DEFAULT 'legacy_unverified',ADD COLUMN IF NOT EXISTS source_player_id text,
 ADD COLUMN IF NOT EXISTS source_url text,ADD COLUMN IF NOT EXISTS source_as_of date,ADD COLUMN IF NOT EXISTS source_checked_at timestamptz;
CREATE OR REPLACE FUNCTION npb_refresh_player_stats(p_season integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE pit integer;bat integer;BEGIN
 IF NOT EXISTS(SELECT 1 FROM npb_capture_health WHERE season=p_season AND final_games>0 AND pending_games=0) THEN RAISE EXCEPTION 'NPB capture incomplete';END IF;
 UPDATE npb_player_stats SET source='legacy_unverified' WHERE season=p_season;
 INSERT INTO npb_player_stats(player_name,team_abbr,season,stats_type,games,starts,pa_or_ip,era,fip,siera,whip,k_pct,bb_pct,k_9,bb_9,hr9,h_raw,hr_raw,bb_raw,k_raw,er_raw,is_reliever,updated_at,source,source_player_id,source_url,source_as_of,source_checked_at)
 SELECT player_name,team_abbr,season,'pitching',games,starts,pa_or_ip,era,fip,null,whip,k_pct,bb_pct,k_9,bb_9,hr*27.0/nullif(outs,0),h,hr,bb,so,er,starts=0,now(),'spaia.jp',player_id,'https://spaia.jp/baseball/npb',data_through,now()
 FROM npb_pitcher_season_current p WHERE season=p_season AND NOT EXISTS(SELECT 1 FROM npb_pitcher_season_current q WHERE q.season=p.season AND q.team_abbr=p.team_abbr AND q.player_name=p.player_name AND q.player_id<>p.player_id)
 ON CONFLICT(player_name,team_abbr,season,stats_type) DO UPDATE SET games=EXCLUDED.games,starts=EXCLUDED.starts,pa_or_ip=EXCLUDED.pa_or_ip,era=EXCLUDED.era,fip=EXCLUDED.fip,siera=null,whip=EXCLUDED.whip,k_pct=EXCLUDED.k_pct,bb_pct=EXCLUDED.bb_pct,k_9=EXCLUDED.k_9,bb_9=EXCLUDED.bb_9,hr9=EXCLUDED.hr9,h_raw=EXCLUDED.h_raw,hr_raw=EXCLUDED.hr_raw,bb_raw=EXCLUDED.bb_raw,k_raw=EXCLUDED.k_raw,er_raw=EXCLUDED.er_raw,is_reliever=EXCLUDED.is_reliever,babip=null,lob_pct=null,updated_at=now(),source=EXCLUDED.source,source_player_id=EXCLUDED.source_player_id,source_url=EXCLUDED.source_url,source_as_of=EXCLUDED.source_as_of,source_checked_at=now();GET DIAGNOSTICS pit=ROW_COUNT;
 INSERT INTO npb_player_stats(player_name,team_abbr,season,stats_type,games,pa_or_ip,avg,obp,slg,ops,woba,hr,h_raw,hr_raw,bb_raw,k_raw,updated_at,source,source_player_id,source_url,source_as_of,source_checked_at)
 SELECT player_name,team_abbr,season,'batting',games,pa_or_ip,avg,obp,slg,obp+slg,null,hr,h,hr,bb,so,now(),'spaia.jp',player_id,'https://spaia.jp/baseball/npb',data_through,now()
 FROM npb_batter_season_current b WHERE season=p_season AND NOT EXISTS(SELECT 1 FROM npb_batter_season_current q WHERE q.season=b.season AND q.team_abbr=b.team_abbr AND q.player_name=b.player_name AND q.player_id<>b.player_id)
 ON CONFLICT(player_name,team_abbr,season,stats_type) DO UPDATE SET games=EXCLUDED.games,pa_or_ip=EXCLUDED.pa_or_ip,avg=EXCLUDED.avg,obp=EXCLUDED.obp,slg=EXCLUDED.slg,ops=EXCLUDED.ops,woba=null,hr=EXCLUDED.hr,h_raw=EXCLUDED.h_raw,hr_raw=EXCLUDED.hr_raw,bb_raw=EXCLUDED.bb_raw,k_raw=EXCLUDED.k_raw,updated_at=now(),source=EXCLUDED.source,source_player_id=EXCLUDED.source_player_id,source_url=EXCLUDED.source_url,source_as_of=EXCLUDED.source_as_of,source_checked_at=now();GET DIAGNOSTICS bat=ROW_COUNT;
 RETURN jsonb_build_object('pitching',pit,'batting',bat);END $fn$;
REVOKE ALL ON FUNCTION npb_store_schedule(jsonb),npb_ingest_boxscore(jsonb),npb_refresh_player_stats(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION npb_store_schedule(jsonb),npb_ingest_boxscore(jsonb),npb_refresh_player_stats(integer) TO service_role;
REVOKE ALL ON npb_pitcher_season_current,npb_batter_season_current,npb_capture_health,npb_pitch_profiles FROM PUBLIC,anon,authenticated;
GRANT SELECT ON npb_pitcher_season_current,npb_batter_season_current,npb_capture_health,npb_pitch_profiles TO service_role;
NOTIFY pgrst,'reload schema';
