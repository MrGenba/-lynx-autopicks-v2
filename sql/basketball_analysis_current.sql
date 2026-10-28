-- Bound runtime input without deleting or updating any sealed forecast.
CREATE OR REPLACE FUNCTION public.bk_analysis_forecasts(p_league text,p_game_ids text[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(f)),'[]'::jsonb) FROM (
  SELECT DISTINCT ON(league,game_id,model_version,coalesce(player_id,'')) *
  FROM bk_forecasts WHERE league=p_league AND game_id=ANY(p_game_ids)
  ORDER BY league,game_id,model_version,coalesce(player_id,''),as_of DESC,created_at DESC,forecast_id DESC
 ) f;
$$;
REVOKE ALL ON FUNCTION public.bk_analysis_forecasts(text,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bk_analysis_forecasts(text,text[]) TO service_role;
NOTIFY pgrst,'reload schema';
