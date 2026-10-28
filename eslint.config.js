// ESLint flat config for the QE Workspace monorepo.
// Package boundaries encode the dependency rules in 01_ARCHITECTURE/04_REPO_STRUCTURE_AND_STANDARDS.md §1.
import { resolve } from 'node:path';

import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

const rootDir = import.meta.dirname;

// One element per package so violations name the exact packages involved.
const packages = [
  'domain',
  'contracts',
  'rbac',
  'policy',
  'broker-core',
  'secrets',
  'runtime-providers',
  'telemetry',
  'client-sdk',
  'test-utils',
];

/** `from` may import `to` (01_ARCHITECTURE/04 §1 "Dependency rules"). */
const allowedDependencies = {
  domain: [],
  contracts: ['domain'],
  rbac: ['domain', 'contracts'],
  policy: ['domain', 'contracts'],
  'broker-core': ['domain', 'contracts', 'policy', 'secrets', 'telemetry'],
  secrets: ['domain', 'telemetry'],
  'runtime-providers': ['domain', 'telemetry'],
  telemetry: [],
  'client-sdk': ['contracts'],
  // test-utils is test-only code; it may build fixtures from any library package.
  'test-utils': packages.filter((p) => p !== 'test-utils'),
  // Theia extensions: never secrets, broker-core server parts or runtime-providers.
  // qe-core is allowed because it exposes QeEnvironment to the other extensions (09_LOCAL_AND_WEB_PARITY).
  extension: ['client-sdk', 'contracts', 'domain', 'extension-qe-core'],
  // qe-core is an extension too (04 §1 "extensions/*"); it is a separate element only so others may import it.
  'extension-qe-core': ['client-sdk', 'contracts', 'domain'],
  // ADR-008 exception (+ Phase 10 addendum): qe-remote's backends embed the broker — Electron for desktop, Node for
  // local web (bound only in that mode). They may use broker-core, policy, qe-core and qe-remote's own common code.
  'extension-qe-remote-node-backend': [
    'client-sdk',
    'contracts',
    'domain',
    'broker-core',
    'policy',
    'extension',
    'extension-qe-core',
  ],
  'extension-qe-remote-electron-backend': [
    'client-sdk',
    'contracts',
    'domain',
    'broker-core',
    'policy',
    'extension',
    'extension-qe-core',
    'extension-qe-remote-node-backend',
  ],
  'app-control-plane': ['domain', 'contracts', 'rbac', 'policy', 'secrets', 'runtime-providers', 'telemetry'],
  'app-connection-broker': ['broker-core', 'contracts', 'policy', 'secrets', 'telemetry'],
  'app-ide': [
    'extension',
    'extension-qe-core',
    'extension-qe-remote-node-backend',
    'extension-qe-remote-electron-backend',
  ],
};

const elementSelector = (type) => ({ element: { type } });

// Packages allowed to spawn processes (04 §2: spawn(file, args, { shell: false }) only).
const childProcessAllowed = [
  'packages/runtime-providers/**',
  'packages/broker-core/**',
  'extensions/qe-runner/src/node/**',
  // ADR-013: the desktop app reads Windows managed settings with reg.exe (read-only, fixed arguments, no shell).
  'extensions/qe-core/src/node/qe-managed-settings-registry.ts',
  'packages/test-utils/**',
  'tests/**',
];

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/lib/**',
      '**/src-gen/**',
      '**/coverage/**',
      '.tsbuild/**',
      'spikes/**',
      'apps/*/gen-webpack*.js',
      'apps/*/gen-esbuild.*.mjs',
      // Written by `theia build` on first run; Theia owns its content.
      'apps/*/esbuild.mjs',
      'apps/*/plugins/**',
      'plugins/**',
    ],
  },

  eslint.configs.recommended,

  // Type-aware TypeScript rules for all TS sources (.tsx: Theia React widgets).
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.config.ts'], defaultProject: 'tsconfig.tools.json' },
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },

  // Plain JS config files are linted without type information.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },

  // No child_process outside the packages that own process/SSH lifecycles.
  {
    files: ['**/*.ts'],
    ignores: childProcessAllowed,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['child_process', 'node:child_process'].map((name) => ({
            name,
            message:
              'Only runtime-providers, broker-core and the qe-runner backend may spawn processes (04_REPO_STRUCTURE_AND_STANDARDS §2).',
          })),
        },
      ],
    },
  },

  // Package boundaries.
  {
    files: ['packages/**/*.ts', 'extensions/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}', 'tests/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/root-path': rootDir,
      'import/resolver': {
        typescript: {
          // Resolve workspace packages to their sources (the "@qe/source" export condition) so the
          // rules work before anything is built.
          conditionNames: ['@qe/source', 'types', 'import', 'node', 'default'],
          project: resolve(rootDir, 'tsconfig.base.json'),
        },
      },
      'boundaries/elements': [
        // Most specific first.
        {
          type: 'extension-qe-remote-electron-backend',
          pattern: 'extensions/qe-remote/src/electron-node',
          partialMatch: false,
        },
        {
          type: 'extension-qe-remote-node-backend',
          pattern: 'extensions/qe-remote/src/node',
          partialMatch: false,
        },
        { type: 'extension-qe-core', pattern: 'extensions/qe-core', partialMatch: false },
        { type: 'extension', pattern: 'extensions/*', partialMatch: false, capture: ['name'] },
        { type: 'app-control-plane', pattern: 'apps/control-plane', partialMatch: false },
        { type: 'app-connection-broker', pattern: 'apps/connection-broker', partialMatch: false },
        { type: 'app-ide', pattern: 'apps/ide-*', partialMatch: false },
        { type: 'tests', pattern: 'tests/*', partialMatch: false },
        ...packages.map((name) => ({ type: name, pattern: `packages/${name}`, partialMatch: false })),
      ],
      'boundaries/files': [{ category: 'test', pattern: '**/*.test.ts' }],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          // Also evaluate imports inside one package, so the "no test files" policy below applies there.
          checkInternals: true,
          message:
            '{{from.element.types.[0]}} must not depend on {{to.element.types.[0]}} — see the dependency rules in 01_ARCHITECTURE/04_REPO_STRUCTURE_AND_STANDARDS.md §1',
          policies: [
            // Files inside one element may import each other.
            { allow: { dependency: { relationship: { to: 'internal' } } } },
            ...Object.entries(allowedDependencies).map(([from, to]) => ({
              from: elementSelector(from),
              allow: to.map((target) => ({ to: elementSelector(target) })),
            })),
            // Test files may use the shared test utilities.
            { from: { file: { categories: 'test' } }, allow: { to: elementSelector('test-utils') } },
            // Cross-package and e2e suites may exercise anything.
            { from: elementSelector('tests'), allow: { to: { element: { type: '*' } } } },
            // Nothing may import test files.
            {
              disallow: { to: { file: { categories: 'test' } } },
              message: 'Test files must not be imported',
            },
          ],
        },
      ],
      'boundaries/no-unknown-dependencies': 'error',
    },
  },
);
