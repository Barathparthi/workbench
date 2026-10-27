/**
 * @qe/broker-core — SSH transport, host-key verification and the remote terminal bridge (ADR-002, ADR-008), used by
 * the hosted connection broker and (Phase 10) the embedded desktop broker.
 */
export const PACKAGE_NAME = '@qe/broker-core';

export { DomainError, isDomainError, type ErrorCode } from '@qe/domain';
export { mapSshError } from './errors.js';
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
  type PtyChannel,
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
export { fileDevCredentialSource, type CredentialReference, type CredentialSource } from './credentials.js';
