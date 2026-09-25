CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (char_length(slug) BETWEEN 1 AND 80),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  baseline_run_id UUID REFERENCES runs(id),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 180),
  mode TEXT NOT NULL CHECK (mode IN ('synthetic_demo')),
  status TEXT NOT NULL CHECK (status IN ('failed', 'improved')),
  prompt TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 8000),
  answer TEXT NOT NULL CHECK (char_length(answer) BETWEEN 1 AND 12000),
  trace_facts JSONB NOT NULL CHECK (
    jsonb_typeof(trace_facts) = 'object'
    AND (trace_facts - ARRAY[
      'destination', 'proposed_start_date', 'proposed_end_date',
      'quoted_total_usd', 'step_free_supported', 'trip_type'
    ]) = '{}'::jsonb
  ),
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (baseline_run_id IS DISTINCT FROM id)
);

CREATE INDEX runs_workspace_created_idx ON runs (workspace_id, created_at DESC);
CREATE INDEX runs_baseline_idx ON runs (baseline_run_id) WHERE baseline_run_id IS NOT NULL;

CREATE TABLE run_spans (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'model', 'tool', 'check')),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 1000),
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, position)
);

CREATE TABLE constraints (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 180),
  rule_code TEXT NOT NULL CHECK (rule_code IN (
    'destination_match', 'dates_exact', 'budget_max', 'accessible_route', 'round_trip'
  )),
  required_value JSONB NOT NULL CHECK (jsonb_typeof(required_value) = 'object'),
  UNIQUE (run_id, position),
  UNIQUE (id, run_id)
);

CREATE TABLE check_results (
  run_id UUID NOT NULL REFERENCES runs(id),
  constraint_id UUID NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('passed', 'failed')),
  explanation TEXT NOT NULL CHECK (char_length(explanation) BETWEEN 1 AND 1000),
  source TEXT NOT NULL CHECK (source IN ('seeded', 'deterministic_demo')),
  evaluated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, constraint_id),
  FOREIGN KEY (constraint_id, run_id) REFERENCES constraints(id, run_id)
);

CREATE TABLE proposals (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id),
  version INTEGER NOT NULL CHECK (version > 0),
  source TEXT NOT NULL CHECK (source IN ('deterministic_demo', 'gemini')),
  proposed_task TEXT NOT NULL CHECK (char_length(proposed_task) BETWEEN 1 AND 8000),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'executed')),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, version),
  UNIQUE (run_id, idempotency_key)
);

CREATE TABLE decisions (
  id UUID PRIMARY KEY,
  proposal_id UUID NOT NULL REFERENCES proposals(id),
  run_id UUID NOT NULL REFERENCES runs(id),
  action TEXT NOT NULL CHECK (action IN ('approved', 'rejected')),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  reviewer TEXT NOT NULL CHECK (char_length(reviewer) BETWEEN 1 AND 120),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (proposal_id, idempotency_key)
);

CREATE TABLE run_events (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 80),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, sequence)
);

CREATE OR REPLACE FUNCTION prevent_immutable_row_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable; append a new record instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER runs_immutable
  BEFORE UPDATE OR DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();
CREATE TRIGGER run_spans_immutable
  BEFORE UPDATE OR DELETE ON run_spans
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();
CREATE TRIGGER constraints_immutable
  BEFORE UPDATE OR DELETE ON constraints
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();
CREATE TRIGGER run_events_append_only
  BEFORE UPDATE OR DELETE ON run_events
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();
CREATE TRIGGER decisions_append_only
  BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();
