-- Phase 04: server-side browser sessions (07_SECURITY §4.1) and the platform roles of the RBAC matrix.
-- Never edit after merge (06 §5).

-- The cookie holds a random 256-bit token; only its SHA-256 is stored, as is the session's CSRF token.
CREATE TABLE web_sessions (
  id           uuid PRIMARY KEY,
  token_hash   bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  csrf_hash    bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX web_sessions_user_idx ON web_sessions(user_id);
CREATE INDEX web_sessions_expires_idx ON web_sessions(expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON web_sessions TO qews_app;

-- Fixed platform roles (packages/rbac RoleMatrix). Lab roles (lab.<name>.user) are added on first use.
INSERT INTO roles (id, name) VALUES
  ('0192d2a4-0000-7000-8000-000000000001', 'qe.user'),
  ('0192d2a4-0000-7000-8000-000000000002', 'qe.lead'),
  ('0192d2a4-0000-7000-8000-000000000003', 'qe.admin'),
  ('0192d2a4-0000-7000-8000-000000000004', 'auditor')
ON CONFLICT (name) DO NOTHING;
