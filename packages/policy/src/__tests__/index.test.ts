import { describe, expect, it } from 'vitest';

import {
  canSeeTarget,
  checkAddresses,
  checkPersonalHost,
  checkTargetHost,
  evaluateConnection,
  isValidCidr,
  PACKAGE_NAME,
  parseCidr,
  type PolicyView,
} from '../index.js';

const LAB = ['10.20.0.0/16', 'fd00:1ab::/48'];
const CLUSTER = ['10.20.99.0/24'];

describe('@qe/policy', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@qe/policy');
  });
});

describe('checkAddresses (SSRF guard)', () => {
  it('allows addresses inside an allowed CIDR and returns the first one to connect to', () => {
    expect(checkAddresses(['10.20.1.5', '10.20.1.6'], LAB)).toEqual({ allowed: true, address: '10.20.1.5' });
    expect(checkAddresses(['fd00:1ab::5'], LAB)).toEqual({ allowed: true, address: 'fd00:1ab::5' });
  });

  it.each([
    ['127.0.0.1', 'DENIED_RANGE'],
    ['::1', 'DENIED_RANGE'],
    ['0.0.0.0', 'DENIED_RANGE'],
    ['169.254.169.254', 'DENIED_RANGE'], // cloud metadata
    ['fe80::1', 'DENIED_RANGE'],
    ['224.0.0.1', 'DENIED_RANGE'],
    ['255.255.255.255', 'DENIED_RANGE'],
    ['240.0.0.1', 'DENIED_RANGE'],
    ['::ffff:127.0.0.1', 'DENIED_RANGE'], // mapped loopback is loopback
    ['::ffff:169.254.169.254', 'DENIED_RANGE'],
    ['64:ff9b::a14:105', 'DENIED_RANGE'], // NAT64 embedding 10.20.1.5
    ['2002:a14:105::1', 'DENIED_RANGE'], // 6to4
    ['2001:0:a14:105::1', 'DENIED_RANGE'], // Teredo
    ['10.20.99.7', 'DENIED_CIDR'], // configured cluster network inside the lab range
    ['10.21.0.1', 'NOT_IN_ALLOWED_CIDR'],
    ['8.8.8.8', 'NOT_IN_ALLOWED_CIDR'],
    ['2130706433', 'INVALID_ADDRESS'], // decimal loopback
    ['0177.0.0.1', 'INVALID_ADDRESS'], // octal loopback
    ['0x7f.1', 'INVALID_ADDRESS'],
    ['127.1', 'INVALID_ADDRESS'],
    ['fe80::1%eth0', 'INVALID_ADDRESS'], // zone id
    ['not-an-ip', 'INVALID_ADDRESS'],
  ])('refuses %s (%s)', (address, reason) => {
    expect(checkAddresses([address], LAB, CLUSTER)).toMatchObject({ allowed: false, reason });
  });

  it('treats a mapped IPv6 form of an allowed IPv4 address as that address', () => {
    expect(checkAddresses(['::ffff:10.20.1.5'], LAB)).toEqual({ allowed: true, address: '10.20.1.5' });
  });

  it('refuses when ANY resolved address is forbidden (mixed DNS answers)', () => {
    expect(checkAddresses(['10.20.1.5', '127.0.0.1'], LAB)).toMatchObject({
      allowed: false,
      reason: 'DENIED_RANGE',
    });
    expect(checkAddresses(['10.20.1.5', '192.168.1.1'], LAB)).toMatchObject({ allowed: false });
  });

  it('refuses an empty answer and an empty allowlist', () => {
    expect(checkAddresses([], LAB)).toEqual({ allowed: false, reason: 'NO_ADDRESSES' });
    expect(checkAddresses(['10.20.1.5'], [])).toMatchObject({
      allowed: false,
      reason: 'NOT_IN_ALLOWED_CIDR',
    });
  });

  it('never lets an allowed CIDR re-open a denied range', () => {
    expect(checkAddresses(['127.0.0.1'], ['0.0.0.0/0'])).toMatchObject({
      allowed: false,
      reason: 'DENIED_RANGE',
    });
    expect(checkAddresses(['169.254.169.254'], ['169.254.0.0/16'])).toMatchObject({ allowed: false });
  });
});

describe('CIDR parsing', () => {
  it('accepts valid CIDRs, including IPv4-mapped IPv6 ones as IPv4', () => {
    expect(isValidCidr('10.0.0.0/8')).toBe(true);
    expect(isValidCidr('fd00::/8')).toBe(true);
    expect(parseCidr('::ffff:10.0.0.0/104')[1]).toBe(8);
    expect(checkAddresses(['10.1.2.3'], ['::ffff:10.0.0.0/104'])).toMatchObject({ allowed: true });
  });

  it.each(['10.0.0.0', '10.0.0.0/33', 'x/8', ''])('rejects %j', (c) => {
    expect(isValidCidr(c)).toBe(false);
  });
});

describe('checkTargetHost', () => {
  const resolver = (answers: Record<string, string[]>) => (host: string) => {
    const a = answers[host];
    return a === undefined ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(a);
  };

  it('checks IP literals without resolving', async () => {
    const never = () => Promise.reject(new Error('must not resolve'));
    expect(await checkTargetHost('10.20.1.5', LAB, [], never)).toEqual({
      allowed: true,
      address: '10.20.1.5',
    });
  });

  it('resolves names and pins the checked address', async () => {
    const r = resolver({ 'qe-linux-01.lab.corp': ['10.20.3.4'] });
    expect(await checkTargetHost('qe-linux-01.lab.corp', LAB, [], r)).toEqual({
      allowed: true,
      address: '10.20.3.4',
    });
  });

  it('refuses names that resolve to forbidden places or not at all', async () => {
    const r = resolver({
      'metadata.google.internal': ['169.254.169.254'],
      'evil.example': ['10.20.1.1', '127.0.0.1'],
    });
    expect(await checkTargetHost('metadata.google.internal', LAB, [], r)).toMatchObject({ allowed: false });
    expect(await checkTargetHost('evil.example', LAB, [], r)).toMatchObject({ allowed: false });
    expect(await checkTargetHost('missing.example', LAB, [], r)).toEqual({
      allowed: false,
      reason: 'NO_ADDRESSES',
    });
  });
});

