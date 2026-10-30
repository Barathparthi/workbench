import { DomainError } from '@qe/domain';

import type { TestSelector } from './types.js';

/**
 * Checks on everything a user can put into a run (07_SECURITY T11). Every value ends up as one argv element — never in
 * a shell line — but a test framework still reads its own arguments: a value starting with `-` would be taken as an
 * option (`--rootdir=/`, `-p plugin`), and a path could leave the project folder. Both are refused, as are control
 * characters. A refusal is `INVALID_REQUEST` naming the field, never echoing the value.
 */

const MAX_PATH = 1024;
const MAX_MARKER = 256;
const MAX_ENV_VARS = 32;
const MAX_ENV_VALUE = 4096;
/** PHASE_11 §11.2: what a pytest node id may contain (`tests/test_a.py::TestB::test_c[1-x]`). */
export const NODE_ID_PATTERN = /^[\w./\-[\]:,= ]+$/;
/** NUL, line breaks, escapes and the other C0 controls, and DEL. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
const SHELL_SYNTAX = /[;&|`$<>"'*?{}()!#~^]/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Variables that change how the loader, a shell or the test framework starts — not test settings. */
const ENV_DENIED =
  /^(LD_|DYLD_|BASH_ENV$|ENV$|PATH$|HOME$|SHELL$|IFS$|PYTEST_ADDOPTS$|PYTEST_PLUGINS$|PYTHON)/;

const invalid = (field: string, reason: string) => new DomainError('INVALID_REQUEST', `${field}: ${reason}`);

/**
 * A project-relative POSIX path that stays inside the project folder: no absolute path, drive letter, backslash,
 * `..` segment, control character, shell syntax or leading `-`. Returns it without `./` prefixes.
 */
export function projectPath(path: string, field = 'path'): string {
  if (path.length === 0 || path.length > MAX_PATH) throw invalid(field, 'empty or too long');
  if (hasControl(path)) throw invalid(field, 'contains a control character');
  // Harmless in an argv element, but no test file needs them: refused as defence in depth (T11's own test case).
  if (SHELL_SYNTAX.test(path)) throw invalid(field, 'contains shell syntax');
  if (path.includes('\\')) throw invalid(field, 'use / as the separator');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path))
    throw invalid(field, 'must be relative to the project');
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) throw invalid(field, 'names no file');
  if (segments.includes('..')) throw invalid(field, 'leaves the project folder');
  const normalized = segments.join('/');
  if (normalized.startsWith('-')) throw invalid(field, 'must not start with "-"');
  return normalized;
}

/** A node id: the pattern of PHASE_11 §11.2, a confined file part, and no leading `-`. */
export function nodeId(id: string): string {
  if (id.length === 0 || id.length > MAX_PATH || !NODE_ID_PATTERN.test(id))
    throw invalid('selector.id', 'not a test id');
  const [file = '', ...rest] = id.split('::');
  return [projectPath(file, 'selector.id'), ...rest].join('::');
}

/** A marker expression: passed as the one argument after `-m`, so only its length and characters are limited. */
export function markerExpression(expr: string): string {
  const trimmed = expr.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MARKER)
    throw invalid('selector.expr', 'empty or too long');
  if (hasControl(trimmed)) throw invalid('selector.expr', 'contains a control character');
  if (trimmed.startsWith('-')) throw invalid('selector.expr', 'must not start with "-"');
  return trimmed;
}

/** The selector with every value checked and normalized. */
export function checkSelector(selector: TestSelector): TestSelector {
  switch (selector.kind) {
    case 'all':
      return selector;
    case 'file':
      return { kind: 'file', path: projectPath(selector.path, 'selector.path') };
    case 'node':
      return { kind: 'node', id: nodeId(selector.id) };
    case 'marker':
      return { kind: 'marker', expr: markerExpression(selector.expr) };
  }
}

/** A run id names a folder (`.qe-runs/<runId>`): a lowercase UUID only. */
export function checkRunId(runId: string): string {
  if (!RUN_ID.test(runId)) throw invalid('runId', 'not a UUID');
  return runId;
}

/** Extra environment: at most 32 upper-case names, none that changes how processes start, values without NUL. */
export function checkRunEnv(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const entries = Object.entries(env ?? {});
  if (entries.length > MAX_ENV_VARS) throw invalid('env', `at most ${String(MAX_ENV_VARS)} variables`);
  const checked: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name)) throw invalid('env', 'names are upper-case letters, digits and _');
    if (ENV_DENIED.test(name)) throw invalid('env', `${name} cannot be set for a test run`);
    if (value.length > MAX_ENV_VALUE || value.includes('\u0000'))
      throw invalid('env', `${name} is too long or has NUL`);
    checked[name] = value;
  }
  return checked;
}
