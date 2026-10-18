import { describe, expect, it } from 'vitest';

import {
  AuditMetadata,
  CreateWorkspaceRequest,
  ProblemDetails,
  UpdateWorkspaceRequest,
  Workspace,
} from '../index.js';

const valid = { name: 'login-automation', templateId: 'tpl_python_pytest' };

describe('CreateWorkspaceRequest', () => {
  it('accepts the documented request', () => {
    expect(
      CreateWorkspaceRequest.parse({
        ...valid,
        git: { url: 'https://git.corp/qe/login-automation.git', ref: 'main' },
        resources: { profile: 'standard' },
      }),
    ).toMatchObject(valid);
  });

  it.each([
    [{ ...valid, name: 'Login Automation' }, 'name'],
    [{ ...valid, name: 'ab' }, 'name'],
    [{ ...valid, name: '-lead' }, 'name'],
    [{ ...valid, templateId: '../etc' }, 'templateId'],
    [{ ...valid, git: { url: 'http://git.corp/x.git', ref: 'main' } }, 'git'],
    [{ ...valid, git: { url: 'git@git.corp:x.git', ref: 'main' } }, 'git'],
    [{ ...valid, git: { url: 'https://user:token@git.corp/x.git', ref: 'main' } }, 'git'],
    [{ ...valid, git: { url: 'https://git.corp/x.git', ref: 'main; rm -rf /' } }, 'git'],
    [{ ...valid, resources: { profile: 'huge' } }, 'resources'],
    [{ ...valid, ownerId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f' }, ''],
  ])('rejects %j', (body, field) => {
    const result = CreateWorkspaceRequest.safeParse(body);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0] ?? '').toBe(field);
  });
});

describe('UpdateWorkspaceRequest', () => {
  it('needs at least one field and allows clearing git', () => {
    expect(UpdateWorkspaceRequest.safeParse({}).success).toBe(false);
    expect(UpdateWorkspaceRequest.parse({ git: null })).toEqual({ git: null });
    expect(UpdateWorkspaceRequest.safeParse({ state: 'RUNNING' }).success).toBe(false);
  });
});

describe('Workspace and ProblemDetails', () => {
  it('describe the documented response shapes', () => {
    expect(
      Workspace.safeParse({
        id: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f',
        name: 'login-automation',
        state: 'CREATED',
        templateId: 'tpl_python_pytest',
        ownerId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d70',
        ideUrl: '/w/0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f/',
        resources: { profile: 'standard' },
        git: null,
        lastActiveAt: null,
        createdAt: '2026-10-18T10:00:00.000Z',
        updatedAt: '2026-10-18T10:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      ProblemDetails.safeParse({ type: 'x', title: 't', status: 418, code: 'TEAPOT', requestId: 'r' })
        .success,
    ).toBe(false);
  });
});

describe('AuditMetadata', () => {
  it('only allows the listed keys per action', () => {
    expect(AuditMetadata.WORKSPACE_CREATE.safeParse({ name: 'a', templateId: 't' }).success).toBe(true);
    expect(AuditMetadata.WORKSPACE_CREATE.safeParse({ name: 'a', templateId: 't', token: 'x' }).success).toBe(
      false,
    );
    expect(AuditMetadata.WORKSPACE_DELETE.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
  });
});
