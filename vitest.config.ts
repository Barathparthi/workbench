import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources (the "@qe/source" export condition), so tests
// never run against stale dist output.
const conditions = ['@qe/source', 'node'];

const strictCoverage = { lines: 90, functions: 90, branches: 90, statements: 90 };

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'packages/*/src/**/*.test.ts',
            'extensions/*/src/**/*.test.ts',
            'apps/*/src/**/*.test.ts',
            'tests/lint/**/*.test.ts',
            'tests/security/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['**/*.int.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'extensions/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/__tests__/**', '**/*.test.ts', '**/*.int.test.ts'],
      reporter: ['text', 'html', 'lcov'],
      // 04_REPO_STRUCTURE_AND_STANDARDS §7: security-critical packages ≥ 90 %, everything else ≥ 75 %.
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 75,
        statements: 75,
        'packages/domain/src/**': strictCoverage,
        'packages/rbac/src/**': strictCoverage,
        'packages/policy/src/**': strictCoverage,
        'packages/broker-core/src/**': strictCoverage,
      },
    },
  },
});
