BEGIN;
CREATE TABLE IF NOT EXISTS public.bb_asian_lineup_notifications (
 league text NOT NULL CHECK (league IN ('KBO','NPB','CPBL')),
 game_pk text NOT NULL,
 side text NOT NULL CHECK (side IN ('away','home')),
 payload jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 lease_owner text,
 lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 sent_at timestamptz,
 telegram_message_id bigint,
 last_error text,
 PRIMARY KEY(league,game_pk,side)
);
CREATE TABLE IF NOT EXISTS public.bb_lineup_health (
 league text PRIMARY KEY,
 checked_at timestamptz NOT NULL,
 enabled boolean NOT NULL,
 status text NOT NULL CHECK(status IN ('healthy','error','unsupported')),
 detail jsonb NOT NULL
);
ALTER TABLE public.bb_asian_lineup_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bb_lineup_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bb_asian_lineup_notifications,public.bb_lineup_health FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.bb_asian_lineup_notifications,public.bb_lineup_health TO service_role;

CREATE OR REPLACE FUNCTION public.bb_claim_asian_lineup(p_event jsonb,p_owner text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE claimed public.bb_asian_lineup_notifications; starts timestamptz;
BEGIN
 starts := (p_event->>'starts_at')::timestamptz;
 IF p_owner IS NULL OR length(p_owner)=0 OR starts IS NULL OR starts<now()-interval '30 minutes' OR starts>now()+interval '5 hours'
 OR jsonb_typeof(p_event->'players') IS DISTINCT FROM 'array' OR jsonb_array_length(p_event->'players')<>9 THEN
  RAISE EXCEPTION 'INVALID_LINEUP_CLAIM';
 END IF;
 INSERT INTO public.bb_asian_lineup_notifications(league,game_pk,side,payload,expires_at)
 VALUES(p_event->>'league',p_event->>'game_pk',p_event->>'side',p_event,starts+interval '30 minutes')
 ON CONFLICT(league,game_pk,side) DO UPDATE SET payload=EXCLUDED.payload,observed_at=now(),expires_at=EXCLUDED.expires_at
 WHERE bb_asian_lineup_notifications.sent_at IS NULL AND (bb_asian_lineup_notifications.lease_until IS NULL OR bb_asian_lineup_notifications.lease_until<now());
 UPDATE public.bb_asian_lineup_notifications SET lease_owner=p_owner,lease_until=now()+interval '5 minutes',attempts=attempts+1,last_error=NULL
 WHERE league=p_event->>'league' AND game_pk=p_event->>'game_pk' AND side=p_event->>'side' AND sent_at IS NULL
 AND expires_at>=now() AND (lease_until IS NULL OR lease_until<now()) RETURNING * INTO claimed;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN to_jsonb(claimed);
END $$;
CREATE OR REPLACE FUNCTION public.bb_finish_asian_lineup(p_league text,p_game_pk text,p_side text,p_owner text,p_message_id bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_message_id IS NOT NULL AND p_message_id<=0 THEN RAISE EXCEPTION 'INVALID_MESSAGE_ID'; END IF;
 UPDATE public.bb_asian_lineup_notifications SET
 sent_at=CASE WHEN p_message_id IS NOT NULL THEN now() ELSE NULL END,
 telegram_message_id=p_message_id,
 last_error=CASE WHEN p_message_id IS NULL THEN 'TELEGRAM_DELIVERY_FAILED' ELSE NULL END,
 lease_owner=NULL,lease_until=NULL
 WHERE league=p_league AND game_pk=p_game_pk AND side=p_side AND lease_owner=p_owner AND sent_at IS NULL;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.bb_claim_asian_lineup(jsonb,text),public.bb_finish_asian_lineup(text,text,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bb_claim_asian_lineup(jsonb,text),public.bb_finish_asian_lineup(text,text,text,text,bigint) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
