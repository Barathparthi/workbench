/**
 * Proves the architecture rules in eslint.config.js reject forbidden imports
 * (01_ARCHITECTURE/04_REPO_STRUCTURE_AND_STANDARDS.md §1–§2). Each case lints an in-memory snippet as if
 * it lived at the given path, using the real repository config.
 */
import { resolve } from 'node:path';

import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({
    cwd: repoRoot,
    // Snippets are virtual files outside any tsconfig, so type-aware rules are switched off for them.
    // Boundary and restricted-import rules do not need type information.
    overrideConfig: { files: ['**/*.ts'], ...tseslint.configs.disableTypeChecked } as Linter.Config,
  });
});

async function ruleIdsFor(file: string, code: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath: resolve(repoRoot, file) });
  return results.flatMap((r) => r.messages.map((m) => m.ruleId ?? `fatal: ${m.message}`));
}

const importFrom = (specifier: string) =>
  `import { PACKAGE_NAME } from '${specifier}';\nexport const used = PACKAGE_NAME;\n`;

describe('package boundaries: forbidden imports fail lint', () => {
  it.each([
    ['packages/domain/src/fixture.ts', '@qe/broker-core', 'domain depends on nothing'],
    ['packages/domain/src/fixture.ts', '@qe/contracts', 'no upward dependency from domain'],
    ['packages/contracts/src/fixture.ts', '@qe/rbac', 'contracts may only use domain'],
    ['packages/client-sdk/src/fixture.ts', '@qe/secrets', 'client-sdk never sees secrets'],
    ['packages/client-sdk/src/fixture.ts', '@qe/broker-core', 'client-sdk never sees the broker'],
    ['packages/policy/src/fixture.ts', '@qe/broker-core', 'policy must not depend on broker-core'],
    ['packages/telemetry/src/fixture.ts', '@qe/secrets', 'telemetry depends on nothing'],
    ['packages/rbac/src/fixture.ts', '@qe/test-utils', 'production code must not use test-utils'],
    ['extensions/qe-workspaces/src/browser/fixture.ts', '@qe/secrets', 'extensions never import secrets'],
    [
      'extensions/qe-workspaces/src/browser/fixture.ts',
      '@qe/runtime-providers',
      'extensions never import runtime-providers',
    ],
    [
      'extensions/qe-remote/src/browser/fixture.ts',
      '@qe/broker-core',
      'only the qe-remote electron backend may embed the broker',
    ],
    ['apps/connection-broker/src/fixture.ts', '@qe/runtime-providers', 'the broker does not run workspaces'],
  ])('%s → %s (%s)', async (file, specifier) => {
    expect(await ruleIdsFor(file, importFrom(specifier))).toContain('boundaries/dependencies');
  });

  it('rejects a relative import that reaches into another package', async () => {
    const code = `import { PACKAGE_NAME } from '../../broker-core/src/index.js';\nexport const used = PACKAGE_NAME;\n`;
    expect(await ruleIdsFor('packages/domain/src/fixture.ts', code)).toContain('boundaries/dependencies');
  });

  it('rejects importing a test file from production code', async () => {
    const code = `export * from './__tests__/index.test.js';\n`;
    expect(await ruleIdsFor('packages/rbac/src/fixture.ts', code)).toContain('boundaries/dependencies');
  });
});

describe('package boundaries: allowed imports pass lint', () => {
  it.each([
    ['packages/contracts/src/fixture.ts', '@qe/domain'],
    ['packages/rbac/src/fixture.ts', '@qe/contracts'],
    ['packages/broker-core/src/fixture.ts', '@qe/policy'],
    ['packages/broker-core/src/fixture.ts', '@qe/secrets'],
    ['packages/secrets/src/fixture.ts', '@qe/telemetry'],
    ['packages/client-sdk/src/fixture.ts', '@qe/contracts'],
    ['packages/rbac/src/__tests__/fixture.test.ts', '@qe/test-utils'],
    ['extensions/qe-workspaces/src/browser/fixture.ts', '@qe/client-sdk'],
    ['extensions/qe-remote/src/electron-node/fixture.ts', '@qe/broker-core'],
    ['apps/control-plane/src/fixture.ts', '@qe/runtime-providers'],
    ['apps/connection-broker/src/fixture.ts', '@qe/broker-core'],
    ['tests/integration/fixture.test.ts', '@qe/broker-core'],
  ])('%s → %s', async (file, specifier) => {
    expect(await ruleIdsFor(file, importFrom(specifier))).toEqual([]);
  });

  it('allows imports inside the same package', async () => {
    const code = `import { DomainError } from './errors.js';\nexport const E = DomainError;\n`;
    expect(await ruleIdsFor('packages/domain/src/fixture.ts', code)).toEqual([]);
  });
});

describe('restricted imports', () => {
  const spawnImport = `import { spawn } from 'node:child_process';\nexport const s = spawn;\n`;

  it.each([
    'packages/domain/src/fixture.ts',
    'packages/contracts/src/fixture.ts',
    'apps/control-plane/src/fixture.ts',
  ])('rejects child_process in %s', async (file) => {
    expect(await ruleIdsFor(file, spawnImport)).toContain('no-restricted-imports');
    expect(await ruleIdsFor(file, spawnImport.replace('node:child_process', 'child_process'))).toContain(
      'no-restricted-imports',
    );
  });

  it.each(['packages/runtime-providers/src/fixture.ts', 'packages/broker-core/src/fixture.ts'])(
    'allows child_process in %s',
    async (file) => {
      expect(await ruleIdsFor(file, spawnImport)).toEqual([]);
    },
  );

  it('rejects eval', async () => {
    expect(
      await ruleIdsFor('packages/domain/src/fixture.ts', `export const x: unknown = eval('1');\n`),
    ).toContain('no-eval');
  });
});
