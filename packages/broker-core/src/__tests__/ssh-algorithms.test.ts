import ssh2Constants from 'ssh2/lib/protocol/constants.js';
import { describe, expect, it } from 'vitest';

import { ALGORITHMS, algorithmsFor } from '../ssh-transport.js';

const everything = {
  kex: [...ALGORITHMS.kex],
  serverHostKey: [...ALGORITHMS.serverHostKey],
  cipher: [...ALGORITHMS.cipher],
  hmac: [...ALGORITHMS.hmac],
};

describe('algorithmsFor (the pinned SSH algorithms this runtime can negotiate)', () => {
  it('keeps the pinned lists, in order, where everything is available', () => {
    expect(algorithmsFor(everything)).toEqual(everything);
  });

  it('drops ChaCha20-Poly1305 where the runtime lacks it (Electron’s BoringSSL), keeping the order', () => {
    const boringSsl = { ...everything, cipher: everything.cipher.filter((c) => !c.startsWith('chacha20')) };
    expect(algorithmsFor(boringSsl).cipher).toEqual([
      'aes256-gcm@openssh.com',
      'aes128-gcm@openssh.com',
      'aes256-ctr',
    ]);
  });

  it('never adds an algorithm outside the pinned lists, however much the runtime offers', () => {
    const generous = {
      kex: [...everything.kex, 'diffie-hellman-group1-sha1'],
      serverHostKey: [...everything.serverHostKey, 'ssh-rsa', 'ssh-dss'],
      cipher: [...everything.cipher, 'aes128-cbc', '3des-cbc'],
      hmac: [...everything.hmac, 'hmac-sha1', 'hmac-md5'],
    };
    expect(algorithmsFor(generous)).toEqual(everything);
  });

  it('refuses a runtime that has none of a category, instead of weakening it', () => {
    expect(() => algorithmsFor({ ...everything, cipher: ['aes128-cbc'] })).toThrow('no pinned SSH cipher');
    expect(() => algorithmsFor({ ...everything, kex: [] })).toThrow('no pinned SSH key exchange');
  });

  it('matches what ssh2 itself can use in this runtime', () => {
    const runtime = algorithmsFor({
      kex: ssh2Constants.SUPPORTED_KEX,
      serverHostKey: ssh2Constants.SUPPORTED_SERVER_HOST_KEY,
      cipher: ssh2Constants.SUPPORTED_CIPHER,
      hmac: ssh2Constants.SUPPORTED_MAC,
    });
    expect(runtime.cipher.every((c) => ssh2Constants.SUPPORTED_CIPHER.includes(c))).toBe(true);
    expect(runtime.cipher).toContain('aes256-gcm@openssh.com');
  });
});
