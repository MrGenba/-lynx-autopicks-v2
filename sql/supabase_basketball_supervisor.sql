CREATE TABLE IF NOT EXISTS public.bk_agent_actions (
 action_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task text NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'claimed' CHECK(status IN('claimed','requested','dispatch_unknown','recovered','unresolved')),
 evidence jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS bk_agent_actions_task_time ON public.bk_agent_actions(task,requested_at DESC);
ALTER TABLE public.bk_agent_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bk_agent_actions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.bk_agent_actions TO service_role;
CREATE OR REPLACE FUNCTION public.bk_agent_claim(p_task text,p_evidence jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE id uuid;BEGIN
 IF p_task NOT IN('capture','advanced','analysis','odds','props','research') OR p_evidence->>'task' IS DISTINCT FROM p_task OR jsonb_typeof(p_evidence->'affected') IS DISTINCT FROM 'array' OR jsonb_array_length(p_evidence->'affected')=0 THEN RAISE EXCEPTION 'RECOVERY_INVALID';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('bk_recovery:'||p_task));
 IF EXISTS(SELECT 1 FROM bk_locks WHERE name=p_task AND expires_at>now()) OR EXISTS(SELECT 1 FROM bk_agent_actions WHERE task=p_task AND requested_at>now()-interval '20 minutes') OR (SELECT count(*) FROM bk_agent_actions WHERE task=p_task AND requested_at>now()-interval '1 hour')>=2 THEN RETURN NULL;END IF;
 INSERT INTO bk_agent_actions(task,evidence) VALUES(p_task,p_evidence) RETURNING action_id INTO id;RETURN id;
END $$;
CREATE OR REPLACE FUNCTION public.bk_agent_finish(p_id uuid,p_status text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_status NOT IN('requested','dispatch_unknown','recovered','unresolved') THEN RAISE EXCEPTION 'RECOVERY_STATUS_INVALID';END IF;
 UPDATE bk_agent_actions SET status=p_status,updated_at=now() WHERE action_id=p_id AND ((status='claimed' AND p_status IN('requested','dispatch_unknown')) OR (status IN('claimed','requested','dispatch_unknown') AND p_status IN('recovered','unresolved')));RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.bk_agent_claim(text,jsonb),public.bk_agent_finish(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bk_agent_claim(text,jsonb),public.bk_agent_finish(uuid,text) TO service_role;
