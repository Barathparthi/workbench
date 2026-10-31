import { z } from 'zod';

import { TestFrameworkName, TestSelectorRecord } from './test-runs.js';

/**
 * Remote targets, connection policies, host keys, credential references and remote sessions
 * (05_API_CONTRACTS §2.3–2.4, 06_DATA_MODEL, 08_REMOTE_CONNECTIVITY_DESIGN). Nothing here ever carries secret
 * material: credentials are references into a secret manager, keys are public.
 */

const FOUR_PART_DECIMAL = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * A host name or a canonical IP literal. Names made only of digits and dots are refused unless they are a
 * dotted quad (no `2130706433`, `0177.0.0.1`, `127.1`); no URLs, user info, ports, zone ids or spaces.
 */
export const TargetHost = z
  .string()
  .min(1)
  .max(253)
  .refine(
    (h) =>
      FOUR_PART_DECIMAL.test(h) ||
      z.ipv6().safeParse(h).success ||
      (HOSTNAME.test(h) && !/^[\d.]+$/.test(h) && !/^0x/i.test(h)),
    'must be a host name or a canonical IP address',
  );

/** Absolute POSIX path (or `/C:/…` for Windows OpenSSH), normalised: no `..`, `.`, `//`, control chars, not `/`. */
export const RemoteRoot = z
  .string()
  .min(2)
  .max(1024)
  .refine(
    (p) =>
      p.startsWith('/') &&
      !p.endsWith('/') &&
      // eslint-disable-next-line no-control-regex -- refusing control characters is the point
      !/[\u0000-\u001f\u007f\\]/.test(p) &&
      p
        .slice(1)
        .split('/')
        .every((seg) => seg.length > 0 && seg !== '.' && seg !== '..'),
    'must be an absolute, normalised path other than /',
  );

/** Remote account: the signed-in user's username, or one fixed service account. */
export const PrincipalTemplate = z.union([
  z.literal('{{user.username}}'),
  z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'a POSIX user name or {{user.username}}'),
]);

export const TargetName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'lower-case letters, digits and hyphens');
export const TargetTag = z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/);
export const TargetOs = z.enum(['linux', 'windows', 'macos', 'other']);
export const TargetStatus = z.enum(['pending_host_key', 'active', 'disabled']);
export const Port = z.number().int().min(1).max(65535);

export const CapabilityName = z.enum(['terminal', 'file_read', 'file_write', 'exec', 'port_forward']);
export const SessionKind = z.enum(['terminal', 'files', 'exec']);

// ── Policies ────────────────────────────────────────────────────────────────────────────────────────────
export const CreatePolicyRequest = z.strictObject({
  name: TargetName,
  /** Role names (validated against the RBAC matrix by the server). */
  allowedRoles: z.array(z.string().min(1).max(100)).min(1).max(20),
  /** Lab networks the targets may resolve to (CIDR, validated by the server). */
  allowedCidrs: z.array(z.string().min(1).max(64)).min(1).max(50),
  allowedPorts: z.array(Port).min(1).max(20).default([22]),
  capabilities: z.array(CapabilityName).min(1).max(5),
  idleTimeoutSec: z.number().int().min(60).max(86_400).default(1800),
  maxSessionSec: z.number().int().min(300).max(86_400).default(28_800),
  maxSessionsPerUser: z.number().int().min(1).max(50).default(5),
});
export type CreatePolicyRequest = z.infer<typeof CreatePolicyRequest>;
export const UpdatePolicyRequest = CreatePolicyRequest.omit({ name: true }).partial();
export type UpdatePolicyRequest = z.infer<typeof UpdatePolicyRequest>;

