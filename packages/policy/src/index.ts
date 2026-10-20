/**
 * @qe/policy — Target connection policy evaluation and SSRF rules: allow/deny decisions happen BEFORE any network
 * connection (08_REMOTE_CONNECTIVITY_DESIGN, 07_SECURITY T5/T6).
 */
export const PACKAGE_NAME = '@qe/policy';

export {
  checkAddresses,
  checkTargetHost,
  isValidCidr,
  parseCidr,
  type AddressDecision,
  type AddressDenial,
  type Resolver,
} from './address-guard.js';
export {
  Capabilities,
  KIND_REQUIREMENTS,
  SessionKinds,
  canSeeTarget,
  evaluateConnection,
  type CallerView,
  type Capability,
  type ConnectionDecision,
  type DenyReason,
  type PolicyView,
  type SessionKind,
} from './connection-policy.js';
