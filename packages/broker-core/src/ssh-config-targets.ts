import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';

import SSHConfig, { LineType, type Line } from 'ssh-config';

import type { PersonalTarget, TargetSource } from './sources.js';

export interface SshConfigTargetsOptions {
  /** The user's home directory (`~`). */
  readonly home: string;
  /** The local user name: the default remote user, and `%u`. */
  readonly localUser: string;
  /** Reads a file, or undefined when it does not exist (tests replace it). */
  readonly read?: (path: string) => Promise<string | undefined>;
}

/** Larger configuration files are not read (a real one is a few kB). */
const MAX_CONFIG_BYTES = 1024 * 1024;
const HOST_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*\.?$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;
const USER = /^[^\s\0/\\:@]{1,64}$/;

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    return text.length > MAX_CONFIG_BYTES ? undefined : text;
  } catch {
    return undefined;
  }
}

const values = (line: Line): string[] => {
  if (line.type !== LineType.DIRECTIVE) return [];
  return typeof line.value === 'string' ? [line.value] : line.value.map((v) => v.val);
};

/** OpenSSH host patterns: `*` and `?` wildcards, case-insensitive. */
function globMatches(pattern: string, text: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i').test(text);
}

/** A `Host` line matches when one of its patterns does and none of its `!negated` ones does (ssh_config(5)). */
function hostLineMatches(patterns: readonly string[], alias: string): boolean {
  let matched = false;
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (globMatches(p.slice(1), alias)) return false;
    } else if (globMatches(p, alias)) matched = true;
  }
  return matched;
}

const isConcreteAlias = (name: string) => !/[*?!]/.test(name) && name.length > 0;

/**
 * Personal targets from `~/.ssh/config` and the hosts added in the IDE (`~/.qe-workspace/ssh_hosts`, same syntax;
 * the user's own file is never written). Only the parser of the `ssh-config` package is used: its `compute()` can
 * start processes (`nslookup` for CanonicalizeHostName, a shell for `Match exec`), and reading a configuration must
 * never run anything. Effective values follow ssh_config(5) — the first value wins, `IdentityFile` accumulates —
 * for `HostName`, `User`, `Port`, `IdentityFile`, `IdentitiesOnly` and `ProxyJump`. `Match` blocks and `Include` are
 * not followed; aliases with wildcards are patterns, not hosts, and are not listed.
 */
export function sshConfigTargetSource(options: SshConfigTargetsOptions): TargetSource & {
  /** Entries that could not become targets, with the reason (shown to the user, never secrets). */
  problems(): Promise<string[]>;
} {
  const read = options.read ?? readIfPresent;
  const files = [
    { path: join(options.home, '.ssh', 'config'), source: 'ssh-config' as const },
    { path: join(options.home, '.qe-workspace', 'ssh_hosts'), source: 'qe-hosts' as const },
  ];

  function expand(
    value: string,
    alias: string,
    host: string,
    user: string,
    port: number,
  ): string | undefined {
    const flags = { unknown: false };
    const expanded = value.replace(/%(.)/g, (_m, token: string) => {
      switch (token) {
        case '%':
          return '%';
        case 'd':
          return options.home;
        case 'u':
          return options.localUser;
        case 'r':
          return user;
        case 'h':
          return host;
        case 'n':
          return alias;
        case 'p':
          return String(port);
        default:
          flags.unknown = true;
          return '';
      }
    });
    if (flags.unknown) return undefined;
    const tilde =
      expanded === '~' || expanded.startsWith('~/') ? join(options.home, expanded.slice(1)) : expanded;
    // A relative path is taken relative to ~/.ssh, where key files live.
    return isAbsolute(tilde) ? normalize(tilde) : join(options.home, '.ssh', tilde);
  }

  function targetFrom(
    config: SSHConfig,
    alias: string,
    source: PersonalTarget['source'],
  ): PersonalTarget | string {
    const first = new Map<string, string>();
    const identityFiles: string[] = [];
    const apply = (line: Line) => {
      if (line.type !== LineType.DIRECTIVE) return;
      const param = line.param.toLowerCase();
      const value = values(line).join(' ');
      if (param === 'identityfile') identityFiles.push(value);
      else if (!first.has(param)) first.set(param, value);
    };
    for (const line of config) {
      if (line.type !== LineType.DIRECTIVE) continue;
      const param = line.param.toLowerCase();
      if (param === 'host' && 'config' in line) {
        if (hostLineMatches(values(line), alias)) for (const sub of line.config) apply(sub);
      } else if (param !== 'match') {
        apply(line);
      }
    }
    const rawHost = (first.get('hostname') ?? alias).replace(/%h/g, alias);
    const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
    if (!HOST_NAME.test(host) && !IPV6.test(host)) return `${alias}: HostName is not a host name or address`;
    const port = first.has('port') ? Number(first.get('port')) : 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return `${alias}: Port is not a port number`;
    const user = first.get('user') ?? options.localUser;
    if (!USER.test(user)) return `${alias}: User is not a user name`;
    const keys: string[] = [];
    for (const file of identityFiles) {
      if (file.toLowerCase() === 'none') continue;
      const path = expand(file, alias, host, user, port);
      if (path === undefined) return `${alias}: IdentityFile uses an unsupported %-token`;
      keys.push(path);
    }
    const proxyJump = first.get('proxyjump');
    return {
      id: `personal:${alias}`,
      alias,
      host,
      port,
      user,
      identityFiles: keys,
      identitiesOnly: first.get('identitiesonly')?.toLowerCase() === 'yes',
      ...(proxyJump !== undefined && proxyJump.toLowerCase() !== 'none' && { proxyJump }),
      source,
    };
  }

  async function load(): Promise<{ targets: PersonalTarget[]; problems: string[] }> {
    const targets = new Map<string, PersonalTarget>();
    const problems: string[] = [];
    for (const file of files) {
      const text = await read(file.path);
      if (text === undefined) continue;
      let config: SSHConfig;
      try {
        config = SSHConfig.parse(text);
      } catch {
        problems.push(`${file.path}: could not be read as an SSH configuration`);
        continue;
      }
      for (const line of config) {
        if (line.type !== LineType.DIRECTIVE || line.param.toLowerCase() !== 'host') continue;
        for (const alias of values(line).filter(isConcreteAlias)) {
          if (targets.has(alias.toLowerCase())) continue; // the first definition wins, as in OpenSSH
          const target = targetFrom(config, alias, file.source);
          if (typeof target === 'string') problems.push(target);
          else targets.set(alias.toLowerCase(), target);
        }
      }
    }
    return {
      targets: [...targets.values()].sort((a, b) => a.alias.localeCompare(b.alias)),
      problems,
    };
  }

  return {
    async list() {
      return (await load()).targets;
    },
    async get(id) {
      return (await load()).targets.find((t) => t.id === id);
    },
    async problems() {
      return (await load()).problems;
    },
  };
}
