-- Supabase Tipster_DB; separate receipt for every independent source.
CREATE TABLE IF NOT EXISTS public.bb_catcher_defense_batches (
 batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 sport_id integer NOT NULL CHECK(sport_id=1), season integer NOT NULL CHECK(season>=2020),
 metric_group text NOT NULL CHECK(metric_group IN ('framing','blocking','poptime')),
 season_type text NOT NULL, captured_at timestamptz NOT NULL DEFAULT now(),
 source_url text NOT NULL, collector_version text NOT NULL, rows_count integer NOT NULL CHECK(rows_count>=0),
 source_headers jsonb NOT NULL, metric_coverage jsonb NOT NULL, quality_flags jsonb NOT NULL,
 CHECK ((metric_group='poptime' AND season_type='SOURCE_DEFAULT') OR
        (metric_group IN ('framing','blocking') AND season_type='R'))
);
CREATE INDEX IF NOT EXISTS bb_catcher_defense_latest ON public.bb_catcher_defense_batches(season,metric_group,captured_at DESC);
CREATE TABLE IF NOT EXISTS public.bb_catcher_defense_seasons (
 player_id bigint NOT NULL CHECK(player_id>0), season integer NOT NULL, sport_id integer NOT NULL CHECK(sport_id=1),
 metric_group text NOT NULL, season_type text NOT NULL, player_name text NOT NULL,
 batch_id uuid NOT NULL REFERENCES public.bb_catcher_defense_batches(batch_id),
 metrics jsonb NOT NULL CHECK(jsonb_typeof(metrics)='object'), raw_metrics jsonb NOT NULL,
 quality_flags jsonb NOT NULL,
 PRIMARY KEY(player_id,season,sport_id,metric_group),
 CHECK((metrics->>'shadow_strike_pct')::numeric BETWEEN 0 AND 100),
 CHECK((metrics->>'framing_pitches')::numeric>=0),
 CHECK((metrics->>'blocking_opportunities')::numeric>=0),
 CHECK((metrics->>'throws_2b')::numeric>=0 AND (metrics->>'throws_3b')::numeric>=0),
 CHECK((metrics->>'pop_2b_seconds')::numeric>0 AND (metrics->>'pop_3b_seconds')::numeric>0)
);
CREATE OR REPLACE FUNCTION public.bb_catcher_defense_ingest(p_rows jsonb,p_batch jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b public.bb_catcher_defense_batches%ROWTYPE; old_count integer; n integer; grp text; yr integer; url text;
BEGIN
 grp:=p_batch->>'metric_group'; yr:=(p_batch->>'season')::integer; url:=p_batch->>'source_url';
 IF grp IS NULL OR grp NOT IN ('framing','blocking','poptime') OR (p_batch->>'sport_id')::integer IS DISTINCT FROM 1
 OR yr IS NULL OR yr<2020 OR yr>extract(year from current_date) THEN RAISE EXCEPTION 'Invalid catcher scope'; END IF;
 IF url IS NULL OR url NOT LIKE ('https://baseballsavant.mlb.com/leaderboard/'||
   CASE grp WHEN 'framing' THEN 'catcher-framing' WHEN 'blocking' THEN 'catcher-blocking' ELSE 'poptime' END||'?%')
 THEN RAISE EXCEPTION 'Invalid catcher source'; END IF;
 IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid catcher rows'; END IF;
 n:=jsonb_array_length(p_rows);
 PERFORM pg_advisory_xact_lock(hashtext('bb_catcher_defense_'||yr||grp));
 SELECT rows_count INTO old_count FROM bb_catcher_defense_batches WHERE season=yr AND metric_group=grp ORDER BY captured_at DESC LIMIT 1;
 IF old_count>=20 AND n<old_count/2.0 THEN RAISE EXCEPTION 'Catcher source unexpectedly shrank'; END IF;
 INSERT INTO bb_catcher_defense_batches(sport_id,season,metric_group,season_type,source_url,collector_version,rows_count,source_headers,metric_coverage,quality_flags)
 VALUES(1,yr,grp,p_batch->>'season_type',url,p_batch->>'collector_version',n,p_batch->'source_headers',p_batch->'metric_coverage',p_batch->'quality_flags') RETURNING * INTO b;
 INSERT INTO bb_catcher_defense_seasons(player_id,season,sport_id,metric_group,season_type,player_name,batch_id,metrics,raw_metrics,quality_flags)
 SELECT (r->>'player_id')::bigint,yr,1,grp,b.season_type,r->>'player_name',b.batch_id,r->'metrics',r->'raw_metrics',r->'quality_flags'
 FROM jsonb_array_elements(p_rows) r
 ON CONFLICT(player_id,season,sport_id,metric_group) DO UPDATE SET season_type=excluded.season_type,
 player_name=excluded.player_name,batch_id=excluded.batch_id,metrics=excluded.metrics,raw_metrics=excluded.raw_metrics,quality_flags=excluded.quality_flags;
 RETURN jsonb_build_object('batch_id',b.batch_id,'metric_group',grp,'season',yr,'rows',n,'captured_at',b.captured_at);
END $$;
CREATE OR REPLACE VIEW public.bb_catcher_defense_current AS
 WITH latest AS (SELECT DISTINCT ON(season,metric_group) * FROM public.bb_catcher_defense_batches ORDER BY season,metric_group,captured_at DESC)
 SELECT s.*,b.captured_at,b.source_url,b.collector_version FROM public.bb_catcher_defense_seasons s JOIN latest b USING(batch_id)
 WHERE b.captured_at BETWEEN now()-interval '48 hours' AND now();
CREATE OR REPLACE VIEW public.bb_catcher_defense_health AS
 SELECT e.metric_group,b.season,b.captured_at,b.rows_count,b.metric_coverage,b.quality_flags,
 CASE WHEN b.batch_id IS NULL THEN 'missing' WHEN b.captured_at<now()-interval '48 hours' THEN 'stale'
 WHEN jsonb_array_length(b.quality_flags)>0 THEN 'invalid_metrics' WHEN b.rows_count=0 THEN 'no_data' ELSE 'ok' END state
 FROM (VALUES('framing'),('blocking'),('poptime')) e(metric_group)
 LEFT JOIN LATERAL(SELECT * FROM public.bb_catcher_defense_batches b WHERE b.season=extract(year from current_date)::int
 AND b.metric_group=e.metric_group ORDER BY captured_at DESC LIMIT 1) b ON true;

CREATE TABLE IF NOT EXISTS public.bb_tracking_coverage (
 sport_id integer NOT NULL CHECK(sport_id=23),season integer NOT NULL,
 source text NOT NULL CHECK(source='mlb_statsapi_public'),captured_at timestamptz NOT NULL DEFAULT now(),
 sample_games jsonb NOT NULL CHECK(jsonb_typeof(sample_games)='array'),
 PRIMARY KEY(sport_id,season,source)
);
-- Sample the most recent final game at each venue, including playoffs.
CREATE OR REPLACE VIEW public.bb_lmb_tracking_probe_games AS
 SELECT DISTINCT ON(venue_id) game_pk,game_date,venue_id,season FROM public.lmb_games
 WHERE season=extract(year from current_date)::int AND status='Final'
 ORDER BY venue_id,game_date DESC,game_pk DESC;
CREATE OR REPLACE FUNCTION public.bb_lmb_tracking_coverage_ingest(p_season integer,p_games jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb; n integer;
BEGIN
 IF p_season IS DISTINCT FROM extract(year from current_date)::int OR jsonb_typeof(p_games) IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'Invalid tracking probe'; END IF;
 SELECT count(*) INTO n FROM bb_lmb_tracking_probe_games;
 IF jsonb_array_length(p_games)<>n OR (SELECT count(DISTINCT elem->>'game_pk') FROM jsonb_array_elements(p_games) elem)<>n
 THEN RAISE EXCEPTION 'Incomplete tracking sample'; END IF;
 FOR r IN SELECT * FROM jsonb_array_elements(p_games) LOOP
  IF NOT EXISTS(SELECT 1 FROM bb_lmb_tracking_probe_games g WHERE g.game_pk=(r->>'game_pk')::bigint AND g.venue_id=(r->>'venue_id')::int)
    OR r->>'source_url' IS DISTINCT FROM 'https://statsapi.mlb.com/api/v1.1/game/'||(r->>'game_pk')||'/feed/live'
    OR coalesce((r->>'pitches')::int,0)<=0 OR coalesce((r->>'batted_balls')::int,0)<0
    OR (r->>'pitch_velocity')::int NOT BETWEEN 0 AND (r->>'pitches')::int
    OR (r->>'spin_rate')::int NOT BETWEEN 0 AND (r->>'pitches')::int
    OR (r->>'exit_velocity')::int NOT BETWEEN 0 AND (r->>'batted_balls')::int
    OR (r->>'launch_angle')::int NOT BETWEEN 0 AND (r->>'batted_balls')::int
  THEN RAISE EXCEPTION 'Invalid tracking evidence'; END IF;
 END LOOP;
 INSERT INTO bb_tracking_coverage(sport_id,season,source,sample_games) VALUES(23,p_season,'mlb_statsapi_public',p_games)
 ON CONFLICT(sport_id,season,source) DO UPDATE SET captured_at=now(),sample_games=excluded.sample_games;
 RETURN jsonb_build_object('sport_id',23,'season',p_season,'sample_games',n);
END $$;
CREATE OR REPLACE VIEW public.bb_tracking_coverage_health AS
 SELECT 23 sport_id,c.season,c.captured_at,jsonb_array_length(c.sample_games) sample_games,
 coalesce(x.pitches,0) pitches,coalesce(x.batted_balls,0) batted_balls,
 coalesce(x.pitch_velocity,0) pitch_velocity,coalesce(x.spin_rate,0) spin_rate,
 coalesce(x.exit_velocity,0) exit_velocity,coalesce(x.launch_angle,0) launch_angle,
 CASE WHEN c.captured_at IS NULL THEN 'missing' WHEN c.captured_at<now()-interval '48 hours' THEN 'stale'
 WHEN jsonb_array_length(c.sample_games)=0 THEN 'no_games'
 WHEN coalesce(x.pitch_velocity,0)+coalesce(x.spin_rate,0)+coalesce(x.exit_velocity,0)+coalesce(x.launch_angle,0)=0 THEN 'not_available_in_sample'
 ELSE 'tracking_detected' END state
 FROM (SELECT 23 sport_id) e LEFT JOIN public.bb_tracking_coverage c ON c.sport_id=e.sport_id AND c.season=extract(year from current_date)::int
 LEFT JOIN LATERAL(SELECT sum((g->>'pitches')::int) pitches,sum((g->>'batted_balls')::int) batted_balls,
 sum((g->>'pitch_velocity')::int) pitch_velocity,sum((g->>'spin_rate')::int) spin_rate,
 sum((g->>'exit_velocity')::int) exit_velocity,sum((g->>'launch_angle')::int) launch_angle FROM jsonb_array_elements(c.sample_games) g) x ON true;

ALTER TABLE public.bb_catcher_defense_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bb_catcher_defense_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bb_tracking_coverage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bb_catcher_defense_batches,public.bb_catcher_defense_seasons,public.bb_tracking_coverage,
 public.bb_catcher_defense_current,public.bb_catcher_defense_health,public.bb_lmb_tracking_probe_games,public.bb_tracking_coverage_health FROM anon,authenticated;
REVOKE ALL ON public.bb_catcher_defense_batches,public.bb_catcher_defense_seasons,public.bb_tracking_coverage FROM service_role;
GRANT SELECT ON public.bb_catcher_defense_batches,public.bb_catcher_defense_seasons,public.bb_tracking_coverage,
 public.bb_catcher_defense_current,public.bb_catcher_defense_health,public.bb_lmb_tracking_probe_games,public.bb_tracking_coverage_health TO service_role;
REVOKE ALL ON FUNCTION public.bb_catcher_defense_ingest(jsonb,jsonb),public.bb_lmb_tracking_coverage_ingest(integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bb_catcher_defense_ingest(jsonb,jsonb),public.bb_lmb_tracking_coverage_ingest(integer,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
