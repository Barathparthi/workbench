import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { keyAlgorithm, sha256Fingerprint, type TrustedHostKey } from './host-key.js';
import type { HostKeyRecord, HostKeyStore } from './sources.js';

export interface KnownHostsOptions {
  /** Files to read, in order: the user's (`~/.ssh/known_hosts`) and QE's own (`~/.qe-workspace/known_hosts`). */
  readonly files: readonly string[];
  /** Where "trust and save" writes: QE's own file, never the user's silently. */
  readonly saveTo: string;
  /** Reads a file, or undefined when it does not exist (tests replace it). */
  readonly read?: (path: string) => Promise<string | undefined>;
}

const MAX_KNOWN_HOSTS_BYTES = 4 * 1024 * 1024;

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    return text.length > MAX_KNOWN_HOSTS_BYTES ? undefined : text;
  } catch {
    return undefined;
  }
}

/** How OpenSSH writes the host part: `name` on port 22, `[name]:port` otherwise. */
export const knownHostsName = (host: string, port: number): string =>
  port === 22 ? host : `[${host}]:${String(port)}`;

function globMatches(pattern: string, text: string): boolean {
  // `[` and `]` are literal here: `[host]:2222` is how a non-default port is written.
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i').test(text);
}

/** A hashed entry: `|1|base64(salt)|base64(HMAC-SHA1(salt, name))`. */
function hashedMatches(entry: string, name: string): boolean {
  const parts = entry.split('|');
  if (parts.length !== 4 || parts[1] !== '1') return false;
  const salt = Buffer.from(parts[2] ?? '', 'base64');
  const expected = Buffer.from(parts[3] ?? '', 'base64');
  const actual = createHmac('sha1', salt).update(name).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** One of the patterns matches and none of the negated ones (sshd(8) "SSH_KNOWN_HOSTS FILE FORMAT"). */
function hostsMatch(field: string, name: string): boolean {
  if (field.startsWith('|')) return hashedMatches(field, name);
  let matched = false;
  for (const pattern of field.split(',')) {
    if (pattern.startsWith('!')) {
      if (globMatches(pattern.slice(1), name)) return false;
    } else if (globMatches(pattern, name)) matched = true;
  }
  return matched;
}

interface Entry {
  readonly marker: 'revoked' | 'cert-authority' | undefined;
  readonly hosts: string;
  readonly key: TrustedHostKey;
}

function parse(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    const marker = fields[0]?.startsWith('@') === true ? fields.shift() : undefined;
    if (marker !== undefined && marker !== '@revoked' && marker !== '@cert-authority') continue;
    const [hosts, type, base64] = fields;
    if (hosts === undefined || type === undefined || base64 === undefined) continue;
    const blob = Buffer.from(base64, 'base64');
    // The key blob names its own type; a line whose type field disagrees is not trusted.
    if (blob.length === 0 || keyAlgorithm(blob) !== type) continue;
    entries.push({
      marker: marker === undefined ? undefined : marker === '@revoked' ? 'revoked' : 'cert-authority',
      hosts,
      key: { algorithm: type, fingerprintSha256: sha256Fingerprint(blob) },
    });
  }
  return entries;
}

/**
 * Host keys from `known_hosts` files for personal targets (08_REMOTE_CONNECTIVITY §10). Plain and hashed host
 * entries, wildcards and negation, `[host]:port`; `@revoked` keys are refused even where trusted. `@cert-authority`
 * lines are not used: host certificates are not among the algorithms the transport negotiates, so such a host is
 * treated as having no trusted key (the user is asked, per policy) rather than silently trusted.
 */
export function knownHostsStore(options: KnownHostsOptions): HostKeyStore {
  const read = options.read ?? readIfPresent;
  return {
    async lookup(host, port): Promise<HostKeyRecord> {
      const name = knownHostsName(host, port);
      const trusted: TrustedHostKey[] = [];
      const revoked: string[] = [];
      for (const file of options.files) {
        const text = await read(file);
        if (text === undefined) continue;
        for (const entry of parse(text)) {
          if (entry.marker === 'revoked') {
            // @revoked applies to the key wherever it shows up; its host field is usually `*`.
            if (hostsMatch(entry.hosts, name)) revoked.push(entry.key.fingerprintSha256);
          } else if (entry.marker === undefined && hostsMatch(entry.hosts, name)) {
            trusted.push(entry.key);
          }
        }
      }
      return { trusted, revoked };
    },

    async trust(host, port, keyBlob) {
      const type = keyAlgorithm(keyBlob);
      if (type === 'unknown') throw new Error('not an SSH public key');
      await mkdir(dirname(options.saveTo), { recursive: true, mode: 0o700 });
      const line = `${knownHostsName(host, port)} ${type} ${Buffer.from(keyBlob).toString('base64')}\n`;
      await appendFile(options.saveTo, line, { mode: 0o600 });
      await chmod(options.saveTo, 0o600).catch(() => undefined);
    },
  };
}
