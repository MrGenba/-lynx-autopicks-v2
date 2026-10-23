-- Official KBO boxscores, kept separately from unverified legacy summaries.
CREATE TABLE IF NOT EXISTS public.kbo_official_games (
 game_id text PRIMARY KEY,game_pk text NOT NULL UNIQUE,game_date date NOT NULL,season integer NOT NULL,series_id integer NOT NULL,
 away_team text NOT NULL,home_team text NOT NULL,venue_name text,game_time_kst text,game_start timestamptz,
 status text NOT NULL CHECK(status IN('scheduled','live','final','cancelled')),away_score integer,home_score integer,
 away_starter text,home_starter text,away_starter_id bigint,home_starter_id bigint,source text NOT NULL,raw_schedule jsonb NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.kbo_pitcher_gamelogs
 ADD COLUMN IF NOT EXISTS game_id text REFERENCES kbo_official_games,
 ADD COLUMN IF NOT EXISTS series_id integer,
 ADD COLUMN IF NOT EXISTS player_id bigint,
 ADD COLUMN IF NOT EXISTS appearance_no integer,
 ADD COLUMN IF NOT EXISTS is_starter boolean,
 ADD COLUMN IF NOT EXISTS outs integer CHECK(outs>=0),
 ADD COLUMN IF NOT EXISTS bf integer,
 ADD COLUMN IF NOT EXISTS pitches integer,
 ADD COLUMN IF NOT EXISTS ab integer,
 ADD COLUMN IF NOT EXISTS bb_hbp integer,
 ADD COLUMN IF NOT EXISTS runs integer,
 ADD COLUMN IF NOT EXISTS source text,
 ADD COLUMN IF NOT EXISTS raw_cells jsonb,
 ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
DO $do$ DECLARE c record;BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.kbo_pitcher_gamelogs'::regclass AND contype='u'
 AND pg_get_constraintdef(oid)='UNIQUE (player_name, team_abbr, game_date)' LOOP
 EXECUTE format('ALTER TABLE public.kbo_pitcher_gamelogs DROP CONSTRAINT %I',c.conname);END LOOP;
END $do$;
CREATE UNIQUE INDEX IF NOT EXISTS kbo_pitcher_game_appearance ON kbo_pitcher_gamelogs(game_id,team_abbr,appearance_no);
CREATE INDEX IF NOT EXISTS kbo_pitcher_recent ON kbo_pitcher_gamelogs(season,team_abbr,player_name,game_date DESC);
CREATE TABLE IF NOT EXISTS public.kbo_batter_gamelogs (
 game_id text REFERENCES kbo_official_games,team_abbr text,appearance_no integer,game_date date NOT NULL,season integer NOT NULL,series_id integer NOT NULL,
 player_name text NOT NULL,batting_order integer,position text,pa integer,ab integer,h integer,h1b integer,h2b integer,h3b integer,
 hr integer,bb integer,ibb integer,hbp integer,so integer,sac integer,sf integer,ci integer,rbi integer,runs integer,
 events jsonb NOT NULL,source text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(game_id,team_abbr,appearance_no));
CREATE TABLE IF NOT EXISTS public.kbo_postgame_ingestion (
 game_id text PRIMARY KEY REFERENCES kbo_official_games,collector_version text NOT NULL,pitcher_count integer NOT NULL,
 batter_count integer NOT NULL,totals jsonb NOT NULL,source_url text NOT NULL,captured_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.kbo_pitch_profiles (
 season integer,player_id bigint,pitch_type text,player_name text NOT NULL,team_abbr text,usage numeric CHECK(usage>0 AND usage<=1),
 velocity_kmh numeric CHECK(velocity_kmh BETWEEN 60 AND 180),source text NOT NULL,source_as_of date,coverage text NOT NULL,source_url text NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(season,player_id,pitch_type));
CREATE TABLE IF NOT EXISTS public.kbo_capture_state (
 scope text PRIMARY KEY,checked_at timestamptz NOT NULL DEFAULT now(),status text NOT NULL,report jsonb NOT NULL);
DO $do$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['kbo_official_games','kbo_pitcher_gamelogs','kbo_batter_gamelogs','kbo_postgame_ingestion','kbo_pitch_profiles','kbo_capture_state'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT SELECT ON public.%I TO service_role',t);
 END LOOP;
END $do$;
GRANT INSERT,UPDATE ON kbo_capture_state TO service_role;

CREATE OR REPLACE FUNCTION public.kbo_store_schedule(p_games jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE g kbo_official_games;n integer:=0;
BEGIN
 FOR g IN SELECT * FROM jsonb_populate_recordset(null::kbo_official_games,p_games) LOOP
  IF g.game_id !~ '^20[0-9]{6}[A-Z]{4}[012]$' OR g.source IS DISTINCT FROM 'kbo_gamecenter' OR g.series_id NOT IN(0,3,4,5,6,7)
   OR g.game_date IS DISTINCT FROM to_date(left(g.game_id,8),'YYYYMMDD') THEN RAISE EXCEPTION 'Invalid KBO schedule';END IF;
  g.captured_at:=now();
  INSERT INTO kbo_official_games SELECT g.* ON CONFLICT(game_id) DO UPDATE SET
   game_pk=EXCLUDED.game_pk,game_date=EXCLUDED.game_date,season=EXCLUDED.season,series_id=EXCLUDED.series_id,away_team=EXCLUDED.away_team,home_team=EXCLUDED.home_team,
   venue_name=EXCLUDED.venue_name,game_time_kst=EXCLUDED.game_time_kst,game_start=EXCLUDED.game_start,status=EXCLUDED.status,away_score=EXCLUDED.away_score,home_score=EXCLUDED.home_score,
   away_starter=EXCLUDED.away_starter,home_starter=EXCLUDED.home_starter,away_starter_id=EXCLUDED.away_starter_id,home_starter_id=EXCLUDED.home_starter_id,
   source=EXCLUDED.source,raw_schedule=EXCLUDED.raw_schedule,captured_at=now()
   WHERE kbo_official_games.status<>'final' OR EXCLUDED.status IN('final','cancelled');
  -- Keep resolver compatibility, including distinct keys for doubleheaders.
  INSERT INTO kbo_games(game_pk,game_date,season,game_time_kst,away_team,home_team,venue_name,away_score,home_score,status,kbo_game_id,away_starter,home_starter)
   VALUES(g.game_pk,g.game_date,g.season,g.game_time_kst,g.away_team,g.home_team,g.venue_name,g.away_score,g.home_score,g.status,g.game_id,g.away_starter,g.home_starter)
   ON CONFLICT(game_pk) DO UPDATE SET game_time_kst=EXCLUDED.game_time_kst,away_score=EXCLUDED.away_score,home_score=EXCLUDED.home_score,status=EXCLUDED.status,
    kbo_game_id=EXCLUDED.kbo_game_id,away_starter=EXCLUDED.away_starter,home_starter=EXCLUDED.home_starter
    WHERE kbo_games.status<>'final' OR EXCLUDED.status IN('final','cancelled');
  n:=n+1;
 END LOOP;RETURN n;
END $fn$;
CREATE OR REPLACE FUNCTION public.kbo_ingest_boxscore(p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE gid text:=p_payload->'game'->>'game_id';p jsonb;b jsonb;n integer;m integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(gid,103));
 IF p_payload->'game'->>'status' IS DISTINCT FROM 'final' OR jsonb_array_length(p_payload->'pitchers')<2
 OR jsonb_array_length(p_payload->'batters')<18 THEN RAISE EXCEPTION 'Complete final required';END IF;
 PERFORM kbo_store_schedule(jsonb_build_array(p_payload->'game'));
 DELETE FROM kbo_pitcher_gamelogs WHERE game_id=gid;
 DELETE FROM kbo_batter_gamelogs WHERE game_id=gid;
 FOR p IN SELECT value FROM jsonb_array_elements(p_payload->'pitchers') LOOP
  IF p->>'game_id' IS DISTINCT FROM gid OR (p->>'outs')::int<0 OR abs((p->>'ip')::numeric-(p->>'outs')::numeric/3)>0.00001
   OR p->>'source' IS DISTINCT FROM 'kbo_gamecenter' THEN RAISE EXCEPTION 'Invalid pitcher row';END IF;
  INSERT INTO kbo_pitcher_gamelogs(player_name,team_abbr,game_date,season,ip,er,h,bb,so,hr,era_game,result,game_id,series_id,player_id,appearance_no,is_starter,outs,bf,pitches,ab,bb_hbp,runs,source,raw_cells)
   SELECT r.player_name,r.team_abbr,r.game_date,r.season,r.ip,r.er,r.h,r.bb,r.so,r.hr,r.era_game,r.result,r.game_id,r.series_id,r.player_id,r.appearance_no,r.is_starter,r.outs,r.bf,r.pitches,r.ab,r.bb_hbp,r.runs,r.source,r.raw_cells
   FROM jsonb_populate_record(null::kbo_pitcher_gamelogs,p)r;
 END LOOP;
 FOR b IN SELECT value FROM jsonb_array_elements(p_payload->'batters') LOOP
  IF b->>'game_id' IS DISTINCT FROM gid OR (b->>'ab')::int<(b->>'h')::int THEN RAISE EXCEPTION 'Invalid batter row';END IF;
  INSERT INTO kbo_batter_gamelogs SELECT r.* FROM jsonb_populate_record(null::kbo_batter_gamelogs,b||jsonb_build_object('updated_at',now()))r;
 END LOOP;
 SELECT count(*) INTO n FROM kbo_pitcher_gamelogs WHERE game_id=gid;SELECT count(*) INTO m FROM kbo_batter_gamelogs WHERE game_id=gid;
 IF n<>(p_payload->'receipt'->>'pitcher_count')::int OR m<>(p_payload->'receipt'->>'batter_count')::int THEN RAISE EXCEPTION 'Receipt mismatch';END IF;
 INSERT INTO kbo_postgame_ingestion SELECT r.* FROM jsonb_populate_record(null::kbo_postgame_ingestion,p_payload->'receipt'||jsonb_build_object('game_id',gid,'captured_at',now()))r
 ON CONFLICT(game_id) DO UPDATE SET collector_version=EXCLUDED.collector_version,pitcher_count=EXCLUDED.pitcher_count,batter_count=EXCLUDED.batter_count,
  totals=EXCLUDED.totals,source_url=EXCLUDED.source_url,captured_at=now();
 RETURN jsonb_build_object('game_id',gid,'pitchers',n,'batters',m);
END $fn$;
CREATE OR REPLACE FUNCTION public.kbo_store_pitch_profiles(p_season integer,p_player_ids bigint[],p_rows jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE n integer;BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows)r WHERE (r->>'season')::int<>p_season OR NOT ((r->>'player_id')::bigint=ANY(p_player_ids))) THEN RAISE EXCEPTION 'Profile scope mismatch';END IF;
 DELETE FROM kbo_pitch_profiles WHERE season=p_season AND player_id=ANY(p_player_ids);
 INSERT INTO kbo_pitch_profiles SELECT r.* FROM jsonb_populate_recordset(null::kbo_pitch_profiles,
  (SELECT coalesce(jsonb_agg(value||jsonb_build_object('captured_at',now())),'[]') FROM jsonb_array_elements(p_rows)))r;
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
END $fn$;
REVOKE ALL ON FUNCTION kbo_store_schedule(jsonb),kbo_ingest_boxscore(jsonb),kbo_store_pitch_profiles(integer,bigint[],jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION kbo_store_schedule(jsonb),kbo_ingest_boxscore(jsonb),kbo_store_pitch_profiles(integer,bigint[],jsonb) TO service_role;

CREATE OR REPLACE VIEW public.kbo_pitcher_season_current WITH(security_invoker=true) AS
WITH p AS (SELECT p.* FROM kbo_pitcher_gamelogs p JOIN kbo_official_games g USING(game_id) WHERE g.status='final' AND p.series_id=0),
 league AS(SELECT season,sum(er)*27.0/nullif(sum(outs),0)-(13*sum(hr)+3*sum(bb_hbp)-2*sum(so))*3.0/nullif(sum(outs),0) fip_constant FROM p GROUP BY season)
SELECT p.season,p.team_abbr,p.player_name,max(p.player_id) player_id,count(*) games,count(*) FILTER(WHERE is_starter) starts,
 sum(outs) outs,sum(outs)/3.0 pa_or_ip,sum(er)*27.0/nullif(sum(outs),0) era,
 (13*sum(hr)+3*sum(bb_hbp)-2*sum(so))*3.0/nullif(sum(outs),0)+max(l.fip_constant) fip,
 sum(so)*27.0/nullif(sum(outs),0) k_9,null::numeric bb_9,sum(bb_hbp)*27.0/nullif(sum(outs),0) bb_hbp_9,
 sum(so)::numeric/nullif(sum(bf),0) k_pct,null::numeric bb_pct,null::numeric siera,null::numeric babip,
 sum(so) so,sum(bb_hbp) bb_hbp,sum(hr) hr,sum(bf) bf,max(game_date) data_through,max(p.updated_at) updated_at
FROM p JOIN league l USING(season) GROUP BY p.season,p.team_abbr,p.player_name HAVING count(DISTINCT p.player_id)<=1;
CREATE OR REPLACE VIEW public.kbo_batter_season_current WITH(security_invoker=true) AS
SELECT b.season,b.team_abbr,b.player_name,count(*) games,sum(pa) pa_or_ip,sum(ab) ab,sum(h) h,sum(hr) hr,
 sum(h)::numeric/nullif(sum(ab),0) avg,(sum(h)+sum(bb)+sum(hbp))::numeric/nullif(sum(ab)+sum(bb)+sum(hbp)+sum(sf),0) obp,
 (sum(h1b)+2*sum(h2b)+3*sum(h3b)+4*sum(hr))::numeric/nullif(sum(ab),0) slg,
 (0.69*(sum(bb)-sum(ibb))+0.72*sum(hbp)+0.88*sum(h1b)+1.247*sum(h2b)+1.578*sum(h3b)+2.031*sum(hr))/nullif(sum(ab)+sum(bb)-sum(ibb)+sum(hbp)+sum(sf),0) woba,
 'fixed_weights_approximation'::text woba_method,max(b.game_date) data_through,max(b.updated_at) updated_at,
 sum(h1b) h1b,sum(h2b) h2b,sum(h3b) h3b,sum(bb) bb,sum(ibb) ibb,sum(hbp) hbp,sum(sf) sf
FROM kbo_batter_gamelogs b JOIN kbo_official_games g USING(game_id) WHERE g.status='final' AND b.series_id=0 GROUP BY b.season,b.team_abbr,b.player_name;
CREATE OR REPLACE VIEW public.kbo_capture_health WITH(security_invoker=true) AS
SELECT g.season,count(*) FILTER(WHERE g.status='final') final_games,count(r.game_id) receipts,
 count(*) FILTER(WHERE g.status='final' AND r.game_id IS NULL) pending_games,
 max(g.game_date) FILTER(WHERE g.status='final') latest_final,max(g.game_date) FILTER(WHERE r.game_id IS NOT NULL) latest_ingested,
 sum(r.pitcher_count) pitcher_rows,sum(r.batter_count) batter_rows FROM kbo_official_games g LEFT JOIN kbo_postgame_ingestion r USING(game_id) GROUP BY g.season;
REVOKE ALL ON kbo_pitcher_season_current,kbo_batter_season_current,kbo_capture_health FROM PUBLIC,anon,authenticated;
GRANT SELECT ON kbo_pitcher_season_current,kbo_batter_season_current,kbo_capture_health TO service_role;
NOTIFY pgrst,'reload schema';
