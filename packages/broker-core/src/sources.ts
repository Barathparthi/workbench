import type { TrustedHostKey } from './host-key.js';

/**
 * What differs between the hosted broker and the embedded one (ADR-008, 09_LOCAL_AND_WEB_PARITY §3.4). The hosted
 * broker gets targets, credentials, host keys and audit from the control plane; the embedded broker (desktop, local
 * web) from the user's own machine: `~/.ssh/config`, the SSH agent and key files, `known_hosts`, a local audit log.
 */

/** A host from the user's SSH configuration (a "personal target"). */
export interface PersonalTarget {
  /** `personal:<alias>` — never collides with a managed target's UUID. */
  readonly id: string;
  /** The `Host` alias as written in the configuration. */
  readonly alias: string;
  /** `HostName`, or the alias when there is none. */
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** `IdentityFile` entries, expanded to absolute paths, in order. Empty: OpenSSH's default key files. */
  readonly identityFiles: readonly string[];
  /** `IdentitiesOnly yes`: only the configured key files, never the agent's other keys. */
  readonly identitiesOnly: boolean;
  /** `ProxyJump` as written; jump hosts are not supported yet (Phase 19), so such a target cannot connect. */
  readonly proxyJump?: string;
  /** Where it was found: the user's `~/.ssh/config`, or hosts added in the IDE (`~/.qe-workspace/ssh_hosts`). */
  readonly source: 'ssh-config' | 'qe-hosts';
}

export interface TargetSource {
  list(): Promise<PersonalTarget[]>;
  get(id: string): Promise<PersonalTarget | undefined>;
}

/** What `known_hosts` says about one host. */
export interface HostKeyRecord {
  readonly trusted: readonly TrustedHostKey[];
  /** SHA256 fingerprints listed `@revoked`: refused even if also trusted. */
  readonly revoked: readonly string[];
}

export interface HostKeyStore {
  lookup(host: string, port: number): Promise<HostKeyRecord>;
  /** "Trust and save": records the key for this host in QE's own file (never silently in the user's). */
  trust(host: string, port: number, keyBlob: Uint8Array): Promise<void>;
}

/** One line of the embedded broker's audit trail: names and outcomes only, never contents, keys or commands. */
export interface LocalAuditEvent {
  readonly action: string;
  /** The target's id (`personal:<alias>`). */
  readonly target: string;
  readonly outcome: 'success' | 'failure' | 'denied';
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export interface AuditSink {
  record(event: LocalAuditEvent): Promise<void>;
}
