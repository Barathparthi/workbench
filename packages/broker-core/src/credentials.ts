import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { DomainError } from '@qe/domain';

import type { SshCredential } from './ssh-transport.js';

/** A credential *reference* from the control plane snapshot — never the secret itself. */
export interface CredentialReference {
  readonly provider: string;
  readonly method: string;
  readonly providerPath: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Resolves a reference to key material, on the broker only, at connect time (07_SECURITY T8). */
export interface CredentialSource {
  resolve(reference: CredentialReference, principal: string): Promise<SshCredential>;
}

/**
 * Development only: `file_dev` references name a private key file under one directory. Refused outside that
 * directory (no `..`, no symlinks out) and refused entirely in production by the broker's configuration.
 * Vault-backed sources (SSH certificates) replace this in Phase 12.
 */
export function fileDevCredentialSource(baseDir: string): CredentialSource {
  return {
    async resolve(reference) {
      if (reference.provider !== 'file_dev' || reference.method !== 'vault_key') {
        throw new DomainError('CREDENTIALS_UNAVAILABLE', 'this broker only has development key files');
      }
      if (isAbsolute(reference.providerPath))
        throw new DomainError('CREDENTIALS_UNAVAILABLE', 'invalid key path');
      try {
        const root = await realpath(baseDir);
        const file = await realpath(join(root, reference.providerPath));
        const rel = relative(root, file);
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
          throw new DomainError('CREDENTIALS_UNAVAILABLE', 'invalid key path');
        }
        return { kind: 'key', privateKey: await readFile(file) };
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError('CREDENTIALS_UNAVAILABLE', 'key file unavailable');
      }
    },
  };
}
