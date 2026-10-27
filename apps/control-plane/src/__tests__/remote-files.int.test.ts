/** Remote file operations through the control plane on PostgreSQL (Phase 09 §9.3): ownership, policy, audit. */
import type { BrokerFsRequest, FsOp } from '@qe/contracts';
import { DomainError } from '@qe/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../audit/audit-writer.js';
import { makePrincipal, type Principal } from '../auth.js';
import { createRemoteFileService, type RemoteFileService } from '../remote-file-service.js';
import { createRemoteSessionService, type RemoteSessionService } from '../remote-session-service.js';
import { UsersRepo } from '../repos/users.js';
import { createTargetService, type TargetService } from '../target-service.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

const ORIGIN = 'https://qe.example';
const FP = `SHA256:${'B'.repeat(43)}`;
const TICKET_TTL_MS = 60_000;

let t: TestDatabase;
let targets: TargetService;
let sessions: RemoteSessionService;
let files: RemoteFileService;
let admin: Principal;
let bob: Principal;
let dave: Principal;
let clock = new Date('2026-10-27T10:00:00Z');
const ctx = (p: Principal) => ({ principal: p, requestId: 'req-files-1' });

const brokerCalls: { sessionId: string; op: FsOp; body: BrokerFsRequest }[] = [];
const brokerCloses: string[] = [];
let brokerAnswer: (op: FsOp) => Promise<unknown> = () => Promise.resolve({});

let rwPolicyId = '';
let rwTarget = '';
let roTarget = '';

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

async function activeTarget(name: string, capabilities: ('terminal' | 'file_read' | 'file_write')[]) {
  const policy = await targets.createPolicy(ctx(admin), {
    name,
    allowedRoles: ['lab.a.user'],
    allowedCidrs: ['10.20.0.0/16'],
    allowedPorts: [22],
    capabilities,
    idleTimeoutSec: 1800,
    maxSessionSec: 3600,
    maxSessionsPerUser: 20,
  });
  const target = await targets.registerTarget(ctx(admin), {
    name,
    host: '10.20.1.5',
    port: 22,
    os: 'linux',
    principalTemplate: '{{user.username}}',
    remoteRoot: '/home/qe/work',
    policyId: policy.id,
    tags: [],
  });
  await targets.addHostKey(ctx(admin), target.id, { algorithm: 'ssh-ed25519', fingerprintSha256: FP });
  const cred = await targets.createCredentialRef(ctx(admin), {
    provider: 'file_dev',
    method: 'vault_key',
    providerPath: 'qe-lab-a_ed25519',
    metadata: {},
  });
  await targets.updateTarget(ctx(admin), target.id, { credentialRefId: cred.id, status: 'active' });
  return { policyId: policy.id, targetId: target.id };
}

const openFiles = async (p: Principal, targetId = rwTarget) =>
  (await sessions.open(ctx(p), targetId, { kind: 'files' }, ORIGIN)).sessionId;

const codeOf = async (work: Promise<unknown>) =>
  work.then(
    () => 'resolved',
    (e: unknown) => (e instanceof DomainError ? e.code : 'other'),
  );

const fileAudits = () =>
  t.db
    .selectFrom('audit_events')
    .select(['action', 'result', 'reason_code', 'metadata_json'])
    .where('action', 'like', 'REMOTE_FILE_%')
    .orderBy('seq')
    .execute();

beforeAll(async () => {
  t = await startTestDatabase();
  [admin, bob, dave] = await Promise.all([
    user('admin', ['qe.admin', 'qe.user', 'lab.a.user']),
    user('bob', ['qe.user', 'lab.a.user']),
    user('dave', ['qe.user', 'lab.a.user']),
  ]);
  targets = createTargetService(t.db, { deniedCidrs: [], resolver: () => Promise.resolve(['10.20.1.5']) });
  sessions = createRemoteSessionService(t.db, {
    ticketTtlMs: TICKET_TTL_MS,
    allowedOrigins: [ORIGIN],
    now: () => clock,
  });
  files = createRemoteFileService(t.db, {
    ticketTtlMs: TICKET_TTL_MS,
    now: () => clock,
    broker: (sessionId, op, body) => {
      brokerCalls.push({ sessionId, op, body });
      return brokerAnswer(op);
    },
    closeOnBroker: (sessionId) => {
      brokerCloses.push(sessionId);
      return Promise.resolve();
    },
  });
  ({ policyId: rwPolicyId, targetId: rwTarget } = await activeTarget('lab-a-rw', [
    'file_read',
    'file_write',
  ]));
  ({ targetId: roTarget } = await activeTarget('lab-a-ro', ['file_read']));
});
afterAll(async () => {
  await t.stop();
});
beforeEach(() => {
  brokerCalls.length = 0;
  brokerCloses.length = 0;
  brokerAnswer = () => Promise.resolve({});
});

