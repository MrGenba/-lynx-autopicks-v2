CREATE TABLE IF NOT EXISTS public.bb_model_research_context (
 context_id text PRIMARY KEY,updated_at timestamptz NOT NULL DEFAULT now(),summary jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS public.bb_model_research_reviews (
 input_hash text PRIMARY KEY CHECK(input_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 packet jsonb NOT NULL,review jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS public.bb_model_comparison_decisions (
 comparison_key text PRIMARY KEY,protocol_id text NOT NULL REFERENCES bb_calibration_protocol,
 group_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 report jsonb NOT NULL,assessment jsonb NOT NULL,review_hash text REFERENCES bb_model_research_reviews,
 telegram_state text NOT NULL DEFAULT 'pending' CHECK(telegram_state IN ('pending','claimed','sent','uncertain')),
 claimed_at timestamptz,telegram_message_id bigint,notified_at timestamptz);
ALTER TABLE bb_model_research_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE bb_model_research_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE bb_model_comparison_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON bb_model_research_context,bb_model_research_reviews,bb_model_comparison_decisions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON bb_model_research_context,bb_model_research_reviews,bb_model_comparison_decisions TO service_role;
CREATE OR REPLACE FUNCTION public.bb_preserve_model_assessment() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
BEGIN
 IF NEW.report IS DISTINCT FROM OLD.report OR NEW.assessment IS DISTINCT FROM OLD.assessment
 OR NEW.protocol_id IS DISTINCT FROM OLD.protocol_id OR NEW.group_key IS DISTINCT FROM OLD.group_key
 OR NEW.comparison_key IS DISTINCT FROM OLD.comparison_key THEN RAISE EXCEPTION 'Final model assessment is immutable'; END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS bb_preserve_model_assessment ON bb_model_comparison_decisions;
CREATE TRIGGER bb_preserve_model_assessment BEFORE UPDATE ON bb_model_comparison_decisions
FOR EACH ROW EXECUTE FUNCTION bb_preserve_model_assessment();
-- A completed test is a single assessment, including unsuccessful tests.
DROP FUNCTION IF EXISTS public.bb_freeze_model_comparison(text,text,jsonb,jsonb);
CREATE FUNCTION public.bb_freeze_model_comparison(p_key text,p_protocol text,p_group jsonb,p_assessment jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE r public.bb_model_comparison_decisions;
BEGIN
 IF p_group->>'status'<>'ready_for_review' OR p_group->>'evidence'<>'prospective_sealed_predictions'
 OR (p_group->>'test')::int<200 OR p_key<>p_protocol||'|'||(p_group->>'group')
 THEN RAISE EXCEPTION 'Completed prospective test required'; END IF;
 INSERT INTO bb_model_comparison_decisions(comparison_key,protocol_id,group_key,report,assessment)
 VALUES(p_key,p_protocol,p_group->>'group',p_group,p_assessment) ON CONFLICT DO NOTHING;
 SELECT * INTO r FROM bb_model_comparison_decisions WHERE comparison_key=p_key;
 RETURN to_jsonb(r);
END $fn$;
CREATE OR REPLACE FUNCTION public.bb_claim_model_improvement(p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE n integer;
BEGIN
 UPDATE bb_model_comparison_decisions SET telegram_state='claimed',claimed_at=now()
 WHERE comparison_key=p_key AND telegram_state='pending' AND assessment->>'improved'='true';
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n=1;
END $fn$;
REVOKE ALL ON FUNCTION public.bb_freeze_model_comparison(text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.bb_claim_model_improvement(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bb_freeze_model_comparison(text,text,jsonb,jsonb),public.bb_claim_model_improvement(text) TO service_role;
NOTIFY pgrst,'reload schema';
