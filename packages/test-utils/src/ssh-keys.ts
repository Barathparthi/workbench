import ssh2 from 'ssh2';

/**
 * A fresh ed25519 key pair in OpenSSH format that ssh2 can parse back. ssh2 1.17.0's own generateKeyPairSync yields
 * about 0.6 % of keys (124 in 20,000 measured) that its parseKey rejects as malformed, which made suites that generate
 * keys fail at random; such pairs are drawn again. Test keys only: real keys come from ssh-keygen or Vault.
 */
export function ed25519KeyPair(): { private: string; public: string } {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pair = ssh2.utils.generateKeyPairSync('ed25519');
    if (
      !(ssh2.utils.parseKey(pair.public) instanceof Error) &&
      !(ssh2.utils.parseKey(pair.private) instanceof Error)
    ) {
      return pair;
    }
  }
  throw new Error('could not generate a parseable ed25519 key pair');
}
