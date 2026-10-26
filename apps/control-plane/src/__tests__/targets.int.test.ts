/** Targets, policies, host keys and session tickets on PostgreSQL (Phase 07 §7.1–7.5). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../audit/audit-writer.js';
import { makePrincipal, type Principal } from '../auth.js';
import { createRemoteSessionService, type RemoteSessionService } from '../remote-session-service.js';
import { UsersRepo } from '../repos/users.js';
import { createTargetService, type TargetService } from '../target-service.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

const ORIGIN = 'https://qe.example';
const FP = `SHA256:${'A'.repeat(43)}`;
const DNS: Record<string, string[]> = {
  'qe-linux-01.lab.corp': ['10.20.1.5'],
  'sneaky.lab.corp': ['10.20.1.6', '169.254.169.254'],
};

let t: TestDatabase;
let targets: TargetService;
let sessions: RemoteSessionService;
let admin: Principal;
let bob: Principal; // lab A user
let carol: Principal; // plain QE user, no lab role
let clock = new Date('2026-10-19T10:00:00Z');
const ctx = (p: Principal) => ({ principal: p, requestId: 'req-targets-1' });

const user = async (name: string, roles: string[]) =>
  makePrincipal({
    userId: await new UsersRepo(t.db).upsertIdentity({
      issuer: 'test',
      subject: name,
      username: name,
      displayName: name,
    }),
    username: name,
    roles,
  });
const actions = async () =>
  (await t.db.selectFrom('audit_events').select(['action', 'reason_code']).orderBy('seq').execute()).map(
    (r) => `${r.action}${r.reason_code === null ? '' : `:${r.reason_code}`}`,
  );

let policyId = '';
const brokerCloses: string[] = [];
let targetId = '';

beforeAll(async () => {
  t = await startTestDatabase();
  [admin, bob, carol] = await Promise.all([
    user('admin', ['qe.admin', 'qe.user']),
    user('bob', ['qe.user', 'lab.a.user']),
    user('carol', ['qe.user']),
  ]);
  targets = createTargetService(t.db, {
    deniedCidrs: ['10.20.99.0/24'],
    resolver: (host) =>
      DNS[host] === undefined ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(DNS[host]),
  });
  sessions = createRemoteSessionService(t.db, {
    ticketTtlMs: 60_000,
    allowedOrigins: [ORIGIN],
    now: () => clock,
    closeOnBroker: (sessionId) => {
      brokerCloses.push(sessionId);
      return Promise.resolve();
    },
  });
});
afterAll(async () => {
  await t.stop();
});

describe('policies and targets', () => {
  it('creates a policy and refuses unknown roles and bad CIDRs', async () => {
    const p = await targets.createPolicy(ctx(admin), {
      name: 'lab-a',
      allowedRoles: ['lab.a.user'],
      allowedCidrs: ['10.20.0.0/16'],
      allowedPorts: [22],
      capabilities: ['terminal', 'file_read'],
      idleTimeoutSec: 1800,
      maxSessionSec: 3600,
      maxSessionsPerUser: 2,
    });
    policyId = p.id;
    const base = {
      allowedPorts: [22],
      capabilities: ['terminal' as const],
      idleTimeoutSec: 1800,
      maxSessionSec: 3600,
      maxSessionsPerUser: 2,
    };
    await expect(
      targets.createPolicy(ctx(admin), {
        ...base,
        name: 'x1',
        allowedRoles: ['root'],
        allowedCidrs: ['10.0.0.0/8'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      targets.createPolicy(ctx(admin), {
        ...base,
        name: 'x2',
        allowedRoles: ['lab.a.user'],
        allowedCidrs: ['10.0.0.0'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('registers a target pending its host key', async () => {
    const target = await targets.registerTarget(ctx(admin), {
      name: 'qe-linux-01',
      host: 'qe-linux-01.lab.corp',
      port: 22,
      os: 'linux',
      principalTemplate: '{{user.username}}',
      remoteRoot: '/home/bob/projects',
      policyId,
      tags: ['lab-a'],
    });
    targetId = target.id;
    expect(target).toMatchObject({ status: 'pending_host_key', hostKeys: [] });
  });

  it.each([
    ['127.0.0.1', 'DENIED_RANGE'],
    ['169.254.169.254', 'DENIED_RANGE'],
    ['10.20.99.4', 'DENIED_CIDR'],
    ['192.168.1.10', 'NOT_IN_ALLOWED_CIDR'],
    ['sneaky.lab.corp', 'DENIED_RANGE'],
    ['nowhere.lab.corp', 'NO_ADDRESSES'],
  ])('refuses to register %s (%s) and audits it', async (host, reason) => {
    await expect(
      targets.registerTarget(ctx(admin), {
        name: `bad-${String(Math.random()).slice(2, 8)}`,
        host,
        port: 22,
        os: 'linux',
        principalTemplate: 'qeauto',
        remoteRoot: '/srv',
        policyId,
        tags: [],
      }),
    ).rejects.toMatchObject({ code: 'TARGET_ADDRESS_FORBIDDEN' });
    expect(await actions()).toContain(`SSRF_BLOCKED:${reason}`);
  });

  it('refuses a port the policy does not allow', async () => {
    await expect(
      targets.registerTarget(ctx(admin), {
        name: 'qe-linux-02',
        host: '10.20.1.7',
        port: 2222,
        os: 'linux',
        principalTemplate: 'qeauto',
        remoteRoot: '/srv',
        policyId,
        tags: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('activates only with a trusted host key and a credential', async () => {
    await expect(targets.updateTarget(ctx(admin), targetId, { status: 'active' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await targets.addHostKey(ctx(admin), targetId, { algorithm: 'ssh-ed25519', fingerprintSha256: FP });
    await expect(targets.updateTarget(ctx(admin), targetId, { status: 'active' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const cred = await targets.createCredentialRef(ctx(admin), {
      provider: 'vault',
      method: 'ssh_certificate',
      providerPath: 'ssh-client-signer/sign/qe-lab-a',
      metadata: { ttl: '10m' },
    });
    const active = await targets.updateTarget(ctx(admin), targetId, {
      credentialRefId: cred.id,
      status: 'active',
    });
    expect(active.status).toBe('active');
    await expect(
      targets.addHostKey(ctx(admin), targetId, { algorithm: 'ssh-ed25519', fingerprintSha256: FP }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('lists targets by role: lab users see it, others do not (and get 404 by id)', async () => {
    expect((await targets.listTargets(ctx(bob))).map((x) => x.id)).toContain(targetId);
    expect((await targets.listTargets(ctx(carol))).map((x) => x.id)).not.toContain(targetId);
    await expect(targets.getTarget(ctx(carol), targetId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('sessions and tickets', () => {
  const open = (
    p: Principal,
    kind: 'terminal' | 'files' | 'exec' = 'terminal',
    // `null` means "no Origin header": an explicit `undefined` would fall back to the default parameter.
    origin: string | null = ORIGIN,
  ) => sessions.open(ctx(p), targetId, { kind }, origin ?? undefined);

  it('authorizes a lab user, mints a ticket and redeems it exactly once', async () => {
    const s = await open(bob);
    expect(s).toMatchObject({
      state: 'AUTHORIZED',
      streamUrl: `/api/v1/sessions/${s.sessionId}/stream`,
      idleTimeoutSec: 1800,
    });
    const snapshot = await sessions.redeem(s.ticket, ORIGIN);
    expect(snapshot).toMatchObject({
      sessionId: s.sessionId,
      kind: 'terminal',
      user: { username: 'bob' },
      target: { host: 'qe-linux-01.lab.corp', principal: 'bob', remoteRoot: '/home/bob/projects' },
      policy: { allowedCidrs: ['10.20.0.0/16'] },
      hostKeys: [{ algorithm: 'ssh-ed25519', fingerprintSha256: FP }],
      credential: { method: 'ssh_certificate', providerPath: 'ssh-client-signer/sign/qe-lab-a' },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/password|privateKey|secret/i);
    await expect(sessions.redeem(s.ticket, ORIGIN)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('hands the terminal size the IDE asked for to the broker (none when not given)', async () => {
    const sized = await sessions.open(
      ctx(bob),
      targetId,
      { kind: 'terminal', terminal: { cols: 100, rows: 30 } },
      ORIGIN,
    );
    expect((await sessions.redeem(sized.ticket, ORIGIN)).terminal).toEqual({ cols: 100, rows: 30 });
    const unsized = await open(bob);
    expect((await sessions.redeem(unsized.ticket, ORIGIN)).terminal).toBeNull();
  });

  it('burns a ticket presented with the wrong Origin', async () => {
    const s = await open(bob);
    await expect(sessions.redeem(s.ticket, 'https://evil.example')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await expect(sessions.redeem(s.ticket, ORIGIN)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('refuses expired tickets', async () => {
    // Past maxSessionSec (1 h): the two sessions above still count against bob's limit of 2 (one CONNECTING,
    // one with a burned but unexpired ticket).
    clock = new Date(clock.getTime() + 2 * 60 * 60_000);
    const s = await open(bob);
    clock = new Date(clock.getTime() + 61_000);
    await expect(sessions.redeem(s.ticket, ORIGIN)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('refuses a session whose policy changed after authorization', async () => {
    const s = await open(bob);
    await targets.updatePolicy(ctx(admin), policyId, { idleTimeoutSec: 900 });
    await expect(sessions.redeem(s.ticket, ORIGIN)).rejects.toMatchObject({ code: 'TARGET_NOT_ALLOWED' });
  });

  it('denies and audits: no lab role (404), a capability the policy lacks, a foreign Origin', async () => {
    await expect(open(carol)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(open(bob, 'exec')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(open(bob, 'terminal', 'https://evil.example')).rejects.toMatchObject({
      code: 'CSRF_REJECTED',
    });
    await expect(open(bob, 'terminal', null)).rejects.toMatchObject({ code: 'CSRF_REJECTED' });
    expect(await actions()).toContain('REMOTE_CONNECT_DENIED:missing_permission');
  });

  it('enforces the per-user session limit, and closing a session frees a slot', async () => {
    // Past maxSessionSec (1 h): earlier sessions (CONNECTING ones too) no longer count.
    clock = new Date(clock.getTime() + 2 * 60 * 60_000);
    const a = await open(bob);
    await open(bob);
    await expect(open(bob)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect((await sessions.close(ctx(bob), a.sessionId)).state).toBe('EXPIRED');
    await open(bob);
  });

  it('hides other users’ sessions unless the caller is a session admin', async () => {
    clock = new Date(clock.getTime() + 2 * 60_000); // the previous test's unused tickets have lapsed
    const s = await open(bob);
    await expect(sessions.close(ctx(carol), s.sessionId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await sessions.close(ctx(admin), s.sessionId)).closeReason).toBe('revoked_by_admin');
  });

  it('records broker reports: ACTIVE, admin revocation reaching the broker, CLOSED with byte counts', async () => {
    clock = new Date(clock.getTime() + 2 * 60 * 60_000);
    const s = await open(bob);
    await sessions.redeem(s.ticket, ORIGIN);
    const report = {
      brokerInstance: 'broker-1',
      hostKey: { outcome: 'match' as const, algorithm: 'ssh-ed25519', fingerprintSha256: FP },
    };
    expect(await sessions.reportState(s.sessionId, { state: 'ACTIVE', reason: 'opened', ...report })).toEqual(
      { state: 'ACTIVE' },
    );
    expect((await sessions.close(ctx(admin), s.sessionId)).state).toBe('REVOKED');
    expect(brokerCloses).toContain(s.sessionId);
    expect(
      await sessions.reportState(s.sessionId, {
        state: 'CLOSED',
        reason: 'revoked',
        bytesIn: 10,
        bytesOut: 2048,
        ...report,
      }),
    ).toEqual({ state: 'CLOSED' });
    // A late or repeated report changes nothing.
    expect(await sessions.reportState(s.sessionId, { state: 'ACTIVE', reason: 'opened', ...report })).toEqual(
      { state: 'CLOSED' },
    );
    const row = await t.db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', s.sessionId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      state: 'CLOSED',
      close_reason: 'revoked_by_admin',
      broker_instance: 'broker-1',
    });
    const all = await actions();
    expect(all).toContain('SSH_SESSION_OPENED');
    expect(all).toContain('SSH_SESSION_CLOSED');
  });

  it('audits a failed connect with the host-key mismatch and the refused address as security events', async () => {
    clock = new Date(clock.getTime() + 2 * 60 * 60_000);
    const a = await open(bob);
    await sessions.redeem(a.ticket, ORIGIN);
    await sessions.reportState(a.sessionId, {
      state: 'FAILED',
      reason: 'HOST_KEY_MISMATCH',
      brokerInstance: 'broker-1',
      hostKey: {
        outcome: 'mismatch',
        algorithm: 'ssh-ed25519',
        fingerprintSha256: `SHA256:${'Q'.repeat(43)}`,
      },
    });
    const b = await open(bob);
    await sessions.redeem(b.ticket, ORIGIN);
    await sessions.reportState(b.sessionId, {
      state: 'FAILED',
      reason: 'TARGET_ADDRESS_FORBIDDEN',
      brokerInstance: 'broker-1',
    });
    const all = await actions();
    expect(all).toContain('SSH_CONNECT_FAILED:HOST_KEY_MISMATCH');
    expect(all).toContain('SSH_HOST_KEY_MISMATCH:mismatch');
    expect(all).toContain('SSRF_BLOCKED:at_connect');
    await expect(
      sessions.reportState('0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d00', {
        state: 'ACTIVE',
        reason: 'x',
        brokerInstance: 'b',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('revoking the last host key makes the target pending again (no connects)', async () => {
    const target = await targets.getTarget(ctx(admin), targetId);
    await targets.revokeHostKey(ctx(admin), targetId, target.hostKeys[0]?.id ?? '');
    expect((await targets.getTarget(ctx(admin), targetId)).status).toBe('pending_host_key');
    await expect(open(bob)).rejects.toMatchObject({ code: 'TARGET_NOT_ALLOWED' });
  });

  it('keeps the audit chain intact', async () => {
    const all = await actions();
    for (const a of [
      'POLICY_CREATE',
      'TARGET_CREATE',
      'TARGET_HOST_KEY_APPROVED',
      'CREDENTIAL_REF_CREATE',
      'TARGET_UPDATE',
      'REMOTE_CONNECT_ALLOWED',
      'REMOTE_SESSION_CLOSED',
      'TARGET_HOST_KEY_REVOKED',
    ]) {
      expect(all.some((x) => x.startsWith(a))).toBe(true);
    }
    expect(await verifyAuditChain(t.db)).toMatchObject({ ok: true });
  });
});
