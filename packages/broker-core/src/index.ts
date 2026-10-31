/**
 * @qe/broker-core — SSH transport, host-key verification and the remote terminal bridge (ADR-002, ADR-008), used by
 * the hosted connection broker and (Phase 10) the embedded desktop broker.
 */
export const PACKAGE_NAME = '@qe/broker-core';

export { DomainError, isDomainError, type ErrorCode } from '@qe/domain';
export { mapSshError, messageFor } from './errors.js';
export { fileOperation } from './file-operations.js';
export {
  createHostKeyVerifier,
  keyAlgorithm,
  sha256Fingerprint,
  type HostKeyOutcome,
  type HostKeyVerifier,
  type TrustedHostKey,
} from './host-key.js';
export {
  ALGORITHMS,
  CONNECT_TIMEOUT_MS,
  ssh2Transport,
  type ExecChannel,
  type PtyChannel,
  type KeyMaterial,
  type SshConnection,
  type SshCredential,
  type SshEndpoint,
  type SshTransport,
} from './ssh-transport.js';
export {
  CLOSE_CODE,
  TerminalBridge,
  type BridgeOptions,
  type BridgeResult,
  type CloseReason,
  type StreamSocket,
} from './terminal-bridge.js';
export { SessionRegistry } from './session-registry.js';
export {
  confine,
  createPathGuard,
  MAX_PATH_LENGTH,
  relativeToRoot,
  type PathGuard,
  type RealpathFn,
  type ResolveMode,
} from './confine.js';
export { mapSftpError, wrapSftp, type RemoteDirEntry, type RemoteStats, type SftpChannel } from './sftp.js';
export {
  createRemoteFileSystem,
  etagOf,
  isTempName,
  type FsWriteInput,
  type RemoteFileSystem,
  type RemoteFileSystemOptions,
} from './remote-fs.js';
export { fileDevCredentialSource, type CredentialReference, type CredentialSource } from './credentials.js';
export type {
  AuditSink,
  HostKeyRecord,
  HostKeyStore,
  LocalAuditEvent,
  PersonalTarget,
  TargetSource,
} from './sources.js';
export {
  personalTargetId,
  sshConfigTargetSource,
  type NewPersonalHost,
  type SshConfigTargetsOptions,
} from './ssh-config-targets.js';
export { knownHostsName, knownHostsStore, type KnownHostsOptions } from './known-hosts.js';
export {
  detectAgent,
  personalCredentials,
  WINDOWS_OPENSSH_AGENT,
  type PersonalCredentialOptions,
  type PersonalCredentials,
} from './personal-credentials.js';
export { localAuditLog, type LocalAuditOptions } from './local-audit.js';
export {
  remoteCancelCommand,
  remoteRunCommand,
  shellCommand,
  shellQuote,
  type RemoteRun,
} from './remote-exec.js';
export {
  MAX_REMOTE_REPORT_BYTES,
  readRemoteRun,
  runRemoteTests,
  type RemoteRunOptions,
  type RemoteRunOutcome,
  type RemoteRunSpec,
} from './remote-run.js';
