CREATE TABLE IF NOT EXISTS public.bb_calibration_protocol (
 protocol_id text PRIMARY KEY, registered_at timestamptz NOT NULL DEFAULT now(), config jsonb NOT NULL);
INSERT INTO bb_calibration_protocol(protocol_id,config) VALUES('all-candidates-v1',
 '{"training_games":400,"validation_games":150,"test_games":200,"minimum_span_days":60,"auto_promotion":false,"include_unpublished":true,"group_by":["league","market","pipeline","model_version"],"models":["market","current","raw","fitted_blend","logistic"]}') ON CONFLICT DO NOTHING;
ALTER TABLE bb_calibration_protocol ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON bb_calibration_protocol FROM anon,authenticated;
GRANT SELECT ON bb_calibration_protocol TO service_role;
CREATE TABLE IF NOT EXISTS public.bb_model_evaluation_runs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, evaluated_at timestamptz NOT NULL DEFAULT now(),
 protocol_id text NOT NULL REFERENCES bb_calibration_protocol, report jsonb NOT NULL);
ALTER TABLE bb_model_evaluation_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON bb_model_evaluation_runs FROM anon,authenticated;
GRANT SELECT,INSERT ON bb_model_evaluation_runs TO service_role;
GRANT USAGE ON SEQUENCE bb_model_evaluation_runs_id_seq TO service_role;

CREATE OR REPLACE VIEW public.bb_all_candidates_evaluation WITH (security_invoker=true) AS
WITH games AS (
 SELECT 'MLB' league,game_pk game_id,away_score,home_score,status FROM mlb_games
 UNION ALL SELECT 'MiLB',game_id,away_score,home_score,status FROM daily_games WHERE sport_id=11
 UNION ALL SELECT 'LMB',game_pk,away_score,home_score,status FROM lmb_games
), candidates AS (
 SELECT s.snapshot_id,s.league,s.game_id,s.pipeline,s.model_version,s.prediction_at,s.game_start,c.value,
 CASE WHEN c.value->>'market'='ML' THEN 'ML' WHEN c.value->>'market' LIKE 'HC%' THEN 'HC' ELSE 'OU' END market,
 CASE WHEN c.value->>'market' IN ('OVER','HC_AWAY') OR upper(c.value->>'pick_side') LIKE 'AWAY%' OR upper(c.value->>'pick_side') LIKE 'OVER%' THEN true ELSE false END canonical,
 CASE WHEN c.value->>'market'='ML' THEN 0::numeric WHEN c.value->>'market' LIKE 'HC%' THEN (c.value->>'hc_value')::numeric ELSE (c.value->>'total_line')::numeric END line,
 (c.value->>'odds')::numeric odds,
 coalesce(c.value->>'raw_prob_estimated',c.value->>'prob_model')::numeric raw,
 coalesce(c.value->>'prob_blended',c.value->>'prob_estimated',c.value->>'prob_model')::numeric current
 FROM bb_prediction_snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.output->'candidates') c(value)
 JOIN bb_calibration_protocol p ON p.protocol_id='all-candidates-v1'
 WHERE s.prediction_at>=p.registered_at AND s.prediction_at<s.game_start AND s.captured_at<s.game_start
 AND s.scheduled_innings=9 AND s.quality_flags='[]'::jsonb
 AND s.odds_captured_at BETWEEN s.prediction_at-interval '20 minutes' AND s.prediction_at
 AND c.value->>'market' IN ('ML','HC_AWAY','HC_HOME','OU','OVER','UNDER')
), paired AS (
 SELECT c.*, (1/c.odds)/(1/c.odds+1/u.odds) market_probability,
 CASE WHEN c.market='ML' THEN (g.away_score>g.home_score)::integer
 WHEN c.market='HC' THEN (g.away_score+c.line>g.home_score)::integer
 ELSE (g.away_score+g.home_score>c.line)::integer END y,
 EXISTS(SELECT 1 FROM bb_prediction_publications p WHERE p.snapshot_id=c.snapshot_id AND
 ((p.market=c.value->>'market' AND p.pick_side=c.value->>'pick_side') OR (p.market=u.value->>'market' AND p.pick_side=u.value->>'pick_side'))) published,
 row_number() OVER(PARTITION BY c.league,c.game_id,c.pipeline,c.market,c.model_version ORDER BY c.prediction_at,c.snapshot_id,c.line) priority
 FROM candidates c JOIN candidates u ON c.snapshot_id=u.snapshot_id AND c.market=u.market AND c.canonical AND NOT u.canonical
 AND ((c.market='HC' AND c.line=-u.line) OR (c.market<>'HC' AND c.line=u.line))
 JOIN games g ON g.league=c.league AND g.game_id=c.game_id
 WHERE c.odds>1 AND u.odds>1 AND c.raw>0 AND c.raw<1 AND c.current>0 AND c.current<1
 AND g.status IN ('Final','Game Over') AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
 AND ((c.market='ML' AND g.home_score<>g.away_score) OR (c.market IN ('HC','OU') AND abs(mod(c.line,1))=0.5))
)
SELECT snapshot_id,league,game_id,pipeline,model_version,prediction_at,game_start,market,line,odds,raw,current,market_probability,y,published,
 value->>'model_decision' model_decision,value->'decision_reasons' decision_reasons
FROM paired WHERE priority=1;
REVOKE ALL ON bb_all_candidates_evaluation FROM anon,authenticated;
GRANT SELECT ON bb_all_candidates_evaluation TO service_role;
NOTIFY pgrst,'reload schema';
