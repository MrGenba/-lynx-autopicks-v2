-- Reserve four existing daily calls for research; keep the overall limit of 80.
ALTER TABLE public.bb_syndicate_ai_budget ADD COLUMN IF NOT EXISTS research_reserved_calls integer NOT NULL DEFAULT 0
 CHECK(research_reserved_calls BETWEEN 0 AND 4);
DROP FUNCTION IF EXISTS public.bb_syndicate_reserve_ai(text);
CREATE OR REPLACE FUNCTION public.bb_syndicate_reserve_ai(p_input_hash text,p_purpose text DEFAULT 'game_review')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE v_now timestamptz;v_day date;v_calls integer;v_research integer;v_previous timestamptz;
BEGIN
 IF p_input_hash IS NULL OR p_input_hash !~ '^[0-9a-f]{64}$' OR p_purpose IS NULL OR p_purpose NOT IN ('game_review','model_research') THEN
  RAISE EXCEPTION 'Invalid reservation identity'; END IF;
 PERFORM pg_advisory_xact_lock(1729316042,732002);
 v_now:=clock_timestamp();v_day:=(v_now AT TIME ZONE 'UTC')::date;
 DELETE FROM public.bb_syndicate_ai_budget WHERE day<v_day-13;
 DELETE FROM public.bb_syndicate_ai_claims WHERE last_reserved_at<v_now-interval '14 days';
 SELECT reserved_calls,research_reserved_calls INTO v_calls,v_research FROM public.bb_syndicate_ai_budget WHERE day=v_day;
 v_calls:=coalesce(v_calls,0);v_research:=coalesce(v_research,0);
 IF v_calls+4>80 THEN RETURN jsonb_build_object('granted',false,'reason','BUDGET_REACHED','calls_reserved_today',v_calls); END IF;
 IF p_purpose='game_review' AND v_calls-v_research+4>76 THEN
  RETURN jsonb_build_object('granted',false,'reason','FOUR_CALLS_RESERVED_FOR_RESEARCH','calls_reserved_today',v_calls); END IF;
 IF p_purpose='model_research' AND v_research>=4 THEN
  RETURN jsonb_build_object('granted',false,'reason','RESEARCH_DAILY_LIMIT','calls_reserved_today',v_calls); END IF;
 SELECT last_reserved_at INTO v_previous FROM public.bb_syndicate_ai_claims WHERE input_hash=p_input_hash;
 IF v_previous>v_now-interval '1 hour' THEN RETURN jsonb_build_object('granted',false,'reason','COOLDOWN','calls_reserved_today',v_calls); END IF;
 INSERT INTO public.bb_syndicate_ai_budget(day,reserved_calls,research_reserved_calls)
 VALUES(v_day,4,CASE WHEN p_purpose='model_research' THEN 4 ELSE 0 END)
 ON CONFLICT(day) DO UPDATE SET reserved_calls=public.bb_syndicate_ai_budget.reserved_calls+4,
 research_reserved_calls=public.bb_syndicate_ai_budget.research_reserved_calls+EXCLUDED.research_reserved_calls
 RETURNING reserved_calls INTO v_calls;
 INSERT INTO public.bb_syndicate_ai_claims(input_hash,last_reserved_at) VALUES(p_input_hash,v_now)
 ON CONFLICT(input_hash) DO UPDATE SET last_reserved_at=EXCLUDED.last_reserved_at;
 DELETE FROM public.bb_syndicate_ai_claims WHERE input_hash IN(
 SELECT input_hash FROM public.bb_syndicate_ai_claims ORDER BY last_reserved_at DESC,input_hash DESC OFFSET 5000);
 RETURN jsonb_build_object('granted',true,'reason','RESERVED','calls_reserved_today',v_calls,'purpose',p_purpose);
END $fn$;
REVOKE ALL ON FUNCTION public.bb_syndicate_reserve_ai(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bb_syndicate_reserve_ai(text,text) TO service_role;
NOTIFY pgrst,'reload schema';
