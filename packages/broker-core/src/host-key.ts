import { createHash } from 'node:crypto';

/** OpenSSH `SHA256:` fingerprint of a host key blob, as `ssh-keygen -lf` prints it. */
export const sha256Fingerprint = (blob: Uint8Array): string =>
  `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;

/** The key type written at the start of an SSH public key blob (`ssh-ed25519`, `ecdsa-sha2-nistp256`, …). */
export function keyAlgorithm(blob: Uint8Array): string {
  if (blob.length < 4) return 'unknown';
  const length = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0);
  return length > 0 && length <= 64 && blob.length >= 4 + length
    ? new TextDecoder().decode(blob.subarray(4, 4 + length))
    : 'unknown';
}

export interface TrustedHostKey {
  readonly algorithm: string;
  readonly fingerprintSha256: string;
}

export type HostKeyOutcome = 'match' | 'mismatch' | 'unknown';

export interface HostKeyVerifier {
  /** The `hostVerifier` for ssh2: true only for a trusted fingerprint. Fails closed on anything else. */
  verify(key: Uint8Array): boolean;
  /** What happened at the last handshake (undefined before one). */
  readonly outcome: HostKeyOutcome | undefined;
  /** What the server presented (for the audit trail and the user's terminal header). */
  readonly presented: { algorithm: string; fingerprintSha256: string } | undefined;
}

/**
 * Pinned host-key verification (ADR-002 addendum, S4 rule 2): compares OpenSSH SHA256 fingerprints and tells
 * `unknown` (nothing trusted on record) from `mismatch` (something else is trusted — a possible MITM). A mismatch
 * ends the connection during key exchange, before any credential is sent (proven in S4).
 */
export function createHostKeyVerifier(trusted: readonly TrustedHostKey[]): HostKeyVerifier {
  const fingerprints = new Set(trusted.map((k) => k.fingerprintSha256));
  const state: { outcome?: HostKeyOutcome; presented?: { algorithm: string; fingerprintSha256: string } } =
    {};
  return {
    verify(key) {
      const presented = { algorithm: keyAlgorithm(key), fingerprintSha256: sha256Fingerprint(key) };
      state.presented = presented;
      state.outcome =
        fingerprints.size === 0
          ? 'unknown'
          : fingerprints.has(presented.fingerprintSha256)
            ? 'match'
            : 'mismatch';
      return state.outcome === 'match';
    },
    get outcome() {
      return state.outcome;
    },
    get presented() {
      return state.presented;
    },
  };
}
