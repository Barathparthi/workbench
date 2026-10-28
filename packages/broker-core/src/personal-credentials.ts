import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import ssh2 from 'ssh2';

import type { PersonalTarget } from './sources.js';
import type { KeyMaterial, SshCredential } from './ssh-transport.js';

/** The OpenSSH for Windows agent's named pipe. */
export const WINDOWS_OPENSSH_AGENT = '\\\\.\\pipe\\openssh-ssh-agent';

/** Key files are small; anything larger is not a private key. */
const MAX_KEY_BYTES = 64 * 1024;
/** Wrong passphrases accepted before a key is skipped. */
const PASSPHRASE_ATTEMPTS = 3;

/**
 * The user's SSH agent (PHASE_10 §10.3): `SSH_AUTH_SOCK` wherever it is set; on Windows the OpenSSH agent's pipe,
 * else Pageant. An agent that turns out not to answer is skipped at connect time.
 */
export function detectAgent(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const socket = env['SSH_AUTH_SOCK'];
  if (socket !== undefined && socket !== '') return socket;
  if (platform === 'win32') return exists(WINDOWS_OPENSSH_AGENT) ? WINDOWS_OPENSSH_AGENT : 'pageant';
  return undefined;
}

export interface PersonalCredentialOptions {
  readonly home: string;
  /** From `detectAgent()`; undefined when there is none. */
  readonly agent: string | undefined;
  /** Asks the user for a key's passphrase (the IDE's input dialog); undefined when they cancel. */
  readonly askPassphrase: (keyPath: string) => Promise<string | undefined>;
  /** Reads a key file, or undefined when it does not exist (tests replace it). */
  readonly read?: (path: string) => Promise<Buffer | undefined>;
}

export interface PersonalCredentials {
  /** The agent and the key files that need no passphrase: tried first, without asking anything. */
  readonly first: SshCredential | undefined;
  /** Key files that are encrypted; `unlock()` asks for their passphrases. */
  readonly encryptedKeys: readonly string[];
  /** Asks for the passphrases (only after `first` was rejected, as OpenSSH does); undefined when none unlocked. */
  unlock(): Promise<SshCredential | undefined>;
}

async function readKey(path: string): Promise<Buffer | undefined> {
  try {
    const data = await readFile(path);
    return data.length > MAX_KEY_BYTES ? undefined : data;
  } catch {
    return undefined;
  }
}

/** OpenSSH's default key files, when the configuration names none. */
const defaultKeyFiles = (home: string) =>
  ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((n) => join(home, '.ssh', n));

const isPrivate = (parsed: ReturnType<typeof ssh2.utils.parseKey>): boolean =>
  !(parsed instanceof Error) && parsed.isPrivateKey();

/**
 * Credentials for a personal target on the user's machine (PHASE_10 §10.3): the agent first (unless
 * `IdentitiesOnly`), then the target's key files. Keys and passphrases stay in this process's memory for the
 * connection only; they are never written, logged or sent to the control plane.
 */
export async function personalCredentials(
  target: PersonalTarget,
  options: PersonalCredentialOptions,
): Promise<PersonalCredentials> {
  const read = options.read ?? readKey;
  const agent = target.identitiesOnly ? undefined : options.agent;
  const paths = target.identityFiles.length > 0 ? target.identityFiles : defaultKeyFiles(options.home);

  const plain: KeyMaterial[] = [];
  const encrypted: { path: string; data: Buffer }[] = [];
  for (const path of paths) {
    const data = await read(path);
    if (data === undefined) continue;
    const parsed = ssh2.utils.parseKey(data);
    if (parsed instanceof Error) {
      if (/passphrase|encrypted/i.test(parsed.message)) encrypted.push({ path, data });
      continue; // not a key ssh2 can use
    }
    if (isPrivate(parsed)) plain.push({ privateKey: data });
  }

  const credential = (keys: readonly KeyMaterial[], withAgent: boolean): SshCredential | undefined =>
    keys.length === 0 && !(withAgent && agent !== undefined)
      ? undefined
      : { kind: 'methods', ...(withAgent && agent !== undefined && { agent }), keys };

  return {
    first: credential(plain, true),
    encryptedKeys: encrypted.map((k) => k.path),
    async unlock() {
      const unlocked: KeyMaterial[] = [];
      for (const key of encrypted) {
        for (let attempt = 0; attempt < PASSPHRASE_ATTEMPTS; attempt++) {
          const passphrase = await options.askPassphrase(key.path);
          if (passphrase === undefined) break;
          if (isPrivate(ssh2.utils.parseKey(key.data, passphrase))) {
            unlocked.push({ privateKey: key.data, passphrase });
            break;
          }
        }
      }
      return credential(unlocked, false);
    },
  };
}
