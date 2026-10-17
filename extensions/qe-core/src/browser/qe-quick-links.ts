import { QeCommands } from './qe-commands';

/** One entry of the welcome page's "QE Workspace" section. */
export type QeQuickLink =
  | { readonly label: string; readonly kind: 'open-project' }
  | { readonly label: string; readonly kind: 'command'; readonly commandId: string }
  | { readonly label: string; readonly kind: 'docs' };

/** Open project, Connect remote, Run tests, Docs (02_PHASES/PHASE_02 §2.6). */
export const QE_QUICK_LINKS: readonly QeQuickLink[] = [
  { label: 'Open project…', kind: 'open-project' },
  { label: 'Connect to a remote system…', kind: 'command', commandId: QeCommands.CONNECT_TARGET.id },
  { label: 'Run tests', kind: 'command', commandId: QeCommands.RUN_TESTS.id },
  { label: 'Documentation', kind: 'docs' },
];

/** Only absolute https links open from the IDE; anything else is ignored. */
export function safeDocumentationUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
