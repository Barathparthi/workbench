import { z } from 'zod';

import { isKnownRole } from './matrix.js';

/**
 * IdP group → platform roles, from configuration (`ROLE_MAPPINGS`, 00_START_HERE/03 B2). Only roles the
 * matrix knows are accepted, so a typo in configuration fails at startup instead of silently granting
 * nothing — and an IdP can never mint a role name of its choosing.
 */
export const RoleMappings = z
  .record(
    z.string().min(1).max(256),
    z
      .array(z.string().refine(isKnownRole, { message: 'unknown role' }))
      .min(1)
      .max(20),
  )
  .refine((m) => Object.keys(m).length <= 500, 'too many group mappings');

export type RoleMappings = z.infer<typeof RoleMappings>;

/** Parses the JSON text of `ROLE_MAPPINGS`; throws a ZodError (or SyntaxError wrapped as an issue). */
export function parseRoleMappings(text: string): RoleMappings {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new z.ZodError([{ code: 'custom', path: [], message: 'must be a JSON object', input: text }]);
  }
  return RoleMappings.parse(raw);
}

/**
 * The roles a user gets from their groups, sorted and without duplicates. Groups without a mapping grant
 * nothing; group names are compared exactly (IdPs differ on case, so configuration must match the claim).
 */
export function rolesForGroups(groups: readonly string[], mappings: RoleMappings): string[] {
  const roles = new Set<string>();
  for (const group of groups) {
    for (const role of Object.hasOwn(mappings, group) ? (mappings[group] ?? []) : []) roles.add(role);
  }
  return [...roles].sort();
}
