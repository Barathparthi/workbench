/**
 * @qe/contracts — Zod schemas for REST DTOs, the qews.v1 WebSocket protocol and OpenAPI generation
 * (01_ARCHITECTURE/05_API_CONTRACTS.md).
 */
export const PACKAGE_NAME = '@qe/contracts';

// The API error vocabulary (problem+json `code`) is the domain's ErrorCode set.
export { ErrorCodes, ErrorHttpStatus, type ErrorCode } from '@qe/domain';
export { PROBLEM_TYPE_BASE, ProblemDetails } from './problem.js';
export { CallbackQuery, LoginQuery, Me } from './auth.js';
export {
  CreateWorkspaceRequest,
  GitSource,
  ListWorkspacesQuery,
  ResourceProfile,
  ResourceProfiles,
  TemplateId,
  UpdateWorkspaceRequest,
  Workspace,
  WorkspaceId,
  WorkspaceIdParams,
  WorkspaceList,
  WorkspaceName,
  WorkspaceStateEvent,
  WorkspaceTemplate,
  WorkspaceTemplateList,
} from './workspaces.js';
export {
  AuditActions,
  AuditActorTypes,
  AuditMetadata,
  AuditResults,
  type AuditAction,
  type AuditActorType,
  type AuditResult,
} from './audit.js';
