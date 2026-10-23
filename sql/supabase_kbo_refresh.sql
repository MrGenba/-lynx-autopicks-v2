ALTER TABLE public.kbo_player_stats
 ADD COLUMN IF NOT EXISTS source text DEFAULT 'legacy_unverified',
 ADD COLUMN IF NOT EXISTS source_as_of date,
 ADD COLUMN IF NOT EXISTS source_checked_at timestamptz,
 ADD COLUMN IF NOT EXISTS source_url text,
 ADD COLUMN IF NOT EXISTS source_player_id text,
 ADD COLUMN IF NOT EXISTS quality_flags jsonb DEFAULT '["legacy_unverified"]'::jsonb;
CREATE OR REPLACE FUNCTION public.kbo_refresh_player_stats(p_season integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE pit integer;bat integer;cut date;BEGIN
 IF NOT EXISTS(SELECT 1 FROM kbo_capture_health WHERE season=p_season AND pending_games=0 AND final_games>0) THEN RAISE EXCEPTION 'KBO backfill is incomplete';END IF;
 SELECT max(game_date) INTO cut FROM kbo_official_games WHERE season=p_season AND series_id=0 AND status='final';
 -- Some teams have two pitchers with the same Korean name. Do not merge their
 -- season records or guess which reliever row belongs to which identity.
 UPDATE kbo_player_stats s SET source='kbo_ambiguous_identity',quality_flags='["multiple_official_player_ids_for_same_name"]'::jsonb
 WHERE s.season=p_season AND s.stats_type='pitching' AND s.source='kbo_gamecenter'
 AND EXISTS(SELECT 1 FROM kbo_pitcher_gamelogs p WHERE p.season=s.season AND p.team_abbr=s.team_abbr AND p.player_name=s.player_name
 GROUP BY p.season,p.team_abbr,p.player_name HAVING count(DISTINCT p.player_id)>1);
 INSERT INTO kbo_player_stats(player_name,team,team_abbr,season,stats_type,games,pa_or_ip,era,fip,siera,k_pct,bb_pct,is_reliever,so_raw,hr_raw,hr9,bb_p_raw,
  updated_at,source,source_as_of,source_checked_at,source_url,source_player_id,quality_flags)
 SELECT player_name,team_abbr||' (KBO)',team_abbr,season,'pitching',games,pa_or_ip,era,fip,null,k_pct,null,starts*2<games,so,hr,hr*27.0/nullif(outs,0),null,
  now(),'kbo_gamecenter',cut,now(),'https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx',player_id::text,
  '["bb_and_hbp_combined","siera_unavailable","fip_derived_from_official_counts"]'::jsonb FROM kbo_pitcher_season_current WHERE season=p_season
 ON CONFLICT(player_name,team,season,stats_type) DO UPDATE SET games=EXCLUDED.games,pa_or_ip=EXCLUDED.pa_or_ip,era=EXCLUDED.era,fip=EXCLUDED.fip,siera=null,
  k_pct=EXCLUDED.k_pct,bb_pct=null,whip=null,babip=null,lob_pct=null,so_raw=EXCLUDED.so_raw,hr_raw=EXCLUDED.hr_raw,hr9=EXCLUDED.hr9,bb_p_raw=null,is_reliever=EXCLUDED.is_reliever,updated_at=now(),source=EXCLUDED.source,
  source_as_of=EXCLUDED.source_as_of,source_checked_at=now(),source_url=EXCLUDED.source_url,source_player_id=EXCLUDED.source_player_id,quality_flags=EXCLUDED.quality_flags;
 GET DIAGNOSTICS pit=ROW_COUNT;
 INSERT INTO kbo_player_stats(player_name,team,team_abbr,season,stats_type,games,pa_or_ip,avg,obp,slg,ops,hr,woba,h1b,h2b,h3b,bb_raw,ibb_raw,hbp_raw,sf_raw,ab_raw,
  updated_at,source,source_as_of,source_checked_at,source_url,quality_flags)
 SELECT player_name,team_abbr||' (KBO)',team_abbr,season,'batting',games,pa_or_ip,avg,obp,slg,obp+slg,hr,woba,h1b,h2b,h3b,bb-ibb,ibb,hbp,sf,ab,now(),'kbo_gamecenter',cut,now(),
  'https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx','["woba_fixed_weights_approximation"]'::jsonb FROM kbo_batter_season_current WHERE season=p_season
 ON CONFLICT(player_name,team,season,stats_type) DO UPDATE SET games=EXCLUDED.games,pa_or_ip=EXCLUDED.pa_or_ip,avg=EXCLUDED.avg,obp=EXCLUDED.obp,slg=EXCLUDED.slg,
  ops=EXCLUDED.ops,hr=EXCLUDED.hr,woba=EXCLUDED.woba,h1b=EXCLUDED.h1b,h2b=EXCLUDED.h2b,h3b=EXCLUDED.h3b,bb_raw=EXCLUDED.bb_raw,ibb_raw=EXCLUDED.ibb_raw,
  hbp_raw=EXCLUDED.hbp_raw,sf_raw=EXCLUDED.sf_raw,ab_raw=EXCLUDED.ab_raw,updated_at=now(),source=EXCLUDED.source,source_as_of=EXCLUDED.source_as_of,source_checked_at=now(),source_url=EXCLUDED.source_url,quality_flags=EXCLUDED.quality_flags;
 GET DIAGNOSTICS bat=ROW_COUNT;RETURN jsonb_build_object('pitching',pit,'batting',bat,'source_as_of',cut);
END $fn$;
REVOKE ALL ON FUNCTION kbo_refresh_player_stats(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION kbo_refresh_player_stats(integer) TO service_role;
NOTIFY pgrst,'reload schema';
