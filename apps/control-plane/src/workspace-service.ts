import type {
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
  Workspace,
  WorkspaceTemplate,
} from '@qe/contracts';
import { DomainError, type WorkspaceState } from '@qe/domain';
import { hasWorkspaceRole } from '@qe/rbac';
import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import type { Principal } from './auth.js';
import { writeAuditEvent } from './audit/audit-writer.js';
import type { Database } from './db/schema.js';
import { MembersRepo } from './repos/members.js';
import { TemplatesRepo } from './repos/templates.js';
import { isUniqueViolation, WorkspacesRepo, type WorkspaceRow } from './repos/workspaces.js';

export interface RequestContext {
  readonly principal: Principal;
  readonly requestId: string;
}

/** Workspace use cases over the repositories; the routes call only this. */
export interface WorkspaceService {
  list(ctx: RequestContext, limit: number): Promise<Workspace[]>;
  get(ctx: RequestContext, id: string): Promise<Workspace>;
  create(ctx: RequestContext, input: CreateWorkspaceRequest): Promise<Workspace>;
  update(ctx: RequestContext, id: string, input: UpdateWorkspaceRequest): Promise<Workspace>;
  remove(ctx: RequestContext, id: string): Promise<void>;
  templates(): Promise<WorkspaceTemplate[]>;
}

const DELETABLE: readonly WorkspaceState[] = ['CREATED', 'STOPPED', 'FAILED'];

export function toWorkspaceDto(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    templateId: row.template_id,
    ownerId: row.owner_id,
    ideUrl: `/w/${row.id}/`,
    resources: { profile: row.resource_profile as Workspace['resources']['profile'] },
    git: row.git_url === null ? null : { url: row.git_url, ref: row.git_ref ?? 'main' },
    lastActiveAt: row.last_active_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const nameTaken = () =>
  new DomainError('CONFLICT', 'a workspace with this name already exists', { details: { field: 'name' } });

export function createWorkspaceService(
  db: Kysely<Database>,
  runtimeKind: WorkspaceRow['runtime_kind'],
  /** Removes the runtime and volume of a DELETING workspace, then marks it DELETED (Phase 05). */
  finishDelete?: (id: string) => Promise<void>,
): WorkspaceService {
  const visible = async (id: string, userId: string) => {
    const row = await new WorkspacesRepo(db).findVisible(id, userId);
    if (row === undefined) throw new DomainError('NOT_FOUND');
    return row;
  };

  return {
    async list(ctx, limit) {
      return (await new WorkspacesRepo(db).listForUser(ctx.principal.userId, limit)).map(toWorkspaceDto);
    },

    async get(ctx, id) {
      return toWorkspaceDto(await visible(id, ctx.principal.userId));
    },

    async create(ctx, input) {
      const template = await new TemplatesRepo(db).findEnabled(input.templateId);
      if (template === undefined) {
        throw new DomainError('INVALID_REQUEST', 'unknown template', { details: { field: 'templateId' } });
      }
      try {
        return await db.transaction().execute(async (tx) => {
          const row = await new WorkspacesRepo(tx).insert({
            id: uuidv7(),
            name: input.name,
            ownerId: ctx.principal.userId,
            templateId: template.id,
            runtimeKind,
            resourceProfile: input.resources?.profile ?? template.default_profile,
            gitUrl: input.git?.url ?? null,
            gitRef: input.git?.ref ?? null,
          });
          await new MembersRepo(tx).add(row.id, ctx.principal.userId, 'owner');
          await writeAuditEvent(tx, {
            action: 'WORKSPACE_CREATE',
            actorType: 'user',
            actorUserId: ctx.principal.userId,
            resourceType: 'workspace',
            resourceId: row.id,
            result: 'success',
            requestId: ctx.requestId,
            metadata: { name: row.name, templateId: row.template_id },
          });
          return toWorkspaceDto(row);
        });
      } catch (error) {
        throw isUniqueViolation(error) ? nameTaken() : error;
      }
    },

    async update(ctx, id, input) {
      const current = await visible(id, ctx.principal.userId);
      if (!hasWorkspaceRole(current.member_role, 'editor')) throw new DomainError('FORBIDDEN');
      try {
        const row = await new WorkspacesRepo(db).update(id, {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.git !== undefined && { gitUrl: input.git?.url ?? null, gitRef: input.git?.ref ?? null }),
        });
        if (row === undefined) throw new DomainError('NOT_FOUND');
        return toWorkspaceDto(row);
      } catch (error) {
        throw isUniqueViolation(error) ? nameTaken() : error;
      }
    },

    async remove(ctx, id) {
      const current = await visible(id, ctx.principal.userId);
      if (!hasWorkspaceRole(current.member_role, 'owner')) throw new DomainError('FORBIDDEN');
      if (!DELETABLE.includes(current.state)) {
        throw new DomainError('CONFLICT', `a ${current.state} workspace cannot be deleted; stop it first`);
      }
      await db.transaction().execute(async (tx) => {
        const repo = new WorkspacesRepo(tx);
        const deleting = await repo.transition(id, current.state, 'DELETING', 'deleted by owner');
        if (deleting === null) throw new DomainError('CONFLICT', 'the workspace changed state; retry');
        // Without a runtime provider there is nothing to remove, so DELETING completes at once.
        if (finishDelete === undefined) await repo.transition(id, 'DELETING', 'DELETED');
        await writeAuditEvent(tx, {
          action: 'WORKSPACE_DELETE',
          actorType: 'user',
          actorUserId: ctx.principal.userId,
          resourceType: 'workspace',
          resourceId: id,
          result: 'success',
          requestId: ctx.requestId,
          metadata: { name: current.name },
        });
      });
      // Outside the transaction: the runtime call may be slow. If it fails, the reconciler retries DELETING.
      if (finishDelete !== undefined) await finishDelete(id).catch(() => undefined);
    },

    async templates() {
      return (await new TemplatesRepo(db).listEnabled()).map((t) => ({
        id: t.id,
        displayName: t.display_name,
        defaultProfile: t.default_profile as WorkspaceTemplate['defaultProfile'],
      }));
    },
  };
}
