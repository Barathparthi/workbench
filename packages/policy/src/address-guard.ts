import ipaddr from 'ipaddr.js';

type Address = ipaddr.IPv4 | ipaddr.IPv6;
type Cidr = [Address, number];

/**
 * Address ranges a target may never resolve to, whatever a policy allows (07_SECURITY T5/T6): loopback,
 * link-local (incl. the 169.254.169.254 cloud metadata service), multicast, broadcast, unspecified and reserved
 * space, and IPv6 forms that embed or tunnel IPv4 (NAT64, 6to4, Teredo). Private ranges are *not* denied here:
 * lab networks live there, and policies must name them explicitly.
 */
const DENIED_IPV4_RANGES = new Set([
  'unspecified',
  'broadcast',
  'multicast',
  'linkLocal',
  'loopback',
  'reserved',
]);
const DENIED_IPV6_RANGES = new Set([
  'unspecified',
  'linkLocal',
  'multicast',
  'loopback',
  'reserved',
  'rfc6145',
  'rfc6052',
  '6to4',
  'teredo',
]);

export type AddressDenial =
  'NO_ADDRESSES' | 'INVALID_ADDRESS' | 'DENIED_RANGE' | 'DENIED_CIDR' | 'NOT_IN_ALLOWED_CIDR';

export type AddressDecision =
  | { readonly allowed: true; readonly address: string }
  | { readonly allowed: false; readonly reason: AddressDenial; readonly address?: string };

export function parseCidr(cidr: string): Cidr {
  const [addr, bits] = ipaddr.parseCIDR(cidr);
  return [unmap(addr), addr.kind() === 'ipv6' && unmap(addr).kind() === 'ipv4' ? bits - 96 : bits];
}

export const isValidCidr = (cidr: string): boolean => {
  try {
    parseCidr(cidr);
    return true;
  } catch {
    return false;
  }
};

/** `::ffff:10.0.0.1` is 10.0.0.1: check it as IPv4 so mapped forms cannot slip past IPv4 rules. */
function unmap(addr: Address): Address {
  return addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()
    ? (addr as ipaddr.IPv6).toIPv4Address()
    : addr;
}

/** Only canonical forms: dotted-quad IPv4 (no octal/hex/short forms) or IPv6 without a zone id. */
function parseCanonical(address: string): Address | undefined {
  if (ipaddr.IPv4.isValidFourPartDecimal(address)) return ipaddr.IPv4.parse(address);
  if (address.includes(':') && !address.includes('%') && ipaddr.IPv6.isValid(address)) {
    return unmap(ipaddr.IPv6.parse(address));
  }
  return undefined;
}

const inCidr = (addr: Address, [net, bits]: Cidr): boolean =>
  addr.kind() === net.kind() &&
  (addr.kind() === 'ipv4'
    ? (addr as ipaddr.IPv4).match(net as ipaddr.IPv4, bits)
    : (addr as ipaddr.IPv6).match(net as ipaddr.IPv6, bits));

/**
 * Decides on the addresses a target name resolved to. **Every** address must pass — a name answering with one
 * allowed and one forbidden address is refused, so DNS answers cannot be mixed to sneak through. On success the
 * caller connects to the returned address, never to the name (no second lookup, no DNS rebinding).
 */
export function checkAddresses(
  addresses: readonly string[],
  allowedCidrs: readonly string[],
  deniedCidrs: readonly string[] = [],
): AddressDecision {
  if (addresses.length === 0) return { allowed: false, reason: 'NO_ADDRESSES' };
  const allowed = allowedCidrs.map(parseCidr);
  const denied = deniedCidrs.map(parseCidr);
  let first: string | undefined;
  for (const raw of addresses) {
    const addr = parseCanonical(raw);
    if (addr === undefined) return { allowed: false, reason: 'INVALID_ADDRESS' };
    const shown = addr.toString();
    const range = addr.range();
    if (addr.kind() === 'ipv4' ? DENIED_IPV4_RANGES.has(range) : DENIED_IPV6_RANGES.has(range)) {
      return { allowed: false, reason: 'DENIED_RANGE', address: shown };
    }
    if (denied.some((c) => inCidr(addr, c))) return { allowed: false, reason: 'DENIED_CIDR', address: shown };
    if (!allowed.some((c) => inCidr(addr, c)))
      return { allowed: false, reason: 'NOT_IN_ALLOWED_CIDR', address: shown };
    first ??= shown;
  }
  return { allowed: true, address: first ?? '' };
}

/** Resolves a host name to all its addresses (an injectable `dns.promises.lookup(host, { all: true })`). */
export type Resolver = (host: string) => Promise<readonly string[]>;

/**
 * Resolve-then-check for a target host (registration and every connect). An IP literal is checked as-is; a name
 * is resolved with `resolver`. Resolution failures are denials, not errors to retry blindly.
 */
export async function checkTargetHost(
  host: string,
  allowedCidrs: readonly string[],
  deniedCidrs: readonly string[],
  resolver: Resolver,
): Promise<AddressDecision> {
  if (parseCanonical(host) !== undefined) return checkAddresses([host], allowedCidrs, deniedCidrs);
  let addresses: readonly string[];
  try {
    addresses = await resolver(host);
  } catch {
    return { allowed: false, reason: 'NO_ADDRESSES' };
  }
  return checkAddresses(addresses, allowedCidrs, deniedCidrs);
}
