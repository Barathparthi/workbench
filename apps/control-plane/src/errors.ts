import { DomainError, ErrorHttpStatus, type ErrorCode } from '@qe/domain';
import { PROBLEM_TYPE_BASE, type ProblemDetails } from '@qe/contracts';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';

const TITLES: Partial<Record<ErrorCode, string>> = {
  AUTH_REQUIRED: 'Authentication required',
  FORBIDDEN: 'You do not have permission for this action',
  NOT_FOUND: 'Not found',
  INVALID_REQUEST: 'The request is not valid',
  CONFLICT: 'The request conflicts with the current state',
  RATE_LIMITED: 'Too many requests',
  INTERNAL_ERROR: 'Internal error',
};

export function problem(
  code: ErrorCode,
  requestId: string,
  status = ErrorHttpStatus[code],
  details?: Record<string, unknown>,
): ProblemDetails {
  return {
    type: `${PROBLEM_TYPE_BASE}${code}`,
    title: TITLES[code] ?? code,
    status,
    code,
    requestId,
    ...(details !== undefined && { details }),
  };
}

function send(reply: FastifyReply, body: ProblemDetails): FastifyReply {
  return reply.code(body.status).type('application/problem+json; charset=utf-8').send(body);
}

/** Every error leaves as problem+json; unexpected errors are logged in full and answered without detail. */
export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof DomainError) {
    if (error.httpStatus >= 500) request.log.error({ err: error }, 'domain error');
    return send(reply, problem(error.code, request.id, error.httpStatus, error.details));
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    const issues = error.validation.map((v) => ({
      path: v.instancePath || '/',
      message: v.message ?? 'invalid',
    }));
    return send(
      reply,
      problem('INVALID_REQUEST', request.id, 400, { location: error.validationContext, issues }),
    );
  }
  if (isResponseSerializationError(error)) {
    request.log.error({ err: error }, 'response did not match its schema');
    return send(reply, problem('INTERNAL_ERROR', request.id));
  }
  const status = error.statusCode ?? 500;
  if (status === 429) return send(reply, problem('RATE_LIMITED', request.id, 429));
  if (status >= 400 && status < 500) {
    // Fastify's own client errors: malformed JSON, body too large, unsupported media type, …
    return send(reply, problem('INVALID_REQUEST', request.id, status, { reason: error.code }));
  }
  request.log.error({ err: error }, 'unhandled error');
  return send(reply, problem('INTERNAL_ERROR', request.id));
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return send(reply, problem('NOT_FOUND', request.id));
}
