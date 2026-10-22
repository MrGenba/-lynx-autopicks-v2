BEGIN;
-- Dedicated source scopes; legacy tables remain intact for historical reference.
CREATE TABLE IF NOT EXISTS public.bb_statcast_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sport_id integer NOT NULL CHECK(sport_id IN (1,11)),
 season bigint NOT NULL,player_type text NOT NULL CHECK(player_type IN ('pitcher','batter')),
 season_type text NOT NULL CHECK(season_type IN ('R','POST')),captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 requested_through date NOT NULL,source_url text NOT NULL,collector_version text NOT NULL,
 source_headers jsonb NOT NULL,metric_coverage jsonb NOT NULL,quality_flags jsonb NOT NULL,rows_count integer NOT NULL);
CREATE INDEX IF NOT EXISTS bb_statcast_batches_latest ON public.bb_statcast_batches(sport_id,season,player_type,season_type,captured_at DESC);
CREATE TABLE IF NOT EXISTS public.bb_statcast_seasons (
 sport_id integer NOT NULL CHECK(sport_id IN (1,11)),season bigint NOT NULL,
 player_type text NOT NULL CHECK(player_type IN ('pitcher','batter')),season_type text NOT NULL CHECK(season_type IN ('R','POST')),
 player_id bigint NOT NULL,player_name text,
 team_name text,
 xwoba numeric,
 xba numeric,
 xslg numeric,
 avg_exit_velocity numeric,
 hard_hit_pct numeric,
 barrel_pct numeric,
 launch_angle_avg numeric,
 sweet_spot_pct numeric,
 bbe integer,
 pa numeric,
 bip numeric,
 ba numeric,
 obp numeric,
 slg numeric,
 woba numeric,
 xobp numeric,
 babip numeric,
 iso numeric,
 barrels_total numeric,
 barrels_per_pa_pct numeric,
 whiffs numeric,
 swings numeric,
 takes numeric,
 k_percent numeric,
 bb_percent numeric,
 swing_miss_percent numeric,
 pitches numeric,
 spin_rate numeric,
 velocity numeric,
 effective_speed numeric,
 release_extension numeric,
 batch_id uuid NOT NULL REFERENCES public.bb_statcast_batches(id),captured_at timestamptz NOT NULL,
 requested_through date NOT NULL,source text NOT NULL,source_url text NOT NULL,
 raw_metrics jsonb NOT NULL,quality_flags jsonb NOT NULL,updated_at timestamptz NOT NULL,
 PRIMARY KEY(player_id,season,sport_id,player_type,season_type),
 CHECK(hard_hit_pct BETWEEN 0 AND 100),CHECK(barrel_pct BETWEEN 0 AND 100),CHECK(k_percent BETWEEN 0 AND 100),CHECK(bb_percent BETWEEN 0 AND 100));
