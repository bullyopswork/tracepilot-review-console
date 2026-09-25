CREATE TABLE review_sessions (
  token_hash TEXT PRIMARY KEY CHECK (char_length(token_hash) = 64),
  workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id),
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE runs ADD CONSTRAINT runs_id_workspace_unique UNIQUE (id, workspace_id);

ALTER TABLE proposals ADD COLUMN workspace_id UUID REFERENCES workspaces(id);
UPDATE proposals p
SET workspace_id = r.workspace_id
FROM runs r
WHERE r.id = p.run_id;
ALTER TABLE proposals ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE proposals DROP CONSTRAINT proposals_run_id_fkey;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_run_workspace_fk
  FOREIGN KEY (run_id, workspace_id) REFERENCES runs(id, workspace_id);
ALTER TABLE proposals ADD CONSTRAINT proposals_id_run_workspace_unique UNIQUE (id, run_id, workspace_id);

ALTER TABLE decisions ADD COLUMN workspace_id UUID REFERENCES workspaces(id);
UPDATE decisions d
SET workspace_id = p.workspace_id
FROM proposals p
WHERE p.id = d.proposal_id AND p.run_id = d.run_id;
ALTER TABLE decisions ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE decisions DROP CONSTRAINT decisions_run_id_fkey;
ALTER TABLE decisions
  ADD CONSTRAINT decisions_run_workspace_fk
  FOREIGN KEY (run_id, workspace_id) REFERENCES runs(id, workspace_id);
ALTER TABLE decisions
  ADD CONSTRAINT decisions_proposal_scope_fk
  FOREIGN KEY (proposal_id, run_id, workspace_id) REFERENCES proposals(id, run_id, workspace_id);

CREATE TABLE rerun_executions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  baseline_run_id UUID NOT NULL,
  proposal_id UUID NOT NULL,
  after_run_id UUID NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (proposal_id),
  FOREIGN KEY (baseline_run_id, workspace_id) REFERENCES runs(id, workspace_id),
  FOREIGN KEY (proposal_id, baseline_run_id, workspace_id)
    REFERENCES proposals(id, run_id, workspace_id),
  FOREIGN KEY (after_run_id, workspace_id) REFERENCES runs(id, workspace_id)
);

CREATE OR REPLACE FUNCTION guard_proposal_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
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

CREATE TRIGGER proposals_guarded_transition
  BEFORE UPDATE OR DELETE ON proposals
  FOR EACH ROW EXECUTE FUNCTION guard_proposal_transition();

CREATE TRIGGER rerun_executions_append_only
  BEFORE UPDATE OR DELETE ON rerun_executions
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();
