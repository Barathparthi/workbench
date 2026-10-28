import { readFileSync } from 'node:fs';

import { DomainError } from '@qe/domain';
import { z } from 'zod';

import { checkControlPlaneUrl } from './qe-environment-config';

/**
 * The organisation's settings for QE Workspace on a managed machine (PHASE_10 §10.7, ADR-013): read once at backend
 * startup, outside hosted mode, from
 *   Windows  HKLM\Software\Policies\QEWorkspace (Group Policy / Intune)
 *   macOS    /Library/Application Support/QEWorkspace/policy.json
 *   Linux    /etc/qe-workspace/policy.json
 * They win over the user's own configuration. Anything malformed or unknown stops the app (fail closed): a typo must
 * not silently drop the organisation's deny list.
 */
export const ManagedSettings = z.strictObject({
  /** The control plane the desktop app (and local web) connects to; wins over QE_CONTROL_PLANE_URL. */
  controlPlaneUrl: z
    .string()
    .refine(
      (raw) => !('problem' in checkControlPlaneUrl(raw)),
      'must be an https URL without credentials or query',
    )
    .optional(),
  /** The organisation's Open VSX mirror (ADR-010); recorded for the extension supply, not used at runtime yet. */
  openVsxUrl: z.url({ protocol: /^https$/, error: 'must be an https URL' }).optional(),
  /** Networks personal targets may never reach (the embedded broker's deny list). */
  deniedCidrs: z
    .array(z.union([z.cidrv4(), z.cidrv6()], { error: 'must be IPv4 or IPv6 CIDRs' }))
    .max(1000)
    .optional(),
  /** Whether users may trust an unknown host key of a personal target (default: yes). */
  trustOnFirstUse: z.boolean().optional(),
  /** Whether anonymous usage telemetry may be enabled (default: the user decides; off by default). */
  telemetry: z.boolean().optional(),
});
export type ManagedSettings = z.infer<typeof ManagedSettings>;

export const MANAGED_SETTINGS_FILES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '/Library/Application Support/QEWorkspace/policy.json',
  linux: '/etc/qe-workspace/policy.json',
};
export const MANAGED_SETTINGS_REGISTRY_KEY = 'HKLM\\Software\\Policies\\QEWorkspace';

/** Registry value names (Group Policy convention) → setting names. */
const REGISTRY_NAMES: Readonly<Record<string, keyof ManagedSettings>> = {
  ControlPlaneUrl: 'controlPlaneUrl',
  OpenVsxUrl: 'openVsxUrl',
  DeniedCidrs: 'deniedCidrs',
  TrustOnFirstUse: 'trustOnFirstUse',
  Telemetry: 'telemetry',
};

/**
 * `reg query` output → settings input. REG_SZ is text, REG_DWORD (0x0 / 0x1) a switch, REG_MULTI_SZ (shown with `\0`
 * between items) or a comma-separated REG_SZ a list. Unknown names are kept, so validation reports them.
 */
export function parseRegistryOutput(text: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^ {4}(\S+) {4}(REG_[A-Z_]+) {4}(.*)$/.exec(line);
    if (match === null) continue;
    const [, name = '', type = '', raw = ''] = match;
    const key = REGISTRY_NAMES[name] ?? name;
    const list = (items: string[]) => items.map((s) => s.trim()).filter((s) => s.length > 0);
    values[key] =
      type === 'REG_DWORD'
        ? Number.parseInt(raw, 16) !== 0
        : type === 'REG_MULTI_SZ'
          ? list(raw.split('\\0'))
          : key === 'deniedCidrs'
            ? list(raw.split(','))
            : raw.trim();
  }
  return values;
}

/** Where the settings come from; the platform's own readers in production, fakes in tests. */
export interface ManagedSettingsSource {
  readonly platform: NodeJS.Platform;
  /** The file's text, or undefined when there is no such file. */
  readFile(path: string): string | undefined;
  /** `reg query` output for the key, or undefined when the key does not exist. */
  queryRegistry(key: string): string | undefined;
}

export interface ManagedSettingsResult {
  readonly settings: ManagedSettings;
  /** The file or registry key they came from; undefined when this machine has none. */
  readonly origin?: string;
}

/** Reads and validates the machine's managed settings; throws INVALID_REQUEST naming the origin and the fields. */
export function readManagedSettings(source: ManagedSettingsSource): ManagedSettingsResult {
  let origin: string | undefined;
  let input: unknown;
  if (source.platform === 'win32') {
    const output = source.queryRegistry(MANAGED_SETTINGS_REGISTRY_KEY);
    if (output === undefined) return { settings: {} };
    origin = MANAGED_SETTINGS_REGISTRY_KEY;
    input = parseRegistryOutput(output);
  } else {
    const path = MANAGED_SETTINGS_FILES[source.platform];
    const text = path === undefined ? undefined : source.readFile(path);
    if (path === undefined || text === undefined) return { settings: {} };
    origin = path;
    try {
      input = JSON.parse(text);
    } catch {
      throw new DomainError('INVALID_REQUEST', `Invalid managed settings in ${origin}: not valid JSON`);
    }
  }
  const parsed = ManagedSettings.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) =>
      i.code === 'unrecognized_keys'
        ? `unknown ${i.keys.join(', ')}`
        : `${i.path.join('.') || 'settings'} ${i.message}`,
    );
    throw new DomainError('INVALID_REQUEST', `Invalid managed settings in ${origin}: ${problems.join('; ')}`);
  }
  return { settings: parsed.data, origin };
}

/** The real files (missing means none; unreadable means misconfigured). */
export function fileReader(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new DomainError('INVALID_REQUEST', `Invalid managed settings in ${path}: cannot be read`);
  }
}