ALTER TABLE public.bb_statcast_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bb_statcast_seasons ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bb_statcast_batches,public.bb_statcast_seasons FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.bb_statcast_batches,public.bb_statcast_seasons TO service_role;
ALTER TABLE public.player_stats ADD COLUMN IF NOT EXISTS xwoba_captured_at timestamptz;
CREATE OR REPLACE FUNCTION public.bb_statcast_ingest(p_rows jsonb,p_batch jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_time timestamptz:=clock_timestamp(); v_sport integer:=(p_batch->>'sport_id')::integer;
 v_season bigint:=(p_batch->>'season')::bigint; v_role text:=p_batch->>'player_type';v_phase text:=p_batch->>'season_type';
 v_through date:=(p_batch->>'requested_through')::date;v_url text:=p_batch->>'source_url';v_count integer;v_previous integer;
BEGIN
 IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR v_sport NOT IN (1,11) OR v_sport IS NULL
 OR v_role NOT IN ('pitcher','batter') OR v_role IS NULL OR v_phase NOT IN ('R','POST') OR v_phase IS NULL
 OR v_season IS NULL OR v_season<2020 OR v_through IS NULL OR extract(year from v_through)<>v_season
 OR v_through>current_date OR v_url IS NULL OR v_url NOT LIKE 'https://baseballsavant.mlb.com/%'
 THEN RAISE EXCEPTION 'Invalid Statcast scope'; END IF;
 v_count:=jsonb_array_length(p_rows);
 SELECT rows_count INTO v_previous FROM bb_statcast_batches WHERE sport_id=v_sport AND season=v_season
 AND player_type=v_role AND season_type=v_phase ORDER BY captured_at DESC LIMIT 1;
 IF v_previous>=100 AND v_count<v_previous*0.5 THEN RAISE EXCEPTION 'Statcast response unexpectedly lost more than half its players'; END IF;
 INSERT INTO bb_statcast_batches(sport_id,season,player_type,season_type,captured_at,requested_through,source_url,collector_version,source_headers,metric_coverage,quality_flags,rows_count)
 VALUES(v_sport,v_season,v_role,v_phase,v_time,v_through,v_url,p_batch->>'collector_version',p_batch->'source_headers',p_batch->'metric_coverage',p_batch->'quality_flags',v_count) RETURNING id INTO v_id;
 INSERT INTO bb_statcast_seasons(sport_id,season,player_type,season_type,player_id,player_name,team_name,xwoba,xba,xslg,avg_exit_velocity,hard_hit_pct,barrel_pct,launch_angle_avg,sweet_spot_pct,bbe,pa,bip,ba,obp,slg,woba,xobp,babip,iso,barrels_total,barrels_per_pa_pct,whiffs,swings,takes,k_percent,bb_percent,swing_miss_percent,pitches,spin_rate,velocity,effective_speed,release_extension,batch_id,captured_at,requested_through,source,source_url,raw_metrics,quality_flags,updated_at)
 SELECT v_sport,v_season,v_role,v_phase,r.player_id,r.player_name,r.team_name,r.xwoba,r.xba,r.xslg,r.avg_exit_velocity,r.hard_hit_pct,r.barrel_pct,r.launch_angle_avg,r.sweet_spot_pct,r.bbe,r.pa,r.bip,r.ba,r.obp,r.slg,r.woba,r.xobp,r.babip,r.iso,r.barrels_total,r.barrels_per_pa_pct,r.whiffs,r.swings,r.takes,r.k_percent,r.bb_percent,r.swing_miss_percent,r.pitches,r.spin_rate,r.velocity,r.effective_speed,r.release_extension,v_id,v_time,v_through,'baseball_savant',v_url,r.raw_metrics,COALESCE(r.quality_flags,'[]'::jsonb),v_time
 FROM jsonb_populate_recordset(NULL::bb_statcast_seasons,p_rows) r
 ON CONFLICT(player_id,season,sport_id,player_type,season_type) DO UPDATE SET
 player_name=EXCLUDED.player_name,team_name=EXCLUDED.team_name,xwoba=EXCLUDED.xwoba,xba=EXCLUDED.xba,xslg=EXCLUDED.xslg,avg_exit_velocity=EXCLUDED.avg_exit_velocity,hard_hit_pct=EXCLUDED.hard_hit_pct,barrel_pct=EXCLUDED.barrel_pct,launch_angle_avg=EXCLUDED.launch_angle_avg,sweet_spot_pct=EXCLUDED.sweet_spot_pct,bbe=EXCLUDED.bbe,pa=EXCLUDED.pa,bip=EXCLUDED.bip,ba=EXCLUDED.ba,obp=EXCLUDED.obp,slg=EXCLUDED.slg,woba=EXCLUDED.woba,xobp=EXCLUDED.xobp,babip=EXCLUDED.babip,iso=EXCLUDED.iso,barrels_total=EXCLUDED.barrels_total,barrels_per_pa_pct=EXCLUDED.barrels_per_pa_pct,whiffs=EXCLUDED.whiffs,swings=EXCLUDED.swings,takes=EXCLUDED.takes,k_percent=EXCLUDED.k_percent,bb_percent=EXCLUDED.bb_percent,swing_miss_percent=EXCLUDED.swing_miss_percent,pitches=EXCLUDED.pitches,spin_rate=EXCLUDED.spin_rate,velocity=EXCLUDED.velocity,effective_speed=EXCLUDED.effective_speed,release_extension=EXCLUDED.release_extension,batch_id=EXCLUDED.batch_id,captured_at=EXCLUDED.captured_at,requested_through=EXCLUDED.requested_through,source=EXCLUDED.source,source_url=EXCLUDED.source_url,raw_metrics=EXCLUDED.raw_metrics,quality_flags=EXCLUDED.quality_flags,updated_at=EXCLUDED.updated_at;
 IF v_sport=11 AND v_role='pitcher' AND v_phase='R' THEN
  UPDATE player_stats p SET xwoba=s.xwoba,xwoba_captured_at=s.captured_at FROM bb_statcast_seasons s
  WHERE p.player_id=s.player_id AND p.season=v_season AND s.batch_id=v_id;
  UPDATE player_stats p SET xwoba=NULL,xwoba_captured_at=NULL WHERE p.season=v_season
  AND NOT EXISTS(SELECT 1 FROM bb_statcast_seasons s WHERE s.batch_id=v_id AND s.player_id=p.player_id);
 END IF;
 RETURN jsonb_build_object('batch_id',v_id,'captured_at',v_time,'sport_id',v_sport,'season',v_season,'player_type',v_role,'season_type',v_phase,'rows',v_count);
END $$;
REVOKE ALL ON FUNCTION public.bb_statcast_ingest(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bb_statcast_ingest(jsonb,jsonb) TO service_role;
CREATE OR REPLACE VIEW public.bb_statcast_current AS
 SELECT s.* FROM bb_statcast_seasons s JOIN (
 SELECT DISTINCT ON(sport_id,season,player_type,season_type) id FROM bb_statcast_batches
 WHERE captured_at BETWEEN now()-interval '48 hours' AND now()
 AND requested_through>=current_date-2
 ORDER BY sport_id,season,player_type,season_type,captured_at DESC,id DESC) b ON s.batch_id=b.id;
CREATE OR REPLACE VIEW public.bb_statcast_pitchers_mlb AS SELECT * FROM bb_statcast_current WHERE sport_id=1 AND player_type='pitcher' AND season_type='R';
CREATE OR REPLACE VIEW public.bb_statcast_pitchers_milb AS SELECT * FROM bb_statcast_current WHERE sport_id=11 AND player_type='pitcher' AND season_type='R';
CREATE OR REPLACE VIEW public.bb_statcast_batters_current AS SELECT * FROM bb_statcast_current WHERE player_type='batter' AND season_type='R';
REVOKE ALL ON public.bb_statcast_current,public.bb_statcast_pitchers_mlb,public.bb_statcast_pitchers_milb,public.bb_statcast_batters_current FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.bb_statcast_current,public.bb_statcast_pitchers_mlb,public.bb_statcast_pitchers_milb,public.bb_statcast_batters_current TO service_role;
CREATE OR REPLACE VIEW public.bb_statcast_health AS
 SELECT sport.sport_id,extract(year from current_date)::bigint AS season,role.player_type,phase.season_type,
 b.captured_at,b.requested_through,b.rows_count,b.metric_coverage,
 round(extract(epoch from now()-b.captured_at)/3600,2) AS age_hours,
 CASE WHEN b.id IS NULL THEN 'missing'
 WHEN b.captured_at<now()-interval '48 hours' OR b.captured_at>now() OR b.requested_through<current_date-2 THEN 'stale'
 WHEN b.quality_flags<>'[]'::jsonb THEN 'invalid_metrics'
 WHEN b.rows_count=0 THEN 'no_games'
 WHEN b.rows_count=0 OR COALESCE((b.metric_coverage->>'xwoba')::integer,0)=0 THEN 'empty_metrics'
 ELSE 'ok' END AS state
 FROM (VALUES(1),(11)) sport(sport_id) CROSS JOIN (VALUES('pitcher'),('batter')) role(player_type)
 CROSS JOIN (VALUES('R'),('POST')) phase(season_type)
 LEFT JOIN LATERAL (SELECT * FROM bb_statcast_batches z WHERE z.sport_id=sport.sport_id
 AND z.season=extract(year from current_date) AND z.player_type=role.player_type AND z.season_type=phase.season_type
 ORDER BY z.captured_at DESC,z.id DESC LIMIT 1) b ON true;
REVOKE ALL ON public.bb_statcast_health FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.bb_statcast_health TO service_role;

CREATE OR REPLACE VIEW public.v_pitchers_model AS
 SELECT ps.player_id,
    ps.season,
    COALESCE(sp.player_name, ps.name) AS player_name,
    ps.team_name,
    ps.era,
    ps.whip,
    ps.fip,
    ps.k_9,
    ps.bb_9,
    ps.k_bb_pct,
    ps.woba,
    ps.babip,
    sp.xwoba,
    sp.xba,
    sp.xslg,
    sp.avg_exit_velocity,
    sp.hard_hit_pct,
    sp.barrel_pct,
    sp.launch_angle_avg,
    sp.sweet_spot_pct,
    sp.bbe,
    sp.pitches,
    sp.pa,
    sp.bip,
    sp.whiffs,
    sp.swings,
    sp.takes,
    sp.spin_rate,
    sp.velocity,
    sp.effective_speed,
    sp.release_extension,
    sp.source
   FROM player_stats ps
     LEFT JOIN bb_statcast_pitchers_milb sp ON ps.player_id = sp.player_id AND ps.season = sp.season;

CREATE OR REPLACE VIEW public.vw_apuestas_hoy AS
 SELECT dg.game_id,
    dg.game_date,
    dg.scheduled_innings,
    dg.away_team_name,
    dg.home_team_name,
    w.temperature_2m,
    w.wind_speed_10m,
    w.wind_direction_10m,
    s.altitude_m,
    s.park_factor_runs,
    s.park_factor_hr,
    s.park_factor_hits,
    s.park_factor_runs_lhb,
    s.park_factor_runs_rhb,
    dg.away_pitcher_id,
    ap_name.name AS away_pitcher_name,
    ap_stats.pitch_hand_code AS away_pitch_hand,
    ap_statcast.k_percent AS away_k_pct,
    ap_statcast.bb_percent AS away_bb_pct,
    ap_statcast.swing_miss_percent AS away_whiff_pct,
    ap_stats.era AS away_era,
    ap_stats.fip AS away_fip_pro,
    dg.home_pitcher_id,
    hp_name.name AS home_pitcher_name,
    hp_stats.pitch_hand_code AS home_pitch_hand,
    hp_statcast.k_percent AS home_k_pct,
    hp_statcast.bb_percent AS home_bb_pct,
    hp_statcast.swing_miss_percent AS home_whiff_pct,
    hp_stats.era AS home_era,
    hp_stats.fip AS home_fip_pro
   FROM daily_games dg
     LEFT JOIN game_weather w ON dg.game_id = w.game_id
     LEFT JOIN stadiums s ON dg.venue_id = s.venue_id
     LEFT JOIN player_stats ap_name ON dg.away_pitcher_id = ap_name.player_id AND ap_name.season::numeric = EXTRACT(year FROM dg.game_date)
     LEFT JOIN player_stats ap_stats ON dg.away_pitcher_id = ap_stats.player_id AND ap_stats.season::numeric = EXTRACT(year FROM dg.game_date)
     LEFT JOIN bb_statcast_pitchers_milb ap_statcast ON dg.away_pitcher_id = ap_statcast.player_id AND ap_statcast.season::numeric = EXTRACT(year FROM dg.game_date)
     LEFT JOIN player_stats hp_name ON dg.home_pitcher_id = hp_name.player_id AND hp_name.season::numeric = EXTRACT(year FROM dg.game_date)
     LEFT JOIN player_stats hp_stats ON dg.home_pitcher_id = hp_stats.player_id AND hp_stats.season::numeric = EXTRACT(year FROM dg.game_date)
     LEFT JOIN bb_statcast_pitchers_milb hp_statcast ON dg.home_pitcher_id = hp_statcast.player_id AND hp_statcast.season::numeric = EXTRACT(year FROM dg.game_date)
  WHERE date(dg.game_date) = CURRENT_DATE;

CREATE OR REPLACE VIEW public.vw_team_batting AS
 SELECT ptm.team_id::bigint AS team_id,
    psb.season,
    count(DISTINCT psb.player_id) AS num_batters,
    round(sum(psb.xwoba * psb.pa) FILTER (WHERE psb.xwoba IS NOT NULL) / NULLIF(sum(psb.pa) FILTER (WHERE psb.xwoba IS NOT NULL), 0::numeric), 3) AS xwoba,
    COALESCE(round(sum(psb.woba * psb.pa) FILTER (WHERE psb.woba IS NOT NULL) / NULLIF(sum(psb.pa) FILTER (WHERE psb.woba IS NOT NULL), 0::numeric), 3), mtas.woba) AS woba,
    round(sum(psb.xba * psb.pa) FILTER (WHERE psb.xba IS NOT NULL) / NULLIF(sum(psb.pa) FILTER (WHERE psb.xba IS NOT NULL), 0::numeric), 3) AS xba,
    round(sum(psb.hard_hit_pct * psb.pa) FILTER (WHERE psb.hard_hit_pct IS NOT NULL) / NULLIF(sum(psb.pa) FILTER (WHERE psb.hard_hit_pct IS NOT NULL), 0::numeric), 2) AS hard_hit_pct,
    round(sum(psb.barrel_pct * psb.pa) FILTER (WHERE psb.barrel_pct IS NOT NULL) / NULLIF(sum(psb.pa) FILTER (WHERE psb.barrel_pct IS NOT NULL), 0::numeric), 2) AS barrel_pct,
    round(sum(psb.sweet_spot_pct * psb.pa) FILTER (WHERE psb.sweet_spot_pct IS NOT NULL) / NULLIF(sum(psb.pa) FILTER (WHERE psb.sweet_spot_pct IS NOT NULL), 0::numeric), 2) AS sweet_spot_pct,
    round(sum(psb.avg_exit_velocity * psb.pa) FILTER (WHERE psb.avg_exit_velocity IS NOT NULL) / NULLIF(sum(psb.pa) FILTER (WHERE psb.avg_exit_velocity IS NOT NULL), 0::numeric), 1) AS avg_exit_velo,
    round(sum(psb.bb_percent * psb.pa) FILTER (WHERE psb.bb_percent IS NOT NULL) / NULLIF(sum(psb.pa) FILTER (WHERE psb.bb_percent IS NOT NULL), 0::numeric), 2) AS bb_pct,
    round(sum(psb.k_percent * psb.pa) FILTER (WHERE psb.k_percent IS NOT NULL) / NULLIF(sum(psb.pa) FILTER (WHERE psb.k_percent IS NOT NULL), 0::numeric), 2) AS k_pct,
    round(sum(psb.obp * psb.pa) FILTER (WHERE psb.obp IS NOT NULL) / NULLIF(sum(psb.pa) FILTER (WHERE psb.obp IS NOT NULL), 0::numeric), 3) AS obp,
    round(sum(psb.xobp * psb.pa) FILTER (WHERE psb.xobp IS NOT NULL) / NULLIF(sum(psb.pa) FILTER (WHERE psb.xobp IS NOT NULL), 0::numeric), 3) AS xobp,
    round(sum(psb.iso * psb.pa) FILTER (WHERE psb.iso IS NOT NULL) / NULLIF(sum(psb.pa) FILTER (WHERE psb.iso IS NOT NULL), 0::numeric), 3) AS iso,
    min(psb.captured_at) AS statcast_captured_at, min(psb.requested_through) AS statcast_requested_through
   FROM bb_statcast_batters_current psb
     JOIN player_team_map ptm ON ptm.player_id = psb.player_id AND ptm.season = psb.season AND ptm.sport_id = psb.sport_id
     LEFT JOIN milb_team_advanced_stats mtas ON mtas.team_id = ptm.team_id AND mtas.season = psb.season
  WHERE psb.pa >= 20::numeric
  GROUP BY ptm.team_id, psb.season, mtas.woba;

CREATE OR REPLACE VIEW public.vw_matchups_base AS
 SELECT dg.game_id,
    (dg.game_date AT TIME ZONE 'America/New_York'::text)::date AS game_date,
    EXTRACT(year FROM (dg.game_date AT TIME ZONE 'America/New_York'::text))::integer AS season,
    (((((regexp_replace(lower(regexp_replace(dg.away_team_name, '[^a-zA-Z0-9 ]'::text, ''::text, 'g'::text)), '\s+'::text, '_'::text, 'g'::text) || '_vs_'::text) || regexp_replace(lower(regexp_replace(dg.home_team_name, '[^a-zA-Z0-9 ]'::text, ''::text, 'g'::text)), '\s+'::text, '_'::text, 'g'::text)) || '_'::text) || to_char(dg.game_date, 'YYYY-MM-DD'::text)) || '_g'::text) || COALESCE(dg.game_number, 1)::text AS matchup_key,
    ((dg.away_team_name || ' vs '::text) || dg.home_team_name) ||
        CASE
            WHEN dg.double_header = ANY (ARRAY['Y'::text, 'S'::text]) THEN ' - Game '::text || COALESCE(dg.game_number, 1)::text
            ELSE ''::text
        END AS matchup_label,
    dg.away_team_id,
    dg.away_team_name,
    dg.home_team_id,
    dg.home_team_name,
    dg.away_pitcher_id,
    dg.home_pitcher_id,
    dg.double_header,
    COALESCE(dg.game_number, 1) AS game_number,
    COALESCE(dg.scheduled_innings, 9) AS scheduled_innings,
    COALESCE(dg.scheduled_innings, 9) = 7 AS is_7_innings,
    COALESCE(dg.scheduled_innings, 9) = 9 AS is_9_innings,
    dg.sport_id,
    dg.game_type,
    dg.day_night,
    dg.away_score,
    dg.home_score,
    st.venue_id,
    st.name AS stadium_name,
    st.city,
    st.altitude_m,
    pf.park_factor_runs,
    pf.park_factor_hr,
    gw.forecast_time_utc,
    gw.temperature_2m,
    gw.wind_speed_10m,
    gw.wind_direction_10m AS wind_direction,
        CASE
            WHEN gw.wind_speed_10m IS NOT NULL AND gw.wind_direction_10m IS NOT NULL THEN round((gw.wind_speed_10m::double precision * cos(gw.wind_direction_10m::double precision * pi() / 180.0::double precision))::numeric, 2)
            ELSE NULL::numeric
        END AS wind_tailwind,
        CASE
            WHEN ap.name ~~ '%,%'::text THEN (TRIM(BOTH FROM split_part(ap.name, ','::text, 2)) || ' '::text) || TRIM(BOTH FROM split_part(ap.name, ','::text, 1))
            ELSE TRIM(BOTH FROM ap.name)
        END AS away_pitcher_name,
    ap.era AS away_p_era_season,
    ap.fip AS away_p_fip_season,
    ap.whip AS away_p_whip,
    ap.k_9 AS away_p_k_9,
    ap.bb_9 AS away_p_bb_9,
    ap.innings_pitched AS away_p_ip_season,
    EXTRACT(year FROM dg.game_date)::integer AS away_p_stats_season,
    apsc.xwoba AS away_p_xwoba,
    apsc.k_percent AS away_p_k_pct,
    apsc.bb_percent AS away_p_bb_pct,
    apsc.hard_hit_pct AS away_p_hard_hit,
    apsc.barrel_pct AS away_p_barrel,
    apsc.season AS away_p_statcast_season,
        CASE
            WHEN hp.name ~~ '%,%'::text THEN (TRIM(BOTH FROM split_part(hp.name, ','::text, 2)) || ' '::text) || TRIM(BOTH FROM split_part(hp.name, ','::text, 1))
            ELSE TRIM(BOTH FROM hp.name)
        END AS home_pitcher_name,
    hp.era AS home_p_era_season,
    hp.fip AS home_p_fip_season,
    hp.whip AS home_p_whip,
    hp.k_9 AS home_p_k_9,
    hp.bb_9 AS home_p_bb_9,
    hp.innings_pitched AS home_p_ip_season,
    EXTRACT(year FROM dg.game_date)::integer AS home_p_stats_season,
    hpsc.xwoba AS home_p_xwoba,
    hpsc.k_percent AS home_p_k_pct,
    hpsc.bb_percent AS home_p_bb_pct,
    hpsc.hard_hit_pct AS home_p_hard_hit,
    hpsc.barrel_pct AS home_p_barrel,
    hpsc.season AS home_p_statcast_season,
    ato.rpg_season AS away_team_rpg_season,
    ato.l10_rpg AS away_team_l10_rpg,
    ato.games_played AS away_team_games_played,
    atsc.xwoba AS away_team_xwoba,
    atsc.woba AS away_team_woba,
    atsc.hard_hit_pct AS away_team_hard_hit,
    atsc.barrel_pct AS away_team_barrel,
    atsc.avg_exit_velo AS away_team_exit_velo,
    atsc.season AS away_team_batting_season,
    atsc.num_batters AS away_team_batting_num_batters,
    hto.rpg_season AS home_team_rpg_season,
    hto.l10_rpg AS home_team_l10_rpg,
    hto.games_played AS home_team_games_played,
    htsc.xwoba AS home_team_xwoba,
    htsc.woba AS home_team_woba,
    htsc.hard_hit_pct AS home_team_hard_hit,
    htsc.barrel_pct AS home_team_barrel,
    htsc.avg_exit_velo AS home_team_exit_velo,
    htsc.season AS home_team_batting_season,
    htsc.num_batters AS home_team_batting_num_batters,
    abp.era AS away_bullpen_era,
    abp.k9 AS away_bullpen_k9,
    abp.bb9 AS away_bullpen_bb9,
    abp.fip AS away_bullpen_fip,
    abp.num_pitchers AS away_bullpen_num_pitchers,
    EXTRACT(year FROM dg.game_date)::integer AS away_bullpen_season,
    hbp.era AS home_bullpen_era,
    hbp.k9 AS home_bullpen_k9,
    hbp.bb9 AS home_bullpen_bb9,
    hbp.fip AS home_bullpen_fip,
    hbp.num_pitchers AS home_bullpen_num_pitchers,
    EXTRACT(year FROM dg.game_date)::integer AS home_bullpen_season,
    st.venue_id IS NOT NULL AS has_venue,
    gw.game_id IS NOT NULL AS has_weather,
    dg.away_pitcher_id IS NOT NULL AS has_away_pitcher,
    dg.home_pitcher_id IS NOT NULL AS has_home_pitcher,
    dg.away_pitcher_id IS NOT NULL AND dg.home_pitcher_id IS NOT NULL AS has_both_pitchers,
    dg.game_id IS NOT NULL AND dg.away_team_id IS NOT NULL AND dg.home_team_id IS NOT NULL AND dg.game_date IS NOT NULL AND st.venue_id IS NOT NULL AS ready_for_analysis,
    dg.game_date AS game_datetime_utc
   FROM daily_games dg
     LEFT JOIN stadiums st ON st.venue_id = dg.venue_id
     LEFT JOIN game_weather gw ON gw.game_id = dg.game_id
     LEFT JOIN park_factors pf ON pf.venue_id = dg.venue_id
     LEFT JOIN player_stats ap ON ap.player_id = dg.away_pitcher_id AND ap.season = EXTRACT(year FROM dg.game_date)::integer
     LEFT JOIN player_stats hp ON hp.player_id = dg.home_pitcher_id AND hp.season = EXTRACT(year FROM dg.game_date)::integer
     LEFT JOIN bb_statcast_pitchers_milb apsc ON apsc.player_id = dg.away_pitcher_id AND apsc.season = EXTRACT(year FROM dg.game_date)::integer
     LEFT JOIN bb_statcast_pitchers_milb hpsc ON hpsc.player_id = dg.home_pitcher_id AND hpsc.season = EXTRACT(year FROM dg.game_date)::integer
     LEFT JOIN ( SELECT ranked.team_id,
            ranked.season,
            count(*) AS games_played,
            round(sum(ranked.runs)::numeric / NULLIF(count(*), 0)::numeric, 3) AS rpg_season,
            round(sum(
                CASE
                    WHEN ranked.rn <= 10 THEN ranked.runs
                    ELSE 0
                END)::numeric / NULLIF(sum(
                CASE
                    WHEN ranked.rn <= 10 THEN 1
                    ELSE 0
                END), 0)::numeric, 3) AS l10_rpg
           FROM ( SELECT t.team_id,
                    t.season,
                    t.runs,
                    row_number() OVER (PARTITION BY t.team_id, t.season ORDER BY t.game_date DESC) AS rn
                   FROM ( SELECT daily_games.away_team_id AS team_id,
                            EXTRACT(year FROM daily_games.game_date)::integer AS season,
                            daily_games.game_date,
                            daily_games.away_score AS runs
                           FROM daily_games
                          WHERE daily_games.away_score IS NOT NULL
                        UNION ALL
                         SELECT daily_games.home_team_id,
                            EXTRACT(year FROM daily_games.game_date)::integer AS "extract",
                            daily_games.game_date,
                            daily_games.home_score
                           FROM daily_games
                          WHERE daily_games.home_score IS NOT NULL) t) ranked
          GROUP BY ranked.team_id, ranked.season) ato ON ato.team_id = dg.away_team_id AND ato.season = EXTRACT(year FROM dg.game_date)::integer
     LEFT JOIN ( SELECT ranked.team_id,
            ranked.season,
            count(*) AS games_played,
            round(sum(ranked.runs)::numeric / NULLIF(count(*), 0)::numeric, 3) AS rpg_season,
            round(sum(
                CASE
                    WHEN ranked.rn <= 10 THEN ranked.runs
                    ELSE 0
                END)::numeric / NULLIF(sum(
                CASE
                    WHEN ranked.rn <= 10 THEN 1
                    ELSE 0
                END), 0)::numeric, 3) AS l10_rpg
           FROM ( SELECT t.team_id,
                    t.season,
                    t.runs,
                    row_number() OVER (PARTITION BY t.team_id, t.season ORDER BY t.game_date DESC) AS rn
                   FROM ( SELECT daily_games.away_team_id AS team_id,
                            EXTRACT(year FROM daily_games.game_date)::integer AS season,
                            daily_games.game_date,
                            daily_games.away_score AS runs
                           FROM daily_games
                          WHERE daily_games.away_score IS NOT NULL
                        UNION ALL
                         SELECT daily_games.home_team_id,
                            EXTRACT(year FROM daily_games.game_date)::integer AS "extract",
                            daily_games.game_date,
                            daily_games.home_score
                           FROM daily_games
                          WHERE daily_games.home_score IS NOT NULL) t) ranked
          GROUP BY ranked.team_id, ranked.season) hto ON hto.team_id = dg.home_team_id AND hto.season = EXTRACT(year FROM dg.game_date)::integer
     LEFT JOIN vw_team_batting atsc ON atsc.team_id = dg.away_team_id AND atsc.season = EXTRACT(year FROM dg.game_date)::integer
     LEFT JOIN vw_team_batting htsc ON htsc.team_id = dg.home_team_id AND htsc.season = EXTRACT(year FROM dg.game_date)::integer
     LEFT JOIN ( SELECT pitcher_gamelogs.team_id,
            EXTRACT(year FROM pitcher_gamelogs.game_date)::integer AS season,
            count(DISTINCT pitcher_gamelogs.player_id) AS num_pitchers,
                CASE
                    WHEN sum(ip_real(pitcher_gamelogs.innings_pitched)) > 0::numeric THEN round(sum(pitcher_gamelogs.earned_runs)::numeric * 9.0 / sum(ip_real(pitcher_gamelogs.innings_pitched)), 2)
                    ELSE NULL::numeric
                END AS era,
                CASE
                    WHEN sum(ip_real(pitcher_gamelogs.innings_pitched)) > 0::numeric THEN round(sum(pitcher_gamelogs.strikeouts)::numeric * 9.0 / sum(ip_real(pitcher_gamelogs.innings_pitched)), 2)
                    ELSE NULL::numeric
                END AS k9,
                CASE
                    WHEN sum(ip_real(pitcher_gamelogs.innings_pitched)) > 0::numeric THEN round(sum(pitcher_gamelogs.base_on_balls)::numeric * 9.0 / sum(ip_real(pitcher_gamelogs.innings_pitched)), 2)
                    ELSE NULL::numeric
                END AS bb9,
                CASE
                    WHEN sum(ip_real(pitcher_gamelogs.innings_pitched)) > 0::numeric THEN round((13.0 * sum(pitcher_gamelogs.home_runs)::numeric + 3.0 * sum(pitcher_gamelogs.base_on_balls)::numeric - 2.0 * sum(pitcher_gamelogs.strikeouts)::numeric) / sum(ip_real(pitcher_gamelogs.innings_pitched)) + 3.10, 2)
                    ELSE NULL::numeric
                END AS fip
           FROM pitcher_gamelogs
          WHERE pitcher_gamelogs.is_starter = false
          GROUP BY pitcher_gamelogs.team_id, (EXTRACT(year FROM pitcher_gamelogs.game_date)::integer)) abp ON abp.team_id = dg.away_team_id AND abp.season = EXTRACT(year FROM dg.game_date)::integer
     LEFT JOIN ( SELECT pitcher_gamelogs.team_id,
            EXTRACT(year FROM pitcher_gamelogs.game_date)::integer AS season,
            count(DISTINCT pitcher_gamelogs.player_id) AS num_pitchers,
                CASE
                    WHEN sum(ip_real(pitcher_gamelogs.innings_pitched)) > 0::numeric THEN round(sum(pitcher_gamelogs.earned_runs)::numeric * 9.0 / sum(ip_real(pitcher_gamelogs.innings_pitched)), 2)
                    ELSE NULL::numeric
                END AS era,
                CASE
                    WHEN sum(ip_real(pitcher_gamelogs.innings_pitched)) > 0::numeric THEN round(sum(pitcher_gamelogs.strikeouts)::numeric * 9.0 / sum(ip_real(pitcher_gamelogs.innings_pitched)), 2)
                    ELSE NULL::numeric
                END AS k9,
                CASE
                    WHEN sum(ip_real(pitcher_gamelogs.innings_pitched)) > 0::numeric THEN round(sum(pitcher_gamelogs.base_on_balls)::numeric * 9.0 / sum(ip_real(pitcher_gamelogs.innings_pitched)), 2)
                    ELSE NULL::numeric
                END AS bb9,
                CASE
                    WHEN sum(ip_real(pitcher_gamelogs.innings_pitched)) > 0::numeric THEN round((13.0 * sum(pitcher_gamelogs.home_runs)::numeric + 3.0 * sum(pitcher_gamelogs.base_on_balls)::numeric - 2.0 * sum(pitcher_gamelogs.strikeouts)::numeric) / sum(ip_real(pitcher_gamelogs.innings_pitched)) + 3.10, 2)
                    ELSE NULL::numeric
                END AS fip
           FROM pitcher_gamelogs
          WHERE pitcher_gamelogs.is_starter = false
          GROUP BY pitcher_gamelogs.team_id, (EXTRACT(year FROM pitcher_gamelogs.game_date)::integer)) hbp ON hbp.team_id = dg.home_team_id AND hbp.season = EXTRACT(year FROM dg.game_date)::integer;

CREATE OR REPLACE VIEW public.vw_mlb_matchups_ready AS
 SELECT g.game_pk,
    g.game_date,
    g.season,
    g.status,
    g.away_team_id,
    g.away_team_name,
    g.home_team_id,
    g.home_team_name,
    g.away_pitcher_id,
    g.away_pitcher_name,
    g.home_pitcher_id,
    g.home_pitcher_name,
    g.venue_id,
    g.venue_name,
    COALESCE(asp.era, asp_all.era) AS away_p_era,
    COALESCE(asp.ip, asp_all.ip) AS away_p_ip_season,
    COALESCE(asp.k_9, asp_all.k_9) AS away_p_k_9,
    COALESCE(asp.bb_9, asp_all.bb_9) AS away_p_bb_9,
    COALESCE(asp.season, asp_all.season) AS away_p_stats_season,
    arsp.era_l5 AS away_p_era_l5,
    arsp.ip_l5 AS away_p_ip_l5,
    COALESCE(hsp.era, hsp_all.era) AS home_p_era,
    COALESCE(hsp.ip, hsp_all.ip) AS home_p_ip_season,
    COALESCE(hsp.k_9, hsp_all.k_9) AS home_p_k_9,
    COALESCE(hsp.bb_9, hsp_all.bb_9) AS home_p_bb_9,
    COALESCE(hsp.season, hsp_all.season) AS home_p_stats_season,
    hrsp.era_l5 AS home_p_era_l5,
    hrsp.ip_l5 AS home_p_ip_l5,
    abp.bp_era AS away_bullpen_era,
    abp.bp_k9 AS away_bullpen_k9,
    abp.bp_bb9 AS away_bullpen_bb9,
    abp.bp_pitchers AS away_bullpen_pitchers,
    abp.season AS away_bullpen_season,
    hbp.bp_era AS home_bullpen_era,
    hbp.bp_k9 AS home_bullpen_k9,
    hbp.bp_bb9 AS home_bullpen_bb9,
    hbp.bp_pitchers AS home_bullpen_pitchers,
    hbp.season AS home_bullpen_season,
    ato.avg_runs AS away_team_avg_runs,
    ato.games AS away_team_games,
    hto.avg_runs AS home_team_avg_runs,
    hto.games AS home_team_games,
    pf.park_factor_runs,
    pf.altitude_m,
    w.temperature_2m,
    w.wind_speed_10m,
    w.wind_direction,
    w.wind_tailwind,
    COALESCE(asp.fip, asp_all.fip) AS away_p_fip_season,
    arsp.fip_l5 AS away_p_fip_l5,
    COALESCE(hsp.fip, hsp_all.fip) AS home_p_fip_season,
    hrsp.fip_l5 AS home_p_fip_l5,
    abp.bp_fip AS away_bullpen_fip,
    hbp.bp_fip AS home_bullpen_fip,
    abx.xwoba_allowed AS away_bullpen_xwoba,
    hbx.xwoba_allowed AS home_bullpen_xwoba,
    ats.woba AS away_team_woba,
    ats.xwoba AS away_team_xwoba,
    hts.woba AS home_team_woba,
    hts.xwoba AS home_team_xwoba,
    apsa.siera AS away_p_siera,
    apsa.gb_pct AS away_p_gb_pct,
    hpsa.siera AS home_p_siera,
    hpsa.gb_pct AS home_p_gb_pct,
    asc_.xwoba AS away_p_xwoba,
    asc_.k_percent AS away_p_k_pct,
    asc_.bb_percent AS away_p_bb_pct,
    asc_.hard_hit_pct AS away_p_hard_hit,
    asc_.barrel_pct AS away_p_barrel,
    hsc_.xwoba AS home_p_xwoba,
    hsc_.k_percent AS home_p_k_pct,
    hsc_.bb_percent AS home_p_bb_pct,
    hsc_.hard_hit_pct AS home_p_hard_hit,
    hsc_.barrel_pct AS home_p_barrel,
    aspl.away_era AS away_p_split_away_era,
    hspl.home_era AS home_p_split_home_era,
    COALESCE(g.scheduled_innings, 9) AS scheduled_innings,
        CASE
            WHEN COALESCE(g.scheduled_innings, 9) = 7 THEN true
            ELSE false
        END AS is_7_innings,
        CASE
            WHEN COALESCE(g.scheduled_innings, 9) = 9 THEN true
            ELSE false
        END AS is_9_innings,
    g.double_header,
    g.game_type,
    pf.park_factor_hr,
    abp.bp_ip AS away_bullpen_ip,
    hbp.bp_ip AS home_bullpen_ip,
    asc_.captured_at AS away_p_statcast_captured_at,
    asc_.requested_through AS away_p_statcast_requested_through,
    asc_.source_url AS away_p_statcast_source_url,
    asc_.season AS away_p_statcast_season,
    hsc_.captured_at AS home_p_statcast_captured_at,
    hsc_.requested_through AS home_p_statcast_requested_through,
    hsc_.source_url AS home_p_statcast_source_url,
    hsc_.season AS home_p_statcast_season
   FROM mlb_games g
     LEFT JOIN vw_mlb_pitcher_season asp ON asp.player_id = g.away_pitcher_id AND asp.season = g.season
     LEFT JOIN vw_mlb_pitcher_season_all asp_all ON asp_all.player_id = g.away_pitcher_id AND asp_all.season = g.season
     LEFT JOIN vw_mlb_pitcher_recent arsp ON arsp.player_id = g.away_pitcher_id AND arsp.season = g.season
     LEFT JOIN vw_mlb_pitcher_season hsp ON hsp.player_id = g.home_pitcher_id AND hsp.season = g.season
     LEFT JOIN vw_mlb_pitcher_season_all hsp_all ON hsp_all.player_id = g.home_pitcher_id AND hsp_all.season = g.season
     LEFT JOIN vw_mlb_pitcher_recent hrsp ON hrsp.player_id = g.home_pitcher_id AND hrsp.season = g.season
     LEFT JOIN vw_mlb_team_bullpen abp ON abp.team_id = g.away_team_id AND abp.season = g.season
     LEFT JOIN vw_mlb_team_bullpen hbp ON hbp.team_id = g.home_team_id AND hbp.season = g.season
     LEFT JOIN mlb_bullpen_advanced_stats abx ON abx.team_id = g.away_team_id AND abx.season = g.season
     LEFT JOIN mlb_bullpen_advanced_stats hbx ON hbx.team_id = g.home_team_id AND hbx.season = g.season
     LEFT JOIN vw_mlb_team_offense ato ON ato.team_id = g.away_team_id AND ato.season = g.season
     LEFT JOIN vw_mlb_team_offense hto ON hto.team_id = g.home_team_id AND hto.season = g.season
     LEFT JOIN mlb_team_advanced_stats ats ON ats.team_id = g.away_team_id AND ats.season = g.season
     LEFT JOIN mlb_team_advanced_stats hts ON hts.team_id = g.home_team_id AND hts.season = g.season
     LEFT JOIN mlb_park_factors pf ON pf.venue_id = g.venue_id
     LEFT JOIN mlb_game_weather w ON w.game_pk = g.game_pk
     LEFT JOIN mlb_pitcher_advanced_stats apsa ON apsa.player_id = g.away_pitcher_id AND apsa.season = g.season
     LEFT JOIN mlb_pitcher_advanced_stats hpsa ON hpsa.player_id = g.home_pitcher_id AND hpsa.season = g.season
     LEFT JOIN bb_statcast_pitchers_mlb asc_ ON asc_.player_id = g.away_pitcher_id AND asc_.season = g.season
     LEFT JOIN bb_statcast_pitchers_mlb hsc_ ON hsc_.player_id = g.home_pitcher_id AND hsc_.season = g.season
     LEFT JOIN vw_mlb_pitcher_splits aspl ON aspl.player_id = g.away_pitcher_id AND aspl.season = g.season
     LEFT JOIN vw_mlb_pitcher_splits hspl ON hspl.player_id = g.home_pitcher_id AND hspl.season = g.season;

CREATE OR REPLACE VIEW public.vw_team_bullpen AS
 SELECT p.team_id,p.season,count(*) AS num_pitchers,round(avg(p.era),2) AS era,
 round(avg(p.fip),2) AS fip,round(avg(p.whip),2) AS whip,round(avg(p.k_9),1) AS k9,
 round(avg(p.bb_9),1) AS bb9,round(avg(sc.xwoba)::numeric,3) AS xwoba_allowed,
 min(sc.captured_at) AS statcast_captured_at,min(sc.requested_through) AS statcast_requested_through
 FROM player_stats p LEFT JOIN bb_statcast_pitchers_milb sc ON sc.player_id=p.player_id AND sc.season=p.season
 WHERE p.innings_pitched>=5 AND p.innings_pitched<=79 AND p.era IS NOT NULL AND p.team_id IS NOT NULL
 GROUP BY p.team_id,p.season;
NOTIFY pgrst,'reload schema';

COMMIT;
