/**
 * @qe/test-utils — Shared test fixtures and helpers: Testcontainers (PostgreSQL, OpenSSH, Vault dev), fake IdP,
 * SSH test server. Test code only — production packages must not import it (lint-enforced).
 */
export const PACKAGE_NAME = '@qe/test-utils';

export { startSshServer, type TestSshServer } from './ssh-server.js';
