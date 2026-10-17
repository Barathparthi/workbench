# 06 — Data Model (PostgreSQL)

## 1. Entity relationships

```text
users 1─N workspace_members N─1 workspaces 1─N test_runs 1─N test_artifacts
users N─M roles (user_roles, sourced from IdP groups)
workspaces N─1 workspace_templates
targets N─1 connection_policies
targets 1─N target_host_keys
targets N─1 credential_refs
targets N─0..1 targets (jump_host_id)
sessions N─1 users, N─0..1 workspaces, N─0..1 targets
session_tickets N─1 sessions
audit_events (append-only; references by id, no FK to allow retention of deleted resources)
```

## 2. DDL (migration `0001_init.sql` — illustrative, review before use)

```sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  oidc_issuer   text NOT NULL,
  oidc_subject  text NOT NULL,
  username      citext NOT NULL,            -- used for SSH principal mapping
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
  name text NOT NULL UNIQUE                -- e.g. qe.user, qe.admin, lab.a.user, auditor
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  source  text NOT NULL CHECK (source IN ('idp_group','manual')),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE workspace_templates (
  id            text PRIMARY KEY,           -- tpl_python_pytest
  display_name  text NOT NULL,
  image_ref     text NOT NULL,              -- registry/qe-runtime-python@sha256:...
  default_profile text NOT NULL,
  settings_json jsonb NOT NULL DEFAULT '{}',
  enabled       boolean NOT NULL DEFAULT true
);

CREATE TABLE workspaces (
  id              uuid PRIMARY KEY,
  name            text NOT NULL,
  owner_id        uuid NOT NULL REFERENCES users(id),
  template_id     text NOT NULL REFERENCES workspace_templates(id),
  state           text NOT NULL CHECK (state IN
                   ('CREATED','STARTING','RUNNING','STOPPING','STOPPED','FAILED','DELETING','DELETED')),
  state_reason    text,
  state_version   integer NOT NULL DEFAULT 0,  -- optimistic concurrency
  runtime_kind    text NOT NULL CHECK (runtime_kind IN ('kubernetes','docker','local')),
  runtime_ref     text,                        -- pod name / container id
  resource_profile text NOT NULL,
  git_url         text,
  git_ref         text,
  settings_json   jsonb NOT NULL DEFAULT '{}',
  last_active_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);
CREATE INDEX workspaces_state_idx ON workspaces(state) WHERE state IN ('STARTING','RUNNING','STOPPING');

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE connection_policies (
  id                 uuid PRIMARY KEY,
  name               text NOT NULL UNIQUE,
  allowed_roles      text[] NOT NULL,          -- role names
  allowed_cidrs      cidr[] NOT NULL,          -- resolved IP must be inside one
  allowed_ports      int[]  NOT NULL DEFAULT '{22}',
  capabilities       text[] NOT NULL,          -- terminal, file_read, file_write, exec, port_forward
  idle_timeout_sec   int NOT NULL DEFAULT 1800,
  max_session_sec    int NOT NULL DEFAULT 28800,
  max_sessions_per_user int NOT NULL DEFAULT 5,
  require_jump_host  boolean NOT NULL DEFAULT false,
  version            int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credential_refs (
  id            uuid PRIMARY KEY,
  provider      text NOT NULL CHECK (provider IN ('vault','azure_kv','aws_sm','gcp_sm','file_dev')),
  method        text NOT NULL CHECK (method IN ('ssh_certificate','vault_key','vault_password')),
  provider_path text NOT NULL,                 -- e.g. ssh-client-signer/sign/qe-lab-a  or kv/data/targets/tg_1
  metadata_json jsonb NOT NULL DEFAULT '{}',   -- NON-SECRET: key type, CA role, ttl
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE targets (
  id             uuid PRIMARY KEY,
  name           text NOT NULL UNIQUE,
  description    text,
  host           text NOT NULL,                -- FQDN or IP literal, validated
  port           int  NOT NULL CHECK (port BETWEEN 1 AND 65535),
  os             text NOT NULL CHECK (os IN ('linux','windows','macos','other')),
  principal_template text NOT NULL,            -- '{{user.username}}' or fixed service user
  remote_root    text NOT NULL,                -- absolute, normalized
  credential_ref_id uuid REFERENCES credential_refs(id),
  policy_id      uuid NOT NULL REFERENCES connection_policies(id),
  jump_host_id   uuid REFERENCES targets(id),
  tags           text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL CHECK (status IN ('pending_host_key','active','disabled')),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE target_host_keys (
  id                 uuid PRIMARY KEY,
  target_id          uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  algorithm          text NOT NULL,            -- ssh-ed25519, ecdsa-sha2-nistp256, rsa-sha2-512
  fingerprint_sha256 text NOT NULL,            -- 'SHA256:base64…'
  public_key         text NOT NULL,            -- OpenSSH format (public, non-secret)
  status             text NOT NULL CHECK (status IN ('trusted','revoked')),
  approved_by        uuid REFERENCES users(id),
  approved_at        timestamptz,
  UNIQUE (target_id, fingerprint_sha256)
);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id),
  workspace_id    uuid REFERENCES workspaces(id),
  target_id       uuid REFERENCES targets(id),
  kind            text NOT NULL CHECK (kind IN ('terminal','files','exec')),
  state           text NOT NULL CHECK (state IN
                   ('REQUESTED','AUTHORIZED','DENIED','CONNECTING','ACTIVE','CLOSING','CLOSED','FAILED','EXPIRED','REVOKED')),
  close_reason    text,
  broker_instance text,
  policy_version  int,
  client_ip       inet,
  created_at      timestamptz NOT NULL DEFAULT now(),
  activated_at    timestamptz,
  last_activity_at timestamptz,
  expires_at      timestamptz NOT NULL,
  closed_at       timestamptz
);
CREATE INDEX sessions_active_user_idx ON sessions(user_id) WHERE state IN ('AUTHORIZED','CONNECTING','ACTIVE');

CREATE TABLE session_tickets (
  ticket_hash  bytea PRIMARY KEY,              -- SHA-256 of ticket; raw ticket never stored
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  origin       text NOT NULL,
  expires_at   timestamptz NOT NULL,
  redeemed_at  timestamptz
);

CREATE TABLE test_runs (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_id     uuid REFERENCES targets(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  framework     text NOT NULL,                 -- pytest, maven-surefire, …
  selector      text,                          -- test id/path (validated, not a shell string)
  state         text NOT NULL CHECK (state IN ('QUEUED','RUNNING','PASSED','FAILED','ERROR','CANCELLED')),
  exit_code     int,
  counts_json   jsonb NOT NULL DEFAULT '{}',   -- {total, passed, failed, skipped, errors}
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE test_artifacts (
  id          uuid PRIMARY KEY,
  test_run_id uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('junit_xml','html_report','log','screenshot','other')),
  storage_ref text NOT NULL,                   -- object storage key or workspace-relative path
  size_bytes  bigint NOT NULL,
  sha256      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
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
  prev_hash     bytea,                         -- hash chain for tamper evidence
  hash          bytea NOT NULL
);
CREATE INDEX audit_time_idx ON audit_events(occurred_at DESC);
CREATE INDEX audit_actor_idx ON audit_events(actor_user_id, occurred_at DESC);
CREATE INDEX audit_resource_idx ON audit_events(resource_type, resource_id, occurred_at DESC);

-- Least-privilege grants for the application role
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM qews_app;
GRANT INSERT, SELECT ON audit_events TO qews_app;
```

