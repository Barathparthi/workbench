import { z } from 'zod';

import { ErrorCodes } from '@qe/domain';

/** RFC 9457 problem details as returned by every API error (05_API_CONTRACTS §3). */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.enum(ErrorCodes),
  requestId: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

export const PROBLEM_TYPE_BASE = 'https://qe-workspace.corp/errors/';