describe('checkPersonalHost (org deny list for personal targets)', () => {
  const PROD = ['10.50.0.0/16'];
  const resolver = (answers: Record<string, string[]>) => (host: string) => {
    const a = answers[host];
    return a === undefined ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(a);
  };

  it('allows the user’s own network, loopback included, and pins the checked address', async () => {
    const never = () => Promise.reject(new Error('must not resolve'));
    expect(await checkPersonalHost('127.0.0.1', PROD, never)).toEqual({
      allowed: true,
      address: '127.0.0.1',
    });
    expect(await checkPersonalHost('dev-box', PROD, resolver({ 'dev-box': ['192.168.1.20'] }))).toEqual({
      allowed: true,
      address: '192.168.1.20',
    });
  });

  it('refuses a denied CIDR, also when only one of several answers is in it, and IPv4-mapped forms', async () => {
    const r = resolver({ mixed: ['192.168.1.20', '10.50.3.4'], mapped: ['::ffff:10.50.0.9'] });
    expect(await checkPersonalHost('10.50.1.1', PROD, r)).toMatchObject({
      allowed: false,
      reason: 'DENIED_CIDR',
    });
    expect(await checkPersonalHost('mixed', PROD, r)).toMatchObject({
      allowed: false,
      reason: 'DENIED_CIDR',
    });
    expect(await checkPersonalHost('mapped', PROD, r)).toMatchObject({
      allowed: false,
      reason: 'DENIED_CIDR',
    });
  });

  it('refuses names that do not resolve, empty answers and non-canonical addresses', async () => {
    const r = resolver({ empty: [], odd: ['0x7f.1'] });
    expect(await checkPersonalHost('missing', PROD, r)).toEqual({ allowed: false, reason: 'NO_ADDRESSES' });
    expect(await checkPersonalHost('empty', PROD, r)).toEqual({ allowed: false, reason: 'NO_ADDRESSES' });
    expect(await checkPersonalHost('odd', PROD, r)).toEqual({ allowed: false, reason: 'INVALID_ADDRESS' });
  });
});

describe('evaluateConnection', () => {
  const policy: PolicyView = {
    allowedRoles: ['lab.a.user'],
    capabilities: ['terminal', 'file_read'],
    maxSessionsPerUser: 2,
    idleTimeoutSec: 1800,
    maxSessionSec: 28800,
    version: 3,
  };
  const labUser = { roles: ['lab.a.user'], permissions: new Set(['remote:connect', 'remote:file_read']) };
  const active = { status: 'active' };

  it('allows a lab user a terminal and returns the policy limits', () => {
    expect(evaluateConnection(labUser, active, policy, 'terminal', 0)).toEqual({
      allowed: true,
      policyVersion: 3,
      idleTimeoutSec: 1800,
      maxSessionSec: 28800,
    });
  });

  it('allows a lab user exec (test runs) where the policy lists the exec capability', () => {
    const withExec = { ...policy, capabilities: [...policy.capabilities, 'exec'] };
    expect(evaluateConnection(labUser, active, withExec, 'exec', 0)).toMatchObject({
      allowed: true,
      policyVersion: 3,
    });
    // The capability is the grant: the same user, the same target, a policy without it — refused.
    expect(evaluateConnection(labUser, active, policy, 'exec', 0)).toMatchObject({ allowed: false });
  });

  it.each([
    [
      'an inactive target',
      labUser,
      { status: 'pending_host_key' },
      'terminal',
      0,
      'TARGET_NOT_ALLOWED',
      'target_inactive',
    ],
    [
      'a disabled target',
      labUser,
      { status: 'disabled' },
      'terminal',
      0,
      'TARGET_NOT_ALLOWED',
      'target_inactive',
    ],
    [
      'no remote:connect',
      { roles: ['lab.a.user'], permissions: new Set<string>() },
      active,
      'terminal',
      0,
      'FORBIDDEN',
      'missing_permission',
    ],
    [
      'another lab’s role',
      { roles: ['lab.b.user'], permissions: labUser.permissions },
      active,
      'terminal',
      0,
      'TARGET_NOT_ALLOWED',
      'role_not_allowed',
    ],
    [
      'exec without remote:connect',
      { roles: ['lab.a.user'], permissions: new Set(['target:list']) },
      { status: 'active' },
      'exec',
      0,
      'FORBIDDEN',
      'missing_permission',
    ],
    ['exec not in the policy', labUser, active, 'exec', 0, 'TARGET_NOT_ALLOWED', 'capability_not_allowed'],
    ['the session limit', labUser, active, 'files', 2, 'QUOTA_EXCEEDED', 'session_limit'],
  ] as const)('refuses %s', (_label, caller, target, kind, count, code, reason) => {
    expect(evaluateConnection(caller, target, policy, kind, count)).toEqual({ allowed: false, code, reason });
  });

  it('filters target lists by role', () => {
    expect(canSeeTarget({ roles: ['lab.a.user'] }, policy)).toBe(true);
    expect(canSeeTarget({ roles: ['qe.user'] }, policy)).toBe(false);
  });
});
