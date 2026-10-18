-- QE Workspace schema v1 (01_ARCHITECTURE/06_DATA_MODEL.md §2). Never edit after merge (06 §5).
-- Runs as the migrator role; the application connects as a member of qews_app (DML only).

CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'qews_app') THEN
    CREATE ROLE qews_app NOLOGIN;
  END IF;
END
$$;

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  oidc_issuer   text NOT NULL,
  oidc_subject  text NOT NULL,
  username      citext NOT NULL,
  email         citext,
  display_name  text NOT NULL,
  status        text NOT NULL CHECK (status IN ('active','disabled')),
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (oidc_issuer, oidc_subject),
  UNIQUE (username)
);

CREATE TABLE roles (
  id   uuid PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  source  text NOT NULL CHECK (source IN ('idp_group','manual')),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE workspace_templates (
  id              text PRIMARY KEY,
  display_name    text NOT NULL,
  image_ref       text NOT NULL,
  default_profile text NOT NULL,
  settings_json   jsonb NOT NULL DEFAULT '{}',
  enabled         boolean NOT NULL DEFAULT true
);

CREATE TABLE workspaces (
  id               uuid PRIMARY KEY,
  name             text NOT NULL,
  owner_id         uuid NOT NULL REFERENCES users(id),
  template_id      text NOT NULL REFERENCES workspace_templates(id),
  state            text NOT NULL CHECK (state IN
                    ('CREATED','STARTING','RUNNING','STOPPING','STOPPED','FAILED','DELETING','DELETED')),
  state_reason     text,
  state_version    integer NOT NULL DEFAULT 0,
  runtime_kind     text NOT NULL CHECK (runtime_kind IN ('kubernetes','docker','local')),
  runtime_ref      text,
  resource_profile text NOT NULL,
  git_url          text,
  git_ref          text,
  settings_json    jsonb NOT NULL DEFAULT '{}',
  last_active_at   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- A deleted workspace frees its name (the documented UNIQUE (owner_id, name) would block reuse forever).
CREATE UNIQUE INDEX workspaces_owner_name_uq ON workspaces(owner_id, name) WHERE state <> 'DELETED';
CREATE INDEX workspaces_state_idx ON workspaces(state) WHERE state IN ('STARTING','RUNNING','STOPPING');

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);

CREATE TABLE connection_policies (
  id                    uuid PRIMARY KEY,
  name                  text NOT NULL UNIQUE,
  allowed_roles         text[] NOT NULL,
  allowed_cidrs         cidr[] NOT NULL,
  allowed_ports         int[]  NOT NULL DEFAULT '{22}',
  capabilities          text[] NOT NULL,
  idle_timeout_sec      int NOT NULL DEFAULT 1800,
  max_session_sec       int NOT NULL DEFAULT 28800,
  max_sessions_per_user int NOT NULL DEFAULT 5,
  require_jump_host     boolean NOT NULL DEFAULT false,
  version               int NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credential_refs (
  id            uuid PRIMARY KEY,
  provider      text NOT NULL CHECK (provider IN ('vault','azure_kv','aws_sm','gcp_sm','file_dev')),
  method        text NOT NULL CHECK (method IN ('ssh_certificate','vault_key','vault_password')),
  provider_path text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE targets (
  id                 uuid PRIMARY KEY,
  name               text NOT NULL UNIQUE,
  description        text,
  host               text NOT NULL,
  port               int  NOT NULL CHECK (port BETWEEN 1 AND 65535),
  os                 text NOT NULL CHECK (os IN ('linux','windows','macos','other')),
  principal_template text NOT NULL,
  remote_root        text NOT NULL,
  credential_ref_id  uuid REFERENCES credential_refs(id),
  policy_id          uuid NOT NULL REFERENCES connection_policies(id),
  jump_host_id       uuid REFERENCES targets(id),
  tags               text[] NOT NULL DEFAULT '{}',
  status             text NOT NULL CHECK (status IN ('pending_host_key','active','disabled')),
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE target_host_keys (
  id                 uuid PRIMARY KEY,
  target_id          uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  algorithm          text NOT NULL,
  fingerprint_sha256 text NOT NULL,
  public_key         text NOT NULL,
  status             text NOT NULL CHECK (status IN ('trusted','revoked')),
  approved_by        uuid REFERENCES users(id),
  approved_at        timestamptz,
  UNIQUE (target_id, fingerprint_sha256)
);

CREATE TABLE sessions (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id),
  workspace_id     uuid REFERENCES workspaces(id),
  target_id        uuid REFERENCES targets(id),
  kind             text NOT NULL CHECK (kind IN ('terminal','files','exec')),
  state            text NOT NULL CHECK (state IN
                    ('REQUESTED','AUTHORIZED','DENIED','CONNECTING','ACTIVE','CLOSING','CLOSED','FAILED','EXPIRED','REVOKED')),
  close_reason     text,
  broker_instance  text,
  policy_version   int,
  client_ip        inet,
  created_at       timestamptz NOT NULL DEFAULT now(),
  activated_at     timestamptz,
  last_activity_at timestamptz,
  expires_at       timestamptz NOT NULL,
  closed_at        timestamptz
);
CREATE INDEX sessions_active_user_idx ON sessions(user_id) WHERE state IN ('AUTHORIZED','CONNECTING','ACTIVE');

CREATE TABLE session_tickets (
  ticket_hash bytea PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  origin      text NOT NULL,
  expires_at  timestamptz NOT NULL,
  redeemed_at timestamptz
);

CREATE TABLE test_runs (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_id    uuid REFERENCES targets(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  framework    text NOT NULL,
  selector     text,
  state        text NOT NULL CHECK (state IN ('QUEUED','RUNNING','PASSED','FAILED','ERROR','CANCELLED')),
  exit_code    int,
  counts_json  jsonb NOT NULL DEFAULT '{}',
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE test_artifacts (
  id          uuid PRIMARY KEY,
  test_run_id uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('junit_xml','html_report','log','screenshot','other')),
  storage_ref text NOT NULL,
  size_bytes  bigint NOT NULL,
  sha256      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Append-only, hash-chained audit log. `seq` orders the chain (occurred_at alone can tie or interleave).
CREATE TABLE audit_events (
  seq           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id            uuid PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_type    text NOT NULL CHECK (actor_type IN ('user','service','system')),
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  result        text NOT NULL CHECK (result IN ('success','denied','failure')),
  reason_code   text,
  request_id    text,
  trace_id      text,
  session_id    uuid,
  client_ip     inet,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  prev_hash     bytea,
  hash          bytea NOT NULL
);
CREATE INDEX audit_time_idx ON audit_events(occurred_at DESC);
CREATE INDEX audit_actor_idx ON audit_events(actor_user_id, occurred_at DESC);
CREATE INDEX audit_resource_idx ON audit_events(resource_type, resource_id, occurred_at DESC);

-- Defence in depth beyond the grants: nobody updates, deletes or truncates audit rows through SQL.
-- (Retention drops whole monthly partitions later, which triggers do not block.)
CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END
$$;
CREATE TRIGGER audit_events_no_update_delete BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();

-- Least privilege for the application role: DML on its tables, append-only audit, read-only migrations.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO qews_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, roles, user_roles, workspace_templates, workspaces, workspace_members, connection_policies,
  credential_refs, targets, target_host_keys, sessions, session_tickets, test_runs, test_artifacts
  TO qews_app;
GRANT SELECT, INSERT ON audit_events TO qews_app;
GRANT SELECT ON schema_migrations TO qews_app;
