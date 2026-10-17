/**
 * @qe/contracts — Zod schemas for REST DTOs, the qews.v1 WebSocket protocol and OpenAPI generation
 * (01_ARCHITECTURE/05_API_CONTRACTS.md). Schemas arrive with the control plane in Phase 03.
 */
export const PACKAGE_NAME = '@qe/contracts';

// The API error vocabulary (problem+json `code`) is the domain's ErrorCode set.
export { ErrorCodes, ErrorHttpStatus, type ErrorCode } from '@qe/domain';