describe('remote file operations', () => {
  it('forwards an operation with the session snapshot; the first one moves the session to CONNECTING', async () => {
    const id = await openFiles(bob);
    brokerAnswer = () => Promise.resolve({ type: 'directory' });
    expect(await files.run(ctx(bob), id, 'stat', { path: '' })).toEqual({ type: 'directory' });
    const call = brokerCalls[0];
    expect(call?.op).toBe('stat');
    expect(call?.body.request).toEqual({ path: '' });
    expect(call?.body.snapshot).toMatchObject({
      sessionId: id,
      kind: 'files',
      user: { username: 'bob' },
      target: { id: rwTarget, remoteRoot: '/home/qe/work', principal: 'bob' },
      policy: { capabilities: ['file_read', 'file_write'] },
    });
    const row = await t.db
      .selectFrom('sessions')
      .select('state')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('CONNECTING');
    await files.run(ctx(bob), id, 'stat', { path: '' });
    expect(brokerCalls).toHaveLength(2);
  });

  it('is the owner’s only: another user and an administrator get 404, nothing reaches the broker', async () => {
    const id = await openFiles(bob);
    expect(await codeOf(files.run(ctx(dave), id, 'read', { path: 'a' }))).toBe('NOT_FOUND');
    expect(await codeOf(files.run(ctx(admin), id, 'read', { path: 'a' }))).toBe('NOT_FOUND');
    expect(
      await codeOf(files.run(ctx(bob), '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d00', 'stat', { path: '' })),
    ).toBe('NOT_FOUND');
    expect(brokerCalls).toEqual([]);
  });

  it('refuses a session of another kind', async () => {
    const sessionId = await openFiles(bob);
    await t.db.updateTable('sessions').set({ kind: 'terminal' }).where('id', '=', sessionId).execute();
    expect(await codeOf(files.run(ctx(bob), sessionId, 'stat', { path: '' }))).toBe('INVALID_REQUEST');
  });

  it('audits a write with its relative path and size, never the content', async () => {
    const id = await openFiles(bob);
    brokerAnswer = () => Promise.resolve({ etag: '1761000000000-21' });
    const content = 'SECRET-CONTENT-CANARY';
    await files.run(ctx(bob), id, 'write', {
      path: 'src/main.py',
      contentBase64: Buffer.from(content).toString('base64'),
    });
    await files.run(ctx(bob), id, 'read', { path: 'src/main.py' });
    const audits = await fileAudits();
    expect(audits.at(-1)).toMatchObject({
      action: 'REMOTE_FILE_WRITE',
      result: 'success',
      metadata_json: { targetId: rwTarget, op: 'write', path: 'src/main.py', size: content.length },
    });
    const everything = JSON.stringify(await t.db.selectFrom('audit_events').selectAll().execute());
    expect(everything).not.toContain(content);
    expect(everything).not.toContain(Buffer.from(content).toString('base64'));
    // Reads are not audited (an editor polls them); only changes are.
    expect(audits.filter((a) => a.action === 'REMOTE_FILE_WRITE')).toHaveLength(1);
  });

  it('refuses every change without the policy’s file_write (403, audited as denied), reads still work', async () => {
    const id = await openFiles(bob, roTarget);
    for (const [op, request] of [
      ['write', { path: 'a', contentBase64: '' }],
      ['mkdir', { path: 'd' }],
      ['rename', { from: 'a', to: 'b' }],
      ['delete', { path: 'a', recursive: true }],
    ] as const) {
      expect(await codeOf(files.run(ctx(bob), id, op, request))).toBe('FORBIDDEN');
    }
    expect(brokerCalls).toEqual([]);
    const denied = (await fileAudits()).filter((a) => a.result === 'denied');
    expect(denied.map((a) => `${a.action}:${a.reason_code ?? ''}`)).toEqual([
      'REMOTE_FILE_WRITE:capability_not_allowed',
      'REMOTE_FILE_WRITE:capability_not_allowed',
      'REMOTE_FILE_RENAME:capability_not_allowed',
      'REMOTE_FILE_DELETE:capability_not_allowed',
    ]);
    await files.run(ctx(bob), id, 'read', { path: 'a' });
    expect(brokerCalls.map((c) => c.op)).toEqual(['read']);
  });

  it('passes the broker’s error on and audits a refused change with its code', async () => {
    const id = await openFiles(bob);
    brokerAnswer = () => Promise.reject(new DomainError('PATH_OUTSIDE_ROOT'));
    expect(await codeOf(files.run(ctx(bob), id, 'delete', { path: '../../etc', recursive: true }))).toBe(
      'PATH_OUTSIDE_ROOT',
    );
    brokerAnswer = () => Promise.reject(new DomainError('REMOTE_FILE_CONFLICT'));
    expect(
      await codeOf(files.run(ctx(bob), id, 'write', { path: 'a', contentBase64: '', ifMatch: '1-1' })),
    ).toBe('REMOTE_FILE_CONFLICT');
    expect((await fileAudits()).slice(-2)).toMatchObject([
      {
        action: 'REMOTE_FILE_DELETE',
        result: 'denied',
        reason_code: 'PATH_OUTSIDE_ROOT',
        metadata_json: { path: '../../etc', recursive: true },
      },
      { action: 'REMOTE_FILE_WRITE', result: 'failure', reason_code: 'REMOTE_FILE_CONFLICT' },
    ]);
  });

  it('audits a path with NUL (refused by the broker) without breaking the audit log', async () => {
    const id = await openFiles(bob);
    brokerAnswer = () => Promise.reject(new DomainError('PATH_OUTSIDE_ROOT'));
    expect(await codeOf(files.run(ctx(bob), id, 'rename', { from: 'a\0b', to: 'c' }))).toBe(
      'PATH_OUTSIDE_ROOT',
    );
    expect((await fileAudits()).at(-1)).toMatchObject({ metadata_json: { from: 'a�b', to: 'c' } });
  });

  it('answers 410 for a closed, revoked or never-used expired session; the IDE opens a new one', async () => {
    const closed = await openFiles(bob);
    await files.run(ctx(bob), closed, 'stat', { path: '' });
    await sessions.reportState(closed, { state: 'ACTIVE', reason: 'opened', brokerInstance: 'broker-1' });
    await sessions.reportState(closed, {
      state: 'CLOSED',
      reason: 'idle_timeout',
      brokerInstance: 'broker-1',
    });
    expect(await codeOf(files.run(ctx(bob), closed, 'stat', { path: '' }))).toBe('SESSION_EXPIRED');

    const revoked = await openFiles(bob);
    await files.run(ctx(bob), revoked, 'stat', { path: '' });
    await sessions.reportState(revoked, { state: 'ACTIVE', reason: 'opened', brokerInstance: 'broker-1' });
    expect((await sessions.close(ctx(admin), revoked)).state).toBe('REVOKED');
    expect(await codeOf(files.run(ctx(bob), revoked, 'stat', { path: '' }))).toBe('SESSION_REVOKED');

    const unused = await openFiles(bob);
    clock = new Date(clock.getTime() + TICKET_TTL_MS + 1);
    expect(await codeOf(files.run(ctx(bob), unused, 'stat', { path: '' }))).toBe('SESSION_EXPIRED');
  });

  it('stops a live session at once when its policy changes, and drops it on the broker', async () => {
    const id = await openFiles(bob);
    await files.run(ctx(bob), id, 'stat', { path: '' });
    await targets.updatePolicy(ctx(admin), rwPolicyId, { idleTimeoutSec: 900 });
    brokerCalls.length = 0;
    expect(await codeOf(files.run(ctx(bob), id, 'stat', { path: '' }))).toBe('TARGET_NOT_ALLOWED');
    expect(brokerCalls).toEqual([]);
    expect(brokerCloses).toEqual([id]);
  });

  it('closes what a restarted broker held, and stale unclaimed connects, and nothing else', async () => {
    const set = (
      id: string,
      values: {
        state: 'ACTIVE' | 'CONNECTING' | 'CLOSED';
        broker_instance?: string | null;
        created_at?: Date;
      },
    ) => t.db.updateTable('sessions').set(values).where('id', '=', id).execute();
    const [mine, other, fresh, stale, done] = await Promise.all([1, 2, 3, 4, 5].map(() => openFiles(bob)));
    await set(mine ?? '', { state: 'ACTIVE', broker_instance: 'broker-a' });
    await set(other ?? '', { state: 'ACTIVE', broker_instance: 'broker-b' });
    await set(fresh ?? '', { state: 'CONNECTING' });
    await set(stale ?? '', { state: 'CONNECTING', created_at: new Date(clock.getTime() - 3 * 60_000) });
    await set(done ?? '', { state: 'CLOSED', broker_instance: 'broker-a' });

    expect(await sessions.brokerStarted('broker-a')).toEqual({ closed: 2 });
    const states = await t.db
      .selectFrom('sessions')
      .select(['id', 'state', 'close_reason'])
      .where(
        'id',
        'in',
        [mine, other, fresh, stale, done].map((x) => x ?? ''),
      )
      .execute();
    const byId = new Map(states.map((s) => [s.id, `${s.state}:${s.close_reason ?? ''}`]));
    expect([mine, other, fresh, stale, done].map((id) => byId.get(id ?? ''))).toEqual([
      'CLOSED:broker_restarted',
      'ACTIVE:',
      'CONNECTING:',
      'CLOSED:broker_restarted',
      'CLOSED:',
    ]);
    const closedAudits = await t.db
      .selectFrom('audit_events')
      .select(['resource_id', 'reason_code'])
      .where('action', '=', 'SSH_SESSION_CLOSED')
      .where('reason_code', '=', 'broker_restarted')
      .execute();
    expect(closedAudits.map((a) => a.resource_id).sort()).toEqual([mine, stale].sort());
  });

  it('keeps the audit chain intact', async () => {
    expect(await verifyAuditChain(t.db)).toMatchObject({ ok: true });
  });
});