export const ConnectionPolicy = z.object({
  id: z.uuid(),
  name: z.string(),
  allowedRoles: z.array(z.string()),
  allowedCidrs: z.array(z.string()),
  allowedPorts: z.array(z.number()),
  capabilities: z.array(z.string()),
  idleTimeoutSec: z.number(),
  maxSessionSec: z.number(),
  maxSessionsPerUser: z.number(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const ConnectionPolicyList = z.object({ items: z.array(ConnectionPolicy) });

// ── Credential references (pointers only) ──────────────────────────────────────────────────────────────
export const CreateCredentialRefRequest = z.strictObject({
  provider: z.enum(['vault', 'azure_kv', 'aws_sm', 'gcp_sm', 'file_dev']),
  method: z.enum(['ssh_certificate', 'vault_key', 'vault_password']),
  /** Path inside the secret manager, e.g. `ssh-client-signer/sign/qe-lab-a`. Never the secret itself. */
  providerPath: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,511}$/),
  /** Non-secret settings (CA role, TTL, key type). */
  metadata: z
    .record(
      z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/),
      z.union([z.string().max(200), z.number(), z.boolean()]),
    )
    .refine((m) => Object.keys(m).length <= 20)
    .default({}),
});
export const CredentialRef = z.object({
  id: z.uuid(),
  provider: z.string(),
  method: z.string(),
  providerPath: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

// ── Targets ─────────────────────────────────────────────────────────────────────────────────────────────
export const RegisterTargetRequest = z.strictObject({
  name: TargetName,
  description: z.string().max(500).optional(),
  host: TargetHost,
  port: Port.default(22),
  os: TargetOs.default('linux'),
  principalTemplate: PrincipalTemplate.default('{{user.username}}'),
  remoteRoot: RemoteRoot,
  policyId: z.uuid(),
  credentialRefId: z.uuid().optional(),
  jumpHostId: z.uuid().optional(),
  tags: z.array(TargetTag).max(20).default([]),
});
export type RegisterTargetRequest = z.infer<typeof RegisterTargetRequest>;

export const UpdateTargetRequest = z
  .strictObject({
    description: z.string().max(500).nullable(),
    port: Port,
    principalTemplate: PrincipalTemplate,
    remoteRoot: RemoteRoot,
    policyId: z.uuid(),
    credentialRefId: z.uuid().nullable(),
    tags: z.array(TargetTag).max(20),
    /** Only `active` and `disabled` can be requested; activation needs a trusted host key and a credential. */
    status: z.enum(['active', 'disabled']),
  })
  .partial();
export type UpdateTargetRequest = z.infer<typeof UpdateTargetRequest>;

export const HostKey = z.object({
  id: z.uuid(),
  algorithm: z.string(),
  fingerprintSha256: z.string(),
  status: z.enum(['trusted', 'revoked']),
  approvedAt: z.string().nullable(),
});

export const Target = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  host: z.string(),
  port: z.number(),
  os: TargetOs,
  principalTemplate: z.string(),
  remoteRoot: z.string(),
  policyId: z.uuid(),
  credentialRefId: z.uuid().nullable(),
  jumpHostId: z.uuid().nullable(),
  tags: z.array(z.string()),
  status: TargetStatus,
  hostKeys: z.array(HostKey),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Target = z.infer<typeof Target>;
export const TargetList = z.object({ items: z.array(Target) });
export const TargetIdParams = z.object({ id: z.uuid() });
export const HostKeyParams = z.object({ id: z.uuid(), keyId: z.uuid() });

const KEY_ALGORITHMS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
] as const;

/**
 * Approve a host key, compared out of band (console, CMDB): either the OpenSSH public key line or its
 * algorithm and `SHA256:` fingerprint as `ssh-keygen -lf` prints it. Never trust-on-first-use (08 §6).
 */
export const AddHostKeyRequest = z.union([
  z.strictObject({
    publicKey: z
      .string()
      .max(16_384)
      .regex(new RegExp(`^(${KEY_ALGORITHMS.join('|')}) [A-Za-z0-9+/]+={0,3}( [^\\r\\n]{0,200})?$`)),
  }),
  z.strictObject({
    algorithm: z.enum(KEY_ALGORITHMS),
    fingerprintSha256: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  }),
]);
export type AddHostKeyRequest = z.infer<typeof AddHostKeyRequest>;

// ── Remote sessions and tickets ─────────────────────────────────────────────────────────────────────────
export const OpenSessionRequest = z.strictObject({
  kind: SessionKind,
  workspaceId: z.uuid().optional(),
  terminal: z
    .strictObject({ cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500) })
    .optional(),
});
export type OpenSessionRequest = z.infer<typeof OpenSessionRequest>;

