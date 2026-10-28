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

/** `revoked`: the key is on a revocation list (known_hosts `@revoked`) — refused even where it is also trusted. */
export type HostKeyOutcome = 'match' | 'mismatch' | 'unknown' | 'revoked';

export interface HostKeyVerifier {
  /** The `hostVerifier` for ssh2: true only for a trusted fingerprint. Fails closed on anything else. */
  verify(key: Uint8Array): boolean;
  /** What happened at the last handshake (undefined before one). */
  readonly outcome: HostKeyOutcome | undefined;
  /** What the server presented (for the audit trail and the user's terminal header). */
  readonly presented: { algorithm: string; fingerprintSha256: string } | undefined;
  /** The key blob itself, so a key the user chose to trust can be saved to known_hosts (personal targets). */
  readonly presentedKey: Uint8Array | undefined;
}

/**
 * Pinned host-key verification (ADR-002 addendum, S4 rule 2): compares OpenSSH SHA256 fingerprints and tells
 * `unknown` (nothing trusted on record) from `mismatch` (something else is trusted — a possible MITM). A mismatch
 * ends the connection during key exchange, before any credential is sent (proven in S4). A revoked key fails first,
 * whatever else is trusted, so it can never be offered for trust-on-first-use either.
 */
export function createHostKeyVerifier(
  trusted: readonly TrustedHostKey[],
  options: { readonly revoked?: readonly string[] } = {},
): HostKeyVerifier {
  const fingerprints = new Set(trusted.map((k) => k.fingerprintSha256));
  const revoked = new Set(options.revoked ?? []);
  const state: {
    outcome?: HostKeyOutcome;
    presented?: { algorithm: string; fingerprintSha256: string };
    key?: Uint8Array;
  } = {};
  return {
    verify(key) {
      const presented = { algorithm: keyAlgorithm(key), fingerprintSha256: sha256Fingerprint(key) };
      state.presented = presented;
      state.key = Uint8Array.from(key);
      state.outcome = revoked.has(presented.fingerprintSha256)
        ? 'revoked'
        : fingerprints.size === 0
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
    get presentedKey() {
      return state.key;
    },
  };
}
