import type { NewHostRequest } from './embedded-broker-protocol';

/** The same shapes the backend accepts (broker-core's SSH configuration reader); it checks again. */
const HOST_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*\.?$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;
const USER = /^[^\s\0/\\:@]{1,64}$/;
const ALIAS = /^[A-Za-z0-9._-]{1,63}$/;

/**
 * What the user types in "Add SSH Host…": `host`, `user@host`, `user@host:port`, or `[IPv6]:port`. A string is the
 * reason it cannot be used.
 */
export function parseHostSpec(text: string): Omit<NewHostRequest, 'alias'> | string {
  const spec = text.trim();
  const at = spec.lastIndexOf('@');
  const user = at === -1 ? undefined : spec.slice(0, at);
  const address = at === -1 ? spec : spec.slice(at + 1);
  if (user !== undefined && !USER.test(user))
    return 'The user name cannot contain spaces, “/”, “\\”, “:” or “@”.';
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(address);
  const plain = /^([^:[\]]+)(?::(\d+))?$/.exec(address);
  const [, host, portText] = bracketed ?? plain ?? (IPV6.test(address) ? [address, address] : []);
  if (host === undefined || (!HOST_NAME.test(host) && !IPV6.test(host)))
    return 'Type a host name or address, for example qe@lab-machine.example.com:2222.';
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && (port < 1 || port > 65535)) return 'The port must be between 1 and 65535.';
  return { host, ...(user !== undefined && { user }), ...(port !== undefined && { port }) };
}

/** A name for the host in the picker: a host name's first label, as ssh users usually call it; an address whole. */
export function suggestedAlias(host: string): string {
  const first = host.includes(':')
    ? host.replace(/:/g, '-')
    : /^[\d.]+$/.test(host)
      ? host
      : (host.split('.')[0] ?? host);
  const cleaned = first.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 63);
  return ALIAS.test(cleaned) ? cleaned : 'host';
}

/** Why a name cannot be used, or undefined. */
export function aliasProblem(alias: string): string | undefined {
  return ALIAS.test(alias) ? undefined : 'Use only letters, digits, “.”, “_” and “-”, at most 63.';
}