export const OpenSessionResponse = z.object({
  sessionId: z.uuid(),
  kind: SessionKind,
  state: z.literal('AUTHORIZED'),
  streamUrl: z.string(),
  /** Single use, short-lived (60 s); send it as the `ticket.<value>` WebSocket subprotocol, never in a URL. */
  ticket: z.string(),
  expiresAt: z.string(),
  idleTimeoutSec: z.number(),
});

export const RemoteSession = z.object({
  id: z.uuid(),
  kind: SessionKind,
  state: z.string(),
  targetId: z.uuid().nullable(),
  workspaceId: z.uuid().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  closedAt: z.string().nullable(),
  closeReason: z.string().nullable(),
});
export const RemoteSessionList = z.object({ items: z.array(RemoteSession) });
export const SessionIdParams = z.object({ id: z.uuid() });

/**
 * What a ticket is bound to when the desktop app opened the session with a bearer token (PHASE_10 §10.4): desktop
 * clients have no Origin, and the broker redeems Origin-less upgrades against this value. It is not a serialized
 * origin, so no browser can ever present it, and browser tickets stay bound to their real Origin.
 */
export const DESKTOP_TICKET_ORIGIN = 'qe-desktop';

/** Internal (broker → control plane): redeem a ticket exactly once. */
export const RedeemTicketRequest = z.strictObject({
  ticket: z.string().min(16).max(128),
  /** The `Origin` the broker saw on the WebSocket (DESKTOP_TICKET_ORIGIN without one); must equal the ticket's. */
  origin: z.string().max(256),
});

/** Frozen snapshot the broker connects with (05_API_CONTRACTS §5). */
export const RedeemTicketResponse = z.object({
  sessionId: z.uuid(),
  kind: SessionKind,
  /** An exec session's test run: the broker builds the command from this, never from a client's text. */
  testRun: z
    .object({ runId: z.uuid(), framework: TestFrameworkName, selector: TestSelectorRecord })
    .nullable(),
  expiresAt: z.string(),
  terminal: z.object({ cols: z.number(), rows: z.number() }).nullable(),
  user: z.object({ id: z.uuid(), username: z.string() }),
  target: z.object({
    id: z.uuid(),
    name: z.string(),
    host: z.string(),
    port: z.number(),
    os: TargetOs,
    principal: z.string(),
    remoteRoot: z.string(),
    jumpHostId: z.uuid().nullable(),
  }),
  policy: z.object({
    id: z.uuid(),
    version: z.number(),
    allowedCidrs: z.array(z.string()),
    allowedPorts: z.array(z.number()),
    capabilities: z.array(z.string()),
    idleTimeoutSec: z.number(),
    maxSessionSec: z.number(),
  }),
  hostKeys: z.array(z.object({ algorithm: z.string(), fingerprintSha256: z.string() })),
  credential: z
    .object({
      provider: z.string(),
      method: z.string(),
      providerPath: z.string(),
      metadata: z.record(z.string(), z.unknown()),
    })
    .nullable(),
});
export type RedeemTicketResponse = z.infer<typeof RedeemTicketResponse>;

/** Internal (broker → control plane): what happened to a session. */
export const SessionStateReport = z.strictObject({
  state: z.enum(['ACTIVE', 'CLOSED', 'FAILED']),
  /** Close reason or error code (`remote_exited`, `idle_timeout`, `HOST_KEY_MISMATCH`, …). */
  reason: z.string().regex(/^[A-Za-z_]{1,64}$/),
  brokerInstance: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  hostKey: z
    .strictObject({
      outcome: z.enum(['match', 'mismatch', 'unknown']),
      algorithm: z.string().max(64),
      fingerprintSha256: z.string().max(80),
    })
    .optional(),
  bytesIn: z.number().int().min(0).optional(),
  bytesOut: z.number().int().min(0).optional(),
});
export type SessionStateReport = z.infer<typeof SessionStateReport>;

/** Internal (broker → control plane): this broker instance (re)started and holds no sessions. */
export const BrokerInstanceParams = z.object({ instance: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/) });
