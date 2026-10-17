import { DomainError } from '@qe/domain';
import { z } from 'zod';

import { featuresFor, QeModes, type QeEnvironment, type QeMode } from '../common/qe-environment';

/** Which IDE app is starting: the browser app serves hosted and local web, Electron is always desktop. */
export type QeAppTarget = 'browser' | 'electron';

export interface QeEnvironmentIssue {
  readonly variable: 'QE_MODE' | 'QE_CONTROL_PLANE_URL' | 'QE_WORKSPACE_ID';
  readonly message: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// An empty variable (common with container templating) counts as unset.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const envSchema = z.object({
  QE_MODE: optional(z.enum(QeModes, { error: `must be one of ${QeModes.join(', ')}` })),
  QE_CONTROL_PLANE_URL: optional(z.string()),
  QE_WORKSPACE_ID: optional(z.uuid({ error: 'must be a UUID' })),
});

/** Returns the normalized URL, or a reason it is not acceptable. Never echoes the value itself. */
function checkControlPlaneUrl(raw: string): { url: string } | { problem: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: 'must be an absolute URL' };
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp)
    return { problem: 'must use https (http only for localhost)' };
  if (url.username !== '' || url.password !== '') return { problem: 'must not contain credentials' };
  if (url.search !== '' || url.hash !== '') return { problem: 'must not contain a query or fragment' };
  return { url: url.href };
}

/**
 * Derives the IDE's environment from process variables once, at backend startup. Invalid configuration
 * fails startup (fail closed) with one error listing every problem; values are never echoed back.
 */
export function parseQeEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  target: QeAppTarget,
): QeEnvironment {
  const issues: QeEnvironmentIssue[] = [];
  const parsed = envSchema.safeParse({
    QE_MODE: env['QE_MODE'],
    QE_CONTROL_PLANE_URL: env['QE_CONTROL_PLANE_URL'],
    QE_WORKSPACE_ID: env['QE_WORKSPACE_ID'],
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ variable: issue.path[0] as QeEnvironmentIssue['variable'], message: issue.message });
    }
    throw invalid(issues);
  }
  const { QE_MODE: requestedMode, QE_CONTROL_PLANE_URL: rawUrl, QE_WORKSPACE_ID: workspaceId } = parsed.data;

  let mode: QeMode;
  if (target === 'electron') {
    mode = 'desktop';
    if (requestedMode !== undefined && requestedMode !== 'desktop') {
      issues.push({ variable: 'QE_MODE', message: 'the desktop app always runs in desktop mode' });
    }
  } else {
    mode = requestedMode ?? 'local-web';
    if (mode === 'desktop')
      issues.push({ variable: 'QE_MODE', message: 'desktop is only valid in the desktop app' });
  }

  let controlPlaneUrl: string | undefined;
  if (rawUrl !== undefined) {
    const checked = checkControlPlaneUrl(rawUrl);
    if ('problem' in checked) issues.push({ variable: 'QE_CONTROL_PLANE_URL', message: checked.problem });
    else controlPlaneUrl = checked.url;
  }

  if (mode === 'hosted') {
    if (rawUrl === undefined)
      issues.push({ variable: 'QE_CONTROL_PLANE_URL', message: 'is required in hosted mode' });
    if (workspaceId === undefined)
      issues.push({ variable: 'QE_WORKSPACE_ID', message: 'is required in hosted mode' });
  } else if (workspaceId !== undefined) {
    issues.push({ variable: 'QE_WORKSPACE_ID', message: 'is only valid in hosted mode' });
  }

  if (issues.length > 0) throw invalid(issues);
  return {
    mode,
    ...(controlPlaneUrl !== undefined && { controlPlaneUrl }),
    ...(workspaceId !== undefined && { workspaceId }),
    features: featuresFor(mode, controlPlaneUrl),
  };
}

function invalid(issues: readonly QeEnvironmentIssue[]): DomainError {
  const summary = issues.map((i) => `${i.variable} ${i.message}`).join('; ');
  return new DomainError('INVALID_REQUEST', `Invalid QE Workspace environment: ${summary}`, {
    details: { issues },
  });
}
