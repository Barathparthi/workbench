-- Phase 11: what the QE runner records about a run besides its counts — how long it took, its failed cases (capped,
-- for the run history; the full list is in the run's JUnit file) and whether anything was cut — and the indexes the
-- run history reads by. `selector` holds the selector as JSON. Never edit after merge (06 §5).

ALTER TABLE test_runs
  ADD COLUMN duration_ms   int CHECK (duration_ms >= 0),
  ADD COLUMN failures_json jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN truncated     boolean NOT NULL DEFAULT false;

CREATE INDEX test_runs_workspace_idx ON test_runs(workspace_id, created_at DESC);
CREATE INDEX test_runs_user_idx ON test_runs(user_id, created_at DESC);
CREATE INDEX test_artifacts_run_idx ON test_artifacts(test_run_id);