## 3. Audit actions (catalogue)

```text
AUTH_LOGIN_SUCCESS, AUTH_LOGIN_FAILURE, AUTH_LOGOUT, AUTH_SESSION_EXPIRED
WORKSPACE_CREATE, WORKSPACE_START, WORKSPACE_STOP, WORKSPACE_DELETE, WORKSPACE_OPEN, WORKSPACE_MEMBER_CHANGE
TARGET_CREATE, TARGET_UPDATE, TARGET_DELETE, TARGET_HOST_KEY_APPROVED, TARGET_HOST_KEY_REVOKED
POLICY_CREATE, POLICY_UPDATE
REMOTE_CONNECT_REQUEST, REMOTE_CONNECT_ALLOWED, REMOTE_CONNECT_DENIED
SSRF_BLOCKED, SSH_HOST_KEY_MISMATCH, SSH_HOST_KEY_UNKNOWN, SSH_AUTH_FAILED
SSH_SESSION_OPENED, SSH_SESSION_CLOSED, SESSION_REVOKED, SESSION_EXPIRED
REMOTE_FILE_WRITE, REMOTE_FILE_DELETE, REMOTE_FILE_RENAME, REMOTE_EXEC
QE_TEST_STARTED, QE_TEST_CANCELLED, QE_TEST_FINISHED
PORT_FORWARD_REQUESTED, PORT_FORWARD_DENIED, PORT_FORWARD_OPENED, PORT_FORWARD_CLOSED
CREDENTIAL_ISSUED (cert serial, ttl — never the material), CREDENTIAL_FAILURE
ADMIN_BREAK_GLASS
```

`metadata_json` allowed keys are defined per action in `packages/contracts/audit.ts` (allowlist, not
free-form). Forbidden in metadata: secrets, tokens, file contents, terminal bytes, command lines.

## 4. Retention

| Table | Retention | Mechanism |
|---|---|---|
| sessions | 90 days after close | nightly job |
| session_tickets | 1 day | nightly job |
| test_runs/artifacts | 30–90 days (configurable) | job + object storage lifecycle |
| audit_events | per E1 (e.g. 1 year hot) | partition by month (`PARTITION BY RANGE (occurred_at)`), export to archive then drop partition |

## 5. Migration rules

- `0001_init.sql`, `0002_…` — never edit a merged migration.
- Breaking change = expand (add new column/table, dual-write) → deploy → backfill → contract in a later release.
- Migrations run as a Kubernetes **Job** (Helm pre-upgrade hook) with a DB role that has DDL rights;
  the app role has only DML rights.
