-- Repeated delivery of the same execution's lock request is idempotent.
CREATE OR REPLACE FUNCTION public.bk_lock(p_name text,p_owner text,p_release boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_release THEN DELETE FROM bk_locks WHERE name=p_name AND owner=p_owner;RETURN FOUND;END IF;
 INSERT INTO bk_locks VALUES(p_name,p_owner,now()+interval '20 minutes')
 ON CONFLICT(name) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at
 WHERE bk_locks.expires_at<now() OR bk_locks.owner=EXCLUDED.owner;
 RETURN FOUND;
END $$;
