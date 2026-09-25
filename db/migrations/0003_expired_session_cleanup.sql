CREATE OR REPLACE FUNCTION prevent_immutable_row_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  affected_workspace UUID;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('tracepilot.allow_expired_cleanup', true) = 'on' THEN
    IF TG_TABLE_NAME IN ('runs', 'decisions', 'rerun_executions') THEN
      affected_workspace := OLD.workspace_id;
    ELSIF TG_TABLE_NAME IN ('run_spans', 'constraints', 'run_events') THEN
      SELECT workspace_id INTO affected_workspace FROM runs WHERE id = OLD.run_id;
    END IF;

    IF affected_workspace IS NOT NULL AND EXISTS (
      SELECT 1 FROM review_sessions
      WHERE workspace_id = affected_workspace AND expires_at <= now()
    ) THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION '% rows are immutable; append a new record instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION guard_proposal_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_setting('tracepilot.allow_expired_cleanup', true) = 'on'
    AND EXISTS (
      SELECT 1 FROM review_sessions
      WHERE workspace_id = OLD.workspace_id AND expires_at <= now()
    ) THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'proposal rows cannot be deleted' USING ERRCODE = '55000';
  END IF;

  IF (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'proposal content is immutable; only status transitions are allowed'
      USING ERRCODE = '55000';
  END IF;

  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'approved' AND NEW.status = 'executed')
  ) THEN
    RAISE EXCEPTION 'invalid proposal status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;
