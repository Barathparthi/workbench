import type { ColumnType, Generated } from 'kysely';

import type { WorkspaceState } from '@qe/domain';

/** Kysely table types for the tables the control plane uses (migrations/0001_init.sql). */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<Record<string, unknown>, string | undefined, string>;

export interface UsersTable {
  id: string;
  oidc_issuer: string;
  oidc_subject: string;
  username: string;
  email: string | null;
  display_name: string;
  status: 'active' | 'disabled';
  last_login_at: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WorkspaceTemplatesTable {
  id: string;
  display_name: string;
  image_ref: string;
  default_profile: string;
  settings_json: Json;
  enabled: boolean;
}

export interface WorkspacesTable {
  id: string;
  name: string;
  owner_id: string;
  template_id: string;
  state: WorkspaceState;
  state_reason: string | null;
  state_version: Generated<number>;
  runtime_kind: 'kubernetes' | 'docker' | 'local';
  runtime_ref: string | null;
  resource_profile: string;
  git_url: string | null;
  git_ref: string | null;
  settings_json: Json;
  last_active_at: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WorkspaceMembersTable {
  workspace_id: string;
  user_id: string;
  role: 'owner' | 'editor' | 'viewer';
  created_at: Timestamp;
}

export interface AuditEventsTable {
  seq: Generated<string>;
  id: string;
  occurred_at: Date;
  actor_user_id: string | null;
  actor_type: 'user' | 'service' | 'system';
  action: string;
  resource_type: string;
  resource_id: string | null;
  result: 'success' | 'denied' | 'failure';
  reason_code: string | null;
  request_id: string | null;
  trace_id: string | null;
  session_id: string | null;
  client_ip: string | null;
  metadata_json: Json;
  prev_hash: Buffer | null;
  hash: Buffer;
}

export interface RolesTable {
  id: string;
  name: string;
}

export interface UserRolesTable {
  user_id: string;
  role_id: string;
  source: 'idp_group' | 'manual';
}

/** migrations/0003_web_sessions.sql — browser sessions; tokens are stored as SHA-256 only. */
export interface WebSessionsTable {
  id: string;
  token_hash: Buffer;
  csrf_hash: Buffer;
  user_id: string;
  created_at: Timestamp;
  last_seen_at: Timestamp;
  expires_at: Date;
}

export interface Database {
  users: UsersTable;
  roles: RolesTable;
  user_roles: UserRolesTable;
  web_sessions: WebSessionsTable;
  workspace_templates: WorkspaceTemplatesTable;
  workspaces: WorkspacesTable;
  workspace_members: WorkspaceMembersTable;
  audit_events: AuditEventsTable;
}
