import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DESKTOP_HOST_ENV } from '../../common/desktop-host-protocol';
import { DesktopHostFailure, desktopHostClient, takeDesktopHostAddress } from '../desktop-host-client';
import {
  HostError,
  secretFileStore,
  startDesktopHost,
  type DesktopHost,
  type StringCipher,
} from '../../electron-main/desktop-host';

const SECRET = 'refresh-token-c2VjcmV0LXZhbHVl';

/** Stands in for safeStorage: reversible, and visibly not the plain text. */
const fakeCipher = (available = true): StringCipher => ({
  available,
  encrypt: (text) => Buffer.from(`enc:${Buffer.from(text).reverse().toString('base64')}`),
  decrypt: (data) => {
    const s = data.toString();
    if (!s.startsWith('enc:')) throw new Error('cannot decrypt');
    return Buffer.from(s.slice(4), 'base64').reverse().toString();
  },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qe-secrets-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('secretFileStore', () => {
  it('stores only ciphertext, in a private file, and reads it back', async () => {
    const store = secretFileStore(join(dir, 'qe-secrets'), () => Promise.resolve(fakeCipher()));
    await store.set('qe.refresh-token https://qe.example', SECRET);
    const files = readdirSync(join(dir, 'qe-secrets'));
    expect(files).toHaveLength(1);
    const path = join(dir, 'qe-secrets', files[0] ?? '');
    expect(readFileSync(path, 'utf8')).not.toContain(SECRET);
    expect(files[0]).not.toContain('qe.example'); // the key is hashed into the name
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await store.get('qe.refresh-token https://qe.example')).toBe(SECRET);
    expect(await store.get('another key')).toBeNull();
  });

  it('never writes a secret when the OS cannot encrypt it', async () => {
    const store = secretFileStore(join(dir, 'qe-secrets'), () => Promise.resolve(fakeCipher(false)));
    await expect(store.set('k', SECRET)).rejects.toMatchObject({ code: 'unavailable' });
    expect(() => readdirSync(join(dir, 'qe-secrets'))).toThrow(); // not even the directory
  });

  it('forgets a secret it can no longer decrypt (another account or keychain)', async () => {
    const store = secretFileStore(dir, () => Promise.resolve(fakeCipher()));
    await store.set('k', SECRET);
    const file = join(dir, readdirSync(dir)[0] ?? '');
    writeFileSync(file, 'garbage');
    expect(await store.get('k')).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('deletes', async () => {
    const store = secretFileStore(dir, () => Promise.resolve(fakeCipher()));
    await store.set('k', SECRET);
    await store.delete('k');
    await store.delete('k');
    expect(await store.get('k')).toBeNull();
  });
});

describe('desktop host channel', () => {
  let host: DesktopHost;
  let opened: string[];
  let cipher: StringCipher;

  beforeEach(async () => {
    opened = [];
    cipher = fakeCipher();
    host = await startDesktopHost({
      secrets: secretFileStore(dir, () => Promise.resolve(cipher)),
      openExternal: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    });
  });
  afterEach(async () => {
    await host.close();
  });

  it('serves the backend that presents the token', async () => {
    const client = desktopHostClient({ address: host.address, token: host.token });
    await client.openExternal('https://idp.example/auth?client_id=x');
    expect(opened).toEqual(['https://idp.example/auth?client_id=x']);
    await client.setSecret('k', SECRET);
    expect(await client.getSecret('k')).toBe(SECRET);
    await client.deleteSecret('k');
    expect(await client.getSecret('k')).toBeNull();
  });

  it('drops a connection with the wrong token without answering it', async () => {
    const client = desktopHostClient({ address: host.address, token: 'x'.repeat(43) }, 2_000);
    const error: unknown = await client.getSecret('k').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DesktopHostFailure);
    expect((error as DesktopHostFailure).code).toBe('disconnected');
  });

  it('drops a connection that sends garbage instead of the token', async () => {
    const socket = connect(host.address);
    const closed = new Promise<string>((resolve) => {
      let received = '';
      socket.on('data', (d) => (received += d.toString()));
      socket.on('close', () => {
        resolve(received);
      });
    });
    socket.write('not json\n{"id":1,"op":"secret.get","key":"k"}\n');
    expect(await closed).toBe('');
  });

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ms-settings:privacy',
    'https://user:pass@idp.example/',
    'not a url',
    `https://idp.example/${'a'.repeat(9000)}`,
  ])('refuses to open %s', async (url) => {
    const client = desktopHostClient({ address: host.address, token: host.token });
    await expect(client.openExternal(url)).rejects.toMatchObject({ code: 'refused' });
    expect(opened).toEqual([]);
  });

  it('reports that a secret cannot be stored when the OS cannot encrypt it', async () => {
    cipher = fakeCipher(false);
    const client = desktopHostClient({ address: host.address, token: host.token });
    await expect(client.setSecret('k', SECRET)).rejects.toMatchObject({ code: 'unavailable' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses oversized values and empty keys', async () => {
    const client = desktopHostClient({ address: host.address, token: host.token });
    await expect(client.setSecret('k', 'x'.repeat(20_000))).rejects.toMatchObject({ code: 'refused' });
    await expect(client.getSecret('')).rejects.toMatchObject({ code: 'refused' });
  });
});

describe('takeDesktopHostAddress', () => {
  it('reads the address once and removes it from the environment', () => {
    const env: NodeJS.ProcessEnv = {
      [DESKTOP_HOST_ENV]: JSON.stringify({ address: '/x/host.sock', token: 't' }),
    };
    expect(takeDesktopHostAddress(env)).toEqual({ address: '/x/host.sock', token: 't' });
    expect(env[DESKTOP_HOST_ENV]).toBeUndefined();
    expect(takeDesktopHostAddress(env)).toBeUndefined();
  });

  it('ignores a malformed value (and still removes it)', () => {
    const env: NodeJS.ProcessEnv = { [DESKTOP_HOST_ENV]: '{"address":1}' };
    expect(takeDesktopHostAddress(env)).toBeUndefined();
    expect(env[DESKTOP_HOST_ENV]).toBeUndefined();
  });
});

it('HostError carries its code', () => {
  expect(new HostError('refused').code).toBe('refused');
});
