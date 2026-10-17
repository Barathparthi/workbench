import { describe, expect, it } from 'vitest';

import { qeCorePreferenceSchema } from '../../common/qe-preferences';
import { QeCommands } from '../qe-commands';
import { QE_QUICK_LINKS, safeDocumentationUrl } from '../qe-quick-links';

describe('welcome page quick links', () => {
  it('offers open project, connect remote, run tests and docs, in that order', () => {
    expect(QE_QUICK_LINKS.map((l) => l.kind)).toEqual(['open-project', 'command', 'command', 'docs']);
    expect(QE_QUICK_LINKS.filter((l) => l.kind === 'command').map((l) => l.commandId)).toEqual([
      QeCommands.CONNECT_TARGET.id,
      QeCommands.RUN_TESTS.id,
    ]);
  });
});

describe('safeDocumentationUrl', () => {
  it('accepts https URLs, including the default', () => {
    const fallback = qeCorePreferenceSchema.properties['qe.help.documentationUrl']?.default;
    expect(safeDocumentationUrl(fallback)).toBe(fallback);
    expect(safeDocumentationUrl('https://docs.corp/qe/')).toBe('https://docs.corp/qe/');
  });

  it.each([
    undefined,
    42,
    '',
    'docs.corp',
    'http://docs.corp',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://u:p@docs.corp',
  ])('ignores %j', (value) => {
    expect(safeDocumentationUrl(value)).toBeUndefined();
  });
});
