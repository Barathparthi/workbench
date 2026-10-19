import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  hasPermission,
  hasWorkspaceRole,
  isKnownRole,
  isLabRole,
  isPermission,
  isRoutePermission,
  isWorkspaceRole,
  PACKAGE_NAME,
  parseRoleMappings,
  permissionsFor,
  Permissions,
  RoleMatrix,
  rolesForGroups,
  WorkspaceRoles,
} from '../index.js';

describe('@qe/rbac', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@qe/rbac');
  });
});

describe('permissions', () => {
  it('lists every permission of 07_SECURITY §4.2 exactly once', () => {
    expect(new Set(Permissions).size).toBe(Permissions.length);
    expect(Permissions).toHaveLength(22);
  });

  it.each(['workspace:read', 'audit:export', 'port_forward:use'])('%s is a permission', (p) => {
    expect(isPermission(p)).toBe(true);
    expect(isRoutePermission(p)).toBe(true);
  });

  it('accepts authenticated, public and internal as route permissions only', () => {
    for (const p of ['authenticated', 'public', 'internal']) {
      expect(isPermission(p)).toBe(false);
      expect(isRoutePermission(p)).toBe(true);
    }
  });

  it.each(['', 'workspace:*', 'WORKSPACE:READ', 'admin', '__proto__', 'constructor'])('rejects %j', (p) => {
    expect(isPermission(p)).toBe(false);
    expect(isRoutePermission(p)).toBe(false);
  });
});

/** The matrix of 07_SECURITY §4.2, row by row. A change here is a security review item. */
const expected: Record<string, readonly string[]> = {
  'qe.user': [
    'qe_test:cancel',
    'qe_test:execute',
    'target:list',
    'terminal:open',
    'workspace:create',
    'workspace:delete',
    'workspace:read',
    'workspace:start',
    'workspace:stop',
    'workspace:write',
  ],
  'qe.lead': [
    'qe_test:cancel',
    'qe_test:execute',
    'target:list',
    'terminal:open',
    'workspace:admin',
    'workspace:create',
    'workspace:delete',
    'workspace:read',
    'workspace:start',
    'workspace:stop',
    'workspace:write',
  ],
  auditor: ['audit:export', 'audit:read'],
  'lab.a.user': ['remote:connect', 'remote:file_read', 'target:list'],
};

describe('role matrix', () => {
  it.each(Object.entries(expected))('%s grants exactly its row', (role, perms) => {
    expect([...permissionsFor([role])].sort()).toEqual([...perms].sort());
  });

  it('qe.admin gets everything except audit export and port forwarding', () => {
    const admin = permissionsFor(['qe.admin']);
    expect(admin.has('audit:export')).toBe(false);
    expect(admin.has('port_forward:use')).toBe(false);
    expect(admin.size).toBe(Permissions.length - 2);
  });

  it('no role grants port forwarding (policy-granted only, Phase 19)', () => {
    for (const role of Object.keys(RoleMatrix)) {
      expect(permissionsFor([role]).has('port_forward:use')).toBe(false);
    }
  });

  it('only qe.admin and lab roles can connect to remote systems', () => {
    expect(permissionsFor(['qe.user', 'qe.lead', 'auditor']).has('remote:connect')).toBe(false);
  });

  it('only file read, never file write or execute, comes with a lab role', () => {
    const lab = permissionsFor(['lab.x.user']);
    expect(lab.has('remote:file_write')).toBe(false);
    expect(lab.has('remote:execute')).toBe(false);
  });

  it('unions several roles', () => {
    const p = permissionsFor(['qe.user', 'auditor', 'lab.b.user']);
    expect(p.has('workspace:create') && p.has('audit:read') && p.has('remote:connect')).toBe(true);
  });

  it.each([[[]], [['unknown']], [['__proto__']], [['constructor']], [['toString']], [['QE.ADMIN']]])(
    'grants nothing for %j',
    (roles) => {
      expect(permissionsFor(roles).size).toBe(0);
    },
  );

  it('hasPermission requires a real permission that was granted', () => {
    const p = permissionsFor(['qe.user']);
    expect(hasPermission(p, 'workspace:read')).toBe(true);
    expect(hasPermission(p, 'audit:read')).toBe(false);
    expect(hasPermission(p, 'authenticated')).toBe(false);
    expect(hasPermission(p, 'nonsense')).toBe(false);
  });
});

describe('lab roles', () => {
  it.each(['lab.a.user', 'lab.rack-3.user', 'lab.x9.user'])('%s is a lab role', (r) => {
    expect(isLabRole(r)).toBe(true);
    expect(isKnownRole(r)).toBe(true);
  });

  it.each([
    'lab..user',
    'lab.A.user',
    'lab.-a.user',
    'lab.a-.user',
    'lab.a.admin',
    'lab.a.user.x',
    'xlab.a.user',
    `lab.${'a'.repeat(65)}.user`,
  ])('%s is not', (r) => {
    expect(isLabRole(r)).toBe(false);
    expect(isKnownRole(r)).toBe(false);
  });
});

describe('role mappings', () => {
  const mappings = parseRoleMappings(
    JSON.stringify({
      'qe-workspace-users': ['qe.user'],
      'qe-workspace-admins': ['qe.admin', 'qe.user'],
      'qe-lab-a': ['lab.a.user'],
    }),
  );

  it('maps groups to sorted, unique roles', () => {
    expect(rolesForGroups(['qe-lab-a', 'qe-workspace-users', 'qe-workspace-admins'], mappings)).toEqual([
      'lab.a.user',
      'qe.admin',
      'qe.user',
    ]);
  });

  it('ignores unmapped groups and compares names exactly', () => {
    expect(rolesForGroups(['QE-WORKSPACE-USERS', 'other', '__proto__', 'constructor'], mappings)).toEqual([]);
  });

  it.each([
    ['not json', 'nope'],
    ['an array', '[]'],
    ['an unknown role', '{"g":["root"]}'],
    ['an empty role list', '{"g":[]}'],
    ['a non-string role', '{"g":[1]}'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseRoleMappings(text)).toThrow(ZodError);
  });
});

describe('workspace roles', () => {
  it('ranks owner over editor over viewer', () => {
    expect(hasWorkspaceRole('owner', 'editor')).toBe(true);
    expect(hasWorkspaceRole('editor', 'editor')).toBe(true);
    expect(hasWorkspaceRole('viewer', 'editor')).toBe(false);
    expect(hasWorkspaceRole('editor', 'owner')).toBe(false);
    expect(hasWorkspaceRole('viewer', 'viewer')).toBe(true);
  });

  it.each(['', 'admin', 'OWNER', '__proto__', 'toString'])('never qualifies %j', (role) => {
    expect(isWorkspaceRole(role)).toBe(false);
    for (const required of WorkspaceRoles) expect(hasWorkspaceRole(role, required)).toBe(false);
  });
});
