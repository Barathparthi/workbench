-- Phase 11 (P11.4): test runs on remote targets. A run started from the desktop app belongs to no hosted workspace,
-- and a remote run is carried by an exec session: the broker builds its command from the run's framework and
-- selector, found through this link. Never edit after merge (06 §5).

ALTER TABLE test_runs
  ALTER COLUMN workspace_id DROP NOT NULL,
  ADD COLUMN session_id uuid REFERENCES sessions(id);

-- One run per exec session; and a run that belongs to no workspace is its user's alone.
CREATE UNIQUE INDEX test_runs_session_idx ON test_runs(session_id) WHERE session_id IS NOT NULL;
ALTER TABLE test_runs ADD CONSTRAINT test_runs_remote_or_workspace
  CHECK (workspace_id IS NOT NULL OR target_id IS NOT NULL);
